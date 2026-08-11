/**
 * One turn at a time per client, over the real HTTP routes (DOR-1088).
 *
 * The bug: a session ran two `sendMessage` streams at once — two runtime
 * subprocesses resuming the same transcript, trading the control channel and
 * handing the projector two overlapping turns, which is what left a live session
 * showing an idle composer. The cockpit got there on its own. It mints one
 * client id per tab, its composer arms an auto-flush on the streaming→idle edge,
 * and the second POST from that tab walked through a lock its own first turn was
 * holding.
 *
 * These tests pin the answer at the seam a person actually hits: a second POST
 * waits and then runs, its message neither refused nor lost, whether it came
 * from the same window or another one. DOR-1131 removed the one asymmetry that
 * was left here — a second CLIENT used to be told 409 instead of waiting — so
 * both cases now read the same way, which is what the person sees. The lock is
 * the real `SessionLockManager`, not a canned mock, so the queue and the lock
 * have to agree.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
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
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    getSessionSettings: vi.fn(async () => null),
    has: vi.fn(() => true),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {
    constructor(
      public readonly runtime: string,
      public readonly sessionId: string
    ) {
      super(`Session '${sessionId}' is owned by runtime '${runtime}', which is not registered.`);
      this.name = 'RuntimeNotRegisteredError';
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

import request from 'supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createApp, finalizeApp } from '../../app.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import {
  getOrCreateProjector,
  disposeProjector,
} from '../../services/session/session-state-projector.js';
import { SessionLockManager } from '../../services/session/session-lock.js';
import { resetMessageDispatcher } from '../../services/session/message-dispatcher.js';
import { sessionTurnQueue } from '../../services/session/trigger-turn.js';

const app = createApp();
finalizeApp(app);

/** ONE listener for the whole file (DOR-483); see the cross-client suite. */
const server = listeningServer(app);

const SESSION_ID = '00000000-0000-4000-8000-0000000000bb';
/** The id the runtime assigns to a brand-new session mid-first-turn. */
const CANONICAL_ID = '00000000-0000-4000-8000-0000000000cc';
const TAB = 'web-one-tab';

/** A promise plus the function that resolves it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
  const lockManager = new SessionLockManager();
  fakeRuntime.acquireLock.mockImplementation((sid, cid, res, token) =>
    lockManager.acquireLock(sid, cid, res, token)
  );
  fakeRuntime.releaseLock.mockImplementation((sid, cid, token) =>
    lockManager.releaseLock(sid, cid, token)
  );
  fakeRuntime.getLockInfo.mockImplementation((sid) => lockManager.getLockInfo(sid));
  fakeRuntime.isLocked.mockImplementation((sid, cid) => lockManager.isLocked(sid, cid));
  fakeRuntime.hasSession.mockReturnValue(true);
  fakeRuntime.getInternalSessionId.mockReturnValue(SESSION_ID);
  fakeRuntime.getSessionSnapshot.mockImplementation((_ctx, sessionId) =>
    getOrCreateProjector(sessionId).buildSnapshot(async () => [])
  );
});

afterEach(() => {
  // The dispatcher outlives one case: a message left waiting here would still be
  // in line when the next case posts, and would make ITS first message queue
  // behind a turn from a test that has already finished.
  resetMessageDispatcher();
  disposeProjector(SESSION_ID);
  disposeProjector(CANONICAL_ID);
});

/** POST a message without awaiting the response, kicking the request off now. */
function postMessage(
  clientId: string,
  content: string,
  sessionId: string = SESSION_ID
): Promise<{ status: number }> {
  return request(server)
    .post(`/api/sessions/${sessionId}/messages`)
    .set('X-Client-Id', clientId)
    .send({ content })
    .then((res) => ({ status: res.status }));
}

/** Wait until the route has resolved a runtime for `count` POSTs — i.e. they arrived. */
async function awaitArrivals(count: number): Promise<void> {
  await vi.waitFor(() =>
    expect(vi.mocked(runtimeRegistry.resolveForSession)).toHaveBeenCalledTimes(count)
  );
}

