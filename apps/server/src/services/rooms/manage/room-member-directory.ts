/**
 * The rooms an AGENT can find its own way around — `list_member_rooms`,
 * `get_room`, `find_room` and the handle lookup that feeds them (agent-memory
 * spec D6, spec `rooms-management-tools` §D8).
 *
 * **Membership, not visibility, and the owner is not exempt.** These are
 * `listRoomsForMember` for every caller, deliberately unlike the cockpit's own
 * room list, which short-circuits to every room on the machine for whoever
 * owns it. Each verb is named for what it answers — "the rooms you belong
 * to" — and a version that quietly meant "every room on this machine" when the
 * caller happened to be the owner would be a different question wearing the
 * same name.
 *
 * @module server/services/rooms/manage/room-member-directory
 */
import type { Room, RoomEntry, RoomKind } from '@dorkos/shared/room-schemas';
import type { AuthorRecord, AuthorRegistry } from '../author-registry.js';
import type { RoomCore } from '../service/room-core.js';
import type { RoomStore } from '../room-store.js';
import type { RoomVisibility } from '../service/room-visibility.js';

/**
 * The most rooms {@link RoomService.listMemberRooms} answers with (agent-memory
 * spec D6).
 *
 * Fifty rather than everything, and it is a bound on the PROMPT rather than on
 * the database. The list rides into a model's context whole, and an agent seated
 * in three hundred rooms would spend the turn reading a directory. Fifty most
 * recently active rooms is more than any agent in this product has been seated
 * in, and the ordering means the ones it cannot see are the ones nobody has
 * touched.
 */
export const MEMBER_ROOMS_PAGE_MAX = 50;

/** One room a caller belongs to, as `list_member_rooms` reports it. */
export interface MemberRoomSummary {
  /** The id every other room verb takes. */
  roomId: string;
  /** Channel, direct message, or thread-bearing kind. */
  kind: RoomKind;
  /** `#slug` for a channel that has one, the room's title otherwise. */
  name: string;
  /** ISO-8601, when this caller joined. Their history starts here. */
  joinedAt: string;
  /** ISO-8601, when anything was last said. The order this list is in. */
  lastActivityAt: string;
}

/** One cross-room match, as `search_member_rooms` resolves it. */
export interface MemberRoomMatch {
  /** The room it was said in. */
  roomId: string;
  /** That room's name, as {@link MemberRoomSummary.name} spells it. */
  name: string;
  /** The message itself, resolved through the room's own store. */
  entry: RoomEntry;
}

/**
 * The most rooms {@link RoomService.findMemberRooms} answers with.
 *
 * Smaller than {@link MEMBER_ROOMS_PAGE_MAX} because a find carries every match
 * WITH its roster: ten rooms of members is already a screenful of context, and a
 * filter that matches more than ten rooms is a filter that has not narrowed
 * anything — the honest answer to it is "narrow the filter", which the tool's
 * description says, not a longer page.
 */
export const FIND_ROOMS_MAX = 10;

/**
 * One member of a room, as {@link RoomService.describeRoom} reports them.
 *
 * Deliberately not the roster row: response modes and read cursors are the
 * operator's configuration surface, and a model handed them can act on none of
 * it. What an agent needs is who is here, how to address them, and whether each
 * is a person or a machine — the three facts `meta/agent-etiquette.md` says a
 * well-behaved participant must know.
 */
export interface RoomMemberSummary {
  /** The opaque author id — the one room entries carry as `authorId`. */
  authorId: string;
  /** Display name, or `Unknown` for an author whose record has vanished. */
  name: string;
  /** What an `@` reaches them by, or `null` when they cannot be addressed. */
  handle: string | null;
  /** `human`, `agent`, or `system` — the room's own voice. */
  kind: AuthorRecord['kind'];
}

/**
 * One room in full: the {@link MemberRoomSummary} facts plus its topic and its
 * whole roster. What `get_room` returns for one room and `find_room` returns
 * per match.
 */
export interface RoomDetail extends MemberRoomSummary {
  /** The room's topic, or `null` when nobody has set one. */
  topic: string | null;
  /** Everyone who can post, in the roster's own order. */
  members: RoomMemberSummary[];
}

/**
 * A find_room filter. Both fields optional at this layer, and a filter that
 * narrows nothing is answered with the capped list rather than with an error:
 * the refusal belongs to the TOOL, which is where a person typed the empty
 * filter, and a service that threw as well would put the same rule in two
 * places for a caller that has not gone wrong.
 */
