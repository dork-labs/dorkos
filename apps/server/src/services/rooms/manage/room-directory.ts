/**
 * The lists a person's cockpit draws — their rooms, their threads, one room —
 * and where each reader has got to in them.
 *
 * **Two cursors live behind one number, and which one answers depends on who
 * is asking** (team-room-home spec §D4). A person's place in a room is a row
 * in `read_cursors`, shared with their sessions and their inbox so one person
 * reading on two devices is one fact; an agent's is
 * `room_members.last_read_seq` — what the ambient participation loop has SHOWN
 * it. They are different questions about the same-looking number, and nothing
 * here reads one to answer the other.
 *
 * @module server/services/rooms/manage/room-directory
 */
import type {
  RoomKind,
  RoomMember,
  RoomSessionBinding,
  RoomSummary,
  RoomWithRoster,
  ThreadSummary,
} from '@dorkos/shared/room-schemas';
import { THREAD_PREVIEW_MAX_CHARS } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import type { ReadCursorService } from '../../core/read-cursor-service.js';
import { markRoomRead as markRoomNotificationsRead } from '../../notifications/notification-service.js';
import type { BridgeStore } from '../../relay/chat-bridge/bridge-store.js';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomCore } from '../service/room-core.js';
import { RoomError } from '../room-errors.js';
import { bridgeInfo, type RoomProjection } from '../service/room-projection.js';
import type { RoomRoster } from '../room-roster.js';
import { parseEntryBody } from '../room-rows.js';
import type { RoomStore } from '../room-store.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';
import type { RoomVisibility } from '../service/room-visibility.js';

/** Every read that answers "what rooms are there, and where am I in them". */
export class RoomDirectory {
  private readonly store: RoomStore;
  private readonly authors: AuthorRegistry;
  private readonly roster: RoomRoster;
  private readonly bridges: BridgeStore;
  private readonly triggers: RoomTriggerDispatcher;
  /** Where the PEOPLE in a room have read up to. Never an agent's cursor. */
  private readonly readCursors: ReadCursorService;
  /** Whether an author is the install's owner. Read per check, never captured. */
  private readonly isOwnerAuthor: (authorId: string) => boolean;

  constructor(
    core: RoomCore,
    private readonly visibility: RoomVisibility,
    private readonly projection: RoomProjection
  ) {
    this.store = core.store;
    this.authors = core.authors;
    this.roster = core.roster;
    this.bridges = core.bridges;
    this.triggers = core.triggers;
    this.readCursors = core.readCursors;
    this.isOwnerAuthor = core.isOwnerAuthor;
  }

