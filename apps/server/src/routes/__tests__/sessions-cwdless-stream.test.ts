/**
 * A second window that opened the session URL WITHOUT the folder (DOR-1444).
 *
 * Observed live on 2026-08-23: with one conversation open in two browser tabs,
 * the second tab showed the idle placeholder, no Stop button and none of the
 * streaming text while the first tab was mid-turn — and the status line read
 * "Live updates lost". The durable stream's snapshot→replay contract was not at
 * fault: the snapshot never arrived, because the stream was refused before it
 * could be built.
 *
 * The reason is the fixture below. Every per-session read used to fall back to
 * the server's DEFAULT project directory when the caller passed no `?cwd=`, and
 * on that machine the default sat OUTSIDE the configured boundary — so the
 * stream's boundary check refused a session that was, at that moment, actively
 * streaming from a directory well inside it. `getSessionCwd` is the runtime's
 * live binding for exactly that session, so a window joining a running turn can
 * always be placed; the routes just never asked.
 *
 * The boundary mock here is deliberately shaped like the real one: it admits
 * the session's own directory and refuses everything else, the default project
 * directory included.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { SessionSnapshot } from '@dorkos/shared/session-stream';
import { FakeAgentRuntime } from '@dorkos/test-utils';

/** The directory the session is really running in — inside the boundary. */
const LIVE_CWD = '/live/project';

// Everything this factory needs is declared INSIDE it: `vi.mock` is hoisted
// above every module-level binding in the file, so a reference to one is a
// use-before-initialization at mock time. Hence the repeated literal.
vi.mock('../../lib/boundary.js', () => {
  class TestBoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  }
  /** Reject any directory that is not the session's own — the live fixture. */
  const guard = (dir: string): string => {
    if (dir !== '/live/project' && !dir.startsWith('/live/project/')) {
      throw new TestBoundaryError(
        'Access denied: path outside directory boundary',
        'OUTSIDE_BOUNDARY'
      );
    }
    return dir;
  };
  return {
    validateBoundary: vi.fn(async (p: string) => guard(p)),
    validateBoundaryOrDorkHome: vi.fn(async (p: string) => guard(p)),
    getBoundary: vi.fn(() => '/live/project'),
    initBoundary: vi.fn().mockResolvedValue('/live/project'),
    isWithinBoundary: vi.fn().mockResolvedValue(true),
    BoundaryError: TestBoundaryError,
  };
});

let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    getSessionSettings: vi.fn(async () => null),
    getSessionSettingsMany: vi.fn(() => new Map()),
    has: vi.fn(() => true),
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

import request from 'supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createApp, finalizeApp } from '../../app.js';
import {
  getOrCreateProjector,
  peekProjector,
  disposeProjector,
} from '../../services/session/session-state-projector.js';
import {
  MessageQueueStore,
  setMessageQueueStore,
} from '../../services/session/message-queue-store.js';
import { resetMessageDispatcher } from '../../services/session/message-dispatcher.js';
import { attachEventStream } from './helpers/trigger-turn-helpers.js';

const app = createApp();
finalizeApp(app);
const server = listeningServer(app);

const SESSION_ID = '00000000-0000-4000-8000-0000000000cd';

/** Directories the snapshot was asked to hydrate from, in call order. */
let snapshotCwds: (string | undefined)[] = [];

beforeEach(() => {
  setMessageQueueStore(new MessageQueueStore(createTestDb()));
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
  snapshotCwds = [];
  fakeRuntime.acquireLock.mockReturnValue(true);
  fakeRuntime.isLocked.mockReturnValue(false);
  fakeRuntime.getLockInfo.mockReturnValue(null);
  fakeRuntime.hasSession.mockReturnValue(true);
  fakeRuntime.getInternalSessionId.mockReturnValue(SESSION_ID);
  // The live binding a runtime holds for a session it is running RIGHT NOW.
  fakeRuntime.getSessionCwd = vi.fn(() => LIVE_CWD);
  fakeRuntime.getSession.mockResolvedValue({
    id: SESSION_ID,
    title: 'Live one',
    createdAt: '2026-08-23',
    updatedAt: '2026-08-23',
    permissionMode: 'default',
    runtime: 'fake',
  });
  fakeRuntime.getSessionSnapshot.mockImplementation((ctx, sessionId) => {
    snapshotCwds.push(ctx.cwd);
    return getOrCreateProjector(sessionId).buildSnapshot(async () => []);
  });
  fakeRuntime.subscribeSession = vi.fn((_ctx, sessionId, sinceCursor, signal) =>
    getOrCreateProjector(sessionId).subscribe(sinceCursor, signal)
  );
});

afterEach(() => {
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(SESSION_ID);
});

