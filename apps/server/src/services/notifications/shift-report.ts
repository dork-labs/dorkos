/**
 * The daily Shift Report: what to tell the operator about the last day
 * (spec `notification-system`, design-decisions.md §7.2 "The Shift Report";
 * task 5.2, DOR-1389).
 *
 * Composed entirely from the notifications table itself — no new store, no
 * new query surface. Every kind this report counts is stored `event`
 * (`notification-registry.ts`'s {@link NotificationStorageRule}), which means
 * the row already IS the record of what happened; a report built from a
 * second source could disagree with the very inbox it is summarizing.
 *
 * **The report window is a TRAILING 24 HOURS from the moment it is
 * composed — never "since the local day's 4am boundary."** The two read
 * differently against a real overnight: a fleet working 21:00-03:30 plus a
 * scheduled run at 05:30, opened by a person at 09:00, is one continuous
 * shift, but a since-4am window would have shown only the 05:30 run — the
 * day's own 4am boundary falls AFTER most of the night's work, and
 * everything before it would have been silently excluded. A trailing 24h
 * window has no such edge: whatever happened in the day before "now" is what
 * "now" reports, whatever hour the operator happens to open Home.
 *
 * **The 4am boundary still exists, but its job shrank to two things, both
 * owned by the emitter** (`emitters/shift-report.ts`), never by
 * {@link composeShiftReport}: the date key a report's dedupe key is scoped
 * to, and the signal that a new local day has started (so the emitter knows
 * when to let a fresh attempt through after a day already reported). Mirrored,
 * not shared, from the sidebar digest's own 4am definition
 * (`apps/client/src/layers/shared/lib/overnight-boundary.ts`,
 * `apps/client/src/layers/features/dashboard-sidebar/model/rules/build-digest-row.ts`)
 * — the server cannot import client code, and both sides are answering the
 * same question, "when does a person who works late consider today over",
 * by computing the same rule against the same host clock, independently.
 *
 * The weekly shareable artifact (design-decisions.md §7.2) is explicitly
 * deferred — this module ships only the daily card.
 *
 * @module services/notifications/shift-report
 */
import type { NotificationStore } from './notification-store.js';

/**
 * The hour a day turns over, mirroring the client's `OVERNIGHT_BOUNDARY_HOUR`.
 *
 * Not exported, for the same reason the client keeps its copy private: the
 * hour is an input to {@link shiftReportBoundary} and nothing else. Used only
 * for the dedupe date key and day-roll detection — see the module doc.
 */
const SHIFT_REPORT_BOUNDARY_HOUR = 4;

/**
 * How far back {@link composeShiftReport} looks, trailing from the instant it
 * is asked to compose — see the module doc for why this replaced a
 * since-4am window.
 */
export const SHIFT_REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The most recent local 04:00 that has already passed, epoch ms.
 *
 * Local rather than UTC, and computed from `now` rather than read from a
 * clock, so a test can walk it across a day without mocking time. Mirrors
 * `overnight-boundary.ts`'s `overnightBoundary` exactly. Used ONLY for the
 * dedupe date key and day-roll detection (`emitters/shift-report.ts`) — the
 * report's own counting window is {@link SHIFT_REPORT_WINDOW_MS}, trailing
 * from composition time, not from this boundary.
 *
 * @param now - The instant to reason from, epoch ms.
 */
export function shiftReportBoundary(now: number): number {
  const date = new Date(now);
  const boundary = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    SHIFT_REPORT_BOUNDARY_HOUR,
    0,
    0,
    0
  );
  if (boundary.getTime() > now) boundary.setDate(boundary.getDate() - 1);
  return boundary.getTime();
}

/**
 * The local calendar day an instant falls in, as `YYYY-MM-DD`.
 *
 * Hand-formatted from local date parts, never `Intl` or `toISOString` —
 * `toISOString` answers in UTC, which would roll the report over in the
 * middle of somebody's evening. Mirrors `build-digest-row.ts`'s
 * `localDateKey`. Callers pass this the BOUNDARY, not raw `now`, so the date
 * it returns is the day a shift belongs to rather than the calendar date at
 * the moment somebody happens to be checking (1am is still yesterday's
 * shift). Used only for the dedupe date key and day-roll detection — see the
 * module doc.
 *
 * @param instant - The instant, epoch ms.
 */
