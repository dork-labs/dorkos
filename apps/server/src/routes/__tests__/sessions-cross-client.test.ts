/**
 * Cross-client behaviors over the durable session contract (spec
 * chat-stream-reconnection, task #17). Pins what the acceptance run
 * (test-results/session-switch-test/20260611-145454.md, local) verified by
 * hand, over the real HTTP routes + the REAL projector registry:
 *
 * 1. Two clients on one session CONVERGE — one subscribed before the turn (all
 *    live), one cold-connecting mid-turn (snapshot prefix + live continuation)
 *    end at the same cursor with the same reconstructed content, gap-free.
 * 2. An interaction resolved from a second surface drops as
 *    `interaction_resolved` on EVERY consumer's stream (other windows included).
 * 3. A second client's mid-turn POST is ACCEPTED (202) and queued: both windows
 *    see the same waiting message, and it runs when the first turn ends.
 *
 *    This clause has been rewritten twice, and both lessons are worth keeping
 *    because each one read like a feature at the time.
 *
 *    DOR-782: the lock TTL used to be measured from ACQUISITION, so any turn
 *    outliving five minutes — which a room turn does routinely, and a tool-heavy
 *    one often — was stealable while it was visibly streaming. The acceptance
 *    run's "mid-turn 202 steer" was that: not a designed takeover, a live turn
 *    losing its lock. The TTL now measures INACTIVITY (see `LockActivity`), so a
 *    working turn keeps its lock however long it runs and an abandoned one is
 *    still reclaimed a TTL later. **That machinery is unchanged by the rewrite
 *    below and is still the only thing that reclaims a dark turn.**
 *
 *    DOR-1131: what changed is the ANSWER a second window gets. It used to be
 *    409 SESSION_LOCKED — the person's words bounced back at them because the
 *    agent was busy, which is the one moment somebody most wants to say
 *    something. The message is now accepted onto the session's queue, and the
 *    lock stops being "who may send" and becomes the mutex one turn window
 *    holds. The old clause also required the first turn to go DARK before a
 *    second message could be accepted; that is no longer a precondition for
 *    anything, so it is gone rather than adapted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { SseResponse } from '@dorkos/shared/agent-runtime';
import type { SessionEvent, SessionSnapshot } from '@dorkos/shared/session-stream';
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
import { createTestDb } from '@dorkos/test-utils/db';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createApp, finalizeApp } from '../../app.js';
import {
  getOrCreateProjector,
  peekProjector,
  disposeProjector,
} from '../../services/session/session-state-projector.js';
import { SessionLockManager } from '../../services/session/session-lock.js';
import {
  MessageQueueStore,
  setMessageQueueStore,
} from '../../services/session/message-queue-store.js';
import { resetMessageDispatcher } from '../../services/session/message-dispatcher.js';
import type { LockActivity } from '../../services/session/session-lock.js';
import { attachEventStream } from './helpers/trigger-turn-helpers.js';

const app = createApp();
finalizeApp(app);

/**
 * ONE listener for the whole file (DOR-483). Requests and `/events` attachments
 * both target `server`, never `app`: handed a non-listening app, supertest binds
 * and frees an ephemeral port per request and the stream helpers used to do the
 * same, so a pooled keep-alive socket for a reclaimed port could land on the
 * wrong server. See {@link listeningServer}.
 */
const server = listeningServer(app);

const SESSION_ID = '00000000-0000-4000-8000-0000000000aa';

/** Extract the live (non-snapshot) SessionEvents from a collected stream. */
function liveEvents(frames: { event: string; data: unknown }[]): SessionEvent[] {
  return frames.filter((f) => f.event !== 'snapshot').map((f) => f.data as SessionEvent);
}

/**
 * Assert seqs are EXACTLY the consecutive integers starting at `start` — the
 * literal no-gaps/no-dupes contract. A consumer subscribed from cursor N must
 * receive N+1, N+2, … with nothing silently dropped (a text-equality check
 * alone would miss a dropped non-text event).
 */
function expectConsecutiveFrom(seqs: number[], start: number): void {
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => start + i));
}

beforeEach(() => {
  // The real store, because "both windows see the same queue" is the promise and
  // an in-memory stand-in would be asserting it against itself.
  setMessageQueueStore(new MessageQueueStore(createTestDb()));
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
  fakeRuntime.acquireLock.mockReturnValue(true);
  fakeRuntime.isLocked.mockReturnValue(false);
  fakeRuntime.getLockInfo.mockReturnValue(null);
  fakeRuntime.hasSession.mockReturnValue(true);
  fakeRuntime.getInternalSessionId.mockReturnValue(SESSION_ID);
  fakeRuntime.getSessionSnapshot.mockImplementation((_ctx, sessionId) =>
    getOrCreateProjector(sessionId).buildSnapshot(async () => [])
  );
  fakeRuntime.subscribeSession = vi.fn((_ctx, sessionId, sinceCursor, signal) =>
    getOrCreateProjector(sessionId).subscribe(sinceCursor, signal)
  );
});

