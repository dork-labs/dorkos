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

/** A step in the scripted stream: an SDK message, or something the test does. */
type Step = SDKMessage | (() => Promise<void>);

/**
 * A fake CLI that behaves like the real one in the two ways that matter here:
 * its `interrupt()` never settles once its stdin has ended (the SDK drops the
 * write and waits on an ack nobody will send), and its message stream does not
 * finish until `close()` — which ends it CLEANLY, with no error, exactly as the
 * SDK's own `performCleanup` does (`inputStream.done()`; observed live against
 * CLI 2.1.224 on 2026-08-17).
 */
function fakeWindDownCli(steps: Step[]) {
  let closed = false;
  let releaseClose!: () => void;
  const closeSignal = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const calls = { interrupt: 0, close: 0 };
  return {
    calls,
    handle: {
      interrupt: () => {
        calls.interrupt++;
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
        await closeSignal;
      },
    } as unknown as ReturnType<typeof query>,
  };
}

/** Cut the durable stream into windows at its `turn_start`/`turn_end` pairs. */
function windows(events: SessionEvent[]): Array<{ origin?: string; events: SessionEvent[] }> {
  const out: Array<{ origin?: string; events: SessionEvent[] }> = [];
  let open: { origin?: string; events: SessionEvent[] } | undefined;
  for (const event of events) {
    if (event.type === 'turn_start') {
      open = { origin: (event as { origin?: string }).origin, events: [] };
      out.push(open);
    }
    open?.events.push(event);
    if (event.type === 'turn_end') open = undefined;
  }
  return out;
}

/** The `terminalReason` a window's `turn_end` settled with, if it carried one. */
function endReason(window: { events: SessionEvent[] }): string | undefined {
  const end = window.events.find((e) => e.type === 'turn_end');
  return (end as { terminalReason?: string } | undefined)?.terminalReason;
}

interface TurnRun {
  /** Every StreamEvent the send loop yielded. */
  yielded: StreamEvent[];
  /** The durable stream, cut into windows. */
  windows: Array<{ origin?: string; events: SessionEvent[] }>;
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
async function runTurn(build: (store: SessionStore) => Step[]): Promise<TurnRun> {
  const store = new SessionStore();
  store.ensureSession(SESSION_ID, { permissionMode: 'default' });
  const session = store.findSession(SESSION_ID)!;

  const cli = fakeWindDownCli(build(store));
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
