/**
 * When a proposed schedule would run, in words a person can check.
 *
 * A cron expression is the one part of a proposal an operator cannot verify by
 * reading it — `0 3 * * 1-5` is a claim, not a time. So the card says the same
 * thing three ways: the cadence in English, the timezone it is anchored to, and
 * the first few concrete moments it would actually fire. Nothing here rounds,
 * pads or guesses; a cron nobody can parse falls back to the raw expression,
 * because a string somebody can copy into a cron checker beats a card that
 * refuses to say anything.
 *
 * @module features/schedule-approval/lib/format-schedule-times
 */
import cronstrue from 'cronstrue';

/** Milliseconds in one day. */
const DAY_MS = 86_400_000;

/**
 * The cadence in English, with the timezone it is anchored to.
 *
 * The timezone is never dropped: "every day at 3:00 AM" is a different promise
 * in `UTC` than in `America/Chicago`, and the operator is the one who has to
 * know which. A schedule with no cron at all is on-demand and says so.
 *
 * @param cron - The cron expression, or null for an on-demand task.
 * @param timezone - The IANA zone the cron is evaluated in, when it has one.
 * @returns A sentence like `At 03:00 AM, Monday through Friday (America/Chicago)`.
 */
export function formatCadence(cron: string | null, timezone: string | null): string {
  if (!cron) return 'On demand. It only runs when something asks it to';
  let words: string;
  try {
    words = cronstrue.toString(cron);
  } catch {
    // The raw expression, deliberately. A cron this library cannot read is
    // still the literal thing the scheduler will run, and showing it is what
    // lets somebody paste it somewhere that CAN read it.
    words = cron;
  }
  return timezone ? `${words} (${timezone})` : words;
}

/**
 * One run time, said the way a person would say it.
 *
 * Today and tomorrow are named rather than dated — on the morning somebody is
 * deciding, that is the whole information — and anything further out gets its
 * date, because a bare weekday three weeks from now is not a time. The clock
 * reading is always in the reader's own locale and zone, which is the one they
 * will be standing in when it fires.
 *
 * @param iso - The run time. ISO 8601.
 * @param now - The current time, in epoch milliseconds.
 * @returns A fragment like `tomorrow at 9:00 AM`, or `null` when the timestamp
 *   cannot be read at all.
 */
export function formatRunMoment(iso: string, now: number): string | null {
  const at = new Date(iso);
  const ms = at.getTime();
  if (Number.isNaN(ms)) return null;

  const clock = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  // Compared as local calendar days rather than as a span of hours: a run eight
  // hours out is "tomorrow" at 11pm and "today" at 9am, and only the date knows
  // which of those it is.
  const days = calendarDaysBetween(new Date(now), at);
  if (days === 0) return `today at ${clock}`;
  if (days === 1) return `tomorrow at ${clock}`;
  const date = at.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `${date} at ${clock}`;
}

/**
 * How many local calendar days separate two moments.
 *
 * @param from - The earlier moment.
 * @param to - The later moment.
 * @returns A whole number of days; `0` when both fall on the same local date.
 */
function calendarDaysBetween(from: Date, to: Date): number {
  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);
}

/** The first runs, split into the one that matters and the ones that follow. */
export interface FirstRuns {
  /** The very first fire time, in words. This is what a receipt quotes back. */
  first: string;
  /** The runs after it, in words. Empty when the server sent only one. */
  then: string[];
}

/**
 * The first few concrete moments a proposed schedule would fire.
 *
 * **The server is the only thing that can answer this**, and only for a parked
 * schedule: a pending proposal is never registered with the live cron, so
 * `nextRun` is null for exactly the rows where the operator most needs a time
 * (DOR-1394 added `nextRuns` to close that). An empty array here is therefore a
 * real state — an unparseable cron, or a task with none — and the card draws
 * nothing rather than inventing a first run.
 *
 * @param nextRuns - ISO fire times, soonest first, as the server sent them.
 * @param now - The current time, in epoch milliseconds.
 * @returns The first run and the ones after it, or `null` when there is nothing
 *   sayable.
 */
export function formatFirstRuns(nextRuns: readonly string[], now: number): FirstRuns | null {
  const words = nextRuns
    .map((iso) => formatRunMoment(iso, now))
    .filter((phrase): phrase is string => phrase !== null);
  const [first, ...then] = words;
  if (first === undefined) return null;
  return { first, then };
}
