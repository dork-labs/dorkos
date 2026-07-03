/**
 * @vitest-environment node
 *
 * Integration tests for multi-runtime session-list aggregation (ADR-0308,
 * spec task 1.3): `GET /api/sessions` fans out across every registered
 * runtime with graceful per-runtime degradation and responds with the
 * `{ sessions, warnings? }` envelope.
 *
 * Mocking strategy mirrors sessions-multi-runtime.test.ts: the runtime
 * registry and DB are REAL (singleton registry + in-memory SQLite), while
 * boundary/tunnel/config/manifest are mocked app-wide collaborators. Two
 * `FakeAgentRuntime` instances registered under distinct types stand in for
 * multiple backends, and a REAL `CodexRuntime` over a mocked
 * `@openai/codex-sdk` (task 2.6) proves the real adapter merges, tags,
 * filters, and streams through the same aggregation + durable-events paths.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
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

import http from 'node:http';
import request from 'supertest';
import { createApp, finalizeApp } from '../../app.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, eq } from '@dorkos/db';
import type { Db } from '@dorkos/db';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { CodexRuntime } from '../../services/runtimes/codex/codex-runtime.js';
import { CodexThreadMap } from '../../services/runtimes/codex/thread-map.js';
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

/** A single SSE frame parsed off the durable `/events` wire. */
interface SseFrame {
  event: string;
  data: unknown;
}

/** Parse SSE wire text into `event:`/`data:` frames. */
function parseFrames(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  let event = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) {
      event = line.slice(7).trim();
    } else if (line.startsWith('data: ') && event) {
      frames.push({ event, data: JSON.parse(line.slice(6)) });
      event = '';
    }
  }
  return frames;
}

/**
 * Open `GET /api/sessions/:id/events` (durable — it never ends on its own)
 * against a real listening server, collect frames until `isDone(frames)` is
 * satisfied, then destroy the connection. Mirrors sessions-multi-runtime's
 * helper: the `collectSseEvents` test-util predates trigger-only messaging
 * (ADR-0264) — it parses SSE off the POST response, which is now a 202 JSON
 * body, so turn delivery must be observed on the durable `/events` stream.
 */
function collectEventsUntil(
  sessionId: string,
  isDone: (frames: SseFrame[]) => boolean,
  opts: { after?: number } = {}
): Promise<SseFrame[]> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const query = opts.after !== undefined ? `?after=${opts.after}` : '';
      let settled = false;
      const req = http.get(
        { host: '127.0.0.1', port, path: `/api/sessions/${sessionId}/events${query}` },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          const finish = (): void => {
            if (settled) return;
            settled = true;
            req.destroy();
            server.close();
            resolve(parseFrames(raw));
          };
          res.on('data', (chunk: string) => {
            raw += chunk;
            if (isDone(parseFrames(raw))) finish();
          });
          res.on('end', finish);
        }
      );
      req.on('error', (err) => {
        if (settled) return;
        settled = true;
        server.close();
        reject(err);
      });
    });
  });
}

describe('GET /api/sessions — multi-runtime aggregation (real registry + real DB)', () => {
  let db: Db;
  let runtimeA: FakeAgentRuntime;
  let runtimeB: FakeAgentRuntime;
  let codex: CodexRuntime;

  beforeEach(() => {
    db = createTestDb();
    runtimeA = new FakeAgentRuntime('fake-a');
    runtimeB = new FakeAgentRuntime('fake-b');
    codex = new CodexRuntime({ threadMap: new CodexThreadMap(db), binaryPath: null });
    runtimeRegistry.setDb(db);
    runtimeRegistry.register(runtimeA);
    runtimeRegistry.register(runtimeB);
    runtimeRegistry.register(codex);
    runtimeRegistry.setDefault('fake-a');
  });

  afterEach(() => {
    // The projector registry is a process singleton; triggered Codex turns
    // leave per-session projector state that must not leak across tests.
    disposeProjector(CODEX_SESSION);
    disposeProjector(UNKNOWN_HINT_SESSION);
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
      codex.ensureSession(CODEX_SESSION, { permissionMode: 'default' });

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
      codex.ensureSession(CODEX_SESSION, { permissionMode: 'default' });

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
      codex.ensureSession(CODEX_SESSION, { permissionMode: 'default' });

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
      const cold = await collectEventsUntil(CODEX_SESSION, (frames) =>
        frames.some((f) => f.event === 'snapshot')
      );
      const snapshot = cold.find((f) => f.event === 'snapshot')!.data as SessionSnapshot;
      expect(snapshot.messages).toEqual([
        expect.objectContaining({ role: 'user', content: 'Hello codex' }),
        expect.objectContaining({ role: 'assistant', content: 'pong from codex' }),
      ]);
      expect(snapshot.inProgressTurn).toBeNull();
      expect(snapshot.status.lifecycle).toBe('idle');
      expect(snapshot.cursor).toBeGreaterThan(0);

      // Resume connect: ?after=0 replays the whole log — no snapshot frame; the
      // Codex turn produced at least one text_delta and terminated with turn_end.
      const replayed = await collectEventsUntil(
        CODEX_SESSION,
        (frames) => frames.some((f) => f.event === 'turn_end'),
        { after: 0 }
      );
      expect(replayed.some((f) => f.event === 'snapshot')).toBe(false);
      expect(replayed.filter((f) => f.event === 'text_delta').length).toBeGreaterThan(0);
      expect(replayed.at(-1)!.event).toBe('turn_end');
    });
  });
});
