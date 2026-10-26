/**
 * What a finished scheduled run's notification says, and who it reaches out
 * to — the `run.completed` registry entry's wording, kept beside it rather than
 * inside it so the registry stays one table.
 *
 * @module services/notifications/run-completed-copy
 */
import { listRefusedTools } from '@dorkos/shared/run-refusals';
import type { RunCompletionStatus } from './notification-registry.js';

/** What a `run.completed` notification is told: a scheduled run reached a terminal status. */
export interface RunCompletedPayload {
  runId: string;
  taskId: string;
  taskName: string;
  agentId?: string;
  status: RunCompletionStatus;
  /** How much a `needs_attention` run got done (DOR-3123); absent otherwise. */
  outcome?: 'partial' | 'nothing_done';
  /** The tools a `needs_attention` run was refused, as a person reads them. */
  refusedTools?: string[];
  /**
   * Set on the one notice a failing streak gets (DOR-3123): the schedule
   * stays quiet until a run completes and a later one fails again.
   */
  oncePerStreak?: true;
  /** How long it took, already written, e.g. `2m 14s`. */
  duration?: string;
  /** The first line of output or error. */
  detail?: string;
  /** The sentence an out-of-app channel says. Preserves the wording DOR-240 shipped. */
  channelMessage: string;
}

/**
 * The row's title: what happened, never a failure for a run that broke nothing.
 *
 * @param p - The run's payload.
 */
export function runCompletedTitle(p: RunCompletedPayload): string {
  if (p.status === 'failed') return `${p.taskName} failed`;
  if (p.status === 'needs_attention') return `${p.taskName} needs attention`;
  return `${p.taskName} finished`;
}

/** What the one notice of a failing streak promises (DOR-3123). */
export const ONCE_PER_STREAK_LINE = 'No more notices until it works, then breaks again.';

/**
 * The row's body.
 *
 * A run that needs attention names what was refused and the one fix, rather
 * than repeating the run's own refusal sentence (DOR-2101 review). A failure
 * says how long it ran and its own first line. The notice that opens a failing
 * streak says it will not repeat.
 *
 * @param p - The run's payload.
 */
export function runCompletedBody(p: RunCompletedPayload): string | undefined {
  const once = p.oncePerStreak ? ONCE_PER_STREAK_LINE : undefined;
  if (p.status === 'needs_attention') {
    const named = listRefusedTools(p.refusedTools ?? []);
    const what = named
      ? `${named.list} ${named.them === 'it' ? 'was' : 'were'} refused.`
      : 'A tool was refused.';
    return [what, 'Change this schedule’s permission level to fix it.', once]
      .filter(Boolean)
      .join(' ');
  }
  const timing = !p.duration
    ? undefined
    : p.status === 'failed'
      ? `Failed after ${p.duration}.`
      : `Done in ${p.duration}.`;
  return [timing, p.detail, once].filter(Boolean).join(' ') || undefined;
}

/**
 * Whether the notification reaches a phone or chat on its own.
 *
 * Failures always reach out; successes only where the operator asked for them
 * (DOR-240's policy, moved from the notifier to the declaration). A run that
 * needs attention reaches out too (DOR-2101, DOR-3123): it is the outcome a
 * person cannot notice for themselves, because the task looks like it ran. It
 * stays bearable because a failing streak raises one notice, not one per run
 * (`notifyRunCompleted`).
 *
 * @param p - The run's payload.
 */
export function runCompletedRelay(p: RunCompletedPayload): 'opt-in' | 'always' {
  return p.status === 'completed' ? 'opt-in' : 'always';
}
