/**
 * Phantom-cancellation mitigation (DOR-1087) at the send-loop seam.
 *
 * The CLI writes its interrupt sentinel as a tool_result when it cancels a call
 * the model had pending — a message the model reads as a user refusal. (What
 * triggers that cancellation is not settled; see `phantom-cancellation.ts`.) The
 * loop must (1) steer a corrective note into the held prompt stream so the model
 * learns it was not the user, and (2) yield a `system_status` event so the
 * operator sees what happened. A subagent's phantom cannot be corrected inside
 * the subagent, so its note goes to the coordinator instead (DOR-1150). A REAL
 * operator deny must trigger neither.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import {
  phantomCancellationStats,
  resetPhantomCancellations,
} from '../../../../observability/phantom-cancellations.js';
import type { AgentSession } from '../../agent-types.js';
import { CLI_INTERRUPT_SENTINEL } from '../phantom-cancellation.js';
import { DEFERRED_CLOSE_TIMEOUT_MS } from '../stdin-hold.js';
import { logger } from '../../../../../lib/logger.js';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi.fn().mockResolvedValue('<env>mock</env>'),
  renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
}));
vi.mock('../../tooling/tool-filter.js', () => ({
  resolveToolConfig: vi
    .fn()
    .mockReturnValue({ tasks: true, relay: true, mesh: true, adapter: true }),
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/project'),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue('/mock/project'),
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(undefined) },
}));
vi.mock('../../../../core/credential-env.js', () => ({
  resolveClaudeCredentialEnv: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../sdk/context-usage.js', () => ({
  fetchContextBreakdown: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../sdk/subscription-usage.js', () => ({
  fetchSubscriptionUsage: vi.fn().mockResolvedValue(undefined),
}));
// Inert mapper: the phantom path reads the RAW SDK message and yields its own
// system_status, independent of mapped output.
vi.mock('../../sdk/sdk-event-mapper.js', () => ({
  mapSdkMessage: vi.fn(async function* () {}),
}));

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: false,
    pendingInteractions: new Map(),
    eventQueue: [],
    ...overrides,
  };
}

function makeOpts(overrides: Partial<MessageSenderOpts> = {}): MessageSenderOpts {
  return { cwd: '/mock/project', onSdkSessionRebind: async () => {}, ...overrides };
}

function sentinelMsg(
  toolUseIds: string | string[],
  parentToolUseId: string | null = null
): SDKMessage {
  const ids = Array.isArray(toolUseIds) ? toolUseIds : [toolUseIds];
  return {
    type: 'user',
    uuid: `u-${ids[0]}`,
    session_id: 'sdk-1',
    parent_tool_use_id: parentToolUseId,
    message: {
      role: 'user',
      content: ids.map((toolUseId) => ({
        type: 'tool_result',
        tool_use_id: toolUseId,
        is_error: true,
        content: CLI_INTERRUPT_SENTINEL,
      })),
    },
  } as unknown as SDKMessage;
}

function resultMsg(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    uuid: 'result-uuid',
    session_id: 'sdk-1',
    is_error: false,
  } as unknown as SDKMessage;
}

/**
 * A background task settling. The CLI queues its notification here and delivers
 * it in a LATER segment — it does not arrive with this message.
 */
function taskSettledMsg(taskId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status: 'completed',
    summary: 'done',
    session_id: `subagent-${taskId}`,
    uuid: `task-settled-${taskId}`,
  } as unknown as SDKMessage;
}

/**
 * The `system/init` that opens a query segment. One AFTER a `result` is how the
 * CLI announces a delivery segment on the stream, and it is what drains the
 * queued notifications into it — there is no user message for this (DOR-1238).
 */
function initMsg(): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 'sdk-1',
    uuid: 'init-uuid',
    tools: [],
    slash_commands: [],
  } as unknown as SDKMessage;
}

/**
 * Drive one turn and capture (a) every StreamEvent yielded and (b) every user
 * message that traveled the held prompt stream (the steering channel).
 */
async function runTurn(
  session: AgentSession,
  messages: Array<SDKMessage | (() => void)>
): Promise<{ events: StreamEvent[]; promptMessages: string[] }> {
  const promptMessages: string[] = [];
  let drained: Promise<void> | undefined;
  vi.mocked(query).mockImplementation((args) => {
    // Consume the held prompt like the real subprocess would, recording each
    // user message (the initial prompt + any steered corrections).
    const prompt = args.prompt as AsyncIterable<{ message: { content: string } }>;
    drained = (async () => {
      for await (const m of prompt) promptMessages.push(m.message.content);
    })();
    return {
      [Symbol.asyncIterator]: async function* () {
        // A function entry runs MID-STREAM (e.g. stamping an interrupt while
        // the turn is live, as the real stop path does) instead of yielding.
        for (const m of messages) {
          if (typeof m === 'function') m();
          else yield m;
        }
      },
    } as unknown as ReturnType<typeof query>;
  });
  const events: StreamEvent[] = [];
  for await (const event of executeSdkQuery('s1', 'hello', session, makeOpts())) {
    events.push(event);
  }
  await drained;
  return { events, promptMessages };
}

