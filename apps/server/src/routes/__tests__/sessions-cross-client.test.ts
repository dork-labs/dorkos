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
 * 3. A second client's mid-turn POST conflicts (409 SESSION_LOCKED, naming the
 *    holder) while the write-lock is fresh, and is ACCEPTED (202) once the lock
 *    TTL lapses — the acceptance run's observed "mid-turn 202 steer" was this
 *    takeover: the tool-heavy turn had outlived LOCK_TTL_MS. What the SDK does
 *    with the second resume (deliver as a steer) is Claude-CLI behavior and not
 *    pinnable here; the route-level takeover contract is. DOR-82 will replace
 *    this incidental semantics with explicit queue/steer/interrupt dispositions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
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
import { createApp, finalizeApp } from '../../app.js';
import { SESSIONS } from '../../config/constants.js';
import {
  getOrCreateProjector,
  peekProjector,
  disposeProjector,
} from '../../services/session/session-state-projector.js';
import { SessionLockManager } from '../../services/session/session-lock.js';
import { attachEventStream } from './helpers/trigger-turn-helpers.js';

const app = createApp();
finalizeApp(app);

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
    const a = attachEventStream(app, SESSION_ID);
    await a.ready;
    const post = await request(app)
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
    const b = attachEventStream(app, SESSION_ID);
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

    const a = attachEventStream(app, SESSION_ID);
    await a.ready;
    const post = await request(app)
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
    const b = attachEventStream(app, SESSION_ID);
    await b.ready;

    // The OTHER client approves — no lock applies to interaction resolution.
    const approve = await request(app)
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
  it('conflicts (409, naming the holder) while the lock is fresh; accepted once the TTL lapses', async () => {
    // Real lock semantics (not a canned mock): the route + triggerTurn
    // composition against the actual SessionLockManager, including its TTL
    // expiry — the mechanism behind the acceptance run's observed mid-turn 202.
    const lockManager = new SessionLockManager();
    fakeRuntime.acquireLock.mockImplementation((sid, cid, res, token) =>
      lockManager.acquireLock(sid, cid, res, token)
    );
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
      // The takeover turn (client B) after the TTL lapses.
      async function* () {
        yield { type: 'text_delta', data: { text: 'takeover reply' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const first = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'client-a')
      .send({ content: 'long turn' });
    expect(first.status).toBe(202);

    // Fresh lock → the second client conflicts, told WHO holds it.
    const conflict = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'client-b')
      .send({ content: 'second client message' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('SESSION_LOCKED');
    expect(conflict.body.lockedBy).toBe('client-a');
    expect(fakeRuntime.sendMessage).toHaveBeenCalledTimes(1);

    // Force the lock past its TTL — the acceptance run's real-world condition:
    // a tool-heavy turn (pending approval, subagents) outlives LOCK_TTL_MS
    // while still streaming. Manipulates acquiredAt the same way the lock
    // manager's own unit tests do.
    const locks = (lockManager as unknown as { locks: Map<string, { acquiredAt: number }> }).locks;
    locks.get(SESSION_ID)!.acquiredAt -= SESSIONS.LOCK_TTL_MS + 1;

    // Expired lock → the second client's POST is ACCEPTED and its message is
    // dispatched to the runtime mid-turn. (The Claude CLI delivers such a
    // resume-during-active-turn as a steer; that half lives outside the server.)
    const takeover = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'client-b')
      .send({ content: 'steer content' });
    expect(takeover.status).toBe(202);
    await vi.waitFor(() => expect(fakeRuntime.sendMessage).toHaveBeenCalledTimes(2));
    expect(fakeRuntime.sendMessage).toHaveBeenLastCalledWith(
      SESSION_ID,
      'steer content',
      expect.anything()
    );

    // Drain both detached turns so the afterEach dispose finds them settled.
    releaseTurn();
    await vi.waitFor(() => expect(fakeRuntime.releaseLock).toHaveBeenCalledTimes(2));
  });
});
