import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
/**
 * Who may read a session over HTTP (spec `audit-trail` §3.4, PR4 leak fixes).
 *
 * An agent caller (anything presenting `X-DorkOS-Agent`) reads agent work
 * sessions and never a person's own chat; a private session reads as 404, not
 * 403, so its existence is not confirmed. The owner (no agent header) reads
 * everything, exactly as before.
 */
import http from 'node:http';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';

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
    getNativeSessionCwd: vi.fn(() => null),
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    listRuntimes: vi.fn(() => [fakeRuntime]),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    resolveForSessionWithOwnership: vi.fn(async () => ({ runtime: fakeRuntime, bound: true })),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    has: vi.fn(() => true),
    getSessionSettings: vi.fn(async () => null),
    saveSessionSettings: vi.fn(async () => {}),
    getSessionSettingsMany: vi.fn(() => new Map()),
    getSessionAgentPath: vi.fn(async () => null),
    resolveSessionRuntime: vi.fn(async () => ({ type: 'fake', bound: true })),
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

import request from '@dorkos/test-utils/supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createApp, finalizeApp } from '../../app.js';
import {
  initSessionVisibility,
  resetSessionVisibility,
} from '../../services/audit/session-visibility.js';
import {
  getOrCreateProjector,
  disposeProjector,
} from '../../services/session/session-state-projector.js';
import {
  MessageQueueStore,
  setMessageQueueStore,
} from '../../services/session/message-queue-store.js';
import { resetMessageDispatcher } from '../../services/session/message-dispatcher.js';
import { recordDispatchStart } from '../../services/observability/dispatch-buffers.js';

const app = createApp({ admission: new MainRequestAdmission() });
finalizeApp(app);
const server = listeningServer(app);

/** A person's own chat in the app. */
const PRIVATE = '00000000-0000-4000-8000-0000000000a1';
/** A scheduled run: agent work. */
const WORK = '00000000-0000-4000-8000-0000000000b2';
const AGENT = { 'X-DorkOS-Agent': 'agent-token' };

function sessionRow(id: string) {
  return {
    id,
    title: id === PRIVATE ? 'My own chat' : 'Nightly run',
    createdAt: '2026-10-01',
    updatedAt: '2026-10-01',
    permissionMode: 'default' as const,
    runtime: 'fake',
  };
}

/** Open the SSE stream and answer its status code, then hang up. */
function eventsStatus(sessionId: string, headers: Record<string, string>): Promise<number> {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: `/api/sessions/${sessionId}/events`, headers },
      (res) => {
        resolve(res.statusCode ?? 0);
        res.destroy();
        req.destroy();
      }
    );
    req.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
    });
  });
}

beforeEach(() => {
  setMessageQueueStore(new MessageQueueStore(createTestDb()));
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
  fakeRuntime.getSessionETag.mockResolvedValue(null);
  fakeRuntime.getInternalSessionId.mockReturnValue(undefined);
  fakeRuntime.getSessionCwd = vi.fn(() => '/mock/home/project');
  fakeRuntime.hasSession.mockReturnValue(true);
  fakeRuntime.getSession.mockImplementation(async (_cwd, id) => sessionRow(id));
  fakeRuntime.listSessions.mockResolvedValue([sessionRow(PRIVATE), sessionRow(WORK)]);
  fakeRuntime.getMessageHistory.mockResolvedValue([
    { id: 'm1', role: 'user', content: 'thinking aloud' },
  ]);
  fakeRuntime.getSessionTasks.mockResolvedValue([]);
  fakeRuntime.getSessionSnapshot.mockImplementation((_ctx, sessionId) =>
    getOrCreateProjector(sessionId).buildSnapshot(async () => [])
  );
  fakeRuntime.subscribeSession = vi.fn((_ctx, sessionId, sinceCursor, signal) =>
    getOrCreateProjector(sessionId).subscribe(sinceCursor, signal)
  );
  initSessionVisibility(
    (ids) => new Map(ids.map((id) => [id, id === WORK ? 'space' : 'participants'] as const))
  );
});

