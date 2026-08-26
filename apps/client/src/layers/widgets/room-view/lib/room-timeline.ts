/**
 * Turning a room's log into the rows the message list renders.
 *
 * @module widgets/room-view/lib/room-timeline
 */
import type { RoomMoment } from '@dorkos/shared/room-schemas';
import type { AuthorOrigin, AuthorRef, RoomEntry, RoomRosterEntry } from '@/layers/entities/room';
import { threadRootIdOf } from '@/layers/entities/room';
import type { ConversationRow } from '@/layers/features/conversation';
import { resolveIdentityFace, type IdentityFaceOverride } from '@/layers/shared/lib';
import type { MessageAuthor } from '@/layers/shared/model';

/**
 * Which kind of {@link ConversationRow} one room entry becomes, and what the
 * row it becomes needs from the entry.
 *
 * A discriminated result rather than a bare string, because the caller that
 * asks is the caller that renders: `moment` carries the moment it found, so
 * `RoomMessage` narrows to it instead of reading `body.moment` a second time
 * and asserting it is there.
 *
 * The three names are pinned to the shared union by `Extract`, so a kind
 * renamed or dropped in `features/conversation` fails to compile here rather
 * than leaving a room drawing a row nothing else in the app has a name for.
 */
export type RoomRowKind =
  | { kind: Extract<ConversationRow['kind'], 'notice'> }
  | { kind: Extract<ConversationRow['kind'], 'moment'>; moment: RoomMoment }
  | { kind: Extract<ConversationRow['kind'], 'message'> };

/**
 * Read what kind of line an entry is off the entry itself.
 *
 * **Only `kind` and `body` decide it, and they are not the same tell.** A
 * `notice` is the room speaking about itself, and the server says so on the
 * entry's `kind`. A MOMENT is an ordinary post — same log, same seq, same feed
 * — whose `body.moment` says what it marks, which is why `kind` cannot tell it
 * apart and a client reading only `kind` would draw a milestone as somebody
 * talking.
 *
 * Extracted from `RoomMessage`'s own branches so the rule has one statement and
 * `conversation-row-kinds.test.ts` can put every kind of entry through it. Two
 * copies of "what makes a moment a moment" is precisely the drift that test
 * exists to catch.
 *
 * @param entry - One entry from the room's log.
 * @returns Which row it draws as, and the moment when it draws as one.
 */
export function roomEntryRowKind(entry: RoomEntry): RoomRowKind {
  if (entry.kind === 'notice') return { kind: 'notice' };
  const moment = entry.body.moment;
  if (moment) return { kind: 'moment', moment };
  return { kind: 'message' };
}

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
 * The {@link ConversationRow} key of the "↳ N replies" row under one thread's
 * head.
 *
 * Distinct from {@link threadRowId}, which is the same row's DOM id — see
 * {@link FlowRowRef}. Named here so the flow that BUILDS the row and the
 * landing that has to FIND it cannot spell it two ways.
 *
 * @param rootEntryId - The entry heading the thread the row counts.
 */
