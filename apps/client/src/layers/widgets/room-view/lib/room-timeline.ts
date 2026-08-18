/**
 * Turning a room's log into the rows the message list renders.
 *
 * @module widgets/room-view/lib/room-timeline
 */
import type { AuthorOrigin, AuthorRef, RoomEntry, RoomRosterEntry } from '@/layers/entities/room';
import { threadRootIdOf } from '@/layers/entities/room';
import { resolveIdentityFace, type IdentityFaceOverride } from '@/layers/shared/lib';
import type { MessageAuthor } from '@/layers/shared/model';

/**
 * A roster member's `AuthorRef` paired back up with its `origin` — the two
 * live as sibling fields on `RoomRosterEntry` rather than one holding the
 * other, so a lookup keyed by author id has to carry both or lose one.
 *
 * Exported for `RoomMessage`, which reads the same map to resolve a
 * `<mention>` tag against the roster — a mention pill draws from exactly the
 * fields this type carries (kind, name, color, emoji, origin, and the
 * `agentRef` its hover card looks the agent's runtime up by).
 */
export type RosterAuthor = AuthorRef & { origin: AuthorOrigin };

/**
 * Build the roster lookup the list renders authors from.
 *
 * A room entry stores an opaque `authorId` and nothing else (ADR 260726-170126),
 * so the roster is the only place a name — or an emoji, a color, an origin —
 * comes from; the client never derives an author from the session, the
 * selected agent, or the message's own shape.
 *
 * @param members - The room's roster.
 */
export function authorsById(members: readonly RoomRosterEntry[]): Map<string, RosterAuthor> {
  return new Map(
    members.map((member) => [member.author.id, { ...member.author, origin: member.origin }])
  );
}

/**
 * The view model the shared message primitives render an author from.
 *
 * **The face comes off the one ladder** (`resolveIdentityFace`), the same one
 * the masthead's roster and the member sheet's rows climb: an agent's own
 * manifest first when the caller could reach the fleet, then the render cache
 * the roster carries (`AuthorRef`), then a colour hashed from the opaque author
 * id. This used to be hand-rolled here — the emoji taken straight off the cache
 * with no rung above it, the colour hashed locally — which is how the loudest
 * surface in a room ended up the last one still drawing an agent as a letter
 * while the sidebar drew its face.
 *
 * **The fleet is reached by `agentRef`, never by the author id.** An agent's
 * author row and its manifest are different ULIDs, so hashing the id this
 * resolver holds would paint a confident face matching nothing else on screen —
 * which is exactly why the ladder's own last rung stops at a letter and the
 * emoji can only ever arrive through `facesByRef`.
 *
 * `isExternal` marks a roster member bridged in from another platform, which is
 * what lets a caller draw them apart from someone local without this resolver
 * knowing anything about how that distinction is drawn.
 *
 * @param authorId - The entry's stored author id.
 * @param authors - The room's roster, keyed by author id.
 * @param facesByRef - The fleet's faces keyed by `agentRef`, when the caller
 *   could read the fleet. Omitted or empty simply leaves the ladder's lower
 *   rungs to answer.
 */
export function toMessageAuthor(
  authorId: string,
  authors: ReadonlyMap<string, RosterAuthor>,
  facesByRef?: ReadonlyMap<string, IdentityFaceOverride>
): MessageAuthor {
  const author = authors.get(authorId);
  const face = resolveIdentityFace({
    record: {
      // A removed member's old posts still render: the roster no longer holds
      // them, and saying so is more honest than dropping what they said.
      kind: author?.kind ?? 'system',
      id: authorId,
      displayName: author?.displayName ?? 'Unknown',
      emoji: author?.emoji,
      color: author?.color,
      imageUrl: author?.imageUrl,
    },
    override: author?.agentRef === undefined ? null : facesByRef?.get(author.agentRef),
  });
  return {
    kind: face.kind,
    id: authorId,
    displayName: author?.displayName ?? 'Unknown',
    emoji: face.emoji,
    imageUrl: face.imageUrl,
    color: face.color,
    isExternal: typeof author?.origin === 'object' && author?.origin !== null,
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

/**
 * The DOM id of a message row in the ROOM's own timeline.
 *
 * The fallback the reply row cannot be: a thread opened from the capsule's
 * "Reply in thread" has no replies yet, so there is no "↳ N replies" row under
 * its root and {@link threadRowId} points at nothing. The message itself is
 * always there, and it is where a reader was standing when they opened the
 * thread.
 *
 * **Only the timeline's copy carries it.** A thread's root is on screen twice
 * on a wide screen — in the room's flow and at the head of the panel — and two
 * elements answering to one id is a lookup whose answer depends on document
 * order.
 *
 * @param entryId - The entry the row draws.
 */
export function entryRowId(entryId: string): string {
  return `room-entry-${entryId}`;
}
