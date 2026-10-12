/**
 * When an agent's report beat runs (spec `heartbeats` §3.4): at the start of
 * its chain person's working day for `report: daily`, and at the start of the
 * week's first working day (Monday's, on a Monday-to-Friday week) for
 * `weekly`.
 *
 * - **A missed report is owed, not lost.** When the start after its last
 *   report beat has passed (the server was off, the reader was away, the chat
 *   was busy), it runs a few minutes from now, or when its reader is next
 *   available if later.
 * - **A new agent waits for the next start.** With no report beat yet there is
 *   nothing owed, so a restart never fires a burst of reports.
 * - **No slot is spent on an away reader.** A start that falls while they are
 *   away is passed over for the first one after they are back.
 *
 * Pure: the runner reads the facts and arms the timer.
 *
 * @module services/heartbeats/raises/report-clock
 */
import type { HeartbeatReport } from '@dorkos/shared/heartbeat-schemas';
import {
  nextWorkingStart,
  zonedDay,
  type ResolvedWorkingHours,
} from '@dorkos/shared/working-hours';

/** The wake a report beat runs under (`heartbeat_beats.wake`). */
export const REPORT_WAKE = 'event:report-due';

/** The shortest and longest wait before an owed report runs. */
const OWED_STAGGER_MS = [60_000, 5 * 60_000] as const;

/** The most working starts looked through for a weekly report's day. */
const WEEKLY_SEARCH = 8;

/**
 * The weekday (0 = Sunday) a weekly report runs on: Monday when it is a
 * working day, else the week's first working day counting from Monday.
 *
 * @param days - The working days.
 */
function weeklyDay(days: readonly number[]): number {
  if (days.includes(1)) return 1;
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))[0] ?? 1;
}

/**
 * The weekday of a moment in a zone.
 *
 * @param at - Epoch ms.
 * @param zone - IANA zone.
 */
function zonedWeekday(at: number, zone: string): number {
  return new Date(`${zonedDay(new Date(at), zone)}T00:00:00Z`).getUTCDay();
}

/**
 * The first report start strictly after a moment, or null with no working days.
 *
 * @param cadence - `daily` or `weekly`.
 * @param hours - The chain person's working hours.
 * @param after - Epoch ms.
 */
export function nextReportSlot(
  cadence: Exclude<HeartbeatReport, 'off'>,
  hours: ResolvedWorkingHours,
  after: number
): number | null {
  let from = after + 1;
  const day = weeklyDay(hours.days);
  for (let i = 0; i < WEEKLY_SEARCH; i++) {
    const start = nextWorkingStart(new Date(from), hours)?.getTime();
    if (start === undefined) return null;
    if (cadence === 'daily' || zonedWeekday(start, hours.timezone) === day) return start;
    from = start + 1;
  }
  return null;
}

/** What {@link reportBeatAt} reads. */
export interface ReportClockFacts {
  /** `report:` from `HEARTBEAT.md`. */
  cadence: HeartbeatReport;
  /** The chain person's working hours. */
  hours: ResolvedWorkingHours;
  /** The start of its last report beat that ran, or null. */
  lastAttemptAt: string | null;
  /**
   * When its reader can next be reported to (epoch ms): now for an agent, null
   * for a person away with no return date (nothing is owed; the next start is
   * armed, and the runner re-arms when they come back).
   */
  readerAvailableAt: number | null;
  /** Epoch ms. */
  now: number;
  /** A number in [0, 1), for the stagger. */
  random?: () => number;
}

/** When the next report beat runs, and whether it is one owed from before. */
export interface ReportBeatTime {
  /** Epoch ms. */
  at: number;
  /** A missed report run late, rather than the next regular start. */
  owed: boolean;
}

/**
 * When the agent's next report beat runs, or null when it never reports.
 *
 * @param facts - What it reads.
 */
export function reportBeatAt(facts: ReportClockFacts): ReportBeatTime | null {
  const { cadence, hours, now } = facts;
  if (cadence === 'off') return null;
  const regular = (at: number | null) => (at === null ? null : { at, owed: false });
  // Away with no return date: an hourly re-check would re-run a skipped report.
  if (facts.readerAvailableAt === null) return regular(nextReportSlot(cadence, hours, now));
  const available = facts.readerAvailableAt;
  // The first start once the reader can read it: a slot while they are away is skipped.
  const firstFrom = (after: number) =>
    nextReportSlot(cadence, hours, Math.max(after, available - 1));
  const last = facts.lastAttemptAt ? Date.parse(facts.lastAttemptAt) : NaN;
  if (Number.isNaN(last)) return regular(firstFrom(now));
  const due = nextReportSlot(cadence, hours, last);
  if (due === null) return null;
  if (due > now) return regular(due >= available ? due : firstFrom(due));
  const [min, max] = OWED_STAGGER_MS;
  const stagger = min + Math.floor((facts.random ?? Math.random)() * (max - min));
  return { at: Math.max(now + stagger, available), owed: true };
}
