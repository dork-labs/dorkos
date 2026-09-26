/**
 * The file half of the task store: turning a SKILL.md into a row, pausing a row
 * whose file went away, and finding a row by its file.
 *
 * `upsertFromFile` is the primary create path for every task, and each of its
 * writes runs its content gates (`file-sync-gates.ts`) and lands the row, parked
 * where the arm gate says so, in the same synchronous call, so no caller can see
 * a row that skipped them. Moved out of `task-store.ts` verbatim (DOR-2329) so
 * the store keeps the rows and runs; the store owns one instance,
 * `TaskStore.fileSync`, on the same database handle.
 *
 * Its own directory because `services/tasks` is past the file-count ceiling;
 * `timing/`, `approvals/` and `execution/` set the precedent.
 *
 * @module services/tasks/sync/task-file-sync
 */
import { eq } from 'drizzle-orm';
import { pulseSchedules, type Db } from '@dorkos/db';
import { ulid } from 'ulidx';
import type { Task } from '@dorkos/shared/types';
import type { TaskDefinition } from '@dorkos/skills/types';
import { parseDuration } from '@dorkos/skills/duration';
import {
  FileSyncGates,
  fileProvenance,
  fileSettingsOf,
  type FileSyncSource,
} from '../file-sync-gates.js';
import { mapTaskRow } from '../task-row-mappers.js';
import { scheduleContentKey } from '../schedule-permission-clamp.js';
import { effectiveContentKey } from '../timing/effective-timing.js';

/**
 * What {@link TaskFileSync.upsertFromFile} needs to know beyond the file itself:
 * who is writing, and what is wrong with the file.
 *
 * Defined by the module that acts on it — see {@link FileSyncSource}, which
 * documents both fields — and re-exported here under the name its one caller
 * uses.
 */
export type UpsertFromFileOptions = FileSyncSource;

/**
 * Syncs SKILL.md files into task rows, over the same database the store writes.
 * See the module TSDoc for why this is one synchronous step.
 */
export class TaskFileSync {
  /**
   * The content gates every file-sourced write passes: the permission clamp and
   * the arm gate, plus the memory that keeps a standing refusal from writing a
   * log line every five minutes (`file-sync-gates.ts`). Public because deleting
   * a task forgets its path here too.
   */
  readonly fileGates = new FileSyncGates();

  /**
   * Build the sync over the store's database.
   *
   * @param db - The store's database handle.
   * @param getTask - The store's own row reader, so an upsert answers with the
   *   task exactly as every other store read maps it.
   */
  constructor(
    private readonly db: Db,
    private readonly getTask: (id: string) => Task | null
  ) {}

