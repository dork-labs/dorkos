/**
 * What a finished scheduled run's notification says, and who it reaches out
 * to — the `run.completed` registry entry's wording, kept beside it rather than
 * inside it so the registry stays one table.
 *
 * @module services/notifications/run-completed-copy
 */
import type { NotificationActionDTO } from '@dorkos/shared/notification-schemas';
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
 * The row's title. A run that failed its job, either way, reads "needs
 * attention" (DOR-3123): the reason line says which way.
 *
 * @param p - The run's payload.
 */
export function runCompletedTitle(p: RunCompletedPayload): string {
  return p.status === 'completed' ? `${p.taskName} finished` : `${p.taskName} needs attention`;
}

/** The one fix a failing schedule's notice offers: its own settings, never a raise. */
export const OPEN_TO_FIX_LINE = 'Open the schedule to fix it.';

/** What the one notice of a failing streak promises (DOR-3123). */
export const ONCE_PER_STREAK_LINE =
  'You won’t get another notice about it until it runs cleanly and fails again.';

/** How many tools a reason line names before it counts the rest. */
const NAMED_TOOLS = 2;

/** How long an error is quoted before it is cut. */
const MAX_ERROR_CHARS = 60;

/** The prefix an expired sign-in's stored line carries (`run-outcome`). */
const SIGN_IN_PREFIX = 'Sign in again:';

/**
 * "Bash", "Bash and Write", or "Bash, Write and 4 more".
 *
 * @param names - The refused tools, already readable.
 */
function toolPhrase(names: readonly string[]): string {
  if (names.length <= NAMED_TOOLS) return names.join(' and ');
  return `${names.slice(0, NAMED_TOOLS).join(', ')} and ${names.length - NAMED_TOOLS} more`;
}

/**
 * An error cut to what fits on a row, at a word where it can.
 *
 * @param message - The error's first line.
 */
function shortError(message: string): string {
  const text = message.replace(/[.\s]+$/, '');
  if (text.length <= MAX_ERROR_CHARS) return text;
  const cut = text.slice(0, MAX_ERROR_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${space > MAX_ERROR_CHARS / 2 ? cut.slice(0, space) : cut}…`;
}

/**
 * End a sentence with a full stop, unless it already ends in one, an ellipsis,
 * "!" or "?" — so a cut error never reads "…." (DOR-3123).
 *
 * @param text - The sentence.
 */
function asSentence(text: string): string {
  return /[.…!?]$/.test(text) ? text : `${text}.`;
}

/**
 * The same reason line the Schedules row shows for this run, in its wording
 * for a schedule whose level is not named (`describeFailure` in the client's
 * `features/tasks/lib/schedule-health.ts`; keep the two in step).
 *
 * @param p - A failing run's payload.
 */
export function runFailureReason(p: RunCompletedPayload): string {
  if (p.status === 'needs_attention') {
    const tools = p.refusedTools ?? [];
    if (tools.length === 0) return 'A tool was refused, with nobody there to approve it.';
    const phrase = toolPhrase(tools);
    const verb = tools.length === 1 ? 'was' : 'were';
    return p.outcome === 'nothing_done'
      ? `Nothing got done: ${phrase} ${verb} refused.`
      : `${phrase} ${verb} refused, with nobody there to approve ${tools.length === 1 ? 'it' : 'them'}.`;
  }
  const message = p.detail?.trim();
  if (message?.startsWith(SIGN_IN_PREFIX))
    return 'Its sign-in expired. Sign in again, then run it.';
  return message ? asSentence(`Didn’t finish: ${shortError(message)}`) : 'Didn’t finish.';
}

/**
 * The row's body.
 *
 * A failing run says why, in the row's own words, points at the schedule as
 * the one place to fix it — never at raising its level (spec
 * `schedules-failing` SF-18) — and, on the notice that opens a failing streak,
 * says no more will follow. A completed run says how long it took and what it
 * said.
 *
 * @param p - The run's payload.
 */
export function runCompletedBody(p: RunCompletedPayload): string | undefined {
  if (p.status !== 'completed') {
    return [runFailureReason(p), OPEN_TO_FIX_LINE, p.oncePerStreak ? ONCE_PER_STREAK_LINE : null]
      .filter(Boolean)
      .join(' ');
  }
  const timing = p.duration ? `Done in ${p.duration}.` : undefined;
  return [timing, p.detail].filter(Boolean).join(' ') || undefined;
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

/**
 * A failing run's one fix: its schedule's settings, never a raise (DOR-3123,
 * spec `schedules-failing` SF-18). The inbox row draws it beside the row.
 */
const OPEN_SCHEDULE_ACTION: NotificationActionDTO[] = [
  { id: 'open-schedule', label: 'Open schedule', style: 'primary' },
];

/**
 * What the person can do about the notice: open the schedule, on a failing run.
 *
 * @param p - The run's payload.
 */
export function runCompletedActions(p: RunCompletedPayload): NotificationActionDTO[] {
  return p.status === 'completed' ? [] : OPEN_SCHEDULE_ACTION;
}

/**
 * Which of the Schedules row's marks the notice draws: a padlock for a refusal,
 * a cross for a run that did not finish, none for a success (DOR-3123).
 *
 * @param p - The run's payload.
 */
export function runCompletedMark(p: RunCompletedPayload): 'refused' | 'failed' | undefined {
  if (p.status === 'needs_attention') return 'refused';
  return p.status === 'failed' ? 'failed' : undefined;
}

/** The `run.completed` registry entry's wording, action and reach, in one piece. */
export const RUN_COMPLETED_COPY = {
  title: runCompletedTitle,
  body: runCompletedBody,
  actions: runCompletedActions,
  relay: runCompletedRelay,
} as const;
