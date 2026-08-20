/**
 * Notifications — the channels that reach a person who is not looking at the
 * cockpit: the three sounds, the browser's own notifications, and the one card
 * that asks for permission to use them.
 *
 * Not to be confused with `entities/notifications`, which owns the Inbox's rows.
 * That one answers "what happened"; this one answers "how do we tell you".
 *
 * The barrel is narrow on purpose — the two mounted components, and the cue
 * player the session view uses for its turn-finished chime. The arrival watcher
 * and the primer latch are how those are built rather than what a consumer
 * needs, and this slice's own tests import them by path.
 *
 * @module features/notifications
 */
export { NotificationCenter } from './ui/NotificationCenter';
export { PermissionPrimer } from './ui/PermissionPrimer';
export { useNotificationCues, type NotificationCues } from './model/use-notification-cues';
