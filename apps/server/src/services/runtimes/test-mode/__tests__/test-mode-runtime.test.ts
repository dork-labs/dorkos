import { describe, it, expect, afterEach, vi } from 'vitest';
import type { SessionEvent, SessionListEvent } from '@dorkos/shared/session-stream';
import { StaleResumeCursorError } from '@dorkos/shared/session-stream';
import {
  disposeProjector,
  getOrCreateProjector,
} from '../../../session/session-state-projector.js';
import { triggerTurn } from '../../../session/trigger-turn.js';
import { scenarioStore } from '../scenario-store.js';
import { TEST_MODE_CAPABILITIES } from '../runtime-constants.js';
import { TestModeRuntime } from '../test-mode-runtime.js';

// Purpose: Decision 1 / runtime-agnosticism end-to-end (ADR-0263). The
// stateless test-mode adapter drives the FULL snapshot/subscribe/list contract
// with NO native transcript store: history is reconstructed from the
// DorkOS-owned EventLog, live events come from the projector's seq'd stream,
// and discovery needs no filesystem watch. If these pass, the contract has no
// baked-in JSONL/file assumptions.

const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const CTX = { cwd: '/projects/test', permissionMode: 'default' as const };

/**
 * Trigger a turn exactly the way `POST /:id/messages` does (trigger-only,
 * ADR-0264) and wait for the detached turn to settle.
 *
 * @param settledLifecycle - The lifecycle the projection settles into once the
 *   turn closes (`'error'` for the error scenario, `'idle'` otherwise).
 */
async function runTurn(
  runtime: TestModeRuntime,
  sessionId: string,
  content: string,
  settledLifecycle: 'idle' | 'error' = 'idle'
) {
  const projector = getOrCreateProjector(sessionId, CTX.cwd);
  const result = await triggerTurn({
    sessionId,
    clientId: 'test-client',
    content,
    cwd: CTX.cwd,
    projector,
    deps: {
      acquireLock: (sid, cid, res, token) => runtime.acquireLock(sid, cid, res, token),
      releaseLock: (sid, cid, token) => runtime.releaseLock(sid, cid, token),
      sendMessage: (sid, text, opts) => runtime.sendMessage(sid, text, opts),
      getInternalSessionId: (sid) => runtime.getInternalSessionId(sid),
      rekeyProjector: () => {},
      getCapabilities: () => runtime.getCapabilities(),
    },
  });
  expect(result.accepted).toBe(true);
  // The turn runs detached; settle = the projected lifecycle leaves streaming.
  await vi.waitFor(() => {
    expect(projector.getStatus().lifecycle).toBe(settledLifecycle);
  });
}

/** Collect the first `n` events from a (potentially infinite) live stream. */
async function take(iterable: AsyncIterable<SessionEvent>, n: number): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of iterable) {
    out.push(event);
    if (out.length >= n) break;
  }
  return out;
}

afterEach(() => {
  disposeProjector(SESSION_A);
  disposeProjector(SESSION_B);
});

