/**
 * The marks a scheduled run starts with: those of another agent that wrote its task
 * (`cross-agent.ts`, DOR-3938), and the outsider mark when the task said it reads outside text
 * (`core/turn-power/declared-readers.ts`, DOR-3969).
 *
 * The relay's task payload carries no marks, so a run that starts with any of them runs in this
 * process instead, where the marks always reach the turn.
 *
 * @module services/tasks/approvals/run-marks
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { Task } from '@dorkos/shared/types';
import { taskReadsOutsideText } from '../../core/turn-power/declared-readers.js';
import { creatorMarked, withCreatorMarks, type WriterSource } from './cross-agent.js';

/**
 * Whether a run of this task must start with marks, so it runs in this process rather than over
 * the relay.
 *
 * @param store - The task store.
 * @param task - The task about to run.
 */
export function runMarked(store: WriterSource, task: Pick<Task, 'id'>): boolean {
  return creatorMarked(store, task) || taskReadsOutsideText(task.id);
}

/**
 * A run's send settings with every mark it starts with: its writer's (`withCreatorMarks`), and
 * the outsider mark for a task that reads outside text. The two only ever add the same mark, so
 * one never clears the other.
 *
 * @param store - The task store.
 * @param task - The task about to run.
 * @param settings - The run's resolved settings.
 */
export function withRunMarks<T extends object>(
  store: WriterSource,
  task: Pick<Task, 'id'>,
  settings: T
): T & Pick<MessageOpts, 'carriedMarks' | 'permissionCeiling'> {
  const marked = withCreatorMarks(store, task, settings);
  if (!taskReadsOutsideText(task.id)) return marked;
  return { ...marked, carriedMarks: { ...marked.carriedMarks, outsider: true } };
}
