/**
 * SessionLockManager — who may hold a session, and who may let it go.
 *
 * Two rules meet here. A LIVE lock is never replaced, not even for the client
 * holding it (DOR-1088): the same-client re-acquire used to succeed silently, so
 * one browser tab — one client id for its whole life — could start a second turn
 * beside its own running one. And a release is matched on the acquisition's
 * token (I1), so a turn that comes back late cannot drop a lock it no longer
 * holds; that is still reachable through the expiry path, where a dark holder's
 * lock is legitimately re-taken by the same client and the dark turn then wakes
 * up and releases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SseResponse } from '@dorkos/shared/agent-runtime';
import { SessionLockManager } from '../session-lock.js';
import type { LockActivity } from '../session-lock.js';
import { SESSIONS } from '../../../config/constants.js';

const SESSION = 'sess-1';
const CLIENT = 'client-A';

/** A no-op SseResponse — the lock manager only registers a close handler on it. */
function fakeRes(): SseResponse {
  return { on: vi.fn() };
}

/** An SseResponse that also vouches for its holder's liveness (DOR-782). */
function livingRes(): SseResponse & LockActivity & { touch(): void } {
  let activityAt = Date.now();
  return {
    on: vi.fn(),
    touch: () => {
      activityAt = Date.now();
    },
    lastActivityAt: () => activityAt,
  };
}

describe('SessionLockManager — one live holder (DOR-1088)', () => {
  it('refuses a live lock to the client that already holds it', () => {
    // The hole this closed: the cockpit uses ONE client id per tab, so a second
    // POST from the same tab — which the composer's auto-flush sends the moment
    // it reads idle — walked straight through and started a second stream on a
    // session that already had one. Same-client triggers wait at the turn queue
    // now; this refusal is what makes that queue the only way in.
    const mgr = new SessionLockManager();
    expect(mgr.acquireLock(SESSION, CLIENT, fakeRes(), Symbol('turn-A'))).toBe(true);
    expect(mgr.acquireLock(SESSION, CLIENT, fakeRes(), Symbol('turn-B'))).toBe(false);
    // The FIRST turn still holds it — the refused attempt changed nothing.
    expect(mgr.getLockInfo(SESSION)?.clientId).toBe(CLIENT);
  });

  it('hands the session back to the same client once the first turn released', () => {
    // The queue's happy path: turn A finishes, releases, and turn B — same tab,
    // same client id — takes the lock it was waiting for.
    const mgr = new SessionLockManager();
    const tokenA = Symbol('turn-A');
    expect(mgr.acquireLock(SESSION, CLIENT, fakeRes(), tokenA)).toBe(true);
    mgr.releaseLock(SESSION, CLIENT, tokenA);
    expect(mgr.acquireLock(SESSION, CLIENT, fakeRes(), Symbol('turn-B'))).toBe(true);
  });
});

describe('SessionLockManager — token-matched release (I1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT drop a newer same-client lock when a stale token releases', () => {
    const mgr = new SessionLockManager();
    const tokenA = Symbol('turn-A');
    const tokenB = Symbol('turn-B');

    // Turn A acquires and then goes dark — a turn whose process vanished without
    // its close handler firing. Past the TTL its lock is reclaimable, and the
    // client that owns the session is the one that reclaims it.
    expect(mgr.acquireLock(SESSION, CLIENT, fakeRes(), tokenA)).toBe(true);
    vi.advanceTimersByTime(SESSIONS.LOCK_TTL_MS + 1);
    expect(mgr.acquireLock(SESSION, CLIENT, fakeRes(), tokenB)).toBe(true);

    // Turn A comes back to life and releases. It must be a NO-OP — releasing
    // turn A's token must not drop turn B's lock.
    mgr.releaseLock(SESSION, CLIENT, tokenA);
    expect(mgr.isLocked(SESSION)).toBe(true);
    expect(mgr.getLockInfo(SESSION)?.clientId).toBe(CLIENT);

    // Turn B's own releaser correctly drops the lock it holds.
    mgr.releaseLock(SESSION, CLIENT, tokenB);
    expect(mgr.isLocked(SESSION)).toBe(false);
  });

  it('a tokenless release still honors the legacy clientId-only match', () => {
    const mgr = new SessionLockManager();
    expect(mgr.acquireLock(SESSION, CLIENT, fakeRes())).toBe(true);
    // No token supplied on either side: clientId match alone releases.
    mgr.releaseLock(SESSION, CLIENT);
    expect(mgr.isLocked(SESSION)).toBe(false);
  });

  it('a release from a different client is a no-op regardless of token', () => {
    const mgr = new SessionLockManager();
    const token = Symbol('turn');
    expect(mgr.acquireLock(SESSION, CLIENT, fakeRes(), token)).toBe(true);
    mgr.releaseLock(SESSION, 'other-client', token);
    expect(mgr.isLocked(SESSION)).toBe(true);
  });
});

