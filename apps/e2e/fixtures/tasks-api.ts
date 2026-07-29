/**
 * Server-side setup and teardown for the Tasks scheduler browser tests.
 *
 * The scheduler dialog has nothing to draw until something is scheduled, and
 * the suite's server starts on a throwaway `DORK_HOME` with an empty task
 * store. These specs used to assume a schedule called `test` was simply there —
 * left behind by a developer's own data directory — so they passed on one
 * machine and not on another. Seeding it here makes the dialog's contents a
 * property of the test.
 *
 * @module fixtures/tasks-api
 */
import type { APIRequestContext } from '@playwright/test';

/**
 * A cron that parses, schedules, displays — and can never run.
 *
 * The 31st of February does not exist, so croner accepts the expression and
 * then reports no next occurrence. That matters more than it looks: the suite's
 * API leg sets `DORKOS_TASKS_ENABLED=true`, which is both the subsystem gate and
 * the firing override, and that leg runs the real Claude Code runtime. A
 * seeded schedule with an ordinary cron would eventually spawn a real agent —
 * slow, non-deterministic, and billed. This one cannot, while still rendering
 * as an enabled schedule with a live toggle.
 */
export const NEVER_FIRES_CRON = '0 0 31 2 *';

/** A schedule this helper created, as the tests need to refer to it. */
export interface SeededTask {
  /** Task id, used to delete it again. */
  id: string;
  /** The slug the server derived, which is what the row's toggle is labelled with. */
  name: string;
}

/** Seeds and cleans up the scheduled tasks one browser test needs. */
export class TasksApi {
  private readonly request: APIRequestContext;
  private readonly taskIds: string[] = [];

  constructor(request: APIRequestContext) {
    this.request = request;
  }

  /**
   * Schedule a task that shows up and never runs.
   *
   * @param name - The schedule's name. The server slugifies it, and the slug is
   *   what the row displays and what its toggle's label is built from — so pass
   *   something already slug-shaped if a test asserts on it.
   */
  async createTask(name: string): Promise<SeededTask> {
    const res = await this.request.post('/api/tasks', {
      data: {
        name,
        description: 'Seeded by the browser suite',
        prompt: 'This schedule exists to be looked at, never to run.',
        target: 'global',
        cron: NEVER_FIRES_CRON,
        enabled: true,
      },
    });
    if (!res.ok()) throw new Error(`Could not schedule ${name}: ${await res.text()}`);
    const task = (await res.json()) as { id: string; name: string; status: string };
    // A server with auth on parks new tasks at `pending_approval`, and the row
    // then draws Approve/Reject where the toggle would be. Failing here names
    // that, rather than leaving a test to report a missing switch.
    if (task.status !== 'active') {
      throw new Error(`Scheduled ${name} but it is ${task.status}, not active`);
    }
    this.taskIds.push(task.id);
    return { id: task.id, name: task.name };
  }

  /**
   * Delete every schedule this instance made.
   *
   * Failures are swallowed on purpose: teardown runs after a test has already
   * decided its verdict, and a cleanup error reported as a test failure hides
   * the real one.
   */
  async cleanup(): Promise<void> {
    for (const id of this.taskIds) {
      await this.request.delete(`/api/tasks/${id}`).catch(() => {});
    }
  }
}
