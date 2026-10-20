/**
 * Which held connected-app actions can still be cancelled from the Inbox (spec
 * `trusted-by-default-flip` §5.6).
 *
 * An agent's high-risk action in a connected app waits 60 seconds before it
 * runs. Its waiting row carries a Cancel action; the row that says how it
 * ended (ran, or did not) carries none and shares the waiting row's subject,
 * the hold. So a waiting row is still cancellable only while no row for the
 * same hold has ended it and its 60 seconds have not passed.
 *
 * @module features/inbox/lib/held-actions
 */
import { DESTRUCTIVE_HOLD_MS } from '@dorkos/shared/connector-hold-schemas';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';

/** The kinds a held action's rows come in. */
const HELD_KINDS = new Set(['connector.destructive_pending', 'connector.destructive_executed']);

/** Whether a row offers Cancel: only a held action's waiting row does. */
export function offersCancel(notification: NotificationDTO): boolean {
  return (
    notification.kind === 'connector.destructive_pending' &&
    notification.actions?.some((action) => action.id === 'cancel') === true
  );
}

/**
 * The holds some row already says have ended: it ran, was cancelled, or was
 * dropped by a restart.
 *
 * @param notifications - Every row the list holds.
 * @returns The hold ids, as each row's subject names them.
 */
export function endedHoldIds(notifications: readonly NotificationDTO[]): Set<string> {
  const ended = new Set<string>();
  for (const notification of notifications) {
    if (HELD_KINDS.has(notification.kind) && !offersCancel(notification)) {
      ended.add(notification.subject.id);
    }
  }
  return ended;
}

/**
 * How long Cancel stays on a waiting row, never below zero.
 *
 * Lenient on purpose: the window counts from the row's `createdAt` (the
 * server's clock) or from when this window first saw the row, whichever ends
 * later. A client clock running fast would otherwise read a fresh row as
 * already past its 60 seconds and hide Cancel early. A late Cancel is
 * harmless: the server answers that it is too late, and a later row for the
 * hold hides it anyway.
 *
 * @param notification - The waiting row.
 * @param firstSeen - When this window first drew the row, in epoch ms.
 * @param now - The current time, in epoch ms.
 * @returns Milliseconds Cancel stays.
 */
export function holdTimeLeft(
  notification: NotificationDTO,
  firstSeen: number,
  now: number
): number {
  const deadline =
    Math.max(Date.parse(notification.createdAt) || 0, firstSeen) + DESTRUCTIVE_HOLD_MS;
  return Math.max(0, deadline - now);
}
