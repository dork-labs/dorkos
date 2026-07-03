/**
 * @vitest-environment node
 *
 * Integration test for the per-session runtime-routing wiring introduced by
 * the codex-runtime-adapter-prework spec (ADR-0255). Unlike the unit tests in
 * sessions.test.ts / models.test.ts, this suite does NOT mock
 * `runtime-registry.js` — it uses the real singleton registry, a real in-memory
 * DB, and BOTH runtime implementations (`ClaudeCodeRuntime` + `TestModeRuntime`)
 * so that regressions in `resolveForSession` / `persistSessionRuntime` /
 * legacy-session inference / `RuntimeNotRegisteredError` are caught end-to-end.
 *
 * Mocking strategy:
 *  - Boundary, tunnel-manager, config-manager, and shared/manifest are still
 *    mocked — they're app-wide collaborators whose real initialization isn't
 *    relevant to routing and would require filesystem setup.
 *  - The runtime registry, both runtime classes, and the DB are real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { collectDurableEvents } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';

// Mock boundary before importing app (same pattern as other route tests)
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

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn(async () => null),
}));

import request from 'supertest';
import { createApp, finalizeApp } from '../../app.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, eq } from '@dorkos/db';
import type { Db } from '@dorkos/db';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { ClaudeCodeRuntime } from '../../services/runtimes/claude-code/claude-code-runtime.js';
import { TestModeRuntime } from '../../services/runtimes/test-mode/test-mode-runtime.js';
import { peekProjector, disposeProjector } from '../../services/session/session-state-projector.js';
import type { SessionSnapshot } from '@dorkos/shared/session-stream';

const app = createApp();
finalizeApp(app);

const CLAUDE_SESSION = '11111111-1111-4111-8111-111111111111';
const TEST_MODE_SESSION = '22222222-2222-4222-8222-222222222222';
const LEGACY_SESSION = '33333333-3333-4333-8333-333333333333';
const CODEX_ORPHAN_SESSION = '44444444-4444-4444-8444-444444444444';
const UNSEEN_SESSION = '55555555-5555-4555-8555-555555555555';

/**
 * Register both runtimes on the real singleton and wire the provided DB.
 *
 * Kept inline because extracting to a shared helper before a second caller
 * exists would be premature; task #6 and Phase 3 may lift this later.
 */
function registerBothRuntimes(db: Db): {
  claude: ClaudeCodeRuntime;
  testMode: TestModeRuntime;
} {
  const claude = new ClaudeCodeRuntime('/tmp/dork-test-home', '/tmp/dork-test-cwd');
  const testMode = new TestModeRuntime();
  runtimeRegistry.setDb(db);
  runtimeRegistry.register(claude);
  runtimeRegistry.register(testMode);
  runtimeRegistry.setDefault('claude-code');
  return { claude, testMode };
}

/**
 * Trigger a turn via POST /:id/messages (trigger-only, ADR-0264) and return the
 * JSON status + body. The turn runs detached; its tokens flow on GET /:id/events,
 * not on this response.
 */
async function postMessage(
  sessionId: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await request(app).post(`/api/sessions/${sessionId}/messages`).send(body);
  return { status: res.status, body: res.body as Record<string, unknown> };
}