afterEach(() => {
  resetSessionVisibility();
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(PRIVATE);
  disposeProjector(WORK);
});

const reads = [
  ['GET /:id', (id: string) => `/api/sessions/${id}`],
  ['GET /:id/messages', (id: string) => `/api/sessions/${id}/messages`],
  ['GET /:id/tasks', (id: string) => `/api/sessions/${id}/tasks`],
] as const;

describe('an agent reading sessions', () => {
  it.each(reads)("%s on a person's own chat is 404, and never read", async (_name, path) => {
    const res = await request(server).get(path(PRIVATE)).set(AGENT);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SESSION_NOT_FOUND');
    expect(fakeRuntime.getMessageHistory).not.toHaveBeenCalled();
    expect(fakeRuntime.getSessionTasks).not.toHaveBeenCalled();
  });

  it.each(reads)('%s on agent work is readable', async (_name, path) => {
    const res = await request(server).get(path(WORK)).set(AGENT);

    expect(res.status).toBe(200);
  });

  it("GET /:id/events on a person's own chat is 404; on agent work it streams", async () => {
    expect(await eventsStatus(PRIVATE, AGENT)).toBe(404);
    expect(fakeRuntime.getSessionSnapshot).not.toHaveBeenCalled();
    expect(await eventsStatus(WORK, AGENT)).toBe(200);
  });

  it("GET / and GET /recent leave out a person's own chats", async () => {
    const list = await request(server).get('/api/sessions').set(AGENT);
    expect(list.status).toBe(200);
    expect(list.body.sessions.map((s: { id: string }) => s.id)).toEqual([WORK]);

    const recent = await request(server).get('/api/sessions/recent').set(AGENT);
    expect(recent.status).toBe(200);
    expect(recent.body.sessions.map((s: { id: string }) => s.id)).not.toContain(PRIVATE);
  });

  it('GET /api/debug/sessions/:id applies the same check', async () => {
    expect((await request(server).get(`/api/debug/sessions/${PRIVATE}`).set(AGENT)).status).toBe(
      404
    );
    expect((await request(server).get(`/api/debug/sessions/${WORK}`).set(AGENT)).status).toBe(200);
  });
});

describe('debug lists an agent reads', () => {
  it("leave out a person's own chat; the owner sees both", async () => {
    recordDispatchStart({ dispatchId: 'd-private', origin: 'session', sessionId: PRIVATE });
    recordDispatchStart({ dispatchId: 'd-work', origin: 'session', sessionId: WORK });
    getOrCreateProjector(PRIVATE);
    getOrCreateProjector(WORK);
    const ids = (rows: { sessionId?: string }[]) => rows.map((row) => row.sessionId);

    const dispatches = await request(server).get('/api/debug/dispatches').set(AGENT);
    expect(ids(dispatches.body.recent)).toContain(WORK);
    expect(ids(dispatches.body.recent)).not.toContain(PRIVATE);
    const projectors = await request(server).get('/api/debug/projectors').set(AGENT);
    expect(ids(projectors.body.projectors)).toContain(WORK);
    expect(ids(projectors.body.projectors)).not.toContain(PRIVATE);

    const owner = await request(server).get('/api/debug/projectors');
    expect(ids(owner.body.projectors)).toEqual(expect.arrayContaining([PRIVATE, WORK]));
  });
});

/** The diff routes, each naming its session in the query or body. */
const diffRoutes = [
  ['get', '/baseline', { path: 'a.ts' }],
  ['post', '/baseline/advance', { path: 'a.ts' }],
  ['get', '/pending', {}],
  ['get', '/baseline/raw', { path: 'a.png' }],
  ['post', '/revert', { path: 'a.ts' }],
] as const;

