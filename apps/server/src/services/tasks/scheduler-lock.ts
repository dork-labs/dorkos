/**
 * A `dorkHome`-keyed singleton leader lock for the task scheduler (ADR-285).
 *
 * Of N server processes that share one `dorkHome`, exactly one should fire
 * scheduled tasks. This file lock (`<dorkHome>/tasks/scheduler.lock`) elects
 * that leader: the holder writes a pid + heartbeat record and refreshes it on an
 * interval; a process whose heartbeat goes stale (crash) has its lock stolen by
 * the next acquirer. Followers still register crons (display works) but never
 * fire. It is a single-machine best-effort lock — the brief dual-leader window
 * during a handoff is covered by dispatch idempotency (the other defense).
 *
 * @module services/tasks/scheduler-lock
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname as osHostname } from 'node:os';

/** How often the leader refreshes its heartbeat. */
export const SCHEDULER_HEARTBEAT_MS = 10_000;

/**
 * How long a lock may go without a heartbeat before it is considered stale and
 * stealable. Three missed heartbeats — tolerates GC pauses without flapping.
 */
export const SCHEDULER_LOCK_STALE_TTL_MS = 30_000;

/**
 * The leadership contract the scheduler depends on. Abstracted so the scheduler
 * can be tested with a fake follower lock without touching the filesystem.
 */
export interface LeaderLock {
  /** Attempt to become (or remain) the leader. Returns whether we hold it now. */
  tryAcquire(): boolean;
  /** Refresh our heartbeat if leader; otherwise re-attempt acquisition (promotes on a dead leader). */
  heartbeat(): void;
  /** Release the lock iff we own it. */
  release(): void;
  /** Whether this process currently holds leadership (cached from the last acquire/heartbeat). */
  readonly isLeaderNow: boolean;
}

/** The on-disk lock record. */
interface LockRecord {
  pid: number;
  hostname: string;
  /** Identifies this specific lock instance, distinguishing same-pid holders in tests. */
  startedAt: number;
  /** Last heartbeat (epoch ms); staleness is measured against this. */
  heartbeatAt: number;
}

/** Options for {@link SchedulerLock}; the non-`dorkHome` fields are injected by tests. */
export interface SchedulerLockOptions {
  /** The data directory whose `tasks/scheduler.lock` keys this lock. */
  dorkHome: string;
  /** Clock, injectable for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** This process's id, injectable so a test can simulate multiple processes. */
  pid?: number;
  /** This host's name. Defaults to `os.hostname()`. */
  hostname?: string;
  /** Override the staleness window (tests). */
  staleTtlMs?: number;
}

/**
 * File-based, `dorkHome`-keyed leader lock. One leader per lock path; a stale
 * (crashed) leader's lock is stolen on the next {@link tryAcquire}.
 */
export class SchedulerLock implements LeaderLock {
  private readonly lockPath: string;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly hostname: string;
  private readonly staleTtlMs: number;
  /** Per-instance identity (with `pid`) — lets two same-pid locks be told apart in tests. */
  private readonly startedAt: number;
  private leader = false;

  constructor(opts: SchedulerLockOptions) {
    this.lockPath = join(opts.dorkHome, 'tasks', 'scheduler.lock');
    this.now = opts.now ?? Date.now;
    this.pid = opts.pid ?? process.pid;
    this.hostname = opts.hostname ?? osHostname();
    this.staleTtlMs = opts.staleTtlMs ?? SCHEDULER_LOCK_STALE_TTL_MS;
    this.startedAt = this.now();
  }

  get isLeaderNow(): boolean {
    return this.leader;
  }

  tryAcquire(): boolean {
    mkdirSync(dirname(this.lockPath), { recursive: true });
    const existing = this.read();
    // A live lock held by someone else blocks us — we are a follower.
    if (existing && !this.isOurs(existing) && !this.isStale(existing)) {
      this.leader = false;
      return false;
    }
    // No lock, a stale lock, or already ours → claim it, then verify we won the
    // write (a concurrent claimer may have raced us; last rename wins).
    this.write();
    const after = this.read();
    this.leader = after !== null && this.isOurs(after);
    return this.leader;
  }

  heartbeat(): void {
    if (!this.leader) {
      // Not leader — re-attempt so a follower promotes when the leader dies.
      this.tryAcquire();
      return;
    }
    const existing = this.read();
    if (existing === null || !this.isOurs(existing)) {
      // Our lock was stolen (we paused past the TTL) — step down.
      this.leader = false;
      return;
    }
    this.write();
  }

  release(): void {
    const existing = this.read();
    if (existing !== null && this.isOurs(existing)) {
      try {
        unlinkSync(this.lockPath);
      } catch {
        // Already gone — nothing to release.
      }
    }
    this.leader = false;
  }

  /** Atomically write our record (temp file + rename — atomic on the same filesystem). */
  private write(): void {
    const record: LockRecord = {
      pid: this.pid,
      hostname: this.hostname,
      startedAt: this.startedAt,
      heartbeatAt: this.now(),
    };
    const tmp = `${this.lockPath}.${this.pid}.${this.startedAt}.tmp`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, this.lockPath);
  }

  /** Read the current record, or `null` if missing/unreadable/malformed. */
  private read(): LockRecord | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.lockPath, 'utf8'));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as LockRecord).pid === 'number' &&
        typeof (parsed as LockRecord).heartbeatAt === 'number' &&
        typeof (parsed as LockRecord).startedAt === 'number'
      ) {
        return parsed as LockRecord;
      }
      return null;
    } catch {
      return null;
    }
  }

  private isOurs(record: LockRecord): boolean {
    return (
      record.pid === this.pid &&
      record.startedAt === this.startedAt &&
      record.hostname === this.hostname
    );
  }

  private isStale(record: LockRecord): boolean {
    return this.now() - record.heartbeatAt > this.staleTtlMs;
  }
}
