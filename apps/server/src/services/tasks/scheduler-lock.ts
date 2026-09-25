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

import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
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

/** What an exclusive create came to: see {@link SchedulerLock.createExclusive}. */
type CreateOutcome = 'created' | 'exists' | 'failed';

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
   * the next successful write of either kind — see
   * {@link SchedulerLock.onWriteFailed} and {@link SchedulerLock.onWriteSucceeded}.
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
      const created = this.createExclusive();
      if (created === 'created') {
        this.leader = true;
        return true;
      }
      if (created === 'failed') {
        this.leader = false;
        return false;
      }
      // The file exists. Usually another process just claimed it: re-read, and
      // a whole record there makes us a follower (its fresh lock is not ours).
      const claimed = this.read();
      if (claimed !== null) {
        this.leader = this.isOurs(claimed);
        return this.leader;
      }
      // Present but unreadable: debris from a write that died partway (an older
      // build wrote the lock in place, so a full disk or a crash could leave it
      // empty or cut short). Nothing will ever parse it, and obeying it would
      // keep every process a follower forever, so it is claimed exactly like a
      // stale lock, through the atomic overwrite below (DOR-2131). The one
      // live case that looks the same is another process between its create
      // and its write, a window of microseconds; overwriting then is the same
      // brief two-leader handoff a concurrent stale-steal already has, settled
      // by that process's next heartbeat and covered by dispatch idempotency.
    }
    // Stale or unreadable lock, or already ours → claim by atomic overwrite,
    // then verify we won (a concurrent steal may have raced us; last rename wins).
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
   * log file competing for the space that ran out. The flag resets on the
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
   * End a spell of write failures, so the next one is reported again.
   *
   * Both write paths call this. When only the rename path did, a spell that
   * ended with a fresh create (the usual first acquire after a clean shutdown)
   * left the flag set, and every later outage went unreported (DOR-2132).
   */
  private onWriteSucceeded(): void {
    this.reportedWriteFailure = false;
  }

  /**
   * Exclusively create the lock file (O_EXCL) and write our record into it.
   *
   * - `'created'`: the file is ours and holds a whole record.
   * - `'exists'`: a file was already there; the caller re-reads it.
   * - `'failed'`: anything else. Never a throw: this is reached from the
   *   heartbeat timer via `tryAcquire`, so a throw here is the same uncaught
   *   exception, and the same whole-server shutdown, that
   *   {@link SchedulerLock.write} documents. An unwritable lock file means we
   *   did not become leader; it never means the process should die.
   *
   * The open and the write are separate steps so a failure between them is
   * ours to clean up: the file we just created is removed rather than left
   * empty at the lock path, where it would be the unreadable debris
   * `tryAcquire` otherwise has to steal (DOR-2131). It never unlinks a file
   * someone else owns: a failed open created nothing, and after a failed write
   * the path is removed only while it still names the file we opened, since
   * another process may have claimed our empty file in the meantime and
   * renamed its own whole record over it.
   */
  private createExclusive(): CreateOutcome {
    let fd: number;
    try {
      fd = openSync(this.lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      this.onWriteFailed(err);
      return 'failed';
    }
    let written = false;
    // Which file we created, so cleanup can tell it from a replacement.
    let created: { dev: number; ino: number } | null = null;
    try {
      created = fstatSync(fd);
      const data = Buffer.from(JSON.stringify(this.record()));
      // `writeSync` may write fewer bytes than asked; loop until the record is whole.
      for (let offset = 0; offset < data.length;) {
        offset += writeSync(fd, data, offset, data.length - offset);
      }
      written = true;
    } catch (err) {
      this.onWriteFailed(err);
    }
    try {
      closeSync(fd);
    } catch (err) {
      // A close can surface a deferred write error on some filesystems, so a
      // record we cannot close is not one we can trust.
      if (written) this.onWriteFailed(err);
      written = false;
    }
    if (written) {
      this.onWriteSucceeded();
      return 'created';
    }
    try {
      const current = statSync(this.lockPath);
      if (created !== null && current.dev === created.dev && current.ino === created.ino) {
        unlinkSync(this.lockPath);
      }
    } catch {
      // Already gone, or not removable; `tryAcquire` claims unreadable debris anyway.
    }
    return 'failed';
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
      this.onWriteSucceeded();
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
