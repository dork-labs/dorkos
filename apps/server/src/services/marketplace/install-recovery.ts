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
 * | `legacy-backup`  | old contents, no owner in name  | written before these records existed         | restore only if the target is missing        |
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
 * - **Nothing made after a transaction died is undone with it.** A target
 *   created more than {@link IN_FLIGHT_FLOOR_MS} after its record was
 *   written cannot be that transaction's work — it is someone's own, put
 *   where a long-dead install once was — so a `backup` or `absent` record
 *   beside it is kept, with the target, rather than restored over it or
 *   removed with it.
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
 * owner) is a `legacy-backup`, and the old code left one behind in two very
 * different situations: a crash mid-install (the backup is the whole copy)
 * and a failed delete after a SUCCESSFUL install (the backup may be partial,
 * the target whole). Nothing on disk tells them apart. So it is restored only
 * when the target is missing, where it is certainly the only copy; beside an
 * existing target both are kept and logged, and the next install or
 * uninstall of that target that finishes deletes it
 * ({@link discardSupersededRecords}). Its writer cannot be checked, so it
 * waits for the age floor like any unprovable record.
 *
 * Adding a kind of record is one row in the policy table
 * (`INSTALL_RECORD_POLICIES`): its marker, whether its stamp carries an
 * owner, its suffix, and its phase — `finished` (deleted) or `unfinished`,
 * with a `recover` that settles it and reports `rolled-back`,
 * `rolled-forward` or `kept`. DOR-2245's in-place uninstall is the expected
 * next one: its `.dorkos-stage-` leftovers are a `finished` row, and its
 * `.dorkos-uninstall-` directory an `unfinished` row whose `recover` reads the
 * journal that uninstall writes and rolls back or forward by it. A new marker must
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
export type InstallRecordKind = 'backup' | 'absent' | 'committed' | 'legacy-backup';

/** What recovering one unfinished record did. */
export type RecordOutcome =
  /** The target is back as it was before the record's transaction began. */
  | 'rolled-back'
  /** The record's transaction was carried through to its end (no current row does this; DOR-2245's uninstall will). */
  | 'rolled-forward'
  /** Nothing proves which side is whole, so target and record were both left as they are. */
  | 'kept';

/** One transaction record found beside an install target. */
export interface InstallRecord {
  /** Absolute path of the record itself. */
  path: string;
  /** What the record says about its target. */
  kind: InstallRecordKind;
  /** `Date.now()` when the transaction wrote the record, parsed from its name. */
  createdAt: number;
  /** The process that wrote it; absent on a `legacy-backup`. */
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
  /** The process that wrote it; absent on a `legacy-backup`. */
  owner?: RecordOwner;
}

/** What {@link recoverInterruptedInstall} did to one target. */
export interface InstallRecoveryReport {
  /** Unfinished records settled, newest first, with what settling did. */
  settled: { record: InstallRecord; outcome: Exclude<RecordOutcome, 'kept'> }[];
  /**
   * Unfinished records left in place, with their target, because settling
   * them could destroy something: a `legacy-backup` beside an existing target
   * (nothing proves which copy is whole), or a record whose target was made
   * after its transaction could still have been running (someone else's
   * work). The next change that finishes on this target supersedes them: see
   * {@link discardSupersededRecords}.
   */
  kept: InstallRecord[];
  /** Leftovers of finished transactions deleted. */
  discarded: InstallRecord[];
  /** Leftovers that could not be deleted, with the reason. Harmless; retried next time. */
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
 * bounded `npm install`, happens in `stage`, before any record exists). A
 * record whose `createdAt` is at least this far from now, in either direction
 * (a clock set back leaves records dated in the future), is settled whoever
 * wrote it. That bounds the wait when the writer cannot be checked: a
 * `legacy-backup`, another machine, or a platform where a process's start
 * time cannot be read.
 */
export const IN_FLIGHT_FLOOR_MS = 10 * 60_000;

/** The `<uuid>` every record ends its stamp with, matched in full, as `randomUUID` writes it. */
const RECORD_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

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
  /**
   * Whether the stamp carries its writer: `<createdAt>-<owner>-<uuid>` when
   * true, `<createdAt>-<uuid>` when false (only records from before owners
   * were stamped).
   */
  owned: boolean;
  /** Fixed suffix after the stamp (`''` for none). */
  suffix: string;
  /**
   * What recovery does with a record of this kind. `unfinished`: the record's
   * transaction never reached its end; `recover` settles it (newest first
   * across a target's records) and says how, and must leave the record on
   * disk until the target is settled, so a crash part-way is retried.
   * `finished`: the record is leftovers of a transaction that completed, and
   * is deleted. A `kept` outcome leaves both the record and the target as
   * they are (see {@link InstallRecoveryReport.kept}).
   */
  recovery:
    | {
        phase: 'unfinished';
        recover: (target: string, record: InstallRecord) => Promise<RecordOutcome>;
      }
    | { phase: 'finished' };
}