  /**
   * The rooms this viewer may list, each with their unread count.
   *
   * Two different answers, on purpose:
   *
   * - **The owner sees every room.** This is their machine; hiding rooms from
   *   the person running it would be absurd. "Membership-scoped" in
   *   ADR 260726-170125 describes the model, not an authorization rule against
   *   its owner. Owner-identity, not author kind: the same table will hold
   *   other humans once a community is joined (ADR 260727-184933 D6), and none
   *   of them is the operator of this machine.
   * - **Everybody else sees only rooms they belong to.** That boundary is real:
   *   an agent enumerating the operator's DMs with other agents is a leak, and
   *   it costs one join to prevent.
   *
   * `unreadCount` is `null` for a room the viewer is not a member of. Unread is
   * a property of a read cursor, and a non-member has none — reporting the
   * room's whole entry count instead would render every room the operator has
   * not joined as an alarming unread badge.
   *
   * **Which cursor the count is measured against depends on who is asking**
   * (team-room-home spec §D4): a person's is in `read_cursors`, an agent's is
   * the membership column. Both are read in bulk — one query for the
   * memberships, one for the person's cursors — so a sidebar holding fifty rooms
   * still costs two.
   *
   * `viewerHasPosted` says whether this viewer has ever written in the room
   * themselves — one query for the whole list ({@link RoomStore.roomsPostedInBy}),
   * and the fact that tells a room somebody has merely joined from one they have
   * taken part in.
   *
   * `participants` is carried for direct messages and is `null` for everything
   * else, per {@link RoomSummary}. A DM's mark is whoever it is with, so the
   * sidebar cannot draw one without the roster; resolving it here is two
   * queries for the whole list, where asking per room was one request each.
   *
   * **`bridge` is resolved here too, and it is one more query for the whole
   * list** ({@link BridgeStore.findBridgesByRooms}). It used to be left absent,
   * on the grounds that a list draws no bridge badge — but the sidebar now has
   * to tell a direct message somebody made by hand from one a bridged private
   * chat projects, and only this field says which (`sidebar-simplification` D2).
   * So `null` on a listed room now means "not bridged" rather than "not carried",
   * which is the honest answer and the one every other reader already assumed.
   *
   * @param viewerAuthorId - Whose rooms to list, and whose unread counts to compute.
   * @param filter.kind - Restrict to one room kind.
   * @param filter.includeArchived - Include archived rooms.
   */
  listRooms(
    viewerAuthorId: string,
    filter: { kind?: RoomKind; includeArchived?: boolean } = {}
  ): RoomSummary[] {
    const cursors = this.cursorsFor(viewerAuthorId);
    const visible = this.visibility.seesEveryRoom(viewerAuthorId)
      ? this.store.listRooms(filter)
      : this.store.listRoomsForMember(viewerAuthorId, filter);
    // Only the DMs are asked about, so a room of any other kind is simply
    // absent from the map and reads as `null` below — "not carried" rather
    // than "empty", which is the distinction the schema promises.
    const participants = this.roster.authorsIn(
      visible.filter((room) => room.kind === 'dm').map((room) => room.id)
    );
    // One query for the whole list, asked once here rather than per room — see
    // `RoomStore.roomsPostedInBy`. A room absent from the set is one this viewer
    // has never written in, which is a real `false` and not a missing answer:
    // the log is right here and it has been read.
    const postedIn = this.store.roomsPostedInBy(viewerAuthorId);
    const bridges = this.bridges.findBridgesByRooms(visible.map((room) => room.id));
    return visible.map((room) => {
      const cursor = cursors.get(room.id);
      return {
        ...room,
        unreadCount: cursor === undefined ? null : this.store.countUnread(room.id, cursor),
        participants: participants.get(room.id) ?? null,
        bridge: bridgeInfo(bridges.get(room.id)),
        viewerHasPosted: postedIn.has(room.id),
        // Always a number, `0` included. A dot that only appears once the next
        // republish tick lands would leave a freshly loaded cockpit blind for up
        // to ten seconds about work already running — and an ABSENT count would
        // be indistinguishable from "this server does not know", which is the
        // one thing it is never true of: the claim map is right here.
        working: this.triggers.workingCount(room.id),
      };
    });
  }

  /**
   * Every room this member belongs to, with the cursor that answers for them —
   * the bulk form of {@link RoomService.readCursorFor}.
   *
   * A room the member belongs to is always a key, cursor or no cursor, because
   * the caller distinguishes "not a member" (no unread count exists) from "has
   * read nothing" (everything is unread) and only membership can say which.
   *
   * @param authorId - The member.
   * @returns Room id to cursor, for every room they are in.
   */
  cursorsFor(authorId: string): Map<string, number> {
    const memberships = this.store.listMembershipsFor(authorId);
    if (this.authors.getById(authorId)?.kind !== 'human') {
      return new Map(memberships.map((m) => [m.roomId, m.lastReadSeq]));
    }
    const read = this.readCursors.listForUser(authorId, 'room');
    return new Map(memberships.map((m) => [m.roomId, read.get(m.roomId) ?? 0]));
  }