describe('TestModeRuntime — stateless log-backed contract adapter', () => {
  it('getSessionSnapshot reconstructs full history from the EventLog (no native store)', async () => {
    const runtime = new TestModeRuntime();
    await runTurn(runtime, SESSION_A, 'Hello');

    const snap = await runtime.getSessionSnapshot(CTX, SESSION_A);

    expect(snap.messages).toEqual([
      { id: 'user-1', role: 'user', content: 'Hello' },
      { id: 'assistant-1', role: 'assistant', content: 'Echo: Hello' },
    ]);
    expect(snap.inProgressTurn).toBeNull();
    expect(snap.status.lifecycle).toBe('idle');
    expect(snap.status.model).toBe('claude-haiku-4-5');
    expect(snap.pendingInteractions).toEqual([]);
    expect(snap.cursor).toBeGreaterThan(0);
  });

  it('getMessageHistory returns the same EventLog reconstruction (and [] for an unknown id)', async () => {
    const runtime = new TestModeRuntime();
    await runTurn(runtime, SESSION_A, 'Hello');

    const history = await runtime.getMessageHistory('/projects/test', SESSION_A);
    const snap = await runtime.getSessionSnapshot(CTX, SESSION_A);
    expect(history).toEqual(snap.messages);

    // An id that never streamed has no history — and asking must not mint a
    // projector (peek, not get-or-create).
    expect(await runtime.getMessageHistory('/projects/test', SESSION_B)).toEqual([]);
  });

  it('subscribeSession replays the gap from the log, then continues live', async () => {
    const runtime = new TestModeRuntime();
    await runTurn(runtime, SESSION_A, 'first');

    // Resume from mid-turn-1: cursor 2 = after turn_start + status_change.
    const replayed = await take(runtime.subscribeSession(CTX, SESSION_A, 2), 2);
    expect(replayed.map((e) => e.type)).toEqual(['text_delta', 'turn_end']);
    expect(replayed[0]).toMatchObject({ seq: 3, text: 'Echo: first' });

    // The same subscription path continues into the NEXT turn live.
    const live = take(runtime.subscribeSession(CTX, SESSION_A, 4), 4);
    await runTurn(runtime, SESSION_A, 'second');
    expect((await live).map((e) => e.type)).toEqual([
      'turn_start',
      'status_change',
      'text_delta',
      'turn_end',
    ]);
  });

  it('subscribe-first hydration: a subscriber attached BEFORE the first turn receives it live', async () => {
    const runtime = new TestModeRuntime();
    const live = take(runtime.subscribeSession(CTX, SESSION_A, 0), 4);

    await runTurn(runtime, SESSION_A, 'Hello');

    const events = await live;
    expect(events.map((e) => e.type)).toEqual([
      'turn_start',
      'status_change',
      'text_delta',
      'turn_end',
    ]);
    expect(events[0]).toMatchObject({ type: 'turn_start', userMessage: 'Hello' });
  });

  it('throws StaleResumeCursorError eagerly for a cursor ahead of the seq space', async () => {
    const runtime = new TestModeRuntime();
    await runTurn(runtime, SESSION_A, 'Hello');

    expect(() => runtime.subscribeSession(CTX, SESSION_A, 999)).toThrow(StaleResumeCursorError);
  });

  it('subscribeSessionList emits the tracked inventory, then live upserts — no filesystem watch', async () => {
    const runtime = new TestModeRuntime();
    await runTurn(runtime, SESSION_A, 'Hello lake');

    const iterator = runtime.subscribeSessionList(CTX)[Symbol.asyncIterator]();

    // Inventory: the session tracked by its first triggered message.
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const inventory = first.value as Extract<SessionListEvent, { type: 'session_upserted' }>;
    expect(inventory.type).toBe('session_upserted');
    expect(inventory.session).toMatchObject({
      id: SESSION_A,
      title: 'Hello lake',
      lastMessagePreview: 'Hello lake',
      cwd: '/projects/test',
    });

    // Live: a NEW session's first message upserts while subscribed.
    const next = iterator.next();
    await runTurn(runtime, SESSION_B, 'Hello fruit');
    const liveEvent = (await next).value as Extract<SessionListEvent, { type: 'session_upserted' }>;
    expect(liveEvent.type).toBe('session_upserted');
    expect(liveEvent.session.id).toBe(SESSION_B);

    await iterator.return?.();
  });

  it('list iterator.return() resolves a PARKED next() instead of hanging (broadcaster stop path)', async () => {
    const runtime = new TestModeRuntime();
    const iterator = runtime.subscribeSessionList(CTX)[Symbol.asyncIterator]();

    const parked = iterator.next(); // nothing tracked — parks
    await iterator.return?.();

    await expect(parked).resolves.toEqual({ value: undefined, done: true });
    // And the registry listener is gone: a later message must not throw/leak.
    await runTurn(runtime, SESSION_A, 'after close');
  });

  it('listSessions/getSession serve the tracked set, scoped by cwd', async () => {
    const runtime = new TestModeRuntime();
    await runTurn(runtime, SESSION_A, 'Hello');

    expect(await runtime.getSession('/projects/test', SESSION_A)).toMatchObject({
      id: SESSION_A,
      title: 'Hello',
    });
    expect((await runtime.listSessions('/projects/test')).map((s) => s.id)).toEqual([SESSION_A]);
    expect(await runtime.listSessions('/projects/other')).toEqual([]);
    expect(await runtime.getSession('/projects/test', SESSION_B)).toBeNull();
  });

  it('resetTrackedSessions disposes projectors — a reused id gets a FRESH session, not resurrected history', async () => {
    // The projector is the runtime's ONLY persistence: a reset that cleared
    // metadata but left projectors would resurrect pre-reset history on the
    // next snapshot for a reused id (review finding, /api/test/reset).
    const runtime = new TestModeRuntime();
    await runTurn(runtime, SESSION_A, 'before reset');

    // A live list subscriber sees the teardown as session_removed.
    const iterator = runtime.subscribeSessionList(CTX)[Symbol.asyncIterator]();
    await iterator.next(); // drain the inventory upsert
    const removal = iterator.next();

    runtime.resetTrackedSessions();

    expect((await removal).value).toEqual({ type: 'session_removed', sessionId: SESSION_A });
    await iterator.return?.();

    expect(await runtime.getMessageHistory('/projects/test', SESSION_A)).toEqual([]);
    const snap = await runtime.getSessionSnapshot(CTX, SESSION_A);
    expect(snap.messages).toEqual([]);
    expect(snap.cursor).toBe(0);
    expect(await runtime.listSessions('/projects/test')).toEqual([]);
  });

  it('updateSession patches tracked metadata and is reflected in the next upsert', async () => {
    const runtime = new TestModeRuntime();
    await runTurn(runtime, SESSION_A, 'Hello');

    expect(runtime.updateSession(SESSION_A, { permissionMode: 'plan' })).toBe(true);
    expect((await runtime.getSession('/projects/test', SESSION_A))?.permissionMode).toBe('plan');
    expect(runtime.updateSession(SESSION_B, { permissionMode: 'plan' })).toBe(false);
  });
});