afterEach(() => {
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(SESSION_ID);
});

describe('cross-client: two consumers on one session', () => {
  it('a live-from-start consumer and a cold mid-turn consumer converge gap-free', async () => {
    // The core multi-window contract (DOR-73 generalized): window A triggered
    // the turn and watches it live; window B opens the same session mid-turn
    // and must reconstruct the identical state from snapshot + continuation.
    let releaseTurn!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    fakeRuntime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'first-half ' } } as StreamEvent;
        await gate;
        yield { type: 'text_delta', data: { text: 'second-half' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    // Client A: subscribe-first, then trigger.
    const a = attachEventStream(server, SESSION_ID);
    await a.ready;
    const post = await request(server)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'client-a')
      .send({ content: 'Hello' });
    expect(post.status).toBe(202);

    // Wait until the first half is INGESTED (not merely the turn opened), so
    // B's cold snapshot must carry a non-empty in-progress prefix.
    await vi.waitFor(async () => {
      const snap = (await peekProjector(SESSION_ID)!.buildSnapshot(
        async () => []
      )) as SessionSnapshot;
      expect(snap.inProgressTurn?.some((e) => e.type === 'text_delta')).toBe(true);
    });

    // Client B: cold connect mid-turn.
    const b = attachEventStream(server, SESSION_ID);
    await b.ready;
    releaseTurn();

    const [aRes, bRes] = await Promise.all([a.done, b.done]);

    // A saw the whole turn live, with every event present and in order:
    // consecutive seqs from its own (empty, cursor-0) snapshot.
    const aSnapshot = aRes.frames.find((f) => f.event === 'snapshot')!.data as SessionSnapshot;
    const aEvents = liveEvents(aRes.frames);
    const aDeltas = aEvents.filter((e) => e.type === 'text_delta').map((e) => e.text);
    expect(aDeltas).toEqual(['first-half ', 'second-half']);
    expectConsecutiveFrom(
      aEvents.map((e) => e.seq),
      aSnapshot.cursor + 1
    );

    // B reconstructs the same content: snapshot prefix + live continuation.
    const bSnapshot = bRes.frames.find((f) => f.event === 'snapshot')!.data as SessionSnapshot;
    const prefixDeltas = (bSnapshot.inProgressTurn ?? [])
      .filter((e) => e.type === 'text_delta')
      .map((e) => e.text);
    const bEvents = liveEvents(bRes.frames);
    const bDeltas = bEvents.filter((e) => e.type === 'text_delta').map((e) => e.text);
    expect([...prefixDeltas, ...bDeltas].join('')).toBe('first-half second-half');

    // Gap-free handoff: B's live frames are exactly cursor+1, cursor+2, … (the
    // capture→subscribe race is closed; nothing dropped, nothing duplicated),
    // and both consumers end on the SAME final cursor — converged.
    expectConsecutiveFrom(
      bEvents.map((e) => e.seq),
      bSnapshot.cursor + 1
    );
    expect(bEvents.at(-1)!.seq).toBe(aEvents.at(-1)!.seq);
    // Both observed the same settle.
    expect(aEvents.at(-1)!.type).toBe('turn_end');
    expect(bEvents.at(-1)!.type).toBe('turn_end');
  });

  it('an approval resolved from a SECOND surface emits interaction_resolved on every consumer', async () => {
    // The cross-surface approve path verified live in the acceptance run:
    // window A holds the pending card; the approval lands from window B; both
    // streams must drop the card via the same seq'd interaction_resolved (no
    // window left with an answerable ghost). The approve seam is wired to the
    // REAL projector resolution path — the identical call the Claude adapter
    // makes — so the pin covers the projector fan-out, not adapter internals.
    fakeRuntime.approveTool.mockImplementation((sessionId: string, toolCallId: string) => {
      const projector = peekProjector(sessionId);
      if (!projector) return false;
      projector.resolveInteraction(toolCallId, 'approved');
      return true;
    });
    let releaseTurn!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    fakeRuntime.withScenarios([
      async function* () {
        yield {
          type: 'approval_required',
          data: { toolCallId: 'tool-1', toolName: 'Bash', input: 'ls', timeoutMs: 60_000 },
        } as StreamEvent;
        await gate;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const a = attachEventStream(server, SESSION_ID);
    await a.ready;
    const post = await request(server)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'client-a')
      .send({ content: 'run something' });
    expect(post.status).toBe(202);

    // Wait for the pending interaction, then open the second surface.
    await vi.waitFor(async () => {
      const snap = (await peekProjector(SESSION_ID)!.buildSnapshot(
        async () => []
      )) as SessionSnapshot;
      expect(snap.pendingInteractions).toHaveLength(1);
    });
    const b = attachEventStream(server, SESSION_ID);
    await b.ready;

    // The OTHER client approves — no lock applies to interaction resolution.
    const approve = await request(server)
      .post(`/api/sessions/${SESSION_ID}/approve`)
      .set('X-Client-Id', 'client-b')
      .send({ toolCallId: 'tool-1' });
    expect(approve.status).toBe(200);
    releaseTurn();

    const [aRes, bRes] = await Promise.all([a.done, b.done]);

    // B connected mid-block: its snapshot carried the recoverable pending card.
    const bSnapshot = bRes.frames.find((f) => f.event === 'snapshot')!.data as SessionSnapshot;
    expect(bSnapshot.pendingInteractions).toHaveLength(1);
    expect(bSnapshot.pendingInteractions[0]).toMatchObject({ id: 'tool-1' });

    // EVERY consumer saw the resolution on its live stream.
    for (const res of [aRes, bRes]) {
      const resolved = liveEvents(res.frames).find((e) => e.type === 'interaction_resolved');
      expect(resolved).toMatchObject({ id: 'tool-1', resolution: 'approved' });
    }
  });
});

describe('cross-client: second-client POST during an open turn', () => {
  it('accepts it, queues it where both windows can see it, and runs it when the first turn ends', async () => {
    // Real lock semantics (not a canned mock): the route + dispatcher +
    // triggerTurn composition against the actual SessionLockManager. The lock is
    // still here and still does its job — it is simply no longer an answer this
    // route gives anybody.
    const lockManager = new SessionLockManager();
    // triggerTurn's DetachedTurnLifecycle, which is also the lock's liveness
    // witness (DOR-782). Held so this test can assert the first turn NEVER lost
    // its lock while it was working.
    let holder: (SseResponse & Partial<LockActivity>) | undefined;
    fakeRuntime.acquireLock.mockImplementation((sid, cid, res, token) => {
      const acquired = lockManager.acquireLock(sid, cid, res, token);
      // Only a SUCCESSFUL acquisition installs a holder; a refused attempt's
      // lifecycle is discarded and must not overwrite the real one.
      if (acquired) holder = res;
      return acquired;
    });
    fakeRuntime.releaseLock.mockImplementation((sid, cid, token) =>
      lockManager.releaseLock(sid, cid, token)
    );
    fakeRuntime.getLockInfo.mockImplementation((sid) => lockManager.getLockInfo(sid));

    let releaseTurn!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    fakeRuntime.withScenarios([
      // The long-running first turn (client A) — parked open at the gate.
      async function* () {
        yield { type: 'text_delta', data: { text: 'long work ' } } as StreamEvent;
        await gate;
        yield { type: 'done', data: {} } as StreamEvent;
      },
      // The queued message's turn (client B), once the first one ends.
      async function* () {
        yield { type: 'text_delta', data: { text: 'queued reply' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const first = await request(server)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'client-a')
      .send({ content: 'long turn' });
    expect(first.status).toBe(202);

    // The second window, mid-turn. Accepted — with a receipt naming the message
    // and where it sits — rather than refused. That this request SETTLES AT ALL
    // is half the point: the turn ahead of it is parked on a gate this test has
    // not opened, so an answer that waited for it could not arrive here.
    const second = await request(server)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'client-b')
      .send({ content: 'second client message' });
    expect(second.status).toBe(202);
    expect(second.body.messageId).toEqual(expect.any(String));
    expect(second.body.queuePosition).toBe(1);
    expect(second.body.outcome).toMatchObject({ requested: 'queue', applied: 'queue' });
    // Queued, not started: the first turn is still the only one running.
    expect(fakeRuntime.sendMessage).toHaveBeenCalledTimes(1);
    // And the first turn kept its lock throughout (DOR-782): nothing about
    // accepting a second message takes the session away from the turn that has
    // it. `lastActivityAt` is the witness the lock consults.
    expect(holder?.lastActivityAt).toBeTypeOf('function');
    expect(lockManager.getLockInfo(SESSION_ID)?.clientId).toBe('client-a');

    // ONE queue, both windows. Either client reads the same waiting message,
    // and neither reads it as "theirs" or "not theirs" — `enqueuedBy` says who
    // typed it and nothing refuses the other window.
    for (const clientId of ['client-a', 'client-b']) {
      const queue = await request(server)
        .get(`/api/sessions/${SESSION_ID}/queue`)
        .set('X-Client-Id', clientId);
      expect(queue.status).toBe(200);
      expect(queue.body.queue).toMatchObject([
        { id: second.body.messageId, content: 'second client message', enqueuedBy: 'client-b' },
      ]);
    }

    // The first turn ends. THAT is what releases the queue — and the message
    // runs without anybody sending it again.
    releaseTurn();
    await vi.waitFor(() => expect(fakeRuntime.sendMessage).toHaveBeenCalledTimes(2));
    expect(fakeRuntime.sendMessage).toHaveBeenLastCalledWith(
      SESSION_ID,
      'second client message',
      expect.anything()
    );
    await vi.waitFor(async () => {
      const queue = await request(server).get(`/api/sessions/${SESSION_ID}/queue`);
      expect(queue.body.queue).toEqual([]);
    });

    // Drain both detached turns so the afterEach dispose finds them settled.
    await vi.waitFor(() => expect(fakeRuntime.releaseLock).toHaveBeenCalledTimes(2));
  });
});
