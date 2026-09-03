/**
 * Notifications — the channels that reach a person who is not looking at the
 * cockpit: the three sounds, the browser's own notifications, the card that asks
 * permission to use them, and the devices DorkOS may push to once it is closed.
 *
 * Not to be confused with `entities/notifications`, which owns the Inbox's rows.
 * That one answers "what happened"; this one answers "how do we tell you".
 *
 * The barrel is narrow on purpose — the mounted components, the cue player the
 * session view uses for its turn-finished chime, and the permission card's
 * decision (its host arbitrates cards, so it must be able to ask before it
 * draws). The arrival watcher, the primer latch and the push-subscription flow
 * are how those are built rather than what a consumer needs, and this slice's
 * own tests import them by path.
 * {@link ReachMeSection} is here because the Settings tab renders it: a feature
 * may compose a sibling feature's COMPONENT, never reach into its hooks.
 *
 * @module features/notifications
 */
export { NotificationCenter } from './ui/NotificationCenter';
export { PermissionPrimer } from './ui/PermissionPrimer';
export { usePermissionPrimer, type PermissionPrimerOffer } from './model/use-permission-primer';
export { ReachMeSection } from './ui/ReachMeSection';
export { useNotificationCues, type NotificationCues } from './model/use-notification-cues';
