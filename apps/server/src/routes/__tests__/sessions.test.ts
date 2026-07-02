import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeAgentRuntime } from '@dorkos/test-utils';

// Mock boundary before importing app
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

// fakeRuntime is declared at module scope so both the vi.mock factory and the
// test body share the same instance. vi.hoisted() cannot reference the imported
// FakeAgentRuntime because hoisting runs before ESM imports resolve.
let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    listRuntimes: vi.fn(() => [fakeRuntime]),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    has: vi.fn(() => true),
    // Session-settings store (ADR-0260): default to "no persisted settings"
    // so the route overlay is a no-op unless a test opts in.
    getSessionSettings: vi.fn(async () => null),
    saveSessionSettings: vi.fn(async () => {}),
    getSessionSettingsMany: vi.fn(() => new Map()),
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
  configManager: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  },
}));

const mockReadManifest = vi.fn(async (_path: string) => null);
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: (path: string) => mockReadManifest(path),
}));

// Dynamically import after mocks are set up
import request from 'supertest';
import { createApp, finalizeApp } from '../../app.js';
import { validateBoundary, BoundaryError } from '../../lib/boundary.js';
import {
  runtimeRegistry,
  RuntimeNotRegisteredError,
} from '../../services/core/runtime-registry.js';

const app = createApp();
finalizeApp(app);

/** Valid UUID for session ID params (routes validate UUID format). */
const S1 = '00000000-0000-4000-8000-000000000001';

