import type { SseResponse } from '@dorkos/shared/agent-runtime';
import { SESSIONS } from '../../config/constants.js';
import { logger } from '../../lib/logger.js';

/** Private acquisition identity. It is data custody, never a principal or permission. */
export interface NativeSessionAcquisition {
  readonly kind: 'native-session-acquisition';
}
export interface NativeSessionActivity {
  readonly kind: 'native-session-activity';
}
type NativeLockRecord = {
  manager: SessionLockManager;
  locks: Map<string, SessionLock>;
  key: string;
  lock: SessionLock;
  holder: SseResponse;
  retired: boolean;
};
const originalLockConstructors = new WeakMap<
  object,
  {
    capture(key: string, holder: SseResponse): NativeSessionAcquisition | undefined;
  }
>();
const originalAcquisitions = new WeakMap<NativeSessionAcquisition, NativeLockRecord>();
const originalActivity = new WeakMap<
  NativeSessionActivity,
  {
    acquisition: NativeSessionAcquisition;
    time: number;
    lastSeen: number;
  }
>();
const originalMapGet = Map.prototype.get;
function currentAcquisition(record: NativeLockRecord): boolean {
  const slot = Object.getOwnPropertyDescriptor(record.manager, 'locks');
  return (
    !record.retired &&
    !!slot &&
    'value' in slot &&
    slot.value === record.locks &&
    originalMapGet.call(record.locks, record.key) === record.lock
  );
}
/** Fixed native-entry capture requires the actual acquired holder, not a copied token/client. */
export function captureNativeSessionAcquisition(
  manager: SessionLockManager,
  key: string,
  holder: SseResponse
): NativeSessionAcquisition | undefined {
  return originalLockConstructors.get(manager)?.capture(key, holder);
}
/** Fixed same-holder lookup: a retired raw key may be ignored only beside this actual acquisition. */
export function isOriginalNativeSessionAcquisitionAlias(
  manager: SessionLockManager,
  acquisition: NativeSessionAcquisition,
  holder: SseResponse,
  canonicalId: string,
  retiredId: string
): boolean {
  const own = originalAcquisitions.get(acquisition);
  return (
    !!own &&
    own.manager === manager &&
    own.holder === holder &&
    own.key === canonicalId &&
    retiredId !== canonicalId &&
    currentAcquisition(own) &&
    originalMapGet.call(own.locks, retiredId) === undefined
  );
}
/** Run real clock/activity policy before final currentness; callbacks can invalidate acquisition. */
export function captureNativeSessionActivity(
  acquisition: NativeSessionAcquisition,
  time: number
): NativeSessionActivity | undefined {
  const record = originalAcquisitions.get(acquisition);
  if (!record || !Number.isFinite(time) || !currentAcquisition(record)) return undefined;
  const lastSeen = Math.max(record.lock.acquiredAt, record.lock.activity?.lastActivityAt() ?? 0);
  if (!Number.isFinite(lastSeen) || !currentAcquisition(record)) return undefined;
  const captured: NativeSessionActivity = Object.freeze({ kind: 'native-session-activity' });
  originalActivity.set(captured, { acquisition, time, lastSeen });
  return captured;
}
/** Callback-free final exact-entry read. No structural activity DTO can bless an acquisition. */
export function readNativeSessionAcquisition(
  acquisition: NativeSessionAcquisition,
  captured: NativeSessionActivity,
  time: number,
  canonicalSessionId: string
): boolean {
  const record = originalAcquisitions.get(acquisition),
    activity = originalActivity.get(captured);
  return (
    !!record &&
    !!activity &&
    activity.acquisition === acquisition &&
    activity.time === time &&
    currentAcquisition(record) &&
    record.key === canonicalSessionId &&
    time - activity.lastSeen <= record.lock.ttl
  );
}

