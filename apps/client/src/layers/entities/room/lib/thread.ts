/**
 * Where an entry sits in its thread, and what replying to it aims at.
 *
 * A thread is a relation between entries in one room's log, not a room of its
 * own (ADR 260728-022013), so "which thread is this in?" is a question about a
 * single entry and answering it needs nothing else loaded.
 *
 * @module entities/room/lib/thread
 */
import type { RoomEntry } from '@dorkos/shared/room-schemas';

/**
 * The entry heading this entry's thread, or `null` when it heads its own.
 *
 * Reads `threadRootEntryId` and falls back to `parentEntryId`. The fallback is
 * not decoration: the two pointers are written together and pinned equal by a
 * server test, but that invariant is not yet a `CHECK` constraint, so a
 * hand-written row can still carry one without the other.
 *
 * @param entry - The entry to place.
 */
export function threadRootIdOf(entry: RoomEntry): string | null {
  return entry.threadRootEntryId ?? entry.parentEntryId;
}

/**
 * The entry a reply to this one must hang off.
 *
 * **Replying to a reply aims at the root**, because the server refuses anything
 * deeper (`NESTED_THREAD`, 400) and a refusal here would be an error message
 * about our own interface. Retargeting is also what the reader already sees:
 * the timeline draws one level, so the thread they are answering into is the
 * root's, whichever line inside it they pressed.
 *
 * @param entry - The entry the reader chose to answer.
 * @returns The id to send as `rootEntryId` — the entry itself when it heads a
 *   thread, otherwise the entry that does.
 */
export function replyRootFor(entry: RoomEntry): string {
  return threadRootIdOf(entry) ?? entry.id;
}
