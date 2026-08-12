/**
 * The single most likely implementation error in the correlation spine, pinned.
 *
 * `POST /api/sessions/:id/messages` is trigger-only (ADR-0264): it starts a turn
 * that runs DETACHED and answers `202` without awaiting it. So a correlation
 * scope has to wrap the CONSTRUCTION of that detached chain — an async generator
 * created inside an `AsyncLocalStorage` scope keeps the scope for its whole life
 * — and not merely the `await` that resolves the 202, which expires the moment
 * the response is sent and would correlate nothing that mattered.
 *
 * The test therefore reads the ambient dispatch id from inside the runtime's own
 * generator, at a point that is provably AFTER the 202 has resolved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { isDispatchId } from '@dorkos/shared/dispatch-id';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
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
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
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
import { currentDispatch, currentDispatchId } from '../../lib/dispatch-context.js';
import {
  recentDispatches,
  resetDispatchBuffers,
} from '../../services/observability/dispatch-buffers.js';

const app = createApp();
finalizeApp(app);

const SESSION_ID = '00000000-0000-4000-8000-0000000000d1';
/** The canonical id the adapter assigns to a brand-new session mid-turn. */
const CANONICAL_ID = '11111111-1111-4111-8111-1111111111d1';

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
  fakeRuntime.acquireLock.mockReturnValue(true);
  fakeRuntime.isLocked.mockReturnValue(false);
  fakeRuntime.getLockInfo.mockReturnValue(null);
  fakeRuntime.hasSession.mockReturnValue(true);
  fakeRuntime.getInternalSessionId.mockReturnValue(SESSION_ID);
});

afterEach(() => {
  disposeProjector(SESSION_ID);
  disposeProjector(CANONICAL_ID);
});

