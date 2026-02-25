import type { Response } from 'express';
import { SESSIONS } from '../../config/constants.js';

interface SessionLock {
  clientId: string;
  acquiredAt: number;
  ttl: number;
  response: Response;
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
   */
  acquireLock(sessionId: string, clientId: string, res: Response): boolean {
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
      response: res,
    };
    this.locks.set(sessionId, lock);
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
   */
  releaseLock(sessionId: string, clientId: string): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.clientId === clientId) {
      this.locks.delete(sessionId);
    }
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
