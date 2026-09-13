import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mapSdkMessage } from '../../sdk-event-mapper.js';
import { createToolState } from '../../../agent-types.js';
import type { AgentSession, ToolState } from '../../../agent-types.js';
import type { StreamEvent } from '@dorkos/shared/types';
import { toRawSessionEvent } from '../../../../../session/session-event-normalizer.js';

/**
 * A gated tool call must never claim it finished before it ran (DOR-2011).
 *
 * The sequence below is the one a live `default`-permission-mode turn produced
 * on 2026-09-12 for "Create a file named hello.txt containing the word hello.":
 * the model streams the `Write` block, the SDK closes it with
 * `content_block_stop`, DorkOS raises the permission prompt, and only after the
 * operator approves does the real result come back on a `user` message. The
 * `content_block_stop` is the model finishing the ARGUMENTS — it says nothing
 * about whether the tool ran, and the durable stream used to project it as a
 * terminal `tool_result` with `status: 'complete'` and no `result`, so the
 * write read as done for the whole approval wait.
 */

/** Collect every event one SDK message maps to. */
async function collect(
  message: SDKMessage,
  session: AgentSession,
  toolState: ToolState
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of mapSdkMessage(message, session, 'session-1', toolState)) events.push(e);
  return events;
}

/** A bare session — none of these messages touch it. */
function makeSession(): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: true,
    pendingInteractions: new Map(),
    eventQueue: [],
  };
}

/** The SDK `stream_event` envelope, as the CLI emits it. */
function streamEvent(event: Record<string, unknown>): SDKMessage {
  return { type: 'stream_event', event } as unknown as SDKMessage;
}

/** A `user` message carrying one tool_result block. */
function toolResultMessage(block: Record<string, unknown>): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', ...block }] },
  } as unknown as SDKMessage;
}

/** Drive the model's half of the live trace: open the block, stream its input, close it. */
async function streamWriteCall(
  session: AgentSession,
  toolState: ToolState,
  toolCallId = 'toolu_0151hgcppF5Kpk1mQtFx5Uef'
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  events.push(
    ...(await collect(
      streamEvent({
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: toolCallId, name: 'Write' },
      }),
      session,
      toolState
    ))
  );
  events.push(
    ...(await collect(
      streamEvent({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/hello.txt"' },
      }),
      session,
      toolState
    ))
  );
  events.push(...(await collect(streamEvent({ type: 'content_block_stop' }), session, toolState)));
  return events;
}

/** Every `tool_result` event in a list, narrowed for its payload. */
function toolResults(events: StreamEvent[]) {
  return events.filter((e) => e.type === 'tool_result');
}

/** One durable frame, read back for assertion. */
interface DurableFrame {
  type: string;
  status?: string;
  result?: string;
}

/**
 * The durable frames these live events project onto.
 *
 * The durable stream is what a client actually reads, and it is where the lie
 * was visible: `session-event-normalizer` maps `tool_call_end` onto the SAME
 * `tool_result` frame type a real result uses, so the mapper's status is
 * published verbatim under a name that means "this call ended".
 *
 * Re-typed on the way out because `RawSessionEvent` is `Omit<SessionEvent,
 * 'seq'>`, and `Omit` over a union collapses it to the keys every member shares
 * — leaving `type` as the only field TypeScript will read (the projector notes
 * the same wart). The payload really is on the wire; this reads it back.
 */
function durableFrames(events: StreamEvent[]): DurableFrame[] {
  return events
    .map(toRawSessionEvent)
    .filter((event) => event !== null)
    .map((event) => event as unknown as DurableFrame);
}

