/**
 * The one rule for housekeeping background tasks.
 *
 * Runtimes can mark a background task as work they started on their own behalf
 * — a watcher that keeps the agent oriented, not something anybody asked for —
 * and ask hosts to keep it out of activity indicators. DorkOS honours that
 * everywhere at once: the session's task bar, the status line's subagent count,
 * the session inspector, and whatever indicator comes next.
 *
 * The rule lives here, in one function, for the reason the spec named as the
 * risk: one field read by several surfaces is how the session ends up saying
 * one thing and the status line another.
 *
 * @module shared/lib/ambient-tasks
 */
import type { BackgroundTaskStatus } from '@dorkos/shared/types';

/** The two fields the rule reads, from a task part, event, or folded row. */
export interface AmbientTaskInput {
  /** The runtime's housekeeping mark. Absent means ordinary work. */
  ambient?: boolean;
  /** The task's lifecycle status. */
  status: BackgroundTaskStatus;
}

/**
 * Whether a background task is housekeeping that indicators must leave out.
 *
 * One exception, and it is the whole reason hiding is safe: a housekeeping task
 * that **failed** reads as ordinary work again. Quiet about work nobody asked
 * for is calm; quiet about something that broke is a lie, and a person who
 * cannot see the breakage just experiences an agent that got slow for no
 * reason.
 *
 * Only claude-code marks tasks today (SDK 0.3.247+); an absent mark means not
 * housekeeping, which is why every other runtime keeps working unchanged.
 *
 * @param task - The task part, event, or folded row to classify.
 */
export function isAmbientTask(task: AmbientTaskInput): boolean {
  return task.ambient === true && task.status !== 'error';
}

/** A list of background tasks split into what indicators show and what they hide. */
export interface PartitionedAmbientTasks<T> {
  /** Tasks every indicator counts and draws. */
  shown: T[];
  /** Housekeeping tasks, reachable only where somebody went looking for them. */
  ambient: T[];
}

/**
 * Split rows into the ones indicators may show and the housekeeping ones they
 * may not.
 *
 * Takes rows whose `ambient` is already resolved (the promotion rule applied),
 * which is what `useBackgroundTasks` hands out — so a surface splits a list
 * without having to know the rule at all. Order is preserved within each half.
 *
 * @param tasks - Rows carrying a resolved `ambient` flag.
 */
export function partitionAmbientTasks<T extends { ambient: boolean }>(
  tasks: readonly T[]
): PartitionedAmbientTasks<T> {
  const shown: T[] = [];
  const ambient: T[] = [];
  for (const task of tasks) {
    (task.ambient ? ambient : shown).push(task);
  }
  return { shown, ambient };
}
