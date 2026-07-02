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
 * multiple backends.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';

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
import { sessionMetadata } from '@dorkos/db';
import type { Db } from '@dorkos/db';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';

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

describe('GET /api/sessions — multi-runtime aggregation (real registry + real DB)', () => {
  let db: Db;
  let runtimeA: FakeAgentRuntime;
  let runtimeB: FakeAgentRuntime;

  beforeEach(() => {
    db = createTestDb();
    runtimeA = new FakeAgentRuntime('fake-a');
    runtimeB = new FakeAgentRuntime('fake-b');
    runtimeRegistry.setDb(db);
    runtimeRegistry.register(runtimeA);
    runtimeRegistry.register(runtimeB);
    runtimeRegistry.setDefault('fake-a');
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
    const res = await request(app).get('/api/sessions').query({ runtime: 'nonexistent' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_RUNTIME');
    expect(runtimeA.listSessions).not.toHaveBeenCalled();
    expect(runtimeB.listSessions).not.toHaveBeenCalled();
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
});
