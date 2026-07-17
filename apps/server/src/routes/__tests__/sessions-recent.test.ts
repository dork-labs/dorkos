/**
 * @vitest-environment node
 *
 * Integration tests for `GET /api/sessions/recent` (DOR-329): query validation
 * (limit 1-50, default 10) and the `{ sessions, agentActivity, warnings }`
 * response envelope. Agent paths are resolved from a stub mesh registry on
 * `app.locals.meshCore`; sessions come from a single `FakeAgentRuntime`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';

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
import { runtimeRegistry } from '../../services/core/runtime-registry.js';

const app = createApp();
finalizeApp(app);

function makeSession(id: string, updatedAt: string, cwd: string): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    permissionMode: 'default',
    runtime: 'fake-a',
    cwd,
  };
}

/** Stub the mesh registry the route reads off app.locals. */
function setAgentPaths(paths: string[]): void {
  app.locals.meshCore = {
    listWithPaths: () =>
      paths.map((projectPath) => ({ id: projectPath, name: 'agent', projectPath })),
  };
}

describe('GET /api/sessions/recent', () => {
  let runtime: FakeAgentRuntime;

  beforeEach(() => {
    const db = createTestDb();
    runtime = new FakeAgentRuntime('fake-a');
    runtimeRegistry.setDb(db);
    runtimeRegistry.register(runtime);
    runtimeRegistry.setDefault('fake-a');
    setAgentPaths([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete app.locals.meshCore;
  });

  it('returns the { sessions, agentActivity, warnings } envelope', async () => {
    setAgentPaths(['/p1']);
    runtime.listSessions.mockImplementation((dir: string) =>
      Promise.resolve(dir === '/p1' ? [makeSession('s1', '2026-03-01T00:00:00.000Z', '/p1')] : [])
    );

    const res = await request(app).get('/api/sessions/recent');

    expect(res.status).toBe(200);
    expect(res.body.sessions.map((s: Session) => s.id)).toEqual(['s1']);
    expect(res.body.agentActivity).toEqual({ '/p1': '2026-03-01T00:00:00.000Z' });
    expect(res.body.warnings).toEqual([]);
  });

  it('defaults limit to 10 when omitted', async () => {
    const paths = Array.from({ length: 15 }, (_, i) => `/p${String(i).padStart(2, '0')}`);
    setAgentPaths(paths);
    runtime.listSessions.mockImplementation((dir: string) =>
      Promise.resolve([makeSession(`s-${dir}`, `2026-03-${dir.slice(-2)}T00:00:00.000Z`, dir)])
    );

    const res = await request(app).get('/api/sessions/recent');

    expect(res.status).toBe(200);
    // 15 agents each with a session, trimmed to the default limit of 10.
    expect(res.body.sessions).toHaveLength(10);
    // agentActivity is complete (pre-trim) across all 15 agents.
    expect(Object.keys(res.body.agentActivity)).toHaveLength(15);
  });

  it('honors an explicit valid limit', async () => {
    const paths = Array.from({ length: 5 }, (_, i) => `/p${i}`);
    setAgentPaths(paths);
    runtime.listSessions.mockImplementation((dir: string) =>
      Promise.resolve([makeSession(`s-${dir}`, `2026-03-0${dir.slice(-1)}T00:00:00.000Z`, dir)])
    );

    const res = await request(app).get('/api/sessions/recent?limit=3');

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(3);
  });

  it('rejects a limit below 1', async () => {
    const res = await request(app).get('/api/sessions/recent?limit=0');
    expect(res.status).toBe(400);
  });

  it('rejects a limit above 50', async () => {
    const res = await request(app).get('/api/sessions/recent?limit=100');
    expect(res.status).toBe(400);
  });

  it('rejects a non-numeric limit', async () => {
    const res = await request(app).get('/api/sessions/recent?limit=abc');
    expect(res.status).toBe(400);
  });

  it('returns an empty envelope when no agents are registered', async () => {
    setAgentPaths([]);
    const res = await request(app).get('/api/sessions/recent');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessions: [], agentActivity: {}, warnings: [] });
  });
});
