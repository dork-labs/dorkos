/**
 * What every row of the chat list shares, its tree's rows included: the slot
 * tests find a row by, its left inset, and the fold toggle's slot.
 *
 * @module features/chat-list/ui/chat-row-parts
 */

/**
 * The `data-slot` every chat row answers to, folded spin-offs included.
 *
 * One name for every row, so a test or page object finds them without knowing
 * which section they landed in, which is exactly what the list decides.
 */
export const CHAT_LIST_ROW_SLOT = 'chat-list-row';

/**
 * A row's left inset: the same 8px the section headings and toggles use, so
 * row titles line up with them instead of the sidebar's glyph column.
 */
export const ROW_INSET = 'pl-2';

/** The `data-slot` on an "N spin-offs" toggle, under a row or a chat in its tree. */
export const CHAT_LIST_SPIN_OFF_TOGGLE_SLOT = 'chat-list-spin-off-toggle';
