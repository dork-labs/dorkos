/**
 * The on-disk record an install transaction keeps beside its target, and the
 * recovery that reads it after a crash (DOR-2273).
 *
 * `runTransaction` (`./transaction.ts`) changes an install target in steps:
 * move the old contents aside, activate the new ones, clean up. A crash can
 * land between any two of them, and the process that comes back has only the
 * disk to go on. So before `activate` runs, the transaction leaves a **record**
 * next to the target, a sibling named
 * `<target>.dorkos-bak-<createdAt>-<owner>-<uuid>[.<state>]`, and the record's
 * name says who wrote it and how far the transaction got:
 *
 * | Record           | On disk                         | Means                                        | Recovery                                     |
 * | ---------------- | ------------------------------- | -------------------------------------------- | -------------------------------------------- |
 * | `backup`         | the old contents (no suffix)    | activation started, never committed          | replace the target with the old contents     |
 * | `absent`         | an empty file (`.absent`)       | fresh install started, never committed       | remove whatever the install left at target   |
 * | `committed`      | the old contents (`.committed`) | the new install is whole; this is leftovers  | delete it                                    |
 *
 * The commit point is one atomic step: renaming `backup` to `committed`, or
 * unlinking the `absent` marker. Anything the transaction had not committed is
 * rolled back, because nothing on disk can say whether a half-activated target
 * is whole: an agent's directory is already in place before its workspace is
 * scaffolded, and a cross-device move is a recursive copy. A content check
 * (a manifest is present, say) would pass exactly those broken states, so the
 * record, not the target, is the verification. The rules that follow:
 *
 * - **A backup is deleted only once it is committed**, which is only after the
 *   new install finished. The old janitor deleted any backup older than a day,
 *   which deleted the only good copy when a crash had left the target missing
 *   or half-written.
 * - **Uncommitted records are undone newest first.** Each one describes the
 *   target as it stood before its own transaction, so undoing them in reverse
 *   order walks the target back to the last committed state. Every
 *   transaction recovers its target before it starts (under the target's
 *   lock), so in one process there is at most one uncommitted record per
 *   target; more than one can only come from a server older than this module,
 *   or from two servers sharing a project (the residual named in
 *   `./transaction.ts`).
 * - **Nothing that does not match the record grammar exactly is touched.** The
 *   uuid is checked in full, so a directory a person happened to name with the
 *   marker in it is left alone.
 * - **Another process's live transaction is never touched.** The install lock
 *   is per process, and two DorkOS servers with different data directories
 *   routinely share a project (the dev server and the installed app). So a
 *   record names the process that wrote it (`./lib/record-owner.ts`: pid,
 *   start time, host), and recovery settles a record only when that process
 *   is this one, or is provably gone, or the record is older than
 *   {@link IN_FLIGHT_FLOOR_MS}. A record that is none of
 *   those belongs to a transaction still running somewhere else: the sweep
 *   leaves the whole target alone, and a new transaction refuses to start.
 *
 * A backup written before this module existed (`<createdAt>-<uuid>`, no
 * owner) is read as a `backup` record whose owner cannot be checked, so only
 * the age floor settles it. Rolling it back is right for every crash the old
 * code could leave behind except one: a crash (or a failed delete) in the old
 * success path's removal of the backup, where the new install was whole and
 * the backup is now restored over it. That window is the length of one
 * directory removal, the old janitor already swept anything older than a day,
 * and restoring the previous version still leaves a working install.
 *
 * Adding a kind of record is one row in the policy table
 * (`INSTALL_RECORD_POLICIES`): its marker, its suffix, and whether recovery
 * rolls it back (with the `undo` that does it) or discards it. DOR-2245's
 * in-place uninstall is the expected next one: its `.dorkos-stage-` leftovers
 * are a `discard` row, and its `.dorkos-uninstall-` directory a `roll-back`
 * row whose `undo` reads the journal that uninstall writes. A new marker must
 * also be added to `MARKETPLACE_INSTALL_SIBLING_MARKERS` in
 * `@dorkos/shared/marketplace-schemas`, which every reader of an install root
 * uses to skip these siblings. The sweep in `./backup-janitor.ts` and the
 * recovery every transaction and uninstall runs pick the row up with no change
 * of their own, and so does the ownership check: every row shares the
 * `<createdAt>-<owner>-<uuid>` stamp and {@link isRecordSettleable}, and
 * `./lib/record-owner.ts` is there for a sibling that needs the owner check
 * outside this grammar.
 *
 * "Whole" here means "committed": the transaction committed only after its
 * `activate` returned. A stronger check of the live target (DOR-2245's record
 * of installed files) belongs in {@link recoverInterruptedInstall}, before a
 * committed leftover is discarded: a target that fails it would then be
 * restored from that leftover instead.
 *
 * Durability is against process crashes (a kill, an out-of-memory exit, a
 * power-button restart of the app): nothing here fsyncs, matching the rest of
 * the install engine.
 *
 * @module services/marketplace/install-recovery
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MARKETPLACE_BACKUP_DIR_MARKER } from '@dorkos/shared/marketplace-schemas';
import { atomicMove } from './lib/atomic-move.js';
import {
  assessRecordOwner,
  currentRecordOwner,
  formatRecordOwner,
  parseRecordOwner,
  RECORD_OWNER_PATTERN,
  type RecordOwner,
} from './lib/record-owner.js';

/**
 * What a transaction record says about its target — see the table in the
 * module header.
 */