  /**
   * Every thread this reader takes part in, across every room, newest first.
   *
   * The sidebar's Threads section (spec `room-messaging-design` §3), and the
   * one place a thread is reachable without first knowing which room it is in.
   *
   * **Participation is what selects a thread**: the reader wrote the root, or
   * wrote a reply. There is no follow list — that was weighed as real server
   * lift and deferred until threads get noisy enough to need the escape valve —
   * so nothing here is stored and nothing has to be kept in step.
   *
   * **The visibility boundary is the ROOM's roster, as it stands now.** A thread
   * is a relation between entries in one room's log (ADR 260728-022013), so
   * there is no second boundary to invent: the store joins on membership exactly
   * as `listRooms` does. Participation implies membership at WRITE time and
   * cannot be trusted at READ time — somebody removed from a room would
   * otherwise keep a live view of a conversation they were taken out of, on
   * rows that `getRoom` refuses to open. The owner's see-every-room privilege
   * buys nothing extra here: a thread you never spoke in is not yours to see in
   * this list.
   *
   * **Unread is measured against the cursor that answers for this reader** — a
   * person's own, an agent's membership column — which is why the store is told
   * which one to join (team-room-home spec §D4). A thread's count is the room's
   * cursor narrowed to the thread, so it is the same number the room badge is
   * measured from and it clears when the room does.
   *
   * @param viewerAuthorId - Whose threads to list.
   * @param limit - Most threads to return.
   */
  listThreads(viewerAuthorId: string, limit: number): ThreadSummary[] {
    // Anyone this install cannot name is measured against the membership
    // column: it is the one cursor that certainly exists for a member, and a
    // caller with no author row has no rows to list anyway.
    const cursor = this.authors.getById(viewerAuthorId)?.kind === 'human' ? 'user' : 'membership';
    return this.store.listThreadsForMember(viewerAuthorId, limit, cursor).map((row) => ({
      roomId: row.roomId,
      roomKind: row.roomKind as RoomKind,
      roomSlug: row.roomSlug,
      roomTitle: row.roomTitle,
      rootEntryId: row.rootEntryId,
      rootAuthorId: row.rootAuthorId,
      // Truncated here rather than in the row: a root can be as long as anyone
      // cared to type, and a sidebar draws one line of it. Cut without an
      // ellipsis — the row clamps its own text, and a server-side "…" inside a
      // box that also clamps gives you two of them.
      rootPreview: parseEntryBody(row.rootBody).text.slice(0, THREAD_PREVIEW_MAX_CHARS),
      replyCount: row.replyCount,
      unreadCount: row.unreadCount,
      lastActivityAt: row.lastActivityAt,
    }));
  }

  /**
   * One room with its roster, as this viewer may see it.
   *
   * @param roomId - The room id.
   * @param viewerAuthorId - The caller. The owner sees any room; everybody else
   *   only the ones they belong to.
   * @returns The room, or `null` when it does not exist or the viewer may not see it.
   */
  getRoom(roomId: string, viewerAuthorId: string): RoomWithRoster | null {
    const room = this.store.getRoom(roomId);
    if (!room || !this.visibility.canSee(roomId, viewerAuthorId)) return null;
    return this.projection.withRoster(room, viewerAuthorId);
  }

  /**
   * Which session each of this room's agents answers in.
   *
   * **Ids only, and that is the whole of it** — no session content, no working
   * directory, no status. It exists so the room's live lane can offer "Open its
   * session", which is a link; anything more would be a second way to read a
   * session, reached through a room and reviewed as neither.
   *
   * The room is resolved through {@link RoomVisibility.requireVisibleRoom}, so a
   * room the caller cannot see throws `ROOM_NOT_FOUND` exactly as reading it
   * does. **Whether the caller may ask at all is the ROUTE's question**, not
   * this method's: `specs/room-presence` §15 deferred the mapping until there
   * was an authorization design for it, and the design is "people only", which
   * is a statement about HTTP callers rather than about room state.
   *
   * @param roomId - The room to list bindings for.
   * @param viewerAuthorId - The caller, for the visibility check.
   * @returns One binding per agent that has answered here, room-scoped.
   */
  listRoomSessions(roomId: string, viewerAuthorId: string): RoomSessionBinding[] {
    this.visibility.requireVisibleRoom(roomId, viewerAuthorId);
    return this.store.sessionLedger
      .list()
      .filter((binding) => binding.roomId === roomId)
      .map(({ authorId, sessionId }) => ({ authorId, sessionId }));
  }

  /**
   * Where a session is answering, as a saved note should record it.
   *
   * The provenance suffix on an agent's memory has to be something the agent
   * cannot choose (agent-memory spec D4 / review M4), so it is derived from the
   * session rather than passed in — and the session id is not a value the model
   * supplies either. `#slug` for a channel; `null` for a direct message, an
   * unbound session, or a room that has since gone, all of which the note
   * records honestly as a direct chat.
   *
   * **Deliberately unscoped by viewer**, unlike every listing on this service.
   * It answers about the CALLER'S OWN session, and returns a label the caller is
   * already looking at — the room context block names the same room by the same
   * name on every turn — so there is nothing here a membership check would
   * protect.
   *
   * @param sessionId - Either of the session's ids; the ledger follows a rekey.
   */
  roomLabelForSession(sessionId: string): string | null {
    const binding = this.store.sessionLedger.bindingForSession(sessionId);
    if (!binding) return null;
    const room = this.store.getRoom(binding.roomId);
    if (!room || room.kind !== 'channel') return null;
    return room.slug ? `#${room.slug}` : room.title;
  }

