/**
 * SessionLockManager — token-matched release (I1).
 *
 * With detached turns, a second turn for the same (session, client) can start
 * (compose-next auto-flush) before the prior detached turn settles. A purely
 * (sessionId, clientId)-matched release from the FIRST turn would then delete
 * the SECOND turn's lock, admitting a concurrent writer. These tests pin the
 * per-acquisition token guard that prevents that.
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

describe('SessionLockManager — token-matched release (I1)', () => {
  it('does NOT drop a newer same-client lock when a stale token releases', () => {
    const mgr = new SessionLockManager();
    const tokenA = Symbol('turn-A');
    const tokenB = Symbol('turn-B');

    // Turn A acquires; turn B re-acquires for the SAME (session, client) — the
    // legitimate same-client re-acquire, e.g. an auto-flushed second turn.
    expect(mgr.acquireLock(SESSION, CLIENT, fakeRes(), tokenA)).toBe(true);
    expect(mgr.acquireLock(SESSION, CLIENT, fakeRes(), tokenB)).toBe(true);

    // Turn A's stale releaser fires (it settled late). It must be a NO-OP —
    // releasing turn A's token must not drop turn B's lock.
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
