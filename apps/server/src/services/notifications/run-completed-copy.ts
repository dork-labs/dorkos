/**
 * What a finished scheduled run's notification says, and who it reaches out
 * to — the `run.completed` registry entry's wording, kept beside it rather than
 * inside it so the registry stays one table.
 *
 * @module services/notifications/run-completed-copy
 */
import type { NotificationPayloads } from './notification-registry.js';

type RunCompleted = NotificationPayloads['run.completed'];

/**
 * The row's title: what happened, never a failure for a run that broke nothing.
 *
 * @param p - The run's payload.
 */
export function runCompletedTitle(p: RunCompleted): string {
  if (p.status === 'failed') return `${p.taskName} failed`;
  if (p.status === 'needs_attention') return `${p.taskName} needs attention`;
  return `${p.taskName} finished`;
}

/**
 * The row's body: how long it ran, then the run's own first line.
 *
 * For a run that needs attention the lead does NOT say "nobody was there to
 * approve its tools" again: `detail` is the run's own refusal sentence, which
 * ends in exactly those words, and the row printed the same fact twice
 * (DOR-2101 review). Headline here, the tools themselves in the detail.
 *
 * @param p - The run's payload.
 */
export function runCompletedBody(p: RunCompleted): string | undefined {
  const timing = !p.duration
    ? undefined
    : p.status === 'failed'
      ? `Failed after ${p.duration}.`
      : p.status !== 'needs_attention'
        ? `Done in ${p.duration}.`
        : p.outcome === 'nothing_done'
          ? `Ran for ${p.duration} and used none of its tools.`
          : `Ran for ${p.duration} and was refused a tool.`;
  return [timing, p.detail].filter(Boolean).join(' ') || undefined;
}

/**
 * Whether the notification reaches a phone or chat on its own.
 *
 * Failures always reach out; successes only where the operator asked for them
 * (DOR-240's policy, moved from the notifier to the declaration). A run that got
 * nothing done reaches out too (DOR-2101): it is the one outcome a person cannot
 * notice for themselves, because the task looks like it ran.
 *
 * A run that lost a tool and carried on (`partial`, DOR-3123) stays where it
 * was before it stopped being called a success: in the inbox, and on a phone
 * only where the operator asked. Until one notice covers a whole failing streak
 * (spec `schedules-failing` §5), reaching out on every such run would ping a
 * schedule that loses a tool hourly once an hour.
 *
 * @param p - The run's payload.
 */
export function runCompletedRelay(p: RunCompleted): 'opt-in' | 'always' {
  const quiet =
    p.status === 'completed' || (p.status === 'needs_attention' && p.outcome === 'partial');
  return quiet ? 'opt-in' : 'always';
}
