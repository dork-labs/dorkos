/**
 * Trigger-only message POST: migration safety / single delivery path (ADR-0264).
 *
 * The POST no longer streams tokens — it triggers a detached turn whose events
 * flow ONLY through the per-session projector to `GET /:id/events`. These tests
 * pin the contract: a fast 202 with the canonical id, the turn observed exactly
 * once on the durable stream (and never on the POST body), the lock held for the
 * turn's real duration and released on completion AND error, error surfacing on
 * `/events`, and no phantom `streaming` after a restart/eviction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { SessionEvent, SessionSnapshot } from '@dorkos/shared/session-stream';
import { FakeAgentRuntime } from '@dorkos/test-utils';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    getSessionSettings: vi.fn(async () => null),
    has: vi.fn(() => true),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {
    constructor(
      public readonly runtime: string,
      public readonly sessionId: string
    ) {
      super(`Session '${sessionId}' is owned by runtime '${runtime}', which is not registered.`);
      this.name = 'RuntimeNotRegisteredError';
    }
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn(async () => null) }));

import request from 'supertest';
import { createApp, finalizeApp } from '../../app.js';
import {
  getOrCreateProjector,
  peekProjector,
  disposeProjector,
} from '../../services/session/session-state-projector.js';
import { collectTriggeredTurn, openEventStream } from './helpers/trigger-turn-helpers.js';

const app = createApp();
finalizeApp(app);

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
/** The canonical id the adapter assigns to a brand-new session mid-turn. */
const CANONICAL_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
  fakeRuntime.acquireLock.mockReturnValue(true);
  fakeRuntime.isLocked.mockReturnValue(false);
  fakeRuntime.getLockInfo.mockReturnValue(null);
  fakeRuntime.hasSession.mockReturnValue(true);
  fakeRuntime.getInternalSessionId.mockReturnValue(SESSION_ID);
  fakeRuntime.getSessionSnapshot.mockImplementation((_ctx, sessionId) =>
    getOrCreateProjector(sessionId).buildSnapshot(async () => [])
  );
  fakeRuntime.subscribeSession = vi.fn((_ctx, sessionId, sinceCursor, signal) =>
    getOrCreateProjector(sessionId).subscribe(sinceCursor, signal)
  );
});

afterEach(() => {
  disposeProjector(SESSION_ID);
  disposeProjector(CANONICAL_ID);
});

