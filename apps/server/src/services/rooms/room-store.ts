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
  rooms,
  roomMembers,
  roomEntries,
  roomSessions,
  roomBridges,
  eq,
  and,
  inArray,
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
} from '@dorkos/db';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { Room, RoomEntry, RoomKind, RoomMember } from '@dorkos/shared/room-schemas';
import { logger } from '../../lib/logger.js';
import { RoomSessionLedger } from './room-session-ledger.js';
import {
  toEntry,
  toMember,
  toRoom,
  type NewRoom,
  type NewRoomEntry,
  type ThreadAggregateRow,
} from './room-rows.js';

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
   */
  createRoom(
    room: NewRoom,
    members: ReadonlyArray<{ authorId: string; responseMode: ResponseMode; joinedAt: string }>,
    within?: (tx: DbTransaction) => void
  ): Room {
    const row = {
      ...room,
      wellKnown: room.wellKnown ?? null,
      archived: false,
      ambientMaxEntries: DEFAULT_AMBIENT_MAX_ENTRIES,
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
   * "Exactly" is the whole point and every word of it is load-bearing:
   *
   * - **The whole set, human included.** A DM is identified by who is in it, and
   *   the operator is in it. Matching on the agents alone would collapse two
   *   different conversations the moment a second human author exists.
   * - **Order-independent.** `[me, ana]` and `[ana, me]` are one conversation.
   *   The `IN` test does not care, and neither should a caller.
   * - **Not a superset, not a subset.** `COUNT(*)` pins the roster's size and
   *   the `SUM` pins how many of it were asked for; requiring both to equal the
   *   set's size is what makes "contains these agents" fail to match. A DM with
   *   Ana and Kai is not the DM with Ana.
   *
   * Archived DMs are matched too, and deliberately: the caller decides what to
   * do with one (`RoomService.createRoom` un-archives it), and a store that hid
   * them would leave the only way to reach that conversation being to mint a
   * second room with the same people in it.
   *
   * **A bridged room is never a match, enforced in the query** (chats-as-channels
   * spec §3.2, A3.2c). A bridged private chat's roster — the bound agent plus
   * the operator — is byte-identical to the operator's own private DM with that
   * agent, so without this exclusion this method would hand a stranger's chat
   * log back as the operator's private conversation, and would un-archive and
   * reuse it for a re-bridge. The `NOT IN (SELECT room_id FROM room_bridges)`
   * clause is what makes that impossible regardless of which call site reaches
   * this method — `RoomService.createBridgedRoom` also never calls it at all
   * (§3.2's create-path bypass), so the exclusion here is belt-and-braces for
   * every OTHER caller, present and future, that does.
   *
   * Ordering settles a tie that only pre-existing data can produce — nothing
   * creates a duplicate once `createRoom` consults this — so a live room is
   * preferred over an archived one and the oldest wins after that, rather than
   * leaving the answer to whichever index the planner picked.
   *
   * @param authorIds - The exact member set to match. Duplicates are collapsed.
   * @returns The matching DM, or `null` when no room holds exactly these authors.
   */
  findDmByMemberSet(authorIds: readonly string[]): Room | null {
    const wanted = [...new Set(authorIds)];
    if (wanted.length === 0) return null;
    const row = this.db
      .select({ room: rooms })
      .from(rooms)
      .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
      .where(
        and(
          eq(rooms.kind, 'dm'),
          sql`${rooms.id} NOT IN (SELECT ${roomBridges.roomId} FROM ${roomBridges})`
        )
      )
      .groupBy(rooms.id)
      .having(
        and(
          eq(count(), wanted.length),
          eq(
            sql<number>`SUM(CASE WHEN ${inArray(roomMembers.authorId, wanted)} THEN 1 ELSE 0 END)`,
            wanted.length
          )
        )
      )
      .orderBy(rooms.archived, rooms.createdAt)
      .get();
    return row ? toRoom(row.room) : null;
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
   * @param id - The room id.
   * @param patch - Fields to change; omitted fields are left alone.
   * @returns The updated room, or `null` when no such room exists.
   */
  updateRoom(
    id: string,
    patch: { title?: string; slug?: string; topic?: string | null; archived?: boolean }
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
    const exec = tx ?? this.db;
    const row = { ...member, joinedSeq: this.maxSeq(member.roomId), lastReadSeq: 0 };
    exec.insert(roomMembers).values(row).onConflictDoNothing().run();
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
   * Advance a member's read cursor. Monotonic: a lower value is ignored, so a
   * stale client cannot un-read a room for a second client.
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
   */
  removeMember(roomId: string, authorId: string): boolean {
    const existed = this.getMember(roomId, authorId) !== null;
    this.db
      .delete(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.authorId, authorId)))
      .run();
    this.db
      .delete(roomSessions)
      .where(and(eq(roomSessions.roomId, roomId), eq(roomSessions.authorId, authorId)))
      .run();
    return existed;
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
   * @param roomId - The room.
   * @param opts.before - Return entries with `seq` strictly below this.
   * @param opts.limit - Page size.
   */
  listEntries(roomId: string, opts: { before?: number; limit: number }): RoomEntry[] {
    const conditions = [eq(roomEntries.roomId, roomId)];
    if (opts.before !== undefined) conditions.push(lt(roomEntries.seq, opts.before));
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
   * @param opts.excludeEntryId - Drop the triggering entry; it IS the message.
   * @param opts.limit - How many of the newest to return.
   */
  listUnreadEntries(
    roomId: string,
    opts: {
      afterSeq: number;
      throughSeq: number;
      excludeAuthorId: string;
      excludeEntryId: string;
      limit: number;
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
          ne(roomEntries.id, opts.excludeEntryId),
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
          ne(roomEntries.authorId, opts.excludeAuthorId)
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
   */
  listThreadsForMember(viewerAuthorId: string, limit: number): ThreadAggregateRow[] {
    const root = alias(roomEntries, 'thread_root');
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
          unreadCount: sql<number>`SUM(CASE WHEN ${roomEntries.seq} > ${roomMembers.lastReadSeq} THEN 1 ELSE 0 END)`,
          lastActivityAt,
        })
        .from(roomEntries)
        .innerJoin(
          root,
          and(eq(root.roomId, roomEntries.roomId), eq(root.id, roomEntries.threadRootEntryId))
        )
        .innerJoin(rooms, eq(rooms.id, roomEntries.roomId))
        .innerJoin(
          roomMembers,
          and(eq(roomMembers.roomId, roomEntries.roomId), eq(roomMembers.authorId, viewerAuthorId))
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
   * The distinct authors already in one cascade — the ancestry rule's input.
   *
   * **Scoped to the room, which now includes its threads.** A thread reply
   * carries the channel's `room_id` (ADR 260728-022013), so a cascade that opens
   * a thread stays inside one ancestry set instead of resetting at a room
   * boundary the way a child-room thread did (room-participation spec §3.4).
   *
   * @param roomId - The room.
   * @param cascadeRoot - The entry id that began the cascade.
   */
  authorsInCascade(roomId: string, cascadeRoot: string): string[] {
    const rows = this.db
      .selectDistinct({ authorId: roomEntries.authorId })
      .from(roomEntries)
      .where(and(eq(roomEntries.roomId, roomId), eq(roomEntries.cascadeRoot, cascadeRoot)))
      .all();
    return rows.map((row) => row.authorId);
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
   * (`services/session/room-origin-overlay.ts`). Scoped to the ids asked about —
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
   * has re-keyed away from, recorded by {@link RoomSessionLedger.retire}.
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
   */
  rebindRoomSession(roomId: string, authorId: string, sessionId: string): void {
    const successor = this.sessionLedger.successorFor(sessionId);
    if (successor !== undefined) {
      logger.warn('[rooms] refused to rebind a room onto a retired session id', {
        roomId,
        authorId,
        retiredSessionId: sessionId,
        canonicalSessionId: successor,
      });
      return;
    }
    this.db
      .update(roomSessions)
      .set({ sessionId })
      .where(and(eq(roomSessions.roomId, roomId), eq(roomSessions.authorId, authorId)))
      .run();
  }
}

export type { NewRoom, NewRoomEntry } from './room-rows.js';
