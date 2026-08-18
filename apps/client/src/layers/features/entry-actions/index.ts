/**
 * Entry actions — what you can do to one message in a room.
 *
 * The surface, not the button. It owns an ordered ACTION SET — quick reactions,
 * the picker, then reply / copy / mention — and three ways to reach it: the
 * toolbar that appears on hover or focus, the right-click menu, and the
 * long-press drawer on touch. All three render the same set in the same order,
 * which is what keeps a message's affordances one thing a reader learns once
 * instead of three that happen to agree.
 *
 * It also owns the pills a reaction leaves under the message, because the pill
 * is a toggle for the same act the capsule offers — one slice, one rule for what
 * a reaction means.
 *
 * @module features/entry-actions
 */
export { useEntryActions } from './model/use-entry-actions';
export type { EntryAction } from './lib/entry-actions';
export { ENTRY_ACTION_ORDER } from './lib/entry-actions';
export type { EntryActionId, EntryActionSlot } from './lib/entry-actions';
export { EMOJI_GROUPS, emojiLabel, searchEmoji } from './lib/emoji-catalog';
export type { RovingGroupHandle } from './model/use-roving-buttons';
export { EntryActionBar } from './ui/EntryActionBar';
export type { EntryActionBarHandle, EntryActionBarReactions } from './ui/EntryActionBar';
export type { EntryRunWith } from './ui/EntryRunWithMenu';
export { EntryActionMenu } from './ui/EntryActionMenu';
export type { EntryActionMenuReactions } from './ui/EntryActionMenu';
export { EntryReactionRow } from './ui/EntryReactionRow';
export { EntryReactionPicker, EntryReactionGrid } from './ui/EntryReactionPicker';
