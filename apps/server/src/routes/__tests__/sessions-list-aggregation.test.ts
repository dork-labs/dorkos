/**
 * @vitest-environment node
 *
 * Integration tests for multi-runtime session-list aggregation (ADR-0310,
 * spec task 1.3): `GET /api/sessions` fans out across every registered
 * runtime with graceful per-runtime degradation and responds with the
 * `{ sessions, warnings? }` envelope.
 *
 * Mocking strategy mirrors sessions-multi-runtime.test.ts: the runtime
 * registry and DB are REAL (singleton registry + in-memory SQLite), while
 * boundary/tunnel/config/manifest are mocked app-wide collaborators. Two
 * `FakeAgentRuntime` instances registered under distinct types stand in for
 * multiple backends, and a REAL `CodexRuntime` over a mocked
 * `@openai/codex-sdk` (task 2.6) plus a REAL `OpenCodeRuntime` over a mocked
 * sidecar provider (task 3.7) prove the real adapters merge, tag, filter,
 * and stream through the same aggregation + durable-events paths.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeAgentRuntime, collectDurableEvents } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import type { SessionSnapshot } from '@dorkos/shared/session-stream';

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

// The real CodexRuntime rides on a mocked SDK: every runStreamed() call gets a
// FRESH scripted `codex exec` turn (cumulative agent_message snapshots per the
// Codex item contract). Kept inline and untyped on purpose —
// codex/__tests__/codex-scenarios.ts is boundary-scoped to the codex adapter
// and must not be imported from route tests.
vi.mock('@openai/codex-sdk', () => {
  const turn = () => [
    { type: 'thread.started', thread_id: 'codex-thread-aggregation' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'msg-1', type: 'agent_message', text: '' } },
    { type: 'item.updated', item: { id: 'msg-1', type: 'agent_message', text: 'pong from' } },
    {
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'pong from codex' },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 10,
        cached_input_tokens: 0,
        output_tokens: 3,
        reasoning_output_tokens: 0,
      },
    },
  ];
  const makeThread = () => ({
    id: 'codex-thread-aggregation',
    run: vi.fn(),
    runStreamed: () =>
      Promise.resolve({
        events: (async function* () {
          for (const event of turn()) yield event;
        })(),
      }),
  });
  return {
    Codex: class {
      startThread = () => makeThread();
      resumeThread = () => makeThread();
    },
  };
});

import request from 'supertest';
import { createApp, finalizeApp } from '../../app.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, eq } from '@dorkos/db';
import type { Db } from '@dorkos/db';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { CodexRuntime } from '../../services/runtimes/codex/codex-runtime.js';
import { CodexThreadMap } from '../../services/runtimes/codex/thread-map.js';
import { DEFAULT_CWD } from '../../lib/resolve-root.js';
import { OpenCodeRuntime } from '../../services/runtimes/opencode/opencode-runtime.js';
import { peekProjector, disposeProjector } from '../../services/session/session-state-projector.js';

const app = createApp();
finalizeApp(app);

function makeSession(overrides: Partial<Session> & Pick<Session, 'id' | 'updatedAt'>): Session {
  return {
    title: `Session ${overrides.id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'fake',
    ...overrides,
  };
}

/** Valid UUIDs — POST /:id/messages validates the session-id format. */
const CODEX_SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const UNKNOWN_HINT_SESSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OPENCODE_SESSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

// ---------------------------------------------------------------------------
// Inline OpenCode sidecar fixtures (task 3.7). Kept inline and untyped on
// purpose — opencode/__tests__/opencode-sse-fixtures.ts is boundary-scoped to
// the opencode adapter and must not be imported from route tests (same rule
// as the Codex scenarios above).
// ---------------------------------------------------------------------------

/** OpenCode-native session id (`ses_*` — the adapter maps it to a DorkOS UUID). */
const OC_SESSION_ID = 'ses_aggregation01';
/**
 * The directory OpenCode STORES for the session. The adapter demuxes the
 * global stream on `session.get`'s directory — so this exact string must
 * appear on both the session payloads and every event envelope below.
 */
const OPENCODE_DIRECTORY = '/projects/opencode-aggregation';

