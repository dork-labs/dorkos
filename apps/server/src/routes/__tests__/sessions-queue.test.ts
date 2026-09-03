/**
 * The queue's HTTP surface (spec `persistent-session-runtime` §3.3, task 2.4):
 * read what is waiting on a session, edit it, remove it.
 *
 * Driven over the real routes against a real SQLite store, because every claim
 * here is about persistence and about two windows sharing one queue — a stubbed
 * store would be asserting those promises against itself.
 *
 * The rule the whole file exists to pin: **the queue belongs to the session, not
 * to a window.** The second client can reword and remove what the first one
 * typed. `enqueuedBy` is there so a window can SAY which chips are its own,
 * never so the server can refuse the others.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeAgentRuntime, mockInterruptReceipt } from '@dorkos/test-utils';

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
import { createTestDb } from '@dorkos/test-utils/db';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createApp, finalizeApp } from '../../app.js';
import {
  getOrCreateProjector,
  disposeProjector,
} from '../../services/session/session-state-projector.js';
import {
  MessageQueueStore,
  setMessageQueueStore,
} from '../../services/session/message-queue-store.js';
import { resetMessageDispatcher } from '../../services/session/message-dispatcher.js';

const app = createApp();
finalizeApp(app);
const server = listeningServer(app);

const SESSION_ID = '00000000-0000-4000-8000-0000000000cc';
const OTHER_SESSION_ID = '00000000-0000-4000-8000-0000000000cd';

/** Opens the running turn that everything else in a case queues behind. */
let releaseTurn: () => void;
/** The case's store, for seeding rows no route would create. */
let store: MessageQueueStore;

/** Post a message as `clientId` and return the 202 body. */
async function post(content: string, clientId: string) {
  const res = await request(server)
    .post(`/api/sessions/${SESSION_ID}/messages`)
    .set('X-Client-Id', clientId)
    .send({ content });
  expect(res.status).toBe(202);
  return res.body as { messageId: string; queuePosition: number };
}

/** The session's queue as the routes report it. */
async function readQueue(sessionId = SESSION_ID) {
  const res = await request(server).get(`/api/sessions/${sessionId}/queue`);
  expect(res.status).toBe(200);
  return res.body.queue as { id: string; content: string; enqueuedBy: string }[];
}

beforeEach(async () => {
  store = new MessageQueueStore(createTestDb());
  setMessageQueueStore(store);
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
  fakeRuntime.acquireLock.mockReturnValue(true);
  fakeRuntime.isLocked.mockReturnValue(false);
  fakeRuntime.getLockInfo.mockReturnValue(null);
  fakeRuntime.hasSession.mockReturnValue(true);
  fakeRuntime.getInternalSessionId.mockReturnValue(SESSION_ID);

  // One long turn, parked open, so everything posted after it waits in the
  // queue where these cases can work on it.
  const gate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  fakeRuntime.withScenarios([
    async function* () {
      yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
      await gate;
      yield { type: 'done', data: {} } as StreamEvent;
    },
    async function* () {
      yield { type: 'done', data: {} } as StreamEvent;
    },
  ]);
  const first = await request(server)
    .post(`/api/sessions/${SESSION_ID}/messages`)
    .set('X-Client-Id', 'client-a')
    .send({ content: 'the turn everything queues behind' });
  expect(first.status).toBe(202);
});

afterEach(() => {
  releaseTurn();
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(SESSION_ID);
  disposeProjector(OTHER_SESSION_ID);
});

describe('GET /api/sessions/:id/queue', () => {
  it('lists what is waiting, in dispatch order, with who typed it', async () => {
    await post('first in line', 'client-a');
    await post('second in line', 'client-b');

    expect(await readQueue()).toMatchObject([
      { content: 'first in line', enqueuedBy: 'client-a' },
      { content: 'second in line', enqueuedBy: 'client-b' },
    ]);
  });

  it('is empty for a session with nothing waiting', async () => {
    expect(await readQueue(OTHER_SESSION_ID)).toEqual([]);
  });

  it('rejects a malformed session id', async () => {
    const res = await request(server).get('/api/sessions/not-a-uuid/queue');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SESSION_ID');
  });
});

