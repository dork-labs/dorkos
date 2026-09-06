/**
 * Searching what was said — in one room, across the rooms one member belongs
 * to, and the scope the whole-install search runs under.
 *
 * **A caller of the message index, never a scan of its own.** There is exactly
 * one search path over these rows; a second one written here would answer the
 * same question differently — stems against substrings — and the difference
 * would be invisible until somebody compared them. What this module owns is
 * the ACCESS half: it resolves who may read what, hands the index coordinates
 * to rank, and resolves the hits back through the room's own read path. The
 * index is never asked to work out who anybody is.
 *
 * @module server/services/rooms/messages/room-search
 */
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import type { RoomCore } from '../service/room-core.js';
import { memberRoomName, type MemberRoomMatch } from '../manage/room-member-directory.js';
import type { RoomProjection } from '../service/room-projection.js';
import { HISTORY_PAGE_MAX, clampHistoryLimit } from './room-reads.js';
import type { RoomMessageFinder, RoomSearchScope } from '../service/room-service-deps.js';
import type { RoomStore } from '../room-store.js';
import type { RoomVisibility } from '../service/room-visibility.js';

/**
 * The key one cross-room match is ranked under: room first, then position.
 *
 * Joined on a NUL, written as an escape rather than pasted in as a byte, exactly
 * as `search-service.ts` composes its container key and for the same reason — a
 * room id is opaque and NUL is the one character it cannot hold. A bare `seq`
 * would collide across rooms and rank one room's message by another's relevance.
 *
 * @param roomId - The room.
 * @param seq - The message's position in it.
 */
function matchKey(roomId: string, seq: number): string {
  return `${roomId}\u0000${seq}`;
}

/** Every search this domain answers, and the scope each one runs under. */
export class RoomSearch {
  private readonly store: RoomStore;
  /** Words in, entry coordinates out. The message index, behind its port. */
  private readonly findMessages: RoomMessageFinder;

  constructor(
    core: RoomCore,
    private readonly visibility: RoomVisibility,
    private readonly projection: RoomProjection
  ) {
    this.store = core.store;
    this.findMessages = core.findMessages;
  }

  /**
   * The messages in one room that match some words, best first —
   * `search_room_history` (room-participation spec §10.3, as amended by DOR-672).
   *
   * **A caller of the message index, never a scan of its own.** There is exactly
   * one search path over these rows; a second one written here would answer the
   * same question differently — stems against substrings — and the difference
   * would be invisible until somebody compared them.
   *
   * The three scope rules are the read tool's, reused verbatim, and the index
   * gains no authority the tool did not already have: membership is resolved
   * first, the join floor rides into the query, and the coordinates that come back
   * are resolved through this room's OWN read path — so a hit the index somehow
   * held for a room this caller may not see could not be turned into a message
   * anyway.
   *
   * **A thread filter narrows what the index already ranked.** The index knows
   * nothing about threads (a projected message carries a container and an ordinal
   * and no relation), so the filter is applied to the resolved entries, over the
   * top {@link HISTORY_PAGE_MAX} matches in the room. Searching a busy channel for
   * a common word and narrowing to one thread can therefore come back thin; the
   * tool says so, and the fix if it ever matters is a column in the projection,
   * not a second scan here.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; must be on the roster.
   * @param opts.query - The words to look for. Matched by STEM, not substring.
   * @param opts.limit - The most matches to return, clamped to
   *   {@link HISTORY_PAGE_MAX}.
   * @param opts.threadRootEntryId - Keep only matches inside this thread.
   * @returns The matching entries, best first.
   */
  searchHistory(
    roomId: string,
    viewerAuthorId: string,
    opts: { query: string; limit: number; threadRootEntryId?: string }
  ): RoomEntry[] {
    const { floor } = this.visibility.requireHistoryFloor(roomId, viewerAuthorId);
    const wanted = clampHistoryLimit(opts.limit);
    const hits = this.findMessages({
      rooms: [{ roomId, afterSeq: floor }],
      query: opts.query,
      // Over-fetch only when something will be filtered out afterwards, so the
      // ordinary search costs exactly what it asked for.
      limit: opts.threadRootEntryId === undefined ? wanted : HISTORY_PAGE_MAX,
    });
    if (hits.length === 0) return [];

    const ranked = new Map(hits.map((hit, rank) => [hit.seq, rank]));
    const found = this.store
      .listEntriesBySeq(roomId, [...ranked.keys()])
      .filter(
        (entry) =>
          opts.threadRootEntryId === undefined || entry.threadRootEntryId === opts.threadRootEntryId
      )
      // The index ranked these by relevance and the store returned them by
      // position; relevance is the order the caller asked for.
      .sort((a, b) => (ranked.get(a.seq) ?? 0) - (ranked.get(b.seq) ?? 0))
      .slice(0, wanted);
    return this.projection.withRollups(roomId, found);
  }

