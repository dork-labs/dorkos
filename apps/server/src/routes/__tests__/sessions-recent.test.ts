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
  // Two more runtimes, registered for EVERY test rather than inside the one
  // that needs them: the registry is process-global with no unregister, so a
  // test-local registration would leak into whatever ran next.
  let quiet: FakeAgentRuntime;
  let broken: FakeAgentRuntime;

  beforeEach(() => {
    const db = createTestDb();
    runtime = new FakeAgentRuntime('fake-a');
    quiet = new FakeAgentRuntime('fake-b');
    broken = new FakeAgentRuntime('fake-c');
    runtimeRegistry.setDb(db);
    runtimeRegistry.register(runtime);
    runtimeRegistry.register(quiet);
    runtimeRegistry.register(broken);
    runtimeRegistry.setDefault('fake-a');
    // Silent unless a test says otherwise, so they contribute no rows and no
    // warnings to the cases that are not about them.
    quiet.listSessions.mockResolvedValue([]);
    broken.listSessions.mockResolvedValue([]);
    setAgentPaths([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete app.locals.meshCore;
    delete app.locals.resolveTaskOrigins;
    delete app.locals.resolveRoomOrigins;
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

  it('applies the Pulse task-origin overlay (session-origin-legibility)', async () => {
    setAgentPaths(['/p1']);
    // Classified user by the head-scan (e.g. a direct-branch Pulse run whose
    // marker never made it into JSONL) — the Pulse-run overlay is the only
    // thing that can catch and re-tag this session as `task`.
    runtime.listSessions.mockImplementation((dir: string) =>
      Promise.resolve(dir === '/p1' ? [makeSession('s1', '2026-03-01T00:00:00.000Z', '/p1')] : [])
    );
    app.locals.resolveTaskOrigins = (sessionIds: string[]) =>
      sessionIds.includes('s1') ? new Map([['s1', { taskName: 'daily-digest' }]]) : new Map();

    const res = await request(app).get('/api/sessions/recent');

    expect(res.status).toBe(200);
    const session = res.body.sessions.find((s: Session) => s.id === 's1');
    expect(session.origin).toBe('task');
    expect(session.originLabel).toBe('Scheduled task · daily-digest');
  });

  // The other overlay, and the one nothing else can do: a room turn leaves no
  // marker in its transcript, so without this the recents list draws the room
  // AND the run underneath it as two rows for one conversation.
  it('tags a room-bound session `room` and names the room it answers in', async () => {
    setAgentPaths(['/p1']);
    runtime.listSessions.mockImplementation((dir: string) =>
      Promise.resolve(
        dir === '/p1'
          ? [
              makeSession('s1', '2026-03-01T00:00:00.000Z', '/p1'),
              makeSession('s2', '2026-03-02T00:00:00.000Z', '/p1'),
            ]
          : []
      )
    );
    app.locals.resolveRoomOrigins = (sessionIds: string[]) =>
      sessionIds.includes('s1')
        ? new Map([['s1', { roomLabel: '#general', roomId: 'room-1' }]])
        : new Map();

    const res = await request(app).get('/api/sessions/recent');

    expect(res.status).toBe(200);
    const bound = res.body.sessions.find((s: Session) => s.id === 's1');
    expect(bound.origin).toBe('room');
    expect(bound.originLabel).toBe('#general');
    // …and the session no room is answering with is untouched, which is what
    // keeps ordinary conversations in the list.
    const loose = res.body.sessions.find((s: Session) => s.id === 's2');
    expect(loose.origin).toBeUndefined();
  });

  // BC-16's server half. The point of the field is that it survives the whole
  // aggregation path — merge, sort, trim, three overlays, JSON serialization —
  // as a real instant from ONE runtime and as nothing at all from another, in
  // the same response, while a third runtime is down.
  it('carries lastUserMessageAt from the runtime that can say, omits it for the one that cannot, and still degrades', async () => {
    setAgentPaths(['/p1']);

    // The person wrote at 09:00; the agent kept working until 11:00, which is
    // what `updatedAt` records. A relabelled `updatedAt` fails this.
    runtime.listSessions.mockResolvedValue([
      {
        ...makeSession('s-knows', '2026-03-01T11:00:00.000Z', '/p1'),
        lastUserMessageAt: '2026-03-01T09:00:00.000Z',
      },
    ]);
    quiet.listSessions.mockResolvedValue([
      { ...makeSession('s-quiet', '2026-03-01T10:00:00.000Z', '/p1'), runtime: 'fake-b' },
    ]);
    broken.listSessions.mockRejectedValue(new Error('backend down'));

    const res = await request(app).get('/api/sessions/recent');

    expect(res.status).toBe(200);
    const knows = res.body.sessions.find((s: Session) => s.id === 's-knows');
    expect(knows.lastUserMessageAt).toBe('2026-03-01T09:00:00.000Z');
    expect(Date.parse(knows.lastUserMessageAt)).toBeLessThan(Date.parse(knows.updatedAt));

    // Omission, never a guess: the key is absent from the JSON body entirely —
    // not null, not an empty string, not this row's updatedAt.
    const quietRow = res.body.sessions.find((s: Session) => s.id === 's-quiet');
    expect(quietRow).toBeDefined();
    expect('lastUserMessageAt' in quietRow).toBe(false);

    // …and the runtime that could not answer at all is still reported as
    // degraded rather than silently shrinking the list (ADR-0310).
    expect(res.body.warnings.map((w: { runtime: string }) => w.runtime)).toContain('fake-c');
  });

  it('lets a scheduled task that posts into a room still read as the task', async () => {
    setAgentPaths(['/p1']);
    runtime.listSessions.mockImplementation((dir: string) =>
      Promise.resolve(dir === '/p1' ? [makeSession('s1', '2026-03-01T00:00:00.000Z', '/p1')] : [])
    );
    app.locals.resolveRoomOrigins = () =>
      new Map([['s1', { roomLabel: '#general', roomId: 'room-1' }]]);
    app.locals.resolveTaskOrigins = () => new Map([['s1', { taskName: 'daily-digest' }]]);

    const res = await request(app).get('/api/sessions/recent');

    expect(res.body.sessions[0].origin).toBe('task');
    expect(res.body.sessions[0].originLabel).toBe('Scheduled task · daily-digest');
  });
});
