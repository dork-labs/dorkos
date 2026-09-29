/**
 * The two questions a SKILL.md has to answer before it becomes a row.
 *
 * Both are asked of CONTENT rather than of a caller: what permission mode may
 * this file have (`resolveFilePermissionMode`), and may it arm itself at all
 * (`resolveFileArmStatus`). The rules themselves live in
 * `schedule-permission-clamp.ts`, keyed on one shared content key so they
 * cannot disagree; what lives HERE is the asking — reading the columns each
 * rule needs off the existing row, and the log damping that keeps a standing
 * refusal from writing a line every five minutes forever.
 *
 * Lifted out of `TaskStore.upsertFromFile` (DOR-1485) for the same reason
 * `task-row-mappers.ts` was: the store file is about PERSISTENCE — what is
 * written, when, and under what guard — and the guards had grown into the
 * larger half of its one write path.
 *
 * @module services/tasks/file-sync-gates
 */
import type { PermissionMode } from '@dorkos/shared/schemas';
import type { TaskDefinition } from '@dorkos/skills/types';
import type { pulseSchedules } from '@dorkos/db';
import { parseDuration } from '@dorkos/skills/duration';
import {
  CHANGED_REASON,
  resolveFileArmStatus,
  resolveFilePermissionMode,
  scheduleContentKey,
  scheduleSettingsOf,
  type FileArmVerdict,
  type IncomingTaskContent,
  type ScheduleSettings,
} from './schedule-permission-clamp.js';
import {
  AGENT_CONTENT_CHANGE_REASON,
  AGENT_SETTINGS_CHANGE_REASON,
  AGENT_TIMING_CHANGE_REASON,
  effectiveContentKey,
  effectiveTiming,
} from './timing/effective-timing.js';

/**
 * The park sentences a sync keeps on a row still parked at the same content
 * (DOR-2313): each says why a schedule that WAS approved is waiting, and stays
 * true until the content changes again. Without this the next sync rewrote
 * every one of them as "DorkOS found this schedule in a file", because a park
 * withdraws the grant the gate reads to tell "changed" from "found". A
 * validation complaint is deliberately not here: it is about the file, and the
 * file's own answer on each sync is the one to show.
 */
const KEPT_PARK_REASONS: ReadonlySet<string> = new Set([
  CHANGED_REASON,
  AGENT_TIMING_CHANGE_REASON,
  AGENT_CONTENT_CHANGE_REASON,
  AGENT_SETTINGS_CHANGE_REASON,
]);
import { logger } from '../../lib/logger.js';

/** Where a file-sourced write came from, and what is wrong with the file. */
export interface FileSyncSource {
  /** `discovery` is subject to the arm gate; `operator` is the person's own act. */
  source?: 'operator' | 'discovery';
  /** The validation complaint to park with, when there is one. */
  problem?: string | null;
  /**
   * Whether an installed package owns this file, and how that is known —
   * `packageOwnershipInRoot`, asked by whoever found it. `null` means the file
   * is the person's; absent means nobody asked.
   *
   * Answered by the caller rather than here because it is a question about the
   * filesystem and this is a synchronous gate. Discovery asks it; a route or an
   * install does not need to, because the write it is making is a person's.
   * The store keeps the answer on the row (`package_owned`), which is how the
   * next sync sees a file STOP being a package's (DOR-2272).
   */
  packageOwned?: 'record' | 'legacy' | null;
}

/** What the gates decided about one incoming file. */
export interface FileSyncVerdict {
  /** The permission mode to write — never more than the file may introduce. */
  permissionMode: PermissionMode;
  /**
   * The status and reason to write, or `null` when the arm gate does not apply
   * (an operator write, whose status the store leaves alone).
   */
  arm: FileArmVerdict | null;
  /**
   * Whether the ROW's `enabled` stands and the file's is not copied over it.
   *
   * True for one case only — see {@link FileSyncGates.keepsRowEnabled} — and
   * false everywhere else, because the file is the source of truth for every
   * scheduling column and that does not change.
   */
  keepsRowEnabled: boolean;
  /**
   * Whether the row's timing override is dropped by this sync, because its file
   * is no longer a package's (DOR-2302). See {@link FileSyncGates.dropsTimingOverride}.
   */
  dropsTimingOverride: boolean;
  /**
   * The ownership to record on the row, or `undefined` to leave it alone (a
   * write that did not ask). See {@link FileSyncGates.packageOwnedToWrite}.
   */
  packageOwned: 'record' | 'legacy' | 'unknown' | null | undefined;
}

