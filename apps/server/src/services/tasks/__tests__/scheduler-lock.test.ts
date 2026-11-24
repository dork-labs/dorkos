import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  chmodSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The logger is observed so a test can tell a reported failure from a silent
 * one, and `writeSync` is wrapped so a test can fail a write AFTER the lock file
 * was opened — the one moment a real filesystem cannot be made to fail on cue.
 * Every other call goes to the real `fs`.
 */
const { taggedLogger, injected } = vi.hoisted(() => ({
  taggedLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  /** Runs in place of the next `writeSync`, once; it throws to fail the write. */
  injected: { writeSync: null as (() => never) | null },
}));

vi.mock('../../../lib/logger.js', () => ({ createTaggedLogger: () => taggedLogger }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync: ((...args: Parameters<typeof actual.writeSync>) => {
      const fail = injected.writeSync;
      if (fail !== null) {
        injected.writeSync = null;
        fail();
      }
      return actual.writeSync(...args);
    }) as typeof actual.writeSync,
  };
});

import { SchedulerLock } from '../scheduler-lock.js';

/** An errno-shaped error, as `fs` throws it. */
const errnoError = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: simulated`), { code });

beforeEach(() => {
  taggedLogger.warn.mockClear();
  injected.writeSync = null;
});

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

  it('admits one leader, steals only a stale lock, and promotes a follower on heartbeat', () => {
    const leader = makeLock(1);
    const follower = makeLock(2);
    expect(leader.tryAcquire()).toBe(true);
    expect(follower.tryAcquire()).toBe(false);

    clock += 29_000; // under TTL
    expect(follower.tryAcquire()).toBe(false);

    clock += 1_001; // leader stops heartbeating (crash) and goes stale
    follower.heartbeat();
    expect(follower.isLeaderNow).toBe(true);
  });

  it('release only deletes the lock when this process owns it', () => {
    const leader = makeLock(1);
    const intruder = makeLock(2);
    expect(leader.tryAcquire()).toBe(true);

    intruder.release();
    expect(intruder.tryAcquire()).toBe(false);

    leader.release();
    expect(intruder.tryAcquire()).toBe(true);
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

  it('stands down from heartbeat without throwing when the lock cannot be written', () => {
    const lock = makeLock();
    expect(lock.tryAcquire()).toBe(true);
    sealDisk();

    // A throw here is an uncaught exception in a timer callback.
    expect(() => lock.heartbeat()).not.toThrow();
    // Still leading would fire tasks while our heartbeat is provably not landing.
    expect(lock.isLeaderNow).toBe(false);
  });
});

/**
 * A lock file that exists but cannot be parsed must never keep the scheduler
 * off for good (DOR-2131).
 *
 * The old `createExclusive` wrote straight to the lock path, so a write that
 * failed after the file was created (a full disk, a crash) left an empty or
 * half-written `scheduler.lock` behind. Every later acquire then read `null`,
 * hit `EEXIST`, took that as a lost race, and stayed a follower: no process
 * ever became leader again and no scheduled task ever ran, silently, across
 * restarts.
 */
describe('SchedulerLock — an unreadable lock file is replaced, not obeyed (DOR-2131)', () => {
  let dorkHome: string;
  let lockPath: string;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    dorkHome = mkdtempSync(join(tmpdir(), 'sched-lock-debris-'));
    lockPath = join(dorkHome, 'tasks', 'scheduler.lock');
    clock = 3_000_000;
  });

  afterEach(() => {
    rmSync(dorkHome, { recursive: true, force: true });
  });

  const makeLock = (pid: number) =>
    new SchedulerLock({ dorkHome, now, pid, hostname: 'host', staleTtlMs: 30_000 });

  it.each([
    ['an empty', ''],
    ['a truncated', '{"pid":7,"hostname":"ho'],
  ])('takes leadership over %s lock file', (_label, contents) => {
    const lock = makeLock(1);
    writeFileSync(lockPath, contents);

    expect(lock.tryAcquire()).toBe(true);
    expect(lock.isLeaderNow).toBe(true);
    // Replaced by a whole record, and only through the temp-file-plus-rename
    // path: no temp file is left beside it.
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(1);
    expect(readdirSync(join(dorkHome, 'tasks'))).toEqual(['scheduler.lock']);
  });

  it('removes its own half-written lock file when the write fails after the create', () => {
    const lock = makeLock(1);
    injected.writeSync = () => {
      throw errnoError('ENOSPC');
    };

    expect(lock.tryAcquire()).toBe(false);
    // The file it had just created is gone, so nothing unreadable is left for
    // every later acquire to trip over.
    expect(existsSync(lockPath)).toBe(false);
    expect(taggedLogger.warn).toHaveBeenCalledTimes(1);
    expect(String(taggedLogger.warn.mock.calls[0]?.[0])).toContain('The disk is full.');

    // And the next attempt, with the disk back, simply wins.
    expect(lock.tryAcquire()).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(1);
  });

  it('leaves alone a lock another process renamed over its half-written file', () => {
    const failing = makeLock(1);
    const other = makeLock(2);
    // While `failing` holds its empty, just-created file, `other` reads it as
    // debris and claims the path with a whole record of its own.
    injected.writeSync = () => {
      expect(other.tryAcquire()).toBe(true);
      throw errnoError('ENOSPC');
    };

    expect(failing.tryAcquire()).toBe(false);
    // The cleanup must not delete the lock `other` now holds.
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(2);
    other.heartbeat();
    expect(other.isLeaderNow).toBe(true);
    expect(failing.tryAcquire()).toBe(false);
  });
});
