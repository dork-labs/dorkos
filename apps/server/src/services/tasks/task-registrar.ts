/**
 * The one place a task's row becomes a live cron job, or stops being one.
 *
 * ## The seam this closes
 *
 * Tasks are file-first: a SKILL.md on disk is the truth, the `pulse_schedules`
 * row is a cache of it, and the running `croner` job is a cache of the row.
 * Four writers keep the row in step with disk — the file watcher, the
 * reconciler, and the two write routes — and until this module existed only the
 * routes went on to touch the scheduler. The watcher was handed a callback that
 * did nothing at all (`new TaskFileWatcher(store, () => {}, dorkHome)`), and the
 * reconciler held no scheduler reference of any kind.
 *
 * So the second cache silently stopped tracking the first. Editing a cron in a
 * task's SKILL.md updated the row, showed the new time in the cockpit, and left
 * the old job firing on the old schedule until the next server restart. A new
 * SKILL.md dropped into `~/.dork/tasks/` got a row and never fired at all. A
 * task paused because its file went missing was un-paused when the file came
 * back — `upsertFromFile` does that deliberately — and then never ran again.
 *
 * Every writer now calls {@link TaskRegistrar.syncTask} instead of reasoning
 * about the scheduler itself, so "when is this task registered?" has exactly one
 * answer in exactly one place.
 *
 * @module services/tasks/task-registrar
 */
import type { Task } from '@dorkos/shared/types';
import type { TaskStore } from './task-store.js';
import { createTaggedLogger } from '../../lib/logger.js';

const logger = createTaggedLogger('Tasks');

/**
 * The slice of {@link TaskSchedulerService} the registrar drives.
 *
 * Narrowed to three members rather than taking the whole service: this lets a
 * caller that only writes rows depend on the registration seam without pulling
 * in a dispatch engine, and lets tests stand in a scheduler that records calls.
 */
export interface SchedulerRegistrationTarget {
  /** Whether `start()` has run. See {@link TaskRegistrar.syncTask}. */
  readonly isStarted: boolean;
  /** Register (or re-register) a task's cron job. Never throws. */
  registerTask(task: Task): boolean;
  /** Stop and forget a task's cron job. */
  unregisterTask(id: string): void;
}

/** What the registrar needs to answer "should this task have a job right now?". */
export interface TaskRegistrarDeps {
  store: TaskStore;
  scheduler: SchedulerRegistrationTarget;
}

/**
 * Keeps the running cron jobs in step with the task rows.
 *
 * Holds no state of its own: every answer is read from the store at the moment
 * it is asked, which is what makes it safe for four writers to call from four
 * different places without coordinating.
 */
export class TaskRegistrar {
  constructor(private deps: TaskRegistrarDeps) {}

  /**
   * Make the scheduler agree with what the row says right now.
   *
   * Registers a task that should be running, unregisters one that should not,
   * and re-registers one whose cron or timezone changed — `registerTask`
   * replaces an existing job, so a changed expression takes effect on the spot.
   * A task id with no row (just deleted) unregisters, which is what stops a job
   * firing against a schedule that no longer exists.
   *
   * ## Before the scheduler starts, this deliberately does nothing
   *
   * The watcher is created and starts delivering `add` events at boot, and the
   * server is listening for API calls, both BEFORE `schedulerService.start()`
   * runs (`index.ts`). Registering in that window would put jobs on the clock
   * ahead of leader election (ADR-285) and ahead of the crash recovery that
   * marks interrupted runs failed — two processes could fire the same tick.
   *
   * Skipping costs nothing, because `start()` registers every enabled, active
   * task from the store as its first act. The store is the thing all four
   * writers have already updated, so whatever happened in the window is picked
   * up there rather than lost.
   *
   * @param taskId - The task whose registration should be brought up to date.
   */
  syncTask(taskId: string): void {
    if (!this.deps.scheduler.isStarted) {
      logger.debug(`scheduler not started yet — start() will register ${taskId} from the store`);
      return;
    }

    const task = this.deps.store.getTask(taskId);
    if (!task) {
      this.deps.scheduler.unregisterTask(taskId);
      return;
    }

    if (task.enabled && task.status === 'active') {
      this.deps.scheduler.registerTask(task);
    } else {
      this.deps.scheduler.unregisterTask(task.id);
    }
  }

  /**
   * Bring the registration of the task defined by a SKILL.md up to date.
   *
   * The file layer knows paths, not ids — a removed file is reported to the
   * watcher as a path, and the row behind it is whichever one claims that exact
   * path. A path with no row is nothing to do.
   *
   * @param filePath - Absolute path to the task's SKILL.md.
   */
  syncTaskByFilePath(filePath: string): void {
    const task = this.deps.store.getByFilePath(filePath);
    if (task) this.syncTask(task.id);
  }
}