export function shiftReportDateKey(instant: number): string {
  const date = new Date(instant);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** What the daily report counts, by outcome. */
export interface ShiftReportCounts {
  turnsCompleted: number;
  runsSucceeded: number;
  runsFailed: number;
  asksAnswered: number;
  asksExpired: number;
  /** Direct messages and mentions together — one "you have mail" figure. */
  messages: number;
}

/** Every count starts at zero. */
function emptyCounts(): ShiftReportCounts {
  return {
    turnsCompleted: 0,
    runsSucceeded: 0,
    runsFailed: 0,
    asksAnswered: 0,
    asksExpired: 0,
    messages: 0,
  };
}

/**
 * Read the last {@link SHIFT_REPORT_WINDOW_MS} of activity and fold it into
 * the six counts the report cares about, or `null` when every one of them is
 * zero.
 *
 * `null` on an empty window is the whole point: a "while you were away" that
 * reports nothing is a product inventing an event to have a moment about —
 * the same rule the sidebar digest states at `build-digest-row.ts`.
 *
 * Splits `run.completed` by reading its stored TIER rather than parsing its
 * payload: the registry already spells "this one failed" as `notable` and
 * "this one didn't" as `quiet` (`notification-registry.ts`), and re-deriving
 * that from `dataJson` would be a second place it could drift from the one
 * the registry declares. `report.daily` rows themselves never count toward
 * anything — they fall through the `default` case below — so a still-in-window
 * report from a previous day cannot inflate today's.
 *
 * One honest caveat: these counts are what the inbox still HOLDS, not a
 * permanent ledger. `notification-store.ts` prunes past 1000 rows or 30
 * days, high-churn kinds first (`turn.completed`, resolved `ask.pending`) —
 * nowhere close on an ordinary day, but a genuinely extraordinary 24 hours
 * could in principle read a smaller count than actually happened.
 *
 * @param store - Where the last day's rows already live.
 * @param now - The instant to compose from, epoch ms. The window is the
 *   {@link SHIFT_REPORT_WINDOW_MS} before it, inclusive.
 */
export function composeShiftReport(
  store: NotificationStore,
  now: number
): ShiftReportCounts | null {
  const since = now - SHIFT_REPORT_WINDOW_MS;
  const rows = store.countActivitySince(new Date(since).toISOString());
  const counts = emptyCounts();

  for (const row of rows) {
    switch (row.kind) {
      case 'turn.completed':
        counts.turnsCompleted += row.count;
        break;
      case 'run.completed':
        if (row.tier === 'notable') counts.runsFailed += row.count;
        else counts.runsSucceeded += row.count;
        break;
      case 'ask.pending':
        if (row.outcome === 'answered') counts.asksAnswered += row.count;
        else if (row.outcome === 'expired') counts.asksExpired += row.count;
        break;
      case 'dm.received':
      case 'mention.received':
        counts.messages += row.count;
        break;
      default:
        // Every other kind (agent notes, dead letters, updates, and the
        // Shift Report's OWN `report.daily` kind) is real activity too, but
        // not the shift's own work product — the report is about what
        // agents DID, not everything the inbox ever mentioned. This is also
        // what keeps a still-in-window report from a previous day out of
        // every bucket, `messages` included.
        break;
    }
  }

  const total =
    counts.turnsCompleted +
    counts.runsSucceeded +
    counts.runsFailed +
    counts.asksAnswered +
    counts.asksExpired +
    counts.messages;
  return total > 0 ? counts : null;
}

/** One fact the report can mention, already agreeing with its own count. */
interface ShiftReportFact {
  count: number;
  say: (count: number) => string;
}

/** Every fact key the report can mention. */
type ShiftReportFactKey = keyof ShiftReportCounts;

/** "1 run" vs "3 runs" — pluralize a counted noun. */
function countedNoun(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Every fact the report can mention, keyed so the body and the headline can
 * each read them in a different order without a second copy of the wording.
 *
 * Plain nouns throughout — "question", never "Ask" — because this is
 * user-facing prose (writing-for-humans), not the product's own vocabulary
 * for the thing.
 */
function shiftReportFacts(counts: ShiftReportCounts): Record<ShiftReportFactKey, ShiftReportFact> {
  return {
    turnsCompleted: {
      count: counts.turnsCompleted,
      say: (n) => `${countedNoun(n, 'turn')} finished`,
    },
    runsSucceeded: { count: counts.runsSucceeded, say: (n) => `${countedNoun(n, 'run')} finished` },
    runsFailed: {
      count: counts.runsFailed,
      say: (n) => `${countedNoun(n, 'run')} ${n === 1 ? 'needs' : 'need'} a look`,
    },
    asksAnswered: {
      count: counts.asksAnswered,
      say: (n) => `${countedNoun(n, 'question')} answered`,
    },
    asksExpired: {
      count: counts.asksExpired,
      say: (n) => `${countedNoun(n, 'question')} went unanswered`,
    },
    messages: { count: counts.messages, say: (n) => `${countedNoun(n, 'message')} waiting` },
  };
}

/** The order the BODY reads facts in — narrative, the shift as it happened. */
const BODY_ORDER: readonly ShiftReportFactKey[] = [
  'turnsCompleted',
  'runsSucceeded',
  'runsFailed',
  'asksAnswered',
  'asksExpired',
  'messages',
];

/**
 * The order the HEADLINE picks its two facts from — problems first.
 *
 * A failed run or an expired question is the whole reason to glance at this
 * card, and only two facts fit in a title. Ranking them first means a large,
 * uneventful count — "40 turns finished" — can never push a single failure
 * out of the two slots a glance actually reads.
 */
const HEADLINE_ORDER: readonly ShiftReportFactKey[] = [
  'runsFailed',
  'asksExpired',
  'runsSucceeded',
  'turnsCompleted',
  'asksAnswered',
  'messages',
];

/** Every non-zero fact, worded, in the given order. */
function sayInOrder(
  facts: Record<ShiftReportFactKey, ShiftReportFact>,
  order: readonly ShiftReportFactKey[]
): string[] {
  return order
    .map((key) => facts[key])
    .filter((fact) => fact.count > 0)
    .map((fact) => fact.say(fact.count));
}

/**
 * Turn the day's counts into the title and body a person reads.
 *
 * The title leads with the two facts most worth a glance — problems first
 * (see {@link HEADLINE_ORDER}); the body carries the full rundown in
 * narrative order, ending with the window it covers so the timeframe is
 * never left to guesswork. Both are plain sentences a smart ninth grader
 * reads without translation — no product jargon, no exclamation marks for
 * routine work.
 *
 * @param counts - What {@link composeShiftReport} found. Callers only reach
 *   this after its `null` check, so at least one fact here is non-zero.
 */
export function buildShiftReportText(counts: ShiftReportCounts): {
  title: string;
  summary: string;
} {
  const facts = shiftReportFacts(counts);
  const headline = sayInOrder(facts, HEADLINE_ORDER).slice(0, 2);
  const body = sayInOrder(facts, BODY_ORDER);

  return {
    title: `While you were away: ${headline.join(', ')}`,
    summary: `${body.join(', ')} in the last day.`,
  };
}
