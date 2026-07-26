/**
 * Turning a room's log into the rows the message list renders.
 *
 * @module widgets/room-view/lib/room-timeline
 */
import type { AuthorRef, RoomEntry, RoomRosterEntry } from '@/layers/entities/room';
import { authorColor } from '@/layers/entities/room';
import type { MessageAuthor } from '@/layers/shared/model';

/**
 * Build the roster lookup the list renders authors from.
 *
 * A room entry stores an opaque `authorId` and nothing else (ADR 260726-170126),
 * so the roster is the only place a name comes from — the client never derives
 * an author from the session, the selected agent, or the message's own shape.
 *
 * @param members - The room's roster.
 */
export function authorsById(members: readonly RoomRosterEntry[]): Map<string, AuthorRef> {
  return new Map(members.map((member) => [member.author.id, member.author]));
}

/**
 * The view model the shared message primitives render an author from.
 *
 * Colors are hashed from the opaque author id, so one participant reads as one
 * color everywhere without the server having to choose. An agent's emoji is
 * deliberately NOT resolved here: it would mean matching the roster back to a
 * local agent by display name, and a wrong avatar on someone's words is worse
 * than a plain one.
 *
 * @param authorId - The entry's stored author id.
 * @param authors - The room's roster, keyed by author id.
 */
export function toMessageAuthor(
  authorId: string,
  authors: ReadonlyMap<string, AuthorRef>
): MessageAuthor {
  const author = authors.get(authorId);
  return {
    // A removed member's old posts still render: the roster no longer holds
    // them, and saying so is more honest than dropping what they said.
    kind: author?.kind ?? 'system',
    id: authorId,
    displayName: author?.displayName ?? 'Unknown',
    color: authorColor(authorId),
  };
}

/**
 * The id of the last entry the reader has already seen, from their read cursor.
 *
 * The unread rule is placed relative to an id, while a membership stores a
 * `seq`, so this is the translation between the two. Returns `null` when the
 * reader is caught up, is not a member, or has read nothing — all three mean
 * "draw no rule".
 *
 * @param entries - The rendered history, oldest first.
 * @param lastReadSeq - The reader's `(member, room)` cursor, or null when they
 *   are not a member of this room.
 */
export function lastSeenEntryId(
  entries: readonly RoomEntry[],
  lastReadSeq: number | null
): string | null {
  if (lastReadSeq === null || lastReadSeq <= 0) return null;
  // Nothing is unread — the newest entry is at or below the cursor.
  const newest = entries[entries.length - 1];
  if (!newest || newest.seq <= lastReadSeq) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.seq <= lastReadSeq) return entries[i]!.id;
  }
  return null;
}
