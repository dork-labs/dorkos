import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Response } from 'express';

// Mock the SDK before importing agent-manager
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

// Type for accessing private lockManager internals for testing
interface SessionLock {
  clientId: string;
  acquiredAt: number;
  ttl: number;
  response: Response;
}

interface LockManagerWithLocks {
  locks: Map<string, SessionLock>;
}

interface AgentManagerWithLockManager {
  lockManager: LockManagerWithLocks;
}

/** Helper to access the private locks map for test manipulation. */
function getLocksMap(am: unknown): Map<string, SessionLock> {
  return (am as AgentManagerWithLockManager).lockManager.locks;
}

describe('AgentManager - Session Locking', () => {
  let AgentManager: typeof import('../agent-manager.js').AgentManager;
  let agentManager: InstanceType<typeof AgentManager>;

  // Helper to create a mock Express Response
  function createMockResponse(): Response & { _triggerClose: () => void } {
    const handlers = new Map<string, Function>();
    const mockRes = {
      on: vi.fn((event: string, cb: Function) => {
        handlers.set(event, cb);
        return mockRes;
      }),
      _triggerClose: () => {
        handlers.get('close')?.();
      },
    };
    return mockRes as unknown as Response & { _triggerClose: () => void };
  }

  beforeEach(async () => {
    vi.resetModules();
    // Re-mock after resetModules
    vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
      query: vi.fn(),
    }));
    const mod = await import('../agent-manager.js');
    AgentManager = mod.AgentManager;
    agentManager = new AgentManager();
  });

  describe('acquireLock()', () => {
    it('acquires lock on unlocked session', () => {
      const res = createMockResponse();
      const result = agentManager.acquireLock('session1', 'client1', res);

      expect(result).toBe(true);
      expect(agentManager.isLocked('session1')).toBe(true);
    });

    it('rejects lock when session is locked by another client', () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();

      agentManager.acquireLock('session1', 'client1', res1);
      const result = agentManager.acquireLock('session1', 'client2', res2);

      expect(result).toBe(false);
      expect(agentManager.isLocked('session1', 'client2')).toBe(true);
    });

    it('allows same client to re-acquire their own lock', () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();

      agentManager.acquireLock('session1', 'client1', res1);
      const result = agentManager.acquireLock('session1', 'client1', res2);

      expect(result).toBe(true);
      expect(agentManager.isLocked('session1', 'client1')).toBe(false);
    });

    it('allows lock after TTL expiry', () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();

      agentManager.acquireLock('session1', 'client1', res1);

      // Manually expire the lock by manipulating acquiredAt
      const lockInfo = agentManager.getLockInfo('session1');
      if (lockInfo) {
        // Access the private sessionLocks map via type assertion
        const locks = getLocksMap(agentManager);
        const lock = locks.get('session1');
        if (lock) {
          lock.acquiredAt = Date.now() - 6 * 60 * 1000; // 6 minutes ago
        }
      }

      const result = agentManager.acquireLock('session1', 'client2', res2);
      expect(result).toBe(true);
    });

    it('releases lock when response closes (connection drop)', () => {
      const res = createMockResponse();

      agentManager.acquireLock('session1', 'client1', res);
      expect(agentManager.isLocked('session1')).toBe(true);

      res._triggerClose();
      expect(agentManager.isLocked('session1')).toBe(false);
    });
  });

  describe('releaseLock()', () => {
    it('releases lock on explicit release', () => {
      const res = createMockResponse();

      agentManager.acquireLock('session1', 'client1', res);
      expect(agentManager.isLocked('session1')).toBe(true);

      agentManager.releaseLock('session1', 'client1');
      expect(agentManager.isLocked('session1')).toBe(false);
    });

    it('does not release lock held by another client', () => {
      const res = createMockResponse();

      agentManager.acquireLock('session1', 'client1', res);
      agentManager.releaseLock('session1', 'client2');

      expect(agentManager.isLocked('session1', 'client2')).toBe(true);
    });
  });

  describe('isLocked()', () => {
    it('returns false for unlocked sessions', () => {
      expect(agentManager.isLocked('session1')).toBe(false);
    });

    it('returns true for locked sessions', () => {
      const res = createMockResponse();
      agentManager.acquireLock('session1', 'client1', res);

      expect(agentManager.isLocked('session1')).toBe(true);
    });

    it('returns false for own lock with clientId', () => {
      const res = createMockResponse();
      agentManager.acquireLock('session1', 'client1', res);

      expect(agentManager.isLocked('session1', 'client1')).toBe(false);
      expect(agentManager.isLocked('session1', 'client2')).toBe(true);
    });

    it('returns false when lock has expired', () => {
      const res = createMockResponse();
      agentManager.acquireLock('session1', 'client1', res);

      // Expire the lock
      const locks = getLocksMap(agentManager);
      const lock = locks.get('session1');
      if (lock) {
        lock.acquiredAt = Date.now() - 6 * 60 * 1000; // 6 minutes ago
      }

      expect(agentManager.isLocked('session1')).toBe(false);
    });
  });

  describe('getLockInfo()', () => {
    it('returns null for unlocked sessions', () => {
      expect(agentManager.getLockInfo('session1')).toBeNull();
    });

    it('returns info for locked sessions', () => {
      const res = createMockResponse();
      const before = Date.now();
      agentManager.acquireLock('session1', 'client1', res);
      const after = Date.now();

      const info = agentManager.getLockInfo('session1');
      expect(info).not.toBeNull();
      expect(info?.clientId).toBe('client1');
      expect(info?.acquiredAt).toBeGreaterThanOrEqual(before);
      expect(info?.acquiredAt).toBeLessThanOrEqual(after);
    });

    it('returns null when lock has expired', () => {
      const res = createMockResponse();
      agentManager.acquireLock('session1', 'client1', res);

      // Expire the lock
      const locks = getLocksMap(agentManager);
      const lock = locks.get('session1');
      if (lock) {
        lock.acquiredAt = Date.now() - 6 * 60 * 1000; // 6 minutes ago
      }

      expect(agentManager.getLockInfo('session1')).toBeNull();
    });
  });

  describe('checkSessionHealth()', () => {
    it('cleans up expired locks', () => {
      const res = createMockResponse();
      agentManager.acquireLock('session1', 'client1', res);

      // Expire the lock
      const locks = getLocksMap(agentManager);
      const lock = locks.get('session1');
      if (lock) {
        lock.acquiredAt = Date.now() - 6 * 60 * 1000; // 6 minutes ago
      }

      agentManager.checkSessionHealth();
      expect(agentManager.isLocked('session1')).toBe(false);
    });

    it('keeps fresh locks', () => {
      const res = createMockResponse();
      agentManager.acquireLock('session1', 'client1', res);

      agentManager.checkSessionHealth();
      expect(agentManager.isLocked('session1')).toBe(true);
    });

    it('cleans up locks when session is removed', () => {
      const res = createMockResponse();

      // Create a session and acquire a lock
      agentManager.ensureSession('session1', { permissionMode: 'default' });
      agentManager.acquireLock('session1', 'client1', res);

      // Expire the session (use fake timers)
      vi.useFakeTimers();
      vi.advanceTimersByTime(31 * 60 * 1000); // 31 minutes

      agentManager.checkSessionHealth();

      expect(agentManager.hasSession('session1')).toBe(false);
      expect(agentManager.isLocked('session1')).toBe(false);

      vi.useRealTimers();
    });
  });
});
