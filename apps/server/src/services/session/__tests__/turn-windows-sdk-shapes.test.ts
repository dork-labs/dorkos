/**
 * Turn windowing against REAL SDK message sequences (DOR-1100).
 *
 * The other window tests hand-write `StreamEvent`s, which is fine for the
 * projector's side of the contract and useless for the question that actually
 * decides the reopen set: what does the claude-code CLI really emit after the
 * `result` DorkOS closed a turn on? So this suite drives raw `SDKMessage`s
 * through the production mapper (`mapSdkMessage`) into `feedProjector` and
 * counts windows — the same two hops a live turn takes.
 *
 * Every "settling" shape below is a real one. The trailing interrupt sentinel is
 * pinned on `main` by `message-sender-phantom-cancellation.test.ts` ("surfaces
 * but does NOT steer a phantom arriving after the result message"), and
 * `message-sender`'s `sawResult` guard exists because that ordering happens.
 *
 * @module services/session/__tests__/turn-windows-sdk-shapes
 */
import { describe, it, expect } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { feedProjector } from '../session-event-normalizer.js';
import { SessionStateProjector } from '../session-state-projector.js';
import { mapSdkMessage } from '../../runtimes/claude-code/sdk/sdk-event-mapper.js';
import { createToolState } from '../../runtimes/claude-code/agent-types.js';
import type { AgentSession } from '../../runtimes/claude-code/agent-types.js';

/** An SDK message, kept SDK-type-free at this layer (the mapper owns that import). */
type Msg = Parameters<typeof mapSdkMessage>[0];

/** The CLI's interrupt sentinel text, as `phantom-cancellation` recognizes it. */
const SENTINEL = 'The user doesn’t want to proceed with this tool use.';

function resultMsg(): Msg {
  return {
    type: 'result',
    subtype: 'success',
    uuid: 'result-uuid',
    session_id: 'sdk-1',
    is_error: false,
  } as unknown as Msg;
}

/** A `user` message carrying the CLI's cancellation sentinel as a tool_result. */
function sentinelMsg(toolUseId: string): Msg {
  return {
    type: 'user',
    uuid: `u-${toolUseId}`,
    session_id: 'sdk-1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: SENTINEL }],
    },
  } as unknown as Msg;
}

/** A built-in tool's result, delivered as the CLI's summary message. */
function toolUseSummaryMsg(toolUseId: string): Msg {
  return {
    type: 'tool_use_summary',
    summary: 'Read 3 files',
    preceding_tool_use_ids: [toolUseId],
  } as unknown as Msg;
}

/** Intermediate output from a long-running tool. */
function toolProgressMsg(toolUseId: string): Msg {
  return {
    type: 'tool_progress',
    tool_use_id: toolUseId,
    content: 'still going',
  } as unknown as Msg;
}

/** The close of a tool block that was open when the result landed. */
function contentBlockStopMsg(): Msg {
  return { type: 'stream_event', event: { type: 'content_block_stop' } } as unknown as Msg;
}

/** The model saying something new — the shape of a genuine wake-up. */
function textDeltaMsg(text: string): Msg {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  } as unknown as Msg;
}

/** The model opening a NEW tool call — the other genuine wake-up shape. */
function toolUseStartMsg(id: string, name: string): Msg {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      content_block: { type: 'tool_use', id, name },
    },
  } as unknown as Msg;
}

/**
 * Drive raw SDK messages through the real mapper into a projector, and report
 * the window boundaries the durable stream ended up with.
 *
 * @param messages - The SDK messages, in the order the CLI produced them.
 * @param opts.toolInFlight - A tool id/name to pre-register as running when the
 *   sequence begins, mirroring a turn whose tool had not finished at the result.
 */
async function windowsFor(
  messages: Msg[],
  opts: { toolInFlight?: { id: string; name: string } } = {}
): Promise<{ types: string[]; starts: number; ends: number }> {
  const projector = new SessionStateProjector('sdk-shapes');
  const session = {} as AgentSession;
  const toolState = createToolState();
  if (opts.toolInFlight) {
    toolState.setToolState(true, opts.toolInFlight.name, opts.toolInFlight.id);
    toolState.toolNameById.set(opts.toolInFlight.id, opts.toolInFlight.name);
  }

  async function* stream(): AsyncIterable<StreamEvent> {
    for (const message of messages) {
      yield* mapSdkMessage(message, session, 'sdk-shapes', toolState);
    }
  }

  await feedProjector(projector, stream(), { userMessage: 'do the thing' });
  const types = projector.replayFrom(0).map((e) => e.type);
  return {
    types,
    starts: types.filter((t) => t === 'turn_start').length,
    ends: types.filter((t) => t === 'turn_end').length,
  };
}