describe('Sessions Routes', () => {
  beforeEach(() => {
    fakeRuntime = new FakeAgentRuntime();
    vi.clearAllMocks();
    // Default: return empty sessions list
    fakeRuntime.listSessions.mockResolvedValue([]);
    fakeRuntime.getSession.mockResolvedValue(null);
    fakeRuntime.getSessionETag.mockResolvedValue(null);
    fakeRuntime.getSessionTasks.mockResolvedValue([]);
    // Default: allow lock acquisition
    fakeRuntime.acquireLock.mockReturnValue(true);
    fakeRuntime.getLockInfo.mockReturnValue(null);
    fakeRuntime.getInternalSessionId.mockReturnValue(undefined);
    // Reset registry spies — per-test `.mockReturnValue(...)` overrides leak
    // across cases otherwise (clearAllMocks only clears call history).
    vi.mocked(runtimeRegistry.resolveForSession).mockResolvedValue(fakeRuntime);
    vi.mocked(runtimeRegistry.getSessionRuntimeType).mockResolvedValue('fake');
    vi.mocked(runtimeRegistry.persistSessionRuntime).mockResolvedValue(undefined);
    vi.mocked(runtimeRegistry.has).mockReturnValue(true);
    vi.mocked(runtimeRegistry.getDefaultType).mockReturnValue('fake');
  });

  // ---- GET /api/sessions ----

  describe('GET /api/sessions', () => {
    it('returns an empty envelope when no sessions', async () => {
      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sessions: [] });
      expect(fakeRuntime.listSessions).toHaveBeenCalled();
    });

    it('returns sessions from the single registered runtime (aggregation of one is a no-op)', async () => {
      const sessions = [
        {
          id: S1,
          title: 'First question',
          createdAt: '2024-01-02',
          updatedAt: '2024-01-02',
          permissionMode: 'default' as const,
          runtime: 'fake',
        },
        {
          id: 's2',
          title: 'Second question',
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
          permissionMode: 'bypassPermissions' as const,
          runtime: 'fake',
        },
      ];
      fakeRuntime.listSessions.mockResolvedValue(sessions);

      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(200);
      // Envelope (ADR-0308): { sessions, warnings? } — no warnings when healthy.
      expect(res.body).toEqual({ sessions });
    });
  });

  // ---- GET /api/sessions/:id ----

  describe('GET /api/sessions/:id', () => {
    it('returns session when found', async () => {
      const session = {
        id: S1,
        title: 'My session',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        permissionMode: 'default' as const,
        runtime: 'fake',
      };
      fakeRuntime.getSession.mockResolvedValue(session);

      const res = await request(app).get(`/api/sessions/${S1}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(session);
    });

    it('fills a missing runtime tag from the resolved runtime type', async () => {
      // Adapters tag `runtime` (task 1.1); the route backstops sloppy ones so
      // the required field always reaches the wire.
      fakeRuntime.getSession.mockResolvedValue({
        id: S1,
        title: 'Untagged session',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        permissionMode: 'default' as const,
      });

      const res = await request(app).get(`/api/sessions/${S1}`);
      expect(res.status).toBe(200);
      expect(res.body.runtime).toBe('fake');
    });

    it('overlays persisted settings over transcript-derived values (ADR-0260: store wins)', async () => {
      // Transcript reports 'default' (e.g. session init), but the operator set bypass.
      fakeRuntime.getSession.mockResolvedValue({
        id: S1,
        title: 'My session',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        permissionMode: 'default' as const,
        model: 'transcript-model',
      });
      vi.mocked(runtimeRegistry.getSessionSettings).mockResolvedValue({
        permissionMode: 'bypassPermissions',
      });

      const res = await request(app).get(`/api/sessions/${S1}`);
      expect(res.status).toBe(200);
      expect(res.body.permissionMode).toBe('bypassPermissions'); // store wins
      expect(res.body.model).toBe('transcript-model'); // transcript kept where store has no value
    });

    it('returns 400 for invalid (non-UUID) session ID', async () => {
      const res = await request(app).get('/api/sessions/nonexistent');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SESSION_ID');
    });

    it('returns 404 for missing session', async () => {
      const missingId = '00000000-0000-4000-8000-ffffffffffff';
      const res = await request(app).get(`/api/sessions/${missingId}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Session not found');
    });
  });

  // ---- PATCH /api/sessions/:id ----

  describe('PATCH /api/sessions/:id', () => {
    it('returns 200 when permission mode update succeeds', async () => {
      fakeRuntime.updateSession.mockReturnValue(true);
      fakeRuntime.getSession.mockResolvedValue({
        id: S1,
        title: 'Test session',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        permissionMode: 'dontAsk',
      });

      const res = await request(app)
        .patch(`/api/sessions/${S1}`)
        .send({ permissionMode: 'dontAsk' });

      expect(res.status).toBe(200);
      expect(fakeRuntime.updateSession).toHaveBeenCalledWith(S1, {
        permissionMode: 'dontAsk',
        model: undefined,
        effort: undefined,
        fastMode: undefined,
      });
    });

    // ADR-0261: updateSession is contractually no-throw — a failed live mode
    // switch is persisted and applied next turn, never surfaced as a 422. The
    // best-effort behavior is unit-tested in session-store-update.test.ts.

    it('includes the resolved runtime in the fallback body when getSession returns null', async () => {
      // Session.runtime is required on the wire (task 1.1) — the loose
      // fallback for a just-updated-but-unreadable session must carry it too.
      fakeRuntime.updateSession.mockReturnValue(true);
      fakeRuntime.getSession.mockResolvedValue(null);

      const res = await request(app).patch(`/api/sessions/${S1}`).send({ permissionMode: 'plan' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: S1,
        permissionMode: 'plan',
        runtime: 'fake',
      });
    });

    it('returns 404 when session does not exist', async () => {
      fakeRuntime.updateSession.mockReturnValue(false);

      const res = await request(app).patch(`/api/sessions/${S1}`).send({ permissionMode: 'plan' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns 400 for invalid session ID', async () => {
      const res = await request(app)
        .patch('/api/sessions/not-a-uuid')
        .send({ permissionMode: 'plan' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SESSION_ID');
    });

    it('returns 400 for invalid request body', async () => {
      const res = await request(app)
        .patch(`/api/sessions/${S1}`)
        .send({ permissionMode: 'invalid_mode' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('translates session ID via getInternalSessionId', async () => {
      const internalId = '00000000-0000-4000-8000-internal00001';
      fakeRuntime.getInternalSessionId.mockReturnValue(internalId);
      fakeRuntime.updateSession.mockReturnValue(true);
      fakeRuntime.getSession.mockResolvedValue({
        id: internalId,
        title: 'Test session',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        permissionMode: 'plan',
      });

      await request(app).patch(`/api/sessions/${S1}`).send({ permissionMode: 'plan' });

      expect(fakeRuntime.updateSession).toHaveBeenCalledWith(
        internalId,
        expect.objectContaining({ permissionMode: 'plan' })
      );
    });

    it('updates model without affecting permission mode', async () => {
      fakeRuntime.updateSession.mockReturnValue(true);
      fakeRuntime.getSession.mockResolvedValue({
        id: S1,
        title: 'Test session',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        permissionMode: 'default',
        model: 'claude-sonnet-4-20250514',
      });

      const res = await request(app)
        .patch(`/api/sessions/${S1}`)
        .send({ model: 'claude-sonnet-4-20250514' });

      expect(res.status).toBe(200);
      expect(fakeRuntime.updateSession).toHaveBeenCalledWith(S1, {
        permissionMode: undefined,
        model: 'claude-sonnet-4-20250514',
        effort: undefined,
        fastMode: undefined,
      });
    });
  });

  // ---- POST /api/sessions/:id/messages (trigger-only, ADR-0264) ----
  //
  // Migrated from the legacy in-band SSE contract: the POST is now a fast
  // trigger that returns 202 + the canonical id and feeds the turn into the
  // projector (the single delivery path). These assert the trigger semantics —
  // status code, canonical id, validation, lock acquisition/release — not the
  // turn's tokens (those are exercised on GET /:id/events in
  // sessions-trigger.test.ts and sessions-streaming.test.ts).

  describe('POST /api/sessions/:id/messages', () => {
    it('returns 400 for missing content', async () => {
      const res = await request(app).post(`/api/sessions/${S1}/messages`).send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid request');
    });

    it('returns 202 with the canonical session id and no in-band turn frames', async () => {
      fakeRuntime.withScenarios([
        async function* () {
          yield { type: 'text_delta', data: { text: 'Hello world' } } as StreamEvent;
          yield { type: 'done', data: { sessionId: S1 } } as StreamEvent;
        },
      ]);
      fakeRuntime.getInternalSessionId.mockReturnValue(S1);

      const res = await request(app).post(`/api/sessions/${S1}/messages`).send({ content: 'hi' });

      expect(res.status).toBe(202);
      expect(res.type).toBe('application/json');
      expect(res.body).toEqual({ sessionId: S1 });
      // The turn's tokens are NOT delivered on the POST response.
      expect(res.text).not.toContain('text_delta');
    });

    it('acquires the lock and releases it after the (detached) turn completes', async () => {
      fakeRuntime.withScenarios([
        async function* () {
          yield { type: 'text_delta', data: { text: 'Hello' } } as StreamEvent;
          yield { type: 'done', data: { sessionId: S1 } } as StreamEvent;
        },
      ]);
      fakeRuntime.getInternalSessionId.mockReturnValue(S1);

      await request(app).post(`/api/sessions/${S1}/messages`).send({ content: 'hi' });

      expect(fakeRuntime.acquireLock).toHaveBeenCalledWith(
        S1,
        expect.any(String),
        expect.anything(),
        expect.any(Symbol) // per-turn lock token (I1)
      );
      await vi.waitFor(() =>
        expect(fakeRuntime.releaseLock).toHaveBeenCalledWith(
          S1,
          expect.any(String),
          expect.any(Symbol)
        )
      );
    });

    it('returns 409 when session is locked by another client', async () => {
      fakeRuntime.acquireLock.mockReturnValue(false);
      fakeRuntime.getLockInfo.mockReturnValue({
        clientId: 'other-client',
        acquiredAt: Date.now() - 60000,
      });

      const res = await request(app).post(`/api/sessions/${S1}/messages`).send({ content: 'hi' });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: 'Session locked',
        code: 'SESSION_LOCKED',
        lockedBy: 'other-client',
      });
      expect(res.body.lockedAt).toBeDefined();
    });

    it('releases the lock even when the detached turn errors', async () => {
      fakeRuntime.withScenarios([
        async function* (): AsyncGenerator<StreamEvent> {
          throw new Error('SDK failure');
        },
      ]);

      const res = await request(app).post(`/api/sessions/${S1}/messages`).send({ content: 'hi' });

      // The 202 is sent regardless — the error surfaces on /events, not here.
      expect(res.status).toBe(202);
      expect(fakeRuntime.acquireLock).toHaveBeenCalled();
      await vi.waitFor(() => expect(fakeRuntime.releaseLock).toHaveBeenCalled());
    });
  });

  // ---- Session runtime ownership (persist on first message) ----

  describe('session runtime ownership', () => {
    /** Trigger one turn and resolve once the 202 is returned. */
    async function sendMessageOnce(sessionId: string, body: Record<string, unknown>) {
      fakeRuntime.withScenarios([
        async function* () {
          yield { type: 'done', data: {} } as StreamEvent;
        },
      ]);
      return request(app).post(`/api/sessions/${sessionId}/messages`).send(body);
    }

    it('persists runtime=<default> when no hint or manifest is provided', async () => {
      vi.mocked(runtimeRegistry.getDefaultType).mockReturnValue('claude-code');

      await sendMessageOnce(S1, { content: 'hi' });

      expect(runtimeRegistry.persistSessionRuntime).toHaveBeenCalledWith(
        S1,
        'claude-code',
        undefined
      );
    });

    it('persists the explicit body.runtime hint when provided', async () => {
      vi.mocked(runtimeRegistry.has).mockReturnValue(true);

      await sendMessageOnce(S1, { content: 'hi', runtime: 'test-mode' });

      expect(runtimeRegistry.persistSessionRuntime).toHaveBeenCalledWith(
        S1,
        'test-mode',
        undefined
      );
    });

    it('passes agentPath to persistSessionRuntime', async () => {
      await sendMessageOnce(S1, {
        content: 'hi',
        runtime: 'test-mode',
        agentPath: '/projects/my-agent',
      });

      expect(runtimeRegistry.persistSessionRuntime).toHaveBeenCalledWith(
        S1,
        'test-mode',
        '/projects/my-agent'
      );
    });

    it('returns 400 when the hinted runtime is not registered', async () => {
      vi.mocked(runtimeRegistry.has).mockReturnValue(false);

      const res = await request(app)
        .post(`/api/sessions/${S1}/messages`)
        .send({ content: 'hi', runtime: 'codex' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNKNOWN_RUNTIME');
      expect(runtimeRegistry.persistSessionRuntime).not.toHaveBeenCalled();
    });

    it('falls back to the default when the MANIFEST runtime is not registered', async () => {
      // The manifest names a preference, not a guarantee: the test-mode server
      // registers only 'test-mode' while every on-disk manifest says
      // 'claude-code' (the AgentRuntime enum has no test-mode member). An
      // unregistered manifest runtime must soft-fall-back to the default —
      // only the EXPLICIT body hint 400s on an unknown runtime.
      mockReadManifest.mockResolvedValueOnce({ runtime: 'claude-code' } as never);
      vi.mocked(runtimeRegistry.getDefaultType).mockReturnValue('fake');
      vi.mocked(runtimeRegistry.has).mockImplementation((type: string) => type === 'fake');

      const res = await sendMessageOnce(S1, { content: 'hi', cwd: '/projects/seeded-agent' });

      expect(res.status).toBe(202);
      expect(runtimeRegistry.persistSessionRuntime).toHaveBeenCalledWith(S1, 'fake', undefined);
    });

    it('resolves via resolveForSession after persisting', async () => {
      // Ensure prior tests' `has.mockReturnValue(false)` does not leak
      vi.mocked(runtimeRegistry.has).mockReturnValue(true);
      vi.mocked(runtimeRegistry.resolveForSession).mockResolvedValue(fakeRuntime);

      await sendMessageOnce(S1, { content: 'hi' });

      expect(runtimeRegistry.resolveForSession).toHaveBeenCalledWith(S1);
      // persist should be called before resolve on the first message
      const persistOrder = vi.mocked(runtimeRegistry.persistSessionRuntime).mock
        .invocationCallOrder[0];
      const resolveOrder = vi.mocked(runtimeRegistry.resolveForSession).mock.invocationCallOrder[0];
      expect(persistOrder).toBeLessThan(resolveOrder);
    });
  });

  // ---- async-rejection guard (lib/async-handler.ts) ----

  describe('async handler rejections reach the error middleware', () => {
    // Express 4 does not forward rejected promises from async handlers — before
    // the shared asyncHandler wrapper, a resolveForSession rejection on a route
    // without its own try/catch left the request HANGING until client timeout.
    // These pin that a rejection now terminates as a mapped error response.

    it('maps a RuntimeNotRegisteredError rejection to 503 RUNTIME_NOT_AVAILABLE', async () => {
      vi.mocked(runtimeRegistry.resolveForSession).mockRejectedValueOnce(
        new RuntimeNotRegisteredError('codex', S1)
      );

      const res = await request(app).get(`/api/sessions/${S1}`);

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('RUNTIME_NOT_AVAILABLE');
      expect(res.body.runtime).toBe('codex');
    });

    it('maps an unexpected rejection on an interaction route to 500 INTERNAL_ERROR', async () => {
      // /approve never had its own try/catch — the wrapper is its only guard.
      vi.mocked(runtimeRegistry.resolveForSession).mockRejectedValueOnce(
        new Error('settings store unavailable')
      );

      const res = await request(app)
        .post(`/api/sessions/${S1}/approve`)
        .send({ toolCallId: 'tool-1' });

      expect(res.status).toBe(500);
      expect(res.body.code).toBe('INTERNAL_ERROR');
    });
  });

  // ---- POST /api/sessions/:id/approve ----

  describe('POST /api/sessions/:id/approve', () => {
    it('approves pending tool call', async () => {
      fakeRuntime.approveTool.mockReturnValue(true);

      const res = await request(app)
        .post(`/api/sessions/${S1}/approve`)
        .send({ toolCallId: 'tc1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(fakeRuntime.approveTool).toHaveBeenCalledWith(S1, 'tc1', true, undefined);
    });

    it('returns 404 when no pending approval', async () => {
      fakeRuntime.approveTool.mockReturnValue(false);

      const res = await request(app)
        .post(`/api/sessions/${S1}/approve`)
        .send({ toolCallId: 'tc1' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No pending approval');
    });
  });

  // ---- POST /api/sessions/:id/deny ----

  describe('POST /api/sessions/:id/deny', () => {
    it('denies pending tool call', async () => {
      fakeRuntime.approveTool.mockReturnValue(true);

      const res = await request(app).post(`/api/sessions/${S1}/deny`).send({ toolCallId: 'tc1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(fakeRuntime.approveTool).toHaveBeenCalledWith(S1, 'tc1', false);
    });

    it('returns 404 when no pending approval', async () => {
      fakeRuntime.approveTool.mockReturnValue(false);

      const res = await request(app).post(`/api/sessions/${S1}/deny`).send({ toolCallId: 'tc1' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No pending approval');
    });
  });

  // ---- Session ID Translation ----

  describe('session ID translation', () => {
    it('GET /messages uses internal session ID when available', async () => {
      fakeRuntime.getInternalSessionId.mockReturnValue('sdk-uuid-123');
      fakeRuntime.getMessageHistory.mockResolvedValue([]);

      await request(app).get(`/api/sessions/${S1}/messages`);

      expect(fakeRuntime.getInternalSessionId).toHaveBeenCalledWith(S1);
      expect(fakeRuntime.getMessageHistory).toHaveBeenCalledWith(
        expect.any(String),
        'sdk-uuid-123'
      );
    });

    it('returns 500 when getMessageHistory throws', async () => {
      fakeRuntime.getMessageHistory.mockRejectedValueOnce(new Error('I/O error'));

      const res = await request(app)
        .get(`/api/sessions/${S1}/messages`)
        .set('x-client-id', 'test-client');

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });

    it('GET /messages falls back to URL session ID when not in runtime', async () => {
      fakeRuntime.getInternalSessionId.mockReturnValue(undefined);
      fakeRuntime.getMessageHistory.mockResolvedValue([]);

      await request(app).get(`/api/sessions/${S1}/messages`);

      expect(fakeRuntime.getMessageHistory).toHaveBeenCalledWith(expect.any(String), S1);
    });

    it('GET /:id uses internal session ID for metadata lookup', async () => {
      fakeRuntime.getInternalSessionId.mockReturnValue('sdk-uuid-456');
      fakeRuntime.getSession.mockResolvedValue({
        id: 'sdk-uuid-456',
        title: 'Test',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        permissionMode: 'default',
      });

      const res = await request(app).get(`/api/sessions/${S1}`);

      expect(res.status).toBe(200);
      expect(fakeRuntime.getSession).toHaveBeenCalledWith(expect.any(String), 'sdk-uuid-456');
    });

    it('GET /:id/tasks uses internal session ID', async () => {
      fakeRuntime.getInternalSessionId.mockReturnValue('sdk-uuid-789');

      await request(app).get(`/api/sessions/${S1}/tasks`);

      expect(fakeRuntime.getSessionTasks).toHaveBeenCalledWith(expect.any(String), 'sdk-uuid-789');
    });
  });

  // ---- Boundary Enforcement ----

  describe('boundary enforcement', () => {
    it('GET /api/sessions rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).get('/api/sessions').query({ cwd: '/etc/passwd' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('GET /api/sessions/:id rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).get(`/api/sessions/${S1}`).query({ cwd: '/etc' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('GET /api/sessions/:id/messages rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app)
        .get(`/api/sessions/${S1}/messages`)
        .query({ cwd: '/tmp/evil' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('GET /api/sessions/:id/tasks rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).get(`/api/sessions/${S1}/tasks`).query({ cwd: '/tmp/evil' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('rejects null byte paths with 403 and NULL_BYTE code', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Invalid path: null bytes not allowed', 'NULL_BYTE')
      );

      const res = await request(app)
        .get('/api/sessions')
        .query({ cwd: '/home/user/project\0/../../etc' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NULL_BYTE');
    });
  });

  // ---- POST /api/sessions/:id/fork ----

  describe('POST /api/sessions/:id/fork', () => {
    it('returns 400 for invalid session ID', async () => {
      const res = await request(app).post('/api/sessions/not-a-uuid/fork').send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SESSION_ID');
    });

    it('forks a session and returns 201 with new session', async () => {
      const forkedSession = {
        id: '00000000-0000-4000-8000-000000000099',
        title: 'Test conversation (fork)',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        permissionMode: 'default' as const,
      };
      fakeRuntime.forkSession.mockResolvedValue(forkedSession);

      const res = await request(app).post(`/api/sessions/${S1}/fork`).send({});
      expect(res.status).toBe(201);
      expect(res.body).toEqual(forkedSession);
      expect(fakeRuntime.forkSession).toHaveBeenCalledWith(expect.any(String), S1, {});
    });

    it('passes upToMessageId and title to runtime', async () => {
      fakeRuntime.forkSession.mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000099',
        title: 'Custom fork',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        permissionMode: 'default' as const,
      });

      await request(app)
        .post(`/api/sessions/${S1}/fork`)
        .send({ upToMessageId: 'msg-123', title: 'Custom fork' });

      expect(fakeRuntime.forkSession).toHaveBeenCalledWith(expect.any(String), S1, {
        upToMessageId: 'msg-123',
        title: 'Custom fork',
      });
    });

    it('returns 404 when fork fails (session not found)', async () => {
      fakeRuntime.forkSession.mockResolvedValue(null);

      const res = await request(app).post(`/api/sessions/${S1}/fork`).send({});
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('FORK_FAILED');
    });

    it('returns 500 when runtime throws', async () => {
      fakeRuntime.forkSession.mockRejectedValue(new Error('SDK crash'));

      const res = await request(app).post(`/api/sessions/${S1}/fork`).send({});
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('FORK_ERROR');
    });

    it('translates session ID via getInternalSessionId', async () => {
      const internalId = '00000000-0000-4000-8000-internal00001';
      fakeRuntime.getInternalSessionId.mockReturnValue(internalId);
      fakeRuntime.forkSession.mockResolvedValue({
        id: '00000000-0000-4000-8000-forked0000001',
        title: 'Forked',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        permissionMode: 'default' as const,
      });

      await request(app).post(`/api/sessions/${S1}/fork`).send({});
      expect(fakeRuntime.forkSession).toHaveBeenCalledWith(expect.any(String), internalId, {});
    });
  });
});