/**
 * The {@link ScheduleSettings} a SKILL.md declares, in the row's terms: the
 * same values `TaskStore.upsertFromFile` writes into the row, so the key of
 * what arrives and the key of the row it lands on can be compared.
 *
 * @param def - The parsed file.
 */
export function fileSettingsOf(def: TaskDefinition): ScheduleSettings {
  const schedule = def.meta.schedule;
  return {
    name: def.name,
    runtime: schedule.runtime ?? null,
    model: schedule.model ?? null,
    effort: schedule.effort ?? null,
    maxRuntime: schedule['max-runtime'] ? parseDuration(schedule['max-runtime']) : null,
    sticky: schedule.sticky,
    account: schedule.account ?? null,
  };
}

/**
 * Asks the content gates, and remembers what it has already complained about.
 *
 * Stateful for exactly one reason: the refusal log needs to know what it said
 * last time about this path. One instance per {@link TaskStore}.
 */
export class FileSyncGates {
  /**
   * Path → the refused version last logged about it.
   *
   * Keyed on the refused CONTENT, not the path alone. The reconciler re-reads
   * every file every five minutes, so warning per sync turns one standing
   * refusal into twelve log lines an hour; but keying on the path alone would
   * swallow the line that matters most — a file rewritten under a grant it used
   * to hold is a NEW refusal, and must not be silenced by an earlier one at the
   * same path.
   */
  private refusedFileGrants = new Map<string, string>();

  /**
   * Decide what this file gets.
   *
   * @param def - The parsed file being synced.
   * @param existing - The row it is landing on, when there is one.
   * @param options - Where the write came from, and any validation complaint.
   * @returns The permission mode to write, and the arm verdict when one applies.
   */
  resolve(
    def: TaskDefinition,
    existing: typeof pulseSchedules.$inferSelect | undefined,
    options?: FileSyncSource
  ): FileSyncVerdict {
    const fileCron = def.meta.schedule.cron ?? '';
    // Both gates compare what will RUN, not what the file says (DOR-2302). A
    // package's schedule can carry a person's own cron on its row, which the
    // sync never overwrites — so the incoming content runs on that cron, and a
    // package update that changes only its default timing is not new work to
    // approve. A changed prompt still is. An override this sync drops runs no
    // longer, so it is not part of what arrives.
    const dropsTimingOverride = this.dropsTimingOverride(existing, options);
    // The timezone is part of what runs, and of the approval, since DOR-2307;
    // the settings since DOR-2323 (`ScheduleSettings`).
    const incoming = {
      ...fileSettingsOf(def),
      prompt: def.body,
      cron: (dropsTimingOverride ? null : existing?.cronOverride) ?? fileCron,
      timezone:
        (dropsTimingOverride ? null : existing?.timezoneOverride) ?? def.meta.schedule.timezone,
    };
    const approved = existing && {
      ...scheduleSettingsOf(existing),
      permissionMode: existing.permissionMode as PermissionMode,
      status: existing.status,
      prompt: existing.prompt,
      ...effectiveTiming(existing),
      approvedContentKey: existing.approvedContentKey,
    };

    const { mode: permissionMode, clamped } = resolveFilePermissionMode(
      def.meta.schedule.permissions,
      approved,
      incoming
    );
    // The refusal is about the FILE asking for more than it got, so its log key
    // is the file's own content.
    this.reportRefusal(def, fileCron, clamped);

    // Only discovery is subject to the arm gate: a file DorkOS found is nobody's
    // decision to run, while a route write is a person's (ADR `260823-200726`).
    const verdict =
      options?.source === 'discovery'
        ? resolveFileArmStatus(approved, incoming, options.problem)
        : null;
    const arm =
      verdict && options && this.keepsParkReason(verdict, existing, incoming, options)
        ? { ...verdict, reason: existing!.reason }
        : verdict;

    const keepsRowEnabled = this.keepsRowEnabled(existing, arm, options);
    return {
      permissionMode,
      arm,
      keepsRowEnabled,
      dropsTimingOverride,
      packageOwned: this.packageOwnedToWrite(def, existing, keepsRowEnabled, options),
    };
  }

  /**
   * Whether this sync keeps the sentence the row was parked with, instead of
   * writing the arm gate's (DOR-2313).
   *
   * A park withdraws the grant, so the gate reading the same file afterwards has
   * only "DorkOS found this schedule in a file" to say, which is false for a
   * schedule a person approved before: an agent's own request that parked it
   * (`TaskApprovals.settleApprovedWorkChange`), or an earlier sync that saw its
   * file change. The earlier sentence ({@link KEPT_PARK_REASONS}) stands while
   * it is still true: the row is parked, the file has nothing wrong with it,
   * and what would run is exactly the work that was parked. Any new change to
   * the file is new work, and the gate's own sentence takes over.
   */
  private keepsParkReason(
    verdict: FileArmVerdict,
    existing: typeof pulseSchedules.$inferSelect | undefined,
    incoming: IncomingTaskContent,
    options: FileSyncSource
  ): boolean {
    return (
      verdict.status === 'pending_approval' &&
      !options.problem &&
      existing?.status === 'pending_approval' &&
      existing.reasonSource === 'dorkos' &&
      existing.reason !== null &&
      KEPT_PARK_REASONS.has(existing.reason) &&
      effectiveContentKey(existing) === scheduleContentKey(incoming)
    );
  }

