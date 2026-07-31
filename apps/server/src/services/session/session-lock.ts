import type { SseResponse } from '@dorkos/shared/agent-runtime';
import { SESSIONS } from '../../config/constants.js';

/**
 * A lock holder that can prove it is still alive (DOR-782).
 *
 * The TTL exists to reclaim a lock whose holder vanished — a client that
 * disconnected without its close handler firing. It was never meant to bound how
 * long legitimate work may run, but with `acquiredAt` fixed at acquisition that
 * is exactly what it did: a room turn that legally runs an hour spent 55 minutes
 * on an expired, stealable lock while it was visibly streaming.
 *
 * A holder that implements this interface is asked when it was last alive, and
 * the TTL is measured from THAT instead. Silence is still bounded — a turn that
 * stops proving liveness expires one TTL later, exactly as before — and the
 * detached-turn holder ({@link import('./trigger-turn').DetachedTurnLifecycle})
 * only reports liveness while the turn is streaming events or parked on a person.
 *
 * Structural, not required: `SseResponse` holders that cannot vouch for
 * themselves (a plain HTTP response) keep the acquisition-time TTL.
 */
export interface LockActivity {
  /** Epoch ms of the holder's most recent proof of life. */
  lastActivityAt(): number;
}

/** Whether a lock holder can answer {@link LockActivity.lastActivityAt}. */
function hasLockActivity(res: SseResponse): res is SseResponse & LockActivity {
  return typeof (res as Partial<LockActivity>).lastActivityAt === 'function';
}

interface SessionLock {
  clientId: string;
  acquiredAt: number;
  ttl: number;
  /** The holder's liveness probe, when it offers one; see {@link LockActivity}. */
  activity?: LockActivity;
  /**
   * Unique per-acquisition identity (I1). A same-client re-acquire (e.g. a
   * compose-next auto-flush starting a second detached turn before the first
   * settles) mints a NEW token, so a stale releaser holding the prior token is a
   * no-op and cannot drop the lock the second turn now holds — which would
   * otherwise admit a concurrent writer.
   */
  token: symbol;
}

/**
 * Manages session write locks to prevent concurrent writes from multiple clients.
 *
 * A lock is released when its SSE connection closes, and otherwise expires after
 * a TTL of INACTIVITY — measured from the holder's last proof of life when it
 * offers one ({@link LockActivity}), and from acquisition when it does not. A
 * holder that keeps working therefore keeps its lock however long the work runs,
 * while one that vanishes is still reclaimed a TTL later (DOR-782).
 */
export class SessionLockManager {
  private locks = new Map<string, SessionLock>();
  private readonly LOCK_TTL_MS = SESSIONS.LOCK_TTL_MS;

  /**
   * Whether a lock has gone unclaimed for longer than its TTL. The clock starts
   * at the holder's last proof of life, falling back to acquisition time — so a
   * live holder is never expired out from under itself, and a dark one still is.
   */
  private isExpired(lock: SessionLock, now = Date.now()): boolean {
    const lastSeen = Math.max(lock.acquiredAt, lock.activity?.lastActivityAt() ?? 0);
    return now - lastSeen > lock.ttl;
  }

  /**
   * Attempt to acquire a lock on a session for a specific client.
   * Returns true if the lock was acquired, false if the session is locked by another client.
   *
   * @param token - Optional per-acquisition identity. When the caller threads
   *   this token into {@link releaseLock}, release is token-matched (I1) so a
   *   stale releaser from a superseded same-client turn cannot drop a newer
   *   lock. Omit for callers that do not need the guard (legacy same-client
   *   release-by-clientId semantics still apply).
   */
  acquireLock(sessionId: string, clientId: string, res: SseResponse, token?: symbol): boolean {
    const existing = this.locks.get(sessionId);
    if (existing) {
      if (this.isExpired(existing)) {
        this.locks.delete(sessionId);
      } else if (existing.clientId !== clientId) {
        return false;
      }
    }
    const lock: SessionLock = {
      clientId,
      acquiredAt: Date.now(),
      ttl: this.LOCK_TTL_MS,
      token: token ?? Symbol('session-lock'),
      ...(hasLockActivity(res) ? { activity: res } : {}),
    };
    this.locks.set(sessionId, lock);
    // Attach close handler immediately — instance-identity matched, so a later
    // re-acquire that replaces this lock makes this handler a no-op.
    res.on('close', () => {
      const current = this.locks.get(sessionId);
      if (current === lock) {
        this.locks.delete(sessionId);
      }
    });
    return true;
  }

  /**
   * Release a lock on a session if it's held by the specified client.
   *
   * @param token - Optional per-acquisition identity from {@link acquireLock}.
   *   When provided, release is a no-op unless it matches the CURRENT lock's
   *   token — so a stale releaser from a superseded same-client turn (I1) cannot
   *   drop the lock a newer turn holds. When omitted, the legacy clientId-only
   *   match applies.
   */
  releaseLock(sessionId: string, clientId: string, token?: symbol): void {
    const lock = this.locks.get(sessionId);
    if (!lock || lock.clientId !== clientId) return;
    if (token !== undefined && lock.token !== token) return;
    this.locks.delete(sessionId);
  }

  /**
   * Check if a session is locked.
   * If clientId is provided, returns false if the lock is held by that client (owns the lock).
   */
  isLocked(sessionId: string, clientId?: string): boolean {
    const lock = this.locks.get(sessionId);
    if (!lock) return false;
    if (this.isExpired(lock)) {
      this.locks.delete(sessionId);
      return false;
    }
    if (clientId && lock.clientId === clientId) return false;
    return true;
  }

  /**
   * Get information about the current lock on a session.
   * Returns null if the session is not locked or the lock has expired.
   */
  getLockInfo(sessionId: string): { clientId: string; acquiredAt: number } | null {
    const lock = this.locks.get(sessionId);
    if (!lock) return null;
    if (this.isExpired(lock)) {
      this.locks.delete(sessionId);
      return null;
    }
    return { clientId: lock.clientId, acquiredAt: lock.acquiredAt };
  }

  /** Remove expired locks and locks for specified session IDs. */
  cleanup(sessionIds?: string[]): void {
    const now = Date.now();
    for (const [id, lock] of this.locks) {
      if (this.isExpired(lock, now)) {
        this.locks.delete(id);
      }
    }
    if (sessionIds) {
      for (const id of sessionIds) {
        this.locks.delete(id);
      }
    }
  }
}