describe('SessionLockManager — activity-extended TTL (DOR-782)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires a lock whose holder never showed proof of life', () => {
    const mgr = new SessionLockManager();
    expect(mgr.acquireLock(SESSION, CLIENT, fakeRes())).toBe(true);

    vi.advanceTimersByTime(SESSIONS.LOCK_TTL_MS + 1);
    expect(mgr.isLocked(SESSION)).toBe(false);
    expect(mgr.getLockInfo(SESSION)).toBeNull();
    // A second client may now take it — the pre-DOR-782 behavior, unchanged for
    // a holder that went dark.
    expect(mgr.acquireLock(SESSION, 'client-B', fakeRes())).toBe(true);
  });

  it('holds a lock indefinitely while its holder keeps working past the TTL', () => {
    const mgr = new SessionLockManager();
    const res = livingRes();
    expect(mgr.acquireLock(SESSION, CLIENT, res)).toBe(true);

    // A room turn legally runs an hour, emitting events throughout. Twelve
    // TTL windows of steady work must not make it stealable.
    for (let i = 0; i < 12; i += 1) {
      vi.advanceTimersByTime(SESSIONS.LOCK_TTL_MS - 1);
      res.touch();
      expect(mgr.isLocked(SESSION)).toBe(true);
      expect(mgr.acquireLock(SESSION, 'client-B', fakeRes())).toBe(false);
    }
    expect(mgr.getLockInfo(SESSION)?.clientId).toBe(CLIENT);
  });

  it('expires one TTL after the holder goes quiet, not one TTL after acquisition', () => {
    const mgr = new SessionLockManager();
    const res = livingRes();
    expect(mgr.acquireLock(SESSION, CLIENT, res)).toBe(true);

    // Work for two full TTLs, then fall silent.
    vi.advanceTimersByTime(SESSIONS.LOCK_TTL_MS * 2);
    res.touch();
    expect(mgr.isLocked(SESSION)).toBe(true);

    vi.advanceTimersByTime(SESSIONS.LOCK_TTL_MS);
    expect(mgr.isLocked(SESSION)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(mgr.isLocked(SESSION)).toBe(false);
  });

  it('reclaims a lock whose holder is parked on a wait that has itself expired', () => {
    // DOR-782 regression. `waitingOnPerson` reports liveness with no clock of
    // its own, so a holder whose pending interaction STRANDS (an SDK stream that
    // throws with an approval outstanding never re-drains its queue) would hold
    // the lock for the process's lifetime. The projector bounds that by the
    // interaction timeout; this pins that the lock honors the bound rather than
    // trusting the probe forever.
    const mgr = new SessionLockManager();
    let personIsWaiting = true;
    const res: SseResponse & LockActivity = {
      on: vi.fn(),
      lastActivityAt: () => (personIsWaiting ? Date.now() : acquiredMoment),
    };
    const acquiredMoment = Date.now();
    expect(mgr.acquireLock(SESSION, CLIENT, res)).toBe(true);

    // While someone really is waiting, the lock survives any number of windows.
    for (let i = 0; i < 100; i += 1) {
      vi.advanceTimersByTime(SESSIONS.LOCK_TTL_MS);
      expect(mgr.isLocked(SESSION)).toBe(true);
    }

    // The wait expires (the projector stops counting it). The holder is now
    // silent, so one TTL later the lock is reclaimable.
    personIsWaiting = false;
    expect(mgr.isLocked(SESSION)).toBe(false);
    expect(mgr.acquireLock(SESSION, 'client-B', fakeRes())).toBe(true);
  });

  it('cleanup() reaps a dark lock but spares a live one', () => {
    const mgr = new SessionLockManager();
    const live = livingRes();
    expect(mgr.acquireLock('live-session', CLIENT, live)).toBe(true);
    expect(mgr.acquireLock('dark-session', CLIENT, fakeRes())).toBe(true);

    vi.advanceTimersByTime(SESSIONS.LOCK_TTL_MS + 1);
    live.touch();
    mgr.cleanup();

    expect(mgr.isLocked('live-session')).toBe(true);
    expect(mgr.isLocked('dark-session')).toBe(false);
  });
});