describe('gated tool calls report an honest status', () => {
  it('does not report a Write as complete while its approval is still open', async () => {
    const session = makeSession();
    const toolState = createToolState();

    const beforeApproval = await streamWriteCall(session, toolState);

    // The live bug, stated as the assertion: not one frame emitted before the
    // permission prompt may claim the call finished.
    expect(
      beforeApproval.filter(
        (e) => e.data !== undefined && (e.data as { status?: string }).status === 'complete'
      )
    ).toEqual([]);
    // And no terminal result exists yet, under any status.
    expect(toolResults(beforeApproval)).toEqual([]);
  });

  it('emits exactly one complete tool_result, carrying the result, after approval', async () => {
    const session = makeSession();
    const toolState = createToolState();
    const toolCallId = 'toolu_0151hgcppF5Kpk1mQtFx5Uef';

    const beforeApproval = await streamWriteCall(session, toolState, toolCallId);
    const afterApproval = await collect(
      toolResultMessage({
        tool_use_id: toolCallId,
        content: [{ type: 'text', text: 'File created successfully at: /tmp/hello.txt' }],
      }),
      session,
      toolState
    );

    const results = toolResults([...beforeApproval, ...afterApproval]);
    expect(results).toHaveLength(1);
    expect(results[0]?.data).toMatchObject({
      toolCallId,
      toolName: 'Write',
      status: 'complete',
      result: 'File created successfully at: /tmp/hello.txt',
    });
  });

  it('keeps the call in flight between the model finishing its input and the result', async () => {
    const session = makeSession();
    const toolState = createToolState();

    const events = await streamWriteCall(session, toolState);
    const end = events.find((e) => e.type === 'tool_call_end');

    // `running` and not `pending`: the call is either executing or queued behind
    // a permission prompt, and `pending` is this codebase's word for an
    // interaction a PERSON still owes an answer to.
    expect(end?.data).toMatchObject({ toolName: 'Write', status: 'running' });
  });

  it('reports a denied tool call as an error, not as complete', async () => {
    const session = makeSession();
    const toolState = createToolState();
    const toolCallId = 'toolu_01BzQsMmWnPd3YaNwH6uUcLb';

    await streamWriteCall(session, toolState, toolCallId);
    const denied = await collect(
      toolResultMessage({
        tool_use_id: toolCallId,
        is_error: true,
        content: [{ type: 'text', text: 'User denied tool execution. Reason: not now' }],
      }),
      session,
      toolState
    );

    expect(toolResults(denied)[0]?.data).toMatchObject({
      toolCallId,
      status: 'error',
      result: 'User denied tool execution. Reason: not now',
    });
  });

  it('publishes no complete tool_result on the durable stream until the result lands', async () => {
    const session = makeSession();
    const toolState = createToolState();
    const toolCallId = 'toolu_0151hgcppF5Kpk1mQtFx5Uef';

    const beforeApproval = durableFrames(await streamWriteCall(session, toolState, toolCallId));
    expect(
      beforeApproval.filter((e) => e.type === 'tool_result' && e.status === 'complete')
    ).toEqual([]);

    const afterApproval = durableFrames(
      await collect(
        toolResultMessage({
          tool_use_id: toolCallId,
          content: [{ type: 'text', text: 'File created successfully at: /tmp/hello.txt' }],
        }),
        session,
        toolState
      )
    );
    const settled = afterApproval.filter(
      (e) => e.type === 'tool_result' && e.status === 'complete'
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]?.result).toBe('File created successfully at: /tmp/hello.txt');
  });

  it('still settles a tool whose result carried no text at all', async () => {
    const session = makeSession();
    const toolState = createToolState();
    const toolCallId = 'toolu_image_only';

    await streamWriteCall(session, toolState, toolCallId);
    // A `Read` of a PNG: the only block is an image, so there is no result text.
    // `tool_call_end` no longer settles anything, so this frame is the only
    // thing that can — without it the call spins forever.
    const settled = await collect(
      toolResultMessage({
        tool_use_id: toolCallId,
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }],
      }),
      session,
      toolState
    );

    const results = toolResults(settled);
    expect(results).toHaveLength(1);
    expect(results[0]?.data).toMatchObject({ toolCallId, status: 'complete' });
    expect((results[0]?.data as { result?: string }).result).toBeUndefined();
  });
});
