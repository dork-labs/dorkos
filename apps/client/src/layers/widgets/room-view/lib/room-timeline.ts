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

/** Where the "New messages" rule goes, if anywhere. */
export interface UnreadPlacement {
  /** Id of the newest entry already read; the rule goes just after it. */
  lastSeenId: string | null;
  /** Everything on screen is unread, so the rule goes above the first entry. */
  fromStart: boolean;
}

/** No rule at all: caught up, or not a member. */
const NO_RULE: UnreadPlacement = { lastSeenId: null, fromStart: false };

/**
 * Translate a membership's read cursor into a rule position.
 *
 * The rule is placed relative to an entry id while a membership stores a `seq`,
 * so this is the translation between the two — and it has to distinguish three
 * things the old `seq → id` shape collapsed into one `null`: not a member (no
 * rule), caught up (no rule), and a member who has read nothing (rule at the
 * top, because the sidebar is badging that room and the two must agree).
 *
 * @param entries - The rendered history, oldest first.
 * @param lastReadSeq - The reader's `(member, room)` cursor, or null when they
 *   are not a member of this room.
 */
export function unreadPlacement(
  entries: readonly RoomEntry[],
  lastReadSeq: number | null
): UnreadPlacement {
  // Not a member: no cursor, so no rule. `hasUnread` badges nothing here either,
  // so the two agree.
  if (lastReadSeq === null) return NO_RULE;

  const newest = entries[entries.length - 1];
  // Nothing to read, or nothing unread — the newest entry is at or below the cursor.
  if (!newest || newest.seq <= lastReadSeq) return NO_RULE;

  // A member who has read nothing has a real cursor sitting at zero, and every
  // entry is above it. The rule belongs above the first one — not absent, which
  // is what the sidebar badge would be contradicting.
  if (lastReadSeq <= 0) return { lastSeenId: null, fromStart: true };

  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.seq <= lastReadSeq) return { lastSeenId: entries[i]!.id, fromStart: false };
  }
  // The cursor is above every entry this page holds (history was paged past it),
  // so everything on screen is unread.
  return { lastSeenId: null, fromStart: true };
}
