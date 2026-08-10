/**
 * @vitest-environment node
 *
 * Integration tests for `GET /api/sessions/daily-counts` (DOR-1039): query
 * validation (days 1-31, default 7) and the `{ days, dailyCounts, warnings }`
 * envelope. Agent paths are resolved from a stub mesh registry on
 * `app.locals.meshCore`; sessions come from `FakeAgentRuntime`s.
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

/** Local-midnight-ish ISO timestamp `daysAgo` days before now. */
function daysBefore(daysAgo: number): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12).toISOString();
}

function makeSession(id: string, createdAt: string, cwd: string): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt,
    updatedAt: createdAt,
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

describe('GET /api/sessions/daily-counts', () => {
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

  it('counts sessions across every agent, seven days by default', async () => {
    setAgentPaths(['/p1', '/p2']);
    runtime.listSessions.mockImplementation((dir: string) =>
      Promise.resolve(
        dir === '/p1'
          ? [makeSession('a1', daysBefore(0), '/p1'), makeSession('a2', daysBefore(6), '/p1')]
          : [makeSession('b1', daysBefore(0), '/p2')]
      )
    );

    const res = await request(app).get('/api/sessions/daily-counts');

    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    expect(res.body.dailyCounts).toEqual([1, 0, 0, 0, 0, 0, 2]);
    expect(res.body.warnings).toEqual([]);
  });

  it('answers zeros when no agent is registered', async () => {
    const res = await request(app).get('/api/sessions/daily-counts');

    expect(res.status).toBe(200);
    expect(res.body.dailyCounts).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('honours an explicit days window', async () => {
    setAgentPaths(['/p1']);
    runtime.listSessions.mockResolvedValue([makeSession('a1', daysBefore(0), '/p1')]);

    const res = await request(app).get('/api/sessions/daily-counts?days=3');

    expect(res.status).toBe(200);
    expect(res.body.days).toBe(3);
    expect(res.body.dailyCounts).toEqual([0, 0, 1]);
  });

  it('rejects an out-of-range or non-numeric days', async () => {
    for (const days of ['0', '32', 'abc']) {
      const res = await request(app).get(`/api/sessions/daily-counts?days=${days}`);
      expect(res.status).toBe(400);
    }
  });

  it('degrades per runtime instead of failing the request', async () => {
    setAgentPaths(['/p1']);
    runtime.listSessions.mockResolvedValue([makeSession('a1', daysBefore(1), '/p1')]);
    const down = new FakeAgentRuntime('fake-down');
    down.listSessions.mockRejectedValue(new Error('sidecar not running'));
    runtimeRegistry.register(down);

    const res = await request(app).get('/api/sessions/daily-counts');

    expect(res.status).toBe(200);
    expect(res.body.dailyCounts[5]).toBe(1);
    expect(res.body.warnings).toEqual([{ runtime: 'fake-down', message: 'sidecar not running' }]);
  });
});