/** The sidecar `Session` payload `session.create`/`session.get` return. */
const ocSessionInfo = () => ({
  id: OC_SESSION_ID,
  projectID: 'prj_0001',
  directory: OPENCODE_DIRECTORY,
  title: 'aggregation fixture',
  version: '1.17.13',
  time: { created: 1_720_000_000_000, updated: 1_720_000_000_000 },
});

/** A cumulative `text` part snapshot (`message.part.updated` payload). */
const ocTextPart = (text: string, end = false) => ({
  id: 'prt_1',
  sessionID: OC_SESSION_ID,
  messageID: 'msg_a1',
  type: 'text',
  text,
  time: { start: 1_720_000_000_000, ...(end ? { end: 1_720_000_009_000 } : {}) },
});

/** Wrap a wire event in the `/global/event` `{directory, payload}` envelope. */
const ocEnvelope = (payload: unknown) => ({ directory: OPENCODE_DIRECTORY, payload });

/**
 * One full scripted `/global/event` turn, exactly as the v1.17.13 sidecar
 * publishes it: connect marker → busy → empty text-start snapshot → true
 * increments as `message.part.delta` → full-text end snapshot → the
 * authoritative `session.idle` terminal.
 */
const opencodeTurn = () => [
  ocEnvelope({ type: 'server.connected', properties: {} }),
  ocEnvelope({
    type: 'session.status',
    properties: { sessionID: OC_SESSION_ID, status: { type: 'busy' } },
  }),
  ocEnvelope({ type: 'message.part.updated', properties: { part: ocTextPart('') } }),
  ocEnvelope({
    type: 'message.part.delta',
    properties: {
      sessionID: OC_SESSION_ID,
      messageID: 'msg_a1',
      partID: 'prt_1',
      field: 'text',
      delta: 'pong from ',
    },
  }),
  ocEnvelope({
    type: 'message.part.delta',
    properties: {
      sessionID: OC_SESSION_ID,
      messageID: 'msg_a1',
      partID: 'prt_1',
      field: 'text',
      delta: 'opencode',
    },
  }),
  ocEnvelope({
    type: 'message.part.updated',
    properties: { part: ocTextPart('pong from opencode', true) },
  }),
  ocEnvelope({ type: 'session.idle', properties: { sessionID: OC_SESSION_ID } }),
];

/**
 * The turn as `session.messages` reads it back from the sidecar's durable
 * store — OpenCode snapshots serve completed history from THIS native source
 * (with an EventLog fallback), unlike the stateless Codex adapter.
 */