/** Lookup-only positive original retirement, not absence/currentness DATA or a caller checker. */
export function requireOriginalNativeSessionAcquisitionRetired(
  manager: SessionLockManager,
  acquisition: NativeSessionAcquisition,
  holder: SseResponse
): void {
  const own = originalAcquisitions.get(acquisition),
    slot = Object.getOwnPropertyDescriptor(manager, 'locks');
  if (
    !own ||
    own.manager !== manager ||
    own.holder !== holder ||
    !own.retired ||
    !slot ||
    !('value' in slot) ||
    slot.value !== own.locks ||
    originalMapGet.call(own.locks, own.key) === own.lock
  )
    throw new Error('Original native session acquisition retirement unconfirmed');
}

/** Readonly original-acquisition comparison for a same-holder canonical move. It does not register or mutate witnesses. */
export function isNativeSessionAcquisitionMove(
  previous: NativeSessionAcquisition,
  next: NativeSessionAcquisition,
  holder: SseResponse
): boolean {
  const before = originalAcquisitions.get(previous),
    after = originalAcquisitions.get(next);
  return (
    !!before &&
    !!after &&
    previous !== next &&
    before.manager === after.manager &&
    before.holder === holder &&
    after.holder === holder &&
    before.lock.token === after.lock.token &&
    before.lock.clientId === after.lock.clientId &&
    before.key !== after.key &&
    currentAcquisition(before) &&
    currentAcquisition(after)
  );
}

/**
 * The holder prefix reserved for a turn the agent started on its own (spec
 * `warm-process-lifecycle` D6).
 *
 * Reserved rather than merely conventional: `SessionLockManager.acquireLock`
 * refuses it to every caller, so a lock reading `runtime:…` was minted by
 * {@link SessionLockManager.acquireRuntimeLock} and by nothing else.
 */
export const RUNTIME_LOCK_PREFIX = 'runtime:';

/**
 * The reserved holder id for one session's agent-initiated turns.
 *
 * @param sessionKey - The session the turn runs on
 */
