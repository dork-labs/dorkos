/**
 * The CLI's stdin stays open while the turn is still alive (DOR-1238).
 *
 * Closing the held prompt at a `result` sends the CLI's stdin an EOF. The CLI
 * keeps running — it finishes its in-flight subagents and delivers their
 * `<task-notification>` segments — but its SDK control stream is gone, so every
 * tool matched by the PreToolUse hook is cancelled at entry with the interrupt
 * sentinel ("PreToolUse SDK callback hook cancelled (control stream closed)")
 * and every corrective push is dropped ("Dropping write to ended stdin
 * stream"). Nine phantoms in one production turn, all `steered:false`.
 *
 * So the early close does not merely cost the steering opportunity, as
 * DOR-1149's header claimed — it CAUSES the cancellations. These tests drive
 * the send loop against a fake CLI that behaves like the real one in the way
 * that matters: it does not finish until stdin closes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { CLI_INTERRUPT_SENTINEL } from '../phantom-cancellation.js';
import { DEFERRED_CLOSE_TIMEOUT_MS } from '../stdin-hold.js';
import { logger } from '../../../../../lib/logger.js';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { readDeliverySegmentFrames } from './fixtures/background-tasks.js';

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
// Inert mapper: every assertion here is about the input stream, not the mapped
// output.
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

function makeOpts(): MessageSenderOpts {
  return { cwd: '/mock/project', onSdkSessionRebind: async () => {} };
}

/** The SDK's level signal: the FULL set of live background tasks after a change. */
function tasksChanged(
  tasks: Array<{ id: string; type: 'local_agent' | 'local_bash' }>
): SDKMessage {
  return {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: tasks.map(({ id, type }) => ({
      task_id: id,
      task_type: type,
      description: `task ${id}`,
    })),
    uuid: `level-${tasks.map((t) => t.id).join('-')}`,
    session_id: 'sdk-1',
  } as unknown as SDKMessage;
}

/** A background task settling — the delivery it owes arrives in a LATER segment. */
function taskSettledMsg(taskId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status: 'completed',
    session_id: `subagent-${taskId}`,
    uuid: `task-settled-${taskId}`,
  } as unknown as SDKMessage;
}

/**
 * The `system/init` that opens a query segment.
 *
 * Every stream below starts with one, as a real one does, because an init that
 * follows a `result` is what tells the tracker a DELIVERY segment has opened —
 * the queued notifications are drained into it. There is no user message to
 * stand in for that: the CLI never sends one on the stream (DOR-1238).
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

/** The CLI's cancellation sentinel, as a tool_result the model reads as a deny. */
function sentinelMsg(toolUseId: string, parentToolUseId: string | null = null): SDKMessage {
  return {
    type: 'user',
    uuid: `u-${toolUseId}`,
    session_id: 'sdk-1',
    parent_tool_use_id: parentToolUseId,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          is_error: true,
          content: CLI_INTERRUPT_SENTINEL,
        },
      ],
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

/** The model speaking — the other proof that a segment is running. */
function assistantMsg(): SDKMessage {
  return {
    type: 'assistant',
    uuid: 'assistant-uuid',
    session_id: 'sdk-1',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'thinking it over' }] },
  } as unknown as SDKMessage;
}

/**
 * A pause in the scripted stream that records whether stdin has been closed
 * YET, optionally after letting the clock run first.
 *
 * Recorded rather than asserted in place: an assertion that throws inside the
 * SDK generator is caught by the send loop's own error handling and turns into
 * an error event, so the test would go green on a failure.
 */
interface Probe {
  probe: string;
  advanceMs?: number;
}

/** The process dying under the turn, mid-stream. */
interface Crash {
  crash: string;
}

/** One scripted stream: SDK messages, with probes and crashes between them. */
type StreamEntry = SDKMessage | Probe | Crash;

function isProbe(entry: StreamEntry): entry is Probe {
  return 'probe' in entry;
}

function isCrash(entry: StreamEntry): entry is Crash {
  return 'crash' in entry;
}

