/**
 * Drizzle CRUD over the five room tables.
 *
 * Synchronous throughout (`better-sqlite3`), so a post is one transaction with
 * no await inside it and the SSE handler can read the log and subscribe in the
 * same tick without opening a gap.
 *
 * This store owns exactly one non-obvious thing: `seq` allocation. Everything
 * else is a query; the row-to-domain mapping lives in `room-rows.ts`.
 *
 * @module server/services/rooms/room-store
 */
import {
  DEFAULT_AMBIENT_MAX_ENTRIES,
  authors,
  canonicalDmMemberKey,
  rooms,
  roomMembers,
  roomEntries,
  roomSessions,
  readCursors,
  eq,
  and,
  inArray,
  notInArray,
  lt,
  lte,
  gt,
  ne,
  isNull,
  isNotNull,
  alias,
  sql,
  count,
  desc,
  type Db,
  type DbTransaction,
  type SQL,
} from '@dorkos/db';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type {
  Room,
  RoomEntry,
  RoomKind,
  RoomMember,
  RoomMomentKind,
} from '@dorkos/shared/room-schemas';
import { logger } from '../../lib/logger.js';
import { RoomSessionLedger } from './room-session-ledger.js';
import {
  parseEntryBody,
  toEntry,
  toMember,
  toRoom,
  type NewRoom,
  type NewRoomEntry,
  type ThreadAggregateRow,
} from './room-rows.js';

/**
 * The bounds of one read of a channel's top level, shared by the read that
 * LISTS it and the one that COUNTS it (DOR-1207).
 */
export interface TopLevelWindow {
  /** Return entries with `seq` strictly above this — the caller's floor. */
  afterSeq: number;
  /** And with `seq` at or below this — the triggering entry's own position. */
  throughSeq: number;
  /** Drop this author's own entries; the turn reports them separately. */
  excludeAuthorId: string;
  /** Drop one entry by id — the thread root, quoted to the model already. */
  excludeEntryId: string;
}

/**
 * The predicate both top-level reads run, written once.
 *
 * It exists as a function rather than as two identical `where` clauses because
 * the count is SUBTRACTED from the list: the omitted number is only true while
 * the two describe the same set of messages, and a filter added to one of two
 * copies would make it a lie nothing could detect.
 *
 * @param roomId - The room.
 * @param opts - The window bounds.
 */
function topLevelWindow(roomId: string, opts: TopLevelWindow): SQL | undefined {
  return and(
    eq(roomEntries.roomId, roomId),
    gt(roomEntries.seq, opts.afterSeq),
    lte(roomEntries.seq, opts.throughSeq),
    isNull(roomEntries.threadRootEntryId),
    // Posts only — see `listRecentTopLevelEntries` for why this is a budget
    // decision and why it subsumes the notice-about-me filter.
    eq(roomEntries.kind, 'post'),
    ne(roomEntries.authorId, opts.excludeAuthorId),
    ne(roomEntries.id, opts.excludeEntryId)
  );
}

/**
 * What SQLite says when the partial unique index behind "one DM per member set"
 * refuses a write. `better-sqlite3` names the COLUMN rather than the index
 * (`UNIQUE constraint failed: rooms.dm_member_key`), which is what makes this
 * string, and not the error code, the thing to match on.
 */
const DM_MEMBER_KEY_CONSTRAINT = 'rooms.dm_member_key';

/**
 * Whether a thrown error is SQLite refusing a second direct message for one
 * member set (DOR-1616).
 *
 * **The column is matched, not just the error code.** `rooms` carries three
 * unique indexes — the channel slug, the well-known key, and this one — so a
 * caller that read any `SQLITE_CONSTRAINT_UNIQUE` as "somebody else opened this
 * DM first" would swallow a `SLUG_TAKEN` collision along with it. The column
 * name in the message is the only thing that tells them apart.
 *
 * **The whole cause chain is searched**, because the error a caller catches is
 * not always the one SQLite threw: a driver is free to wrap it, and a guard
 * that only read the outermost `message` would start answering `false` after a
 * dependency bump — silently turning every adopt-the-winner path back into the
 * 500 it exists to prevent.
 *
 * @param err - Whatever was caught.
 * @returns `true` when the DM member-set constraint is what refused the write.
 */
export function isDmMemberSetTaken(err: unknown): boolean {
  for (let cursor: unknown = err; cursor instanceof Error; cursor = cursor.cause) {
    if (cursor.message.includes(DM_MEMBER_KEY_CONSTRAINT)) return true;
  }
  return false;
}

/**
 * The `rooms.dm_member_key` a new room is inserted with — its canonical member
 * set, or `null` when it takes part in no member-set dedupe.
 *
 * Two rooms answer `null`. A CHANNEL has no member-set identity: its name is
 * `#slug` and `rooms_channel_slug_unique` is its constraint. A BRIDGED DM's
 * identity is its bridge row and never its roster (ADR 260804-093318) — the
 * roster of a bridged private chat is byte-identical to the operator's own DM
 * with that agent, so a bridged chat inside this dedupe would let a fresh open
 * reuse, and un-archive, a stranger's chat log.
 *
 * An empty roster also answers `null`, and that is not a degenerate case being
 * papered over: a room with nobody in it has no member set to be identified by,
 * and `RoomStore.findDmByMemberSet([])` has always answered `null` for exactly
 * that reason.
 *
 * @param kind - The room's kind.
 * @param bridged - Whether this room is a bridge projection.
 * @param members - The roster being written alongside the room.
 */
function dmMemberKeyFor(
  kind: RoomKind,
  bridged: boolean,
  members: ReadonlyArray<{ authorId: string }>
): string | null {
  if (kind !== 'dm' || bridged) return null;
  const key = canonicalDmMemberKey(members.map((member) => member.authorId));
  return key === '' ? null : key;
}

/** Persistence for rooms, memberships, entries, and per-room agent sessions. */
export class RoomStore {
  /**
   * Session-id-keyed reads, and the memory of which ids the projector has
   * retired. Public because the convergence paths address `room_sessions` by
   * session rather than by room, which is a different subject from everything
   * else on this store — see `room-session-ledger.ts`.
   */
  readonly sessionLedger: RoomSessionLedger;

  constructor(private readonly db: Db) {
    this.sessionLedger = new RoomSessionLedger(db);
  }

  // === Rooms ===

  /**
   * Insert a room and seed its roster in ONE transaction.
   *
   * Atomic on purpose. Seeding used to run as separate statements after the
   * room row was already committed, so a bad member id left a room that the
   * caller had just been told (404) was not created — holding its slug, showing
   * up in listings, and turning the obvious retry into a 409 SLUG_TAKEN for a
   * room they did not know they owned. Either the whole room exists with its
   * roster or none of it does.
   *
   * @param room - Every column of the new room.
   * @param members - The roster to seed, already resolved and validated.
   * @param within - Extra writes to run inside the SAME transaction, after the
   *   room and its roster are inserted — what
   *   {@link RoomService.createBridgedRoom} uses to write the `room_bridges` row
   *   alongside the room it identifies (chats-as-channels spec §3.2): either
   *   both commit or neither does, so a bridged room can never exist for a
   *   moment without the row that makes it bridged. On this single-connection
   *   `better-sqlite3` database that outcome is already structural — a plain
   *   write from inside `db.transaction(...)` lands in the same open
   *   transaction whether or not it is handed the `tx` argument, because there
   *   is only one connection for it to run against (see `DbTransaction`'s doc
   *   in `@dorkos/db` for why). What `within` actually buys is ORDERING and
   *   explicitness: the bridge row is guaranteed to land AFTER the room and
   *   roster it points at, reviewably, at the call site — not a room and
   *   roster with no bridge row sitting exposed between two separate
   *   `db.transaction` calls, however briefly.
   * @returns The inserted room.
   * @throws Whatever SQLite throws, including a UNIQUE failure on
   *   `rooms.dm_member_key` when another writer opened this same DM first —
   *   {@link isDmMemberSetTaken} is how a caller recognises that one, and
   *   `RoomService.createRoom` is what adopts the winner rather than surfacing
   *   it.
   */
  createRoom(
    room: NewRoom,
    members: ReadonlyArray<{ authorId: string; responseMode: ResponseMode; joinedAt: string }>,
    within?: (tx: DbTransaction) => void
  ): Room {
    const { bridged = false, ...columns } = room;
    const row = {
      ...columns,
      wellKnown: room.wellKnown ?? null,
      // Computed HERE, from the roster this call is about to write, rather than
      // handed in by the caller (DOR-1616). The key and the memberships have to
      // describe the same set of people, and the only way to guarantee that is
      // to derive one from the other in the transaction that writes both — a
      // caller-supplied key would be a second expression of the member set,
      // free to disagree with the rows beside it.
      dmMemberKey: dmMemberKeyFor(room.kind, bridged, members),
      // Empty at creation always: the seat is assigned by the boot hook that
      // resolves the default agent, never by whoever opened the room.
      fallbackSeatAuthorId: null,
      archived: false,
      ambientMaxEntries: DEFAULT_AMBIENT_MAX_ENTRIES,
      // Inheriting, always: a room is created with no opinion of its own about
      // automatic-reply limits, so it follows Settings until somebody says
      // otherwise (DOR-1429). Written explicitly rather than left to the column
      // default because this literal is also what `toRoom` hands back, and a
      // created room must read exactly as a re-fetched one does.
      turnLimitsEnabled: null,
      maxAgentDepth: null,
      maxTurnsPerAgentPerCascade: null,
      maxAutoTurnsPerHour: null,
      lastActivityAt: room.createdAt,
    };
    this.db.transaction(
      (tx) => {
        tx.insert(rooms).values(row).run();
        for (const member of members) {
          tx.insert(roomMembers)
            // Both seqs are 0 by construction rather than by default: a room
            // being created holds no entries yet, so nobody seeded onto its
            // roster has anything behind them or anything to have read.
            .values({ ...member, roomId: room.id, joinedSeq: 0, lastReadSeq: 0 })
            .onConflictDoNothing()
            .run();
        }
        within?.(tx);
      },
      { behavior: 'immediate' }
    );
    return toRoom(row);
  }

  /**
   * One room by id.
   *
   * @param id - The room id.
   */
  getRoom(id: string): Room | null {
    const row = this.db.select().from(rooms).where(eq(rooms.id, id)).get();
    return row ? toRoom(row) : null;
  }