describe('POST /api/sessions/:id/messages — same-client turn serialization', () => {
  it('makes a second POST from the same client WAIT, then run, never alongside', async () => {
    const first = gate();
    /** Every start/end boundary the runtime saw, in the order it saw them. */
    const order: string[] = [];
    fakeRuntime.withScenarios([
      async function* () {
        order.push('turn-1:start');
        yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
        await first.wait;
        order.push('turn-1:end');
        yield { type: 'done', data: {} } as StreamEvent;
      },
      async function* () {
        order.push('turn-2:start');
        yield { type: 'text_delta', data: { text: 'queued reply' } } as StreamEvent;
        order.push('turn-2:end');
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const firstRes = await postMessage(TAB, 'long turn');
    expect(firstRes.status).toBe(202);
    expect(order).toEqual(['turn-1:start']);

    // The same tab's auto-flush posts its queued message while turn 1 streams.
    const secondDone = postMessage(TAB, 'queued message');
    await awaitArrivals(2);
    // Let the request settle as far as it can get. It must get no further than
    // the queue: turn 1 still holds the session, so turn 2 has not been sent.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fakeRuntime.sendMessage).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['turn-1:start']);

    // Turn 1 finishes and releases. Only now may turn 2 begin.
    first.open();
    expect((await secondDone).status).toBe(202);
    await vi.waitFor(() =>
      expect(order).toEqual(['turn-1:start', 'turn-1:end', 'turn-2:start', 'turn-2:end'])
    );
    expect(fakeRuntime.sendMessage).toHaveBeenCalledTimes(2);
    expect(fakeRuntime.sendMessage).toHaveBeenLastCalledWith(
      SESSION_ID,
      'queued message',
      expect.anything()
    );
    // Both slots handed back: the queue holds nothing once a session goes quiet.
    await vi.waitFor(() => expect(sessionTurnQueue.size).toBe(0));
  });

  it('makes a SECOND CLIENT wait exactly as the first one does (DOR-1131)', async () => {
    // Waiting used to be only for the client that owned the turn; a different
    // client got a 409 it could see and act on. Acting on it meant retyping,
    // which is why it is gone: the second window's message now waits in the same
    // queue and runs on the same signal, and the lock it used to bounce off is
    // now just the mutex the running turn holds.
    const first = gate();
    fakeRuntime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
        await first.wait;
        yield { type: 'done', data: {} } as StreamEvent;
      },
      async function* () {
        yield { type: 'text_delta', data: { text: 'the other window’s reply' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    expect((await postMessage(TAB, 'long turn')).status).toBe(202);

    const fromElsewhere = await request(server)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'another-tab')
      .send({ content: 'from elsewhere' });
    expect(fromElsewhere.status).toBe(202);
    expect(fromElsewhere.body.messageId).toEqual(expect.any(String));
    // Waiting, not running beside it: still one stream on this session.
    expect(fakeRuntime.sendMessage).toHaveBeenCalledTimes(1);
    // And the running turn kept the lock while the second message waited.
    expect(fakeRuntime.getLockInfo(SESSION_ID)?.clientId).toBe(TAB);

    first.open();
    await vi.waitFor(() => expect(fakeRuntime.sendMessage).toHaveBeenCalledTimes(2));
    expect(fakeRuntime.sendMessage).toHaveBeenLastCalledWith(
      SESSION_ID,
      'from elsewhere',
      expect.anything()
    );
    await vi.waitFor(() => expect(fakeRuntime.releaseLock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(sessionTurnQueue.size).toBe(0));
  });
});

describe('POST /api/sessions/:id/messages — one session, two ids (review G4)', () => {
  it('serializes a second POST sent under the canonical id the first POST handed back', async () => {
    // A live session answers to every id it has ever held. The cockpit re-keys
    // itself to the canonical id the moment the 202 carries it, so the tab's
    // NEXT message arrives under a different id than the turn still running —
    // and keyed on the raw request id, the queue and the lock both looked at the
    // wrong shelf and let a second stream into one projector.
    const first = gate();
    const order: string[] = [];
    let canonicalAssigned = false;

    // Before the first turn speaks, the session does not exist yet and has no
    // canonical id; from its first event on, BOTH ids resolve to the canonical
    // one. That is the runtime's real alias behavior, and the whole hazard.
    fakeRuntime.getInternalSessionId.mockImplementation(() =>
      canonicalAssigned ? CANONICAL_ID : undefined
    );

    fakeRuntime.withScenarios([
      async function* () {
        order.push('turn-1:start');
        canonicalAssigned = true;
        yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
        await first.wait;
        order.push('turn-1:end');
        yield { type: 'done', data: {} } as StreamEvent;
      },
      async function* () {
        order.push('turn-2:start');
        yield { type: 'text_delta', data: { text: 'queued reply' } } as StreamEvent;
        order.push('turn-2:end');
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const firstRes = await postMessage(TAB, 'long turn');
    expect(firstRes.status).toBe(202);
    expect(order).toEqual(['turn-1:start']);

    // Same tab, same client id — but addressed to the id it just adopted.
    const secondDone = postMessage(TAB, 'queued message', CANONICAL_ID);
    await awaitArrivals(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fakeRuntime.sendMessage).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['turn-1:start']);

    first.open();
    expect((await secondDone).status).toBe(202);
    await vi.waitFor(() =>
      expect(order).toEqual(['turn-1:start', 'turn-1:end', 'turn-2:start', 'turn-2:end'])
    );
    expect(fakeRuntime.sendMessage).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(sessionTurnQueue.size).toBe(0));
  });
});