  /**
   * The ownership to record on the row after this sync.
   *
   * Discovery's answer, with one exception that makes the release of a file
   * TWO-PHASE (DOR-2272). While the row keeps a switch the file does not say
   * yet, the row keeps its previous ownership, so every later sync, from the
   * watcher or the reconciler, in any order, still sees a file being released
   * and keeps the switch too. Only once the file says what the row does (the
   * caller wrote it, `carrySwitchIntoReleasedFile`) is `null` recorded. A write
   * that fails, or two syncs that interleave, therefore cost a retry, never the
   * person's switch.
   */
  private packageOwnedToWrite(
    def: TaskDefinition,
    existing: typeof pulseSchedules.$inferSelect | undefined,
    keepsRowEnabled: boolean,
    options?: FileSyncSource
  ): FileSyncVerdict['packageOwned'] {
    if (options?.packageOwned === undefined) return undefined;
    const switchNotInFile =
      options.packageOwned === null &&
      existing?.packageOwned != null &&
      keepsRowEnabled &&
      existing.enabled !== def.meta.schedule.enabled;
    return switchNotInFile ? existing.packageOwned : options.packageOwned;
  }

  /**
   * Whether a person's timing override stops applying at this sync.
   *
   * An override exists only because DorkOS would not write the package's file.
   * When discovery finds the file is no longer a package's — the package was
   * uninstalled and left the file in place, so it is now the person's to edit —
   * the file is the one source of timing again. Keeping the override would make
   * a hand edit of the file's cron do nothing, and leave the Schedules page
   * saying "the package runs this…" about a package that is gone.
   *
   * Only discovery answers `packageOwned`; a route or an install does not say
   * (absent), and that is not an answer.
   *
   * The timing that runs changes with it, so the arm gate compares the file's
   * own timing against the approval: it stays live when the two agree (the
   * person wrote their timing into the file), and asks again otherwise.
   *
   * A package reinstalled over the same file later brings no override back.
   * One that vanished and came back instead — an update, or an uninstall that
   * took the file with it and a reinstall — never looked unowned, so its
   * override is still there.
   */
  private dropsTimingOverride(
    existing: typeof pulseSchedules.$inferSelect | undefined,
    options?: FileSyncSource
  ): boolean {
    // `packageOwned` is only ever answered by discovery; absent is not `null`.
    if (options?.packageOwned !== null) return false;
    return (
      existing !== undefined &&
      (existing.cronOverride !== null || existing.timezoneOverride !== null)
    );
  }

