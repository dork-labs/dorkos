/**
 * The daily Shift Report: what to tell the operator about a day that just
 * ended (spec `notification-system`, design-decisions.md §7.2 "The Shift
 * Report"; task 5.2, DOR-1389).
 *
 * Composed entirely from the notifications table itself — no new store, no
 * new query surface. Every kind this report counts is stored `event`
 * (`notification-registry.ts`'s {@link NotificationStorageRule}), which means
 * the row already IS the record of what happened; a report built from a
 * second source could disagree with the very inbox it is summarizing.
 *
 * **The day boundary is 4am local, not midnight** — mirrored, not shared,
 * from the sidebar digest's own definition
 * (`apps/client/src/layers/shared/lib/overnight-boundary.ts`,
 * `apps/client/src/layers/features/dashboard-sidebar/model/rules/build-digest-row.ts`).
 * The server cannot import client code, and both sides are answering the
 * same question — when does a person who works late consider today OVER —
 * by computing the same rule against the same host clock, independently. A
 * copy that drifted would read one boundary in the sidebar's "while you were
 * away" row and a different one in the report it could point at, which is a
 * worse property than the duplication.
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
 * hour is an input to {@link shiftReportBoundary} and nothing else.
 */
const SHIFT_REPORT_BOUNDARY_HOUR = 4;

/**
 * The most recent local 04:00 that has already passed, epoch ms.
 *
 * Local rather than UTC, and computed from `now` rather than read from a
 * clock, so a test can walk it across a day without mocking time. Mirrors
 * `overnight-boundary.ts`'s `overnightBoundary` exactly.
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
 * shift).
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
 * Read the day's activity since `sinceMs` and fold it into the six counts the
 * report cares about, or `null` when every one of them is zero.
 *
 * `null` on an empty day is the whole point: a "while you were away" that
 * reports nothing is a product inventing an event to have a moment about —
 * the same rule the sidebar digest states at `build-digest-row.ts`.
 *
 * Splits `run.completed` by reading its stored TIER rather than parsing its
 * payload: the registry already spells "this one failed" as `notable` and
 * "this one didn't" as `quiet` (`notification-registry.ts`), and re-deriving
 * that from `dataJson` would be a second place it could drift from the one
 * the registry declares.
 *
 * @param store - Where the day's rows already live.
 * @param sinceMs - The boundary to count from (inclusive), epoch ms.
 */
export function composeShiftReport(
  store: NotificationStore,
  sinceMs: number
): ShiftReportCounts | null {
  const rows = store.countActivitySince(new Date(sinceMs).toISOString());
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
        // Every other kind (agent notes, dead letters, updates…) is real
        // activity too, but not the shift's own work product — the report is
        // about what agents DID, not everything the inbox ever mentioned.
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

/** "1 run" vs "3 runs" — pluralize a counted noun. */
function countedNoun(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Every fact the report can mention, in the order the body reads them.
 *
 * Plain nouns throughout — "question", never "Ask" — because this is
 * user-facing prose (writing-for-humans), not the product's own vocabulary
 * for the thing.
 */
function shiftReportFacts(counts: ShiftReportCounts): ShiftReportFact[] {
  return [
    { count: counts.turnsCompleted, say: (n) => `${countedNoun(n, 'turn')} finished` },
    { count: counts.runsSucceeded, say: (n) => `${countedNoun(n, 'run')} finished` },
    {
      count: counts.runsFailed,
      say: (n) => `${countedNoun(n, 'run')} ${n === 1 ? 'needs' : 'need'} a look`,
    },
    { count: counts.asksAnswered, say: (n) => `${countedNoun(n, 'question')} answered` },
    { count: counts.asksExpired, say: (n) => `${countedNoun(n, 'question')} went unanswered` },
    { count: counts.messages, say: (n) => `${countedNoun(n, 'message')} waiting` },
  ];
}

/**
 * Turn the day's counts into the title and body a person reads.
 *
 * The title leads with the two most useful facts (the first thing a glance
 * needs); the body carries the full rundown, one clause per non-zero fact.
 * Both are plain sentences a smart ninth grader reads without translation —
 * no product jargon, no exclamation marks for routine work.
 *
 * @param counts - What {@link composeShiftReport} found. Callers only reach
 *   this after its `null` check, so at least one fact here is non-zero.
 */
export function buildShiftReportText(counts: ShiftReportCounts): {
  title: string;
  summary: string;
} {
  const facts = shiftReportFacts(counts)
    .filter((fact) => fact.count > 0)
    .map((fact) => fact.say(fact.count));

  return {
    title: `While you were away: ${facts.slice(0, 2).join(', ')}`,
    summary: `${facts.join('. ')}.`,
  };
}