/** Every kind of record the install engine writes, and its recovery. */
const INSTALL_RECORD_POLICIES: readonly InstallRecordPolicy[] = [
  {
    kind: 'backup',
    marker: MARKETPLACE_BACKUP_DIR_MARKER,
    owned: true,
    suffix: '',
    recovery: {
      phase: 'unfinished',
      // Whatever stands at the target is the uncommitted install; the backup
      // is the last committed one — unless the target was made after the
      // transaction could still have been running, by someone else.
      recover: async (target, record) => {
        if (await madeAfterRecord(target, record)) return 'kept';
        await _internal.removePath(target);
        await _internal.move(record.path, target);
        return 'rolled-back';
      },
    },
  },
  {
    kind: 'absent',
    marker: MARKETPLACE_BACKUP_DIR_MARKER,
    owned: true,
    suffix: '.absent',
    recovery: {
      phase: 'unfinished',
      // There was nothing here before, so whatever stands at the target is
      // the uncommitted install — unless it was made after the transaction
      // could still have been running, by someone else. The target goes
      // first: the marker is what says it has to.
      recover: async (target, record) => {
        if (await madeAfterRecord(target, record)) return 'kept';
        await _internal.removePath(target);
        await _internal.removePath(record.path);
        return 'rolled-back';
      },
    },
  },
  {
    kind: 'committed',
    marker: MARKETPLACE_BACKUP_DIR_MARKER,
    owned: true,
    suffix: '.committed',
    recovery: { phase: 'finished' },
  },
  {
    kind: 'legacy-backup',
    marker: MARKETPLACE_BACKUP_DIR_MARKER,
    owned: false,
    suffix: '',
    recovery: {
      phase: 'unfinished',
      // Written by a server from before commit records existed, which also
      // left one behind whenever deleting it after a SUCCESSFUL install failed
      // part-way — so it may be the partial copy, and the target the whole
      // one. It is restored only where it is certainly the only copy.
      recover: async (target, record) => {
        if (await pathExists(target)) return 'kept';
        await _internal.move(record.path, target);
        return 'rolled-back';
      },
    },
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
    const ownerGroup = policy.owned ? `${RECORD_OWNER_PATTERN}-` : '';
    const match = new RegExp(
      `^(\\d+)-${ownerGroup}${RECORD_UUID}${escapeRegExp(policy.suffix)}$`
    ).exec(tail);
    if (!match) continue;
    const createdAt = Number(match[1]);
    if (!Number.isSafeInteger(createdAt)) continue;
    let owner: RecordOwner | undefined;
    if (policy.owned) {
      owner = parseRecordOwner(match[2] ?? '', match[3] ?? '', match[4] ?? '');
      if (owner === undefined) continue;
    }
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
  if (record.kind !== 'backup') {
    throw new Error(`Only a transaction's own record can be committed: ${record.path}`);
  }
  const committedPath = `${record.path}${policyFor('committed').suffix}`;
  await rename(record.path, committedPath);
  return { ...record, path: committedPath, kind: 'committed' };
}

/**
 * Undo this process's own uncommitted transaction after its `activate` or
 * commit failed: put `target` back the way it was before the transaction
 * began. The same step crash recovery runs, so a failure part-way leaves the
 * record in place and the next recovery finishes the job.
 *
 * @param target - Absolute path of the install target.
 * @param record - The record {@link beginInstallRecord} returned.
 * @throws On any filesystem failure, with the record still on disk.
 */
export async function rollBackInstallRecord(target: string, record: InstallRecord): Promise<void> {
  const outcome = await recoverRecord(target, record);
  if (outcome !== 'rolled-back') {
    throw new Error(`Recovering ${record.path} did not roll it back (${outcome})`);
  }
}

/**
 * Delete a leftover of a finished transaction. The install it belonged to
 * already finished, so this is housekeeping: a failure costs disk space,
 * never the install.
 *
 * @param record - A `committed` record.
 */
export async function discardCommittedRecord(record: InstallRecord): Promise<void> {
  await _internal.removePath(record.path);
}

/**
 * Delete records a recovery kept (see {@link InstallRecoveryReport.kept}) once
 * a later change to the same target has finished — a committed install, or a
 * completed uninstall. That change is proof the person has what they asked
 * for, so the kept copy is no longer anyone's only copy; left in place, it
 * would be restored the next time the target went missing, bringing back a
 * package the person had since uninstalled.
 *
 * @param records - The `kept` records of the recovery that ran first.
 * @returns Records that could not be deleted, with the reason.
 */
export async function discardSupersededRecords(
  records: readonly InstallRecord[]
): Promise<{ record: InstallRecord; error: unknown }[]> {
  const failures: { record: InstallRecord; error: unknown }[] = [];
  for (const record of records) {
    try {
      await _internal.removePath(record.path);
    } catch (error) {
      failures.push({ record, error });
    }
  }
  return failures;
}

/**
 * Bring one install target back to a settled state after a crash.
 *
 * Deletes every finished leftover beside `target`, then settles every
 * unfinished record newest first (see the module header for why that order).
 * Stops at the first record that fails to settle and throws, leaving it and
 * any older ones on disk for the next attempt; carrying on past it would undo
 * an older transaction on top of a newer one that is still half-applied.
 *
 * Must run with the target's install lock held (`withInstallTargetLock`), so
 * no live transaction in this process owns the records it reads. A record
 * another live process may own makes this a no-op for the whole target (see
 * {@link InstallRecoveryReport.inFlight}).
 *
 * @param target - Absolute path of the install target.
 * @returns What was settled, kept and discarded.
 * @throws When an unfinished record cannot be settled.
 */
export async function recoverInterruptedInstall(target: string): Promise<InstallRecoveryReport> {
  const records = await listInstallRecords(target);
  const report: InstallRecoveryReport = {
    settled: [],
    kept: [],
    discarded: [],
    discardFailures: [],
    inFlight: [],
  };

  const now = Date.now();
  report.inFlight = records.filter((r) => !isRecordSettleable(r, now));
  if (report.inFlight.length > 0) return report;

  const inPhase = (phase: InstallRecordPolicy['recovery']['phase']) =>
    records.filter((r) => policyFor(r.kind).recovery.phase === phase);

  for (const record of inPhase('finished')) {
    try {
      await discardCommittedRecord(record);
      report.discarded.push(record);
    } catch (error) {
      report.discardFailures.push({ record, error });
    }
  }

  const unfinished = inPhase('unfinished').sort(
    (a, b) => b.createdAt - a.createdAt || b.path.localeCompare(a.path)
  );
  for (const record of unfinished) {
    const outcome = await recoverRecord(target, record);
    if (outcome === 'kept') report.kept.push(record);
    else report.settled.push({ record, outcome });
  }
  return report;
}

/**
 * Why recovery kept `record`, in words for a log line.
 *
 * @param record - A record from {@link InstallRecoveryReport.kept}.
 */
export function keptReason(record: InstallRecord): string {
  return record.kind === 'legacy-backup'
    ? 'the record predates commit records, so nothing proves which copy is whole'
    : 'the target was made after the interrupted install, so it is not the install to undo';
}

/**
 * Whether any transaction record sits beside `target`. For a caller that
 * must not conclude "not installed" from a missing target alone: a crash can
 * leave the target missing with its previous install in a record beside it.
 *
 * @param target - Absolute path of the install target.
 */
export async function hasInstallRecords(target: string): Promise<boolean> {
  return (await listInstallRecords(target)).length > 0;
}

/**
 * Whether recovery may act on `record` now: its writer is this process (whose
 * own transactions the install lock excludes), its writer is provably gone, or
 * its `createdAt` is at least {@link IN_FLIGHT_FLOOR_MS} from `now` either
 * way. Anything else may belong to a transaction still running in another
 * process.
 *
 * @param record - A record found beside an install target.
 * @param now - The current time, in ms since the epoch.
 */
export function isRecordSettleable(record: InstallRecord, now: number): boolean {
  if (Math.abs(now - record.createdAt) >= IN_FLIGHT_FLOOR_MS) return true;
  if (record.owner === undefined) return false;
  return assessRecordOwner(record.owner) !== 'maybe-running';
}

/**
 * The latest moment by which every one of `records` is settleable whoever
 * wrote it — when a refused change is certain to be allowed. `now` when the
 * list is empty.
 *
 * @param records - Records {@link isRecordSettleable} refused.
 * @param now - The current time, in ms since the epoch.
 */
export function settleableBy(records: readonly InstallRecord[], now: number): number {
  return Math.max(now, ...records.map((r) => r.createdAt + IN_FLIGHT_FLOOR_MS));
}

/**
 * Settle one unfinished record by its kind's policy row.
 *
 * @internal
 */
async function recoverRecord(target: string, record: InstallRecord): Promise<RecordOutcome> {
  const { recovery } = policyFor(record.kind);
  if (recovery.phase !== 'unfinished') {
    throw new Error(
      `A ${record.kind} install record is finished and has nothing to recover: ${record.path}`
    );
  }
  return recovery.recover(target, record);
}

/**
 * Whether what stands at `target` was made after `record`'s transaction
 * could still have been running — by the person, most likely, putting
 * something of their own where a long-dead install once was. Recovery leaves
 * such a target alone (and keeps the record), because undoing a transaction
 * must never delete or overwrite work that came after it.
 *
 * Uses the target's creation time, or its status-change time where the
 * filesystem records no creation time. Either is at or after the moment the
 * transaction's own writes landed, and a transaction's writes land within
 * {@link IN_FLIGHT_FLOOR_MS} of its record, so a target the transaction made
 * never passes this. A missing target is not "made after" anything.
 *
 * @internal
 */
async function madeAfterRecord(target: string, record: InstallRecord): Promise<boolean> {
  let made: number;
  try {
    const stats = await _internal.statTarget(target);
    made = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.ctimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  return made > record.createdAt + IN_FLIGHT_FLOOR_MS;
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
  // A wrapper, not `lstat` itself: reading the import here would run at module
  // load, and a test that mocks `node:fs/promises` without `lstat` would then
  // fail just by importing anything that reaches the install engine.
  statTarget: (target: string) => lstat(target),
};
