import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
/**
 * @vitest-environment node
 *
 * When you touch a chat, as the routes record it (spec `your-activity-first`
 * D3, D4, D6): `POST /:id/opened` and an accepted `POST /:id/messages` write
 * `session_touches` only for a person at the app, and `GET /recent` keeps
 * every chat touched since a given time beyond its window. The dispatcher is
 * stubbed so a refusal and an acceptance can each be asked for directly; what
 * is under test is what the route records around it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';

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

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn(async () => null) }));

vi.mock('../../services/session/launch/session-exists.js', () => ({
  sessionExists: vi.fn(async () => true),
}));

const dispatchSessionMessage = vi.fn();
vi.mock('../../services/session/launch/launch-session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/session/launch/launch-session.js')>()),
  dispatchSessionMessage: (...args: unknown[]) => dispatchSessionMessage(...args),
}));

import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { createApp, finalizeApp } from '../../app.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import {
  SessionTouchStore,
  setSessionTouchStore,
} from '../../services/session/origin/session-touch-store.js';
import {
  initSessionVisibility,
  resetSessionVisibility,
} from '../../services/audit/session-visibility.js';

const app = createApp({ admission: new MainRequestAdmission() });
finalizeApp(app);
const server = listeningServer(app);

const CHAT = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
/** An id the runtime has retired in favour of {@link CHAT}. */
const RETIRED = '00000000-0000-4000-8000-000000000003';
const APP_WINDOW = { 'X-Client-Id': 'window-1' };

/** What the dispatcher answers for a message it took. */
function accepted(canonicalId = CHAT) {
  return {
    accepted: true,
    canonicalId,
    outcome: { messageId: 'm1', requested: 'queue', applied: 'queue' },
    queuePosition: 1,
    queued: false,
  };
}

function makeSession(id: string, updatedAt: string): Session {
  return {
    id,
    title: id,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt,
    permissionMode: 'default',
    runtime: 'fake-touch',
    cwd: '/p1',
  };
}

// The agent callers below act on agent work, so the session read guard
// (`routes/session-read-guard.ts`) lets them through to the rule under test.
beforeEach(() => {
  initSessionVisibility((ids) => new Map(ids.map((id) => [id, 'space'] as const)));
});
afterEach(() => {
  resetSessionVisibility();
});