export interface FindMemberRoomsFilter {
  /** Matches a channel's `#slug` exactly, or any room title as a substring. */
  name?: string;
  /** Handles (with or without `@`) that must ALL be on the roster. */
  memberHandles?: string[];
}

/**
 * What a `find_room` name filter MEANS, decided in one place.
 *
 * Trim, drop every leading `#`, lowercase. Both callers ask this rather than
 * spelling it themselves, and that is the whole point: the guard in
 * `room-capabilities.ts` has to refuse a filter that narrows nothing, and it can
 * only do that if it computes the same needle {@link RoomService.findMemberRooms}
 * will match on. Two hand-rolled copies is exactly how `"##"` got through — each
 * side stripped ONE `#`, so the guard saw a non-empty `"#"`, the matcher saw an
 * empty string, and an empty needle matches every room the caller is in.
 *
 * **Every leading `#`, not one**, which also makes this idempotent: normalizing
 * an already-normalized needle is a no-op, so the guard may hand its own result
 * to the service without the second pass changing it again.
 *
 * @param name - What the caller typed.
 * @returns The needle to match on. Empty means the filter narrows nothing.
 */
export function normalizeRoomNameNeedle(name: string): string {
  return name.trim().replace(/^#+/, '').trim().toLowerCase();
}

/**
 * What a `find_room` member filter MEANS, decided in one place.
 *
 * The `@` twin of {@link normalizeRoomNameNeedle}, and it had the same defect
 * for the same reason: `["@@"]` survived a guard that stripped one `@` and then
 * emptied out in the service, leaving `wanted` empty — which
 * {@link RoomMemberDirectory.holdsEveryHandle} reads as "no handle filter at all", so a
 * caller asking for an impossible roster got every room instead of none.
 *
 * Also used on the handles read back OFF a roster, so both sides of the
 * comparison are normalized by the same function rather than by two rules that
 * agree today.
 *
 * @param handle - A handle as typed, with or without its sigil.
 * @returns The handle to compare on. Empty means it names nobody.
 */
export function normalizeMemberHandle(handle: string): string {
  return handle.trim().replace(/^@+/, '').trim().toLowerCase();
}

/**
 * What a room is called when an agent is told about it.
 *
 * `#slug` for a channel, because that is the name a person types and the name
 * the room context block already uses; the title for a direct message, which has
 * no slug and whose title is who it is with.
 *
 * @param room - The room.
 * @returns The label, never empty — a room's title is required.
 */
export function memberRoomName(room: Room): string {
  return room.kind === 'channel' && room.slug ? `#${room.slug}` : room.title;
}

/** The room directory as a model reaches it: by membership, name and handle. */
export class RoomMemberDirectory {
  private readonly store: RoomStore;
  private readonly authors: AuthorRegistry;

  constructor(
    core: RoomCore,
    private readonly visibility: RoomVisibility
  ) {
    this.store = core.store;
    this.authors = core.authors;
  }

  /**
   * The rooms one member belongs to, newest activity first, bounded to
   * {@link MEMBER_ROOMS_PAGE_MAX} — `list_member_rooms` (agent-memory spec D6).
   *
   * It closes a plain gap: until this existed, an agent could read and search
   * ONE room by id and had no way to learn which rooms it was in. Every room
   * verb takes a room id, and the only id an agent held was the room it was
   * answering in — so `read_room_history` and `search_room_history` were
   * reachable for exactly one room out of however many it had been seated in.
   *
   * **Membership, not visibility, and the owner is not exempt.** This is
   * {@link RoomStore.listRoomsForMember} for EVERY caller, including the
   * operator — deliberately unlike {@link RoomService.listRooms}, which
   * short-circuits to every room on the machine for whoever owns it. The tool is
   * named for what it answers, "the rooms you belong to", and a version of it
   * that quietly means "every room on this machine" when the caller happens to
   * be the owner would be a different question wearing the same name.
   *
   * **Archived rooms are left out**, matching the sidebar's own default: a room
   * somebody archived is one nobody is working in, and an agent's list of where
   * it can act should hold places it can act. That is a narrower answer than
   * {@link RoomService.searchScope} gives, which is the safe direction — see
   * {@link RoomService.searchMemberRooms} for why the two differ on purpose.
   *
   * **The bound is a slice of an ORDERED list, never a bare `LIMIT`.** The store
   * orders by last activity descending with the id as the tiebreak, so the fifty
   * that come back are the fifty most recently active. A truncation that took an
   * arbitrary fifty would satisfy a count and be useless.
   *
   * @param viewerAuthorId - Whose rooms to list.
   * @returns At most {@link MEMBER_ROOMS_PAGE_MAX} rooms, newest activity first.
   *   Empty for somebody in no rooms, which is a real answer.
   */
  listMemberRooms(viewerAuthorId: string): MemberRoomSummary[] {
    const joinedAt = new Map(
      this.store
        .listMembershipsFor(viewerAuthorId)
        .map((member) => [member.roomId, member.joinedAt])
    );
    return this.store
      .listRoomsForMember(viewerAuthorId)
      .slice(0, MEMBER_ROOMS_PAGE_MAX)
      .map((room) => ({
        roomId: room.id,
        kind: room.kind,
        name: memberRoomName(room),
        // Defaulted rather than asserted. The listing INNER JOINS `room_members`,
        // so every room here has a membership row and the fallback is
        // unreachable — but a non-null assertion over two separate reads is a
        // claim about a race, and the room's own creation date is the honest
        // answer if one ever lost that race.
        joinedAt: joinedAt.get(room.id) ?? room.createdAt,
        lastActivityAt: room.lastActivityAt,
      }));
  }

  /**
   * One room in full — `get_room`: the listing facts plus the topic and the
   * whole roster, each member with their handle and their kind.
   *
   * The same gate the history reads use, through the same method
   * ({@link RoomVisibility.requireMemberRoom}): a caller that is not a member gets
   * the `ROOM_NOT_FOUND` a missing room gets, so a room id is never a
   * capability, and the owner is not exempt. The one thing this returns that the
   * listing does not is WHO — and who is in a room is exactly what membership
   * already grants: the roster panel shows it to every member, and the room
   * context block hands it to every triggered agent.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - Who is asking; must be on the roster.
   * @returns The room's detail, roster included.
   * @throws {RoomError} `ROOM_NOT_FOUND` for a missing room and a non-member
   *   alike.
   */
  describeRoom(roomId: string, viewerAuthorId: string): RoomDetail {
    const { room, member } = this.visibility.requireMemberRoom(roomId, viewerAuthorId);
    return this.detailOf(room, member.joinedAt);
  }

  /**
   * The caller's member rooms that match a filter, each in full — `find_room`.
   *
   * Scoped to membership by construction: the candidate set IS
   * {@link RoomStore.listRoomsForMember}, so a room the caller is not in is not
   * findable, which keeps this the same answer the reads give without a second
   * membership check to forget. Archived rooms stay out for the same reason they
   * stay out of the listing: a find is for rooms a message could still land in.
   *
   * Name matching is a channel's `#slug` exactly (the `#` optional, the case
   * not held against anyone) or any title as a case-insensitive substring — a DM
   * has no slug, and its title is who it is with, so "find my DM with Ana"
   * lands on the substring branch. Member matching requires EVERY named handle
   * on the roster, which is what makes "is there already a DM for this pair?"
   * one call. The name filter runs first because it is a column read; rosters
   * are only pulled for rooms that survive it.
   *
   * @param viewerAuthorId - Who is asking; only their rooms are searched.
   * @param filter - What to match; see {@link FindMemberRoomsFilter}.
   * @returns At most {@link FIND_ROOMS_MAX} matches, newest activity first.
   */
  findMemberRooms(viewerAuthorId: string, filter: FindMemberRoomsFilter): RoomDetail[] {
    const needle = filter.name === undefined ? undefined : normalizeRoomNameNeedle(filter.name);
    const wanted = (filter.memberHandles ?? [])
      .map(normalizeMemberHandle)
      .filter((handle) => handle.length > 0);
    const joinedAt = new Map(
      this.store
        .listMembershipsFor(viewerAuthorId)
        .map((member) => [member.roomId, member.joinedAt])
    );
    return this.store
      .listRoomsForMember(viewerAuthorId)
      .filter((room) => this.matchesName(room, needle))
      .filter((room) => this.holdsEveryHandle(room, wanted))
      .slice(0, FIND_ROOMS_MAX)
      .map((room) => this.detailOf(room, joinedAt.get(room.id) ?? room.createdAt));
  }

  /**
   * Turn a `@handle` into the author that answers to it, anywhere on this
   * install (spec `rooms-management-tools` §D8, DOR-1611).
   *
   * **A handle first, because it is the name a person types and the name the
   * roster leads with.** `get_room` puts a handle on every member and
   * `find_room` filters on them, so a handle is what a model has in hand when it
   * decides who to bring into a room. Resolved once, here — not in the
   * capability layer, where it would be a second place the rule could drift from
   * `holdsEveryHandle`'s idea of what a handle matches. Both sides normalize
   * through {@link normalizeMemberHandle} for exactly that reason.
   *
   * **An author id second, because a handle does not always exist** (DOR-1611
   * review, correcting this comment's own earlier premise that author ids are
   * "an identifier space no read verb produces" — `projectDetail` emits
   * `authorId` on every member, deliberately). The gap is not hypothetical and
   * it is not an edge: `mintHandle` returns `null` for the install's own human,
   * because the only string it could derive from is the placeholder `'You'`
   * (DOR-979 is the surface that will ask her for one). So on a default install
   * the OWNER has no handle at all — and every room an agent may open with a
   * colleague is one she has to be in, by the three-way rule. Without this
   * fallback `create_room` with a colleague was a dead end that answered
   * `OPERATOR_ONLY`, and naming her by the id the roster had just handed over
   * answered `MEMBER_NOT_FOUND`. The same gap catches any agent whose name
   * spells nothing legal.
   *
   * **Ordered, not sniffed.** The handle lookup runs first and the id lookup
   * only on a miss, rather than guessing from the shape of the string, because a
   * shape test is a third opinion about what a handle is and this file already
   * has enough. A string that names a live handle can never be shadowed by an
   * id; a string that names neither still resolves to nothing.
   *
   * **A scan rather than an index, deliberately.** There is no handle→author
   * lookup on {@link AuthorRegistry} and this does not add one: an install's
   * author rows number in the tens (its agents, its people), the verbs that ask
   * are occasional by construction, and a real index would need to answer the
   * tombstone question — a released handle whose row still carries it — that
   * {@link AuthorHandleStore} owns. Reading LIVE rows sidesteps that entirely:
   * a handle nobody currently answers to resolves to nothing.
   *
   * It answers WHO, never WHETHER. Membership, the three-way rule and the grant
   * all sit above this; resolving a name is not permission to use it.
   *
   * @param token - A handle as the caller typed it, with or without its `@`, or
   *   an author id as the roster reports it.
   * @returns The author, or `null` when nobody on this install answers to it.
   */
  findAuthorByHandle(token: string): AuthorRecord | null {
    const wanted = normalizeMemberHandle(token);
    if (!wanted) return null;
    const live = this.authors.listActive();
    const byHandle = live.find(
      (author) => author.handle && normalizeMemberHandle(author.handle) === wanted
    );
    if (byHandle) return byHandle;
    // Over the SAME live rows, not through `getById`, which has no
    // `retired_at IS NULL` filter: an id lookup that skipped it would resolve a
    // member whose directory has since changed hands, and the handle scan above
    // deliberately cannot.
    //
    // Trimmed and de-sigilled but NOT lowercased: an id is case-sensitive, so
    // `normalizeMemberHandle` is the wrong tool here even though it is the right
    // one two lines up. The `@` is stripped because a model that has been told
    // to write `@name` writes `@<id>` too, and a dead end there reads to it as
    // "that member does not exist".
    const id = token.trim().replace(/^@+/, '');
    return live.find((author) => author.id === id) ?? null;
  }

  /**
   * Whether a room answers to a name — its `#slug` exactly, or its title as a
   * substring. An empty or absent needle matches everything, so the two
   * `findMemberRooms` filters compose by plain chaining.
   */
  matchesName(room: Room, needle: string | undefined): boolean {
    if (!needle) return true;
    if (room.slug && room.slug.toLowerCase() === needle) return true;
    return room.title.toLowerCase().includes(needle);
  }

  /** Whether every wanted handle is on a room's roster. Empty wants everything. */
  holdsEveryHandle(room: Room, wanted: string[]): boolean {
    if (wanted.length === 0) return true;
    const held = new Set<string>();
    for (const member of this.store.listMembers(room.id)) {
      const handle = this.authors.getById(member.authorId)?.handle;
      if (handle) held.add(normalizeMemberHandle(handle));
    }
    return wanted.every((handle) => held.has(handle));
  }

  /**
   * Project one room and its roster into a {@link RoomDetail}.
   *
   * `Unknown` for a vanished author is the same word the roster panel and the
   * room context block use for the same state, so one absent author does not
   * read as three different people on three surfaces.
   */
  detailOf(room: Room, joinedAt: string): RoomDetail {
    return {
      roomId: room.id,
      kind: room.kind,
      name: memberRoomName(room),
      topic: room.topic,
      joinedAt,
      lastActivityAt: room.lastActivityAt,
      members: this.store.listMembers(room.id).map((member) => {
        const author = this.authors.getById(member.authorId);
        return {
          authorId: member.authorId,
          name: author?.displayName ?? 'Unknown',
          handle: author?.handle ?? null,
          kind: author?.kind ?? 'system',
        };
      }),
    };
  }
}