export function threadRowKey(rootEntryId: string): string {
  return `thread-${rootEntryId}`;
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
 * The DOM id of a message row inside the open THREAD PANEL.
 *
 * A namespace of its own, and it has to be one: a thread's root is drawn twice
 * on a wide screen — once in the room's flow and once at the head of the panel —
 * so reusing {@link entryRowId} would put the same id on two elements and
 * `getElementById` would answer with whichever came first. The panel's lane
 * resolves its own claims through this; the room's lane never does.
 */
export function threadPanelRowId(entryId: string): string {
  return `thread-panel-entry-${entryId}`;
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

/**
 * The row of the ROOM's own flow that takes a reader to one entry — both names
 * it answers to.
 *
 * **Two ids for one row, because the timeline is addressed both ways and they
 * are not interchangeable.** `rowId` is the {@link ConversationRow} key, which
 * is what the landing matches on; `domId` is the element's `id`, which is what
 * `scrollToRow` and `getElementById` take. Handing one where the other is
 * wanted fails silently — the room simply opens at its newest message — so they
 * are returned together rather than derived twice, once correctly.
 */
export interface FlowRowRef {
  /** The `ConversationRow.id` the flow draws this entry under. */
  rowId: string;
  /** The DOM `id` that row's element carries. */
  domId: string;
}

/**
 * Which row of the ROOM's own flow takes a reader to one entry, or `null` when
 * the room draws no row for it at all.
 *
 * **Quotable is not the same as rendered**, and this function is that
 * distinction written down once. A room's flow draws top-level entries only
 * ({@link groupByThread} keeps replies out of it), so an entry the caller can
 * name may have no row of its own anywhere in the room column. Three cases:
 *
 * - **A top-level entry** is its own row — {@link entryRowId}.
 * - **A reply the flow hangs under a thread** is drawn in the panel rather than
 *   the flow, so the truest place the room can take you is the "↳ N replies"
 *   row of that thread — {@link threadRowId}.
 * - **An orphaned reply** — one whose thread head is not in this page, or is
 *   itself a reply — IS drawn in the flow: {@link groupByThread} pushes exactly
 *   those into `topLevel` rather than dropping them, so it has a row of its own.
 * - **An entry not in the loaded history** has no row anywhere, and gets `null`.
 *
 * The three branches are {@link groupByThread}'s own placement rule read back
 * out, and they have to stay that: a row id derived from a different rule is a
 * link into an element the feed never drew.
 *
 * Both callers must answer this identically: the live peek's "replying to …"
 * link and a search hit's landing are the same question about the same feed,
 * and two versions of it is exactly the drift that makes one of them a link
 * into nowhere.
 *
 * @param entries - The room's loaded history, whole (replies included).
 * @param entryId - The entry to reach.
 */
export function flowRowForEntry(entries: readonly RoomEntry[], entryId: string): FlowRowRef | null {
  const entry = entries.find((candidate) => candidate.id === entryId);
  if (entry === undefined) return null;
  // `?? null` because `threadRootIdOf` reads two OPTIONAL fields and can answer
  // `undefined` in spite of its `string | null` signature.
  const rootId = threadRootIdOf(entry) ?? null;
  const ownRow = { rowId: entryId, domId: entryRowId(entryId) };
  if (rootId === null) return ownRow;
  const root = entries.find((candidate) => candidate.id === rootId);
  const rootLeadsAThread = root !== undefined && (threadRootIdOf(root) ?? null) === null;
  return rootLeadsAThread ? { rowId: threadRowKey(rootId), domId: threadRowId(rootId) } : ownRow;
}

/**
 * How much of the answered message the reference chip quotes back.
 *
 * Short on purpose: the chip is a pointer, not a quote. Longer than this and it
 * competes with the answer it sits above.
 */
const ANSWERS_EXCERPT_MAX = 48;

/**
 * What the reference chip above an agent's post should say, or `null` when it
 * should not be drawn at all.
 *
 * **A room posts in arrival order, whatever a message is responding to**, so an
 * answer is not always next to its question — and a message that waited behind
 * a turn in another conversation is answered out of order routinely rather than
 * rarely. The server records which entry every agent-authored post answers
 * (`answersEntryId`); this decides whether a reader needs telling.
 *
 * **It is suppressed when the answered entry is the one directly above.** In
 * that case the link is obvious, and a chip on every reply in the product would
 * be furniture rather than information — which is exactly what would happen,
 * because the pointer is set unconditionally.
 *
 * @param entry - The post that may be answering something.
 * @param previous - The entry rendered directly above it, or `undefined` at the
 *   top of the rendered feed.
 * @param find - How to look an entry up by id in the loaded history.
 * @returns The excerpt to quote, or `null` when there is nothing to say —
 *   the post answers nothing, answers the row above, or answers a message this
 *   client has not loaded and therefore cannot quote.
 */
export function answeredReference(
  entry: RoomEntry,
  previous: RoomEntry | undefined,
  find: (entryId: string) => RoomEntry | undefined
): { entryId: string; excerpt: string } | null {
  const answers = entry.body.answersEntryId;
  if (answers === undefined || answers === entry.id) return null;
  if (previous !== undefined && previous.id === answers) return null;
  const answered = find(answers);
  if (answered === undefined) return null;
  const text = answered.body.text.replace(/\s+/gu, ' ').trim();
  if (text.length === 0) return null;
  return {
    entryId: answers,
    excerpt:
      text.length > ANSWERS_EXCERPT_MAX ? `${text.slice(0, ANSWERS_EXCERPT_MAX).trimEnd()}…` : text,
  };
}