  /**
   * Advance a member's read cursor. Monotonic — a lower value is ignored.
   *
   * **Two cursors live behind this one method, and which one moves is decided by
   * WHO is reading** (team-room-home spec §D4). A person's place in a room is a
   * row in `read_cursors`, the same store their agent sessions and their inbox
   * use, so one person reading on two devices is one fact. An agent's is
   * `room_members.last_read_seq` — what the ambient participation loop has SHOWN
   * it (room-participation spec §8.3) — and it stays exactly where it was. They
   * are different questions about the same-looking number, and nothing here
   * reads one to answer the other.
   *
   * A person's cursor that actually moves is announced as `read_cursor` on the
   * global fan-out, so a second browser or device clears the badge on push
   * instead of on its next poll. The event carries the count the room list would
   * now draw, because a reader holding only the new cursor cannot work it out: a
   * room summary has no seq to measure against, so it could only guess zero —
   * and zero is wrong the moment something arrived after the other device
   * stopped reading.
   *
   * **A write that changes nothing says nothing.** Opening a room already read
   * is the common case, and an event per no-op would put the loudest name on the
   * stream on a fact nobody could act on.
   *
   * **An agent's cursor is announced not at all.** RP3 advances it once per
   * agent per turn through {@link RoomStore.setReadCursor} directly, which would
   * make it the most frequent event on the global stream — and nothing in the
   * cockpit draws it. `read_cursor` is the people's stream by contract, which is
   * also why `PUT /api/read-cursors/:kind/:id` refuses an agent outright.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   * @param lastReadSeq - The seq they have read up to.
   * @returns The membership, reporting the cursor that answers for this
   *   member — see {@link RoomRoster.list}.
   */
  setReadCursor(roomId: string, authorId: string, lastReadSeq: number): RoomMember {
    this.visibility.requireVisibleRoom(roomId, authorId);
    // A membership references its author by foreign key, so a member without an
    // author row cannot happen. Resolved BEFORE the write because it is what
    // decides which cursor is being written, not a decoration on the
    // announcement: with no author row there is nobody to call a person, and the
    // membership column is the safe answer — it is where this cursor lived
    // before the split, and it is what RP3 would read back.
    const author = this.authors.getById(authorId);
    if (!author) {
      logger.warn('[rooms] a read cursor moved for a member with no author row', {
        roomId,
        authorId,
      });
      return this.roster.setReadCursor(roomId, authorId, lastReadSeq);
    }
    if (author.kind !== 'human') return this.roster.setReadCursor(roomId, authorId, lastReadSeq);

    // Membership is what makes a cursor meaningful, and the check is the same
    // one the agent path gets from `RoomRoster.setReadCursor` — stated here
    // because the person's cursor is not stored on the membership row and so
    // cannot be refused by its absence.
    const member = this.store.getMember(roomId, authorId);
    if (!member) throw new RoomError('MEMBER_NOT_FOUND', 'Not a member of this room');

    // The broadcast, the monotonic guard and the "did it move" comparison all
    // live in `ReadCursorService.advance` — one write path for every kind of
    // thread a person reads, so a room cannot drift from a session.
    const cursor = this.readCursors.advance(authorId, 'room', roomId, lastReadSeq, {
      unreadCount: (seq) => this.store.countUnread(roomId, seq),
    });
    // Read-cursor auto-read (spec `notification-system` task T11): reading a
    // room reads its inbox rows too, so an unread bell count and an unread room
    // never disagree. Scoped to the OPERATOR's own cursor — notifications are
    // single-operator by design (`notifications` table's own doc comment), and
    // a second human account's cursor moving is not a fact about what the
    // operator has seen. Never lets a notification-store problem fail a read
    // cursor that already moved.
    if (this.isOwnerAuthor(authorId)) {
      try {
        markRoomNotificationsRead(roomId, cursor.lastReadSeq);
      } catch (err) {
        logger.warn("[rooms] could not mark this room's notifications read", {
          roomId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { ...member, lastReadSeq: cursor.lastReadSeq };
  }

  /**
   * Where one member has read up to in one room: a person's own cursor, an
   * agent's membership column.
   *
   * The read half of {@link RoomService.setReadCursor}, and the one place the
   * "which cursor answers for whom" rule is stated for a single member — the
   * list paths resolve it in bulk instead, for the query count.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   * @returns The cursor, or `null` when this author is not a member.
   */
  readCursorFor(roomId: string, authorId: string): number | null {
    const member = this.store.getMember(roomId, authorId);
    if (!member) return null;
    if (this.authors.getById(authorId)?.kind !== 'human') return member.lastReadSeq;
    return this.readCursors.get(authorId, 'room', roomId)?.lastReadSeq ?? 0;
  }
}