  /**
   * How much of the room log one caller may search across EVERY room at once —
   * the whole-install read `GET /api/search` needs (message-search spec §7).
   *
   * The same two rules {@link RoomVisibility.requireVisibleRoom} and
   * {@link RoomService.readHistory} keep, expressed for a query that names no
   * room: the owner may see every room, everybody else exactly the rooms they
   * are on the roster of, each from their own `joinedSeq` up.
   *
   * **The floors are per room and cannot be collapsed into one.** A member joins
   * different rooms at different points, so a single lowest floor would leak what
   * was said before they arrived in the rooms they joined late, and a single
   * highest one would hide what is theirs in the rooms they joined early. This is
   * the reason the shape is a map rather than a list plus a number.
   *
   * **The owner's `'all'` diverges from {@link RoomService.readHistory}, and it is
   * meant to.** That path requires a MEMBER row even of the owner — "reading a
   * room's log is a membership, not a visibility" — so the operator cannot read
   * back a room they never joined, an agent-to-agent DM included. Search does not
   * apply that bar: the owner's scope is every room on the install. Three reasons,
   * and the first is the decisive one.
   *
   * - **The spec says so in a table.** message-search §7 gives the operator
   *   "all" rooms, {@link RoomVisibility.seesEveryRoom} says "nothing on their own
   *   machine hides from them", and `GET /api/search`'s own reference text tells
   *   every caller that is what it does.
   * - **Search is the export path, not the reading path.** The nearest neighbour
   *   is {@link RoomService.exportRoom}, which deliberately drops the join floor
   *   for the owner because "an owner handed a copy of their own room with the
   *   first months missing has not been given their data". A person searching
   *   their own machine for something they half-remember is in that situation,
   *   not in an agent's.
   * - **A hit is a coordinate, not the log.** What comes back is where something
   *   was said plus one marked sentence; opening it goes through the room's own
   *   read path, which still applies every rule it applies today.
   *
   * The consequence is stated rather than left to be discovered: **the operator's
   * search reaches rooms they are not on the roster of**, including rooms their
   * agents opened between themselves. Narrowing this later means giving the owner
   * a container list, which is the enumerate-everything filter §6.1 refuses — so
   * the honest place to change the answer is the spec, not this method.
   *
   * It returns a scope rather than results, and the difference is the access
   * model: the index is handed what this domain resolved and is never asked to
   * work out who anybody is.
   *
   * @param viewerAuthorId - The caller's author id.
   * @returns `'all'` for the operator, or every room they are in keyed to the
   *   `seq` they may read above. An empty map is a real answer — somebody in no
   *   rooms — and matches nothing.
   */
  searchScope(viewerAuthorId: string): RoomSearchScope {
    if (this.visibility.seesEveryRoom(viewerAuthorId)) return 'all';
    const floors = new Map<string, number>();
    for (const membership of this.store.listMembershipsFor(viewerAuthorId)) {
      floors.set(membership.roomId, membership.joinedSeq);
    }
    return floors;
  }