describe('sessions route — multi-runtime routing (real registry + real DB)', () => {
  let db: Db;
  let claude: ClaudeCodeRuntime;
  let testMode: TestModeRuntime;

  beforeEach(() => {
    db = createTestDb();
    ({ claude, testMode } = registerBothRuntimes(db));
    vi.clearAllMocks();
  });

  afterEach(() => {
    // The projector registry is a process singleton; a triggered turn leaves
    // per-session projector state. Drop it so accumulated turns don't leak across
    // tests (e.g. an earlier "Echo: hi" turn surfacing in a later assertion).
    for (const id of [
      CLAUDE_SESSION,
      TEST_MODE_SESSION,
      LEGACY_SESSION,
      CODEX_ORPHAN_SESSION,
      UNSEEN_SESSION,
    ]) {
      disposeProjector(id);
    }
  });

  // ---------------------------------------------------------------------------
  // Runtime ownership persistence
  // ---------------------------------------------------------------------------

  describe('POST /:id/messages — runtime ownership persistence', () => {
    it('persists runtime="test-mode" when body.runtime hint is provided', async () => {
      const res = await postMessage(TEST_MODE_SESSION, {
        content: 'hi',
        runtime: 'test-mode',
      });

      expect(res.status).toBe(202);
      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, TEST_MODE_SESSION))
        .get();
      expect(row).toBeDefined();
      expect(row!.runtime).toBe('test-mode');
    });

    it('persists runtime=<default> when no hint is provided', async () => {
      // Spy on claude-code methods since ClaudeCodeRuntime's real sendMessage
      // would try to talk to the Anthropic API. We only want to verify routing.
      const sendSpy = vi.spyOn(claude, 'sendMessage').mockImplementation(async function* () {
        yield { type: 'done', data: { sessionId: CLAUDE_SESSION } } as StreamEvent;
      });

      const res = await postMessage(CLAUDE_SESSION, { content: 'hi' });

      expect(res.status).toBe(202);
      expect(sendSpy).toHaveBeenCalled();
      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, CLAUDE_SESSION))
        .get();
      expect(row).toBeDefined();
      expect(row!.runtime).toBe('claude-code');
    });

    it('records agentPath on first message for provenance', async () => {
      await postMessage(TEST_MODE_SESSION, {
        content: 'hi',
        runtime: 'test-mode',
        agentPath: '/projects/my-agent',
      });

      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, TEST_MODE_SESSION))
        .get();
      expect(row).toBeDefined();
      expect(row!.agentPath).toBe('/projects/my-agent');
    });

    it('returns 400 UNKNOWN_RUNTIME for an unregistered hint and persists no row', async () => {
      const res = await request(app)
        .post(`/api/sessions/${TEST_MODE_SESSION}/messages`)
        .send({ content: 'hi', runtime: 'nonexistent-runtime' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNKNOWN_RUNTIME');

      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, TEST_MODE_SESSION))
        .get();
      expect(row).toBeUndefined();
    });

    it('first-write-wins: subsequent hints on the same session are ignored', async () => {
      // First message: test-mode
      await postMessage(TEST_MODE_SESSION, { content: 'first', runtime: 'test-mode' });

      // Second message: claude-code hint — should be ignored, row remains test-mode
      await postMessage(TEST_MODE_SESSION, { content: 'second', runtime: 'claude-code' });

      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, TEST_MODE_SESSION))
        .get();
      expect(row!.runtime).toBe('test-mode');
    });
  });

  // ---------------------------------------------------------------------------
  // Legacy session inference (no session_metadata row → claude-code)
  // ---------------------------------------------------------------------------

  describe('legacy-session inference', () => {
    it('registry.getSessionRuntimeType() infers "claude-code" without writing a row (read-only)', async () => {
      const before = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, LEGACY_SESSION))
        .get();
      expect(before).toBeUndefined();

      const type = await runtimeRegistry.getSessionRuntimeType(LEGACY_SESSION);
      expect(type).toBe('claude-code');

      // No side-effect write. Only `persistSessionRuntime` (called from
      // `POST /:id/messages`) ever writes to session_metadata.
      const after = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, LEGACY_SESSION))
        .get();
      expect(after).toBeUndefined();
    });

    it('resolveForSession() returns the claude-code runtime for a session with no row (no side-effect write)', async () => {
      const runtime = await runtimeRegistry.resolveForSession(UNSEEN_SESSION);
      expect(runtime.type).toBe('claude-code');
      expect(runtime).toBe(claude);

      // Read is pure — no row is written. Explicit persistence is the
      // `persistSessionRuntime` call made by `POST /:id/messages`.
      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, UNSEEN_SESSION))
        .get();
      expect(row).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // RuntimeNotRegisteredError — stored runtime no longer present
  // ---------------------------------------------------------------------------

  describe('RuntimeNotRegisteredError', () => {
    it('resolveForSession() throws when the stored runtime type is not registered', async () => {
      // Seed a row that points at 'codex' — which this test harness never registers.
      await db.insert(sessionMetadata).values({
        sessionId: CODEX_ORPHAN_SESSION,
        runtime: 'codex',
        agentPath: null,
        createdAt: new Date().toISOString(),
      });

      await expect(runtimeRegistry.resolveForSession(CODEX_ORPHAN_SESSION)).rejects.toThrow(
        /owned by runtime 'codex'/
      );
    });

    it('getSessionRuntimeType() returns the stored type even when not registered', async () => {
      await db.insert(sessionMetadata).values({
        sessionId: CODEX_ORPHAN_SESSION,
        runtime: 'codex',
        agentPath: null,
        createdAt: new Date().toISOString(),
      });

      // getSessionRuntimeType doesn't assert registration — only resolveForSession does.
      const type = await runtimeRegistry.getSessionRuntimeType(CODEX_ORPHAN_SESSION);
      expect(type).toBe('codex');
    });

    it('GET /messages surfaces a 503 RUNTIME_NOT_AVAILABLE when the stored runtime is not registered', async () => {
      await db.insert(sessionMetadata).values({
        sessionId: CODEX_ORPHAN_SESSION,
        runtime: 'codex',
        agentPath: null,
        createdAt: new Date().toISOString(),
      });

      // GET /messages wraps resolveForSession in try/catch + next(err); the
      // global error middleware recognizes RuntimeNotRegisteredError and maps
      // it to a 503 with a stable code so the client can render a targeted
      // "runtime not available on this server" message instead of a generic 500.
      const res = await request(app).get(`/api/sessions/${CODEX_ORPHAN_SESSION}/messages`);

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('RUNTIME_NOT_AVAILABLE');
      expect(res.body.runtime).toBe('codex');
    });
  });

  // ---------------------------------------------------------------------------
  // Per-endpoint dispatch — spy on test-mode runtime, verify claude-code is not
  // called for a test-mode-owned session.
  // ---------------------------------------------------------------------------

  describe('each hot-path handler dispatches to the session-owned runtime', () => {
    beforeEach(async () => {
      // Pre-register TEST_MODE_SESSION as test-mode-owned so we don't need to
      // go through POST /messages on every sub-test.
      await db.insert(sessionMetadata).values({
        sessionId: TEST_MODE_SESSION,
        runtime: 'test-mode',
        agentPath: null,
        createdAt: new Date().toISOString(),
      });
    });

    it('GET /:id routes to test-mode runtime', async () => {
      const testModeSpy = vi.spyOn(testMode, 'getSession');
      const claudeSpy = vi.spyOn(claude, 'getSession');

      const res = await request(app).get(`/api/sessions/${TEST_MODE_SESSION}`);

      expect(testModeSpy).toHaveBeenCalled();
      expect(claudeSpy).not.toHaveBeenCalled();
      // TestModeRuntime.getSession returns null → 404 Session not found.
      expect(res.status).toBe(404);
    });

    it('GET /:id/tasks routes to test-mode runtime', async () => {
      const testModeSpy = vi.spyOn(testMode, 'getSessionTasks');
      const claudeSpy = vi.spyOn(claude, 'getSessionTasks');

      const res = await request(app).get(`/api/sessions/${TEST_MODE_SESSION}/tasks`);

      expect(testModeSpy).toHaveBeenCalled();
      expect(claudeSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ tasks: [] });
    });

    it('GET /:id/messages routes to test-mode runtime', async () => {
      const testModeSpy = vi.spyOn(testMode, 'getMessageHistory');
      const claudeSpy = vi.spyOn(claude, 'getMessageHistory');

      const res = await request(app).get(`/api/sessions/${TEST_MODE_SESSION}/messages`);

      expect(testModeSpy).toHaveBeenCalled();
      expect(claudeSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ messages: [] });
    });

    it('PATCH /:id routes to test-mode runtime', async () => {
      const testModeSpy = vi.spyOn(testMode, 'updateSession');
      const claudeSpy = vi.spyOn(claude, 'updateSession');

      // TestModeRuntime.updateSession returns false because no _sessions entry
      // exists — the route should respond with 404.
      const res = await request(app)
        .patch(`/api/sessions/${TEST_MODE_SESSION}`)
        .send({ permissionMode: 'plan' });

      expect(testModeSpy).toHaveBeenCalled();
      expect(claudeSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SESSION_NOT_FOUND');
    });

    it('POST /:id/fork routes to test-mode runtime', async () => {
      const testModeSpy = vi.spyOn(testMode, 'forkSession');
      const claudeSpy = vi.spyOn(claude, 'forkSession');

      const res = await request(app).post(`/api/sessions/${TEST_MODE_SESSION}/fork`).send({});

      expect(testModeSpy).toHaveBeenCalled();
      expect(claudeSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(404); // TestModeRuntime returns null → FORK_FAILED
      expect(res.body.code).toBe('FORK_FAILED');
    });

    it('POST /:id/reload-plugins routes to test-mode runtime', async () => {
      const testModeSpy = vi.spyOn(testMode, 'reloadPlugins');
      const claudeSpy = vi.spyOn(claude, 'reloadPlugins');

      const res = await request(app).post(`/api/sessions/${TEST_MODE_SESSION}/reload-plugins`);

      expect(testModeSpy).toHaveBeenCalled();
      expect(claudeSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NO_ACTIVE_QUERY');
    });

    it('POST /:id/messages + GET /:id/events deliver a test-mode turn over the durable path (task #15)', async () => {
      // Trigger-only (ADR-0264) end-to-end with the STATELESS runtime: the POST
      // dispatches to test-mode's sendMessage, the detached turn feeds the
      // projector, and GET /:id/events serves snapshot+replay through the SAME
      // handler the Claude adapter uses — no runtime branching anywhere. The
      // snapshot's history is reconstructed purely from the DorkOS EventLog
      // (Decision 1 / runtime-agnosticism, spec task #15).
      const testModeSpy = vi.spyOn(testMode, 'sendMessage');
      const claudeSpy = vi.spyOn(claude, 'sendMessage');

      const res = await postMessage(TEST_MODE_SESSION, { content: 'Hello' });

      expect(testModeSpy).toHaveBeenCalled();
      expect(claudeSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ sessionId: TEST_MODE_SESSION });

      // Wait for the detached turn to settle so the cold connect below gets a
      // deterministic post-turn snapshot.
      await vi.waitFor(() => {
        expect(peekProjector(TEST_MODE_SESSION)?.getStatus().lifecycle).toBe('idle');
      });

      // Cold connect: the snapshot carries the EventLog-reconstructed history.
      const cold = await collectDurableEvents(app, TEST_MODE_SESSION, {
        until: (frames) => frames.some((f) => f.event === 'snapshot'),
      });
      const snapshot = cold.frames.find((f) => f.event === 'snapshot')!.data as SessionSnapshot;
      expect(snapshot.messages).toEqual([
        { id: 'user-1', role: 'user', content: 'Hello' },
        { id: 'assistant-1', role: 'assistant', content: 'Echo: Hello' },
      ]);
      expect(snapshot.inProgressTurn).toBeNull();
      expect(snapshot.status.lifecycle).toBe('idle');
      expect(snapshot.cursor).toBeGreaterThan(0);

      // Resume connect: ?after replays the gap from the log — no snapshot frame.
      const resumed = await collectDurableEvents(app, TEST_MODE_SESSION, {
        until: (frames) => frames.some((f) => f.event === 'turn_end'),
        after: snapshot.cursor - 2,
      });
      expect(resumed.frames.some((f) => f.event === 'snapshot')).toBe(false);
      expect(resumed.frames.map((f) => f.event)).toEqual(['text_delta', 'turn_end']);
    });

    it('POST /:id/approve routes to test-mode runtime', async () => {
      const testModeSpy = vi.spyOn(testMode, 'approveTool');
      const claudeSpy = vi.spyOn(claude, 'approveTool');

      const res = await request(app)
        .post(`/api/sessions/${TEST_MODE_SESSION}/approve`)
        .send({ toolCallId: 'tc-1' });

      expect(testModeSpy).toHaveBeenCalled();
      expect(claudeSpy).not.toHaveBeenCalled();
      // test-mode.approveTool returns false, hasSession returns false → 404.
      expect(res.status).toBe(404);
    });

    it('POST /:id/deny routes to test-mode runtime', async () => {
      const testModeSpy = vi.spyOn(testMode, 'approveTool');
      const claudeSpy = vi.spyOn(claude, 'approveTool');

      await request(app)
        .post(`/api/sessions/${TEST_MODE_SESSION}/deny`)
        .send({ toolCallId: 'tc-1' });

      expect(testModeSpy).toHaveBeenCalled();
      expect(claudeSpy).not.toHaveBeenCalled();
    });

    it('POST /:id/batch-approve routes to test-mode runtime', async () => {
      const testModeSpy = vi.spyOn(testMode, 'approveTool');
      const claudeSpy = vi.spyOn(claude, 'approveTool');

      const res = await request(app)
        .post(`/api/sessions/${TEST_MODE_SESSION}/batch-approve`)
        .send({ toolCallIds: ['tc-1', 'tc-2'] });

      expect(testModeSpy).toHaveBeenCalledTimes(2);
      expect(claudeSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
    });

    it('POST /:id/batch-deny routes to test-mode runtime', async () => {
      const testModeSpy = vi.spyOn(testMode, 'approveTool');
      const claudeSpy = vi.spyOn(claude, 'approveTool');

      const res = await request(app)
        .post(`/api/sessions/${TEST_MODE_SESSION}/batch-deny`)
        .send({ toolCallIds: ['tc-1'] });

      expect(testModeSpy).toHaveBeenCalledTimes(1);
      expect(claudeSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
    });

    it('POST /:id/submit-answers routes to test-mode runtime', async () => {
      const testModeSpy = vi.spyOn(testMode, 'submitAnswers');
      const claudeSpy = vi.spyOn(claude, 'submitAnswers');

      await request(app)
        .post(`/api/sessions/${TEST_MODE_SESSION}/submit-answers`)
        .send({ toolCallId: 'tc-1', answers: { '0': 'A' } });

      expect(testModeSpy).toHaveBeenCalled();
      expect(claudeSpy).not.toHaveBeenCalled();
    });

    it('POST /:id/submit-elicitation routes to test-mode runtime', async () => {
      const testModeSpy = vi.spyOn(testMode, 'submitElicitation');
      const claudeSpy = vi.spyOn(claude, 'submitElicitation');

      await request(app)
        .post(`/api/sessions/${TEST_MODE_SESSION}/submit-elicitation`)
        .send({ interactionId: 'e-1', action: 'accept' });

      expect(testModeSpy).toHaveBeenCalled();
      expect(claudeSpy).not.toHaveBeenCalled();
    });

    it('POST /:id/tasks/:taskId/stop routes to test-mode runtime', async () => {
      const testModeSpy = vi.spyOn(testMode, 'stopTask');
      const claudeSpy = vi.spyOn(claude, 'stopTask');

      await request(app).post(`/api/sessions/${TEST_MODE_SESSION}/tasks/task-1/stop`);

      expect(testModeSpy).toHaveBeenCalled();
      expect(claudeSpy).not.toHaveBeenCalled();
    });

    it('POST /:id/interrupt routes to test-mode runtime', async () => {
      const testModeSpy = vi.spyOn(testMode, 'interruptQuery');
      const claudeSpy = vi.spyOn(claude, 'interruptQuery');

      const res = await request(app).post(`/api/sessions/${TEST_MODE_SESSION}/interrupt`);

      expect(testModeSpy).toHaveBeenCalled();
      expect(claudeSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false });
    });
  });

  // ---------------------------------------------------------------------------
  // Reverse-direction sanity: a claude-code-owned session dispatches to claude.
  // ---------------------------------------------------------------------------

  describe('claude-code-owned session dispatches to claude runtime', () => {
    beforeEach(async () => {
      await db.insert(sessionMetadata).values({
        sessionId: CLAUDE_SESSION,
        runtime: 'claude-code',
        agentPath: null,
        createdAt: new Date().toISOString(),
      });
    });

    it('GET /:id routes to claude runtime (not test-mode)', async () => {
      const claudeSpy = vi.spyOn(claude, 'getSession');
      const testModeSpy = vi.spyOn(testMode, 'getSession');

      await request(app).get(`/api/sessions/${CLAUDE_SESSION}`);

      expect(claudeSpy).toHaveBeenCalled();
      expect(testModeSpy).not.toHaveBeenCalled();
    });

    it('POST /:id/interrupt routes to claude runtime', async () => {
      const claudeSpy = vi.spyOn(claude, 'interruptQuery').mockResolvedValue(false);
      const testModeSpy = vi.spyOn(testMode, 'interruptQuery');

      await request(app).post(`/api/sessions/${CLAUDE_SESSION}/interrupt`);

      expect(claudeSpy).toHaveBeenCalled();
      expect(testModeSpy).not.toHaveBeenCalled();
    });
  });
});
