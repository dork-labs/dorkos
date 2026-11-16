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
import { outsideAuditScope } from '../../audit/audit-context.js';
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

  /**
   * Give back a one-shot task's claim when its fire wrote no run, so it is due
   * again the next time it is armed (`fireOneShot`).
   *
   * @param id - The task.
   */
  releaseOneShot(id: string): void {
    this.db
      .update(pulseSchedules)
      .set({ ranOnceAt: null })
      .where(and(eq(pulseSchedules.id, id), eq(pulseSchedules.runOnce, true)))
      .run();
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

/** What {@link fireOneShot} reads of the store. */
export interface OneShotStore {
  /** How many runs a task has. */
  countRuns: (taskId?: string) => number;
  /** The claim's release. */
  runControls: Pick<TaskRunControls, 'releaseOneShot'>;
}

/**
 * Fire a claimed one-shot task's one run, and give the claim back when the
 * fire wrote no run row: a task parked for a person or switched off between
 * arming and firing never ran, so it stays due and runs when it is armed
 * again. A skipped run writes its row, so it keeps the claim: that was its run,
 * and the person reads why on it.
 *
 * @param store - The store: its run count and run controls.
 * @param taskId - The task.
 * @param dispatch - The scheduler's dispatch of this fire.
 */
export async function fireOneShot(
  store: OneShotStore,
  taskId: string,
  dispatch: () => Promise<void>
): Promise<void> {
  // Counted before and after, so a trial run from before arming is not this fire's row.
  const before = store.countRuns(taskId);
  try {
    await dispatch();
  } finally {
    if (store.countRuns(taskId) === before) store.runControls.releaseOneShot(taskId);
  }
}

/**
 * Arm a one-shot task in a process that may fire: when its one run is due
 * and this call wins the claim, fire it once the computer has settled,
 * outside the arming caller's audit scope, as a timer fire is.
 *
 * @param store - The store: its run controls and run count.
 * @param wakeSettle - The scheduler's wake-settle gate.
 * @param task - The task as the scheduler reads it.
 * @param dispatch - The scheduler's dispatch for a fire at an instant.
 */
export function armOneShot(
  store: OneShotStore & { runControls: Pick<TaskRunControls, 'claimOneShot'> },
  wakeSettle: { run: (fire: (at: Date) => Promise<void>, name: string) => void },
  task: Pick<Task, 'id' | 'name' | 'runOnce' | 'ranOnceAt'>,
  dispatch: (at: Date) => Promise<void>
): void {
  if (!oneShotDue(task, store.runControls)) return;
  const fire = (at: Date) => fireOneShot(store, task.id, () => dispatch(at));
  outsideAuditScope(() => wakeSettle.run(fire, task.name))();
}

/** A rule list as its column holds it: `null` for none. */
function rulesColumn(rules: readonly string[]): string | null {
  return rules.length > 0 ? JSON.stringify(rules) : null;
}
