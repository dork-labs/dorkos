import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Task, UpdateTaskRequest } from '@dorkos/shared/types';
import type { TaskStore } from '../task-store.js';

/** The refusal shared by every stale schedule review. */
export const STALE_SCHEDULE_REVIEW = {
  error: 'This schedule changed. Review it again.',
  code: 'schedule_review_changed',
} as const;

/** Hash the work and mode, excluding moving facts such as run history and next-run times. */
export function taskReviewRowRevision(task: Task): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        task.id,
        task.prompt,
        task.permissionMode,
        task.cron,
        task.timezone,
        task.runtime,
        task.model,
        task.effort,
        task.account,
        task.agentId,
        task.filePath,
        task.enabled,
        task.status,
        task.originMarks,
      ])
    )
    .digest('hex');
}

/**
 * Bind a review to both the row and the file, including an edit not yet seen by the watcher.
 * Synchronous so the last check and the row activation cannot interleave with another request.
 * An unreadable file has a distinct revision; it never makes a failed read match an old review.
 */
export function taskReviewRevision(task: Task): string {
  const file = taskReviewFileRevision(task.filePath);
  return createHash('sha256').update(taskReviewRowRevision(task)).update(file).digest('hex');
}

/** Hash the exact file bytes, or distinguish a failed read from every readable file. */
function taskReviewFileRevision(filePath: string): string {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  } catch (error) {
    return `unreadable:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`;
  }
}

/**
 * The two ends of a person's activation: refuse stale input before any write,
 * then compare synchronously again after all asynchronous checks and file work.
 */
export function preparePersonTaskReview(
  store: Pick<TaskStore, 'getTask'>,
  existing: Task,
  data: UpdateTaskRequest,
  revision: string | undefined
) {
  const approving = data.status === 'active';
  const rowRevision = taskReviewRowRevision(existing);
  const stillMatches = () => {
    const current = store.getTask(existing.id);
    return !!current && revision === taskReviewRevision(current);
  };
  return {
    stale:
      approving &&
      (!stillMatches() || (data.prompt !== undefined && data.prompt !== existing.prompt)),
    beforeWrite: approving ? stillMatches : undefined,
    beforeActivation: (writtenFileHash?: string): boolean => {
      if (!approving) return true;
      const current = store.getTask(existing.id);
      return (
        !!current &&
        taskReviewRowRevision(current) === rowRevision &&
        (writtenFileHash
          ? taskReviewFileRevision(current.filePath) === writtenFileHash
          : stillMatches())
      );
    },
  };
}
