import type { SseResponse } from '@dorkos/shared/agent-runtime';
import { SESSIONS } from '../../../../config/constants.js';

interface SessionLock {
  clientId: string;
  acquiredAt: number;
  ttl: number;
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
 * Locks auto-expire after a configurable TTL and are released when SSE connections close.
 */
export class SessionLockManager {
  private locks = new Map<string, SessionLock>();
  private readonly LOCK_TTL_MS = SESSIONS.LOCK_TTL_MS;

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
      const expired = Date.now() - existing.acquiredAt > existing.ttl;
      if (expired) {
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
    if (Date.now() - lock.acquiredAt > lock.ttl) {
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
    if (Date.now() - lock.acquiredAt > lock.ttl) {
      this.locks.delete(sessionId);
      return null;
    }
    return { clientId: lock.clientId, acquiredAt: lock.acquiredAt };
  }

  /** Remove expired locks and locks for specified session IDs. */
  cleanup(sessionIds?: string[]): void {
    const now = Date.now();
    for (const [id, lock] of this.locks) {
      if (now - lock.acquiredAt > lock.ttl) {
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
