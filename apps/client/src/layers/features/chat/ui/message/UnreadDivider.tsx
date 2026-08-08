/**
 * The "New messages" rule in the message list.
 *
 * @module features/chat/ui/message/UnreadDivider
 */

/** Label on the unread rule. Named so the row and its aria label can't drift. */
const UNREAD_LABEL = 'New messages';

/**
 * The rule marking where the reader left off.
 *
 * At most one per list, placed before the first message that arrived after the
 * reader's last visit. One component for every kind of thread there is: a
 * session's transcript places it from the server-held cursor
 * (`use-unread-cursor`), a room's from the same table's room cursor, so the same
 * read state draws the same rule wherever it is read. Accent-colored and
 * labelled on the right so it reads as a live marker rather than another day
 * boundary.
 */
export function UnreadDivider() {
  return (
    <div
      data-testid="unread-divider"
      role="separator"
      aria-label={UNREAD_LABEL}
      className="flex items-center gap-2 py-2"
    >
      <span aria-hidden="true" className="bg-brand/60 h-px flex-1" />
      <span className="text-brand text-2xs font-medium tracking-wide">{UNREAD_LABEL}</span>
    </div>
  );
}