describe('TestModeRuntime — configurable type (secondary e2e instance)', () => {
  it('defaults to test-mode and shares the capabilities constant by reference', () => {
    const runtime = new TestModeRuntime();
    expect(runtime.type).toBe('test-mode');
    expect(runtime.getCapabilities()).toBe(TEST_MODE_CAPABILITIES);
  });

  it('stamps its type onto capabilities and tracked sessions', async () => {
    const runtime = new TestModeRuntime('test-mode-b');
    expect(runtime.type).toBe('test-mode-b');
    // Identity field follows the instance; everything else stays shared so the
    // two instances serve identical scenarios/permission modes.
    expect(runtime.getCapabilities()).toEqual({ ...TEST_MODE_CAPABILITIES, type: 'test-mode-b' });

    await runTurn(runtime, SESSION_A, 'Hello');
    // Session-list runtime marks read this field — it must name the OWNING
    // instance, not a hardcoded 'test-mode'.
    expect((await runtime.getSession('/projects/test', SESSION_A))?.runtime).toBe('test-mode-b');
  });
});

describe("scenario 'error' — turn-failure contract (spec additional-agent-runtimes 4.1)", () => {
  afterEach(() => {
    scenarioStore.reset();
  });

  it("closes the turn with turn_end{terminalReason:'error'} and settles lifecycle 'error'", async () => {
    scenarioStore.setDefault('error');
    const runtime = new TestModeRuntime();
    const live = take(runtime.subscribeSession(CTX, SESSION_A, 0), 4);

    await runTurn(runtime, SESSION_A, 'boom', 'error');

    // Durable stream: the terminalReason-only session_status is dropped by the
    // normalizer, but the typed error StreamEvent rides the stream (rendered
    // inline live, latched into lastError), followed by the closing turn_end
    // CARRYING the reason — the one turn-failure signal every runtime shares
    // (drives TurnFailedNotice).
    const events = await live;
    expect(events.map((e) => e.type)).toEqual(['turn_start', 'status_change', 'error', 'turn_end']);
    expect(events[2]).toMatchObject({
      type: 'error',
      message: 'Simulated error from TestModeRuntime',
      code: 'simulated_error',
      category: 'execution_error',
    });
    expect(events[3]).toMatchObject({ type: 'turn_end', terminalReason: 'error' });

    const snap = await runtime.getSessionSnapshot(CTX, SESSION_A);
    expect(snap.status.lifecycle).toBe('error');
    expect(snap.status.lastError).toMatchObject({
      message: 'Simulated error from TestModeRuntime',
      code: 'simulated_error',
    });
  });
});
