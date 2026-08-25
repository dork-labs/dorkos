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
import { logger } from '../../lib/logger.js';

/** Where a file-sourced write came from, and what is wrong with the file. */
export interface FileSyncSource {
  /** `discovery` is subject to the arm gate; `operator` is the person's own act. */
  source?: 'operator' | 'discovery';
  /** The validation complaint to park with, when there is one. */
  problem?: string | null;
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
    const incoming = { prompt: def.body, cron: def.meta.schedule.cron ?? '' };
    const approved = existing && {
      permissionMode: existing.permissionMode as PermissionMode,
      status: existing.status,
      prompt: existing.prompt,
      cron: existing.cron,
      approvedContentKey: existing.approvedContentKey,
    };

    const { mode: permissionMode, clamped } = resolveFilePermissionMode(
      def.meta.schedule.permissions,
      approved,
      incoming
    );
    this.reportRefusal(def, incoming.cron, clamped);

    // Only discovery is subject to the arm gate: a file DorkOS found is nobody's
    // decision to run, while a route write is a person's (ADR `260823-200726`).
    const arm =
      options?.source === 'discovery'
        ? resolveFileArmStatus(approved, incoming, options.problem)
        : null;

    return { permissionMode, arm };
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