export type InstallRecordKind = 'backup' | 'absent' | 'committed';

/** One transaction record found beside an install target. */
export interface InstallRecord {
  /** Absolute path of the record itself. */
  path: string;
  /** What the record says about its target. */
  kind: InstallRecordKind;
  /** `Date.now()` when the transaction wrote the record, parsed from its name. */
  createdAt: number;
  /** The process that wrote it; absent on a record from before owners were stamped. */
  owner?: RecordOwner;
}

/** A record name, parsed: which target it belongs to and what it says. */
export interface ParsedInstallRecordName {
  /** Basename of the install target the record sits beside. */
  targetName: string;
  /** What the record says about that target. */
  kind: InstallRecordKind;
  /** `Date.now()` when the transaction wrote the record. */
  createdAt: number;
  /** The process that wrote it; absent on a record from before owners were stamped. */
  owner?: RecordOwner;
}

/** What {@link recoverInterruptedInstall} did to one target. */
export interface InstallRecoveryReport {
  /** Uncommitted records undone, newest first. */
  rolledBack: InstallRecord[];
  /** Committed leftovers deleted. */
  discarded: InstallRecord[];
  /** Committed leftovers that could not be deleted, with the reason. Harmless; retried next time. */
  discardFailures: { record: InstallRecord; error: unknown }[];
  /**
   * Records a transaction in another live process may still own. When this is
   * non-empty nothing else was done to the target: undoing older records
   * underneath a live one would corrupt it.
   */
  inFlight: InstallRecord[];
}

/**
 * How long a record can belong to a running transaction, at most. A record
 * lives only from just before `activate` to its commit or rollback — a rename
 * and some scaffolding, seconds at most (the slow part of an install, the
 * bounded `npm install`, happens in `stage`, before any record exists). Past
 * this age a record is settled whoever wrote it, which is what bounds the
 * wait when its writer cannot be checked: a record from before owners were
 * stamped, or a platform where a process's start time cannot be read.
 */
export const IN_FLIGHT_FLOOR_MS = 10 * 60_000;

/**
 * The stamp every record carries after its marker: `<createdAt>-<owner>-<uuid>`
 * (the owner is absent on records from before owners were stamped). The uuid
 * is matched in full, as `randomUUID` writes it, so a name that merely
 * contains the marker is never mistaken for a record. Captures: `createdAt`,
 * then the owner's three.
 */
