/**
 * The words core draws around an extension's decision (spec
 * `flow-multiproject` §7.1, §7.4, §7.5, V2, V8): the deadline line, the
 * timing line, and the history row's trail. Pure, so every sentence is
 * pinned by a test.
 *
 * @module features/inbox/lib/decision-copy
 */
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { formatBackIn, formatResetTime } from '@/layers/shared/lib';

/** How much later than the condition began an ask has to be to say "asked after". */
const ASKED_AFTER_MIN_MS = 60_000;

/**
 * "If you don't answer by 5pm, the agent picks “Keep it”." — in the viewer's
 * zone, with a day when it is not today. Null when the question has no
 * deadline (or its deadline already passed and was dealt with).
 *
 * @param decideBy - The deadline, ISO, or undefined.
 * @param pickLabel - The agent's pick, in words, or null.
 * @param now - The moment to read from.
 */
export function deadlineLine(
  decideBy: string | undefined,
  pickLabel: string | null,
  now: Date
): string | null {
  if (!decideBy || !pickLabel) return null;
  const due = Date.parse(decideBy);
  if (Number.isNaN(due)) return null;
  // Never a deadline in the past: the agent is about to go ahead.
  if (due <= now.getTime())
    return `The agent picks “${pickLabel}” any moment now, unless you answer.`;
  const when = formatResetTime(decideBy, now);
  return when ? `If you don’t answer by ${when}, the agent picks “${pickLabel}”.` : null;
}

/**
 * "since 09:14 · asked after 1h" (V2): when the condition began, and how long
 * the extension waited before asking. Null when the decision gave no start.
 *
 * @param since - When the condition began, ISO, or null.
 * @param raisedAt - When the decision was raised, ISO.
 * @param now - The moment to read from.
 */
export function sinceLine(since: string | null, raisedAt: string, now: Date): string | null {
  if (!since) return null;
  const began = formatResetTime(since, now);
  if (!began) return null;
  const waited = Date.parse(raisedAt) - Date.parse(since);
  return waited >= ASKED_AFTER_MIN_MS
    ? `since ${began} · asked after ${formatBackIn(waited)}`
    : `since ${began}`;
}

/**
 * "at 2:14 PM" today, "on Sep 12" any other day, in the viewer's zone.
 *
 * @param iso - The moment, ISO.
 * @param now - The moment to read from.
 */
function whenPhrase(iso: string, now: Date): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? `at ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)}`
    : `on ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)}`;
}

/**
 * What follows the title on a decision's history row: "Ship it · you at
 * 2:14 PM", "Ship it · you on Sep 12", "Resolved on its own at 11:02", "No
 * longer needed". The server
 * wrote who decided (the body); this adds the time in the viewer's zone.
 *
 * @param notification - The stored history row.
 * @param now - The moment to read from.
 */
export function decisionHistoryTrail(notification: NotificationDTO, now: Date): string | null {
  const body = notification.body ?? null;
  if (notification.outcome === 'cancelled') return body;
  const when = whenPhrase(notification.resolvedAt ?? notification.createdAt, now);
  if (!body) return when;
  return when ? `${body} ${when}` : body;
}