  /**
   * Whether this row's own `enabled` survives the sync instead of being
   * overwritten from the file (FB-26).
   *
   * **The file is the source of truth for every scheduling column, including
   * this one — unless DorkOS refuses to write the file.** A schedule shipped
   * inside an installed package is exactly that case: the update door will not
   * edit somebody else's checkout, so a person switching the schedule on has
   * nowhere to be recorded but the row, and copying the package's `enabled:
   * false` back over it would undo their approval at the next sweep with
   * nothing anywhere saying why. For those files, and only those, the switch
   * belongs to the row.
   *
   * It belongs to the row only while the row's approval stands, which is what
   * the arm gate says: **it leaves the row `active` only when the file's prompt
   * and cron are still the ones the person approved.** A row being re-parked is
   * a row whose content changed under it, and a person's "yes, run this" does
   * not carry over to work they have not read; the package's own switch governs
   * again until they approve the new content. A parked row never keeps its
   * switch, so switching a package schedule on without approving it arms
   * nothing and is undone by the next sweep (DOR-607).
   *
   * A row coming back from `paused` is NOT an exception. A package update is an
   * unlink and a reappearance; `markRemovedByFilePath` only pauses and leaves
   * `enabled` as the person set it, and the approval the arm gate just
   * re-checked decides whether that switch still stands. An earlier version of
   * this rule took the file's value on a paused return, which left an updated
   * package's schedule `active` and switched off with no card and no
   * notification: the FB-26 symptom back, quieter.
   *
   * **The moment a file stops being a package's, the row's switch still
   * stands** (DOR-2272). Until then the row was the only place the person's
   * switch could live, so it disagrees with the file on purpose; copying the
   * file's value over it then would switch back ON a schedule the person had
   * switched off. So on that one sync the row keeps an OFF switch outright, and
   * an ON switch under the same approval rule as above, and the caller writes
   * the kept switch into the file, which is now the person's to write
   * (`carrySwitchIntoReleasedFile`). A lapse is reachable: a later version
   * that stops shipping the file, a legacy record rebuilt without proof of it,
   * a record edited by hand, or a row older than the column (`unknown`), which
   * may have been a package's under the old rule; for that last one only an OFF
   * switch is kept, since the file may be the person's own choice. The release lasts until the
   * file agrees ({@link FileSyncGates.packageOwnedToWrite}).
   *
   * @param existing - The row the file is landing on, when there is one.
   * @param arm - What the arm gate decided, or `null` for an operator write.
   * @param options - Where the write came from, and whether a package owns it.
   * @returns True when the store must leave `enabled` alone.
   */
  private keepsRowEnabled(
    existing: typeof pulseSchedules.$inferSelect | undefined,
    arm: FileArmVerdict | null,
    options?: FileSyncSource
  ): boolean {
    if (existing === undefined || options?.packageOwned === undefined) return false;
    if (options.packageOwned !== null) return arm?.status === 'active';
    if (existing.packageOwned === null) return false;
    // A row older than the column (`unknown`) may have been the person's all
    // along, whose file then says what they last chose; only an OFF row is kept
    // against it, the safe direction, never an ON one (DOR-2272 review, T4).
    if (existing.packageOwned === 'unknown') return existing.enabled === false;
    return existing.enabled === false || arm?.status === 'active';
  }

  /** Forget what was said about a path, because its file went away. */
  forget(filePath: string): void {
    this.refusedFileGrants.delete(filePath);
  }

  /**
   * Say once, per refused version of a file, that it asked for more than it got.
   *
   * Serialized rather than concatenated: a prompt can hold any text at all, and
   * a separator the prompt can also hold lets two different files share one key
   * — swallowing exactly the warning this keying exists to preserve.
   */
  private reportRefusal(def: TaskDefinition, cron: string, clamped: boolean): void {
    if (!clamped) {
      this.refusedFileGrants.delete(def.filePath);
      return;
    }
    const refusal = JSON.stringify([def.meta.schedule.permissions, def.body, cron]);
    if (this.refusedFileGrants.get(def.filePath) === refusal) return;
    this.refusedFileGrants.set(def.filePath, refusal);
    logger.warn(
      `TaskStore: ${def.filePath} asked to run with every approval prompt turned off. ` +
        `DorkOS synced it with the normal prompts instead; you can change that on the task.`
    );
  }
}

/**
 * The provenance columns a discovery sync may write to a row that ALREADY
 * EXISTS — which is usually none of them.
 *
 * Discovery re-reads every file every five minutes, and the legacy roots it
 * reads hold rows that discovery did not create: an agent's proposal, carrying
 * the case it made for itself and the session it was proposed from, and an
 * operator's own schedule, carrying nothing. Writing the arm gate's generic
 * story over either one destroys real provenance — an agent's reason replaced
 * by "DorkOS found this schedule in a file", an operator's row stamped
 * `origin: 'file'` in flat contradiction of what that column means (DOR-1485
 * review, B2).
 *
 * So:
 *
 * - `origin` is written only when the row was BORN from discovery. A row that
 *   arrived through a route is never re-labelled by a later sync of its file.
 * - `reason` is written only when discovery owns the row, or when the row has
 *   no story of its own to overwrite.
 * - `reasonSource` rides with any reason we DO write, marking it as DorkOS's
 *   own words. Without it the drift sentence on an operator's own schedule
 *   rendered on the approval card as an agent's quoted case — our words in
 *   somebody else's mouth.
 *
 * The arm STATUS is not conditional and is applied by the caller regardless:
 * that is the security property, and it holds for every row whatever wrote it.
 *
 * @param existing - The row being updated.
 * @param arm - What the arm gate decided.
 * @returns The provenance columns to include in the update, possibly none.
 */
export function fileProvenance(
  existing: { origin: string | null; reason: string | null },
  arm: { reason: string | null }
): { reason?: string | null; origin?: 'file'; reasonSource?: 'dorkos' | null } {
  const source = arm.reason === null ? null : ('dorkos' as const);
  if (existing.origin === 'file')
    return { reason: arm.reason, origin: 'file', reasonSource: source };
  if (existing.reason === null) return { reason: arm.reason, reasonSource: source };
  return {};
}
