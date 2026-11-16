/**
 * A task's DorkOS-only run controls (DOR-4315), over the store's database: the
 * allow list its own agent set and each program's pin, whether it is a
 * one-shot task, and the claim on that one run. Never in the SKILL.md, so a
 * file edit can't reach them. Every caller has already decided and audited the
 * change (`services/tasks/allow-list/`).
 *
 * @module services/tasks/store/task-run-controls
 */
import { and, eq, isNull } from 'drizzle-orm';
import { pulseSchedules, type Db } from '@dorkos/db';
import type { Task } from '@dorkos/shared/types';
import { parsePins, serializePins, type AllowListPins } from '../allow-list/allow-list-pins.js';

/** What {@link TaskRunControls.set} may change; an omitted control is left alone. */
export interface RunControlsWrite {
  /** The task-run rules, written to `approvedAllow` (empty clears it). */
  approvedAllow?: readonly string[];
  /** The rules shown on the task's card, kept in step when a list narrows. */
  requestedAllow?: readonly string[] | null;
  /** Each agent-set program's pin. */
  allowListPins?: AllowListPins;
  /** Whether it is a one-shot task. */
  runOnce?: boolean;
}

/** The run controls of every task in one database. */
export class TaskRunControls {
  constructor(private readonly db: Db) {}

  /**
   * Write a task's run controls.
   *
   * @param id - The task.
   * @param controls - What to change.
   * @returns Whether a row was written.
   */
  set(id: string, controls: RunControlsWrite): boolean {
    const set: Partial<typeof pulseSchedules.$inferInsert> = {};
    if (controls.approvedAllow !== undefined)
      set.approvedAllow = rulesColumn(controls.approvedAllow);
    if (controls.requestedAllow !== undefined) {
      set.requestedAllow = controls.requestedAllow ? rulesColumn(controls.requestedAllow) : null;
    }
    if (controls.allowListPins !== undefined)
      set.allowListPins = serializePins(controls.allowListPins);
    if (controls.runOnce !== undefined) set.runOnce = controls.runOnce;
    if (Object.keys(set).length === 0) return false;
    set.updatedAt = new Date().toISOString();
    return (
      this.db.update(pulseSchedules).set(set).where(eq(pulseSchedules.id, id)).run().changes === 1
    );
  }

  /**
   * A task's pins: each agent-set program's real path and hash when it was
   * set, and when its first list was set. Never on the `Task`, which every API
   * reader carries.
   *
   * @param id - The task.
   */
  pinsOf(id: string): AllowListPins {
    const row = this.db
      .select({ pins: pulseSchedules.allowListPins })
      .from(pulseSchedules)
      .where(eq(pulseSchedules.id, id))
      .get();
    return parsePins(row?.pins);
  }

  /**
   * Claim a one-shot task's one run: records when it started, and only when no
   * run has. Atomic, so two fires (a restart, a second process) can't both win.
   *
   * @param id - The task.
   * @returns Whether this caller claimed the run.
   */
  claimOneShot(id: string): boolean {
    const result = this.db
      .update(pulseSchedules)
      .set({ ranOnceAt: new Date().toISOString() })
      .where(
        and(
          eq(pulseSchedules.id, id),
          eq(pulseSchedules.runOnce, true),
          isNull(pulseSchedules.ranOnceAt)
        )
      )
      .run();
    return result.changes === 1;
  }
}

/**
 * Whether a one-shot task's one run is due now, claimed by this caller: a
 * one-shot task that has not run, and whose claim this call won.
 *
 * @param task - The task as the scheduler reads it.
 * @param controls - The store's run controls, for the claim.
 */
export function oneShotDue(
  task: Pick<Task, 'id' | 'runOnce' | 'ranOnceAt'>,
  controls: Pick<TaskRunControls, 'claimOneShot'>
): boolean {
  return task.runOnce === true && !task.ranOnceAt && controls.claimOneShot(task.id);
}

/** A rule list as its column holds it: `null` for none. */
function rulesColumn(rules: readonly string[]): string | null {
  return rules.length > 0 ? JSON.stringify(rules) : null;
}
