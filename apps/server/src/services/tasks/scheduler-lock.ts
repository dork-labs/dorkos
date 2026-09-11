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

import { createTaggedLogger } from '../../lib/logger.js';

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

const logger = createTaggedLogger('SchedulerLock');

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
  /**
   * Whether the current run of write failures has already been reported, so a
   * disk that stays full does not fill the log with the same line. Cleared by
   * the next successful write — see {@link SchedulerLock.onWriteFailed}.
   */
  private reportedWriteFailure = false;

  constructor(opts: SchedulerLockOptions) {
    this.lockPath = join(opts.dorkHome, 'tasks', 'scheduler.lock');
    this.now = opts.now ?? Date.now;
    this.pid = opts.pid ?? process.pid;
    this.hostname = opts.hostname ?? osHostname();
    this.staleTtlMs = opts.staleTtlMs ?? SCHEDULER_LOCK_STALE_TTL_MS;
    this.startedAt = this.now();
    mkdirSync(dirname(this.lockPath), { recursive: true });
  }

  get isLeaderNow(): boolean {
    return this.leader;
  }

  tryAcquire(): boolean {
    const existing = this.read();
    // A live lock held by someone else blocks us — we are a follower.
    if (existing !== null && !this.isOurs(existing) && !this.isStale(existing)) {
      this.leader = false;
      return false;
    }
    if (existing === null) {
      // Fast path: an exclusive (O_EXCL) create has exactly one winner, so a
      // simultaneous no-lock race can never elect two leaders.
      if (this.createExclusive()) {
        this.leader = true;
        return true;
      }
      // Lost the create race — another process just claimed it. Re-read; we are
      // a follower (its fresh lock is not ours).
      const claimed = this.read();
      this.leader = claimed !== null && this.isOurs(claimed);
      return this.leader;
    }
    // Stale lock, or already ours → claim by atomic overwrite, then verify we
    // won (a concurrent stale-steal may have raced us; last rename wins).
    // A claim we could not write is simply a claim we did not win.
    if (!this.write()) {
      this.leader = false;
      return false;
    }
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
    // A heartbeat we could not write is a heartbeat that did not happen, so
    // step down rather than keep firing tasks while our record rots. Another
    // process takes over once the TTL expires; if the write starts working
    // again we re-acquire on the next tick through the follower path above.
    if (!this.write()) this.leader = false;
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

  /** Build our current lock record. */
  private record(): LockRecord {
    return {
      pid: this.pid,
      hostname: this.hostname,
      startedAt: this.startedAt,
      heartbeatAt: this.now(),
    };
  }

  /**
   * Report a lock write we could not complete — once per spell, not once per
   * heartbeat.
   *
   * The heartbeat runs every {@link SCHEDULER_HEARTBEAT_MS}, so a disk that
   * stays full would otherwise write six identical lines a minute into the very
   * log file competing for the space that ran out. The counter resets on the
   * next successful write, so a second outage is reported again.
   */
  private onWriteFailed(err: unknown): void {
    if (this.reportedWriteFailure) return;
    this.reportedWriteFailure = true;
    const code = (err as NodeJS.ErrnoException).code;
    logger.warn(
      'Could not refresh the scheduler lock — standing down as scheduler leader. ' +
        'Scheduled tasks will be run by another DorkOS process, or by this one once ' +
        'the write succeeds again.' +
        (code === 'ENOSPC' ? ' The disk is full.' : ''),
      { path: this.lockPath, ...(code === undefined ? {} : { code }) }
    );
  }

  /**
   * Exclusively create the lock file (O_EXCL). Returns `false` (without throwing)
   * if it already exists — the caller then re-reads and becomes a follower.
   *
   * Nor does it throw for anything else. This is reached from the heartbeat
   * timer via `tryAcquire`, so a throw here is the same uncaught exception, and
   * the same whole-server shutdown, that {@link SchedulerLock.write} documents.
   * An unwritable lock file means we did not become leader; it never means the
   * process should die.
   */
  private createExclusive(): boolean {
    try {
      writeFileSync(this.lockPath, JSON.stringify(this.record()), { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      this.onWriteFailed(err);
      return false;
    }
  }

  /**
   * Atomically overwrite our record (temp file + rename — atomic on the same
   * filesystem).
   *
   * **Never throws, and that is the whole point.** This runs from a
   * `setInterval` heartbeat, where a throw is an UNCAUGHT EXCEPTION and takes
   * the entire server down — not the scheduler, the server. A full disk did
   * exactly that four times on the operator's machine (2026-08-28, twice on
   * 2026-09-07, and 2026-09-10, every one of them `ENOSPC` on this write,
   * every one of them `[DorkOS] Uncaught exception — shutting down`). The
   * chat a person was in the middle of died with it (FB-17).
   *
   * A write that fails is the ordinary meaning of "this process can no longer
   * prove it is alive", which the lock already has an answer for: the record
   * goes stale and the next acquirer steals it after the TTL. So the failure
   * is survivable by design — it just has to be caught and reported to the
   * callers, who step down.
   *
   * `read()` above has always been guarded this way. This one was not, and the
   * asymmetry was the defect.
   *
   * @returns Whether the record was durably written.
   */
  private write(): boolean {
    const tmp = `${this.lockPath}.${this.pid}.${this.startedAt}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.record()));
      renameSync(tmp, this.lockPath);
      // Recovered — let a future outage be reported again.
      this.reportedWriteFailure = false;
      return true;
    } catch (err) {
      this.onWriteFailed(err);
      // Best-effort: a failed rename can leave the temp file behind, and on a
      // full disk every one of those is a file the operator has to find. If
      // this cleanup fails too there is nothing further to do about it.
      try {
        unlinkSync(tmp);
      } catch {
        // Not there, or unremovable — either way, not worth a second report.
      }
      return false;
    }
  }

  /** Read the current record, or `null` if missing/unreadable/malformed. */
  private read(): LockRecord | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.lockPath, 'utf8'));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as LockRecord).pid === 'number' &&
        typeof (parsed as LockRecord).hostname === 'string' &&
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
