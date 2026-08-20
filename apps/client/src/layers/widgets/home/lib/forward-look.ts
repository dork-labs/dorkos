/**
 * The quiet state's forward look: what is coming, read off real schedules.
 *
 * The whole point of the quiet state is that it never invents a recap
 * (team-room-home spec D3.6). So the only sentence it is allowed to add to "All
 * quiet." is one it can point at a row for — a scheduled run that is genuinely
 * on the books. Nothing here summarises, guesses or pads: given no future run it
 * returns `null`, and the line is left off the screen entirely.
 *
 * **A scheduled run is the whole of it.** The spec names a second half — the
 * oldest item still waiting on the reader — and for everything the header can
 * see, that half is answered a few pixels higher up: an approval or an attention
 * row puts the pinned triage header on screen, and the header on screen is what
 * makes the quiet state stand down. A branch for those here could never be
 * reached.
 *
 * The gap this note used to describe — a session quiet for three days, older
 * than the attention lookback and so in neither the header nor this sentence —
 * closed by deletion rather than by a branch: a quiet session is no longer
 * something the product says needs you at all (DOR-1381). What the header can
 * see, it draws; what it draws makes this line stand down; and there is nothing
 * left in between for this file to apologise for.
 *
 * @module widgets/home/lib/forward-look
 */
import type { Task } from '@dorkos/shared/types';

/** A scheduled run that has not happened yet. */
export interface NextScheduledRun {
  /** What the Tasks list calls it — the same name the row shows. */
  name: string;
  /** When it runs. ISO 8601. */
  at: string;
}

/**
 * The soonest run still ahead of us.
 *
 * Only tasks that will actually run count: `enabled` off or a status other than
 * `active` means the scheduler is not going to fire it, and naming it as what
 * happens next would be a promise nothing is keeping. A `nextRun` already in the
 * past is treated the same way — a stale timestamp is not a plan.
 *
 * @param tasks - Every task, or `undefined` while the list has not loaded (or
 * the Tasks feature is switched off, in which case there is nothing to say).
 * @param now - The current time, in epoch milliseconds.
 * @returns The nearest future run, or `null` when there is none.
 */
export function nextScheduledRun(
  tasks: readonly Task[] | undefined,
  now: number
): NextScheduledRun | null {
  if (tasks === undefined) return null;

  let soonest: NextScheduledRun | null = null;
  let soonestAt = Infinity;

  for (const task of tasks) {
    if (!task.enabled || task.status !== 'active') continue;
    const nextRun = task.nextRun;
    if (nextRun === null || nextRun === undefined) continue;
    const at = Date.parse(nextRun);
    if (Number.isNaN(at) || at <= now || at >= soonestAt) continue;
    soonestAt = at;
    // `displayName` is what the Tasks list shows when it is set; `name` is the
    // file-safe one underneath it. Reading them in that order is what keeps this
    // sentence and that row talking about the same thing.
    soonest = { name: task.displayName ?? task.name, at: nextRun };
  }

  return soonest;
}

/**
 * When a run happens, said the way a person would say it.
 *
 * Today and tomorrow are named rather than dated, because that is the whole
 * information on a quiet morning; anything further out gets its date, because
 * "Friday" three weeks from now is not a time. The clock reading is always
 * there, in the reader's own locale and timezone.
 *
 * @param at - The run's time. ISO 8601.
 * @param now - The current time, in epoch milliseconds.
 * @returns A fragment like `tomorrow at 9:00 AM`.
 */
function whenPhrase(at: string, now: number): string {
  const runAt = new Date(at);
  const clock = runAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  // Compared as local calendar days, not as a span of hours: a run eight hours
  // from now is "tomorrow" at 11pm and "today" at 9am, and only the date can say
  // which.
  const days = calendarDaysBetween(new Date(now), runAt);
  if (days === 0) return `today at ${clock}`;
  if (days === 1) return `tomorrow at ${clock}`;

  const date = runAt.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
  return `on ${date} at ${clock}`;
}

/**
 * How many local calendar days separate two moments.
 *
 * @param from - The earlier moment.
 * @param to - The later moment.
 * @returns A whole number of days, `0` when both fall on the same local date.
 */
function calendarDaysBetween(from: Date, to: Date): number {
  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((startOfDay(to) - startOfDay(from)) / 86_400_000);
}

/**
 * The second sentence of the quiet state, or nothing at all.
 *
 * @param run - The nearest future run, from {@link nextScheduledRun}.
 * @param now - The current time, in epoch milliseconds.
 * @returns The sentence, or `null` when there is nothing real to look forward
 * to — in which case the quiet state says only "All quiet." and stops. Padding
 * this with a generic line is the exact thing the spec forbids.
 */
export function forwardLookSentence(run: NextScheduledRun | null, now: number): string | null {
  if (run === null) return null;
  return `Next up: ${run.name} runs ${whenPhrase(run.at, now)}.`;
}
