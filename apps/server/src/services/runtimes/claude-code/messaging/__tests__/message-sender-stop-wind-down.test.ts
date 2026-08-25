/**
 * What a Stop pressed during a turn's WIND-DOWN actually settles as (DOR-1244).
 *
 * The shape, end to end and through the production pieces: the send loop takes a
 * `result` for the end of the turn and closes the CLI's stdin; the CLI keeps
 * going past that EOF and speaks again, which reopens the turn window (DOR-1100)
 * and puts a Stop button back on screen; the person presses it. The graceful
 * `interrupt()` can no longer be delivered, so the stop escalates to
 * `query.close()`.
 *
 * The question this file answers is what the person then SEES, which the unit
 * tests around `SessionStore` cannot say: the real `mapSdkMessage` and the real
 * `feedProjector` run here, and the assertions read the durable stream. The
 * promise is that the settle is honest — the reopened turn ends, and it ends as
 * a turn that stopped rather than as a red failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import { SessionStore } from '../../sessions/session-store.js';
import { feedProjector } from '../../../../session/session-event-normalizer.js';
import { SessionStateProjector } from '../../../../session/session-state-projector.js';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { StreamEvent } from '@dorkos/shared/types';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  forkSession: vi.fn(),
}));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi
    .fn()
    .mockResolvedValue({ text: '<env>mock</env>', stable: '<env>mock</env>' }),
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
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));
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

const SESSION_ID = 'wind-down-session';

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

function textDeltaMsg(text: string): SDKMessage {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  } as unknown as SDKMessage;
}

/**
 * A successful `result`, carrying the `terminal_reason` a real one does — the
 * field the result mapper turns into the turn's `terminalReason`, and the whole
 * reason a turn that ended by itself can be told apart from one that was
 * stopped.
 */
function resultMsg(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    uuid: 'result-uuid',
    session_id: 'sdk-1',
    is_error: false,
    total_cost_usd: 0.01,
    terminal_reason: 'completed',
  } as unknown as SDKMessage;
}

/**
 * The `result` a CLI emits after it ACKS an interrupt: no content, and its own
 * `terminal_reason` naming the abort. The SDK's `TerminalReason` union, and one
 * of the values the projector already reads as an interrupted turn.
 */
function abortedResultMsg(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    uuid: 'result-aborted',
    session_id: 'sdk-1',
    is_error: false,
    total_cost_usd: 0.01,
    terminal_reason: 'aborted_streaming',
  } as unknown as SDKMessage;
}

/** A step in the scripted stream: an SDK message, or something the test does. */
type Step = SDKMessage | (() => Promise<void>);

/** How the fake CLI behaves around the stop it is about to be sent. */
interface CliBehaviour {
  /**
   * What `interrupt()` does. `never-settles` is the wind-down shape (the SDK
   * drops the write to an ended stdin and waits on an ack nobody will send);
   * `rejects` reaches the same `close()` escalation without spending the real
   * three-second bound, which is what the starting-phase case needs; `acks` is
   * the healthy CLI, which answers and then ends the turn itself.
   */
  interrupt?: 'never-settles' | 'rejects' | 'acks';
  /** The process exits by itself at the end of the script rather than waiting to be closed. */
  endsOnItsOwn?: boolean;
}

/**
 * A fake CLI that behaves like the real one in the ways that matter here: it
 * outlives its own `result` (so DorkOS ending stdin does not end it), its
 * `interrupt()` cannot be answered, and its message stream finishes on `close()`
 * CLEANLY, with no error — exactly as the SDK's `performCleanup` does
 * (`inputStream.done()`; observed live against CLI 2.1.224 on 2026-08-17).
 */
function fakeWindDownCli(steps: Step[], behaviour: CliBehaviour = {}) {
  let closed = false;
  let releaseClose!: () => void;
  const closeSignal = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const calls = { interrupt: 0, close: 0 };
  return {
    calls,
    handle: {
      interrupt: (): Promise<unknown> => {
        calls.interrupt++;
        if (behaviour.interrupt === 'rejects') {
          return Promise.reject(new Error('interrupt refused'));
        }
        if (behaviour.interrupt === 'acks') return Promise.resolve(undefined);
        return new Promise<never>(() => {});
      },
      close: () => {
        calls.close++;
        closed = true;
        releaseClose();
      },
      [Symbol.asyncIterator]: async function* () {
        for (const step of steps) {
          if (typeof step === 'function') {
            await step();
            continue;
          }
          if (closed) return;
          yield step;
        }
        if (!behaviour.endsOnItsOwn) await closeSignal;
      },
    } as unknown as ReturnType<typeof query>,
  };
}

/** One window on the durable stream, `turn_start` through `turn_end`. */
interface ProjectedWindow {
  /** `turn_start.origin` — absent for a window a person asked for, `'runtime'` for a reopen. */
  origin?: string;
  /** Every event type in the window, in order. */
  types: string[];
  events: SessionEvent[];
}

