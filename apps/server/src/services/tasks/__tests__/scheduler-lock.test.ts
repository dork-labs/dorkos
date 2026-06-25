import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