describe('a window that opened the session without the folder', () => {
  it('still sees the turn that is already running', async () => {
    let releaseTurn!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    fakeRuntime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'half-one ' } } as StreamEvent;
        await gate;
        yield { type: 'text_delta', data: { text: 'half-two' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    // Window 1 drives the turn, naming its directory the way the cockpit does.
    const first = attachEventStream(server, SESSION_ID);
    await first.ready;
    const post = await request(server)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'window-1')
      .query({ cwd: LIVE_CWD })
      .send({ content: 'Hello' });
    expect(post.status).toBe(202);

    // Wait until the first half is INGESTED, so the late joiner's snapshot must
    // carry a non-empty in-progress prefix if it carries anything at all.
    await vi.waitFor(async () => {
      const snap = (await peekProjector(SESSION_ID)!.buildSnapshot(
        async () => []
      )) as SessionSnapshot;
      expect(snap.inProgressTurn?.some((e) => e.type === 'text_delta')).toBe(true);
    });

    // Window 2: the same session, no `?cwd=` at all — the failing case.
    const second = attachEventStream(server, SESSION_ID);
    await second.ready;
    releaseTurn();

    const [, secondRes] = await Promise.all([first.done, second.done]);

    // It connected at all — the observed failure was a boundary refusal here.
    expect(secondRes.status).toBe(200);
    const snapshot = secondRes.frames.find((f) => f.event === 'snapshot')?.data as
      SessionSnapshot | undefined;
    expect(snapshot).toBeDefined();
    // The Stop button and the streaming text both hang off these two facts.
    expect(snapshot!.status.lifecycle).toBe('streaming');
    expect(
      (snapshot!.inProgressTurn ?? []).filter((e) => e.type === 'text_delta').map((e) => e.text)
    ).toEqual(['half-one ']);
    // …and it keeps up: the rest of the turn arrives live.
    const liveDeltas = secondRes.frames
      .filter((f) => f.event === 'text_delta')
      .map((f) => (f.data as { text: string }).text);
    expect(liveDeltas).toEqual(['half-two']);
  });

  it("hydrates from the session's own directory, not the server default", async () => {
    const handle = attachEventStream(server, SESSION_ID, { until: 'snapshot', maxMs: 2000 });
    await handle.ready;
    handle.close();
    await handle.done;

    expect(snapshotCwds).toEqual([LIVE_CWD]);
  });

  it('reads its title and settings without the folder too', async () => {
    const res = await request(server).get(`/api/sessions/${SESSION_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Live one');
    expect(fakeRuntime.getSession).toHaveBeenCalledWith(LIVE_CWD, SESSION_ID);
  });

  it('still refuses an out-of-boundary directory the caller named', async () => {
    const res = await request(server)
      .get(`/api/sessions/${SESSION_ID}/events`)
      .query({ cwd: '/etc/shadow' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    // Refused before the runtime was ever consulted for this session.
    expect(fakeRuntime.getSessionSnapshot).not.toHaveBeenCalled();
  });
});

describe('a session whose live binding is outside the boundary', () => {
  // The inverse of everything above, and the reason these resolvers must never
  // be trusted on their own. `getSessionCwd` reports where a session is
  // ACTUALLY running, which is not the same as where it is ALLOWED to run: the
  // task routes create sessions with no boundary check at all, so a scheduled
  // task can bind one outside it. If a resolved directory skipped the boundary,
  // omitting `?cwd=` would read a session that naming the same directory is
  // refused for — a request that is more powerful for saying less.
  beforeEach(() => {
    fakeRuntime.getSessionCwd = vi.fn(() => '/secret/outside');
    fakeRuntime.getMessageHistory.mockResolvedValue([
      { id: 'm1', role: 'assistant', content: 'SECRET', timestamp: '2026-08-23T00:00:00Z' },
    ]);
    fakeRuntime.getSessionTasks.mockResolvedValue([]);
  });

  /** Every read that can be reached without naming a directory. */
  const readsWithoutCwd = [
    ['GET /:id', (id: string) => `/api/sessions/${id}`],
    ['GET /:id/messages', (id: string) => `/api/sessions/${id}/messages`],
    ['GET /:id/tasks', (id: string) => `/api/sessions/${id}/tasks`],
    ['GET /:id/events', (id: string) => `/api/sessions/${id}/events`],
  ] as const;

  it.each(readsWithoutCwd)('%s refuses it rather than reading it', async (_name, path) => {
    const res = await request(server).get(path(SESSION_ID));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
  });

  it('never reads the transcript it refused', async () => {
    await request(server).get(`/api/sessions/${SESSION_ID}/messages`);
    await request(server).get(`/api/sessions/${SESSION_ID}/tasks`);
    await request(server).get(`/api/sessions/${SESSION_ID}/events`);

    expect(fakeRuntime.getMessageHistory).not.toHaveBeenCalled();
    expect(fakeRuntime.getSessionTasks).not.toHaveBeenCalled();
    expect(fakeRuntime.getSessionSnapshot).not.toHaveBeenCalled();
  });

  it('answers the same way whether or not the caller named the directory', async () => {
    // The control that makes the four above mean something: naming the very
    // same directory was ALWAYS refused, so a no-cwd request that succeeded
    // would be the inversion, not merely a second opinion.
    const named = await request(server)
      .get(`/api/sessions/${SESSION_ID}/messages`)
      .query({ cwd: '/secret/outside' });
    const unnamed = await request(server).get(`/api/sessions/${SESSION_ID}/messages`);

    expect(named.status).toBe(403);
    expect(unnamed.status).toBe(named.status);
  });
});