/** Cut the durable stream into windows at its `turn_start`/`turn_end` pairs. */
function windows(events: SessionEvent[]): ProjectedWindow[] {
  const out: ProjectedWindow[] = [];
  let open: ProjectedWindow | undefined;
  for (const event of events) {
    if (event.type === 'turn_start') {
      open = { origin: (event as { origin?: string }).origin, types: [], events: [] };
      out.push(open);
    }
    open?.types.push(event.type);
    open?.events.push(event);
    if (event.type === 'turn_end') open = undefined;
  }
  return out;
}

/** The `terminalReason` a window's `turn_end` settled with, if it carried one. */
function endReason(window: ProjectedWindow): string | undefined {
  const end = window.events.find((e) => e.type === 'turn_end');
  return (end as { terminalReason?: string } | undefined)?.terminalReason;
}

interface TurnRun {
  /** Every StreamEvent the send loop yielded. */
  yielded: StreamEvent[];
  /** The durable stream, cut into windows. */
  windows: ProjectedWindow[];
  /** The lifecycle the session settled at — what a cold hydrate would show. */
  lifecycle: string;
  cli: ReturnType<typeof fakeWindDownCli>;
}

/**
 * Drive one turn through the production pieces: the real send loop, the real
 * `mapSdkMessage`, and the real `feedProjector` over a real projector.
 *
 * `store` is handed to the caller's steps so a step can press Stop mid-stream.
 */
async function runTurn(
  build: (store: SessionStore) => Step[],
  behaviour: CliBehaviour = {}
): Promise<TurnRun> {
  const store = new SessionStore();
  store.ensureSession(SESSION_ID, { permissionMode: 'default' });
  const session = store.findSession(SESSION_ID)!;

  const cli = fakeWindDownCli(build(store), behaviour);
  vi.mocked(query).mockReturnValue(cli.handle);

  const opts: MessageSenderOpts = { cwd: '/mock/project', onSdkSessionRebind: async () => {} };
  const yielded: StreamEvent[] = [];
  const projector = new SessionStateProjector(SESSION_ID);
  async function* stream(): AsyncIterable<StreamEvent> {
    for await (const event of executeSdkQuery(SESSION_ID, 'hello', session, opts)) {
      yielded.push(event);
      yield event;
    }
  }
  await feedProjector(projector, stream(), { userMessage: 'hello' });

  return {
    yielded,
    windows: windows(projector.replayFrom(0)),
    lifecycle: projector.getStatus().lifecycle,
    cli,
  };
}