  /**
   * The messages that match some words across EVERY room this member belongs to,
   * best first — `search_member_rooms` (agent-memory spec D6).
   *
   * The cross-room sibling of {@link RoomService.searchHistory}, and it creates
   * no access that did not already exist: this is exactly the grant
   * message-search §7's table gives an agent — its member rooms, each floored at
   * its own `joinedSeq` — made reachable without first knowing a room id. The
   * same index, the same ranking, the same one search path.
   *
   * ## The floors are PER ROOM, and a single global floor is forbidden
   *
   * A member joins different rooms at different points, so the visible set is
   * `(roomId, joinedSeq)` PAIRS. One global floor is wrong in both directions and
   * there is no third option: the lowest leaks what was said before the caller
   * arrived in a room they joined late, and the highest hides what is theirs in a
   * room they joined early. {@link RoomMessageFinder} takes a floor per room for
   * this reason, and the index applies each INSIDE the query — a floor applied
   * after the `LIMIT` returns fewer results than were asked for and looks like a
   * ranking quirk.
   *
   * **The floor is then applied a second time, to the resolved entries.** Not
   * belt-and-braces theatre: the two filters answer different questions — the
   * first bounds what the INDEX may return, the second bounds what this service
   * hands back — and they COMPOSE rather than replace. An index row that survived
   * a room the caller has since left, or a projection that ever wrote an ordinal
   * that is not a `seq`, dies here rather than in a hit. A room with no floor at
   * all resolves to nothing, which is the direction a missing answer has to fail
   * in.
   *
   * **The second one is a lock no test can turn, and it is kept anyway.** Nothing
   * in the shipped code can hand this loop a row above the query's own floor, so
   * removing it reddens nothing — which is stated rather than papered over, and
   * is why `__tests__/member-rooms.test.ts` had to seed BOTH floors to make the
   * leak case fail. The first floor has a case to itself: collapse it alone and
   * the LIMIT starves, because a floor applied after the `LIMIT` returns fewer
   * results than were asked for.
   *
   * ## Where it deliberately differs from `list_member_rooms`
   *
   * The scope is every membership, ARCHIVED ROOMS INCLUDED, because archiving a
   * room does not un-say what was said in it and does not revoke a member's
   * history — it is the same rule {@link RoomService.searchScope} applies to a
   * non-owner, which is the shipped access model for `GET /api/search`. Listing
   * is about where an agent can act now; searching is about what it may recall.
   *
   * **It is NOT `searchScope`, and must never be refactored into it.** That
   * method has an OWNER branch which answers `'all'`, and this one deliberately
   * has none: a caller with no agent identity resolves to the person who owns
   * the install (`callerAuthor`, the login-off default), so an owner branch here
   * would turn one no-argument call from an ordinary coding session into a
   * search of every room on the machine — the operator's own DMs and rooms their
   * agents opened between themselves included. The two methods answer different
   * questions and only look alike. `__tests__/member-rooms.test.ts` pins it on
   * both verbs, because a defect seeded here is invisible to every case that
   * drives an identified agent.
   *
   * ## What it does NOT reach
   *
   * Session transcripts, and nothing here can be talked into them: the scope
   * this builds names the rooms source only, container by container, and
   * `origin_key` carries `source_id` beside it in the query — so a session whose
   * opaque id collides with a room's is still a different container.
   *
   * @param viewerAuthorId - The caller. Their memberships ARE the scope.
   * @param opts.query - The words to look for. Matched by STEM, not substring.
   * @param opts.limit - The most matches to return, clamped to
   *   {@link HISTORY_PAGE_MAX}.
   * @returns The matching entries with the room each was said in, best first.
   *   Empty for a caller in no rooms, for a query with no searchable word, and
   *   for a query that matches nothing — the three are one answer on purpose.
   */
  searchMemberRooms(
    viewerAuthorId: string,
    opts: { query: string; limit: number }
  ): MemberRoomMatch[] {
    const floors = new Map<string, number>();
    for (const membership of this.store.listMembershipsFor(viewerAuthorId)) {
      floors.set(membership.roomId, membership.joinedSeq);
    }
    if (floors.size === 0) return [];

    const wanted = clampHistoryLimit(opts.limit);
    const hits = this.findMessages({
      rooms: [...floors].map(([roomId, joinedSeq]) => ({ roomId, afterSeq: joinedSeq })),
      query: opts.query,
      limit: wanted,
    });
    if (hits.length === 0) return [];

    // The index ranked these; the store will return them by position. Rank is
    // the order the caller asked for, so it is captured before anything else
    // touches the list. Keyed on room AND seq, because a bare seq collides
    // across rooms and would rank one room's message by another's relevance.
    const ranked = new Map<string, number>();
    const seqsByRoom = new Map<string, number[]>();
    for (const [rank, hit] of hits.entries()) {
      const key = matchKey(hit.roomId, hit.seq);
      if (!ranked.has(key)) ranked.set(key, rank);
      const seqs = seqsByRoom.get(hit.roomId);
      if (seqs) seqs.push(hit.seq);
      else seqsByRoom.set(hit.roomId, [hit.seq]);
    }

    const matches: MemberRoomMatch[] = [];
    for (const [roomId, seqs] of seqsByRoom) {
      const room = this.store.getRoom(roomId);
      // A hit for a room that is gone resolves to nothing rather than to a
      // coordinate with no room around it.
      if (!room) continue;
      // Fails CLOSED. A room absent from the floor map is not in scope, and an
      // infinite floor is how that is spelled without a second branch.
      const floor = floors.get(roomId) ?? Number.POSITIVE_INFINITY;
      const entries = this.projection.withRollups(
        roomId,
        this.store.listEntriesBySeq(roomId, seqs).filter((entry) => entry.seq > floor)
      );
      const name = memberRoomName(room);
      for (const entry of entries) matches.push({ roomId, name, entry });
    }

    return matches
      .sort(
        (a, b) =>
          (ranked.get(matchKey(a.roomId, a.entry.seq)) ?? 0) -
          (ranked.get(matchKey(b.roomId, b.entry.seq)) ?? 0)
      )
      .slice(0, wanted);
  }
}