interface TurnRun {
  events: StreamEvent[];
  /** Every user message that traveled the held prompt — the steering channel. */
  promptMessages: string[];
  /** What each probe saw, in stream order. */
  probes: Array<{ label: string; stdinClosed: boolean }>;
  /** The `steered` flag of every phantom the loop reported, in order. */
  steered: boolean[];
  /** Whether stdin was closed by the time the turn was over. */
  stdinClosed: boolean;
}

/** Every "expired, but an agent is live" log the loop wrote, in order. */
function stillHoldingLogs(): unknown[] {
  return vi
    .mocked(logger.debug)
    .mock.calls.filter(
      (call) =>
        call[0] === '[sendMessage] deadline expired but a background agent is live; still holding'
    );
}

/** Let every pending microtask run, so a close the loop just made is visible. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/**
 * Drive one turn against a fake CLI that only finishes once stdin closes —
 * exactly as the real one does. A turn that never closes the held prompt
 * therefore hangs rather than passing quietly, which is what makes the final
 * "and then it closed" assertions load-bearing.
 */
async function runTurn(session: AgentSession, entries: StreamEntry[]): Promise<TurnRun> {
  const promptMessages: string[] = [];
  const probes: Array<{ label: string; stdinClosed: boolean }> = [];
  let stdinClosed = false;
  let noteStdinClosed!: () => void;
  const stdinEof = new Promise<void>((resolve) => {
    noteStdinClosed = resolve;
  });
  let drained: Promise<void> | undefined;

  vi.mocked(query).mockImplementation((args) => {
    const prompt = args.prompt as AsyncIterable<{ message: { content: string } }>;
    drained = (async () => {
      for await (const m of prompt) promptMessages.push(m.message.content);
      stdinClosed = true;
      noteStdinClosed();
    })();
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const entry of entries) {
          if (isProbe(entry)) {
            if (entry.advanceMs !== undefined) await vi.advanceTimersByTimeAsync(entry.advanceMs);
            await settleMicrotasks();
            probes.push({ label: entry.probe, stdinClosed });
            continue;
          }
          if (isCrash(entry)) throw new Error(entry.crash);
          yield entry;
        }
        // The CLI waits on stdin, and so does this.
        await stdinEof;
      },
    } as unknown as ReturnType<typeof query>;
  });

  const events: StreamEvent[] = [];
  for await (const event of executeSdkQuery('s1', 'hello', session, makeOpts())) {
    events.push(event);
  }
  await drained;
  const steered = vi
    .mocked(logger.warn)
    .mock.calls.filter(
      (call) => call[0] === '[sendMessage] phantom tool-call cancellation detected'
    )
    .map((call) => (call[1] as { steered: boolean }).steered);
  return { events, promptMessages, probes, steered, stdinClosed };
}