describe('a Stop pressed while the turn is winding down (DOR-1244)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ends the reopened turn, and settles it as interrupted rather than as finished', async () => {
    let stopOutcome: boolean | undefined;
    const run = await runTurn((store) => [
      initMsg(),
      textDeltaMsg('working on it'),
      // The `result` DorkOS takes for the end of the turn: it closes the CLI's
      // stdin here, which is what makes everything below undeliverable.
      resultMsg(),
      // The CLI keeps going past that EOF and speaks again. This reopens the
      // turn window (DOR-1100) — the Stop button is back on screen.
      textDeltaMsg('actually, one more thing'),
      // The person presses it.
      async () => {
        stopOutcome = await store.interruptQuery(SESSION_ID);
      },
    ]);

    // The Stop was answered — it did not hang waiting for an ack that could not
    // come, and it took the only route left.
    expect(stopOutcome).toBe(true);
    expect(run.cli.calls.close).toBe(1);

    // Two windows: the turn, and the continuation the CLI woke itself for.
    expect(run.windows).toHaveLength(2);
    expect(run.windows[1]!.origin).toBe('runtime');
    // The first window closed on the CLI's own `result`, and keeps saying so —
    // a Stop landing later must not rewrite a turn that already finished.
    expect(endReason(run.windows[0]!)).toBe('completed');
    // The reopened window SETTLES, and settles as a turn somebody stopped.
    // Before this it closed with no reason at all, which the projector reads as
    // idle — the same thing it says about a reply that finished by itself, so
    // the sidebar told the operator their agent was fine.
    expect(endReason(run.windows[1]!)).toBe('interrupted');
    expect(run.lifecycle).toBe('interrupted');
    // Stopped, not failed: no red anywhere on either stream.
    expect(run.windows.flatMap((w) => w.events).some((e) => e.type === 'error')).toBe(false);
    expect(run.yielded.some((e) => e.type === 'error')).toBe(false);
    // The terminal the sender synthesizes carries a reason and NOTHING else: with
    // no status fields on it, `toStatusChange` returns null, so it never reaches
    // the durable stream as an event of its own. The reopened window is exactly
    // the content plus its terminal — no second `status_change`, no phantom row.
    expect(run.windows[0]!.types).toEqual([
      'turn_start',
      'text_delta',
      'status_change',
      'turn_end',
    ]);
    expect(run.windows[1]!.types).toEqual(['turn_start', 'text_delta', 'turn_end']);
  });

  it('leaves a reopened turn nobody stopped settled as it always was', async () => {
    // The other half of the gate. Identical to the case above MINUS the Stop:
    // the CLI reopens the window (DOR-1100), says one more thing, and exits on
    // its own without a second `result`. Nothing was interrupted, so nothing may
    // claim it was — this window settles with no reason, exactly as before.
    const run = await runTurn(
      () => [initMsg(), textDeltaMsg('working on it'), resultMsg(), textDeltaMsg('one more thing')],
      { endsOnItsOwn: true }
    );

    expect(run.cli.calls.close).toBe(0);
    expect(run.windows).toHaveLength(2);
    expect(run.windows[1]!.origin).toBe('runtime');
    expect(endReason(run.windows[0]!)).toBe('completed');
    expect(endReason(run.windows[1]!)).toBeUndefined();
    expect(run.lifecycle).toBe('idle');
  });

  it('settles a Stop pressed before the agent has said anything as interrupted, with no failure card', async () => {
    // The STARTING phase: the escalation kills the process before the model has
    // spoken and before any `result`. That is a turn with zero content and no
    // terminal — which the empty-stream guard called a dead stream, reporting
    // "The agent did not respond" and settling `error`, so the operator saw the
    // crash notice "Claude Code stopped unexpectedly" for something they did on
    // purpose. A stopped turn with nothing in it is a turn somebody ended.
    let stopOutcome: boolean | undefined;
    const run = await runTurn(
      (store) => [
        initMsg(),
        async () => {
          stopOutcome = await store.interruptQuery(SESSION_ID);
        },
      ],
      { interrupt: 'rejects' }
    );

    expect(stopOutcome).toBe(true);
    expect(run.cli.calls.close).toBe(1);
    expect(run.windows).toHaveLength(1);
    expect(endReason(run.windows[0]!)).toBe('interrupted');
    expect(run.lifecycle).toBe('interrupted');
    // No red: neither the empty-stream error nor any other.
    expect(run.yielded.some((e) => e.type === 'error')).toBe(false);
    expect(run.windows[0]!.types).not.toContain('error');
  });

  it('keeps the CLI own abort reason when it acks a Stop it had nothing to show for', async () => {
    // The gracefully-ACKED zero-content Stop, which lands in the OTHER
    // empty-stream arm — the in-loop one, at the `done` the CLI's own `result`
    // maps to. Press Stop the moment a turn starts and the healthy CLI answers,
    // ends the turn itself, and reports `aborted_streaming`; the turn has no
    // content, so without the stop-aware guard it also collected "The agent did
    // not respond" and settled `error` instead.
    let stopOutcome: boolean | undefined;
    const run = await runTurn(
      (store) => [
        initMsg(),
        async () => {
          stopOutcome = await store.interruptQuery(SESSION_ID);
        },
        // The CLI honours it and closes the turn on its own terms.
        abortedResultMsg(),
      ],
      { interrupt: 'acks', endsOnItsOwn: true }
    );

    expect(stopOutcome).toBe(true);
    // Acked, so the process was never killed.
    expect(run.cli.calls.interrupt).toBe(1);
    expect(run.cli.calls.close).toBe(0);
    expect(run.windows).toHaveLength(1);
    // The CLI's own reason wins: the synthesis stays out because that `result`
    // closed the window, and the runtime's answer is better than ours.
    expect(endReason(run.windows[0]!)).toBe('aborted_streaming');
    expect(run.lifecycle).toBe('interrupted');
    // The zero-content turn earns no "the agent did not respond" — the operator
    // is who ended it. Asserted before the event list so a regression reads as
    // the error it is rather than as a shape mismatch.
    expect(run.yielded.some((e) => e.type === 'error')).toBe(false);
    expect(run.windows[0]!.types).toEqual(['turn_start', 'status_change', 'turn_end']);
  });

  it('leaves a turn that finished on its own settled as completed, even when a Stop races the end', async () => {
    // The non-flip. The CLI answered, its `result` closed the window, and only
    // THEN does the Stop arrive — the ordinary race between a reply ending and
    // the button being pressed. Nothing here was interrupted, and the transcript
    // must not claim it was.
    let stopOutcome: boolean | undefined;
    const run = await runTurn((store) => [
      initMsg(),
      textDeltaMsg('all done'),
      resultMsg(),
      async () => {
        stopOutcome = await store.interruptQuery(SESSION_ID);
      },
    ]);

    expect(stopOutcome).toBe(true);
    expect(run.windows).toHaveLength(1);
    expect(endReason(run.windows[0]!)).toBe('completed');
    expect(run.lifecycle).toBe('idle');
    // And nothing trails the terminal `done` that closed it.
    expect(run.yielded.at(-1)?.type).toBe('done');
  });
});
