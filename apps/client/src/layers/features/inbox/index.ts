/**
 * Inbox feature — the list of what has happened, and the row it is made of
 * (spec `notification-system` §Client).
 *
 * Drawing only. The store, the read state and the mapping from a notification to
 * a mark and a destination all live in `entities/notifications`; what is here is
 * the one list three surfaces share, so that the bell, an agent's profile and
 * home cannot drift into three different ideas of what a notification looks
 * like.
 *
 * @module features/inbox
 */
export { InboxList } from './ui/InboxList';
export type { InboxListProps } from './ui/InboxList';
export { InboxRow } from './ui/InboxRow';
export type { InboxRowProps } from './ui/InboxRow';
export { useOpenNotification } from './model/use-open-notification';