  /**
   * Upsert a task from a parsed SKILL.md file definition.
   *
   * @see {@link UpsertFromFileOptions} for what `options` decides.
   *
   * Looks up existing tasks by `filePath`. If found, updates in place.
   * If not found, inserts a new row with a fresh ULID.
   *
   * The file's declared `permissions` is resolved through
   * {@link resolveFilePermissionMode} rather than written straight in: this is
   * the primary create path for every task, and a file on disk is nobody's
   * approval. Read that function for what a file may and may not do to the mode.
   *
   * `options.source` decides whether the SECOND content gate applies. A write
   * from `discovery` — the watcher or the reconciler finding a file — can never
   * arm itself and parks at `pending_approval` until a person says otherwise
   * ({@link resolveFileArmStatus}). A write from `operator` is a person or an
   * install acting through DorkOS, and the act itself is the approval, so the
   * status is left exactly as it was. That is the default, because it is what
   * every caller here did before the gate existed.
   *
   * @param def - Parsed task definition from a SKILL.md file
   * @param agentId - Agent ID derived from directory location (optional)
   * @param options - Where the write came from, and what is wrong with the file
   * @returns The upserted Task
   */
  upsertFromFile(def: TaskDefinition, agentId?: string, options?: UpsertFromFileOptions): Task {
    const now = new Date().toISOString();
    // The schedule block is the only place scheduling lives since DOR-1486.
    // Until then this read went through a flattened copy of it that discovery
    // built for the legacy roots' benefit; those roots are gone and so is the
    // copy.
    const schedule = def.meta.schedule;
    const maxRuntimeMs = schedule['max-runtime'] ? parseDuration(schedule['max-runtime']) : null;

    const existing = this.db
      .select()
      .from(pulseSchedules)
      .where(eq(pulseSchedules.filePath, def.filePath))
      .get();

    const incomingCron = schedule.cron ?? '';
    // What a file on disk may do to this row, decided in one place so the
    // permission clamp and the arm gate cannot disagree — see
    // `file-sync-gates.ts` and `schedule-permission-clamp.ts`.
    const { permissionMode, arm, keepsRowEnabled, dropsTimingOverride, packageOwned } =
      this.fileGates.resolve(def, existing, options);

    if (existing) {
      this.db
        .update(pulseSchedules)
        .set({
          name: def.name,
          displayName: def.meta['display-name'] ?? null,
          description: def.meta.description ?? null,
          prompt: def.body,
          cron: incomingCron,
          timezone: schedule.timezone,
          agentId: agentId ?? null,
          // The file's switch, unless the row is the only place a person's own
          // can live: a schedule inside an installed package is one DorkOS
          // refuses to write, so switching it on is recorded on the row and
          // this sync must not copy `enabled: false` back over it (FB-26).
          // `file-sync-gates.ts` owns that condition.
          ...(keepsRowEnabled ? {} : { enabled: schedule.enabled }),
          sticky: schedule.sticky,
          maxRuntime: maxRuntimeMs,
          permissionMode,
          // The file is the source of truth for these three, like every other
          // scheduling column here — so a key REMOVED from the block clears the
          // row's override rather than leaving a stale one behind (DOR-1615).
          runtime: schedule.runtime ?? null,
          model: schedule.model ?? null,
          effort: schedule.effort ?? null,
          account: schedule.account ?? null,
          // The file is no longer a package's, so it is the one source of
          // timing again (DOR-2302, `FileSyncGates.dropsTimingOverride`).
          ...(dropsTimingOverride ? { cronOverride: null, timezoneOverride: null } : {}),
          // Who owns the file, kept so the next sync can see ownership lapse and
          // the app can show it (DOR-2272); `file-sync-gates.ts` decides what to
          // record while a release is still being written. A write that did not
          // ask leaves it as it was.
          ...(packageOwned !== undefined ? { packageOwned } : {}),
          // A `paused` row whose file is back is un-paused here, because
          // nothing else ever will: the scheduler requires `enabled` AND
          // `status === 'active'`, and restoring only `enabled` leaves a task
          // that looks live and never fires.
          //
          // Safe because `paused` is a server-owned signal, not a person's
          // choice. It is written only by this service — file gone
          // (`markRemovedByFilePath`), agent unregistered
          // (`disableTasksByAgentId`) — and `SettableTaskStatusSchema` keeps
          // the update API from setting it, precisely because a DB-only status
          // cannot survive this line. A person pausing a task sends
          // `enabled: false`, which lands in the file's frontmatter and is
          // re-read above, so their choice holds.
          // `pending_approval` is untouched: that gate is a person's to clear.
          //
          // Under the arm gate this un-pausing is the gate's call instead: a
          // returning file keeps its approval when the content key still
          // matches (a save is an unlink-and-recreate), and re-parks when it
          // does not.
          ...(arm
            ? {
                status: arm.status,
                ...fileProvenance(existing, arm),
                // Parking withdraws the grant, so the next sync has to ask again
                // rather than finding a key it left lying around.
                ...(arm.status === 'pending_approval'
                  ? {
                      approvedContentKey: null,
                      // Kept for the card's "what changed" (DOR-2323).
                      previousApprovalKey:
                        existing.approvedContentKey ?? existing.previousApprovalKey,
                    }
                  : { previousApprovalKey: null }),
              }
            : existing.status === 'paused'
              ? {
                  status: 'active' as const,
                  // ...and with a grant, because this branch ARMS the row. An
                  // operator write that un-pauses a schedule is the operator's
                  // approval of it, exactly as the insert branch treats a create;
                  // leaving the key null would put the row live and ungranted
                  // until the next sync noticed and parked it (DOR-1485 review,
                  // R2). Reachable through `shape-schedule-service` and through a
                  // route write over a path whose file had been deleted.
                  // What will RUN, a person's own timing included (DOR-2302).
                  approvedContentKey: effectiveContentKey({
                    ...existing,
                    ...fileSettingsOf(def),
                    prompt: def.body,
                    cron: incomingCron,
                    timezone: schedule.timezone,
                  }),
                  previousApprovalKey: null,
                }
              : {}),
          tags: '[]',
          updatedAt: now,
        })
        .where(eq(pulseSchedules.id, existing.id))
        .run();
      return this.getTask(existing.id)!;
    }

    const id = ulid();
    this.db
      .insert(pulseSchedules)
      .values({
        id,
        name: def.name,
        displayName: def.meta['display-name'] ?? null,
        description: def.meta.description ?? null,
        prompt: def.body,
        cron: incomingCron,
        timezone: schedule.timezone,
        agentId: agentId ?? null,
        enabled: schedule.enabled,
        sticky: schedule.sticky,
        maxRuntime: maxRuntimeMs,
        permissionMode,
        runtime: schedule.runtime ?? null,
        model: schedule.model ?? null,
        effort: schedule.effort ?? null,
        account: schedule.account ?? null,
        status: arm?.status ?? 'active',
        reason: arm?.reason ?? null,
        origin: arm ? 'file' : null,
        reasonSource: arm?.reason ? 'dorkos' : null,
        // An operator write IS the approval — the install or the route that
        // reached here is a person acting through DorkOS — so it arrives with a
        // grant. A discovered file never does; it has to be looked at first.
        approvedContentKey: arm
          ? null
          : scheduleContentKey({
              ...fileSettingsOf(def),
              prompt: def.body,
              cron: incomingCron,
              timezone: schedule.timezone,
            }),
        filePath: def.filePath,
        packageOwned: options?.packageOwned ?? null,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return this.getTask(id)!;
  }

  /**
   * Pause the one task whose file lived at `filePath`, because it is gone.
   *
   * Matched on the exact absolute path, never on the directory slug. Slugs are
   * only unique within one tasks directory, and DorkOS watches several at once
   * (the global one plus every registered agent's), so a slug match pauses a
   * live task in another project that happens to share the name — observed on
   * real data with two `flow-drain` tasks in different checkouts.
   *
   * The arm grant is deliberately LEFT ALONE here. A schedule whose file went
   * away has not been un-approved by anybody; if the same content comes back —
   * which is what an ordinary atomic-rename save looks like from the outside, and
   * what a package update does — the stored key still matches and the schedule
   * picks up where it left off. If different content comes back, the key does not
   * match and it parks. Neither outcome needs this method to have an opinion,
   * which is the point of storing the grant rather than inferring it from status:
   * an earlier round of this work had to special-case `pending_approval` here to
   * stop a pause laundering a missing approval, and that special case is now
   * unnecessary.
   *
   * `enabled` is left alone for the same reason. `paused` alone stops the clock
   * (the scheduler needs `enabled` AND `active`), and `enabled` is a person's
   * switch, not the server's. For most files the returning file's own switch is
   * copied back anyway, but a schedule shipped in an installed package keeps its
   * switch on the row (FB-26, `file-sync-gates.ts`), and a package update looks
   * like the file going away and coming back. Writing `false` here erased the
   * person's approval with nothing anywhere saying why.
   *
   * @param filePath - Absolute path to the SKILL.md that is no longer on disk
   * @returns The number of tasks marked as removed (0 or 1)
   */
  markRemovedByFilePath(filePath: string): number {
    // A file that came back is a fresh conflict, worth stating again.
    this.fileGates.forget(filePath);
    const now = new Date().toISOString();
    const result = this.db
      .update(pulseSchedules)
      .set({ status: 'paused', updatedAt: now })
      .where(eq(pulseSchedules.filePath, filePath))
      .run();
    return result.changes;
  }

  /**
   * Find the task defined by an exact SKILL.md path.
   *
   * Keyed on the full path, never a directory slug: a slug is unique only
   * within one tasks directory, and DorkOS watches the global one plus every
   * registered agent's, so a slug lookup silently returns an arbitrary one of
   * several matches.
   *
   * @param filePath - Absolute path to the task's SKILL.md
   * @returns The matching Task or null
   */
  getByFilePath(filePath: string): Task | null {
    const row = this.db
      .select()
      .from(pulseSchedules)
      .where(eq(pulseSchedules.filePath, filePath))
      .get();
    return row ? mapTaskRow(row) : null;
  }
}
