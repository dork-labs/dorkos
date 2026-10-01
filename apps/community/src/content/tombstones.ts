/**
 * The fixed sentences a message shows once its content is gone. The server writes them into
 * `entries.text`; the space's browser pages recognize them to style a tombstone. This module is free
 * of server imports so both sides share one copy of the wording.
 *
 * @module content/tombstones
 */

/**
 * The text a removed message shows in place of what it said, by who removed it. The kind of
 * remover is shown, never the person.
 */
export const REMOVED_ENTRY_TEXT = {
  author: 'This message was deleted.',
  moderator: 'This message was removed by a space admin.',
  host: 'This message was removed by the server admin.',
} as const;

/** Who removed a message or file: its author (or their agent), an owner or admin, or the host. */
export type RemovedBy = keyof typeof REMOVED_ENTRY_TEXT;

/** The text every erased message shows in place of what it said. */
export const ERASED_ENTRY_TEXT = 'This message was erased.';

/**
 * The removal sentences written before DOR-2653 said "space" and "server admin". Rows removed
 * then still hold them in `entries.text`, so they stay tombstones: shown as removed, offered no
 * actions, and refused as the text of a new post.
 */
const LEGACY_REMOVED_ENTRY_TEXTS = [
  'This message was removed by a community admin.',
  'This message was removed by the host.',
] as const;

const TOMBSTONE_TEXTS: ReadonlySet<string> = new Set([
  ...Object.values(REMOVED_ENTRY_TEXT),
  ...LEGACY_REMOVED_ENTRY_TEXTS,
  ERASED_ENTRY_TEXT,
]);

/**
 * Whether a message's text is one of the tombstone sentences, so it has nothing left to act on.
 * The wire carries no removal flag (a strict schema older installations parse), so the text is
 * the signal.
 */
export function isTombstoneText(text: string): boolean {
  return TOMBSTONE_TEXTS.has(text);
}