describe('session touches', () => {
  let store: SessionTouchStore;
  let runtime: FakeAgentRuntime;

  beforeEach(() => {
    const db = createTestDb();
    store = new SessionTouchStore(db);
    setSessionTouchStore(store);
    app.locals.resolveTouches = (ids: string[]) => store.resolve(ids);
    runtime = new FakeAgentRuntime('fake-touch');
    runtimeRegistry.setDb(db);
    runtimeRegistry.register(runtime);
    runtimeRegistry.setDefault('fake-touch');
    dispatchSessionMessage.mockResolvedValue(accepted());
  });

  afterEach(() => {
    vi.clearAllMocks();
    setSessionTouchStore(undefined);
    delete app.locals.resolveTouches;
    delete app.locals.resolveRoomOrigins;
    delete app.locals.meshCore;
  });

  const touchOf = (id: string) => store.resolve([id]).get(id);

  describe('POST /api/sessions/:id/opened', () => {
    it('records the open when a window of the app shows the chat', async () => {
      const res = await request(server).post(`/api/sessions/${CHAT}/opened`).set(APP_WINDOW);
      expect(res.status).toBe(204);
      expect(touchOf(CHAT)?.openedAt).toEqual(expect.any(String));
      expect(touchOf(CHAT)?.wroteAt).toBeNull();
    });

    it('answers 204 and records nothing for an agent', async () => {
      const res = await request(server)
        .post(`/api/sessions/${CHAT}/opened`)
        .set({ ...APP_WINDOW, 'X-DorkOS-Agent': 'some-token' });
      expect(res.status).toBe(204);
      expect(touchOf(CHAT)).toBeUndefined();
    });

    it('answers 204 and records nothing for a caller with no client id', async () => {
      const res = await request(server).post(`/api/sessions/${CHAT}/opened`);
      expect(res.status).toBe(204);
      expect(touchOf(CHAT)).toBeUndefined();
    });

    it('saves under the chat’s current id when opened by a retired one', async () => {
      runtime.getInternalSessionId.mockImplementation((id: string) =>
        id === RETIRED ? CHAT : undefined
      );
      const res = await request(server).post(`/api/sessions/${RETIRED}/opened`).set(APP_WINDOW);
      expect(res.status).toBe(204);
      expect(touchOf(RETIRED)).toBeUndefined();
      expect(touchOf(CHAT)?.openedAt).toEqual(expect.any(String));
    });

    it('refuses an id that is not a session id', async () => {
      const res = await request(server).post('/api/sessions/not-a-uuid/opened').set(APP_WINDOW);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SESSION_ID');
    });
  });

  describe('POST /api/sessions/:id/messages', () => {
    const send = () =>
      request(server).post(`/api/sessions/${CHAT}/messages`).send({ content: 'hello' });

    it('records the write under the canonical id once the message is accepted', async () => {
      dispatchSessionMessage.mockResolvedValue(accepted(OTHER));
      const res = await send().set(APP_WINDOW);
      expect(res.status).toBe(202);
      const touch = touchOf(OTHER);
      expect(touch?.wroteAt).toEqual(expect.any(String));
      expect(touch?.openedAt).toBe(touch?.wroteAt);
    });

    it('records nothing when the launch is refused', async () => {
      dispatchSessionMessage.mockResolvedValue({
        refused: 'DESK_NOT_OWN',
        message: 'Not here.',
      });
      const res = await send().set(APP_WINDOW);
      expect(res.status).toBe(409);
      expect(touchOf(CHAT)).toBeUndefined();
    });

    it('records nothing when the dispatcher refused the message without a launch refusal', async () => {
      // `accepted: false` still answers 202 (a busy session refusing a
      // machine-sent trigger), but nothing was taken.
      dispatchSessionMessage.mockResolvedValue({
        ...accepted(),
        accepted: false,
        canonicalId: undefined,
      });
      const res = await send().set(APP_WINDOW);
      expect(res.status).toBe(202);
      expect(touchOf(CHAT)).toBeUndefined();
    });

    it('records nothing for an agent posting to the route', async () => {
      const res = await send().set({ ...APP_WINDOW, 'X-DorkOS-Agent': 'some-token' });
      expect(res.status).toBe(202);
      expect(touchOf(CHAT)).toBeUndefined();
    });

    it('records nothing for a script that sends no client id', async () => {
      // A coordinator waking a chat from a shell: the bug this rule removes.
      const res = await send();
      expect(res.status).toBe(202);
      expect(touchOf(CHAT)).toBeUndefined();
    });
  });

  describe('GET /api/sessions/recent', () => {
    function agentAt(path: string) {
      app.locals.meshCore = {
        listWithPaths: () => [{ id: path, name: 'agent', projectPath: path }],
      };
    }

    it('keeps a chat touched since the given time beyond the limit', async () => {
      agentAt('/p1');
      // Twelve agent-busy chats outrank the one you used by `updatedAt`.
      const busy = Array.from({ length: 12 }, (_, i) =>
        makeSession(`busy-${i}`, `2026-10-08T1${Math.min(i, 9)}:30:00.000Z`)
      );
      const yours = makeSession(CHAT, '2026-10-08T05:00:00.000Z');
      runtime.listSessions.mockResolvedValue([...busy, yours]);
      store.recordOpened(CHAT, '2026-10-08T06:00:00.000Z');

      const without = await request(server).get('/api/sessions/recent?limit=10');
      expect(without.body.sessions.map((s: Session) => s.id)).not.toContain(CHAT);

      const res = await request(server).get(
        '/api/sessions/recent?limit=10&touchedSince=2026-10-08T04:00:00%2B00:00'
      );
      expect(res.status).toBe(200);
      const ids = res.body.sessions.map((s: Session) => s.id);
      expect(ids).toHaveLength(11);
      // Kept in its `updatedAt` place, at the end, not pulled to the top.
      expect(ids.at(-1)).toBe(CHAT);
      expect(res.body.sessions.at(-1).lastTouchedByYouAt).toBe('2026-10-08T06:00:00.000Z');
    });

    it('does not keep a chat touched before the given time', async () => {
      agentAt('/p1');
      const busy = Array.from({ length: 3 }, (_, i) =>
        makeSession(`busy-${i}`, `2026-10-08T1${i}:00:00.000Z`)
      );
      runtime.listSessions.mockResolvedValue([
        ...busy,
        makeSession(CHAT, '2026-10-07T05:00:00.000Z'),
      ]);
      store.recordOpened(CHAT, '2026-10-07T06:00:00.000Z');

      const res = await request(server).get(
        '/api/sessions/recent?limit=3&touchedSince=2026-10-08T04:00:00.000Z'
      );
      expect(res.body.sessions.map((s: Session) => s.id)).not.toContain(CHAT);
    });

    it('keeps a chat touched exactly at the given time', async () => {
      agentAt('/p1');
      runtime.listSessions.mockResolvedValue([
        makeSession('busy', '2026-10-08T12:00:00.000Z'),
        makeSession(CHAT, '2026-10-08T05:00:00.000Z'),
      ]);
      store.recordOpened(CHAT, '2026-10-08T04:00:00.000Z');

      const res = await request(server).get(
        '/api/sessions/recent?limit=1&touchedSince=2026-10-08T04:00:00.000Z'
      );
      expect(res.body.sessions.map((s: Session) => s.id)).toEqual(['busy', CHAT]);
    });

    it('refuses a touchedSince that is not a time', async () => {
      const res = await request(server).get('/api/sessions/recent?touchedSince=today');
      expect(res.status).toBe(400);
    });

    // The spec's scenario, server half: a chat a room started, that you then
    // typed in from the app, reads as yours.
    it('counts a room-born chat you typed in as yours', async () => {
      agentAt('/p1');
      runtime.listSessions.mockResolvedValue([
        {
          ...makeSession(CHAT, '2026-10-08T12:00:00.000Z'),
          userLastMessageAt: '2026-10-08T11:00:00.000Z',
        },
        {
          ...makeSession(OTHER, '2026-10-08T12:00:00.000Z'),
          userLastMessageAt: '2026-10-08T11:00:00.000Z',
        },
      ]);
      app.locals.resolveRoomOrigins = (ids: string[]) =>
        new Map(ids.map((id) => [id, { roomLabel: '#dorkos', roomId: 'room-1' }]));

      const wrote = await request(server)
        .post(`/api/sessions/${CHAT}/messages`)
        .set(APP_WINDOW)
        .send({ content: 'carry on' });
      expect(wrote.status).toBe(202);

      const res = await request(server).get('/api/sessions/recent');
      const byId = new Map<string, Session>(res.body.sessions.map((s: Session) => [s.id, s]));
      const yours = byId.get(CHAT)!;
      expect(yours.origin).toBe('room');
      expect(yours.userLastMessageAt).toEqual(expect.any(String));
      expect(yours.lastTouchedByYouAt).toBe(yours.userLastMessageAt);
      // The other room turn, which only relayed posts reached, stays not-yours.
      const relayed = byId.get(OTHER)!;
      expect('userLastMessageAt' in relayed).toBe(false);
      expect('lastTouchedByYouAt' in relayed).toBe(false);
    });
  });
});
