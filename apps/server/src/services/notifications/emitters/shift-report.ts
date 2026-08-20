/**
 * Fires the daily Shift Report once real activity has happened after the
 * local day turns over (spec `notification-system`, task 5.2, DOR-1389).
 *
 * **The trigger is deliberately not a timer.** DorkOS already has one signal
 * that something happened: every `notify()` call broadcasts on
 * `eventFanOut` before it reaches a single connected client
 * (`EventFanOut.subscribe`), and that is the cheapest honest answer to "has
 * today started yet" — if nothing has happened since 4am, there is nothing
 * to check, and a timer would be polling for an answer the pipeline already
 * has. So this rides the existing broadcast rather than adding a server-wide
 * interval: the FIRST notification of a new local day is what turns the
 * report over, whatever kind it is.
 *
 * **State is in-memory, not persisted, and that is a deliberate trade.** A
 * crash mid-day loses only "have I already reported today" — never the
 * report's own facts, which are read fresh from the notifications table on
 * every attempt — and the registry's own dedupe key
 * (`report-daily:{date}`, held open by `REPORT_DAILY_DEDUPE_WINDOW_MS`) is
 * the backstop that keeps a restart from writing a second row for a day
 * already reported. What a restart CAN do is delay today's report until the
 * next notification after it comes back up, which is the honest cost of not
 * running a boot-time catch-up for a feature this quiet.
 *
 * @module services/notifications/emitters/shift-report
 */
import { eventFanOut } from '../../core/event-fan-out.js';
import { logger } from '../../../lib/logger.js';
import { notify } from '../notification-service.js';
import type { NotificationStore } from '../notification-store.js';
import {
  buildShiftReportText,
  composeShiftReport,
  shiftReportBoundary,
  shiftReportDateKey,
} from '../shift-report.js';

/**
 * Watch for the day's first real activity and raise the Shift Report once.
 *
 * @param store - Where the day's activity already lives.
 * @returns An unsubscribe function.
 */
export function watchShiftReport(store: NotificationStore): () => void {
  /** The local day a report was last successfully raised for, if any. */
  let reportedFor: string | undefined;
  /**
   * Whether an attempt is already in flight.
   *
   * `raise()` yields to the event loop before it inserts (every notify() call
   * is `async`, even one whose relay policy is `never`), so two heartbeats a
   * millisecond apart — two scheduled runs finishing back to back — could
   * otherwise both find nothing stored yet and both insert a row. This makes
   * attempts serial instead: at most one composes and calls `notify()` at a
   * time, which is what keeps the one shared dedupe key
   * (`report-daily:{date}`) actually shared rather than raced.
   */
  let checking = false;

  return eventFanOut.subscribe((eventName, data) => {
    if (eventName !== 'notification') return;
    // Its own broadcast is not "activity" to react to. Reacting to it would
    // still be harmless — `reportedFor` is set before this fires again — but
    // skipping it by kind says the real intent plainly rather than leaning on
    // that ordering.
    const kind = (data as { notification?: { kind?: string } } | null)?.notification?.kind;
    if (kind === 'report.daily') return;

    const boundary = shiftReportBoundary(Date.now());
    const localDate = shiftReportDateKey(boundary);
    if (checking || localDate === reportedFor) return;

    checking = true;
    void raiseIfDue(store, boundary, localDate)
      .then((raised) => {
        if (raised) reportedFor = localDate;
      })
      .finally(() => {
        checking = false;
      });
  });
}

/**
 * Compose the day's report and raise it, when there is anything to say.
 *
 * Never throws: a notification is the least important thing this path is
 * doing, and a composition error must never surface on the write path of
 * whatever activity triggered the check.
 *
 * @param store - Where the day's activity already lives.
 * @param boundary - The most recent local 4am, epoch ms.
 * @param localDate - `boundary`'s own calendar date — the report's identity.
 * @returns Whether a notification was actually stored. `false` on an empty
 *   day so far, so the caller keeps trying later in the same day.
 */
async function raiseIfDue(
  store: NotificationStore,
  boundary: number,
  localDate: string
): Promise<boolean> {
  try {
    const counts = composeShiftReport(store, boundary);
    if (!counts) return false;

    const { title, summary } = buildShiftReportText(counts);
    const result = await notify('report.daily', { date: localDate, title, summary });
    return result.notification !== null;
  } catch (err) {
    logger.warn('[Notifications] Could not compose the daily Shift Report', { err });
    return false;
  }
}