  /**
   * Every room, newest activity first.
   *
   * Unscoped. The operator's own listing uses this — a single-player cockpit
   * that hid rooms from the person running it would be absurd. An AGENT's
   * listing must use {@link RoomStore.listRoomsForMember} instead.
   *
   * Recency is the only order this query imposes, on purpose. One list carries
   * every kind, and each kind wants a different order on screen (channels read
   * alphabetically, DMs by recency), which a single `ORDER BY` cannot say
   * without also grouping the kinds. That split is the client's — see
   * `useRoomsByKind` in `entities/room`. What this owes every caller is a
   * *stable* answer, hence the id: two rooms whose `lastActivityAt` is identical
   * (every seeded pair, since a new room's activity is its creation) would
   * otherwise come back in whatever order SQLite felt like.
   *
   * @param filter.kind - Restrict to one room kind.
   * @param filter.includeArchived - Include archived rooms (default false).
   */
  listRooms(filter: { kind?: RoomKind; includeArchived?: boolean } = {}): Room[] {
    const conditions = [];
    if (filter.kind) conditions.push(eq(rooms.kind, filter.kind));
    if (!filter.includeArchived) conditions.push(eq(rooms.archived, false));
    const rows = this.db
      .select()
      .from(rooms)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(rooms.lastActivityAt), desc(rooms.id))
      .all();
    return rows.map(toRoom);
  }

  /**
   * The rooms one author belongs to, newest activity first.
   *
   * Scoped by an inner join on `room_members` rather than by filtering after
   * the read: a room an agent is not in must never be loaded, not loaded and
   * then hidden. This is the boundary that stops an agent enumerating the
   * operator's DMs with other agents.
   *
   * Ordered like {@link RoomStore.listRooms}, id included — the two feed the
   * same endpoint and must not disagree about what "newest first" means.
   *
   * @param memberAuthorId - Whose rooms to list.
   * @param filter.kind - Restrict to one room kind.
   * @param filter.includeArchived - Include archived rooms (default false).
   */
  listRoomsForMember(
    memberAuthorId: string,
    filter: { kind?: RoomKind; includeArchived?: boolean } = {}
  ): Room[] {
    const conditions = [eq(roomMembers.authorId, memberAuthorId)];
    if (filter.kind) conditions.push(eq(rooms.kind, filter.kind));
    if (!filter.includeArchived) conditions.push(eq(rooms.archived, false));
    const rows = this.db
      .select({ room: rooms })
      .from(rooms)
      .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
      .where(and(...conditions))
      .orderBy(desc(rooms.lastActivityAt), desc(rooms.id))
      .all();
    return rows.map((row) => toRoom(row.room));
  }

  /**
   * The direct message whose roster is EXACTLY this set of authors, or `null`.
   *
   * **A lookup on the column the constraint guards, and that is the whole
   * design** (DOR-1616). This used to group `room_members` and count, which
   * answered the question correctly and answered it about a moment that had
   * already passed: two opens for one pair could both read "no DM yet" and both
   * insert, because no constraint could refuse the second — the fact being
   * constrained lived in a different table from the row. `rooms.dm_member_key`
   * moves it onto the row, `rooms_dm_member_key_unique` refuses the duplicate,
   * and this method reads that same column. So the question the create path asks
   * and the constraint that settles it are ONE expression, and cannot come to
   * different conclusions about what "the same member set" means.
   *
   * "Exactly" still means exactly, and the key is what makes each part of it
   * true. The whole set, human included — a DM is identified by who is in it and
   * the operator is in it, so matching the agents alone would collapse two
   * conversations the moment a second human author exists. Order-independent —
   * `[me, ana]` and `[ana, me]` sort to one key. Neither a superset nor a
   * subset — a different roster is a different string, so the DM with Ana and
   * Kai can never answer for the DM with Ana.
   *
   * Archived DMs are matched too, and deliberately: archiving does not release
   * a member set the way it releases a `#slug`, so the caller decides what to do
   * with one (`RoomService.createRoom` un-archives it). A store that hid them
   * would leave the only way back to that conversation being to mint a second
   * room with the same people in it.
   *
   * **A bridged room is never a match, now structurally.** A bridged private
   * chat's roster — the bound agent plus the operator — is byte-identical to the
   * operator's own private DM with that agent, so a match would hand a
   * stranger's chat log back as a private conversation and would un-archive and
   * reuse it for a re-bridge (chats-as-channels spec §3.2, A3.2c). Bridged rooms
   * carry a NULL key and this query asks for a non-null one, so the exclusion no
   * longer needs a `NOT IN (SELECT … FROM room_bridges)` clause that a future
   * copy of the query could be written without.
   *
   * **At most one row can match, so there is no tie to break.** The old
   * `ORDER BY archived, created_at` existed for duplicates that only
   * pre-existing data could hold; migration 0085 resolved those by that same
   * order and left every loser NULL, and the unique index means no new one can
   * appear.
   *
   * @param authorIds - The exact member set to match. Duplicates are collapsed.
   * @returns The matching DM, or `null` when no room holds exactly these authors.
   */
  findDmByMemberSet(authorIds: readonly string[]): Room | null {
    const key = canonicalDmMemberKey(authorIds);
    if (key === '') return null;
    const row = this.db
      .select()
      .from(rooms)
      // `kind` is redundant given that only a DM ever carries a key, and it is
      // here so the predicate MATCHES the partial index's own — which is what
      // lets the planner use it rather than scanning.
      .where(and(eq(rooms.kind, 'dm'), eq(rooms.dmMemberKey, key)))
      .get();
    return row ? toRoom(row) : null;
  }

  /**
   * The live (non-archived) channel holding a slug, if any. Archiving a channel
   * releases its slug, which is what the partial unique index encodes.
   *
   * @param slug - The channel slug.
   */
  findLiveChannelBySlug(slug: string): Room | null {
    const row = this.db
      .select()
      .from(rooms)
      .where(and(eq(rooms.slug, slug), eq(rooms.kind, 'channel'), eq(rooms.archived, false)))
      .get();
    return row ? toRoom(row) : null;
  }

  /**
   * Whether ANY channel holds this slug — archived ones included.
   *
   * The counterpart to {@link RoomStore.findLiveChannelBySlug}, and the two
   * answer different questions on purpose. "May I take this name?" is the live
   * one, because archiving releases a slug. "Is this name somebody's to come
   * back to?" is this one: an archived channel's way back is the slug it left
   * behind, so a path that hands that slug to a new room strands it for good
   * (`updateRoom` refuses the un-archive with `SLUG_TAKEN`). Only the paths
   * that MINT a name nobody typed ask this — a person naming a channel is told
   * about a collision and can choose.
   *
   * A boolean rather than a row: the partial unique index leaves archived
   * channels free to share a slug, so "which one" has no single honest answer
   * and nothing here needs one.
   *
   * @param slug - The channel slug.
   */
  anyChannelHoldsSlug(slug: string): boolean {
    return (
      this.db
        .select({ id: rooms.id })
        .from(rooms)
        .where(and(eq(rooms.slug, slug), eq(rooms.kind, 'channel')))
        .get() !== undefined
    );
  }

  /**
   * The room holding a well-known key, archived or not.
   *
   * **Archived rooms are included, deliberately.** This is the lookup
   * `ensureTeamRoom` is idempotent by, and skipping an archived match would let
   * a boot open a second #team beside the one somebody put away — which is the
   * one outcome a well-known key exists to prevent.
   *
   * @param key - The well-known key (`'team'`).
   */
  findByWellKnown(key: string): Room | null {
    const row = this.db.select().from(rooms).where(eq(rooms.wellKnown, key)).get();
    return row ? toRoom(row) : null;
  }

  /**
   * Patch a room's mutable fields.
   *
   * **An omitted field and a `null` one are different instructions**, and the
   * four turn-limit overrides are where that matters (DOR-1429): omitted leaves
   * the stored override alone, `null` clears it back to inheriting Settings.
   * Drizzle's `set` writes exactly the keys present, so both work without a
   * sentinel — which is why the caller must strip absent keys rather than
   * spreading `undefined`s.
   *
   * @param id - The room id.
   * @param patch - Fields to change; omitted fields are left alone.
   * @returns The updated room, or `null` when no such room exists.
   */
  updateRoom(
    id: string,
    patch: {
      title?: string;
      slug?: string;
      topic?: string | null;
      archived?: boolean;
      turnLimitsEnabled?: boolean | null;
      maxAgentDepth?: number | null;
      maxTurnsPerAgentPerCascade?: number | null;
      maxAutoTurnsPerHour?: number | null;
    }
  ): Room | null {
    if (Object.keys(patch).length > 0) {
      this.db.update(rooms).set(patch).where(eq(rooms.id, id)).run();
    }
    return this.getRoom(id);
  }

  // === Membership ===

  /**
   * Add a member, or leave an existing membership untouched.
   *
   * @param member - The membership to write.
   * `joinedSeq` is stamped HERE, from the room's log as it stands at this
   * moment, rather than being left to the column default: it is the floor under
   * everything this member may ever be shown (room-participation spec §8.3), and
   * a default of 0 would claim they had been present since the room's first
   * message. A conflicting insert leaves the existing row alone, so re-adding
   * somebody never moves the floor they already had.
   *
   * @param tx - An open transaction to write inside, when the join has to be
   *   atomic with something else. A bridged room's external human joins in the
   *   very transaction that writes their first entry (chats-as-channels §4.2),
   *   so that a crash can never leave a log holding a message from somebody the
   *   roster says was never in the room. The read below is issued through
   *   `this.db` for the reason {@link RoomStore.createRoom} records — one
   *   connection, so it sees that transaction's own uncommitted writes.
   * @returns The stored membership.
   * @throws Whatever SQLite throws, including a UNIQUE failure on
   *   `rooms.dm_member_key` when this join would give one DM the member set
   *   another DM already holds — see {@link RoomStore.syncDmMemberKey}, and
   *   {@link isDmMemberSetTaken} for how `RoomRoster` recognises it.
   */
  addMember(
    member: {
      roomId: string;
      authorId: string;
      responseMode: ResponseMode;
      joinedAt: string;
    },
    tx?: DbTransaction
  ): RoomMember {
    const row = { ...member, joinedSeq: this.maxSeq(member.roomId), lastReadSeq: 0 };
    // The join and the room's member key are ONE write: a DM whose roster moved
    // without its key moving would leave `findDmByMemberSet` confidently
    // answering with a room that no longer holds those people (DOR-1616).
    this.inOneTransaction(tx, (exec) => {
      exec.insert(roomMembers).values(row).onConflictDoNothing().run();
      this.syncDmMemberKey(member.roomId, exec);
    });
    // Read back through `this.db` even inside a transaction, for the reason
    // `createRoom` records: one connection, so a read here sees the open
    // transaction's own uncommitted write.
    return this.getMember(member.roomId, member.authorId) ?? toMember(row);
  }

  /**
   * One membership.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   */
  getMember(roomId: string, authorId: string): RoomMember | null {
    const row = this.db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.authorId, authorId)))
      .get();
    return row ? toMember(row) : null;
  }

  /**
   * A room's roster, oldest membership first, `authorId` breaking a tie.
   *
   * The tiebreak is load-bearing, not tidiness. A roster seeded at room
   * creation is written with ONE `joinedAt` for every member, so ordering by
   * that column alone leaves the whole roster tied — and a tie falls through to
   * whatever index the query planner happened to pick, which `ANALYZE` is free
   * to change under a running install. A reader takes the first agent in this
   * order to decide who a direct message is with, so "unspecified" would have
   * meant a DM could name a different counterpart on two machines holding
   * identical data.
   *
   * @param roomId - The room.
   */
  listMembers(roomId: string): RoomMember[] {
    const rows = this.db
      .select()
      .from(roomMembers)
      .where(eq(roomMembers.roomId, roomId))
      .orderBy(roomMembers.joinedAt, roomMembers.authorId)
      .all();
    return rows.map(toMember);
  }

  /**
   * The memberships of several rooms in ONE query, grouped by room and ordered
   * within each room exactly as {@link RoomStore.listMembers} orders one —
   * oldest first, `authorId` breaking the tie that a seeded roster always has.
   * The two must agree: the sidebar reads a DM's counterpart out of this and
   * the open room's header reads it out of that, and a reader who saw two
   * different agents for one conversation would be right to distrust both.
   *
   * The list endpoint resolves who is in every direct message it returns, and
   * doing that a room at a time would put an N+1 on the server to take one off
   * the client.
   *
   * @param roomIds - The rooms to read. An empty list reads nothing.
   */
  listMembersForRooms(roomIds: readonly string[]): RoomMember[] {
    if (roomIds.length === 0) return [];
    const rows = this.db
      .select()
      .from(roomMembers)
      .where(inArray(roomMembers.roomId, [...new Set(roomIds)]))
      .orderBy(roomMembers.roomId, roomMembers.joinedAt, roomMembers.authorId)
      .all();
    return rows.map(toMember);
  }

  /**
   * Every room an author belongs to.
   *
   * @param authorId - The member.
   */
  listMembershipsFor(authorId: string): RoomMember[] {
    const rows = this.db.select().from(roomMembers).where(eq(roomMembers.authorId, authorId)).all();
    return rows.map(toMember);
  }

  /**
   * Every room this author has written in — `RoomSummary.viewerHasPosted` for a
   * whole list, in one query.
   *
   * **Derived from the log, never stored.** There is no "has posted" column to
   * keep in step with the entries table, which is the same trade
   * {@link RoomStore.listThreadsForMember} makes: a fact that is a `SELECT` away
   * cannot drift from the rows it describes, and the write path stays a plain
   * append.
   *
   * **One query for the list, not one per room.** The obvious per-room spelling
   * is an `EXISTS` against `(room_id, seq)`, and it is the wrong shape twice
   * over: it is N queries for an N-room sidebar, and each one proves "never"
   * only by walking that room's entire log. This reads
   * `idx_room_entries_author_room` instead, whose whole reason to exist is this
   * question.
   *
   * **Every entry under a person's author id is something they wrote.** No
   * `kind` filter, because there is nothing to filter: a `notice` is authored by
   * the system author (`RoomService.postNotice`) and so is a milestone the room
   * mints for somebody, so an entry can only carry this author id if this author
   * posted it.
   *
   * @param authorId - Whose writing to look for.
   * @returns The ids of the rooms they have posted in. Empty for somebody who
   *   has never written anywhere, which is the answer a fresh install gives.
   */
  roomsPostedInBy(authorId: string): Set<string> {
    const rows = this.db
      .selectDistinct({ roomId: roomEntries.roomId })
      .from(roomEntries)
      .where(eq(roomEntries.authorId, authorId))
      .all();
    return new Set(rows.map((row) => row.roomId));
  }

  /**
   * Change a membership's response mode.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   * @param responseMode - The new per-room override.
   * @returns The updated membership, or `null` when there is none.
   */
  setResponseMode(roomId: string, authorId: string, responseMode: ResponseMode): RoomMember | null {
    this.db
      .update(roomMembers)
      .set({ responseMode })
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.authorId, authorId)))
      .run();
    return this.getMember(roomId, authorId);
  }

  /**
   * Record which member holds this room's fallback seat — the one that answers
   * a post nobody addressed.
   *
   * A column rather than a sweep for `response_mode = 'always'`: the mode is
   * also what a person picks from the member menu, and the two must not be
   * confused (see the column's own doc in `@dorkos/db`). Not validated against
   * the roster here, because the only caller resolves the member first and a
   * second read would just be the same question asked twice.
   *
   * @param roomId - The room.
   * @param authorId - The member holding the seat, or `null` to leave it empty.
   * @returns The updated room, or `null` when there is no such room.
   */
  setFallbackSeat(roomId: string, authorId: string | null): Room | null {
    this.db.update(rooms).set({ fallbackSeatAuthorId: authorId }).where(eq(rooms.id, roomId)).run();
    return this.getRoom(roomId);
  }

  /**
   * Advance a member's read cursor. Monotonic: a lower value is ignored, so a
   * stale client cannot un-read a room for a second client.
   *
   * **This is the AGENT-side cursor** (team-room-home spec §D4): what the
   * ambient participation loop has SHOWN a member, advanced when a turn is
   * claimed and rewound when it refuses (room-participation spec §8.3). Where a
   * PERSON has read is `read_cursors`, and `RoomService.setReadCursor` is what
   * decides which of the two a caller is moving. A human's row here is
   * historical residue from before the split: migration 0061 copied it forward,
   * and nothing writes or reads it for a person now.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   * @param lastReadSeq - The seq the member has now read up to.
   * @returns The updated membership, or `null` when there is none.
   */
  setReadCursor(roomId: string, authorId: string, lastReadSeq: number): RoomMember | null {
    this.db
      .update(roomMembers)
      .set({ lastReadSeq })
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.authorId, authorId),
          lt(roomMembers.lastReadSeq, lastReadSeq)
        )
      )
      .run();
    return this.getMember(roomId, authorId);
  }

  /**
   * Put a member's read cursor BACK, and only if nothing has moved it since.
   *
   * **A second method rather than a relaxed {@link RoomStore.setReadCursor}.**
   * That one is monotonic on purpose — a stale client must never un-read a room
   * for a second client — and widening its predicate to allow a lower value
   * would hand every caller the ability to do exactly that. This one can only
   * ever undo one specific write: it names the value it expects to find, so it
   * is a compare-and-set rather than an assignment.
   *
   * **What it is for.** The room advances an agent's cursor when its turn is
   * CLAIMED, because a turn that then fails has still seen the messages it was
   * shown (room-participation spec §8.3). But a claim is taken before the runner
   * is asked, and the runner can refuse before any model runs — a busy session,
   * or a throw on the way in. Nothing was shown, so nothing was read, and
   * leaving the cursor forward would make that backlog permanently invisible;
   * the busy notice even invites a re-send that would land above it.
   *
   * `from` is what makes this safe to run late. If a SECOND turn has been
   * claimed for the same member in the meantime, the stored value is no longer
   * the one this turn wrote, the predicate misses, and the rewind is a no-op —
   * so a refusal can never walk back a cursor that a live turn is relying on.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   * @param opts.from - The value this rewind expects to find; anything else and
   *   nothing is written.
   * @param opts.to - The value to restore.
   * @returns The membership as it now stands, or `null` when there is none.
   */
  rewindReadCursor(
    roomId: string,
    authorId: string,
    opts: { from: number; to: number }
  ): RoomMember | null {
    this.db
      .update(roomMembers)
      .set({ lastReadSeq: opts.to })
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.authorId, authorId),
          eq(roomMembers.lastReadSeq, opts.from)
        )
      )
      .run();
    return this.getMember(roomId, authorId);
  }

  /**
   * Remove a member.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   * @returns Whether a membership was removed.
   * @throws Whatever SQLite throws, including a UNIQUE failure on
   *   `rooms.dm_member_key` when the departure would leave one DM holding the
   *   member set another DM already holds — see
   *   {@link RoomStore.syncDmMemberKey}.
   */
  removeMember(roomId: string, authorId: string): boolean {
    const existed = this.getMember(roomId, authorId) !== null;
    // All three writes together, for the reason `addMember` gives: a roster that
    // moved without the room's member key moving is a key that describes people
    // who are no longer there.
    this.inOneTransaction(undefined, (exec) => {
      exec
        .delete(roomMembers)
        .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.authorId, authorId)))
        .run();
      exec
        .delete(roomSessions)
        .where(and(eq(roomSessions.roomId, roomId), eq(roomSessions.authorId, authorId)))
        .run();
      this.syncDmMemberKey(roomId, exec);
    });
    return existed;
  }

  /**
   * Run `writes` inside a transaction — the caller's when it has one, a fresh
   * IMMEDIATE one when it does not.
   *
   * **A caller's transaction is joined, never nested.** On this
   * single-connection `better-sqlite3` database a plain write from inside an
   * open transaction lands in it whether or not it is handed the `tx` handle
   * (see `DbTransaction`'s doc in `@dorkos/db`), so opening a second one here
   * would be asking SQLite for a savepoint nobody needs, and a rollback
   * boundary that is not the one the caller reasoned about.
   *
   * IMMEDIATE for the reason {@link RoomStore.appendEntry} records: this
   * transaction reads a room's roster and then writes the room's key from it,
   * and a deferred transaction that took a read lock first would fail to
   * upgrade it with `SQLITE_BUSY_SNAPSHOT` — which SQLite does not retry — the
   * moment a second process wrote in between.
   *
   * @param tx - The caller's open transaction, or `undefined`.
   * @param writes - The statements to run, handed whichever executor applies.
   */
  private inOneTransaction(
    tx: DbTransaction | undefined,
    writes: (exec: Db | DbTransaction) => void
  ): void {
    if (tx) {
      writes(tx);
      return;
    }
    this.db.transaction((fresh) => writes(fresh), { behavior: 'immediate' });
  }

  /**
   * Re-derive one room's `dm_member_key` from the roster as it now stands
   * (DOR-1616).
   *
   * **Called from inside the transaction that changed the roster**, never
   * after it. The key and the memberships are one fact written in two places,
   * and a crash between them would leave a DM whose key names people who are
   * not in it — which `RoomStore.findDmByMemberSet` would then hand back as
   * that conversation.
   *
   * **A room that holds no key is left alone, and that is the guard that makes
   * this safe rather than an oversight.** Three kinds of room hold NULL and
   * each must keep holding it: a channel, which has no member-set identity; a
   * BRIDGED DM, whose identity is its bridge row and never its roster
   * (ADR 260804-093318); and a DM that was already a duplicate before migration
   * 0085 ran, which that migration deliberately left out of the index. Deriving
   * a key for the last of those would be the worst outcome of the three — its
   * member set is by definition the winner's, so the recompute would collide and
   * refuse a roster edit that changes nothing.
   *
   * **A roster emptied to nothing drops the key.** A room with nobody in it has
   * no member set to be found by, and `findDmByMemberSet([])` has always
   * answered `null`, so it leaves the dedupe rather than sitting in the index
   * under an empty string. It does not come back if somebody is added again;
   * that is the honest consequence of a DM having been emptied, and it is no
   * worse than the state such a room is in today.
   *
   * @param roomId - The room whose roster just changed.
   * @param exec - The open transaction (or the db, when the caller had none).
   * @throws Whatever SQLite throws, including a UNIQUE failure on
   *   `rooms.dm_member_key` when the new roster is one another DM already holds
   *   — which rolls the whole roster write back, so the refusal leaves nothing
   *   half-applied.
   */
  private syncDmMemberKey(roomId: string, exec: Db | DbTransaction): void {
    const room = exec
      .select({ dmMemberKey: rooms.dmMemberKey })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .get();
    if (!room || room.dmMemberKey === null) return;
    const roster = exec
      .select({ authorId: roomMembers.authorId })
      .from(roomMembers)
      .where(eq(roomMembers.roomId, roomId))
      .all();
    const key = canonicalDmMemberKey(roster.map((member) => member.authorId));
    const next = key === '' ? null : key;
    if (next === room.dmMemberKey) return;
    exec.update(rooms).set({ dmMemberKey: next }).where(eq(rooms.id, roomId)).run();
  }

  // === Entries ===

  /**
   * Append one entry, allocating its per-room `seq` inside the transaction.
   *
   * The transaction is **IMMEDIATE**, and that is the load-bearing detail. A
   * deferred transaction would take a read lock for the `MAX(seq)` select and
   * then have to upgrade it to write, which SQLite refuses with
   * `SQLITE_BUSY_SNAPSHOT` when another connection wrote in between — and does
   * not retry, `busy_timeout` or not. Taking the writer lock up front makes
   * `busy_timeout` do its job and makes "SQLite serialises writers" true, which
   * is what lets `COALESCE(MAX(seq),0)+1` stand in for a counter table.
   *
   * Also bumps the room's `lastActivityAt` in the same transaction, so a room
   * can never be listed as quiet while holding an entry nobody has seen.
   *
   * @param entry - The entry to write, minus `seq`.
   * @param within - Extra writes to run inside the SAME transaction, before the
   *   entry row is inserted. This is what makes a bridged room's lazy roster
   *   join atomic with the message that causes it (chats-as-channels §4.2):
   *   the join must be visible to anything that reads the log, and a log
   *   holding a message from a non-member is not a state any reader should
   *   have to handle. Ordered first so the membership exists for the whole
   *   life of the entry, never the other way round.
   * @param bind - Extra writes to run inside the SAME transaction, AFTER the
   *   entry row is inserted. The mirror of `within`, and both exist because the
   *   two sides of the insert are not interchangeable: `within` runs first so a
   *   membership row covers the whole life of the entry, and `bind` runs last so
   *   a child row carrying a foreign key ONTO the entry has a parent to point
   *   at. `room_attachments` is the first such child, and putting its UPDATE in
   *   `within` fails immediately with `FOREIGN KEY constraint failed` —
   *   `foreign_keys` is ON and drizzle emits no `DEFERRABLE` clause, so the key
   *   is checked at statement time. All three writes are in one transaction, so
   *   they land together or not at all. Handed the allocated `seq` for a child
   *   row that wants to record it.
   * @returns The stored entry, with its allocated `seq`.
   */
  appendEntry(
    entry: NewRoomEntry,
    within?: (tx: DbTransaction) => void,
    bind?: (tx: DbTransaction, seq: number) => void
  ): RoomEntry {
    return this.db.transaction(
      (tx) => {
        within?.(tx);
        const allocated = tx
          .select({ next: sql<number>`COALESCE(MAX(${roomEntries.seq}), 0) + 1` })
          .from(roomEntries)
          .where(eq(roomEntries.roomId, entry.roomId))
          .get();
        const seq = allocated?.next ?? 1;

        tx.insert(roomEntries)
          .values({
            roomId: entry.roomId,
            seq,
            id: entry.id,
            authorId: entry.authorId,
            kind: entry.kind,
            body: JSON.stringify(entry.body),
            mentions: JSON.stringify(entry.mentions),
            mentionSpans: JSON.stringify(entry.mentionSpans ?? []),
            sessionId: entry.sessionId,
            cascadeRoot: entry.cascadeRoot,
            cascadeDepth: entry.cascadeDepth,
            // Which turn wrote this, when a turn did — the repeat rule's unit
            // (DOR-1434). Every writer that is not inside a turn omits it, and
            // `null` is the honest record of "no turn behind this write".
            dispatchId: entry.dispatchId ?? null,
            parentEntryId: entry.parentEntryId,
            threadRootEntryId: entry.threadRootEntryId,
            signature: null,
            createdAt: entry.createdAt,
          })
          .run();

        tx.update(rooms)
          .set({ lastActivityAt: entry.createdAt })
          .where(eq(rooms.id, entry.roomId))
          .run();

        bind?.(tx, seq);

        return {
          roomId: entry.roomId,
          seq,
          id: entry.id,
          authorId: entry.authorId,
          kind: entry.kind,
          body: entry.body,
          mentions: [...entry.mentions],
          mentionSpans: [...(entry.mentionSpans ?? [])],
          sessionId: entry.sessionId,
          cascadeRoot: entry.cascadeRoot,
          cascadeDepth: entry.cascadeDepth,
          parentEntryId: entry.parentEntryId,
          threadRootEntryId: entry.threadRootEntryId,
          signature: null,
          createdAt: entry.createdAt,
        };
      },
      { behavior: 'immediate' }
    );
  }

  /**
   * A page of history, oldest-first within the page.
   *
   * **One predicate over one table, and it stays that way.** A thread is an
   * entry-level relation (ADR 260728-022013), so a thread's replies live in the
   * channel's own log carrying `threadRootEntryId` — narrowing to a thread is one
   * more `AND`, where the child-room model would have needed a `UNION` across
   * every thread hanging off the channel (room-participation spec §3.3).
   *
   * @param roomId - The room.
   * @param opts.before - Return entries with `seq` strictly below this.
   * @param opts.afterSeq - Return entries with `seq` strictly above this. The
   *   history tools pass a member's `joinedSeq`, so nobody retroactively reads
   *   what was said before they were in the room (spec §8.3, §10.3).
   * @param opts.threadRootEntryId - Narrow to one thread's replies.
   * @param opts.limit - Page size.
   */
  listEntries(
    roomId: string,
    opts: { before?: number; afterSeq?: number; threadRootEntryId?: string; limit: number }
  ): RoomEntry[] {
    const conditions = [eq(roomEntries.roomId, roomId)];
    if (opts.before !== undefined) conditions.push(lt(roomEntries.seq, opts.before));
    if (opts.afterSeq !== undefined) conditions.push(gt(roomEntries.seq, opts.afterSeq));
    if (opts.threadRootEntryId !== undefined) {
      conditions.push(eq(roomEntries.threadRootEntryId, opts.threadRootEntryId));
    }
    const rows = this.db
      .select()
      .from(roomEntries)
      .where(and(...conditions))
      .orderBy(desc(roomEntries.seq))
      .limit(opts.limit)
      .all();
    return rows.reverse().map(toEntry);
  }

  /**
   * Specific entries of one room, by `seq`, in position order.
   *
   * The resolve half of `search_room_history`: the message index answers in
   * coordinates, and a coordinate becomes a message only by coming back through
   * the store that owns it. Scoped to ONE room by construction, so a coordinate
   * from anywhere else resolves to nothing rather than to somebody's message.
   *
   * @param roomId - The room the coordinates belong to.
   * @param seqs - The positions to read. An empty list reads nothing.
   */
  listEntriesBySeq(roomId: string, seqs: readonly number[]): RoomEntry[] {
    const wanted = [...new Set(seqs)];
    if (wanted.length === 0) return [];
    return this.db
      .select()
      .from(roomEntries)
      .where(and(eq(roomEntries.roomId, roomId), inArray(roomEntries.seq, wanted)))
      .orderBy(roomEntries.seq)
      .all()
      .map(toEntry);
  }

  /**
   * Specific entries of one room, by id, oldest first.
   *
   * The gathered half of a collected turn (§10.4): the dispatcher knows WHICH
   * messages one turn was asked, by id, and this is how those messages are read
   * — **never by slicing them out of the ambient page**, whose cap sizes the
   * background an agent reads and must not decide whether a question it was
   * asked reaches the model at all (DOR-1231).
   *
   * Scoped to ONE room by construction, like {@link RoomStore.listEntriesBySeq}
   * beside it, so an id from anywhere else reads nothing rather than somebody
   * else's message.
   *
   * @param roomId - The room the ids belong to.
   * @param ids - The entries to read. An empty list reads nothing.
   */
  listEntriesByIds(roomId: string, ids: readonly string[]): RoomEntry[] {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return [];
    return this.db
      .select()
      .from(roomEntries)
      .where(and(eq(roomEntries.roomId, roomId), inArray(roomEntries.id, wanted)))
      .orderBy(roomEntries.seq)
      .all()
      .map(toEntry);
  }

  /**
   * The newest entries above a cursor that one member has not read, oldest-first
   * within the page — the unread window a room turn shows an agent.
   *
   * **Every clause is in SQL on purpose, the cap included.** The obvious shape
   * is `listEntriesAfter` plus a `slice` in JS, and it is quadratic: every agent
   * read cursor is `0` until something advances it, so each turn reads the whole
   * log to keep the last thirty rows of it. Measured over a 500-message room
   * that is 125,250 rows read to deliver 30. Assembling this context must never
   * cost a model turn (`meta/agent-etiquette.md` E7), and it must not quietly
   * get more expensive with every message either.
   *
   * Ask for one more row than you need: a full page means older entries were
   * dropped, and that is what tells the caller to say so.
   *
   * **The window is closed at BOTH ends**, and the upper bound is what makes the
   * read cursor safe to advance at claim time. A turn's window is frozen to the
   * log as it stood when the turn was claimed; without a ceiling, a message that
   * landed while the turn was being assembled would be shown by this turn and
   * still sit above the cursor the claim wrote, so the next turn would show it a
   * second time (room-participation spec §8.3).
   *
   * **Notices ABOUT this agent are dropped too**, and that is the least obvious
   * clause. A notice is the room speaking, so it is not the agent's own entry
   * and the author filter above never touches it — which meant the room's line
   * about Ana ("Ana was busy… send it again when Ana is free") arrived in Ana's
   * next turn as something she had missed. It is not news to her: it is the
   * room narrating her, in the third person, occupying one of the handful of
   * slots that exist to carry what other people said. Notices about SOMEBODY
   * ELSE stay, because those are real context — a room-mate went quiet, and this
   * agent may be the one to pick it up.
   *
   * @param opts.afterSeq - Return entries with `seq` strictly above this.
   * @param opts.throughSeq - And with `seq` at or below this — the top of the
   *   window, which is the triggering entry's own position.
   * @param opts.excludeAuthorId - Drop this author's own entries, and the room's
   *   notices about it; the first are reported separately outside the untrusted
   *   fence, and the second are the room talking about the reader.
   * @param opts.excludeEntryIds - Drop entries that reach the model somewhere
   *   else: the triggering entry, which IS the message, and the gathered ones,
   *   which are read separately and rendered as the rest of what the turn
   *   answers (§10.4). **In SQL rather than filtered afterwards**, for the same
   *   reason the cap is: a page filtered in JS returns fewer than `limit` rows
   *   and makes the truncation flag lie.
   * @param opts.limit - How many of the newest to return.
   * @param opts.threadRootEntryId - Scope the window to one thread's replies.
   *   Omit for the whole room, which is what a top-level turn reads. A turn
   *   inside a thread passes the root, because the scope of what it reads has to
   *   be the scope it answers into and stays engaged in (DOR-1207); the entry
   *   the thread hangs off carries a null pointer, so it is never in its own
   *   thread's window — it reaches the model as the quoted opener instead.
   */
  listUnreadEntries(
    roomId: string,
    opts: {
      afterSeq: number;
      throughSeq: number;
      excludeAuthorId: string;
      excludeEntryIds: readonly string[];
      limit: number;
      threadRootEntryId?: string;
    }
  ): RoomEntry[] {
    const rows = this.db
      .select()
      .from(roomEntries)
      .where(
        and(
          eq(roomEntries.roomId, roomId),
          gt(roomEntries.seq, opts.afterSeq),
          lte(roomEntries.seq, opts.throughSeq),
          ne(roomEntries.authorId, opts.excludeAuthorId),
          // `notInArray` over an EMPTY list is `false` in some dialects, so the
          // clause is omitted rather than emitted empty. Unreachable today — the
          // triggering entry is always in it — and left as a property of the
          // method rather than of its one caller.
          ...(opts.excludeEntryIds.length === 0
            ? []
            : [notInArray(roomEntries.id, [...opts.excludeEntryIds])]),
          // Reads `idx_room_entries_thread_root`, whose third column is `seq` —
          // so a thread scattered through a long channel is paged rather than
          // sorted (migration 0040, and the measurement in
          // {@link RoomStore.listRecentPostsByOthers}).
          ...(opts.threadRootEntryId === undefined
            ? []
            : [eq(roomEntries.threadRootEntryId, opts.threadRootEntryId)]),
          // In SQL with the rest of them, for the reason the cap is: filtering
          // afterwards would return fewer than `limit` rows and make the
          // truncation flag lie. `json_extract` reads the subject out of the
          // body column; a row with no subject yields NULL, and `IS NOT` is the
          // null-safe comparison that keeps it.
          sql`json_extract(${roomEntries.body}, '$.subjectAuthorId') IS NOT ${opts.excludeAuthorId}`
        )
      )
      .orderBy(desc(roomEntries.seq))
      .limit(opts.limit)
      .all();
    return rows.reverse().map(toEntry);
  }

  /**
   * The last few TOP-LEVEL POSTS of a room, oldest-first within the page — the
   * glance sideways a thread turn gets at the channel it is not reading
   * (DOR-1207).
   *
   * **Posts only, and that is a budget decision.** The whole read is five rows,
   * so one machine notice — the room narrating that somebody was busy — would
   * eat a fifth of an agent's entire awareness of the channel. It also subsumes
   * the subject filter {@link RoomStore.listUnreadEntries} needs:
   * `subjectAuthorId` is written exactly when `kind === 'notice'`, so a notice
   * about the reader cannot reach this read either, and a second predicate
   * saying so would be SQL that can never match.
   *
   * **`afterSeq` is the caller's floor, and it carries two different jobs.**
   * The unread-first read passes `max(lastReadSeq, joinedSeq)`; the fallback
   * read, taken when nothing there is unread, passes `joinedSeq` alone — a
   * member never retroactively reads what was said before they were in the room
   * (spec §8.3), whichever of the two reads answers.
   *
   * **The cost is honest rather than free.** `thread_root_entry_id IS NULL` is a
   * residual filter over the `(room_id, seq)` primary key walked backwards, not
   * an index seek: the partial index covers the non-null rows only. So the walk
   * reads every row between the trigger and the fifth qualifying top-level post
   * — which in a channel is five rows, and inside a 30k-reply thread is 30k
   * (~0.5µs/row, so ~15ms). That is once per THREAD turn, beside a model call,
   * and no second index is being added for it; if a room ever makes that
   * measurable, the fix is an index on `(room_id, seq) WHERE
   * thread_root_entry_id IS NULL`, not a smaller glance.
   *
   * @param roomId - The room.
   * @param opts.afterSeq - Return entries with `seq` strictly above this.
   * @param opts.throughSeq - Frozen to the log as it stood at the trigger.
   * @param opts.excludeAuthorId - Drop this author's own entries; they are
   *   reported separately, outside the untrusted fence, because it wrote them.
   * @param opts.excludeEntryId - Drop one entry — the thread's own root, which
   *   is already quoted to the model as the thread opener.
   * @param opts.limit - How many of the newest to return.
   */
  listRecentTopLevelEntries(roomId: string, opts: TopLevelWindow & { limit: number }): RoomEntry[] {
    if (opts.limit <= 0) return [];
    const rows = this.db
      .select()
      .from(roomEntries)
      .where(topLevelWindow(roomId, opts))
      .orderBy(desc(roomEntries.seq))
      .limit(opts.limit)
      .all();
    return rows.reverse().map(toEntry);
  }

  /**
   * How many entries {@link RoomStore.listRecentTopLevelEntries} would return
   * with no limit — what turns "here are five" into "and N more you were not
   * shown".
   *
   * **It shares its predicate with the list rather than restating it**, because
   * the two are subtracted from each other: a filter that drifted between them
   * would report a count about a different set of messages than the one the
   * agent is looking at, and nothing would notice. Called only when the list
   * came back full, so a quiet channel costs one query rather than two.
   *
   * @param roomId - The room.
   * @param opts - Exactly the window the list read, minus its limit.
   */
  countRecentTopLevelEntries(roomId: string, opts: TopLevelWindow): number {
    const row = this.db
      .select({ total: sql<number>`count(*)` })
      .from(roomEntries)
      .where(topLevelWindow(roomId, opts))
      .get();
    return row?.total ?? 0;
  }

  /**
   * One author's most recent entries in a room, oldest-first within the page.
   *
   * Filtered in SQL rather than by reading a page and discarding most of it: an
   * agent that has not spoken for a hundred messages still has recent posts, and
   * a caller scanning back for them would either miss them or read the whole log.
   *
   * @param roomId - The room.
   * @param authorId - Whose entries to read.
   * @param limit - How many of the newest to return.
   */
  listEntriesByAuthor(roomId: string, authorId: string, limit: number): RoomEntry[] {
    const rows = this.db
      .select()
      .from(roomEntries)
      .where(and(eq(roomEntries.roomId, roomId), eq(roomEntries.authorId, authorId)))
      .orderBy(desc(roomEntries.seq))
      .limit(limit)
      .all();
    return rows.reverse().map(toEntry);
  }

  /**
   * The newest posts in one thread scope that somebody else wrote, NEWEST
   * FIRST — the engaged window's only read (`engagement.ts`, spec §9.2).
   *
   * Three predicates, each of them load-bearing:
   *
   * - **Thread scope.** `null` means the channel's top level, which is
   *   `thread_root_entry_id IS NULL` rather than "no filter": being addressed
   *   inside a thread must not engage an agent across the whole channel, and
   *   the reverse (spec §3.2).
   * - **`kind = 'post'`.** A notice is the room talking about the conversation,
   *   not a turn in it, so it neither anchors a window nor decays one.
   * - **Not the room's own voice.** The same rule as the line above, on the axis
   *   the kind cannot express: the system author writes POSTS too — a milestone
   *   (`postMoment`) and, since `project-rooms` §3.6, a merge event — and those
   *   are the room reporting rather than anybody taking a turn. Left in, they
   *   decayed a window nobody had spoken into: measured, five merges in a
   *   project room stood an engaged agent down in the middle of a conversation,
   *   and merges are that room's ordinary traffic. It is spelled as the author's
   *   KIND rather than as "not a merge", because the reason has nothing to do
   *   with merges — it is that the room is not a member of its own conversation.
   * - **Not this author.** An agent's own posts do not decay its own window, and
   *   an entry it wrote cannot be the message that addressed it.
   *
   * Newest-first is the ordering the caller counts in: the index of the newest
   * entry mentioning the member IS how many messages by others have landed since
   * it.
   *
   * **The two scopes are served by two different indexes, and only one of them
   * was free.** The top-level scope walks the `(room_id, seq)` primary key
   * backwards and stops at `limit`, with the other three clauses as residual
   * filters — right, because in a channel most rows are top-level posts, so the
   * first few it meets are the ones it wants. The thread scope cannot do that:
   * a thread is a handful of rows scattered through a long log, so a primary-key
   * walk reads the WHOLE room before it collects `limit` of them. It did exactly
   * that until migration 0040 put `seq` into `idx_room_entries_thread_root` —
   * measured at 5.5ms per call on a 50k-entry channel, once per engaged agent
   * per message. `packages/db/src/schema/rooms.ts` records why the fix is a
   * third index column rather than an `INDEXED BY` hint, and
   * `__tests__/engagement.test.ts` pins the plan so a regression is visible
   * rather than merely slow.
   *
   * @param roomId - The room.
   * @param opts.threadRootEntryId - The thread to scope to, or `null` for the
   *   channel's top level.
   * @param opts.excludeAuthorId - The member the window is being evaluated for.
   * @param opts.limit - How many of the newest to read.
   */
  listRecentPostsByOthers(
    roomId: string,
    opts: { threadRootEntryId: string | null; excludeAuthorId: string; limit: number }
  ): RoomEntry[] {
    if (opts.limit <= 0) return [];
    const rows = this.db
      .select()
      .from(roomEntries)
      .where(
        and(
          eq(roomEntries.roomId, roomId),
          opts.threadRootEntryId === null
            ? isNull(roomEntries.threadRootEntryId)
            : eq(roomEntries.threadRootEntryId, opts.threadRootEntryId),
          eq(roomEntries.kind, 'post'),
          ne(roomEntries.authorId, opts.excludeAuthorId),
          // The room's own voice, excluded by the author's kind. A residual
          // filter on a primary-key lookup per candidate row, so the `(room_id,
          // seq)` walk the plan test pins is unchanged.
          notInArray(
            roomEntries.authorId,
            this.db.select({ id: authors.id }).from(authors).where(eq(authors.kind, 'system'))
          )
        )
      )
      .orderBy(desc(roomEntries.seq))
      .limit(opts.limit)
      .all();
    return rows.map(toEntry);
  }

  /**
   * A bounded FORWARD page of one room's log, oldest-first, starting strictly
   * after a `seq` — the read a cursor-paged listing needs.
   *
   * The sibling {@link RoomStore.listEntries} pages BACKWARDS from the newest
   * entry, which is what a chat window scrolling up wants and what a cursor
   * cannot use: resuming from an entry means "the next few after this one", and
   * expressing that with `before` requires knowing the answer first.
   * {@link RoomStore.listEntriesAfter} has the right direction and no bound,
   * which is fine for a replay that must be complete and wrong for a page.
   *
   * **Two scopes, and each is served by an index that already exists.** The
   * default (`threadRootEntryId` omitted) is the top-level timeline —
   * `parent_entry_id IS NULL` as a residual filter over a `(room_id, seq)`
   * range the primary key already orders, which is exactly why
   * `packages/db/src/schema/rooms.ts` deliberately does not index that
   * predicate. Passing a root reads `idx_room_entries_thread_root`, whose third
   * column is `seq` precisely so an ordered page stops at its limit instead of
   * sorting the whole thread.
   *
   * Ask for one more row than the page needs: a caller that must declare
   * exhaustion (rather than let a reader infer it from a short page) can only
   * do so by knowing whether a further row exists.
   *
   * @param roomId - The room.
   * @param opts.afterSeq - Return entries with `seq` strictly above this.
   * @param opts.limit - How many of the oldest matching entries to return.
   * @param opts.threadRootEntryId - Omit for the top level; pass a root entry id
   *   for that thread's replies.
   */
  listEntriesFrom(
    roomId: string,
    opts: { afterSeq: number; limit: number; threadRootEntryId?: string }
  ): RoomEntry[] {
    if (opts.limit <= 0) return [];
    const rows = this.db
      .select()
      .from(roomEntries)
      .where(
        and(
          eq(roomEntries.roomId, roomId),
          gt(roomEntries.seq, opts.afterSeq),
          opts.threadRootEntryId === undefined
            ? isNull(roomEntries.parentEntryId)
            : eq(roomEntries.threadRootEntryId, opts.threadRootEntryId)
        )
      )
      .orderBy(roomEntries.seq)
      .limit(opts.limit)
      .all();
    return rows.map(toEntry);
  }

  /**
   * Rolled-up reply counts for several thread roots at once.
   *
   * The batched form of {@link RoomStore.countThreadReplies}, and it exists for
   * the reason {@link RoomStore.listMembersForRooms} exists: a page of fifty
   * entries would otherwise be fifty `COUNT(*)` round trips to decorate a
   * summary nobody asked for one row at a time.
   *
   * `lastReplyAt` is `MAX(created_at)`, which orders correctly because every
   * value is written by `new Date().toISOString()` — one fixed-width UTC format,
   * where lexicographic and chronological order coincide. Two replies inside the
   * same millisecond report the same instant, which is what a display timestamp
   * can honestly say about them.
   *
   * @param roomId - The room the threads live in.
   * @param rootEntryIds - The roots to roll up. An empty list reads nothing.
   * @returns One entry per root that HAS replies; a root with none is absent.
   */
  countThreadRepliesFor(
    roomId: string,
    rootEntryIds: readonly string[]
  ): Map<string, { replyCount: number; lastReplyAt: string }> {
    const summaries = new Map<string, { replyCount: number; lastReplyAt: string }>();
    const wanted = [...new Set(rootEntryIds)];
    if (wanted.length === 0) return summaries;
    const rows = this.db
      .select({
        rootEntryId: roomEntries.threadRootEntryId,
        replyCount: count(),
        lastReplyAt: sql<string>`MAX(${roomEntries.createdAt})`,
      })
      .from(roomEntries)
      .where(and(eq(roomEntries.roomId, roomId), inArray(roomEntries.threadRootEntryId, wanted)))
      .groupBy(roomEntries.threadRootEntryId)
      .all();
    for (const row of rows) {
      if (row.rootEntryId === null) continue;
      summaries.set(row.rootEntryId, {
        replyCount: row.replyCount,
        lastReplyAt: row.lastReplyAt,
      });
    }
    return summaries;
  }

  /**
   * Every entry after a cursor, in `seq` order — the SSE replay read. The log
   * is never trimmed, so this can always be served gap-free.
   *
   * @param roomId - The room.
   * @param afterSeq - Return entries with `seq` strictly above this.
   */
  listEntriesAfter(roomId: string, afterSeq: number): RoomEntry[] {
    const rows = this.db
      .select()
      .from(roomEntries)
      .where(and(eq(roomEntries.roomId, roomId), gt(roomEntries.seq, afterSeq)))
      .orderBy(roomEntries.seq)
      .all();
    return rows.map(toEntry);
  }

  /**
   * A bounded FORWARD page over EVERY entry in a room, oldest-first — the export
   * read (DOR-1225).
   *
   * The third forward reader on this table, and the distinction from the two
   * beside it is the whole reason it exists. {@link RoomStore.listEntriesFrom}
   * pages the top-level TIMELINE (`parent_entry_id IS NULL`) or one thread,
   * because that is what a reader looking at a room sees;
   * {@link RoomStore.listEntriesAfter} is unbounded, because a replay must be
   * complete in one answer. An export needs both halves of what neither gives:
   * every entry, thread replies included — it is a copy of the room, not a view
   * of it — and a bound, because a room's log is never trimmed and a copy must
   * not have to fit in memory before it can start.
   *
   * @param roomId - The room.
   * @param opts.afterSeq - Return entries with `seq` strictly above this.
   * @param opts.limit - How many of the oldest matching entries to return.
   */
  listEntriesForExport(roomId: string, opts: { afterSeq: number; limit: number }): RoomEntry[] {
    if (opts.limit <= 0) return [];
    const rows = this.db
      .select()
      .from(roomEntries)
      .where(and(eq(roomEntries.roomId, roomId), gt(roomEntries.seq, opts.afterSeq)))
      .orderBy(roomEntries.seq)
      .limit(opts.limit)
      .all();
    return rows.map(toEntry);
  }

  /**
   * One entry by its stable id.
   *
   * @param roomId - The room.
   * @param entryId - The entry id.
   */
  getEntryById(roomId: string, entryId: string): RoomEntry | null {
    const row = this.db
      .select()
      .from(roomEntries)
      .where(and(eq(roomEntries.roomId, roomId), eq(roomEntries.id, entryId)))
      .get();
    return row ? toEntry(row) : null;
  }

  /**
   * Has a moment matching this key already landed in this room?
   *
   * **This is the moment detectors' whole idempotency mechanism** (team-room-home
   * spec D5.1). A moment that was posted IS the marker that it was posted: it is
   * a row in this table carrying `body.moment`, so a restart, a second process,
   * or a detector that evaluates the same event twice all read the same answer.
   * Nothing here is remembered in memory, which is the point — a flag would
   * re-post every first-of-its-kind moment on the next boot.
   *
   * Which parts of the key are supplied is how a detector says what "already"
   * means for it: `kind` alone is once-ever-per-install (your first agent),
   * `+ ref` is once per record (each agent joining), `+ observedAt` is once per
   * occasion (this agent's one-week mark, as distinct from its one-month mark).
   *
   * Unbounded on purpose, unlike {@link RoomStore.latestMomentAt}: this is the
   * question a moment must never get wrong, and it only runs when a detector has
   * already decided it has something to post — rarely, and never in a loop.
   *
   * `kind` is the schema's own union rather than a string, and that is load
   * bearing: the value is compared against JSON already written into the log, so
   * renaming a moment kind without noticing this call site would leave every
   * first-of-its-kind moment matching nothing and re-posting forever. Typed, that
   * rename is a compile error.
   *
   * @param roomId - The room to look in.
   * @param key.kind - The moment kind.
   * @param key.ref - The source record, when the kind may fire for several.
   * @param key.observedAt - The occasion, when a record has several.
   */
  hasMoment(
    roomId: string,
    key: { kind: RoomMomentKind; ref?: string; observedAt?: string }
  ): boolean {
    const conditions = [
      eq(roomEntries.roomId, roomId),
      sql`json_extract(${roomEntries.body}, '$.moment.kind') = ${key.kind}`,
    ];
    if (key.ref !== undefined) {
      conditions.push(sql`json_extract(${roomEntries.body}, '$.moment.source.ref') = ${key.ref}`);
    }
    if (key.observedAt !== undefined) {
      conditions.push(
        sql`json_extract(${roomEntries.body}, '$.moment.source.observedAt') = ${key.observedAt}`
      );
    }
    return (
      this.db
        .select({ seq: roomEntries.seq })
        .from(roomEntries)
        .where(and(...conditions))
        .limit(1)
        .get() !== undefined
    );
  }

  /**
   * When this room last marked a moment, looking no further back than the
   * newest `scan` entries.
   *
   * The bound is deliberate and is what makes this safe to call on every
   * activity event: it walks the `(room_id, seq)` primary key backwards and
   * stops, rather than scanning a whole channel for a JSON field no index
   * covers. Its one caller is the quiet period that keeps a burst of milestones
   * from filling the feed, and a room that has moved `scan` entries since its
   * last moment is not in a burst — so reading further could only confirm what
   * the bound already decided.
   *
   * @param roomId - The room.
   * @param scan - How many of the newest entries to read.
   * @returns The newest moment's `createdAt` within that window, or `null`.
   */
  latestMomentAt(roomId: string, scan: number): string | null {
    if (scan <= 0) return null;
    const rows = this.db
      .select({ createdAt: roomEntries.createdAt, body: roomEntries.body })
      .from(roomEntries)
      .where(eq(roomEntries.roomId, roomId))
      .orderBy(desc(roomEntries.seq))
      .limit(scan)
      .all();
    for (const row of rows) {
      if (parseEntryBody(row.body).moment) return row.createdAt;
    }
    return null;
  }

  /**
   * The highest `seq` in a room, or 0 when it is empty.
   *
   * @param roomId - The room.
   */
  maxSeq(roomId: string): number {
    const row = this.db
      .select({ value: sql<number>`COALESCE(MAX(${roomEntries.seq}), 0)` })
      .from(roomEntries)
      .where(eq(roomEntries.roomId, roomId))
      .get();
    return row?.value ?? 0;
  }

  /**
   * How many entries a member has not read.
   *
   * **No visibility predicate, and that is the decision rather than an
   * oversight** (DOR-634). Now that a thread reply is an entry in this room
   * (ADR 260728-022013) it is tempting to exclude one here so the badge matches
   * a timeline that only draws top-level rows. Do not: the cursor is only ever
   * advanced to the newest entry in the array the client was handed, that array
   * is unfiltered, and a count filtered against a cursor that is not would leave
   * a badge nothing in the product can clear. Unread means "entries in this room
   * you have not seen", which stays true and stays clearable. The grouping
   * belongs in the render.
   *
   * **One meaning, and every reader wants that one.** This is the sidebar-badge
   * predicate, and the three callers are the three ways that badge is delivered:
   * `RoomService.listRooms` computes it for a list, `RoomService.setReadCursor`
   * sends it on the global stream so a second device redraws the same badge
   * without refetching, and the local `CommunityAdapter` projects it for a room.
   * A fourth reader is welcome on the same terms — do not bend the predicate to
   * suit one. It briefly had a reader that took it as a plain row count for a
   * thread's `replyCount`, sound only while a thread had a room to itself; that
   * reader and the room kind behind it retired together (ADR 260728-022013), and
   * `countThreadReplies` is where a reply count comes from now.
   *
   * @param roomId - The room.
   * @param lastReadSeq - The member's read cursor.
   */
  countUnread(roomId: string, lastReadSeq: number): number {
    const row = this.db
      .select({ value: count() })
      .from(roomEntries)
      .where(and(eq(roomEntries.roomId, roomId), gt(roomEntries.seq, lastReadSeq)))
      .get();
    return row?.value ?? 0;
  }

  /**
   * How many replies hang off one thread root.
   *
   * The root itself carries a null `thread_root_entry_id`, so it is never in its
   * own count — which is what makes "3 replies" mean three answers and not the
   * opening message plus two.
   *
   * Reads `idx_room_entries_thread_root`, the partial index. Deliberately NOT
   * `countUnread(threadRoomId, 0)`, which is what the child-room shape reused
   * for this: that reuse only worked while a thread had a room of its own, and
   * bending the unread predicate to keep it working would have changed the
   * sidebar badge too (DOR-634).
   *
   * @param roomId - The room the thread lives in.
   * @param threadRootEntryId - The entry the thread hangs off.
   */
  countThreadReplies(roomId: string, threadRootEntryId: string): number {
    const row = this.db
      .select({ value: count() })
      .from(roomEntries)
      .where(
        and(eq(roomEntries.roomId, roomId), eq(roomEntries.threadRootEntryId, threadRootEntryId))
      )
      .get();
    return row?.value ?? 0;
  }

  /**
   * Every thread one author takes part in, across every room, newest first.
   *
   * **Participation is what SELECTS a thread; the roster is what permits it**
   * (spec `room-messaging-design` §3). A thread is here because this author
   * wrote its root or wrote one of its replies AND is on the room's roster
   * today. Nothing is stored — no follow list, no thread membership table — so
   * this is derived from the log on every read, which is exactly why v1 needed
   * no schema.
   *
   * **The participation test is an EXISTS rather than a predicate on the row,
   * and getting that wrong is the bug worth naming.** The obvious spelling —
   * `WHERE reply.author_id = ? OR root.author_id = ?` — filters the rows being
   * COUNTED, so a thread you replied in once would report a reply count of one
   * and no unread replies from anybody else. The EXISTS asks the same question
   * about the thread rather than about the row, so every reply is aggregated
   * whoever wrote it.
   *
   * **Unread is the room's own cursor, narrowed to the thread.** There is one
   * `(member, room)` cursor and threads share it, so opening a room clears its
   * threads' counts too — the same trade `groupByThread` states on the client,
   * and the alternative is a badge nothing in the product can clear. A reply of
   * the reader's own counts while it sits above the cursor, exactly as
   * {@link RoomStore.countUnread} counts it for the room's badge — one rule,
   * measured in one place.
   *
   * **Which cursor that is depends on who is reading, and the caller says which**
   * (team-room-home spec §D4). A person's place in a room lives in
   * `read_cursors`; an agent's — what the ambient loop has shown it — is
   * `room_members.last_read_seq`. The `'user'` join is LEFT, and its `COALESCE`
   * floor is 0 rather than the membership column: a person who has read nothing
   * has no row, and falling back to the agent-side column would be reading one
   * cursor to answer the other's question, which is the one thing the split
   * forbids.
   *
   * **The membership join is INNER, and that is the privacy boundary** — the
   * same one {@link RoomStore.listRoomsForMember} draws, drawn the same way.
   * Participation implies membership at WRITE time, never at read time:
   * somebody removed from a room keeps the words they wrote there, but the room
   * stops being theirs to see. `getRoom` already 404s them, so a row here would
   * be a dead end, and a thread list that reached past the roster would be a
   * way to keep watching a room you were taken out of.
   *
   * Archived rooms are excluded, matching the default room list — a room that
   * has left the sidebar should not send its threads back into it.
   *
   * @param viewerAuthorId - Whose threads to list, and whose cursor to measure.
   * @param limit - Most rows to return, newest activity first.
   * @param cursor - Which read cursor answers for this reader: `'user'` for a
   *   person's own, `'membership'` for the agent-side column.
   */
  listThreadsForMember(
    viewerAuthorId: string,
    limit: number,
    cursor: 'user' | 'membership'
  ): ThreadAggregateRow[] {
    const root = alias(roomEntries, 'thread_root');
    const readCursor = sql`COALESCE(${readCursors.lastReadSeq}, 0)`;
    // MAX over the replies' timestamps: a thread's activity is its newest
    // reply. Named once and reused for the ORDER BY, so the sort and the value
    // the row reports can never be two different expressions.
    const lastActivityAt = sql<string>`MAX(${roomEntries.createdAt})`;
    return (
      this.db
        .select({
          roomId: roomEntries.roomId,
          roomKind: rooms.kind,
          roomSlug: rooms.slug,
          roomTitle: rooms.title,
          rootEntryId: root.id,
          rootAuthorId: root.authorId,
          rootBody: root.body,
          replyCount: count(),
          unreadCount: sql<number>`SUM(CASE WHEN ${roomEntries.seq} > ${
            cursor === 'user' ? readCursor : roomMembers.lastReadSeq
          } THEN 1 ELSE 0 END)`,
          lastActivityAt,
        })
        .from(roomEntries)
        .innerJoin(
          root,
          and(eq(root.roomId, roomEntries.roomId), eq(root.id, roomEntries.threadRootEntryId))
        )
        .innerJoin(rooms, eq(rooms.id, roomEntries.roomId))
        // The membership join is the privacy boundary and stays INNER whichever
        // cursor is measured; the cursor join below is LEFT, because having read
        // nothing is not the same as not being here.
        .innerJoin(
          roomMembers,
          and(eq(roomMembers.roomId, roomEntries.roomId), eq(roomMembers.authorId, viewerAuthorId))
        )
        .leftJoin(
          readCursors,
          and(
            eq(readCursors.userId, viewerAuthorId),
            eq(readCursors.threadKind, 'room'),
            eq(readCursors.threadId, roomEntries.roomId)
          )
        )
        .where(
          and(
            isNotNull(roomEntries.threadRootEntryId),
            eq(rooms.archived, false),
            sql`(${root.authorId} = ${viewerAuthorId} OR EXISTS (
            SELECT 1 FROM ${roomEntries} AS participation
            WHERE participation.room_id = ${roomEntries.roomId}
              AND participation.thread_root_entry_id = ${roomEntries.threadRootEntryId}
              AND participation.author_id = ${viewerAuthorId}
          ))`
          )
        )
        .groupBy(roomEntries.roomId, roomEntries.threadRootEntryId)
        // The id breaks a tie so two threads answered in the same second never
        // swap places between reads, the same rule every room list ends on.
        .orderBy(desc(lastActivityAt), desc(root.id))
        .limit(limit)
        .all()
    );
  }

  /**
   * How many TURNS each author has already taken in one cascade — the repeat
   * rule's input.
   *
   * A count per author rather than the distinct set the ancestry rule used to
   * ask for (DOR-1428): the rule fires at `maxTurnsPerAgentPerCascade` rather
   * than at the first repeat, so "has this author spoken" is no longer the
   * question. Same single indexed read of `idx_room_entries_cascade_root`,
   * grouped instead of de-duplicated.
   *
   * **The unit is a turn, not a message** (DOR-1434, amending ADR 260823-000217,
   * which shipped this as `COUNT(*)` and named the change as its own follow-up).
   * One turn writes as many entries as it likes — progress notes through the
   * rooms tool, then the answer the dispatcher delivers — and all of them carry
   * that turn's `dispatch_id`, so they collapse to one. Counting rows instead
   * made an agent that thinks out loud spend its allowance several times faster
   * than one that answers in a single line, which is a tax on being legible.
   *
   * So the sum is two halves:
   *
   * - `COUNT(DISTINCT dispatch_id)` — one per marked turn. SQLite's `COUNT
   *   DISTINCT` ignores nulls, so unmarked rows cannot leak in here.
   * - `SUM(dispatch_id IS NULL)` — one per unmarked row. That is a person's
   *   post (irrelevant: only agents are ever guard targets), an agent post with
   *   no trigger behind it (already stamped at the depth ceiling, so its cascade
   *   is spent anyway), and every row written before the column existed. Each
   *   costing one preserves exactly what those rows shipped under.
   *
   * **Scoped to the room, which now includes its threads.** A thread reply
   * carries the channel's `room_id` (ADR 260728-022013), so a cascade that opens
   * a thread keeps counting inside one cascade instead of resetting at a room
   * boundary the way a child-room thread did (room-participation spec §3.4).
   *
   * @param roomId - The room.
   * @param cascadeRoot - The entry id that began the cascade.
   */
  turnsByAuthorInCascade(roomId: string, cascadeRoot: string): Map<string, number> {
    const rows = this.db
      .select({
        authorId: roomEntries.authorId,
        // `IS NULL` yields 1/0 in SQLite, so the second half needs no CASE.
        turns: sql<number>`COUNT(DISTINCT ${roomEntries.dispatchId})
          + SUM(${roomEntries.dispatchId} IS NULL)`,
      })
      .from(roomEntries)
      .where(and(eq(roomEntries.roomId, roomId), eq(roomEntries.cascadeRoot, cascadeRoot)))
      .groupBy(roomEntries.authorId)
      .all();
    return new Map(rows.map((row) => [row.authorId, row.turns]));
  }

  // === Per-room agent sessions ===

  /**
   * The session an agent member answers in this room with, or `null` when it
   * has not answered here yet.
   *
   * @param roomId - The room.
   * @param authorId - The agent member.
   */
  getRoomSession(roomId: string, authorId: string): string | null {
    const row = this.db
      .select()
      .from(roomSessions)
      .where(and(eq(roomSessions.roomId, roomId), eq(roomSessions.authorId, authorId)))
      .get();
    return row?.sessionId ?? null;
  }

  /**
   * Every room-to-session binding stored, across every room.
   *
   * A whole-table read with nothing to scope it — cost grows with how many
   * rooms the install has ever had members in. That is fine for its one
   * caller, `GET /api/health/deep`, which an operator invokes by hand and
   * which needs every binding to answer whether any of them point at a
   * conversation that is gone. It is the wrong shape for anything a person
   * triggers by using the app: a room-scoped read belongs in
   * {@link RoomStore.getRoomSession}.
   *
   * @returns One entry per bound room member.
   */
  listRoomSessions(): Array<{ roomId: string; authorId: string; sessionId: string }> {
    return this.db
      .select({
        roomId: roomSessions.roomId,
        authorId: roomSessions.authorId,
        sessionId: roomSessions.sessionId,
      })
      .from(roomSessions)
      .all();
  }

  /**
   * Which of these session ids are room turns, and what to call the room.
   *
   * The read behind the session-origin room overlay
   * (`services/session/origin/room-origin-overlay.ts`). Scoped to the ids asked about —
   * unlike {@link RoomStore.listRoomSessions}, which is the unscoped whole-table
   * read a hand-run health check can afford — because this one runs on every
   * session list a person loads.
   *
   * **Bindings are keyed by the CURRENT session id.** A runtime renames a
   * session mid-turn and `RoomSessionLedger.rebindBySessionId` moves the binding
   * with it (DOR-784), so matching on `room_sessions.session_id` matches the
   * live id and a retired one correctly answers nothing.
   *
   * The label is what a person calls the room — `#slug` for a channel, the title
   * for a direct message — the same rule the client's `roomDisplayTitle`
   * follows. Archived rooms are included deliberately: the session still came
   * from that room, and a run whose room was archived is exactly the one a
   * reader would otherwise be unable to place.
   *
   * @param sessionIds - The sessions to ask about.
   * @returns One entry per bound session; absent means "not a room turn".
   */
  resolveRoomOrigins(sessionIds: string[]): Map<string, { roomLabel: string; roomId: string }> {
    const result = new Map<string, { roomLabel: string; roomId: string }>();
    if (sessionIds.length === 0) return result;
    const rows = this.db
      .select({
        sessionId: roomSessions.sessionId,
        roomId: rooms.id,
        kind: rooms.kind,
        slug: rooms.slug,
        title: rooms.title,
      })
      .from(roomSessions)
      .innerJoin(rooms, eq(rooms.id, roomSessions.roomId))
      .where(inArray(roomSessions.sessionId, sessionIds))
      .all();
    for (const row of rows) {
      // Several agents in one room answer with several sessions, so many ids can
      // map to the same room — but one id is bound in at most one place, and the
      // first row for it wins if that ever stops being true.
      if (result.has(row.sessionId)) continue;
      const label = row.kind === 'channel' && row.slug ? `#${row.slug}` : row.title;
      result.set(row.sessionId, { roomLabel: label, roomId: row.roomId });
    }
    return result;
  }

  /**
   * Bind an agent member's session for this room. First write wins, mirroring
   * the runtime binding it will carry (ADR-0255).
   *
   * @param roomId - The room.
   * @param authorId - The agent member.
   * @param sessionId - The session to bind.
   * @param createdAt - When the binding was made.
   * @returns The bound session id — the existing one when there already was one.
   */
  bindRoomSession(roomId: string, authorId: string, sessionId: string, createdAt: string): string {
    this.db
      .insert(roomSessions)
      .values({ roomId, authorId, sessionId, createdAt })
      .onConflictDoNothing()
      .run();
    return this.getRoomSession(roomId, authorId) ?? sessionId;
  }

  /**
   * Move an agent member's binding onto the session id its turn actually ran
   * under — the runtime's canonical id, which is not always the id the room
   * asked with.
   *
   * This is the one write that is deliberately NOT first-write-wins, and it has
   * to be an UPDATE rather than another {@link RoomStore.bindRoomSession}: the
   * insert there ignores conflicts, so the row minted before the first turn
   * would keep a throwaway id forever. Claude Code assigns its own session id
   * on the first turn and writes the transcript under THAT id; the room kept
   * the pre-turn UUID, and once the live session was swept for idleness (or the
   * server restarted) the next turn found no transcript under the bound id and
   * started the agent over from nothing — every idle window, silently.
   *
   * Called after every turn, not only the first. The canonical id is stable
   * while a conversation is, so this is a no-op write in the ordinary case, but
   * the SDK can assign a new id on a resume too (see `rebindSdkSession` in the
   * Claude Code session store), and the binding has to be whichever id the
   * transcript is under — always.
   *
   * **Refuses to move a binding back onto a RETIRED id** — an id the projector
   * has re-keyed away from, recorded by {@link RoomSessionLedger.retire}. That
   * record is durable (DOR-1205), so the refusal holds on the first request
   * after a restart rather than only once this process has watched a rename
   * itself — which is exactly the window a turn still in flight lands in.
   *
   * The reversal is not hypothetical and it is not the first turn. On turn 1 the
   * rekey listener wins and no rebind here has anything stale to say. It is the
   * SECOND rename that reaches this branch: the SDK can assign a new id on a
   * resume (`rebindSdkSession` in the Claude Code session store), the listener
   * moves the binding forward the moment it happens, and the turn that was in
   * flight then finishes and calls this with the id it read at its start. The
   * repair sweep racing a live turn reaches it the same way, from the other
   * side. Either one moved a binding back onto an id with no transcript, which
   * is how one room's binding was observed oscillating (00dfdce7 → 0e7270c6 →
   * 00dfdce7) and settling on the dead one.
   *
   * A refusal HERE is the only one that can be structural: every path that moves
   * a binding by `(room, agent)` goes through this method.
   *
   * @param roomId - The room.
   * @param authorId - The agent member.
   * @param sessionId - The session the turn ran on.
   * @returns Whether the binding moved. `false` means the refusal above fired,
   *   which a caller that is REPAIRING has to know: a repair sweep counting a
   *   refused write as a repair would report a room fixed while it is still
   *   pointing at a dead id, and stop reporting it as stranded.
   */
  rebindRoomSession(roomId: string, authorId: string, sessionId: string): boolean {
    const successor = this.sessionLedger.successorFor(sessionId);
    if (successor !== undefined) {
      logger.warn('[rooms] refused to rebind a room onto a retired session id', {
        roomId,
        authorId,
        retiredSessionId: sessionId,
        canonicalSessionId: successor,
      });
      return false;
    }
    this.db
      .update(roomSessions)
      .set({ sessionId })
      .where(and(eq(roomSessions.roomId, roomId), eq(roomSessions.authorId, authorId)))
      .run();
    return true;
  }
}

export type { NewRoom, NewRoomEntry } from './room-rows.js';