describe('executeSdkQuery — stdin stays open while the turn is alive (DOR-1238)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // T1. The whole property in one turn: an agent is live at the `result`, so
  // stdin stays open with no deadline at all; phantoms that land while it runs
  // are steered for real; and the close happens at the `result` where nothing is
  // live or owed.
  it('holds stdin open at a result while a background agent is live, and steers what lands next', async () => {
    const run = await runTurn(makeSession(), [
      initMsg(),
      tasksChanged([{ id: 'agent-1', type: 'local_agent' }]),
      resultMsg(),
      // No deadline may be armed for a live agent: the level signal is what ends
      // this hold, and a wall clock would fire straight into a running segment.
      { probe: 'agent-live', advanceMs: DEFERRED_CLOSE_TIMEOUT_MS * 2 },
      sentinelMsg('toolu_sub', 'toolu_parent'),
      sentinelMsg('toolu_main'),
      tasksChanged([]),
      taskSettledMsg('agent-1'),
      initMsg(), // the delivery segment opens and drains the queue
      resultMsg(),
      { probe: 'turn-over' },
    ]);

    expect(run.probes).toEqual([
      { label: 'agent-live', stdinClosed: false },
      { label: 'turn-over', stdinClosed: true },
    ]);
    // Both phantoms reached the model — the thing that was `steered:false` nine
    // times out of nine in the production turn.
    expect(run.steered).toEqual([true, true]);
    expect(run.promptMessages.some((m) => m.includes('toolu_sub'))).toBe(true);
    expect(run.promptMessages.some((m) => m.includes('toolu_main'))).toBe(true);
    expect(run.events.some((e) => e.type === 'done')).toBe(true);
  });

  // The `finally` is the subprocess-exit guarantee: a turn that leaves without
  // ever reaching a `result` still closes stdin, live agent or not, so a hold
  // can never leak the subprocess.
  it('closes stdin when the process dies with an agent still live', async () => {
    const run = await runTurn(makeSession(), [
      initMsg(),
      tasksChanged([{ id: 'agent-1', type: 'local_agent' }]),
      { crash: 'the process went away' },
    ]);

    expect(run.stdinClosed).toBe(true);
    expect(run.events.some((e) => e.type === 'error')).toBe(true);
    expect(run.events.some((e) => e.type === 'done')).toBe(true);
  });

  // T2. The deadline exists only for an owed delivery with nothing live, and it
  // must not survive the segment it was waiting for — a deadline that fires
  // mid-segment is the bug, not the safety net. The segment announces itself
  // with a second `system/init`, which is also what drains the queue.
  it('drops the deadline the moment the delivery segment opens', async () => {
    const run = await runTurn(makeSession(), [
      initMsg(),
      taskSettledMsg('task-1'),
      resultMsg(),
      { probe: 'deadline-armed', advanceMs: DEFERRED_CLOSE_TIMEOUT_MS / 2 },
      initMsg(), // the delivery segment
      // Far past the deadline that was armed: the segment starting released it,
      // so a slow segment is never cut short.
      { probe: 'delivery-segment', advanceMs: DEFERRED_CLOSE_TIMEOUT_MS * 3 },
      sentinelMsg('toolu_in_delivery_segment'),
      resultMsg(),
      { probe: 'turn-over' },
    ]);

    expect(run.probes).toEqual([
      { label: 'deadline-armed', stdinClosed: false },
      { label: 'delivery-segment', stdinClosed: false },
      { label: 'turn-over', stdinClosed: true },
    ]);
    expect(run.steered).toEqual([true]);
    expect(vi.mocked(logger.warn).mock.calls.map((c) => c[0])).not.toContain(
      '[sendMessage] deferred close expired; releasing input stream'
    );
  });

  // The model speaking is the other proof a segment is running — a `result` is
  // coming, so the deadline has done its job and must not close under it.
  it('drops the deadline when the model speaks, without draining what is owed', async () => {
    const run = await runTurn(makeSession(), [
      initMsg(),
      taskSettledMsg('task-1'),
      resultMsg(),
      assistantMsg(),
      { probe: 'model-talking', advanceMs: DEFERRED_CLOSE_TIMEOUT_MS * 3 },
      resultMsg(), // still owed, nothing live: re-armed here
      { probe: 're-armed', advanceMs: DEFERRED_CLOSE_TIMEOUT_MS + 1_000 },
    ]);

    expect(run.probes).toEqual([
      { label: 'model-talking', stdinClosed: false },
      { label: 're-armed', stdinClosed: true },
    ]);
  });

  // The deadline still does its job on the path it was written for: a settle
  // whose segment never opens, with no further `result` to re-decide.
  it('still expires an owed-only hold when no segment ever opens', async () => {
    const run = await runTurn(makeSession(), [
      initMsg(),
      taskSettledMsg('task-that-never-delivers'),
      resultMsg(),
      { probe: 'expired', advanceMs: DEFERRED_CLOSE_TIMEOUT_MS + 1_000 },
    ]);

    expect(run.probes).toEqual([{ label: 'expired', stdinClosed: true }]);
    expect(vi.mocked(logger.warn).mock.calls.map((c) => c[0])).toContain(
      '[sendMessage] deferred close expired; releasing input stream'
    );
  });

  // The turn moves underneath an armed deadline: the segment it waited for
  // starts and the model launches ANOTHER helper inside it. Closing on the
  // timer alone would then EOF stdin under a live agent — the property this
  // whole change exists to hold.
  it('refuses to close on expiry when a background agent has since gone live', async () => {
    const run = await runTurn(makeSession(), [
      initMsg(),
      taskSettledMsg('task-1'),
      resultMsg(), // owed, nothing live -> deadline armed
      tasksChanged([{ id: 'agent-late', type: 'local_agent' }]),
      { probe: 'expiry-with-agent-live', advanceMs: DEFERRED_CLOSE_TIMEOUT_MS + 1_000 },
      // A SECOND window with the agent still live: the re-arm keeps asking, and
      // keeps getting the same answer, rather than closing.
      { probe: 'second-window-agent-still-live', advanceMs: DEFERRED_CLOSE_TIMEOUT_MS + 1_000 },
      tasksChanged([]),
      initMsg(),
      resultMsg(),
      { probe: 'turn-over' },
    ]);

    expect(run.probes).toEqual([
      { label: 'expiry-with-agent-live', stdinClosed: false },
      { label: 'second-window-agent-still-live', stdinClosed: false },
      { label: 'turn-over', stdinClosed: true },
    ]);
    // Once per window — the re-arm is a bounded ask, not a spin.
    expect(stillHoldingLogs()).toHaveLength(2);
  });

  // The other half of the re-arm: once the agent goes, the very next window
  // closes stdin. Without it there would be no timer left to fire, and a CLI
  // that drops the agent from the level set without a notification and then
  // says nothing more would hold until the ten-minute stall guard.
  it('closes on the NEXT window once the agent that deferred it has gone', async () => {
    const run = await runTurn(makeSession(), [
      initMsg(),
      taskSettledMsg('task-1'),
      resultMsg(), // deadline armed
      tasksChanged([{ id: 'agent-late', type: 'local_agent' }]),
      { probe: 'expiry-with-agent-live', advanceMs: DEFERRED_CLOSE_TIMEOUT_MS + 1_000 },
      // The agent leaves without a notification and the CLI goes quiet: no
      // `result` will re-decide this, so only the re-armed deadline can.
      tasksChanged([]),
      { probe: 'next-window-agent-gone', advanceMs: DEFERRED_CLOSE_TIMEOUT_MS + 1_000 },
    ]);

    expect(run.probes).toEqual([
      { label: 'expiry-with-agent-live', stdinClosed: false },
      { label: 'next-window-agent-gone', stdinClosed: true },
    ]);
    expect(stillHoldingLogs()).toHaveLength(1);
    expect(vi.mocked(logger.warn).mock.calls.map((c) => c[0])).toContain(
      '[sendMessage] deferred close expired; releasing input stream'
    );
  });

  // T3. Background SHELLS are out of scope. The CLI kills them shortly after
  // stdin ends and always has; holding for one would change behaviour nobody
  // asked to change.
  it('closes stdin at a result when only a background shell is live', async () => {
    const run = await runTurn(makeSession(), [
      initMsg(),
      tasksChanged([{ id: 'shell-1', type: 'local_bash' }]),
      resultMsg(),
      { probe: 'turn-over' },
    ]);

    expect(run.probes).toEqual([{ label: 'turn-over', stdinClosed: true }]);
  });

  // T4. The production shape: the main thread launches an async Agent and ends
  // its segment before the agent settles. The background-task frames and both
  // `system/init`s come straight off the wire; the two `result`s are supplied
  // here because the capture does not carry them (see the fixture module), and
  // the sentinel is synthetic because that turn produced no phantom.
  it('survives the production shape, replayed from the captured stream', async () => {
    const frames = readDeliverySegmentFrames();
    const run = await runTurn(makeSession(), [
      ...frames.slice(0, 4), // init, the level frame, both task_started frames
      resultMsg(), // RESULT #1: the main segment ends, the agent still running
      { probe: 'agent-still-running', advanceMs: DEFERRED_CLOSE_TIMEOUT_MS * 2 },
      ...frames.slice(4, 8), // the shell settles, the level empties, the agent settles
      frames[8]!, // the SECOND init: the delivery segment opens
      frames[9]!, // and its first assistant frame
      sentinelMsg('toolu_write_in_delivery_segment'),
      resultMsg(), // RESULT #2
      { probe: 'turn-over' },
    ]);

    expect(run.probes).toEqual([
      { label: 'agent-still-running', stdinClosed: false },
      { label: 'turn-over', stdinClosed: true },
    ]);
    expect(run.steered).toEqual([true]);
    // The clean path: the turn ended at its own `result`, never on a timer.
    expect(vi.mocked(logger.warn).mock.calls.map((c) => c[0])).not.toContain(
      '[sendMessage] deferred close expired; releasing input stream'
    );
  });
});