describe('POST /api/sessions/:id/messages — trigger-only contract', () => {
  it('returns 202 with the canonical session id, quickly, and no turn frames in the body', async () => {
    // Migration safety: the POST is a fast trigger that returns JSON (not SSE);
    // the body carries the canonical id and NONE of the turn's events.
    fakeRuntime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'Hi' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const started = Date.now();
    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'Hello' });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ sessionId: SESSION_ID });
    expect(res.type).toBe('application/json');
    // No StreamEvent leaked onto the POST response.
    expect(res.text).not.toContain('text_delta');
    expect(res.text).not.toContain('turn_start');
    // Fast: resolves on the first event, far under the canonical-id timeout.
    expect(elapsed).toBeLessThan(2000);
  });

  it('returns the canonical (remapped) id for a brand-new session', async () => {
    // DOR-74: a new session is assigned its real id during the turn; the 202
    // returns it so the client can re-key its URL and /events subscription.
    fakeRuntime.getInternalSessionId.mockReturnValue(CANONICAL_ID);
    fakeRuntime.withScenarios([
      async function* () {
        yield { type: 'session_status', data: { model: 'm' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'Hello' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ sessionId: CANONICAL_ID });
  });

  it('delivers the triggered turn EXACTLY ONCE on GET /:id/events', async () => {
    // Core single-delivery guarantee: turn_start … turn_end appear once on the
    // durable stream, with no duplication.
    fakeRuntime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'A' } } as StreamEvent;
        yield { type: 'text_delta', data: { text: 'B' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const live = await collectTriggeredTurn(app, SESSION_ID, 'Hello');
    const types = live.map((f) => (f.data as SessionEvent).type);

    expect(types.filter((t) => t === 'turn_start')).toHaveLength(1);
    expect(types.filter((t) => t === 'turn_end')).toHaveLength(1);
    expect(types.filter((t) => t === 'text_delta')).toHaveLength(2);
    // Monotonic, gap-free seq across the single delivery.
    const seqs = live.map((f) => (f.data as SessionEvent).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('holds the lock for the turn and releases it on completion (not on the 202)', async () => {
    // Lock lifetime: acquireLock is called once; releaseLock fires only after
    // the detached turn finishes, not when the 202 is sent.
    let releasedDuringTurn = false;
    fakeRuntime.releaseLock.mockImplementation(() => {});
    fakeRuntime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'x' } } as StreamEvent;
        // Snapshot the release state mid-turn: it must NOT have fired yet.
        releasedDuringTurn = fakeRuntime.releaseLock.mock.calls.length > 0;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    await collectTriggeredTurn(app, SESSION_ID, 'Hello');

    expect(fakeRuntime.acquireLock).toHaveBeenCalledTimes(1);
    expect(releasedDuringTurn).toBe(false);
    // Released after the turn completed. The third arg is the per-turn lock
    // token (I1) — release is token-matched so a superseded same-client turn
    // cannot drop a newer lock.
    await vi.waitFor(() => expect(fakeRuntime.releaseLock).toHaveBeenCalledTimes(1));
    expect(fakeRuntime.releaseLock).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(String),
      expect.any(Symbol)
    );
  });

  it('releases the lock AND surfaces an error lifecycle when the turn throws', async () => {
    // Detached error surfacing: a sendMessage rejection after the 202 must
    // appear on /events (error lifecycle + error turn_end) and free the lock —
    // the client can no longer learn of it from the POST.
    fakeRuntime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'partial' } } as StreamEvent;
        throw new Error('SDK exploded');
      },
    ]);

    const live = await collectTriggeredTurn(app, SESSION_ID, 'Hello');
    const events = live.map((f) => f.data as SessionEvent);

    const errorStatus = events.find(
      (e) => e.type === 'status_change' && e.status.lifecycle === 'error'
    );
    expect(errorStatus).toBeDefined();
    const turnEnd = events.find((e) => e.type === 'turn_end');
    expect(turnEnd).toMatchObject({ type: 'turn_end', terminalReason: 'error' });

    await vi.waitFor(() => expect(fakeRuntime.releaseLock).toHaveBeenCalledTimes(1));
  });

  it('marks an evicted in-flight turn interrupted (no phantom streaming after restart)', async () => {
    // Restart/eviction degradation (ADR-0262/0264): an abandoned streaming turn
    // is finalized `interrupted` so a later cold snapshot does not show a frozen
    // "Thinking…". Simulated by leaving the projector mid-turn, then evicting.
    const projector = getOrCreateProjector(SESSION_ID);
    projector.ingest({ type: 'turn_start' });
    projector.ingest({ type: 'text_delta', text: 'partial' });
    expect(projector.getStatus().lifecycle).toBe('streaming');

    // The eviction path (checkSessionHealth → peekProjector.markInterrupted →
    // disposeProjector) finalizes the abandoned turn.
    peekProjector(SESSION_ID)?.markInterrupted();
    expect(projector.getStatus().lifecycle).toBe('interrupted');

    const snap = (await projector.buildSnapshot(async () => [])) as SessionSnapshot;
    expect(snap.inProgressTurn).toBeNull();
    expect(snap.status.lifecycle).toBe('interrupted');
  });

  it('does not start a turn when the session is locked by another client', async () => {
    // Lock contention: a 409 short-circuits before sendMessage.
    fakeRuntime.acquireLock.mockReturnValue(false);
    fakeRuntime.isLocked.mockReturnValue(true);
    fakeRuntime.getLockInfo.mockReturnValue({ clientId: 'other', acquiredAt: Date.now() });

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'Hello' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SESSION_LOCKED');
    expect(fakeRuntime.sendMessage).not.toHaveBeenCalled();
    expect(fakeRuntime.releaseLock).not.toHaveBeenCalled();
  });

  it('rejects an empty message with 400 and never acquires the lock', async () => {
    const res = await request(app).post(`/api/sessions/${SESSION_ID}/messages`).send({});
    expect(res.status).toBe(400);
    expect(fakeRuntime.acquireLock).not.toHaveBeenCalled();
  });

  it('rekeys the projector so the turn is visible under the canonical id (C1)', async () => {
    // C1: a brand-new session feeds its turn under the request UUID, but the 202
    // returns the canonical id and the client re-keys its /events subscription to
    // it. Without the rekey, GET /events under the canonical id would hit a FRESH
    // EMPTY projector and the turn would be invisible. Here the fake remaps to a
    // canonical id; after POST, a cold /events connect under the CANONICAL id must
    // see the completed turn (idle snapshot), proving the projector was rekeyed.
    fakeRuntime.getInternalSessionId.mockReturnValue(CANONICAL_ID);
    fakeRuntime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'new session reply' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const post = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'Hello' });
    expect(post.status).toBe(202);
    expect(post.body).toEqual({ sessionId: CANONICAL_ID });

    // The turn finished; the rekeyed projector lives under the canonical id now.
    await vi.waitFor(() => expect(peekProjector(CANONICAL_ID)?.getStatus().lifecycle).toBe('idle'));
    // And the OLD UUID no longer resolves to a live projector (it was moved).
    expect(peekProjector(SESSION_ID)).toBeUndefined();

    // A cold /events connect under the CANONICAL id surfaces the turn — its
    // cursor is non-zero, so the snapshot reflects the real (rekeyed) state.
    const { frames } = await openEventStream(app, CANONICAL_ID, { maxMs: 500 });
    const snapshot = frames.find((f) => f.event === 'snapshot')?.data as SessionSnapshot;
    expect(snapshot).toBeDefined();
    expect(snapshot.cursor).toBeGreaterThan(0);
    expect(snapshot.status.lifecycle).toBe('idle');
  });

  it('rekeys even when the canonical id resolves only AFTER the first event (F2 race)', async () => {
    // Acceptance run 20260610-173202, F2: live, the adapter's reverse-index
    // remap (SDK init) had NOT run by the first yielded event, so a one-shot
    // canonical-id read at first-event time missed and the projector stayed
    // keyed by the request UUID for the whole first turn — the sidebar's
    // canonical-id view hit a fresh empty projector while the session was
    // actually blocked on an approval. The rekey must retry per event and
    // converge whenever the id becomes known.
    let idKnown = false;
    fakeRuntime.getInternalSessionId.mockImplementation(() => (idKnown ? CANONICAL_ID : undefined));
    fakeRuntime.withScenarios([
      async function* () {
        // First event: the id is NOT yet resolvable (the live race).
        yield { type: 'text_delta', data: { text: 'first' } } as StreamEvent;
        // The init lands mid-turn; later events must pick the id up.
        idKnown = true;
        yield { type: 'text_delta', data: { text: 'second' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const post = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'Hello' });
    expect(post.status).toBe(202);
    // The 202 raced the init and carries the request id — that is best-effort
    // by design; registry correctness must not depend on it.
    expect(post.body).toEqual({ sessionId: SESSION_ID });

    // The per-event retry still moved the projector to the canonical id.
    await vi.waitFor(() => expect(peekProjector(CANONICAL_ID)?.getStatus().lifecycle).toBe('idle'));
    expect(peekProjector(SESSION_ID)).toBeUndefined();
  });

  it('rekeys when the adapter seeds an IDENTITY mapping before the real id (F2 regression)', async () => {
    // Acceptance run 20260611-145454: the Claude adapter's ensureSession SEEDS
    // `sdkSessionId === sessionId` at creation, so getInternalSessionId returns
    // a truthy IDENTITY mapping from the very first event — the real canonical
    // id only lands when the SDK init message is processed mid-turn. A retry
    // that disarms on ANY truthy resolution latches the identity and never
    // rekeys, recreating the F2 split-brain. Identity must keep the retry armed.
    let initLanded = false;
    fakeRuntime.getInternalSessionId.mockImplementation(() =>
      initLanded ? CANONICAL_ID : SESSION_ID
    );
    fakeRuntime.withScenarios([
      async function* () {
        // First event: the store resolves to the identity seed.
        yield { type: 'text_delta', data: { text: 'first' } } as StreamEvent;
        // The init lands mid-turn and assigns the real canonical id.
        initLanded = true;
        yield { type: 'text_delta', data: { text: 'second' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const post = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'Hello' });
    expect(post.status).toBe(202);

    // The per-event retry must NOT have disarmed on the identity resolution.
    await vi.waitFor(() => expect(peekProjector(CANONICAL_ID)?.getStatus().lifecycle).toBe('idle'));
    expect(peekProjector(SESSION_ID)).toBeUndefined();
  });

  it('a cold /events connect AFTER the turn finishes hydrates from the snapshot', async () => {
    // Ordering note (for #9): a consumer that attaches after the turn ends sees
    // the completed state in the snapshot, not as live frames — which is why the
    // client subscribes BEFORE/at POST. Here we drive POST-then-connect and
    // assert the snapshot reflects the finished (idle) turn.
    fakeRuntime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'done already' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const post = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'Hello' });
    expect(post.status).toBe(202);

    // Let the detached turn finish, then cold-connect.
    await vi.waitFor(() => expect(peekProjector(SESSION_ID)?.getStatus().lifecycle).toBe('idle'));
    const { frames } = await openEventStream(app, SESSION_ID, { maxMs: 500 });
    const snapshot = frames.find((f) => f.event === 'snapshot')?.data as SessionSnapshot;
    expect(snapshot.inProgressTurn).toBeNull();
    expect(snapshot.status.lifecycle).toBe('idle');
  });
});