describe('PATCH /api/sessions/:id/queue/:messageId', () => {
  it('lets a SECOND window reword what the first one typed', async () => {
    const mine = await post('teh typo', 'client-a');

    const res = await request(server)
      .patch(`/api/sessions/${SESSION_ID}/queue/${mine.messageId}`)
      .set('X-Client-Id', 'client-b')
      .send({ content: 'the typo, fixed by the other window' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({
      id: mine.messageId,
      content: 'the typo, fixed by the other window',
      // Rewording does not change whose message it is.
      enqueuedBy: 'client-a',
    });
    expect(res.body.queue).toHaveLength(1);
    expect((await readQueue())[0]?.content).toBe('the typo, fixed by the other window');
  });

  it('moves a message before another one, and answers with the new order', async () => {
    const one = await post('one', 'client-a');
    await post('two', 'client-a');
    const three = await post('three', 'client-a');

    const res = await request(server)
      .patch(`/api/sessions/${SESSION_ID}/queue/${three.messageId}`)
      .send({ move: { before: one.messageId } });

    expect(res.status).toBe(200);
    expect(res.body.queue.map((m: { content: string }) => m.content)).toEqual([
      'three',
      'one',
      'two',
    ]);
    expect((await readQueue()).map((m) => m.content)).toEqual(['three', 'one', 'two']);
  });

  it('rewords and moves in one call', async () => {
    const one = await post('one', 'client-a');
    const two = await post('two', 'client-a');

    const res = await request(server)
      .patch(`/api/sessions/${SESSION_ID}/queue/${two.messageId}`)
      .send({ content: 'two, reworded', move: { before: one.messageId } });

    expect(res.status).toBe(200);
    expect(res.body.queue.map((m: { content: string }) => m.content)).toEqual([
      'two, reworded',
      'one',
    ]);
  });

  it('404s an id that is not on this queue', async () => {
    await post('something', 'client-a');

    const res = await request(server)
      .patch(`/api/sessions/${SESSION_ID}/queue/no-such-message`)
      .send({ content: 'hello?' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUEUED_MESSAGE_NOT_FOUND');
  });

  it('404s a move anchored on a message from ANOTHER session', async () => {
    // A queue can only be reordered against itself; silently reparenting a
    // message into another session's queue would be the worst possible reading.
    const mine = await post('mine', 'client-a');
    const elsewhere = store.enqueue({
      sessionId: OTHER_SESSION_ID,
      content: 'elsewhere',
      clientId: 'client-b',
    });

    const res = await request(server)
      .patch(`/api/sessions/${SESSION_ID}/queue/${mine.messageId}`)
      .send({ move: { after: elsewhere.id } });

    expect(res.status).toBe(404);
    // The message itself is untouched and still on ITS queue — the refusal was
    // about the anchor, not about a queue that had gone missing.
    expect((await readQueue()).map((m) => m.id)).toEqual([mine.messageId]);
  });

  it('refuses a reword+move together when the move anchor is bogus, and leaves the words untouched', async () => {
    // A PATCH that reworded AND moved must not commit the reword before the
    // move is checked: a refused move that already landed the reword would
    // answer 404 while quietly changing what the message says (DOR-1178).
    const mine = await post('original words', 'client-a');

    const res = await request(server)
      .patch(`/api/sessions/${SESSION_ID}/queue/${mine.messageId}`)
      .send({ content: 'hijacked words', move: { before: 'no-such-message' } });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUEUED_MESSAGE_NOT_FOUND');
    expect((await readQueue())[0]?.content).toBe('original words');
  });

  it('400s a body that asks for nothing, and an empty body', async () => {
    const mine = await post('unchanged', 'client-a');

    const nothing = await request(server)
      .patch(`/api/sessions/${SESSION_ID}/queue/${mine.messageId}`)
      .send({});
    expect(nothing.status).toBe(400);
    expect(nothing.body.code).toBe('VALIDATION_ERROR');

    // Express 5 leaves `req.body` undefined for a body-less request; that is a
    // 400 like any other malformed body, never a crash.
    const empty = await request(server).patch(
      `/api/sessions/${SESSION_ID}/queue/${mine.messageId}`
    );
    expect(empty.status).toBe(400);

    expect((await readQueue())[0]?.content).toBe('unchanged');
  });
});

describe('DELETE /api/sessions/:id/queue/:messageId', () => {
  it('lets a second window remove what the first one queued', async () => {
    const mine = await post('never mind', 'client-a');
    await post('but keep this', 'client-a');

    const res = await request(server)
      .delete(`/api/sessions/${SESSION_ID}/queue/${mine.messageId}`)
      .set('X-Client-Id', 'client-b');

    expect(res.status).toBe(200);
    expect(res.body.queue.map((m: { content: string }) => m.content)).toEqual(['but keep this']);
    expect((await readQueue()).map((m) => m.content)).toEqual(['but keep this']);
  });

  it('404s an id that is not on this queue, including one already removed', async () => {
    const mine = await post('going', 'client-a');
    expect(
      (await request(server).delete(`/api/sessions/${SESSION_ID}/queue/${mine.messageId}`)).status
    ).toBe(200);

    const again = await request(server).delete(
      `/api/sessions/${SESSION_ID}/queue/${mine.messageId}`
    );
    expect(again.status).toBe(404);
    expect(again.body.code).toBe('QUEUED_MESSAGE_NOT_FOUND');
  });

  it('rejects a malformed session id', async () => {
    const res = await request(server).delete('/api/sessions/not-a-uuid/queue/whatever');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SESSION_ID');
  });
});

describe('a row this process ADOPTED after a restart (task 2.5)', () => {
  it('is editable and removable through the same routes as one it accepted itself', async () => {
    // A row with no pending entry behind it is exactly what a restart leaves:
    // the words survived on disk, the in-memory entry that runs them did not.
    // `adoptQueuedMessages` wraps a fresh entry around it on the next dispatch,
    // and from the routes' side the result must be indistinguishable from a
    // message this process accepted itself — a person who reloads and finds
    // their queue cannot be told the messages in it are now read-only.
    const survivor = store.enqueue({
      sessionId: SESSION_ID,
      content: 'typed before the server restarted',
      clientId: 'client-a',
    });

    // Any dispatch adopts. This one queues behind the turn the fixture started,
    // so the adopted row is still waiting when the routes reach it.
    await post('typed after the server came back', 'client-b');

    // One queue: the survivor keeps its own id, its position, and the client
    // that first typed it.
    expect(await readQueue()).toMatchObject([
      { id: survivor.id, content: 'typed before the server restarted', enqueuedBy: 'client-a' },
      { content: 'typed after the server came back', enqueuedBy: 'client-b' },
    ]);

    const patched = await request(server)
      .patch(`/api/sessions/${SESSION_ID}/queue/${survivor.id}`)
      .set('X-Client-Id', 'client-b')
      .send({ content: 'reworded after the restart' });
    expect(patched.status).toBe(200);
    expect(patched.body.message.content).toBe('reworded after the restart');

    const removed = await request(server)
      .delete(`/api/sessions/${SESSION_ID}/queue/${survivor.id}`)
      .set('X-Client-Id', 'client-b');
    expect(removed.status).toBe(200);
    expect(removed.body.queue.map((m: { content: string }) => m.content)).toEqual([
      'typed after the server came back',
    ]);

    // Removing it really cancelled its ADOPTED dispatch: when the turn ahead
    // ends, only the message still queued runs. An adopted entry left armed
    // would have fired the removed message anyway.
    releaseTurn();
    await vi.waitFor(() => expect(fakeRuntime.sendMessage).toHaveBeenCalledTimes(2));
    // Let the queue drain completely before judging: a stale entry sorts BEHIND
    // every message that still has a row, so it would fire after the assertion
    // above rather than instead of it, and a count taken too early cannot tell
    // the two apart.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fakeRuntime.sendMessage).toHaveBeenCalledTimes(2);
    expect(fakeRuntime.sendMessage).not.toHaveBeenCalledWith(
      SESSION_ID,
      'reworded after the restart',
      expect.anything()
    );
  });
});

describe('POST /api/sessions/:id/messages — the receipt', () => {
  it('numbers the queue as it grows, and never refuses for being busy', async () => {
    expect((await post('first', 'client-a')).queuePosition).toBe(1);
    expect((await post('second', 'client-b')).queuePosition).toBe(2);
    expect((await post('third', 'client-b')).queuePosition).toBe(3);
    expect(await readQueue()).toHaveLength(3);
  });

  it('says a steer was downgraded to a queue rather than quietly doing something else', async () => {
    const res = await request(server)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'client-b')
      .send({ content: 'change course', disposition: 'steer' });

    expect(res.status).toBe(202);
    expect(res.body.outcome).toMatchObject({
      requested: 'steer',
      applied: 'queue',
      degradedBecause: 'unsupported',
    });
  });

  it('rejects an empty body with 400, not a crash (Express 5)', async () => {
    const res = await request(server).post(`/api/sessions/${SESSION_ID}/messages`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/sessions/:id/interrupt — Stop clears the queue (task 4.7)', () => {
  it('empties the queue and hands every message back, in order', async () => {
    fakeRuntime.interruptQuery.mockResolvedValue(mockInterruptReceipt('acked'));
    await post('one', 'client-a');
    await post('two', 'client-b');
    await post('three', 'client-a');

    const res = await request(server).post(`/api/sessions/${SESSION_ID}/interrupt`);

    expect(res.status).toBe(200);
    expect(res.body.receipt.outcome).toBe('acked');
    expect(res.body.cancelledQueued.map((m: { content: string }) => m.content)).toEqual([
      'one',
      'two',
      'three',
    ]);
    // Every window reads the same empty queue afterward.
    expect(await readQueue()).toEqual([]);
  });

  it('makes no promise it cannot keep: still clears the queue when the stop found nothing', async () => {
    // A turn that already finished resolves `not-running` — nothing failed, and
    // nothing was stopped. The DorkOS queue is ours and is cleared regardless;
    // the response never claims more than happened.
    fakeRuntime.interruptQuery.mockResolvedValue(mockInterruptReceipt('not-running'));
    await post('one', 'client-a');
    await post('two', 'client-a');

    const res = await request(server).post(`/api/sessions/${SESSION_ID}/interrupt`);

    expect(res.status).toBe(200);
    expect(res.body.receipt.outcome).toBe('not-running');
    expect(res.body.cancelledQueued.map((m: { content: string }) => m.content)).toEqual([
      'one',
      'two',
    ]);
    expect(await readQueue()).toEqual([]);
  });

  it('an empty queue interrupts with nothing to hand back', async () => {
    fakeRuntime.interruptQuery.mockResolvedValue(mockInterruptReceipt('acked'));

    const res = await request(server).post(`/api/sessions/${OTHER_SESSION_ID}/interrupt`);

    expect(res.status).toBe(200);
    expect(res.body.receipt.outcome).toBe('acked');
    expect(res.body.cancelledQueued).toEqual([]);
  });

  it('still hands the cleared messages back when the interrupt itself throws', async () => {
    // The queue was already emptied before the interrupt runs. A thrown
    // interrupt must not 500 those rows into the void — the person confirmed
    // "put N back", and dropping them would break the one promise this feature
    // exists to keep. It reports the `failed` receipt and still returns the
    // words — and `failed` rather than `not-running`, because nothing ended the
    // turn and pressing Stop again is the person's only move.
    fakeRuntime.interruptQuery.mockRejectedValue(new Error('interrupt wedged'));
    await post('one', 'client-a');
    await post('two', 'client-a');

    const res = await request(server).post(`/api/sessions/${SESSION_ID}/interrupt`);

    expect(res.status).toBe(200);
    expect(res.body.receipt).toEqual({
      outcome: 'failed',
      reason: 'delivery-failed',
      runtime: 'fake',
    });
    expect(res.body.cancelledQueued.map((m: { content: string }) => m.content)).toEqual([
      'one',
      'two',
    ]);
    expect(await readQueue()).toEqual([]);
  });
});

describe('POST /api/sessions/:id/tasks/:taskId/stop — the same receipt vocabulary', () => {
  it('answers the receipt for a stop that reached a real task', async () => {
    fakeRuntime.stopTask.mockResolvedValue(mockInterruptReceipt('acked'));

    const res = await request(server).post(`/api/sessions/${SESSION_ID}/tasks/task-1/stop`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      receipt: { outcome: 'acked', runtime: 'fake' },
      taskId: 'task-1',
    });
  });

  it('keeps `unconfirmed` a 200, not the 409 that would claim the task was already stopped', async () => {
    // The distinction the boolean could not carry: the CLI did not answer, so
    // the task is very likely STILL RUNNING. A 409 saying "already stopped"
    // would be the exact lie the receipt vocabulary exists to remove, and the
    // surface has to be able to say "stop requested" about it instead.
    fakeRuntime.stopTask.mockResolvedValue(mockInterruptReceipt('unconfirmed'));
    fakeRuntime.hasSession.mockReturnValue(true);

    const res = await request(server).post(`/api/sessions/${SESSION_ID}/tasks/task-1/stop`);

    expect(res.status).toBe(200);
    expect(res.body.receipt.outcome).toBe('unconfirmed');
  });

  it('keeps the 409 for `not-running` on a live session, and the 404 without one', async () => {
    fakeRuntime.stopTask.mockResolvedValue(mockInterruptReceipt('not-running'));

    fakeRuntime.hasSession.mockReturnValue(true);
    const conflict = await request(server).post(`/api/sessions/${SESSION_ID}/tasks/gone/stop`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('TASK_NOT_RUNNING');

    fakeRuntime.hasSession.mockReturnValue(false);
    const missing = await request(server).post(`/api/sessions/${SESSION_ID}/tasks/gone/stop`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('SESSION_NOT_FOUND');
  });
});
