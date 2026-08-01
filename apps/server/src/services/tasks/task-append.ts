/**
 * The context a scheduled run hands its agent.
 *
 * A task-dispatched turn has nobody sitting in front of it, so the agent is
 * told what it is running and why before it starts.
 *
 * @module services/tasks/task-append
 */
import type { Task, TaskRun } from '@dorkos/shared/types';

/**
 * Build the system prompt append for a Task-dispatched agent run.
 *
 * Gives the agent context about the scheduled job so it can operate unattended.
 *
 * @param task - The task being run.
 * @param run - The run itself.
 */
export function buildTaskAppend(task: Task, run: TaskRun): string {
  return [
    '',
    '=== TASK SCHEDULER CONTEXT ===',
    `Job: ${task.name}`,
    `Schedule: ${task.cron ?? 'on-demand'}`,
    `Agent: ${task.agentId ?? '(global)'}`,
    `Run ID: ${run.id}`,
    `Trigger: ${run.trigger}`,
    '',
    'You are running as an unattended task via DorkOS Tasks.',
    'Complete the task described in the prompt efficiently.',
    'Do not ask questions — make reasonable decisions autonomously.',
    '=== END TASK CONTEXT ===',
  ].join('\n');
}
