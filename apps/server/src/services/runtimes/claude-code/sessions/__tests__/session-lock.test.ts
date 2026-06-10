/**
 * SessionLockManager — token-matched release (I1).
 *
 * With detached turns, a second turn for the same (session, client) can start
 * (compose-next auto-flush) before the prior detached turn settles. A purely
 * (sessionId, clientId)-matched release from the FIRST turn would then delete
 * the SECOND turn's lock, admitting a concurrent writer. These tests pin the
 * per-acquisition token guard that prevents that.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SseResponse } from '@dorkos/shared/agent-runtime';
import { SessionLockManager } from '../session-lock.js';

const SESSION = 'sess-1';
const CLIENT = 'client-A';

/** A no-op SseResponse — the lock manager only registers a close handler on it. */
function fakeRes(): SseResponse {
  return { on: vi.fn() };
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
