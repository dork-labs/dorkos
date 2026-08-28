/**
 * A scheduler stand-in that records registrations instead of starting clocks.
 *
 * Shared by the tests that ask "did this writer reach the scheduler?" — the
 * watcher, the reconciler, and the registrar itself. A real
 * `TaskSchedulerService` would answer the same question by really scheduling,
 * which makes a test's outcome depend on wall-clock time.
 *
 * Deliberately not named `*.test.ts`: vitest only collects that suffix, so this
 * lives beside the suites without being run as one.
 *
 * @module services/tasks/__tests__/fake-scheduler
 */
import type { Task } from '@dorkos/shared/types';
import type { SchedulerRegistrationTarget } from '../task-registrar.js';

/** A recording {@link SchedulerRegistrationTarget} with the jobs it holds. */
export class FakeScheduler implements SchedulerRegistrationTarget {
  /** Task id → the cron each registered job was built from. */
  readonly jobs = new Map<string, { cron: string | null; timezone: string | null }>();
  /** Every task handed to {@link registerTask}, in order. */
  readonly registered: Task[] = [];
  /** Every id handed to {@link unregisterTask}, in order. */
  readonly unregistered: string[] = [];

  constructor(public isStarted = true) {}

  /** Record a registration, mimicking the real service's replace-in-place. */
  registerTask(task: Task): boolean {
    this.registered.push(task);
    if (!task.cron) {
      this.jobs.delete(task.id);
      return false;
    }
    this.jobs.set(task.id, { cron: task.cron, timezone: task.timezone });
    return true;
  }

  /** Record an unregistration and drop the job. */
  unregisterTask(id: string): void {
    this.unregistered.push(id);
    this.jobs.delete(id);
  }

  /** The cron the live job for `taskId` would fire on, or null when there is none. */
  cronFor(taskId: string): string | null {
    return this.jobs.get(taskId)?.cron ?? null;
  }
}