export function runtimeLockHolder(sessionKey: string): string {
  return `${RUNTIME_LOCK_PREFIX}${sessionKey}`;
}

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
   * Unique per-acquisition identity (I1). Every acquisition mints a NEW token,
   * so a stale releaser holding the prior one is a no-op and cannot drop the
   * lock a later turn now holds — which would otherwise admit a concurrent
   * writer. Still reachable after DOR-1088 closed the live re-acquire: a turn
   * whose lock EXPIRED (it went dark) can be replaced by the same client and
   * then come back to life and release, which without the token would delete
   * the successor's lock.
   */
  token: symbol;
  native?: NativeSessionAcquisition;
  holder: SseResponse;
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

  constructor() {
    const locks = this.locks;
    originalLockConstructors.set(this, {
      capture: (key, holder) => {
        const lock = originalMapGet.call(locks, key) as SessionLock | undefined;
        if (!lock || lock.holder !== holder) return undefined;
        const acquisition = lock.native;
        const record = acquisition && originalAcquisitions.get(acquisition);
        return record && currentAcquisition(record) ? acquisition : undefined;
      },
    });
  }

  private retire(key: string): void {
    const lock = originalMapGet.call(this.locks, key) as SessionLock | undefined;
    const record = lock?.native && originalAcquisitions.get(lock.native);
    if (record) record.retired = true;
    this.locks.delete(key);
  }

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
   *
   * A LIVE lock is never replaced — not even for the client that holds it
   * (DOR-1088). The same-client re-acquire used to succeed and silently swap the
   * holder, which meant one browser tab (one client id for its whole life) could
   * start a second turn beside its own running one: two runtime subprocesses
   * resuming the same transcript. Same-client triggers now WAIT their turn at
   * {@link import('./trigger-turn').SessionTurnQueue} instead, so by the time one
   * reaches this method the lock it is waiting on is already released and this
   * refusal is not the path anyone takes — it is the guarantee that nothing can
   * route around the queue.
   *
   * A lock past its TTL of inactivity is still reclaimable by anyone; that is
   * how a session whose holder crashed comes back.
   *
   * @param token - Optional per-acquisition identity. When the caller threads
   *   this token into {@link releaseLock}, release is token-matched (I1) so a
   *   stale releaser from a superseded turn cannot drop a newer lock. Omit for
   *   callers that do not need the guard (legacy same-client
   *   release-by-clientId semantics still apply).
   * @returns True when the lock was acquired; false when the session is already
   *   locked and that lock is still live, whoever holds it.
   */
  acquireLock(sessionId: string, clientId: string, res: SseResponse, token?: symbol): boolean {
    // The runtime holder is RESERVED (spec `warm-process-lifecycle` D6). A turn
    // the agent started on its own holds the session under `runtime:<key>`, and
    // whoever reads a lock's holder is entitled to take that name at face value:
    // it decides whether the person's queued message waits, and whether a room
    // trigger parks. A caller that could spell the name itself could impersonate
    // an agent-initiated turn, so the only way in is {@link acquireRuntimeLock}.
    if (clientId.startsWith(RUNTIME_LOCK_PREFIX)) {
      logger.warn('[SessionLockManager] refused a reserved runtime lock holder', {
        sessionId,
        clientId,
      });
      return false;
    }
    return this.claim(sessionId, clientId, res, token);
  }

  /**
   * Take a session for a turn the AGENT started, under the reserved
   * `runtime:<sessionKey>` holder (spec `warm-process-lifecycle` D6).
   *
   * The one way that holder is ever minted. Everything else about it is an
   * ordinary lock: the same TTL measured from the holder's own liveness, the
   * same token-matched release, and the same refusal while somebody else holds
   * it live — a runtime turn waits for the person's turn to finish exactly as
   * the person's next turn waits for the runtime one.
   *
   * @param sessionKey - The session being taken, resolved as every other holder
   *   resolves it
   * @param res - The turn's lifecycle, which vouches for its own liveness
   * @param token - Per-acquisition identity, threaded into {@link releaseLock}
   * @returns True when the lock was taken
   */
  acquireRuntimeLock(sessionKey: string, res: SseResponse, token?: symbol): boolean {
    return this.claim(sessionKey, runtimeLockHolder(sessionKey), res, token);
  }

  /** Take the lock, with no question about who is allowed to ask. */
  private claim(sessionId: string, clientId: string, res: SseResponse, token?: symbol): boolean {
    const existing = this.locks.get(sessionId);
    if (existing) {
      if (!this.isExpired(existing)) return false;
      this.retire(sessionId);
    }
    const lock: SessionLock = {
      clientId,
      acquiredAt: Date.now(),
      ttl: this.LOCK_TTL_MS,
      token: token ?? Symbol('session-lock'),
      holder: res,
      ...(hasLockActivity(res) ? { activity: res } : {}),
    };
    this.locks.set(sessionId, lock);
    const acquisition: NativeSessionAcquisition = Object.freeze({
      kind: 'native-session-acquisition',
    });
    lock.native = acquisition;
    originalAcquisitions.set(acquisition, {
      manager: this,
      locks: this.locks,
      key: sessionId,
      lock,
      holder: res,
      retired: false,
    });
    // Attach close handler immediately — instance-identity matched, so a later
    // re-acquire that replaces this lock makes this handler a no-op.
    res.on('close', () => {
      const current = this.locks.get(sessionId);
      if (current === lock) {
        this.retire(sessionId);
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
    this.retire(sessionId);
  }

  /**
   * Check if a session is locked.
   * If clientId is provided, returns false if the lock is held by that client (owns the lock).
   */
  isLocked(sessionId: string, clientId?: string): boolean {
    const lock = this.locks.get(sessionId);
    if (!lock) return false;
    if (this.isExpired(lock)) {
      this.retire(sessionId);
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
      this.retire(sessionId);
      return null;
    }
    return { clientId: lock.clientId, acquiredAt: lock.acquiredAt };
  }

  /** Remove expired locks and locks for specified session IDs. */
  cleanup(sessionIds?: string[]): void {
    const now = Date.now();
    for (const [id, lock] of this.locks) {
      if (this.isExpired(lock, now)) {
        this.retire(id);
      }
    }
    if (sessionIds) {
      for (const id of sessionIds) {
        this.retire(id);
      }
    }
  }
}
