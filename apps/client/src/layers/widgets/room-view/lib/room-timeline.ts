/**
 * Turning a room's log into the rows the message list renders.
 *
 * @module widgets/room-view/lib/room-timeline
 */
import type { AuthorRef, RoomEntry, RoomRosterEntry } from '@/layers/entities/room';
import { authorColor, threadRootIdOf } from '@/layers/entities/room';
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

/** A room's log split into the rows the timeline draws and what hangs off them. */
export interface ThreadedEntries {
  /** The room's own flow, oldest first: every entry that answers nothing. */
  topLevel: RoomEntry[];
  /** Replies keyed by the entry at the head of their thread, each oldest first. */
  repliesByRoot: Map<string, RoomEntry[]>;
  /**
   * Ids of entries in {@link ThreadedEntries.topLevel} that ARE replies but
   * could not be placed, because the entry heading their thread is not in this
   * page. They render in the flow, and say so.
   */
  orphaned: Set<string>;
}

/**
 * Split a room's log into its own flow and the replies hanging off it.
 *
 * Placement reads {@link threadRootIdOf}, which is the SCOPE
 * (`threadRootEntryId`) before the RELATION (`parentEntryId`); PR 1 added both
 * deliberately. Grouping on the scope is what keeps this display rule
 * independent of the server's depth policy: `threadPointers` refuses a
 * reply-to-a-reply today, but its own doc says opening a second level is one
 * `if` and that "nothing else in the schema has an opinion". Grouping on the
 * relation would have quietly made that false — a depth-two reply would key
 * under another reply, and nothing ever reads that key back out.
 *
 * A thread is a relation between entries, not a room (ADR 260728-022013): a
 * reply is an ordinary entry in this room carrying a pointer at the entry that
 * heads its thread, so the timeline's default flow is every entry with no such
 * pointer, and a reply renders under the entry it belongs to.
 *
 * **Nothing may be lost, and that is structural here rather than hoped for.**
 * The first pass collects the ids that will actually render in the flow; the
 * second only groups a reply under one of those. Every other case — a root
 * paged out of this window, a pointer at another reply, a pointer at itself —
 * falls into the flow and is marked {@link ThreadedEntries.orphaned}, so it is
 * shown in the wrong place rather than written into a map nobody reads. A room
 * is never allowed to drop a line, least of all one it has already marked read.
 *
 * **This is the ONLY place a thread reply is filtered out of anything, and that
 * is a decision, not an accident.** The array this receives is the same array
 * `useMarkRoomRead` is handed, and it must stay whole all the way there:
 *
 * - Filtering inside `listEntries` would strand the sidebar's "Mark as read",
 *   which reads `{ limit: 1 }` and would stop at the newest TOP-LEVEL entry —
 *   leaving a badge on a room the reader has open with nothing in the product
 *   able to move it (`use-mark-room-read.ts` says exactly why that is
 *   forbidden). It would also disagree with the resume path: `snapshot()` takes
 *   its cursor from the last visible entry and the live stream dedupes against
 *   it, while `entriesAfter` is unfiltered — so a reply would be missing on a
 *   cold connect and appear on reconnect.
 * - Filtering `entriesQuery.data` before `useMarkRoomRead` would do the same
 *   thing one layer up, freezing the cursor below any reply that arrives after
 *   the newest top-level entry.
 *
 * **The cost we accept, stated rather than hidden: opening a room marks its
 * threads read.** That is a real loss against Slack. With one `(member, room)`
 * cursor, "a badge computed on what you have read" and "a badge that survives
 * opening the room" cannot both be true; this picks the first and stays
 * consistent everywhere. Surfacing thread unreads separately stays available
 * later as a purely additive change. It is also why replies RENDER here rather
 * than collapsing into a bare count: marking something read that the reader was
 * never shown would be the dishonest half of the trade.
 *
 * @param entries - The room's whole history, oldest first.
 */
export function groupByThread(entries: readonly RoomEntry[]): ThreadedEntries {
  // Pass 1: the entries that will render in the room's own flow. A reply may
  // hang off one of these and nothing else — a key that is not in here is a key
  // no render pass ever reads.
  const flowIds = new Set<string>();
  for (const entry of entries) {
    if (threadRootIdOf(entry) === null) flowIds.add(entry.id);
  }

  const topLevel: RoomEntry[] = [];
  const repliesByRoot = new Map<string, RoomEntry[]>();
  const orphaned = new Set<string>();

  // Pass 2: place each entry, defaulting to the flow whenever it cannot be hung.
  for (const entry of entries) {
    const rootId = threadRootIdOf(entry);
    if (rootId === null) {
      topLevel.push(entry);
      continue;
    }
    if (!flowIds.has(rootId)) {
      topLevel.push(entry);
      orphaned.add(entry.id);
      continue;
    }
    const siblings = repliesByRoot.get(rootId);
    if (siblings) siblings.push(entry);
    else repliesByRoot.set(rootId, [entry]);
  }

  return { topLevel, repliesByRoot, orphaned };
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
 * Fed the room's own flow rather than its whole log, so the rule lands between
 * two rows the reader can actually see. A thread reply is above the cursor and
 * off the flow, which is the same thing {@link groupByThread} accepts when it
 * says opening a room marks its threads read.
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

/**
 * The DOM id of the reply row that opens one thread.
 *
 * A real id rather than a ref passed around, because the two ends are far
 * apart and only one of them is ever mounted at a time: on a phone the thread
 * panel UNMOUNTS the room, so a ref captured when the row was clicked points at
 * a node that no longer exists by the time the panel closes. Looking the row up
 * after the close has been painted is the only version that works on both
 * shapes, and it is what puts a keyboard reader back on the row they opened
 * rather than on `document.body`.
 *
 * @param rootEntryId - The entry heading the thread the row counts.
 */
export function threadRowId(rootEntryId: string): string {
  return `thread-row-${rootEntryId}`;
}
