/**
 * Entry actions — what you can do to one message in a room.
 *
 * The surface, not the button. Reply-in-thread is its first tenant and quick
 * reactions are its next, so this slice owns an ordered ACTION SET and three
 * ways to reach it — the toolbar that appears on hover or focus, the right-click
 * menu, and the long-press drawer on touch. All three render the same array in
 * the same order, which is what keeps a message's affordances one thing a reader
 * learns once instead of three that happen to agree.
 *
 * @module features/entry-actions
 */
export { useEntryActions } from './model/use-entry-actions';
export type { EntryAction } from './lib/entry-actions';
export { EntryActionBar } from './ui/EntryActionBar';
export type { EntryActionBarHandle } from './ui/EntryActionBar';
export { EntryActionMenu } from './ui/EntryActionMenu';
