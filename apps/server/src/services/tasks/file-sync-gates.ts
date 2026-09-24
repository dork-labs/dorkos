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
import {
  resolveFileArmStatus,
  resolveFilePermissionMode,
  type FileArmVerdict,
} from './schedule-permission-clamp.js';
import { effectiveTiming } from './timing/effective-timing.js';
import { logger } from '../../lib/logger.js';

/** Where a file-sourced write came from, and what is wrong with the file. */
export interface FileSyncSource {
  /** `discovery` is subject to the arm gate; `operator` is the person's own act. */
  source?: 'operator' | 'discovery';
  /** The validation complaint to park with, when there is one. */
  problem?: string | null;
  /**
   * Whether an installed package owns this file — `isPackageOwnedInRoot`, asked
   * by whoever found it.
   *
   * Answered by the caller rather than here because it is a question about the
   * filesystem and this is a synchronous gate. Discovery asks it; a route or an
   * install does not need to, because the write it is making is a person's.
   */
  packageOwned?: boolean;
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
    const incoming = {
      prompt: def.body,
      cron: (dropsTimingOverride ? null : existing?.cronOverride) ?? fileCron,
    };
    const approved = existing && {
      permissionMode: existing.permissionMode as PermissionMode,
      status: existing.status,
      prompt: existing.prompt,
      cron: effectiveTiming(existing).cron,
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
    const arm =
      options?.source === 'discovery'
        ? resolveFileArmStatus(approved, incoming, options.problem)
        : null;

    return {
      permissionMode,
      arm,
      keepsRowEnabled: this.keepsRowEnabled(existing, arm, options),
      dropsTimingOverride,
    };
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
    // `packageOwned` is only ever answered by discovery; absent is not `false`.
    if (options?.packageOwned !== false) return false;
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
    if (options?.packageOwned !== true || existing === undefined) return false;
    return arm?.status === 'active';
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