const RECORD_STAMP = `(\\d+)-(?:${RECORD_OWNER_PATTERN}-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;

/**
 * How one kind of record is spelled and what recovery does with it — the
 * policy table the module header describes. Recovery reads nothing else, so a
 * new kind of record is a new row (see the header for the DOR-2245 seam).
 */
interface InstallRecordPolicy {
  /** The kind this row describes. */
  kind: InstallRecordKind;
  /** Basename marker between the target's name and the stamp. */
  marker: string;
  /** Fixed suffix after the stamp (`''` for none). */
  suffix: string;
  /**
   * What recovery does with a record of this kind. `roll-back`: the record is
   * an uncommitted transaction, undone newest first by `undo`, which must
   * leave the record on disk until the target is back. `discard`: the record
   * is leftovers of a committed one, and is deleted.
   */
  recovery:
    | { action: 'roll-back'; undo: (target: string, recordPath: string) => Promise<void> }
    | { action: 'discard' };
}

/** Every kind of record the install engine writes, and its recovery. */
const INSTALL_RECORD_POLICIES: readonly InstallRecordPolicy[] = [
  {
    kind: 'backup',
    marker: MARKETPLACE_BACKUP_DIR_MARKER,
    suffix: '',
    recovery: {
      action: 'roll-back',
      // Whatever stands at the target is the uncommitted install; the backup
      // is the last committed one.
      undo: async (target, recordPath) => {
        await _internal.removePath(target);
        await _internal.move(recordPath, target);
      },
    },
  },
  {
    kind: 'absent',
    marker: MARKETPLACE_BACKUP_DIR_MARKER,
    suffix: '.absent',
    recovery: {
      action: 'roll-back',
      // There was nothing here before, so whatever stands at the target is
      // the uncommitted install.
      undo: async (target, recordPath) => {
        await _internal.removePath(target);
        await _internal.removePath(recordPath);
      },
    },
  },
  {
    kind: 'committed',
    marker: MARKETPLACE_BACKUP_DIR_MARKER,
    suffix: '.committed',
    recovery: { action: 'discard' },
  },
];

/** The policy row for `kind`. */
function policyFor(kind: InstallRecordKind): InstallRecordPolicy {
  const policy = INSTALL_RECORD_POLICIES.find((p) => p.kind === kind);
  if (!policy) throw new Error(`No install record policy for kind "${kind}"`);
  return policy;
}

/**
 * Parse a directory entry's name as a transaction record.
 *
 * @param entryName - A basename found in an install target's parent directory.
 * @returns The parsed record name, or `undefined` when the name is not a
 *   record (including a name that contains a marker but not the full grammar).
 */
export function parseInstallRecordName(entryName: string): ParsedInstallRecordName | undefined {
  for (const policy of INSTALL_RECORD_POLICIES) {
    const idx = entryName.lastIndexOf(policy.marker);
    if (idx <= 0) continue;
    const tail = entryName.slice(idx + policy.marker.length);
    const match = new RegExp(`^${RECORD_STAMP}${escapeRegExp(policy.suffix)}$`).exec(tail);
    if (!match) continue;
    const createdAt = Number(match[1]);
    if (!Number.isSafeInteger(createdAt)) continue;
    const [, , pid, startedAt, host] = match;
    const owner =
      pid === undefined || startedAt === undefined || host === undefined
        ? undefined
        : parseRecordOwner(pid, startedAt, host);
    if (pid !== undefined && owner === undefined) continue;
    return {
      targetName: entryName.slice(0, idx),
      kind: policy.kind,
      createdAt,
      ...(owner === undefined ? {} : { owner }),
    };
  }
  return undefined;
}

/** Escape `text` for literal use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Write the record for a transaction that is about to activate `target`.
 *
 * An existing target is moved aside as a `backup` record (a sibling, so the
 * move and any restore are same-filesystem renames). A missing target gets an
 * empty `absent` marker file instead, creating the parent directory the
 * activation is about to write into anyway. Either way, from here until
 * {@link commitInstallRecord} a crash is undone by recovery.
 *
 * @param target - Absolute path of the install target.
 * @returns The record now on disk beside `target`.
 */
export async function beginInstallRecord(target: string): Promise<InstallRecord> {
  const createdAt = Date.now();
  const owner = currentRecordOwner();
  // The owner is part of the name, so it lands in the same atomic step that
  // creates the record — there is no moment a record exists without one.
  const stamp = `${createdAt}-${formatRecordOwner(owner)}-${randomUUID()}`;
  if (await pathExists(target)) {
    const backupPath = recordPath(target, 'backup', stamp);
    await atomicMove(target, backupPath);
    return { path: backupPath, kind: 'backup', createdAt, owner };
  }
  const markerPath = recordPath(target, 'absent', stamp);
  await mkdir(path.dirname(target), { recursive: true });
  // `wx`: the uuid makes a collision impossible, and if one happened anyway
  // the marker must not silently adopt someone else's file.
  await writeFile(markerPath, '', { flag: 'wx' });
  return { path: markerPath, kind: 'absent', createdAt, owner };
}

/**
 * Commit a transaction: the new target is whole, so the record stops asking
 * for a rollback. This is the transaction's commit point and it is one atomic
 * step — a `backup` is renamed to `committed`, an `absent` marker is unlinked.
 *
 * @param record - The record {@link beginInstallRecord} returned.
 * @returns The `committed` leftover to delete, or `undefined` when nothing is
 *   left (a fresh install).
 * @throws When the commit step itself fails; the record is then still
 *   uncommitted and the caller must roll back, because recovery would.
 */
export async function commitInstallRecord(
  record: InstallRecord
): Promise<InstallRecord | undefined> {
  if (record.kind === 'absent') {
    await rm(record.path);
    return undefined;
  }
  if (record.kind === 'committed') return record;
  const committedPath = `${record.path}${policyFor('committed').suffix}`;
  await rename(record.path, committedPath);
  return { ...record, path: committedPath, kind: 'committed' };
}

/**
 * Undo an uncommitted transaction: put `target` back the way it was before
 * the transaction that wrote `record` began.
 *
 * The record is removed (an `absent` marker) or consumed (a `backup` becomes
 * the target again) only after the target is back, so a crash or an error
 * part-way leaves the record in place and the next recovery finishes the job.
 *
 * @param target - Absolute path of the install target.
 * @param record - An uncommitted record for that target.
 * @throws On any filesystem failure, with the record still on disk.
 */
export async function rollBackInstallRecord(target: string, record: InstallRecord): Promise<void> {
  const { recovery } = policyFor(record.kind);
  if (recovery.action !== 'roll-back') {
    throw new Error(`A ${record.kind} install record cannot be rolled back: ${record.path}`);
  }
  await recovery.undo(target, record.path);
}

/**
 * Delete a committed leftover. The new install already finished, so this is
 * housekeeping: a failure costs disk space, never the install.
 *
 * @param record - A `committed` record.
 */
export async function discardCommittedRecord(record: InstallRecord): Promise<void> {
  await _internal.removePath(record.path);
}

/**
 * Bring one install target back to its last committed state after a crash.
 *
 * Deletes every committed leftover beside `target`, then undoes every
 * uncommitted record newest first (see the module header for why that order).
 * Stops at the first rollback that fails and throws, leaving that record and
 * any older ones on disk for the next attempt; carrying on past it would undo
 * an older transaction on top of a newer one that is still half-applied.
 *
 * Must run with the target's install lock held (`withInstallTargetLock`), so
 * no live transaction in this process owns the records it reads. A record
 * another live process may own makes this a no-op for the whole target (see
 * {@link InstallRecoveryReport.inFlight}).
 *
 * @param target - Absolute path of the install target.
 * @returns What was rolled back and discarded.
 * @throws When an uncommitted record cannot be rolled back.
 */
export async function recoverInterruptedInstall(target: string): Promise<InstallRecoveryReport> {
  const records = await listInstallRecords(target);
  const report: InstallRecoveryReport = {
    rolledBack: [],
    discarded: [],
    discardFailures: [],
    inFlight: [],
  };

  const now = Date.now();
  report.inFlight = records.filter((r) => !isRecordSettleable(r, now));
  if (report.inFlight.length > 0) return report;

  const byRecovery = (action: InstallRecordPolicy['recovery']['action']) =>
    records.filter((r) => policyFor(r.kind).recovery.action === action);

  for (const record of byRecovery('discard')) {
    try {
      await discardCommittedRecord(record);
      report.discarded.push(record);
    } catch (error) {
      report.discardFailures.push({ record, error });
    }
  }

  const uncommitted = byRecovery('roll-back').sort(
    (a, b) => b.createdAt - a.createdAt || b.path.localeCompare(a.path)
  );
  for (const record of uncommitted) {
    await rollBackInstallRecord(target, record);
    report.rolledBack.push(record);
  }
  return report;
}

/**
 * Whether recovery may act on `record` now: its writer is this process (whose
 * own transactions the install lock excludes), its writer is provably gone, or
 * it is older than {@link IN_FLIGHT_FLOOR_MS}. Anything else may belong to a
 * transaction still running in another process.
 *
 * @param record - A record found beside an install target.
 * @param now - The current time, in ms since the epoch.
 */
export function isRecordSettleable(record: InstallRecord, now: number): boolean {
  if (now - record.createdAt >= IN_FLIGHT_FLOOR_MS) return true;
  if (record.owner === undefined) return false;
  return assessRecordOwner(record.owner) !== 'maybe-running';
}

/**
 * Every transaction record sitting beside `target`.
 *
 * @internal
 */
async function listInstallRecords(target: string): Promise<InstallRecord[]> {
  const dir = path.dirname(target);
  const targetName = path.basename(target);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const records: InstallRecord[] = [];
  for (const name of names) {
    const parsed = parseInstallRecordName(name);
    if (parsed?.targetName !== targetName) continue;
    records.push({
      path: path.join(dir, name),
      kind: parsed.kind,
      createdAt: parsed.createdAt,
      ...(parsed.owner === undefined ? {} : { owner: parsed.owner }),
    });
  }
  return records;
}

/**
 * The path of a record of `kind` for `target`.
 *
 * @internal
 */
function recordPath(target: string, kind: InstallRecordKind, stamp: string): string {
  const policy = policyFor(kind);
  return `${target}${policy.marker}${stamp}${policy.suffix}`;
}

/**
 * Returns true when anything stands at `target` — a file, a directory, or a
 * symlink, dangling or not: everything a rename would have to move.
 *
 * @internal
 */
async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Remove a path (file or directory) recursively; a missing path is fine.
 *
 * @internal
 */
async function removePath(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

/**
 * @internal Test-only export. The supported API is the functions above; these
 * helpers are exposed only so tests can stop or fail a rollback part-way with
 * `vi.spyOn` (the "cannot spy on a `node:fs/promises` named export" ESM limit),
 * mirroring the `_internal` object in `./transaction.ts`.
 */
export const _internal = {
  removePath,
  move: atomicMove,
};
