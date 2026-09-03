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
import { collectDurableEvents, mockInterruptReceipt } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import { ControlRequestTimeoutError } from '../../services/runtimes/claude-code/sessions/bounded-control.js';

// Mock boundary before importing app (same pattern as other route tests)
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

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

/**
 * The stored `runtimes` section this file's server reads. `null` by default —
 * every other setting these routes touch is irrelevant here — and replaced by
 * the execution-defaults tests below, which need a real one.
 */
let runtimesConfig: unknown = null;

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'runtimes' ? runtimesConfig : null)),
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
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';

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
  // The durable settings port, wired exactly as the composition root wires it
  // (`index.ts`): without it a settings change writes nothing, which is the very
  // path the seeding tests below are about.
  claude.setSessionSettings(runtimeRegistry);
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
  // Execution defaults seeded at the first write (spec execution-defaults E1)
  // ---------------------------------------------------------------------------

  describe('POST /:id/messages — model and effort seeding', () => {
    afterEach(() => {
      runtimesConfig = null;
    });

    it("starts a new session on the runtime's configured default model and effort", async () => {
      // One write, and all three adapters inherit: each already resolves a turn
      // as per-send override -> persisted -> its own default, so seeding the
      // persisted row is the only change the inheritance needs.
      runtimesConfig = {
        ...USER_CONFIG_DEFAULTS.runtimes,
        claudeCode: {
          ...USER_CONFIG_DEFAULTS.runtimes.claudeCode,
          defaultModel: 'opus',
          defaultEffort: 'high',
        },
      };
      vi.spyOn(claude, 'sendMessage').mockImplementation(async function* () {
        yield { type: 'done', data: { sessionId: CLAUDE_SESSION } } as StreamEvent;
      });

      expect((await postMessage(CLAUDE_SESSION, { content: 'hi' })).status).toBe(202);

      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, CLAUDE_SESSION))
        .get();
      expect(row!.model).toBe('opus');
      expect(row!.effort).toBe('high');
    });

    it('uses the default of the runtime the session actually lands on', async () => {
      // Model ids are runtime-namespaced, which is why the defaults are too: a
      // test-mode session must not be started on the claude-code model.
      runtimesConfig = {
        ...USER_CONFIG_DEFAULTS.runtimes,
        claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultModel: 'opus' },
      };

      await postMessage(TEST_MODE_SESSION, { content: 'hi', runtime: 'test-mode' });

      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, TEST_MODE_SESSION))
        .get();
      expect(row!.model).toBeNull();
    });

    it('leaves a session that has already started exactly as it is', async () => {
      // "Applies to new conversations — running ones keep their settings."
      await postMessage(TEST_MODE_SESSION, { content: 'first', runtime: 'test-mode' });
      runtimesConfig = {
        ...USER_CONFIG_DEFAULTS.runtimes,
        claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultModel: 'opus' },
      };

      await postMessage(TEST_MODE_SESSION, { content: 'second', runtime: 'test-mode' });

      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, TEST_MODE_SESSION))
        .get();
      expect(row!.model).toBeNull();
    });

    it('still seeds when a settings change minted the row before the first message', async () => {
      // The pre-launch path, and the one E3 makes NORMAL: changing a setting
      // before sending anything writes the `session_metadata` row. That row has
      // no runtime yet (DOR-812), so the defaults ride the first message — the
      // write that binds one — and an explicit value still wins over the default
      // it arrives beside.
      runtimesConfig = {
        ...USER_CONFIG_DEFAULTS.runtimes,
        claudeCode: {
          ...USER_CONFIG_DEFAULTS.runtimes.claudeCode,
          defaultModel: 'opus',
          defaultEffort: 'high',
        },
      };
      vi.spyOn(claude, 'sendMessage').mockImplementation(async function* () {
        yield { type: 'done', data: { sessionId: CLAUDE_SESSION } } as StreamEvent;
      });

      await request(app)
        .patch(`/api/sessions/${CLAUDE_SESSION}`)
        .send({ model: 'sonnet' })
        .expect(200);
      expect((await postMessage(CLAUDE_SESSION, { content: 'hi' })).status).toBe(202);

      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, CLAUDE_SESSION))
        .get();
      // The person's explicit choice, untouched.
      expect(row!.model).toBe('sonnet');
      // The key their write did not carry, filled from the server default.
      expect(row!.effort).toBe('high');
    });

    it('seeds the defaults of the runtime the first message binds, not of the guess', async () => {
      // Changing a setting pre-launch used to mint the row with the INFERRED
      // runtime, so this session would have been seeded — and routed — as
      // claude-code despite the person having chosen test-mode. Every default is
      // a per-runtime answer, so seeding before the binding is a guess in every
      // key (DOR-812).
      runtimesConfig = {
        ...USER_CONFIG_DEFAULTS.runtimes,
        claudeCode: {
          ...USER_CONFIG_DEFAULTS.runtimes.claudeCode,
          defaultModel: 'opus',
          defaultEffort: 'high',
        },
      };

      await request(app)
        .patch(`/api/sessions/${TEST_MODE_SESSION}`)
        .send({ effort: 'low' })
        .expect(200);
      expect(
        (await postMessage(TEST_MODE_SESSION, { content: 'hi', runtime: 'test-mode' })).status
      ).toBe(202);

      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, TEST_MODE_SESSION))
        .get();
      expect(row!.effort).toBe('low');
      // test-mode has no configured section, so claude-code's model must not
      // reach it — the session is not a claude-code session.
      expect(row!.model).toBeNull();
    });

    it('seeds nothing at all on a fresh install', async () => {
      runtimesConfig = USER_CONFIG_DEFAULTS.runtimes;

      await postMessage(TEST_MODE_SESSION, { content: 'hi', runtime: 'test-mode' });

      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, TEST_MODE_SESSION))
        .get();
      expect(row!.model).toBeNull();
      expect(row!.effort).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Runtime ownership persistence
  // ---------------------------------------------------------------------------

  describe('POST /:id/messages — runtime ownership persistence', () => {
    // The stored `runtimes` section is module state; one test below needs a real
    // one, so every test here starts from the same null it declares.
    afterEach(() => {
      runtimesConfig = null;
    });

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

    it('a settings change before the first message does not choose the runtime (DOR-812)', async () => {
      // The whole bug, end to end: PATCH the session before sending anything —
      // the pre-launch picker's normal move — and the row it minted used to say
      // claude-code, which the first-write-wins binding then made permanent. A
      // person who had chosen another runtime got a session on the wrong one.
      await request(app)
        .patch(`/api/sessions/${TEST_MODE_SESSION}`)
        .send({ model: 'sonnet' })
        .expect(200);

      // Unbound in the meantime: the row exists, but nothing has claimed it.
      expect(
        db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, TEST_MODE_SESSION))
          .get()!.runtime
      ).toBeNull();

      await postMessage(TEST_MODE_SESSION, { content: 'hi', runtime: 'test-mode' });

      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, TEST_MODE_SESSION))
        .get();
      expect(row!.runtime).toBe('test-mode');
      // The setting that created the row is still the person's.
      expect(row!.model).toBe('sonnet');
    });

    it('keeps answering settings writes while the session is unbound, and stays unbound', async () => {
      // The row exists but names no runtime, and every read still resolves it by
      // inference — so the capability gate on `PATCH /api/sessions/:id` behaves
      // exactly as it does for a session with no row at all: it accepts a mode
      // the inferred runtime declares and refuses one it does not. Unbound must
      // never mean unusable.
      await request(app)
        .patch(`/api/sessions/${TEST_MODE_SESSION}`)
        .send({ model: 'sonnet' })
        .expect(200);
      await request(app)
        .patch(`/api/sessions/${TEST_MODE_SESSION}`)
        .send({ permissionMode: 'plan' })
        .expect(200);

      const refused = await request(app)
        .patch(`/api/sessions/${TEST_MODE_SESSION}`)
        .send({ permissionMode: 'dontAsk' });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('UNSUPPORTED_PERMISSION_MODE');

      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, TEST_MODE_SESSION))
        .get();
      expect(row!.runtime).toBeNull();
      // Both writes landed. What the row holds while it is unbound is
      // PROVISIONAL — a mode gated against the inferred runtime, not against the
      // one this session will run on — and the binding write is what settles
      // that; see the two tests below.
      expect(row!.model).toBe('sonnet');
    });

    it('drops a pre-launch mode the runtime it binds cannot run, for the runtime’s own', async () => {
      // The hole this fix would otherwise open. The PATCH gate can only judge
      // the mode against the INFERRED runtime, because an unbound session has
      // nothing else — so `plan` is accepted here and would have arrived, intact
      // and undeclared, on a bound test-mode session. A session must never
      // report a safety posture its runtime is not running (#674).
      runtimesConfig = { ...USER_CONFIG_DEFAULTS.runtimes, defaultTrustStop: 'act' };

      await request(app)
        .patch(`/api/sessions/${TEST_MODE_SESSION}`)
        .send({ permissionMode: 'plan' })
        .expect(200);
      await postMessage(TEST_MODE_SESSION, { content: 'hi', runtime: 'test-mode' });

      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, TEST_MODE_SESSION))
        .get();
      expect(row!.runtime).toBe('test-mode');
      // test-mode declares no `plan`. What lands instead is its OWN mode at the
      // configured stop — the seed, under the drop.
      expect(row!.permissionMode).toBe('scripted');
    });

    it('keeps a pre-launch mode the runtime it binds does declare', async () => {
      // The converse, and the reason the rule is "what this runtime declares"
      // rather than "distrust anything chosen early": a person who set a mode
      // before sending still gets it.
      vi.spyOn(claude, 'sendMessage').mockImplementation(async function* () {
        yield { type: 'done', data: { sessionId: CLAUDE_SESSION } } as StreamEvent;
      });

      await request(app)
        .patch(`/api/sessions/${CLAUDE_SESSION}`)
        .send({ permissionMode: 'plan' })
        .expect(200);
      await postMessage(CLAUDE_SESSION, { content: 'hi' });

      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, CLAUDE_SESSION))
        .get();
      expect(row!.runtime).toBe('claude-code');
      expect(row!.permissionMode).toBe('plan');
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
      // `type`, not identity: `register()` wraps every runtime at the one
      // registration seam (the sign-in watch, and tracing when it is on), so a
      // lookup DELEGATES to the instance that was registered rather than being
      // it. Which runtime answered is the claim here, and this is how it is
      // spelled everywhere else since DOR-1654.
      expect(runtime.type).toBe('claude-code');

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

      // Updates a MODEL, not a permission mode: test-mode declares its own
      // scenario-shaped mode ids, and the route now refuses to store a mode the
      // owning runtime never declared (that gate is covered in sessions.test.ts).
      // TestModeRuntime.updateSession answers `{ updated: false }` because no
      // _sessions entry exists — the route should respond with 404.
      const res = await request(app)
        .patch(`/api/sessions/${TEST_MODE_SESSION}`)
        .send({ model: 'scripted-model' });

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

    it('POST /:id/reload-plugins answers 504, not "send a message first", when the agent never confirms (DOR-1301)', async () => {
      // The two failures are different facts. `null` means there was no query to
      // ask; a timeout means there WAS one and it did not answer inside the
      // bound. Answering the second with the first told the operator to send a
      // message they had already sent.
      vi.spyOn(testMode, 'reloadPlugins').mockRejectedValueOnce(
        new ControlRequestTimeoutError('reloadPlugins', 8_000)
      );

      const res = await request(app).post(`/api/sessions/${TEST_MODE_SESSION}/reload-plugins`);

      expect(res.status).toBe(504);
      expect(res.body.code).toBe('RELOAD_TIMEOUT');
      expect(res.body.error).toContain('may still apply');
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
      // The whole body: the canonical id plus the queue receipt, and no turn
      // frames — the turn is delivered on /events and nowhere else.
      expect(res.body).toEqual({
        sessionId: TEST_MODE_SESSION,
        messageId: expect.any(String),
        outcome: { messageId: expect.any(String), requested: 'queue', applied: 'queue' },
        queuePosition: 1,
      });

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
      // Ids are minted from the event's own `seq`, so they are asserted by SHAPE
      // rather than by value: any bookkeeping the dispatcher puts on the stream
      // ahead of the turn (the steerability announcement) shifts the numbers
      // without changing a thing about the history.
      expect(snapshot.messages).toEqual([
        { id: expect.stringMatching(/^user-\d+$/), role: 'user', content: 'Hello' },
        { id: expect.stringMatching(/^assistant-\d+$/), role: 'assistant', content: 'Echo: Hello' },
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
      // The receipt names the runtime that answered, which is half of what
      // makes this test about ROUTING rather than about a 200.
      expect(res.body).toEqual({
        receipt: { outcome: 'not-running', reason: 'no-open-turn', runtime: 'test-mode' },
        cancelledQueued: [],
      });
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
      const claudeSpy = vi
        .spyOn(claude, 'interruptQuery')
        .mockResolvedValue(mockInterruptReceipt('not-running'));
      const testModeSpy = vi.spyOn(testMode, 'interruptQuery');

      await request(app).post(`/api/sessions/${CLAUDE_SESSION}/interrupt`);

      expect(claudeSpy).toHaveBeenCalled();
      expect(testModeSpy).not.toHaveBeenCalled();
    });
  });
});
