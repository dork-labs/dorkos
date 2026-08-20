/**
 * Inbox bell widget — the one marker in the app header, and the panel behind it
 * (spec `notification-system` §Client, design decision §2).
 *
 * This is `ApprovalsIndicator` grown up. It kept the mount point, the amber
 * contract and the ⌘⇧Y shortcut, and gained the half the cockpit never had: a
 * history with read state. The pinned "Needs you" section is still composed from
 * `entities/attention` and the existing cards — the Inbox shows what is waiting,
 * it does not re-derive it.
 *
 * @module widgets/inbox-bell
 */
export { InboxBell } from './ui/InboxBell';
export { InboxBellPill, DISPLAY_CAP } from './ui/InboxBellPill';
export type { InboxBellPillProps, InboxBellGlyph } from './ui/InboxBellPill';
