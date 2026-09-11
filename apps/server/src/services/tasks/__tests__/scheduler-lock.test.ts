import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchedulerLock } from '../scheduler-lock.js';

/**
 * The dorkHome-keyed leader lock (ADR-285): exactly one leader per lock path; a
 * stale (crashed) leader's lock is stolen; a follower promotes when the leader
 * dies. A mutable clock and injected pids simulate multiple processes in one
 * test process.
 */
describe('SchedulerLock', () => {
  let dorkHome: string;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    dorkHome = mkdtempSync(join(tmpdir(), 'sched-lock-'));
    clock = 1_000_000;
  });

  afterEach(() => {
    rmSync(dorkHome, { recursive: true, force: true });
  });

  const makeLock = (pid: number) =>
    new SchedulerLock({ dorkHome, now, pid, hostname: 'host', staleTtlMs: 30_000 });

  it('acquires leadership when no lock file exists', () => {
    const lock = makeLock(1);
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.isLeaderNow).toBe(true);
  });

  it('a second process becomes a follower while a fresh lock is held', () => {
    const leader = makeLock(1);
    const follower = makeLock(2);
    expect(leader.tryAcquire()).toBe(true);
    expect(follower.tryAcquire()).toBe(false);
    expect(follower.isLeaderNow).toBe(false);
  });

  it('steals a stale lock once the heartbeat TTL is exceeded', () => {
    const dead = makeLock(1);
    const next = makeLock(2);
    expect(dead.tryAcquire()).toBe(true);

    clock += 30_001; // exceed STALE_TTL without a heartbeat — `dead` "crashed"
    expect(next.tryAcquire()).toBe(true);
    expect(next.isLeaderNow).toBe(true);
  });

  it('does NOT steal a lock whose heartbeat is still fresh', () => {
    const leader = makeLock(1);
    const other = makeLock(2);
    expect(leader.tryAcquire()).toBe(true);

    clock += 29_000; // under TTL
    expect(other.tryAcquire()).toBe(false);
  });

  it('release only deletes the lock when this process owns it', () => {
    const leader = makeLock(1);
    const intruder = makeLock(2);
    expect(leader.tryAcquire()).toBe(true);

    // A non-owner release must NOT remove the leader's lock.
    intruder.release();
    expect(intruder.tryAcquire()).toBe(false); // leader's fresh lock still blocks

    // The owner can release it; then the field is free again.
    leader.release();
    expect(intruder.tryAcquire()).toBe(true);
  });

  it('heartbeat advances the on-disk heartbeatAt', () => {
    const leader = makeLock(1);
    leader.tryAcquire();
    const lockPath = join(dorkHome, 'tasks', 'scheduler.lock');
    const before = JSON.parse(readFileSync(lockPath, 'utf8')).heartbeatAt as number;

    clock += 10_000;
    leader.heartbeat();
    const after = JSON.parse(readFileSync(lockPath, 'utf8')).heartbeatAt as number;
    expect(after).toBeGreaterThan(before);
  });

  it('a follower promotes to leader via heartbeat once the leader goes stale', () => {
    const leader = makeLock(1);
    const follower = makeLock(2);
    leader.tryAcquire();
    expect(follower.tryAcquire()).toBe(false);

    clock += 30_001; // leader stops heartbeating (crash) and goes stale
    follower.heartbeat(); // heartbeat re-attempts acquisition for a non-leader
    expect(follower.isLeaderNow).toBe(true);
  });
});

/**
 * A lock write that cannot complete must not take the server down (FB-17).
 *
 * `write()` runs from a `setInterval` heartbeat, so a throw there is an
 * UNCAUGHT EXCEPTION and Node tears the process down. A full disk did exactly
 * that four times on the operator's machine — 2026-08-28, twice on 2026-09-07,
 * and 2026-09-10 — every one of them `ENOSPC` on this write, every one logged
 * as `[DorkOS] Uncaught exception — shutting down`. The chat a person was in
 * the middle of died with the server.
 *
 * A failed write is survivable by design: it is the ordinary meaning of "this
 * process can no longer prove it is alive", and the lock already answers that
 * with the staleness steal. It only has to be caught.
 *
 * **The disk is made READABLE BUT NOT WRITABLE**, by chmod-ing the lock's
 * directory to `r-xr-xr-x`. That is what ENOSPC looks like to this class and it
 * is the only setup that reaches the bug: simply deleting the directory makes
 * `read()` fail first, so `heartbeat()` steps down at the stolen-lock branch
 * and never calls `write()` at all. (Measured — with the fix reverted, the
 * delete-based version of these tests stayed green.) A real `fs` permission
 * error is used rather than a mock so the test cannot drift from what the
 * filesystem actually does.
 */
describe('SchedulerLock — an unwritable lock never kills the process (FB-17)', () => {
  let dorkHome: string;
  let tasksDir: string;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    dorkHome = mkdtempSync(join(tmpdir(), 'sched-lock-enospc-'));
    tasksDir = join(dorkHome, 'tasks');
    clock = 2_000_000;
  });

  afterEach(() => {
    // Restore write permission or the cleanup cannot remove the tree.
    try {
      chmodSync(tasksDir, 0o755);
    } catch {
      // Never created — nothing to restore.
    }
    rmSync(dorkHome, { recursive: true, force: true });
  });

  const makeLock = () =>
    new SchedulerLock({ dorkHome, now, pid: 4242, hostname: 'host', staleTtlMs: 30_000 });

  /** Readable, not writable — so `read()` still answers and only `write()` fails. */
  const sealDisk = () => chmodSync(tasksDir, 0o555);

  it('does not throw from heartbeat when the lock cannot be written', () => {
    const lock = makeLock();
    expect(lock.tryAcquire()).toBe(true);
    sealDisk();

    // THIS is the assertion the crash was: a throw here is an uncaught
    // exception in a timer callback, which ends the process.
    expect(() => lock.heartbeat()).not.toThrow();
  });

  it('stands down as leader rather than firing tasks on a rotting record', () => {
    const lock = makeLock();
    lock.tryAcquire();
    sealDisk();

    lock.heartbeat();

    // Still claiming leadership here would mean firing scheduled tasks while
    // our heartbeat is provably not landing — two leaders once the TTL lets
    // another process steal the lock.
    expect(lock.isLeaderNow).toBe(false);
  });

  it('does not throw from tryAcquire when the lock cannot be created', () => {
    // The other unguarded path: `createExclusive` rethrew anything that was not
    // EEXIST, and the heartbeat reaches it through `tryAcquire` on the follower
    // branch — the same timer, the same uncaught exception.
    const lock = makeLock();
    sealDisk();

    expect(() => lock.tryAcquire()).not.toThrow();
    expect(lock.tryAcquire()).toBe(false);
  });

  it('takes leadership again once the disk recovers', () => {
    // Standing down must not be terminal: the follower branch re-attempts every
    // heartbeat, so a transient full disk costs a scheduling gap, not the
    // scheduler.
    const lock = makeLock();
    lock.tryAcquire();
    sealDisk();
    lock.heartbeat();
    expect(lock.isLeaderNow).toBe(false);

    chmodSync(tasksDir, 0o755);
    lock.heartbeat();

    expect(lock.isLeaderNow).toBe(true);
    expect(JSON.parse(readFileSync(join(tasksDir, 'scheduler.lock'), 'utf8')).pid).toBe(4242);
  });
});