describe('the dispatch id survives the detached turn', () => {
  it('is the same id before and long after the 202', async () => {
    // A gate the turn parks on, opened only once the 202 has been received —
    // so every read tagged `after202` is unambiguously past the response.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const reads: Array<{ at: string; id: string | undefined }> = [];
    let ended!: () => void;
    const finished = new Promise<void>((resolve) => {
      ended = resolve;
    });

    fakeRuntime.withScenarios([
      async function* () {
        reads.push({ at: 'first-yield', id: currentDispatchId() });
        yield { type: 'text_delta', data: { text: 'Hi' } } as StreamEvent;
        await gate;
        reads.push({ at: 'after202', id: currentDispatchId() });
        yield { type: 'text_delta', data: { text: ' there' } } as StreamEvent;
        reads.push({ at: 'after202-second', id: currentDispatchId() });
        yield { type: 'done', data: {} } as StreamEvent;
        ended();
      },
    ]);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'Hello' });
    expect(res.status).toBe(202);
    // Nothing outside the dispatch inherits it.
    expect(currentDispatch()).toBeUndefined();

    open();
    await finished;

    const first = reads.find((r) => r.at === 'first-yield')?.id;
    expect(first).toBeDefined();
    expect(isDispatchId(first as string)).toBe(true);
    // The claim of this phase: the id is still there after the response, and it
    // is the SAME id. A scope tied to the awaited race yields `undefined` here.
    expect(reads.find((r) => r.at === 'after202')?.id).toBe(first);
    expect(reads.find((r) => r.at === 'after202-second')?.id).toBe(first);
  });

  it('does not change when the runtime rekeys the session mid-turn', async () => {
    // The whole reason the correlation key is not `sessionId`: a brand-new
    // session is renamed mid-turn by the runtime. The dispatch id is stable
    // exactly where the session id is not.
    const reads: string[] = [];
    let ended!: () => void;
    const finished = new Promise<void>((resolve) => {
      ended = resolve;
    });
    fakeRuntime.getInternalSessionId.mockReturnValue(SESSION_ID);
    fakeRuntime.withScenarios([
      async function* () {
        reads.push(currentDispatchId() ?? 'none');
        yield { type: 'session_status', data: { model: 'm' } } as StreamEvent;
        // The adapter's reverse-index remap lands: from here the session has a
        // different id than the one the request used.
        fakeRuntime.getInternalSessionId.mockReturnValue(CANONICAL_ID);
        yield { type: 'text_delta', data: { text: 'x' } } as StreamEvent;
        reads.push(currentDispatchId() ?? 'none');
        yield { type: 'done', data: {} } as StreamEvent;
        ended();
      },
    ]);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'Hello' });
    await finished;

    expect(res.status).toBe(202);
    // Proof the rekey actually happened — otherwise the assertion below is
    // comparing an id across a rename that never occurred. The 202 body is NOT
    // that proof: it resolves on the first event, which is before the remap
    // here, so it legitimately carries the request id.
    expect(peekProjector(CANONICAL_ID)).toBeDefined();
    expect(peekProjector(SESSION_ID)).toBeUndefined();
    expect(reads).toHaveLength(2);
    expect(reads[0]).toBe(reads[1]);
    expect(isDispatchId(reads[0])).toBe(true);
  });

  it('keeps one dispatch open across the wait, and closes it with the turn it eventually runs', async () => {
    // A queued message replaced the 409 this case used to pin (DOR-1131), and it
    // is now the interesting one for correlation: acceptance and the turn are
    // minutes apart, so the id minted when the person pressed send has to be the
    // id the turn ends under. In between, the row is legitimately open — the
    // message has not gone anywhere, it is waiting.
    resetDispatchBuffers();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    fakeRuntime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
        await gate;
        yield { type: 'done', data: {} } as StreamEvent;
      },
      async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const running = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'client-a')
      .send({ content: 'the long turn' });
    expect(running.status).toBe(202);

    const queued = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'client-b')
      .send({ content: 'queued behind it' });
    expect(queued.status).toBe(202);

    // Newest first: the waiting message's own dispatch, still open.
    const [waiting] = recentDispatches(10);
    expect(waiting).toBeDefined();
    expect(isDispatchId(waiting.dispatchId)).toBe(true);
    expect(waiting.outcome).toBeNull();
    expect(waiting.endedAt).toBeNull();

    open();

    // It closes under its OWN id when its turn finally runs and settles.
    await vi.waitFor(() => {
      const row = recentDispatches(10).find((d) => d.dispatchId === waiting.dispatchId);
      expect(row?.outcome).toBe('answered');
      expect(row?.endedAt).not.toBeNull();
    });
  });

  it('runs a queued message under its own dispatch, not the one it waited behind', async () => {
    // The production failure (DOR-1159): three POSTs minted three ids, and every
    // line after the first turn logged under the FIRST one, because the pump
    // reaches a parked launch from the PREVIOUS turn's settle — and ALS follows
    // the call chain, not the closure the launch was written in. Turn boundaries
    // became unreadable in the log exactly when somebody needed them.
    resetDispatchBuffers();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const seen: Array<{ at: string; id: string | undefined }> = [];
    let ended!: () => void;
    const finished = new Promise<void>((resolve) => {
      ended = resolve;
    });

    fakeRuntime.withScenarios([
      async function* () {
        seen.push({ at: 'running', id: currentDispatchId() });
        yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
        await gate;
        yield { type: 'done', data: {} } as StreamEvent;
      },
      async function* () {
        seen.push({ at: 'queued', id: currentDispatchId() });
        yield { type: 'done', data: {} } as StreamEvent;
        ended();
      },
    ]);

    const running = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'client-a')
      .send({ content: 'the long turn' });
    expect(running.status).toBe(202);
    // Newest-first, and the route records the start before it triggers, so the
    // head of the ring is this request's own id.
    const runningDispatchId = recentDispatches(10)[0]?.dispatchId;

    const queued = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'client-a')
      .send({ content: 'queued behind it' });
    expect(queued.status).toBe(202);
    const queuedDispatchId = recentDispatches(10)[0]?.dispatchId;
    expect(isDispatchId(queuedDispatchId as string)).toBe(true);
    expect(queuedDispatchId).not.toBe(runningDispatchId);

    open();
    await finished;

    expect(seen.find((s) => s.at === 'running')?.id).toBe(runningDispatchId);
    // The claim: the waiting message's turn is its OWN dispatch, however the
    // pump got to it.
    expect(seen.find((s) => s.at === 'queued')?.id).toBe(queuedDispatchId);
  });

  it('gives two concurrent turns two different ids', async () => {
    // One id per dispatch, not one per process: two sessions triggered at once
    // must not share a filter.
    const otherSession = '22222222-2222-4222-8222-2222222222d1';
    const seen: string[] = [];
    fakeRuntime.withScenarios([
      async function* () {
        seen.push(currentDispatchId() ?? 'none');
        yield { type: 'done', data: {} } as StreamEvent;
      },
      async function* () {
        seen.push(currentDispatchId() ?? 'none');
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    fakeRuntime.getInternalSessionId.mockImplementation((sid: string) => sid);
    getOrCreateProjector(otherSession);

    await request(app).post(`/api/sessions/${SESSION_ID}/messages`).send({ content: 'a' });
    await request(app).post(`/api/sessions/${otherSession}/messages`).send({ content: 'b' });

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.every(isDispatchId)).toBe(true);
    disposeProjector(otherSession);
  });
});