describe('turn windows against real SDK message shapes', () => {
  // The four settling shapes. Each maps to a content-SHAPED event
  // (`tool_result`/`tool_progress`) and each is a tool that was already running
  // reporting in after the result — so each must leave exactly one window.
  const settling: Array<{ name: string; messages: Msg[] }> = [
    {
      name: 'the CLI’s interrupt sentinel arriving after the result',
      messages: [resultMsg(), sentinelMsg('toolu_late')],
    },
    {
      name: 'a tool_use_summary for a tool that was in flight',
      messages: [resultMsg(), toolUseSummaryMsg('toolu_a')],
    },
    {
      name: 'tool progress from a long-running tool',
      messages: [resultMsg(), toolProgressMsg('toolu_a')],
    },
    {
      name: 'the content_block_stop of a tool still open at the result',
      messages: [resultMsg(), contentBlockStopMsg()],
    },
    {
      name: 'an assistant turn, its result, then the tool summary behind it',
      messages: [textDeltaMsg('here you go'), resultMsg(), toolUseSummaryMsg('toolu_a')],
    },
  ];

  for (const { name, messages } of settling) {
    it(`grows ONE window: ${name}`, async () => {
      const { starts, ends } = await windowsFor(messages, {
        toolInFlight: { id: 'toolu_a', name: 'Read' },
      });
      expect({ starts, ends }).toEqual({ starts: 1, ends: 1 });
    });
  }

  // …and the shapes that ARE the agent waking up still open a second window,
  // which is the whole point of the feature.
  it('grows TWO windows when the model says something new after the result', async () => {
    const { types, starts, ends } = await windowsFor([
      textDeltaMsg('first half'),
      resultMsg(),
      textDeltaMsg('the background task finished, carrying on'),
      resultMsg(),
    ]);
    expect({ starts, ends }).toEqual({ starts: 2, ends: 2 });
    // No `status_change` between them: this `result` carries no cost or model
    // fields, so `toStatusChange` has nothing to project.
    expect(types).toEqual([
      'turn_start',
      'text_delta',
      'turn_end',
      'turn_start',
      'text_delta',
      'turn_end',
    ]);
  });

  it('grows TWO windows when the model opens a NEW tool call after the result', async () => {
    const { starts, ends } = await windowsFor([
      resultMsg(),
      toolUseStartMsg('toolu_new', 'Bash'),
      resultMsg(),
    ]);
    expect({ starts, ends }).toEqual({ starts: 2, ends: 2 });
  });

  // The realistic incident shape end to end, with the tool opened by the model
  // rather than pre-registered, so the whole sequence is one the mapper could
  // really have produced: the model speaks, starts a tool, the result lands with
  // that tool still open, the sentinel that used to read as a refusal arrives,
  // the tool closes and reports, and only THEN the agent resumes.
  //
  // The `content_block_stop` is not decoration: the mapper suppresses text
  // deltas while a tool block is open, so a turn where the model speaks again is
  // necessarily one where its tool closed first.
  it('grows exactly two windows for the full wake-up sequence', async () => {
    const { types, starts, ends } = await windowsFor([
      textDeltaMsg('starting the task'),
      toolUseStartMsg('toolu_a', 'Read'),
      resultMsg(),
      sentinelMsg('toolu_a'),
      contentBlockStopMsg(),
      toolUseSummaryMsg('toolu_a'),
      textDeltaMsg('that finished, here is the rest'),
      resultMsg(),
    ]);
    expect({ starts, ends }).toEqual({ starts: 2, ends: 2 });
    // Every settling event lands AFTER the first close and BEFORE the reopen —
    // outside both windows, which is where events nobody's turn owns belong.
    expect(types).toEqual([
      'turn_start',
      'text_delta',
      'tool_call',
      'turn_end',
      'tool_result',
      'tool_result',
      'tool_result',
      'turn_start',
      'text_delta',
      'turn_end',
    ]);
  });

  // The reopened window is tagged so both projections can tell it apart from a
  // turn a person asked for.
  it('tags the reopened window origin runtime and the first one not at all', async () => {
    const projector = new SessionStateProjector('sdk-origin');
    const session = {} as AgentSession;
    const toolState = createToolState();
    async function* stream(): AsyncIterable<StreamEvent> {
      for (const message of [resultMsg(), textDeltaMsg('awake'), resultMsg()]) {
        yield* mapSdkMessage(message, session, 'sdk-origin', toolState);
      }
    }
    await feedProjector(projector, stream(), { userMessage: 'go' });

    const starts = projector
      .replayFrom(0)
      .filter((e): e is Extract<typeof e, { type: 'turn_start' }> => e.type === 'turn_start');
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ userMessage: 'go' });
    expect(starts[0]?.origin).toBeUndefined();
    expect(starts[1]).toMatchObject({ origin: 'runtime' });
    expect(starts[1]?.userMessage).toBeUndefined();
  });
});
