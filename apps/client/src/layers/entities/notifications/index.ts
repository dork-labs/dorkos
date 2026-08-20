/**
 * Notifications entity — the Inbox's one store, and the rules for drawing a row
 * out of it (spec `notification-system` §Client).
 *
 * Everything DorkOS has already told the operator lives here: the paged history,
 * its read state, and the pure mapping from a notification to a mark, a tone and
 * a destination. Three surfaces read it through different lenses — the header
 * bell, an agent's profile, home's activity group — and they all read THIS,
 * because one fact drawn from two stores is one fact that can disagree.
 *
 * What is **not** here: anything still waiting on a person. That is
 * `entities/attention`'s job and stays there — the Inbox shows it, it does not
 * re-derive it.
 *
 * @module entities/notifications
 */
export { useNotifications, useUnreadCount } from './model/use-notifications';
export type { NotificationsState } from './model/use-notifications';
export { useMarkRead, useMarkAllRead } from './model/use-mark-read';
export type { MarkReadMutation, MarkAllReadMutation } from './model/use-mark-read';
export { requestInbox, useInboxRequest, clearInboxRequest } from './model/inbox-request-store';
export {
  NOTIFICATIONS_QUERY_KEY,
  notificationsQueryKey,
  matchesLens,
  upsertNotification,
  applyNotificationRead,
  clearBumpedNotifications,
  MAX_LIVE_PAGE_ROWS,
} from './model/notification-cache';
export type { NotificationLens, NotificationPages } from './model/notification-cache';
export {
  NOTIFICATION_ICONS,
  notificationTone,
  notificationLink,
  isFailedRun,
} from './lib/notification-presentation';
export type { NotificationLink } from './lib/notification-presentation';
