/**
 * The context a scheduled run hands its agent.
 *
 * A task-dispatched turn has nobody sitting in front of it, so the agent is
 * told what it is running and why before it starts.
 *
 * On a SCHEDULED fire it is also told what happens when it reaches for something
 * that needs a person's approval: there is nobody to give it, so the ask is
 * refused the moment it is raised (spec
 * `unattended-session-permission-prompts`). Saying so in advance is what turns a
 * refusal into a plan — the run finishes what it can and reports the rest —
 * rather than a wall the agent hits and re-tries. The refusal itself carries the
 * same words (`NO_APPROVAL_SURFACE_DENIAL`); this is constant text like every
 * other line here.
 *
 * **Those lines are omitted on a manual "Run now", because there they would be
 * false.** Somebody clicked it and is sitting in front of the app, so their
 * cards are answerable and the ordinary wait applies. Telling that agent its
 * asks are refused straight away would teach it not to ask at all — the exact
 * failure this text exists to prevent, pointed the wrong way.
 *
 * @module services/tasks/task-append
 */
import type { Task, TaskRun } from '@dorkos/shared/types';

/**
 * What a run the timer started is told about asks nobody can answer.
 *
 * Only for `trigger === 'scheduled'` — see this module's doc for why saying it
 * on a hand-started run would be a lie with teeth.
 */
const NOBODY_TO_APPROVE_LINES = [
  'Nobody is here to approve a tool that needs permission, so any such request',
  'is refused straight away. Carry on without that tool and, at the end, say',
  'plainly what you could not do.',
] as const;

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
    ...(run.trigger === 'scheduled' ? NOBODY_TO_APPROVE_LINES : []),
    '=== END TASK CONTEXT ===',
  ].join('\n');
}
