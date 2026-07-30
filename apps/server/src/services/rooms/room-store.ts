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
  rooms,
  roomMembers,
  roomEntries,
  roomSessions,
  eq,
  and,
  inArray,
  lt,
  gt,
  ne,
  isNull,
  sql,
  count,
  desc,
  type Db,
} from '@dorkos/db';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { Room, RoomEntry, RoomKind, RoomMember } from '@dorkos/shared/room-schemas';
import { toEntry, toMember, toRoom, type NewRoom, type NewRoomEntry } from './room-rows.js';

/** Persistence for rooms, memberships, entries, and per-room agent sessions. */
export class RoomStore {
  constructor(private readonly db: Db) {}

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
   * @returns The inserted room.
   */
  createRoom(
    room: NewRoom,
    members: ReadonlyArray<{ authorId: string; responseMode: ResponseMode; joinedAt: string }>
  ): Room {
    const row = { ...room, archived: false, lastActivityAt: room.createdAt };
    this.db.transaction(
      (tx) => {
        tx.insert(rooms).values(row).run();
        for (const member of members) {
          tx.insert(roomMembers)
            .values({ ...member, roomId: room.id, lastReadSeq: 0 })
            .onConflictDoNothing()
            .run();
        }
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
      .where(eq(rooms.kind, 'dm'))
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
   * @returns The stored membership.
   */
  addMember(member: {
    roomId: string;
    authorId: string;
    responseMode: ResponseMode;
    joinedAt: string;
  }): RoomMember {
    const row = { ...member, lastReadSeq: 0 };
    this.db.insert(roomMembers).values(row).onConflictDoNothing().run();
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
   * @returns The stored entry, with its allocated `seq`.
   */
  appendEntry(entry: NewRoomEntry): RoomEntry {
    return this.db.transaction(
      (tx) => {
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

        return {
          roomId: entry.roomId,
          seq,
          id: entry.id,
          authorId: entry.authorId,
          kind: entry.kind,
          body: entry.body,
          mentions: [...entry.mentions],
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
   * @param roomId - The room.
   * @param opts.afterSeq - Return entries with `seq` strictly above this.
   * @param opts.excludeAuthorId - Drop this author's own entries; they are
   *   reported separately, outside the untrusted fence.
   * @param opts.excludeEntryId - Drop the triggering entry; it IS the message.
   * @param opts.limit - How many of the newest to return.
   */
  listUnreadEntries(
    roomId: string,
    opts: { afterSeq: number; excludeAuthorId: string; excludeEntryId: string; limit: number }
  ): RoomEntry[] {
    const rows = this.db
      .select()
      .from(roomEntries)
      .where(
        and(
          eq(roomEntries.roomId, roomId),
          gt(roomEntries.seq, opts.afterSeq),
          ne(roomEntries.authorId, opts.excludeAuthorId),
          ne(roomEntries.id, opts.excludeEntryId)
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
   * One caller, one meaning, and it is worth keeping it that way:
   * `RoomService.listRooms` reads it for the sidebar badge, which is what this
   * predicate is written for. It briefly had a second reader that took it as a
   * plain row count for a thread's `replyCount`, sound only while a thread had a
   * room to itself; that reader and the room kind behind it retired together
   * (ADR 260728-022013), and `countThreadReplies` is where a reply count comes
   * from now.
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
   * @param roomId - The room.
   * @param authorId - The agent member.
   * @param sessionId - The session the turn ran on.
   */
  rebindRoomSession(roomId: string, authorId: string, sessionId: string): void {
    this.db
      .update(roomSessions)
      .set({ sessionId })
      .where(and(eq(roomSessions.roomId, roomId), eq(roomSessions.authorId, authorId)))
      .run();
  }
}

export type { NewRoom, NewRoomEntry } from './room-rows.js';
