/**
 * Which runtimes are sitting on a dead sign-in right now, read off the Inbox's
 * own `signin.required` rows.
 *
 * A pure function, separate from the descriptor hook, because the rule it
 * encodes is the whole risk in this banner: get it wrong in either direction and
 * the app either nags about a sign-in somebody already fixed, or stays silent
 * about one that is still dead.
 *
 * @module widgets/app-banner/lib/dead-runtime-signins
 */
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';

/**
 * Every runtime whose sign-in is still dead.
 *
 * ## Latest row per runtime, and `outcome` is the whole test
 *
 * `signin.required` is a `standing-recorded` kind: the server writes one row
 * when a runtime's sign-in stops working, and a SECOND row — same
 * `subject.id`, `outcome: 'cleared'` — when the next clean turn proves it works
 * again (`services/notifications/emitters/runtime-signin.ts`). Neither row is
 * ever revised in place, so "is this runtime still broken?" is answered by the
 * newest row it has and nothing else.
 *
 * **Never by `readAt`.** The recovery row lands ALREADY READ, on purpose — a
 * sign-in somebody just fixed must not light the bell. A banner keyed on unread
 * would therefore keep showing after the recovery, which is exactly the
 * always-on alarm this row must never become. It would also go quiet the moment
 * somebody opened the Inbox while the sign-in was still dead.
 *
 * ## Why the arrival order is not trusted
 *
 * The list arrives newest-first and live rows are prepended, so taking the
 * first row per runtime would usually be right. `createdAt` (with the ULID id
 * as the tie-break, since ULIDs sort by creation time) is compared instead, so
 * a refetch that interleaves a page with live arrivals cannot resurrect a
 * cleared sign-in.
 *
 * @param notifications - Inbox rows, of any kinds. Non-`signin.required` rows
 *   are ignored, so a caller may pass an unfiltered list.
 * @returns Runtime types (`claude-code`, `codex`, …), in the order their newest
 *   row appears in the input — stable across reads, since the input is ordered.
 */
export function deadSigninRuntimes(notifications: readonly NotificationDTO[]): string[] {
  const latest = new Map<string, NotificationDTO>();
  for (const row of notifications) {
    if (row.kind !== 'signin.required') continue;
    const held = latest.get(row.subject.id);
    if (held === undefined || isNewer(row, held)) latest.set(row.subject.id, row);
  }
  return [...latest.entries()]
    .filter(([, row]) => row.outcome !== 'cleared')
    .map(([runtime]) => runtime);
}

/**
 * Whether `row` was raised after `held`, comparing the ISO timestamp first and
 * falling back to the ULID id when two rows share a millisecond.
 */
function isNewer(row: NotificationDTO, held: NotificationDTO): boolean {
  if (row.createdAt !== held.createdAt) return row.createdAt > held.createdAt;
  return row.id > held.id;
}
