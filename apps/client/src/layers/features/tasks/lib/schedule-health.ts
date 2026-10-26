/**
 * What a failing schedule's row says: why it is failing, in one line, and for
 * how long (DOR-3123, spec `schedules-failing` §2-§3).
 *
 * The reason is chosen on the server (`Task.health.reason`) so every surface
 * reads one answer; this module only words it. Tools are named the way a
 * person reads them (`readableToolName`), and the stop by the Trust Dial's own
 * words, never a mode id.
 *
 * @module features/tasks/lib/schedule-health
 */
import type { Task, TaskFailureReason } from '@dorkos/shared/types';
import { readableToolName } from '@dorkos/shared/run-refusals';

/** How many tools a reason line names before it counts the rest. */
const NAMED_TOOLS = 2;

/** How long an error is quoted on a row before it is cut. */
const MAX_ERROR_CHARS = 60;

/**
 * Claude Code's "Never ask" mode (`dontAsk`): it refuses what is not already
 * allowed instead of asking. It declares Default's `asks` and the Ask stop on
 * purpose, so that it never ranks looser than Default, which is why it is told
 * apart by its id — the same way the Trust Dial picks its icon
 * (`trust-dial.tsx`).
 */
export const NEVER_ASK_MODE_ID = 'dontAsk';

/** The prefix an expired sign-in's stored line carries (`run-outcome`). */
const SIGN_IN_PREFIX = 'Sign in again:';

/**
 * Whether a schedule's last finished run failed to do its job.
 *
 * An older server sends no `health`, which reads as healthy rather than as a
 * guess.
 *
 * @param task - The schedule.
 */
export function isFailing(task: Task): boolean {
  return task.health?.state === 'failing';
}

/**
 * The refused tools as a phrase: "Bash", "Bash and Write", or "Bash, Write and
 * 4 more".
 *
 * @param tools - Runtime tool names, as the reason carries them.
 */
function toolPhrase(tools: readonly string[]): string {
  const names = tools.map(readableToolName);
  if (names.length <= NAMED_TOOLS) return names.join(' and ');
  const shown = names.slice(0, NAMED_TOOLS);
  return `${shown.join(', ')} and ${names.length - shown.length} more`;
}

/**
 * Cut an error to what fits on a row, at a word where it can.
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
 * The one line a failing row shows: what happened, and why (spec §3).
 *
 * The fix is the row's action, **Open schedule**, so the line names the cause
 * and stops there. It never says "Something went wrong" or "we" (SF-8).
 *
 * @param reason - Why the schedule is failing.
 * @param stop - The Trust Dial's name for the stop the schedule runs at, when
 *   known ("Ask first", "Act", "Full autonomy").
 */
export function describeFailure(reason: TaskFailureReason, stop: string | null): string {
  switch (reason.kind) {
    case 'tool_refused':
    case 'tools_refused': {
      const tools = toolPhrase(reason.tools);
      const verb = reason.tools.length === 1 ? 'was' : 'were';
      if (reason.nothingDone) {
        return stop
          ? `Nothing got done: ${tools} ${verb} refused at ${stop}.`
          : `Nothing got done: ${tools} ${verb} refused.`;
      }
      return stop
        ? `${tools} ${verb} refused: this schedule runs at ${stop}.`
        : `${tools} ${verb} refused, with nobody there to approve ${reason.tools.length === 1 ? 'it' : 'them'}.`;
    }
    case 'signin_needed':
      return 'Its sign-in expired. Sign in again, then run it.';
    case 'error': {
      const message = reason.message?.startsWith(SIGN_IN_PREFIX) ? null : reason.message;
      return message ? asSentence(`Didn’t finish: ${shortError(message)}`) : 'Didn’t finish.';
    }
  }
}

/** Whether a failing reason is a refusal (a padlock) or a breakage (a cross). */
export function isRefusal(reason: TaskFailureReason | null | undefined): boolean {
  return reason?.kind === 'tool_refused' || reason?.kind === 'tools_refused';
}

/**
 * "Failing since Tue · 3 runs" — when the streak started and how long it is.
 *
 * A start within the last week is named by weekday, anything older by date,
 * so the tail stays short either way.
 *
 * @param health - The schedule's health; must be failing.
 * @param now - The current time, in ms.
 */
export function failingSince(health: NonNullable<Task['health']>, now: number): string {
  const runs = `${health.streak} ${health.streak === 1 ? 'run' : 'runs'}`;
  if (!health.since) return runs;
  const since = new Date(health.since);
  const withinWeek = now - since.getTime() < 6 * 24 * 60 * 60 * 1000;
  const when = withinWeek
    ? since.toLocaleDateString(undefined, { weekday: 'short' })
    : since.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `Failing since ${when} · ${runs}`;
}

/**
 * Failing schedules first, the newest failing streak first, everything else in the order
 * it came in (spec §2.3). Stable, so the default sort below it survives.
 *
 * @param tasks - The list, already sorted by the default sort.
 */
export function failingFirst(tasks: readonly Task[]): Task[] {
  const failing = tasks
    .filter(isFailing)
    .sort((a, b) => (b.health?.since ?? '').localeCompare(a.health?.since ?? ''));
  return [...failing, ...tasks.filter((task) => !isFailing(task))];
}