describe('the diff routes', () => {
  const call = (verb: 'get' | 'post', tail: string, extra: object, sessionId: string) => {
    const params = { cwd: '/mock/home/project', sessionId, ...extra };
    const req = request(server)[verb](`/api/diff${tail}`).set(AGENT);
    return verb === 'get' ? req.query(params) : req.send(params);
  };

  it.each(diffRoutes)(
    "%s %s on a person's own chat is 404 to an agent",
    async (verb, tail, extra) => {
      const res = await call(verb, tail, extra, PRIVATE);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SESSION_NOT_FOUND');
    }
  );

  it.each(diffRoutes)('%s %s on agent work passes the check', async (verb, tail, extra) => {
    const res = await call(verb, tail, extra, WORK);
    expect(res.body.code).not.toBe('SESSION_NOT_FOUND');
  });
});

/** Every other `/:id` route, reached by the router-level guard. */
const everyRoute = [
  ['get', '/queue'],
  ['get', '/chat-messages'],
  ['get', '/settings'],
  ['get', '/runtime-type'],
  ['get', '/limit-history'],
  ['get', '/continue-options'],
  ['get', '/canvas'],
  ['post', '/fork'],
  ['post', '/messages'],
  ['post', '/interrupt'],
  ['post', '/approve'],
  ['patch', ''],
  ['patch', '/queue/m1'],
] as const;

describe('the guard in front of every session route', () => {
  it.each(everyRoute)("%s /:id%s on a person's own chat is 404 to an agent", async (verb, tail) => {
    const res = await request(server)
      [verb](`/api/sessions/${PRIVATE}${tail}`)
      .set(AGENT)
      .send({ content: 'hello' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SESSION_NOT_FOUND');
  });

  // `/limit-history` answers its own 404 for a session that never hit a limit.
  const pastTheGuard = everyRoute.filter(([, tail]) => tail !== '/limit-history');
  it.each(pastTheGuard)('%s /:id%s on agent work passes the guard', async (verb, tail) => {
    const res = await request(server)
      [verb](`/api/sessions/${WORK}${tail}`)
      .set(AGENT)
      .send({ content: 'hello' });

    expect(res.body.code).not.toBe('SESSION_NOT_FOUND');
  });

  it('lets an agent start a new chat, and not reuse a private id to do it', async () => {
    const NEW = '00000000-0000-4000-8000-0000000000c3';
    const { runtimeRegistry } = await import('../../services/core/runtime-registry.js');
    vi.mocked(runtimeRegistry.resolveForSessionWithOwnership).mockImplementation(async (id) => ({
      runtime: fakeRuntime as never,
      bound: id !== NEW,
    }));
    fakeRuntime.getSession.mockImplementation(async (_cwd, id) =>
      id === NEW ? null : sessionRow(id)
    );

    const fresh = await request(server)
      .post(`/api/sessions/${NEW}/messages`)
      .set(AGENT)
      .send({ content: 'hello', create: true });
    expect(fresh.body.code).not.toBe('SESSION_NOT_FOUND');
    // Its own work, not a person's chat, so it can read what it started.
    expect(vi.mocked(runtimeRegistry.persistSessionRuntime)).toHaveBeenCalledWith(
      NEW,
      'fake',
      { kind: 'agent-launch' },
      undefined
    );

    const reused = await request(server)
      .post(`/api/sessions/${PRIVATE}/messages`)
      .set(AGENT)
      .send({ content: 'hello', create: true });
    expect(reused.status).toBe(404);
  });
});

describe('the owner reading sessions', () => {
  it.each(reads)('%s reads their own chat', async (_name, path) => {
    expect((await request(server).get(path(PRIVATE))).status).toBe(200);
  });

  it('lists every session', async () => {
    const list = await request(server).get('/api/sessions');
    expect(list.body.sessions.map((s: { id: string }) => s.id)).toEqual([PRIVATE, WORK]);
  });
});
