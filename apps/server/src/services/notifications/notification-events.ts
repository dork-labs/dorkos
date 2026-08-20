/**
 * SSE broadcast helpers for the notification domain.
 *
 * Both events ride the global `/api/events` fan-out so an inbox open in one
 * window matches an inbox open in another, and a badge cleared on the laptop
 * clears on the phone.
 *
 * **Both are addressed.** A notification carries a title and body about what an
 * agent is doing — the same class of detail the Ask events were made addressed
 * for (ADR 260819-022912) — so they go only to a connection entitled to the
 * operator's own view. An agent principal, which is a machine calling in with
 * `X-DorkOS-Agent`, receives neither.
 *
 * @module services/notifications/notification-events
 */
import type { NotificationDTO, NotificationReadEvent } from '@dorkos/shared/notification-schemas';
import { eventFanOut } from '../core/event-fan-out.js';
import { operatorAudience } from './notification-entitlement.js';

/**
 * Announce a notification, new or changed.
 *
 * An upsert rather than a create: a standing condition that resolves is
 * broadcast again under the same id carrying its outcome, so a surface holding
 * the row replaces it instead of drawing the same thing twice.
 *
 * @param notification - The row as every surface reads it.
 */
export function broadcastNotification(notification: NotificationDTO): void {
  eventFanOut.broadcast('notification', { notification }, operatorAudience);
}

/**
 * Announce that notifications were marked read.
 *
 * @param event - Which ones, and what the unread count now is.
 */
export function broadcastNotificationRead(event: NotificationReadEvent): void {
  eventFanOut.broadcast('notification_read', event, operatorAudience);
}
