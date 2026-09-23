/**
 * Who wrote a marketplace install record, and whether that writer might still
 * be running (DOR-2273).
 *
 * The install lock is per process, and two DorkOS servers with different data
 * directories routinely work on the same project (the dev server and the
 * installed app on one machine). So a record the install engine leaves beside
 * a target carries its writer, and recovery acts on another writer's record
 * only once that writer is provably gone — undoing a record between a live
 * transaction's two renames would destroy that transaction's install.
 *
 * An owner is three facts, all of which the rule below uses:
 *
 * - `pid`, the writer's process id.
 * - `startedAt`, the writer's start time in whole seconds, read by
 *   {@link readProcessStartSeconds} — the same function that later reads a
 *   candidate's start time, so both sides come from one clock and one format.
 *   `0` when it could not be read.
 * - `host`, a short hash of the machine's hostname. A project in a synced
 *   folder can carry a record to another machine, where a pid means nothing.
 *
 * The rule never errs towards "gone": a pid that is not running on this host
 * is gone, and a running pid is gone only when its start time was read on both
 * sides and it started well after the owner did (the OS recycled the pid).
 * Anything unreadable, a different host, or a start time within
 * {@link DEFAULT_PID_REUSE_TOLERANCE_MS} of the owner's reads as possibly
 * running, and only the caller's age floor settles it. Start times are
 * compared with that tolerance rather than for equality because a live
 * process's reported start time moves when the wall clock is stepped (see
 * `@dorkos/shared/process-liveness`), and an equality check would then read
 * a live owner as gone.
 *
 * Windows has no `ps`, so there a running pid is always "possibly running"
 * and the age floor decides; a pid that is not running is still gone.
 *
 * The owner is written into the record's own name (see
 * {@link RECORD_OWNER_PATTERN}), so it lands in the same atomic step that
 * creates the record, and no second file can go missing or be orphaned.
 *
 * @module services/marketplace/lib/record-owner
 */
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import {
  DEFAULT_PID_REUSE_TOLERANCE_MS,
  isProcessAlive,
  processStartTime,
} from '@dorkos/shared/process-liveness';

/** The process that wrote an install record. */
export interface RecordOwner {
  /** The writer's process id. */
  pid: number;
  /** The writer's start time in whole seconds since the epoch; `0` when unreadable. */
  startedAt: number;
  /** First 8 hex characters of the SHA-256 of the writer's hostname. */
  host: string;
}

/** What can be established about a record's writer. */
export type RecordOwnerState =
  /** This process, or an earlier process that had this pid (and so is not running). */
  | 'this-process'
  /** Not running on this host: exited, or its pid now belongs to a newer process. */
  | 'gone'
  /** Might still be running; only an age floor may settle its records. */
  | 'maybe-running';

/**
 * Regular-expression source for an owner inside a record name:
 * `<pid>-<startedAt>-<host>`, with three capture groups in that order. Pass
 * the captures to {@link parseRecordOwner}.
 */
export const RECORD_OWNER_PATTERN = '(\\d+)-(\\d+)-([0-9a-f]{8})';

/**
 * Spell an owner the way {@link RECORD_OWNER_PATTERN} reads it.
 *
 * @param owner - The owner to write into a record name.
 */
export function formatRecordOwner(owner: RecordOwner): string {
  return `${owner.pid}-${owner.startedAt}-${owner.host}`;
}

/**
 * Build an owner from {@link RECORD_OWNER_PATTERN}'s three captures.
 *
 * @param pid - First capture.
 * @param startedAt - Second capture.
 * @param host - Third capture.
 * @returns The owner, or `undefined` when a number is out of range.
 */
export function parseRecordOwner(
  pid: string,
  startedAt: string,
  host: string
): RecordOwner | undefined {
  const pidNumber = Number(pid);
  const startedAtNumber = Number(startedAt);
  if (!Number.isSafeInteger(pidNumber) || pidNumber <= 0) return undefined;
  if (!Number.isSafeInteger(startedAtNumber)) return undefined;
  return { pid: pidNumber, startedAt: startedAtNumber, host };
}

/** This process's owner, computed once (its start time costs one `ps`). */
let currentOwner: RecordOwner | undefined;

/**
 * The owner this process writes into its records.
 *
 * @returns This process's pid, start time and host tag.
 */
export function currentRecordOwner(): RecordOwner {
  currentOwner ??= {
    pid: process.pid,
    startedAt: _internal.readProcessStartSeconds(process.pid) ?? 0,
    host: hostTag(hostname()),
  };
  return currentOwner;
}

/**
 * Whether a record's writer might still be running — see the module header
 * for the rule and why it never errs towards "gone".
 *
 * @param owner - The owner parsed from a record name.
 */
export function assessRecordOwner(owner: RecordOwner): RecordOwnerState {
  const me = currentRecordOwner();
  if (owner.host !== me.host) return 'maybe-running';
  // The only running process with this pid is this one, so a record carrying
  // it is either ours (and the install lock rules out a live transaction) or
  // was left by an earlier process that had the same pid — a container
  // restart, say — and is not running.
  if (owner.pid === me.pid) return 'this-process';
  if (!_internal.isProcessAlive(owner.pid)) return 'gone';
  if (owner.startedAt === 0) return 'maybe-running';
  const startedAt = _internal.readProcessStartSeconds(owner.pid);
  if (startedAt === null) return 'maybe-running';
  const toleranceSeconds = DEFAULT_PID_REUSE_TOLERANCE_MS / 1000;
  return startedAt > owner.startedAt + toleranceSeconds ? 'gone' : 'maybe-running';
}

/**
 * A process's start time in whole seconds, or `null` when this platform
 * cannot say. The one reader of start times for both writing and checking an
 * owner; Windows is `null` outright, because its `ps`, when one is on the
 * path at all, is not the POSIX one `processStartTime` speaks to.
 *
 * @internal
 */
function readProcessStartSeconds(pid: number): number | null {
  if (process.platform === 'win32') return null;
  const startedAt = processStartTime(pid);
  return startedAt === null ? null : Math.floor(startedAt.getTime() / 1000);
}

/**
 * A short, filename-safe tag for a hostname.
 *
 * @internal
 */
function hostTag(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 8);
}

/**
 * @internal Test-only export: lets a test stand in for another process, or
 * for a platform that cannot read start times, with `vi.spyOn`.
 */
export const _internal = {
  isProcessAlive,
  readProcessStartSeconds,
};