/**
 * Narrow helper: StreamEvent's `data` is not discriminated by `type`. The
 * phantom notice carries NO `status` field (the client strip drops any
 * system_status that has one), so it is recognized by its message text.
 */
function isPhantomStatus(e: StreamEvent): boolean {
  const data = e.data as { message?: string; status?: string };
  return (
    e.type === 'system_status' &&
    data.status === undefined &&
    typeof data.message === 'string' &&
    data.message.includes('background task finished at the wrong moment')
  );
}

describe('executeSdkQuery — phantom cancellation mitigation (DOR-1087)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPhantomCancellations();
  });

  afterEach(() => {
    resetPhantomCancellations();
  });

  // The tripwire's flag-OFF leg (DOR-1288). Task 5.1 compares this count against
  // the pump's, so the resume path must attribute its phantoms to `turn` — a
  // phantom counted under the wrong path would make persistence look like the
  // cure or the cause depending on which way it landed.
  it('counts its phantoms against the turn path, never the pump path', async () => {
    await runTurn(makeSession(), [
      sentinelMsg(['toolu_x', 'toolu_y']),
      sentinelMsg('toolu_sub', 'toolu_parent'),
      resultMsg(),
    ]);

    const stats = phantomCancellationStats();
    expect(stats.byPath).toEqual({ turn: 3, pump: 0 });
    expect(stats.mainThread).toBe(2);
    expect(stats.subagent).toBe(1);
    // The resume path DOES steer, and the counter records that it did — the one
    // field that tells the two paths' records apart after the fact.
    expect(stats.steered).toBe(2);
  });

  it('counts nothing for a real operator stop mid-turn', async () => {
    const session = makeSession();
    await runTurn(session, [
      () => {
        session.interruptRequestedAt = Date.now();
      },
      sentinelMsg('toolu_stopped'),
      resultMsg(),
    ]);

    expect(phantomCancellationStats().total).toBe(0);
  });

  it('steers a corrective note and yields a system_status on a main-thread phantom', async () => {
    const { events, promptMessages } = await runTurn(makeSession(), [
      sentinelMsg('toolu_phantom'),
      resultMsg(),
    ]);

    const status = events.find(isPhantomStatus);
    expect(status).toBeDefined();

    expect(promptMessages[0]).toBe('hello');
    const note = promptMessages.find((m) => m.includes('toolu_phantom'));
    expect(note).toBeDefined();
    expect(note).toContain('not by the user');
  });

  // A subagent's input stream is not ours to write to — but its COORDINATOR's
  // is, and the coordinator is the one about to read a false "the user declined"
  // in that subagent's report (DOR-1150).
  it('steers the coordinator a note naming the subagent task on a subagent phantom', async () => {
    const { events, promptMessages } = await runTurn(makeSession(), [
      sentinelMsg('toolu_sub', 'toolu_parent'),
      resultMsg(),
    ]);

    expect(events.some(isPhantomStatus)).toBe(true);
    const note = promptMessages.find((m) => m.includes('dorkos-system-note'));
    expect(note).toBeDefined();
    expect(note).toContain('toolu_sub');
    expect(note).toContain('toolu_parent');
    expect(note).toContain('FALSE');
  });

  it('covers every parallel cancellation with ONE note naming all ids', async () => {
    const { events, promptMessages } = await runTurn(makeSession(), [
      sentinelMsg(['toolu_A', 'toolu_B', 'toolu_C']),
      resultMsg(),
    ]);

    expect(events.filter(isPhantomStatus)).toHaveLength(1);
    const notes = promptMessages.filter((m) => m.includes('dorkos-system-note'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('toolu_A');
    expect(notes[0]).toContain('toolu_B');
    expect(notes[0]).toContain('toolu_C');
  });

  it('surfaces but does NOT steer a post-result phantom when no background task is owed', async () => {
    const { events, promptMessages } = await runTurn(makeSession(), [
      resultMsg(),
      sentinelMsg('toolu_late'),
    ]);

    expect(events.some(isPhantomStatus)).toBe(true);
    expect(promptMessages).toEqual(['hello']);
  });

  it('does nothing when the operator interrupted mid-turn', async () => {
    const session = makeSession();
    const { events, promptMessages } = await runTurn(session, [
      // The stop path stamps the session while the turn is live; the CLI's
      // trailing sentinel then arrives in the same stream.
      () => {
        session.interruptRequestedAt = Date.now();
      },
      sentinelMsg('toolu_after_stop'),
      resultMsg(),
    ]);

    expect(events.some(isPhantomStatus)).toBe(false);
    expect(promptMessages).toEqual(['hello']);
  });

  it('is not blinded by a stop stamped in a PREVIOUS turn', async () => {
    const session = makeSession({ interruptRequestedAt: Date.now() });
    const { events } = await runTurn(session, [sentinelMsg('toolu_new_turn'), resultMsg()]);

    expect(events.some(isPhantomStatus)).toBe(true);
  });

  // A turn that runs background tasks is MULTI-SEGMENT: a task settles, the CLI
  // ends the segment with a `result`, and only THEN opens a new segment — a
  // second `system/init` — to drain the queued notification into. Phantoms land
  // in that delivery segment, where steering used to be dead because the first
  // `result` both tripped the gate and closed the held prompt (DOR-1149).
  describe('multi-segment turns (DOR-1149)', () => {
    it('steers a phantom in the delivery segment of a SINGLE background task', async () => {
      // The shape that matters most, and the one an earlier attempt at this fix
      // missed: the task settles BEFORE the segment-ending result, so keying on
      // "tasks still running" left nothing outstanding at the deferring result.
      const { events, promptMessages } = await runTurn(makeSession(), [
        initMsg(),
        taskSettledMsg('task-1'),
        resultMsg(),
        initMsg(),
        sentinelMsg('toolu_in_delivery_segment'),
        resultMsg(),
      ]);

      expect(events.some(isPhantomStatus)).toBe(true);
      const note = promptMessages.find((m) => m.includes('toolu_in_delivery_segment'));
      expect(note).toBeDefined();
      expect(note).toContain('not by the user');
    });

    it('stops steering once the delivery segment has closed', async () => {
      const { promptMessages } = await runTurn(makeSession(), [
        initMsg(),
        taskSettledMsg('task-1'),
        resultMsg(),
        // The delivery segment opens (draining the queue) and closes again, so
        // the next `result` finds nothing outstanding and stdin goes.
        initMsg(),
        resultMsg(),
        sentinelMsg('toolu_after_delivery'),
      ]);

      expect(promptMessages).toEqual(['hello']);
    });

    it('releases the input stream when no delivery segment ever opens', async () => {
      // The pathological case nothing else reaches: a notification that settles,
      // holds a close, and whose segment never opens, with no further `result`
      // to re-decide. The fake CLI models the real one — it only finishes once
      // stdin closes — so without the deadline this turn would never end.
      vi.useFakeTimers();
      try {
        let stdinClosed!: () => void;
        const stdinClosedPromise = new Promise<void>((resolve) => {
          stdinClosed = resolve;
        });
        vi.mocked(query).mockImplementation((args) => {
          const prompt = args.prompt as AsyncIterable<{ message: { content: string } }>;
          void (async () => {
            for await (const _m of prompt) {
              /* drain */
            }
            stdinClosed();
          })();
          return {
            [Symbol.asyncIterator]: async function* () {
              yield taskSettledMsg('task-that-never-delivers');
              yield resultMsg();
              // The CLI now waits on stdin, exactly as it does in production.
              await stdinClosedPromise;
            },
          } as unknown as ReturnType<typeof query>;
        });

        const turn = (async () => {
          for await (const _e of executeSdkQuery('s1', 'hello', makeSession(), makeOpts())) {
            /* drain */
          }
        })();

        await vi.advanceTimersByTimeAsync(DEFERRED_CLOSE_TIMEOUT_MS + 1_000);
        await turn;

        // The turn completing at all is the primary evidence; the warning is
        // what distinguishes "the deadline fired" from "it never deferred".
        expect(vi.mocked(logger.warn).mock.calls.map((c) => c[0])).toContain(
          '[sendMessage] deferred close expired; releasing input stream'
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('releases the held prompt once the delivery segment ends', async () => {
      // `runTurn` awaits the prompt generator to completion, so this can only
      // pass if the held prompt was closed rather than left open.
      const { events } = await runTurn(makeSession(), [
        initMsg(),
        taskSettledMsg('task-1'),
        resultMsg(),
        initMsg(),
        resultMsg(),
      ]);

      expect(events.some((e) => e.type === 'done')).toBe(true);
    });
  });

  it('keeps a budget for the main thread when helper phantoms arrive in a burst', async () => {
    // Subagent phantoms outnumbered main-thread ones 14 to 10 in the 2026-08-11
    // session, and one helper alone produced four. On a shared budget that burst
    // spent every note before the coordinator's OWN cancellation — the one where
    // the recipient is the victim — could be corrected (DOR-1150).
    const burst = ['a', 'b', 'c', 'd'].map((s) => sentinelMsg(`toolu_sub_${s}`, 'toolu_parent'));
    const { promptMessages } = await runTurn(makeSession(), [
      ...burst,
      sentinelMsg('toolu_main_thread'),
      resultMsg(),
    ]);

    const mainNote = promptMessages.find((m) => m.includes('toolu_main_thread'));
    expect(mainNote).toBeDefined();
    expect(mainNote).toContain('did NOT deny');
  });

  it('caps steered corrections per turn but keeps surfacing status events', async () => {
    const phantoms = ['a', 'b', 'c', 'd', 'e'].map((s) => sentinelMsg(`toolu_${s}`));
    const { events, promptMessages } = await runTurn(makeSession(), [...phantoms, resultMsg()]);

    const statuses = events.filter(isPhantomStatus);
    expect(statuses).toHaveLength(5);
    // 1 initial prompt + at most 3 steered notes (PHANTOM_CORRECTIONS_MAX_PER_TURN).
    expect(promptMessages).toHaveLength(4);
  });
});