const opencodeHistory = () => [
  {
    info: {
      id: 'msg_u1',
      sessionID: OC_SESSION_ID,
      role: 'user',
      time: { created: 1_720_000_000_000 },
      agent: 'build',
      model: { providerID: 'ollama', modelID: 'llama3.3:70b' },
    },
    parts: [
      {
        id: 'prt_u1',
        sessionID: OC_SESSION_ID,
        messageID: 'msg_u1',
        type: 'text',
        text: 'Hello opencode',
      },
    ],
  },
  {
    info: {
      id: 'msg_a1',
      sessionID: OC_SESSION_ID,
      role: 'assistant',
      time: { created: 1_720_000_000_000, completed: 1_720_000_009_000 },
      parentID: 'msg_u1',
      modelID: 'llama3.3:70b',
      providerID: 'ollama',
      mode: 'build',
      path: { cwd: OPENCODE_DIRECTORY, root: OPENCODE_DIRECTORY },
      cost: 0,
      tokens: { input: 10, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [ocTextPart('pong from opencode', true)],
  },
];

/**
 * A warm mocked sidecar: every `global.event` call yields a FRESH pre-queued
 * scripted turn, and the stream parks after the script until the hub aborts
 * it — a finished script must read as quiet, never as a sidecar drop.
 */
function makeOpenCodeSidecar() {
  const client = {
    global: {
      event: vi.fn(async (options?: { signal?: AbortSignal }) => ({
        stream: (async function* () {
          for (const event of opencodeTurn()) yield event;
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) return resolve();
            options?.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        })(),
      })),
    },
    session: {
      create: vi.fn(async () => ({ data: ocSessionInfo() })),
      get: vi.fn(async () => ({ data: ocSessionInfo() })),
      list: vi.fn(async () => ({ data: [] as unknown[] })),
      messages: vi.fn(async () => ({ data: opencodeHistory() })),
      promptAsync: vi.fn(async () => ({})),
      abort: vi.fn(async () => ({ data: true })),
      todo: vi.fn(async () => ({ data: [] as unknown[] })),
    },
  };
  const provider = {
    // Widened to unknown so cold-sidecar tests can mock null/rejection returns.
    getClient: vi.fn(async (): Promise<unknown> => client),
    peekClient: vi.fn((): unknown => client),
  };
  return { client, provider };
}

/** Construct a real OpenCodeRuntime over a mocked sidecar provider. */
function makeOpenCodeRuntime(sidecar: ReturnType<typeof makeOpenCodeSidecar>): OpenCodeRuntime {
  return new OpenCodeRuntime({
    provider: sidecar.provider as unknown as ConstructorParameters<
      typeof OpenCodeRuntime
    >[0]['provider'],
  });
}

describe('GET /api/sessions — multi-runtime aggregation (real registry + real DB)', () => {
  let db: Db;
  let runtimeA: FakeAgentRuntime;
  let runtimeB: FakeAgentRuntime;
  let codex: CodexRuntime;
  let opencodeSidecar: ReturnType<typeof makeOpenCodeSidecar>;
  let opencode: OpenCodeRuntime;

  beforeEach(() => {
    db = createTestDb();
    runtimeA = new FakeAgentRuntime('fake-a');
    runtimeB = new FakeAgentRuntime('fake-b');
    codex = new CodexRuntime({ threadMap: new CodexThreadMap(db), binaryPath: null });
    opencodeSidecar = makeOpenCodeSidecar();
    opencode = makeOpenCodeRuntime(opencodeSidecar);
    runtimeRegistry.setDb(db);
    runtimeRegistry.register(runtimeA);
    runtimeRegistry.register(runtimeB);
    runtimeRegistry.register(codex);
    runtimeRegistry.register(opencode);
    runtimeRegistry.setDefault('fake-a');
  });

  afterEach(() => {
    // The projector registry is a process singleton; triggered Codex/OpenCode
    // turns leave per-session projector state that must not leak across tests.
    disposeProjector(CODEX_SESSION);
    disposeProjector(UNKNOWN_HINT_SESSION);
    disposeProjector(OPENCODE_SESSION);
  });

  it('merges sessions from both runtimes, sorted by updatedAt desc, each tagged with its runtime', async () => {
    runtimeA.listSessions.mockResolvedValue([
      makeSession({ id: 'a-old', updatedAt: '2026-01-01T00:00:00.000Z', runtime: 'fake-a' }),
      makeSession({ id: 'a-new', updatedAt: '2026-03-01T00:00:00.000Z', runtime: 'fake-a' }),
    ]);
    runtimeB.listSessions.mockResolvedValue([
      makeSession({ id: 'b-mid', updatedAt: '2026-02-01T00:00:00.000Z', runtime: 'fake-b' }),
    ]);

    const res = await request(app).get('/api/sessions');

    expect(res.status).toBe(200);
    expect(res.body.sessions.map((s: Session) => s.id)).toEqual(['a-new', 'b-mid', 'a-old']);
    expect(res.body.sessions.map((s: Session) => s.runtime)).toEqual([
      'fake-a',
      'fake-b',
      'fake-a',
    ]);
    // All runtimes healthy → warnings omitted from the envelope entirely.
    expect(res.body).not.toHaveProperty('warnings');
  });

  it('degrades gracefully: a rejecting runtime yields partial results + a warnings[] entry, never a 500', async () => {
    runtimeA.listSessions.mockResolvedValue([
      makeSession({ id: 'a-1', updatedAt: '2026-01-01T00:00:00.000Z', runtime: 'fake-a' }),
    ]);
    runtimeB.listSessions.mockRejectedValue(new Error('cold backend'));

    const res = await request(app).get('/api/sessions');

    expect(res.status).toBe(200);
    expect(res.body.sessions.map((s: Session) => s.id)).toEqual(['a-1']);
    expect(res.body.warnings).toEqual([{ runtime: 'fake-b', message: 'cold backend' }]);
  });

  it('?runtime= filters the fan-out to the named runtime only', async () => {
    runtimeA.listSessions.mockResolvedValue([
      makeSession({ id: 'a-1', updatedAt: '2026-01-01T00:00:00.000Z', runtime: 'fake-a' }),
    ]);
    runtimeB.listSessions.mockResolvedValue([
      makeSession({ id: 'b-1', updatedAt: '2026-02-01T00:00:00.000Z', runtime: 'fake-b' }),
    ]);

    const res = await request(app).get('/api/sessions').query({ runtime: 'fake-a' });

    expect(res.status).toBe(200);
    expect(res.body.sessions.map((s: Session) => s.id)).toEqual(['a-1']);
    // The filter narrows the fan-out itself — the excluded runtime is not called.
    expect(runtimeB.listSessions).not.toHaveBeenCalled();
  });

  it('rejects an unregistered ?runtime= with 400 UNKNOWN_RUNTIME', async () => {
    const codexListSpy = vi.spyOn(codex, 'listSessions');

    const res = await request(app).get('/api/sessions').query({ runtime: 'nonexistent' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_RUNTIME');
    expect(runtimeA.listSessions).not.toHaveBeenCalled();
    expect(runtimeB.listSessions).not.toHaveBeenCalled();
    // The rejection happens before the fan-out — the real adapter included.
    expect(codexListSpy).not.toHaveBeenCalled();
  });

  it('applies ?limit= to the MERGED list, not per runtime', async () => {
    runtimeA.listSessions.mockResolvedValue([
      makeSession({ id: 'a-1', updatedAt: '2026-03-01T00:00:00.000Z', runtime: 'fake-a' }),
      makeSession({ id: 'a-2', updatedAt: '2026-01-01T00:00:00.000Z', runtime: 'fake-a' }),
    ]);
    runtimeB.listSessions.mockResolvedValue([
      makeSession({ id: 'b-1', updatedAt: '2026-02-01T00:00:00.000Z', runtime: 'fake-b' }),
    ]);

    const res = await request(app).get('/api/sessions').query({ limit: 2 });

    expect(res.status).toBe(200);
    // Top 2 of the merged+sorted list — one from each runtime.
    expect(res.body.sessions.map((s: Session) => s.id)).toEqual(['a-1', 'b-1']);
  });

  it('applies the persisted-settings overlay (ADR-0260) to the merged list', async () => {
    runtimeA.listSessions.mockResolvedValue([
      makeSession({
        id: 'a-1',
        updatedAt: '2026-01-01T00:00:00.000Z',
        runtime: 'fake-a',
        permissionMode: 'default',
      }),
    ]);
    runtimeB.listSessions.mockResolvedValue([]);
    await db.insert(sessionMetadata).values({
      sessionId: 'a-1',
      runtime: 'fake-a',
      agentPath: null,
      createdAt: new Date().toISOString(),
      permissionMode: 'bypassPermissions',
    });

    const res = await request(app).get('/api/sessions');

    expect(res.status).toBe(200);
    expect(res.body.sessions[0].permissionMode).toBe('bypassPermissions');
  });

  it('is a no-op refactor with a single effective runtime (spec acceptance)', async () => {
    // The singleton registry has no unregister, so a literal one-runtime
    // process is exercised by the mocked-registry unit test in sessions.test.ts
    // ("aggregation of one is a no-op"). Here the equivalent behavior: when
    // only one runtime has sessions, the response is exactly that runtime's
    // sessions with no warnings key.
    runtimeA.listSessions.mockResolvedValue([
      makeSession({ id: 'a-1', updatedAt: '2026-01-01T00:00:00.000Z', runtime: 'fake-a' }),
    ]);
    runtimeB.listSessions.mockResolvedValue([]);

    const res = await request(app).get('/api/sessions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sessions: [expect.objectContaining({ id: 'a-1', runtime: 'fake-a' })],
    });
  });

  // ---------------------------------------------------------------------------
  // Real CodexRuntime over a mocked SDK (task 2.6): the actual adapter — not a
  // FakeAgentRuntime — merges, tags, filters, and streams through the same
  // aggregation and durable-events paths every runtime uses.
  // ---------------------------------------------------------------------------

  describe('real CodexRuntime (mocked SDK) — merge, tag, filter, stream', () => {
    it('merges tracked Codex sessions into the aggregated list, tagged runtime:"codex"', async () => {
      runtimeA.listSessions.mockResolvedValue([
        makeSession({ id: 'a-1', updatedAt: '2026-01-01T00:00:00.000Z', runtime: 'fake-a' }),
      ]);
      runtimeB.listSessions.mockResolvedValue([]);
      // GET /api/sessions with no ?cwd lists the default root; a cwd-less session
      // belongs to NO project list (ADR 260707-193314), so attribute it there.
      codex.ensureSession(CODEX_SESSION, { permissionMode: 'default', cwd: DEFAULT_CWD });

      const res = await request(app).get('/api/sessions');

      expect(res.status).toBe(200);
      // The registry stamps "now" on tracked sessions — later than the fixed
      // fake dates, so the Codex session sorts first in the merged list.
      expect(res.body.sessions.map((s: Session) => s.id)).toEqual([CODEX_SESSION, 'a-1']);
      expect(res.body.sessions[0].runtime).toBe('codex');
      expect(res.body).not.toHaveProperty('warnings');
    });

    it('keeps Codex sessions when another runtime fails (per-runtime degradation intact)', async () => {
      runtimeA.listSessions.mockResolvedValue([]);
      runtimeB.listSessions.mockRejectedValue(new Error('cold backend'));
      codex.ensureSession(CODEX_SESSION, { permissionMode: 'default', cwd: DEFAULT_CWD });

      const res = await request(app).get('/api/sessions');

      expect(res.status).toBe(200);
      expect(res.body.sessions.map((s: Session) => s.id)).toEqual([CODEX_SESSION]);
      expect(res.body.warnings).toEqual([{ runtime: 'fake-b', message: 'cold backend' }]);
    });

    it('?runtime=codex narrows the fan-out to the real adapter only', async () => {
      runtimeA.listSessions.mockResolvedValue([
        makeSession({ id: 'a-1', updatedAt: '2026-01-01T00:00:00.000Z', runtime: 'fake-a' }),
      ]);
      runtimeB.listSessions.mockResolvedValue([]);
      codex.ensureSession(CODEX_SESSION, { permissionMode: 'default', cwd: DEFAULT_CWD });

      const res = await request(app).get('/api/sessions').query({ runtime: 'codex' });

      expect(res.status).toBe(200);
      expect(res.body.sessions.map((s: Session) => s.id)).toEqual([CODEX_SESSION]);
      expect(runtimeA.listSessions).not.toHaveBeenCalled();
      expect(runtimeB.listSessions).not.toHaveBeenCalled();
    });

    it('POST /:id/messages accepts the runtime:"codex" hint (202 + persisted row); an unknown hint still 400s', async () => {
      const accepted = await request(app)
        .post(`/api/sessions/${CODEX_SESSION}/messages`)
        .send({ content: 'ping', runtime: 'codex' });

      expect(accepted.status).toBe(202);
      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, CODEX_SESSION))
        .get();
      expect(row?.runtime).toBe('codex');

      // Let the detached mocked turn settle before teardown disposes the projector.
      await vi.waitFor(() => {
        expect(peekProjector(CODEX_SESSION)?.getStatus().lifecycle).toBe('idle');
      });

      const rejected = await request(app)
        .post(`/api/sessions/${UNKNOWN_HINT_SESSION}/messages`)
        .send({ content: 'ping', runtime: 'nonexistent-runtime' });

      expect(rejected.status).toBe(400);
      expect(rejected.body.code).toBe('UNKNOWN_RUNTIME');
    });

    it('delivers a mocked Codex turn over the durable /events path (snapshot + replay)', async () => {
      // Trigger-only POST (ADR-0264): 202 with the canonical id; the turn runs
      // detached, feeding the runtime's mapped StreamEvents into the projector.
      const res = await request(app)
        .post(`/api/sessions/${CODEX_SESSION}/messages`)
        .send({ content: 'Hello codex', runtime: 'codex' });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ sessionId: CODEX_SESSION });

      await vi.waitFor(() => {
        expect(peekProjector(CODEX_SESSION)?.getStatus().lifecycle).toBe('idle');
      });

      // Cold connect: the snapshot carries the EventLog-reconstructed history —
      // the assistant text assembled from the adapter's cumulative-delta mapping.
      const cold = await collectDurableEvents(app, CODEX_SESSION, {
        until: (frames) => frames.some((f) => f.event === 'snapshot'),
      });
      const snapshot = cold.frames.find((f) => f.event === 'snapshot')!.data as SessionSnapshot;
      expect(snapshot.messages).toEqual([
        expect.objectContaining({ role: 'user', content: 'Hello codex' }),
        expect.objectContaining({ role: 'assistant', content: 'pong from codex' }),
      ]);
      expect(snapshot.inProgressTurn).toBeNull();
      expect(snapshot.status.lifecycle).toBe('idle');
      expect(snapshot.cursor).toBeGreaterThan(0);

      // Resume connect: ?after=0 replays the whole log — no snapshot frame; the
      // Codex turn produced at least one text_delta and terminated with turn_end.
      const replayed = await collectDurableEvents(app, CODEX_SESSION, {
        until: (frames) => frames.some((f) => f.event === 'turn_end'),
        after: 0,
      });
      expect(replayed.frames.some((f) => f.event === 'snapshot')).toBe(false);
      expect(replayed.frames.filter((f) => f.event === 'text_delta').length).toBeGreaterThan(0);
      expect(replayed.frames.at(-1)!.event).toBe('turn_end');
    });
  });

  // ---------------------------------------------------------------------------
  // Real OpenCodeRuntime over a mocked sidecar provider (task 3.7): the actual
  // adapter merges, tags, degrades, and streams through the same aggregation
  // and durable-events paths — the `opencode` binary is never required.
  // ---------------------------------------------------------------------------

  describe('real OpenCodeRuntime (mocked sidecar) — merge, tag, degrade, stream', () => {
    it('merges tracked OpenCode sessions into the aggregated list, tagged runtime:"opencode"', async () => {
      runtimeA.listSessions.mockResolvedValue([
        makeSession({ id: 'a-1', updatedAt: '2026-01-01T00:00:00.000Z', runtime: 'fake-a' }),
      ]);
      runtimeB.listSessions.mockResolvedValue([]);
      // Attribute to the default root — the dir a no-?cwd GET lists (ADR 260707-193314).
      opencode.ensureSession(OPENCODE_SESSION, { permissionMode: 'default', cwd: DEFAULT_CWD });

      const res = await request(app).get('/api/sessions');

      expect(res.status).toBe(200);
      // The registry stamps "now" on tracked sessions — later than the fixed
      // fake dates, so the OpenCode session sorts first in the merged list.
      expect(res.body.sessions.map((s: Session) => s.id)).toEqual([OPENCODE_SESSION, 'a-1']);
      expect(res.body.sessions[0].runtime).toBe('opencode');
      expect(res.body).not.toHaveProperty('warnings');
    });

    it('a failing sidecar degrades to partial results + an opencode warnings entry, never a 500', async () => {
      runtimeA.listSessions.mockResolvedValue([
        makeSession({ id: 'a-1', updatedAt: '2026-01-01T00:00:00.000Z', runtime: 'fake-a' }),
      ]);
      runtimeB.listSessions.mockResolvedValue([]);
      // Warm sidecar whose listing errors — the mapper's unwrap throws, and
      // aggregation degrades it to a per-runtime warning (ADR-0310).
      opencodeSidecar.client.session.list.mockResolvedValue({
        error: { message: 'sidecar exploded' },
      } as never);

      const res = await request(app).get('/api/sessions');

      expect(res.status).toBe(200);
      expect(res.body.sessions.map((s: Session) => s.id)).toEqual(['a-1']);
      expect(res.body.warnings).toEqual([
        { runtime: 'opencode', message: expect.stringContaining('session.list failed') },
      ]);
    });

    it('a cold sidecar yields fast partial results without booting it (spec §Performance)', async () => {
      // Cold: no sidecar process is up. peekClient() reports null and listing
      // must NEVER call getClient() — booting a sidecar (15s startup budget)
      // inside the listing fan-out would block the aggregated response.
      const cold = makeOpenCodeSidecar();
      cold.provider.peekClient.mockReturnValue(null);
      cold.provider.getClient.mockRejectedValue(new Error('listing must never boot the sidecar'));
      const coldRuntime = makeOpenCodeRuntime(cold);
      runtimeRegistry.register(coldRuntime); // replaces the warm registration
      coldRuntime.ensureSession(OPENCODE_SESSION, { permissionMode: 'default', cwd: DEFAULT_CWD });
      // ensureSession's eager fire-and-forget bind legitimately touches
      // getClient (and fails, non-fatally). The invariant under test is that
      // LISTING never does — let the bind settle, then watch listing alone.
      await vi.waitFor(() => expect(cold.provider.getClient).toHaveBeenCalled());
      cold.provider.getClient.mockClear();
      runtimeA.listSessions.mockResolvedValue([
        makeSession({ id: 'a-1', updatedAt: '2026-01-01T00:00:00.000Z', runtime: 'fake-a' }),
      ]);
      runtimeB.listSessions.mockResolvedValue([]);

      const res = await request(app).get('/api/sessions');

      expect(res.status).toBe(200);
      // Partial-but-fast: the DorkOS-tracked inventory still lists (cold is a
      // deliberate fast-[] path, not a failure — no warnings entry).
      expect(res.body.sessions.map((s: Session) => s.id)).toEqual([OPENCODE_SESSION, 'a-1']);
      expect(res.body).not.toHaveProperty('warnings');
      expect(cold.provider.getClient).not.toHaveBeenCalled();
    });

    it('delivers a mocked OpenCode turn over the durable /events path (snapshot + replay)', async () => {
      // Trigger-only POST (ADR-0264): 202 with the canonical id; the turn runs
      // detached, feeding the adapter's mapped StreamEvents into the projector.
      const res = await request(app)
        .post(`/api/sessions/${OPENCODE_SESSION}/messages`)
        .send({ content: 'Hello opencode', runtime: 'opencode' });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ sessionId: OPENCODE_SESSION });

      await vi.waitFor(() => {
        expect(peekProjector(OPENCODE_SESSION)?.getStatus().lifecycle).toBe('idle');
      });

      // Cold connect: unlike stateless Codex, OpenCode snapshots serve
      // completed messages from the sidecar's durable store (session.messages
      // through the mapper).
      const cold = await collectDurableEvents(app, OPENCODE_SESSION, {
        until: (frames) => frames.some((f) => f.event === 'snapshot'),
      });
      const snapshot = cold.frames.find((f) => f.event === 'snapshot')!.data as SessionSnapshot;
      expect(snapshot.messages).toEqual([
        expect.objectContaining({ role: 'user', content: 'Hello opencode' }),
        expect.objectContaining({ role: 'assistant', content: 'pong from opencode' }),
      ]);
      expect(snapshot.inProgressTurn).toBeNull();
      expect(snapshot.status.lifecycle).toBe('idle');
      expect(snapshot.cursor).toBeGreaterThan(0);

      // Resume connect: ?after=0 replays the whole log — no snapshot frame;
      // the OpenCode turn streamed deltas and terminated with turn_end.
      const replayed = await collectDurableEvents(app, OPENCODE_SESSION, {
        until: (frames) => frames.some((f) => f.event === 'turn_end'),
        after: 0,
      });
      expect(replayed.frames.some((f) => f.event === 'snapshot')).toBe(false);
      expect(replayed.frames.filter((f) => f.event === 'text_delta').length).toBeGreaterThan(0);
      expect(replayed.frames.at(-1)!.event).toBe('turn_end');
    });
  });
});
