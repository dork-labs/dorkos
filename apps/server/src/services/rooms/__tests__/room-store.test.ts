/**
 * `seq` allocation is the one non-obvious thing {@link RoomStore} owns, and the
 * spec's claim about it — "SQLite serialises writers, so `COALESCE(MAX(seq),0)+1`
 * inside the insert transaction is safe and needs no counter table" — is load
 * bearing. So it is proved here under REAL concurrency (worker threads writing
 * to the same file database at the same time), not just asserted sequentially.
 *
 * The other property proved here is an absence: the room log is never trimmed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, eq, rooms, runMigrations, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { BridgeStore } from '../../relay/chat-bridge/bridge-store.js';
import { isDmMemberSetTaken, RoomStore, type NewRoomEntry } from '../room-store.js';
import { EVENT_LOG_MAX_EVENTS } from '../../session/replay/event-log.js';

const require = createRequire(import.meta.url);
const ROOM_ID = 'room-1';

/** A minimal appendable entry; the caller supplies whatever it wants to vary. */
function entry(overrides: Partial<NewRoomEntry> & { id: string }): NewRoomEntry {
  return {
    roomId: ROOM_ID,
    authorId: 'author-1',
    kind: 'post',
    body: { text: 'hello' },
    mentions: [],
    sessionId: null,
    cascadeRoot: overrides.id,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    createdAt: '2026-07-26T12:00:00.000Z',
    ...overrides,
  };
}

/** Seed a room so `appendEntry`'s `lastActivityAt` update has something to hit. */
function seedRoom(store: RoomStore, id = ROOM_ID): void {
  store.createRoom(
    {
      id,
      kind: 'channel',
      slug: id,
      title: `#${id}`,
      topic: null,
      createdAt: '2026-07-26T11:00:00.000Z',
    },
    []
  );
}

describe('RoomStore forward paging', () => {
  let store: RoomStore;

  beforeEach(() => {
    store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'e1' }));
    store.appendEntry(entry({ id: 'e2' }));
    store.appendEntry(entry({ id: 'r1', parentEntryId: 'e1', threadRootEntryId: 'e1' }));
    store.appendEntry(entry({ id: 'r2', parentEntryId: 'e1', threadRootEntryId: 'e1' }));
  });

  it('pages the top level oldest-first, and a thread reply is not on it', () => {
    // The default timeline is `parent_entry_id IS NULL`: a reply lives in this
    // room's log but belongs to its thread, not to the timeline.
    expect(store.listEntriesFrom(ROOM_ID, { afterSeq: 0, limit: 10 }).map((e) => e.id)).toEqual([
      'e1',
      'e2',
    ]);
    expect(store.listEntriesFrom(ROOM_ID, { afterSeq: 0, limit: 1 }).map((e) => e.id)).toEqual([
      'e1',
    ]);
    expect(store.listEntriesFrom(ROOM_ID, { afterSeq: 1, limit: 10 }).map((e) => e.id)).toEqual([
      'e2',
    ]);
  });

  it('pages one thread, scoped to its root', () => {
    expect(
      store
        .listEntriesFrom(ROOM_ID, { afterSeq: 0, limit: 10, threadRootEntryId: 'e1' })
        .map((e) => e.id)
    ).toEqual(['r1', 'r2']);
    expect(
      store.listEntriesFrom(ROOM_ID, { afterSeq: 0, limit: 10, threadRootEntryId: 'e2' }),
      'a root with no replies has an empty thread, not the room'
    ).toEqual([]);
  });

  it('rolls several threads up in one read, and never counts a root in its own replies', () => {
    const summaries = store.countThreadRepliesFor(ROOM_ID, ['e1', 'e2']);
    expect(summaries.get('e1')?.replyCount).toBe(2);
    expect(summaries.get('e1')?.lastReplyAt).toBe('2026-07-26T12:00:00.000Z');
    expect(summaries.has('e2'), 'a root with no replies is absent, not zero').toBe(false);
    expect(store.countThreadRepliesFor(ROOM_ID, []).size, 'an empty ask reads nothing').toBe(0);
  });
});

describe('RoomStore seq allocation', () => {
  let db: Db;
  let store: RoomStore;

  beforeEach(() => {
    db = createTestDb();
    store = new RoomStore(db);
    seedRoom(store);
  });

  it('allocates 1, 2, 3 … with no gaps', () => {
    const seqs = ['a', 'b', 'c'].map((id) => store.appendEntry(entry({ id })).seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('allocates per room, not globally', () => {
    seedRoom(store, 'room-2');
    expect(store.appendEntry(entry({ id: 'a' })).seq).toBe(1);
    expect(store.appendEntry(entry({ id: 'b', roomId: 'room-2' })).seq).toBe(1);
    expect(store.appendEntry(entry({ id: 'c' })).seq).toBe(2);
  });

  it('does not consume a seq when the insert rolls back', () => {
    store.appendEntry(entry({ id: 'a' }));
    // A duplicate entry id violates `room_entries_room_id_entry_id_unique`, so
    // the whole transaction rolls back — including the seq it had read.
    expect(() => store.appendEntry(entry({ id: 'a' }))).toThrow();
    expect(store.appendEntry(entry({ id: 'b' })).seq).toBe(2);
    expect(store.maxSeq(ROOM_ID)).toBe(2);
  });

  it('bumps the room activity in the same transaction as the entry', () => {
    store.appendEntry(entry({ id: 'a', createdAt: '2026-07-26T13:00:00.000Z' }));
    expect(store.getRoom(ROOM_ID)?.lastActivityAt).toBe('2026-07-26T13:00:00.000Z');
  });
});

describe('RoomStore.findDmByMemberSet', () => {
  let db: Db;
  let store: RoomStore;

  /**
   * Seed one room holding exactly these authors.
   *
   * @param id - The room id, also its title, so a failure names itself.
   * @param authorIds - The whole roster.
   * @param opts.kind - Defaults to `dm`.
   * @param opts.archived - Archive it after creating it.
   * @param opts.createdAt - Overrides the timestamp the tie-break reads.
   */
  function seedDm(
    id: string,
    authorIds: readonly string[],
    opts: {
      kind?: 'dm' | 'channel';
      archived?: boolean;
      createdAt?: string;
      bridged?: boolean;
    } = {}
  ): void {
    const createdAt = opts.createdAt ?? '2026-07-26T11:00:00.000Z';
    store.createRoom(
      {
        id,
        kind: opts.kind ?? 'dm',
        slug: opts.kind === 'channel' ? id : null,
        title: id,
        topic: null,
        bridged: opts.bridged,
        createdAt,
      },
      authorIds.map((authorId) => ({
        authorId,
        responseMode: 'always' as const,
        joinedAt: createdAt,
      }))
    );
    if (opts.archived) store.updateRoom(id, { archived: true });
  }

  /**
   * The `dm_member_key` column as stored — read straight from SQLite, because
   * `toRoom` strips it before anything else can see it.
   *
   * @param id - The room id.
   */
  function storedKey(id: string): string | null {
    const row = db.select({ key: rooms.dmMemberKey }).from(rooms).where(eq(rooms.id, id)).get();
    return row?.key ?? null;
  }

  beforeEach(() => {
    db = createTestDb();
    store = new RoomStore(db);
  });

  it('finds the DM whose roster is exactly the set asked for', () => {
    seedDm('dm-ana', ['me', 'ana']);
    expect(store.findDmByMemberSet(['me', 'ana'])?.id).toBe('dm-ana');
  });

  it('does not care what order the members were named in', () => {
    seedDm('dm-group', ['me', 'ana', 'kai']);
    expect(store.findDmByMemberSet(['kai', 'me', 'ana'])?.id).toBe('dm-group');
    expect(store.findDmByMemberSet(['ana', 'kai', 'me'])?.id).toBe('dm-group');
  });

  it('does not match a DM that merely CONTAINS the members asked for', () => {
    // "Me and Ana" is a different conversation from "me, Ana and Kai". A
    // superset match here would silently reopen the group chat instead.
    seedDm('dm-group', ['me', 'ana', 'kai']);
    expect(store.findDmByMemberSet(['me', 'ana'])).toBeNull();
  });

  it('does not match a DM that holds only SOME of the members asked for', () => {
    seedDm('dm-ana', ['me', 'ana']);
    expect(store.findDmByMemberSet(['me', 'ana', 'kai'])).toBeNull();
  });

  it('does not match a set that overlaps without being equal', () => {
    // Same size, one member different — the case a bare COUNT(*) check passes.
    seedDm('dm-ana', ['me', 'ana']);
    expect(store.findDmByMemberSet(['me', 'kai'])).toBeNull();
  });

  it('counts the human, so a DM is not identified by its agents alone', () => {
    seedDm('dm-ana', ['me', 'ana']);
    expect(store.findDmByMemberSet(['ana'])).toBeNull();
  });

  it('ignores a channel holding exactly those members', () => {
    seedDm('backend', ['me', 'ana'], { kind: 'channel' });
    expect(store.findDmByMemberSet(['me', 'ana'])).toBeNull();
  });

  it('matches an archived DM, leaving what to do with it to the caller', () => {
    seedDm('dm-ana', ['me', 'ana'], { archived: true });
    const found = store.findDmByMemberSet(['me', 'ana']);
    expect(found?.id).toBe('dm-ana');
    expect(found?.archived).toBe(true);
  });

  // The two tie-break tests that used to sit here — "prefers a live DM over an
  // archived one holding the same people" and "takes the oldest when two live
  // DMs hold the same people" — are GONE, and their disappearance is the point
  // of DOR-1616. Both seeded two DMs with one member set, which the partial
  // unique index now makes impossible: a tie-break for a state that cannot
  // exist is a test certifying a code path nothing can reach. What replaced
  // them is the refusal below, and migration 0085's own test, which keeps that
  // order — live before archived, oldest first — as the rule for choosing the
  // survivor among duplicates an OLD install already holds.

  it('refuses a second DM for a member set one already holds', () => {
    // The constraint DOR-1616 exists for, driven at the seam that used to have
    // none. Nothing above the store is involved: this is SQLite saying no.
    seedDm('dm-ana', ['me', 'ana']);
    expect(() => seedDm('dm-ana-again', ['me', 'ana'])).toThrow(/UNIQUE constraint failed/);
    expect(store.listRooms({ kind: 'dm' }).map((room) => room.id)).toEqual(['dm-ana']);
  });

  it('refuses it whichever order the second caller named the members in', () => {
    // The key is sorted, so `[ana, me]` is the same conversation as `[me, ana]`
    // to the CONSTRAINT and not merely to the query above it.
    seedDm('dm-ana', ['me', 'ana']);
    expect(() => seedDm('dm-ana-again', ['ana', 'me'])).toThrow(/UNIQUE constraint failed/);
  });

  it('refuses it even when the room that holds the set is archived', () => {
    // Archiving releases a channel's `#slug` and deliberately does NOT release a
    // DM's member set: the way back to a conversation you put away is to ask for
    // it again, and a second room would strand the history in the first.
    seedDm('dm-ana', ['me', 'ana'], { archived: true });
    expect(() => seedDm('dm-ana-again', ['me', 'ana'])).toThrow(/UNIQUE constraint failed/);
  });

  it('lets two DMs with DIFFERENT rosters coexist', () => {
    // The complement, so the assertions above cannot be passing because the
    // index refuses everything.
    seedDm('dm-ana', ['me', 'ana']);
    seedDm('dm-kai', ['me', 'kai']);
    seedDm('dm-group', ['me', 'ana', 'kai']);
    expect(store.findDmByMemberSet(['me', 'ana'])?.id).toBe('dm-ana');
    expect(store.findDmByMemberSet(['me', 'kai'])?.id).toBe('dm-kai');
    expect(store.findDmByMemberSet(['me', 'ana', 'kai'])?.id).toBe('dm-group');
  });

  it('lets two BRIDGED chats with the same roster coexist, and beside a private DM too', () => {
    // The whole reason a bridged room carries a NULL key. Two Telegram chats can
    // hold the same pair — a person's DM and a group of two — and neither is the
    // operator's own private conversation with that agent, which sits beside
    // them under the key.
    seedDm('dm-ana', ['me', 'ana']);
    seedDm('bridged-1', ['me', 'ana'], { bridged: true });
    seedDm('bridged-2', ['me', 'ana'], { bridged: true });
    expect(storedKey('dm-ana')).toBe('ana,me');
    expect(storedKey('bridged-1')).toBeNull();
    expect(storedKey('bridged-2')).toBeNull();
    expect(store.findDmByMemberSet(['me', 'ana'])?.id).toBe('dm-ana');
  });

  it('stores no key for a channel, so two channels may hold the same people', () => {
    seedDm('backend', ['me', 'ana'], { kind: 'channel' });
    seedDm('design', ['me', 'ana'], { kind: 'channel' });
    expect(storedKey('backend')).toBeNull();
    expect(storedKey('design')).toBeNull();
  });

  it('never lets the key reach a reader of the room', () => {
    // Server-side accounting, like `room_entries.dispatch_id`: it names other
    // people's authors and belongs in no SSE frame or API response.
    seedDm('dm-ana', ['me', 'ana']);
    expect(storedKey('dm-ana')).toBe('ana,me');
    expect(store.getRoom('dm-ana')).not.toHaveProperty('dmMemberKey');
    expect(store.findDmByMemberSet(['me', 'ana'])).not.toHaveProperty('dmMemberKey');
    expect(store.listRooms({ kind: 'dm' })[0]).not.toHaveProperty('dmMemberKey');
  });

  describe('the key follows the roster', () => {
    it('moves when a member joins a DM, so the lookup follows the conversation', () => {
      seedDm('dm-ana', ['me', 'ana']);
      store.addMember({
        roomId: 'dm-ana',
        authorId: 'kai',
        responseMode: 'always',
        joinedAt: '2026-07-27T11:00:00.000Z',
      });

      expect(storedKey('dm-ana')).toBe('ana,kai,me');
      // The old set is free again — and it has to be, or the person could never
      // open the two-person conversation the group grew out of.
      expect(store.findDmByMemberSet(['me', 'ana'])).toBeNull();
      expect(store.findDmByMemberSet(['me', 'ana', 'kai'])?.id).toBe('dm-ana');
    });

    it('moves when a member leaves', () => {
      seedDm('dm-group', ['me', 'ana', 'kai']);
      expect(store.removeMember('dm-group', 'kai')).toBe(true);

      expect(storedKey('dm-group')).toBe('ana,me');
      expect(store.findDmByMemberSet(['me', 'ana'])?.id).toBe('dm-group');
      expect(store.findDmByMemberSet(['me', 'ana', 'kai'])).toBeNull();
    });

    it('refuses a join that would duplicate another DM, and leaves the roster alone', () => {
      // DOR-793 point 1, from the other side of the same table: without the
      // constraint this left two rooms holding `[me, ana]` and the lookup
      // silently preferring one of them. The roster write is in the same
      // transaction as the key, so the refusal rolls both back.
      seedDm('dm-ana', ['me', 'ana']);
      seedDm('dm-solo', ['me']);

      expect(() =>
        store.addMember({
          roomId: 'dm-solo',
          authorId: 'ana',
          responseMode: 'always',
          joinedAt: '2026-07-27T11:00:00.000Z',
        })
      ).toThrow(/UNIQUE constraint failed/);

      expect(store.listMembers('dm-solo').map((member) => member.authorId)).toEqual(['me']);
      expect(storedKey('dm-solo')).toBe('me');
      expect(store.findDmByMemberSet(['me', 'ana'])?.id).toBe('dm-ana');
    });

    it('refuses a departure that would duplicate another DM, and keeps the member', () => {
      seedDm('dm-ana', ['me', 'ana']);
      seedDm('dm-group', ['me', 'ana', 'kai']);

      expect(() => store.removeMember('dm-group', 'kai')).toThrow(/UNIQUE constraint failed/);

      expect(
        store
          .listMembers('dm-group')
          .map((member) => member.authorId)
          .sort()
      ).toEqual(['ana', 'kai', 'me']);
      expect(storedKey('dm-group')).toBe('ana,kai,me');
      // And the session binding the same statement drops is still there — the
      // rollback covers all three writes, not just the two that touch a key.
      expect(store.findDmByMemberSet(['me', 'ana'])?.id).toBe('dm-ana');
    });

    it('leaves a BRIDGED room out of the dedupe however its roster moves', () => {
      // A bridged chat's roster changes constantly — an external person joins on
      // their first message (chats-as-channels §4.2) — and none of it may pull
      // the room into a constraint its identity has nothing to do with.
      seedDm('bridged-1', ['me', 'ana'], { bridged: true });
      seedDm('dm-ana', ['me', 'ana']);
      store.addMember({
        roomId: 'bridged-1',
        authorId: 'tel-person',
        responseMode: 'silent',
        joinedAt: '2026-07-27T11:00:00.000Z',
      });

      expect(storedKey('bridged-1')).toBeNull();
      expect(store.findDmByMemberSet(['me', 'ana'])?.id).toBe('dm-ana');
      expect(store.findDmByMemberSet(['me', 'ana', 'tel-person'])).toBeNull();
    });

    it('drops the key when a DM is emptied of everybody', () => {
      // A room with nobody in it has no member set to be found by, and
      // `findDmByMemberSet([])` has always answered null — so the honest state is
      // NULL rather than a row sitting in the index under an empty string.
      seedDm('dm-ana', ['me', 'ana']);
      store.removeMember('dm-ana', 'ana');
      store.removeMember('dm-ana', 'me');

      expect(storedKey('dm-ana')).toBeNull();
      expect(store.findDmByMemberSet([])).toBeNull();
    });

    it('does NOT bring the key back when an emptied DM is repopulated', () => {
      // The accepted regression, asserted rather than only described in
      // `syncDmMemberKey`'s doc — the member-count query this replaced would
      // have handed the original room back here. Pinned so that changing the
      // rule is a red test rather than a paragraph somebody has to notice.
      //
      // Narrow on purpose: emptying a DM at all takes removing YOURSELF last,
      // and the room keeps its entire history. What it loses is the ability to
      // be resolved by asking for those people again.
      seedDm('dm-ana', ['me', 'ana']);
      store.removeMember('dm-ana', 'ana');
      store.removeMember('dm-ana', 'me');

      store.addMember({
        roomId: 'dm-ana',
        authorId: 'me',
        responseMode: 'always',
        joinedAt: '2026-07-27T11:00:00.000Z',
      });
      store.addMember({
        roomId: 'dm-ana',
        authorId: 'ana',
        responseMode: 'always',
        joinedAt: '2026-07-27T11:00:00.000Z',
      });

      expect(storedKey('dm-ana')).toBeNull();
      expect(store.findDmByMemberSet(['me', 'ana'])).toBeNull();
      // So the set is free, and a fresh open takes it — a second room beside the
      // first, which is what the doc says happens and why it says it plainly.
      seedDm('dm-ana-2', ['me', 'ana']);
      expect(store.findDmByMemberSet(['me', 'ana'])?.id).toBe('dm-ana-2');
    });

    it('self-heals a PARTIAL emptying, which is every reachable case but one', () => {
      // The complement, and the reason the loss above is acceptable: a roster
      // that still holds somebody recomputes a real key on the very next write,
      // so nothing except a DM emptied all the way down ever leaves the dedupe.
      seedDm('dm-group', ['me', 'ana', 'kai']);
      store.removeMember('dm-group', 'ana');
      store.removeMember('dm-group', 'kai');

      expect(storedKey('dm-group')).toBe('me');
      store.addMember({
        roomId: 'dm-group',
        authorId: 'ana',
        responseMode: 'always',
        joinedAt: '2026-07-27T11:00:00.000Z',
      });

      expect(storedKey('dm-group')).toBe('ana,me');
      expect(store.findDmByMemberSet(['me', 'ana'])?.id).toBe('dm-group');
    });

    it('never keys a DM that was CREATED with an empty roster', () => {
      // Reachable only by a direct store call — `RoomService.createRoom` always
      // seeds at least its creator — and the doc claims it stays out forever, so
      // that is asserted here rather than assumed from the create path.
      seedDm('dm-nobody', []);
      expect(storedKey('dm-nobody')).toBeNull();

      store.addMember({
        roomId: 'dm-nobody',
        authorId: 'me',
        responseMode: 'always',
        joinedAt: '2026-07-27T11:00:00.000Z',
      });
      expect(storedKey('dm-nobody')).toBeNull();
    });
  });

  it('collapses a member named twice rather than failing to match', () => {
    seedDm('dm-ana', ['me', 'ana']);
    expect(store.findDmByMemberSet(['me', 'ana', 'ana'])?.id).toBe('dm-ana');
  });

  it('answers null for an empty set rather than matching an empty room', () => {
    seedDm('dm-empty', []);
    expect(store.findDmByMemberSet([])).toBeNull();
  });

  it('answers null when there is no DM at all', () => {
    expect(store.findDmByMemberSet(['me', 'ana'])).toBeNull();
  });

  // chats-as-channels spec §3.2, A3.2c: the exclusion holds in the STORE, not by
  // any caller's convention — proved by seeding a bridged room whose roster is
  // the EXACT set asked for and confirming the lookup never returns it, with no
  // `RoomService` in between that could be hiding a convention-only guard.
  //
  // What changed with DOR-1616 is WHERE it holds. It used to be a
  // `NOT IN (SELECT room_id FROM room_bridges)` clause inside this one query,
  // which every future copy of the query would have had to remember. Now a
  // bridged room simply has no key, and the lookup asks for one — so the
  // exclusion survives being rewritten, and the `room_bridges` row beside it is
  // corroboration rather than the mechanism.
  it('never returns a bridged room, even one whose roster matches exactly (A3.2c)', () => {
    seedDm('bridged-ana', ['me', 'ana'], { bridged: true });
    new BridgeStore(db).createBridge({
      roomId: 'bridged-ana',
      adapterId: 'tg-main',
      chatId: '555',
      channelType: null,
      platformChatType: 'private',
      bindingId: 'binding-1',
      platformTitle: null,
      deliverNotices: true,
      createdAt: '2026-07-26T11:00:00.000Z',
    });

    expect(store.findDmByMemberSet(['me', 'ana'])).toBeNull();
  });

  it('still finds the private DM when a bridged room holds the same people', () => {
    // The pair that used to be indistinguishable: a bridged private chat's
    // roster is the bound agent plus the operator, byte for byte the operator's
    // own DM with that agent. The bridged room sorts first by every order the
    // old query could have fallen back on, and it must still lose.
    seedDm('aaa-bridged', ['me', 'ana'], {
      bridged: true,
      createdAt: '2026-07-20T10:00:00.000Z',
    });
    seedDm('zzz-plain', ['me', 'ana'], { createdAt: '2026-07-26T10:00:00.000Z' });
    new BridgeStore(db).createBridge({
      roomId: 'aaa-bridged',
      adapterId: 'tg-main',
      chatId: '555',
      channelType: null,
      platformChatType: 'private',
      bindingId: 'binding-1',
      platformTitle: null,
      deliverNotices: true,
      createdAt: '2026-07-20T10:00:00.000Z',
    });

    expect(store.findDmByMemberSet(['me', 'ana'])?.id).toBe('zzz-plain');
  });
});

describe('RoomStore thread pointers and the counters over them', () => {
  let store: RoomStore;

  beforeEach(() => {
    store = new RoomStore(createTestDb());
    seedRoom(store);
  });

  it('round-trips both pointers through the insert', () => {
    store.appendEntry(entry({ id: 'root' }));
    store.appendEntry(entry({ id: 'reply', parentEntryId: 'root', threadRootEntryId: 'root' }));

    const stored = store.getEntryById(ROOM_ID, 'reply');
    expect(stored?.parentEntryId).toBe('root');
    expect(stored?.threadRootEntryId).toBe('root');
    // And the root stays outside its own thread, which is what makes the count
    // below mean "replies".
    expect(store.getEntryById(ROOM_ID, 'root')?.threadRootEntryId).toBeNull();
  });

  it('counts one thread replies, not the room, and not another thread', () => {
    store.appendEntry(entry({ id: 'root-a' }));
    store.appendEntry(entry({ id: 'root-b' }));
    store.appendEntry(entry({ id: 'top-level' }));
    for (const id of ['a1', 'a2', 'a3']) {
      store.appendEntry(entry({ id, parentEntryId: 'root-a', threadRootEntryId: 'root-a' }));
    }
    store.appendEntry(entry({ id: 'b1', parentEntryId: 'root-b', threadRootEntryId: 'root-b' }));

    expect(store.countThreadReplies(ROOM_ID, 'root-a')).toBe(3);
    expect(store.countThreadReplies(ROOM_ID, 'root-b')).toBe(1);
    // A root nobody answered has no replies — not "the room's entries".
    expect(store.countThreadReplies(ROOM_ID, 'top-level')).toBe(0);
  });

  it('is scoped to one room', () => {
    seedRoom(store, 'room-2');
    store.appendEntry(entry({ id: 'root' }));
    store.appendEntry(entry({ id: 'here', parentEntryId: 'root', threadRootEntryId: 'root' }));
    store.appendEntry(
      entry({ id: 'there', roomId: 'room-2', parentEntryId: 'root', threadRootEntryId: 'root' })
    );

    expect(store.countThreadReplies(ROOM_ID, 'root')).toBe(1);
    expect(store.countThreadReplies('room-2', 'root')).toBe(1);
  });

  it('keeps countUnread counting every entry, thread replies included', () => {
    // **Pinned deliberately, because filtering this is the tempting mistake**
    // (DOR-634). The read cursor is only ever advanced to the newest entry in
    // the array the client was handed, and that array is unfiltered — so a count
    // that excluded thread replies would leave a badge nothing can clear.
    store.appendEntry(entry({ id: 'root' }));
    store.appendEntry(entry({ id: 'r1', parentEntryId: 'root', threadRootEntryId: 'root' }));
    store.appendEntry(entry({ id: 'r2', parentEntryId: 'root', threadRootEntryId: 'root' }));

    expect(store.countUnread(ROOM_ID, 0)).toBe(3);
    expect(store.countUnread(ROOM_ID, 1)).toBe(2);
    // The room's true max seq, which is what the mark-read path writes: reading
    // the room clears the badge, threads and all.
    expect(store.countUnread(ROOM_ID, store.maxSeq(ROOM_ID))).toBe(0);
  });
});

describe('RoomStore.listUnreadEntries', () => {
  /** A room holding `total` entries by `author`, plus the seeded room row. */
  function roomWith(total: number, authorId = 'human'): RoomStore {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    for (let i = 1; i <= total; i += 1) {
      store.appendEntry(entry({ id: `e-${i}`, authorId, body: { text: `m${i}` } }));
    }
    return store;
  }

  it('returns the NEWEST entries above the cursor, oldest first', () => {
    const store = roomWith(10);
    const rows = store.listUnreadEntries(ROOM_ID, {
      afterSeq: 0,
      throughSeq: Number.MAX_SAFE_INTEGER,
      excludeAuthorId: 'ana',
      excludeEntryIds: [],
      limit: 3,
    });
    expect(rows.map((e) => e.body.text)).toEqual(['m8', 'm9', 'm10']);
  });

  it('returns a bounded page from an unbounded log', () => {
    // The quadratic shape this replaced: `listEntriesAfter` plus a `slice` in
    // JS, over a cursor that is 0 for every agent until RP3 advances it — so
    // every turn read the whole log to keep the tail of it. Both reads are put
    // side by side because the contrast is the measurement: one is bounded by
    // its argument, the other by the room's history.
    const store = roomWith(500);
    const page = store.listUnreadEntries(ROOM_ID, {
      afterSeq: 0,
      throughSeq: Number.MAX_SAFE_INTEGER,
      excludeAuthorId: 'ana',
      excludeEntryIds: [],
      limit: 31,
    });
    expect(page).toHaveLength(31);
    expect(page[page.length - 1].body.text).toBe('m500');
    expect(store.listEntriesAfter(ROOM_ID, 0)).toHaveLength(500);
  });

  it('excludes the reading author own entries and the triggering entry', () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'from-human', authorId: 'human' }));
    store.appendEntry(entry({ id: 'from-ana', authorId: 'ana' }));
    store.appendEntry(entry({ id: 'the-trigger', authorId: 'human' }));

    const rows = store.listUnreadEntries(ROOM_ID, {
      afterSeq: 0,
      throughSeq: Number.MAX_SAFE_INTEGER,
      excludeAuthorId: 'ana',
      excludeEntryIds: ['the-trigger'],
      limit: 30,
    });
    expect(rows.map((e) => e.id)).toEqual(['from-human']);
  });

  it('honours the cursor', () => {
    const store = roomWith(5);
    const rows = store.listUnreadEntries(ROOM_ID, {
      afterSeq: 3,
      throughSeq: Number.MAX_SAFE_INTEGER,
      excludeAuthorId: 'ana',
      excludeEntryIds: [],
      limit: 30,
    });
    expect(rows.map((e) => e.body.text)).toEqual(['m4', 'm5']);
  });

  it('closes the window at the top too, so a turn never sees past its trigger', () => {
    // The ceiling is what makes the claim-time cursor advance safe: a message
    // that lands while a turn is being assembled belongs to the NEXT turn's
    // window, because the cursor the claim wrote stops at the trigger. Without
    // it the newest-first page would reach past the ceiling and hand the same
    // entry to two turns in a row (room-participation spec §8.3).
    const store = roomWith(10);
    const rows = store.listUnreadEntries(ROOM_ID, {
      afterSeq: 3,
      throughSeq: 6,
      excludeAuthorId: 'ana',
      excludeEntryIds: [],
      limit: 30,
    });
    expect(rows.map((e) => e.body.text)).toEqual(['m4', 'm5', 'm6']);
  });
});

describe('RoomStore top-level channel reads', () => {
  const BOUNDS = {
    throughSeq: Number.MAX_SAFE_INTEGER,
    excludeAuthorId: 'ana',
    excludeEntryId: 'none',
  };

  /** A room with one top-level post per text, plus whatever `extra` adds. */
  function roomWith(texts: string[], extra: NewRoomEntry[] = []): RoomStore {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    texts.forEach((text, i) => {
      store.appendEntry(entry({ id: `t-${i + 1}`, authorId: 'human', body: { text } }));
    });
    for (const row of extra) store.appendEntry(row);
    return store;
  }

  it('returns the NEWEST top-level entries above the floor, oldest first', () => {
    const store = roomWith(['c1', 'c2', 'c3', 'c4']);
    const rows = store.listRecentTopLevelEntries(ROOM_ID, {
      ...BOUNDS,
      afterSeq: 0,
      limit: 2,
    });
    expect(rows.map((e) => e.body.text)).toEqual(['c3', 'c4']);
  });

  it('reads nothing at all for a limit of zero or less', () => {
    // A caller asking for no rows must not reach SQLite: a negative LIMIT is
    // UNLIMITED there, so the one number most obviously meaning "nothing" would
    // return the whole room.
    const store = roomWith(['c1', 'c2']);
    expect(store.listRecentTopLevelEntries(ROOM_ID, { ...BOUNDS, afterSeq: 0, limit: 0 })).toEqual(
      []
    );
    expect(store.listRecentTopLevelEntries(ROOM_ID, { ...BOUNDS, afterSeq: 0, limit: -1 })).toEqual(
      []
    );
  });

  it('honours the floor, so nothing said before the member joined is read', () => {
    const store = roomWith(['c1', 'c2', 'c3']);
    const rows = store.listRecentTopLevelEntries(ROOM_ID, { ...BOUNDS, afterSeq: 2, limit: 5 });
    expect(rows.map((e) => e.body.text)).toEqual(['c3']);
  });

  it('closes the window at the trigger, exactly as the unread window does', () => {
    const store = roomWith(['c1', 'c2', 'c3', 'c4']);
    const rows = store.listRecentTopLevelEntries(ROOM_ID, {
      ...BOUNDS,
      throughSeq: 2,
      afterSeq: 0,
      limit: 5,
    });
    expect(rows.map((e) => e.body.text)).toEqual(['c1', 'c2']);
  });

  it('reads posts only, so no notice eats a slot in the glance', () => {
    // Five slots is the whole budget, and a notice is the room narrating itself
    // rather than anybody talking. Reading posts only also subsumes the
    // subject filter `listUnreadEntries` needs: `subjectAuthorId` is written
    // exactly when `kind === 'notice'`, so a notice ABOUT the reader — the room
    // saying "Ana was busy" back to Ana — cannot reach this read either.
    const store = roomWith(
      ['c1'],
      [
        entry({
          id: 'notice-about-ana',
          authorId: 'system',
          kind: 'notice',
          body: { text: 'Ana was busy', subjectAuthorId: 'ana' },
        }),
        entry({
          id: 'notice-about-bo',
          authorId: 'system',
          kind: 'notice',
          body: { text: 'Bo was busy', subjectAuthorId: 'bo' },
        }),
      ]
    );
    const rows = store.listRecentTopLevelEntries(ROOM_ID, { ...BOUNDS, afterSeq: 0, limit: 5 });
    expect(rows.map((e) => e.id)).toEqual(['t-1']);
  });

  it('reads the channel only, never a thread reply hanging off it', () => {
    const store = roomWith(
      ['c1'],
      [
        entry({
          id: 'reply',
          authorId: 'human',
          body: { text: 'in the thread' },
          parentEntryId: 't-1',
          threadRootEntryId: 't-1',
        }),
      ]
    );
    const rows = store.listRecentTopLevelEntries(ROOM_ID, { ...BOUNDS, afterSeq: 0, limit: 5 });
    expect(rows.map((e) => e.body.text)).toEqual(['c1']);
  });

  it('excludes the reading agent own posts and the one named entry', () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'from-human', authorId: 'human' }));
    store.appendEntry(entry({ id: 'from-ana', authorId: 'ana' }));
    store.appendEntry(entry({ id: 'the-root', authorId: 'human' }));

    const rows = store.listRecentTopLevelEntries(ROOM_ID, {
      ...BOUNDS,
      excludeEntryId: 'the-root',
      afterSeq: 0,
      limit: 5,
    });
    expect(rows.map((e) => e.id)).toEqual(['from-human']);
  });

  it('counts exactly what the list would have returned without a limit', () => {
    // The two reads answer "show me five" and "how many are there", and the
    // omitted count is their difference — so a predicate that drifted between
    // them would report a number about a different set of messages.
    const store = roomWith(
      ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
      [
        entry({
          id: 'notice',
          authorId: 'system',
          kind: 'notice',
          body: { text: 'Ana was busy', subjectAuthorId: 'ana' },
        }),
        entry({ id: 'mine', authorId: 'ana', body: { text: 'my own' } }),
        entry({
          id: 'reply',
          authorId: 'human',
          body: { text: 'threaded' },
          parentEntryId: 't-1',
          threadRootEntryId: 't-1',
        }),
      ]
    );
    const opts = { ...BOUNDS, excludeEntryId: 't-1', afterSeq: 1 };
    const all = store.listRecentTopLevelEntries(ROOM_ID, { ...opts, limit: 100 });
    expect(store.countRecentTopLevelEntries(ROOM_ID, opts)).toBe(all.length);
    expect(all.map((e) => e.body.text)).toEqual(['c2', 'c3', 'c4', 'c5', 'c6']);
  });
});

describe('RoomStore.rewindReadCursor', () => {
  /** A room with one member whose cursor has been advanced to `at`. */
  function memberAt(at: number): RoomStore {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.addMember({
      roomId: ROOM_ID,
      authorId: 'ana',
      responseMode: 'always',
      joinedAt: '2026-07-26T11:00:00.000Z',
    });
    store.setReadCursor(ROOM_ID, 'ana', at);
    return store;
  }

  it('puts the cursor back when it is still where the caller left it', () => {
    const store = memberAt(7);
    expect(store.rewindReadCursor(ROOM_ID, 'ana', { from: 7, to: 2 })?.lastReadSeq).toBe(2);
  });

  it('refuses when something else has moved it since', () => {
    // The whole reason this is a compare-and-set. A refused turn may release long
    // after a SECOND turn was claimed for the same member — and that turn WAS
    // shown its window, so walking its cursor back would replay the conversation
    // to it. The stale rewind has to miss, silently.
    const store = memberAt(7);
    store.setReadCursor(ROOM_ID, 'ana', 9);

    expect(store.rewindReadCursor(ROOM_ID, 'ana', { from: 7, to: 2 })?.lastReadSeq).toBe(9);
  });

  it('is what setReadCursor cannot do, which is why it is its own method', () => {
    // Pins the monotonic guarantee this deliberately does not relax: the mark-read
    // route must stay unable to un-read a room for a second client.
    const store = memberAt(7);
    expect(store.setReadCursor(ROOM_ID, 'ana', 2)?.lastReadSeq).toBe(7);
  });
});

describe('RoomStore.listEntriesByAuthor', () => {
  it('returns only that author newest entries, oldest first within the page', () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    // Interleaved, so a query that ignored the author would come back in a
    // different order AND with the wrong rows.
    for (let i = 1; i <= 6; i += 1) {
      store.appendEntry(entry({ id: `ana-${i}`, authorId: 'ana', body: { text: `ana ${i}` } }));
      store.appendEntry(entry({ id: `bo-${i}`, authorId: 'bo', body: { text: `bo ${i}` } }));
    }

    const recent = store.listEntriesByAuthor(ROOM_ID, 'ana', 3);
    expect(recent.map((e) => e.body.text)).toEqual(['ana 4', 'ana 5', 'ana 6']);
  });

  it('is scoped to one room', () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    seedRoom(store, 'room-2');
    store.appendEntry(entry({ id: 'here', authorId: 'ana' }));
    store.appendEntry(entry({ id: 'there', authorId: 'ana', roomId: 'room-2' }));

    expect(store.listEntriesByAuthor(ROOM_ID, 'ana', 10).map((e) => e.id)).toEqual(['here']);
  });

  it('is empty for an author that has said nothing', () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'a', authorId: 'ana' }));
    expect(store.listEntriesByAuthor(ROOM_ID, 'bo', 10)).toEqual([]);
  });
});

describe('RoomStore.roomsPostedInBy', () => {
  it('names every room an author wrote in, and no room they only sat in', () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    seedRoom(store, 'room-2');
    seedRoom(store, 'room-3');
    store.appendEntry(entry({ id: 'a', authorId: 'ana' }));
    store.appendEntry(entry({ id: 'b', authorId: 'ana', roomId: 'room-2' }));
    // Somebody else talking in room-3 must not put it in Ana's set.
    store.appendEntry(entry({ id: 'c', authorId: 'bo', roomId: 'room-3' }));

    expect([...store.roomsPostedInBy('ana')].sort()).toEqual([ROOM_ID, 'room-2']);
    expect([...store.roomsPostedInBy('bo')]).toEqual(['room-3']);
  });

  it('is empty for somebody who has never written anywhere', () => {
    // The fresh-install answer, and the one the sidebar's "say hi" suggestion
    // turns on — so it must be an empty set rather than an absent one.
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'a', authorId: 'ana' }));

    expect(store.roomsPostedInBy('bo').size).toBe(0);
  });

  it('reads the author index instead of scanning the whole log', () => {
    // The point of `idx_room_entries_author_room`: proving "never posted" is
    // otherwise a full scan of every room's entries, on a query the sidebar
    // runs on every room list. A returned value cannot show which, so ask
    // SQLite. Reds if the index is dropped and the migration with it.
    const db = createTestDb();
    const store = new RoomStore(db);
    seedRoom(store);
    store.appendEntry(entry({ id: 'a', authorId: 'ana' }));

    const sqlite = (db as unknown as { $client: import('better-sqlite3').Database }).$client;
    const plan = sqlite
      .prepare('EXPLAIN QUERY PLAN SELECT DISTINCT room_id FROM room_entries WHERE author_id = ?')
      .all('ana') as { detail: string }[];
    const detail = plan.map((row) => row.detail).join('; ');

    expect(detail).toContain('idx_room_entries_author_room');
    expect(detail).not.toContain('SCAN room_entries');
  });
});

describe('RoomStore.turnsByAuthorInCascade counts turns, not messages', () => {
  /** A cascade rooted at `root`, so every entry lands in the same count. */
  function inCascade(id: string, authorId: string, dispatchId?: string): NewRoomEntry {
    return entry({ id, authorId, cascadeRoot: 'root', cascadeDepth: 1, ...{ dispatchId } });
  }

  it('collapses every entry one turn wrote into a single turn', () => {
    // The DOR-1434 property, at the grain the query decides it: an agent that
    // says what it is doing three times and then answers has taken ONE turn.
    // Under the shipped `COUNT(*)` this read 4, which taxed an agent for being
    // legible about its work.
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'root', authorId: 'human' }));
    store.appendEntry(inCascade('n1', 'ana', 'dsp_1'));
    store.appendEntry(inCascade('n2', 'ana', 'dsp_1'));
    store.appendEntry(inCascade('n3', 'ana', 'dsp_1'));
    store.appendEntry(inCascade('answer', 'ana', 'dsp_1'));

    expect(store.turnsByAuthorInCascade(ROOM_ID, 'root').get('ana')).toBe(1);
  });

  it('counts each turn once and adds them up', () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'root', authorId: 'human' }));
    store.appendEntry(inCascade('a1', 'ana', 'dsp_1'));
    store.appendEntry(inCascade('a2', 'ana', 'dsp_1'));
    store.appendEntry(inCascade('a3', 'ana', 'dsp_2'));
    store.appendEntry(inCascade('b1', 'bo', 'dsp_3'));

    expect(store.turnsByAuthorInCascade(ROOM_ID, 'root').get('ana')).toBe(2);
    expect(store.turnsByAuthorInCascade(ROOM_ID, 'root').get('bo')).toBe(1);
  });

  it('charges an unmarked row one turn each, so old rows keep counting as they did', () => {
    // Rows written before `dispatch_id` existed carry null, and so does every
    // post with no turn behind it. Each costs one — which is exactly the
    // message-counting behaviour those rows shipped under, so a database that
    // predates this column is not silently re-interpreted.
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'root', authorId: 'human' }));
    store.appendEntry(inCascade('legacy1', 'ana'));
    store.appendEntry(inCascade('legacy2', 'ana'));
    store.appendEntry(inCascade('legacy3', 'ana'));

    expect(store.turnsByAuthorInCascade(ROOM_ID, 'root').get('ana')).toBe(3);
  });

  it('adds marked turns and unmarked rows together', () => {
    // The mixed cascade a real install upgrades into: some of Ana's rows predate
    // the column, and the turn she has taken since is one more on top.
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'root', authorId: 'human' }));
    store.appendEntry(inCascade('legacy1', 'ana'));
    store.appendEntry(inCascade('legacy2', 'ana'));
    store.appendEntry(inCascade('now1', 'ana', 'dsp_1'));
    store.appendEntry(inCascade('now2', 'ana', 'dsp_1'));

    expect(store.turnsByAuthorInCascade(ROOM_ID, 'root').get('ana')).toBe(3);
  });

  it('never counts another cascade or another room', () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    seedRoom(store, 'room-2');
    store.appendEntry(entry({ id: 'root', authorId: 'human' }));
    store.appendEntry(inCascade('mine', 'ana', 'dsp_1'));
    store.appendEntry(entry({ id: 'other', authorId: 'ana', cascadeRoot: 'other-root' }));
    store.appendEntry(
      entry({ id: 'elsewhere', authorId: 'ana', roomId: 'room-2', cascadeRoot: 'root' })
    );

    expect(store.turnsByAuthorInCascade(ROOM_ID, 'root').get('ana')).toBe(1);
  });
});

describe('RoomStore never trims the log', () => {
  // Deliberately heavy: proving the absence of a trim means writing past the cap
  // through the real append path, which is 5000+ IMMEDIATE transactions. The
  // default 5s budget is not enough for that on a loaded machine, and a timeout
  // here would read as "the log trims" — the exact thing this test denies.
  it(`keeps more than EVENT_LOG_MAX_EVENTS (${EVENT_LOG_MAX_EVENTS}) entries`, () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    const total = EVENT_LOG_MAX_EVENTS + 5;
    for (let i = 0; i < total; i++) store.appendEntry(entry({ id: `e-${i}` }));

    // The in-memory EventLog and session_events both evict oldest at this cap.
    // A room that forgot what was said would not be a room, so this one does not.
    expect(store.maxSeq(ROOM_ID)).toBe(total);
    expect(store.listEntriesAfter(ROOM_ID, 0)).toHaveLength(total);
    expect(store.listEntries(ROOM_ID, { limit: 1, before: 2 })[0].seq).toBe(1);
  }, 60_000);
});

describe('RoomStore per-room agent sessions', () => {
  let store: RoomStore;

  beforeEach(() => {
    store = new RoomStore(createTestDb());
  });

  it('binds first-write-wins and rebinds last-write-wins', () => {
    // Two writes, two different rules, and the difference is the point. The
    // bind resolves a race between two posts arriving before the first reply,
    // so it must not overwrite. The rebind records which session the turn ACTUALLY
    // ran on, so it must.
    const first = store.bindRoomSession(
      ROOM_ID,
      'author-ana',
      'placeholder',
      '2026-07-30T10:00:00.000Z'
    );
    const second = store.bindRoomSession(
      ROOM_ID,
      'author-ana',
      'a-later-guess',
      '2026-07-30T10:00:00.000Z'
    );
    expect(first).toBe('placeholder');
    expect(second).toBe('placeholder');

    store.rebindRoomSession(ROOM_ID, 'author-ana', 'sdk-canonical-9f3c');
    expect(store.getRoomSession(ROOM_ID, 'author-ana')).toBe('sdk-canonical-9f3c');
  });

  it('keeps each agent in the room to its own session', () => {
    store.bindRoomSession(ROOM_ID, 'author-ana', 'ana-1', '2026-07-30T10:00:00.000Z');
    store.bindRoomSession(ROOM_ID, 'author-bo', 'bo-1', '2026-07-30T10:00:00.000Z');

    store.rebindRoomSession(ROOM_ID, 'author-ana', 'ana-canonical');

    expect(store.getRoomSession(ROOM_ID, 'author-ana')).toBe('ana-canonical');
    expect(store.getRoomSession(ROOM_ID, 'author-bo')).toBe('bo-1');
  });

  it('writes nothing for an agent that has no binding yet', () => {
    // An UPDATE, never an upsert: a rebind is a correction to a binding that
    // exists, and inventing one here would resurrect a session for an agent
    // whose membership was just removed.
    store.rebindRoomSession(ROOM_ID, 'author-ana', 'sdk-canonical-9f3c');
    expect(store.getRoomSession(ROOM_ID, 'author-ana')).toBeNull();
  });
});

describe('RoomStore.listRooms ordering', () => {
  let store: RoomStore;

  beforeEach(() => {
    store = new RoomStore(createTestDb());
  });

  /** The agent whose membership scopes {@link RoomStore.listRoomsForMember}. */
  const ANA = 'author-ana';

  /** A channel created — and so last active — at `at`, with Ana on its roster. */
  function channelAt(id: string, at: string): void {
    store.createRoom(
      {
        id,
        kind: 'channel',
        slug: id,
        title: `#${id}`,
        topic: null,
        createdAt: at,
      },
      [{ authorId: ANA, responseMode: 'always', joinedAt: at }]
    );
  }

  it('answers newest activity first', () => {
    channelAt('old', '2026-07-26T10:00:00.000Z');
    channelAt('new', '2026-07-26T12:00:00.000Z');
    channelAt('mid', '2026-07-26T11:00:00.000Z');

    expect(store.listRooms().map((room) => room.id)).toEqual(['new', 'mid', 'old']);
  });

  it('breaks a tie on the id rather than leaving it to SQLite', () => {
    // Ties are the common case, not the corner: a room that has never been
    // posted in has `lastActivityAt === createdAt`, so any batch seeded in one
    // pass ties outright. Inserted a, c, b — an untied ORDER BY hands those back
    // in whatever order it likes, and the sidebar reshuffles on every refetch.
    const tied = '2026-07-26T10:00:00.000Z';
    channelAt('a', tied);
    channelAt('c', tied);
    channelAt('b', tied);

    expect(store.listRooms().map((room) => room.id)).toEqual(['c', 'b', 'a']);
  });

  it('orders an agent-scoped listing identically, ties included', () => {
    // `listRoomsForMember` is the agent-facing sibling and feeds the SAME
    // endpoint. Asserting only `listRooms` left this half free to drift, and
    // "the two must not disagree about what newest-first means" is the entire
    // reason its ORDER BY was touched — so it gets the same proof, not a
    // comment promising it.
    const tied = '2026-07-26T10:00:00.000Z';
    channelAt('a', tied);
    channelAt('c', tied);
    channelAt('b', tied);
    channelAt('newest', '2026-07-26T12:00:00.000Z');

    const scoped = store.listRoomsForMember(ANA).map((room) => room.id);
    expect(scoped).toEqual(['newest', 'c', 'b', 'a']);
    expect(scoped).toEqual(store.listRooms().map((room) => room.id));
  });
});

/**
 * The worker body. It mirrors `RoomStore.appendEntry`'s statements rather than
 * importing the store, because a worker cannot load this repo's TypeScript
 * without a build step — the point of these threads is to contend for the same
 * SQLite file at the same time, which is a property of the SQL, not the ORM.
 * The main thread writes through the real store into the same contention, so
 * the store's own path is exercised under it.
 */
const WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const Database = require(workerData.driver);
const db = new Database(workerData.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 20000');

const readNext = db.prepare(
  'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM room_entries WHERE room_id = ?'
);
const insert = db.prepare(
  'INSERT INTO room_entries (room_id, seq, id, author_id, kind, body, mentions, session_id, cascade_root, cascade_depth, signature, created_at)' +
    " VALUES (?, ?, ?, ?, 'post', '{\\"text\\":\\"x\\"}', '[]', NULL, ?, 0, NULL, '2026-07-26T12:00:00.000Z')"
);
const append = db.transaction((entryId) => {
  const seq = readNext.get(workerData.roomId).next;
  insert.run(workerData.roomId, seq, entryId, 'author-1', entryId);
  return seq;
});

parentPort.postMessage({ ready: true });
parentPort.once('message', () => {
  const seqs = [];
  for (let i = 0; i < workerData.count; i++) {
    seqs.push(append.immediate(workerData.label + '-' + i));
  }
  db.close();
  parentPort.postMessage({ seqs });
});
`;

/** Spawn one writer thread and resolve once it has signalled readiness. */
function spawnWriter(opts: {
  dbPath: string;
  roomId: string;
  label: string;
  count: number;
}): Promise<{ worker: Worker; done: Promise<number[]> }> {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { ...opts, driver: require.resolve('better-sqlite3') },
  });
  return new Promise((resolve, reject) => {
    const done = new Promise<number[]>((resolveDone, rejectDone) => {
      worker.on('message', (msg: { ready?: boolean; seqs?: number[] }) => {
        if (msg.ready) {
          resolve({ worker, done });
        } else if (msg.seqs) {
          resolveDone(msg.seqs);
        }
      });
      worker.on('error', (err) => {
        rejectDone(err);
        reject(err);
      });
    });
  });
}

describe('RoomStore seq allocation under concurrent writers', () => {
  let dir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-rooms-seq-'));
    dbPath = path.join(dir, 'rooms.db');
    db = createDb(dbPath);
    runMigrations(db);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never issues the same seq twice, and leaves no gaps', async () => {
    const store = new RoomStore(db);
    seedRoom(store);

    const perWriter = 20;
    const writers = await Promise.all(
      ['w1', 'w2', 'w3'].map((label) =>
        spawnWriter({ dbPath, roomId: ROOM_ID, label, count: perWriter })
      )
    );

    // All three threads are parked on the barrier. Release them and write from
    // this thread through the real store at the same time, so the drizzle path
    // is inside the contention rather than watching it.
    for (const { worker } of writers) worker.postMessage('go');
    const mine: number[] = [];
    for (let i = 0; i < perWriter; i++) {
      mine.push(store.appendEntry(entry({ id: `main-${i}` })).seq);
    }

    const theirs = await Promise.all(writers.map(({ done }) => done));
    await Promise.all(writers.map(({ worker }) => worker.terminate()));

    const all = [...mine, ...theirs.flat()].sort((a, b) => a - b);
    const expected = Array.from({ length: perWriter * 4 }, (_, i) => i + 1);

    expect(all).toEqual(expected);
    expect(new Set(all).size).toBe(all.length);
    expect(store.maxSeq(ROOM_ID)).toBe(perWriter * 4);
  }, 30_000);
});

describe('isDmMemberSetTaken names ONE of the three unique indexes on `rooms`', () => {
  // `RoomService.createRoom` adopts the winner when this answers true, and
  // rethrows when it does not, so a guard that widened to "any unique
  // violation" would turn a taken channel name into somebody else's room
  // handed back. That is the mutation these assertions exist to catch, and the
  // service-level test that looks like it would catch it cannot: the create
  // path's own `findLiveChannelBySlug` check refuses before the insert.
  //
  // **Driven by REAL SQLite failures, never by a hand-written message.** The
  // guard reads a string `better-sqlite3` composes from the schema; a fixture
  // that spelled that string itself would be certifying the fixture.
  let store: RoomStore;

  /** Run a write that must fail, and hand back what it threw. */
  function thrownBy(write: () => void): unknown {
    try {
      write();
    } catch (err) {
      return err;
    }
    throw new Error('the write was expected to fail and did not');
  }

  /** Open a room, with whatever collides supplied by the caller. */
  function open(
    id: string,
    room: { kind: 'dm' | 'channel'; slug?: string | null; wellKnown?: string | null },
    authorIds: readonly string[] = []
  ): void {
    store.createRoom(
      {
        id,
        kind: room.kind,
        slug: room.slug ?? null,
        title: id,
        topic: null,
        wellKnown: room.wellKnown ?? null,
        createdAt: '2026-07-26T11:00:00.000Z',
      },
      authorIds.map((authorId) => ({
        authorId,
        responseMode: 'always' as const,
        joinedAt: '2026-07-26T11:00:00.000Z',
      }))
    );
  }

  beforeEach(() => {
    store = new RoomStore(createTestDb());
  });

  it('answers true for the DM member-set index', () => {
    open('dm-ana', { kind: 'dm' }, ['me', 'ana']);
    expect(
      isDmMemberSetTaken(thrownBy(() => open('dm-again', { kind: 'dm' }, ['me', 'ana'])))
    ).toBe(true);
  });

  it('answers false for a taken channel slug', () => {
    open('backend', { kind: 'channel', slug: 'backend' });
    expect(
      isDmMemberSetTaken(thrownBy(() => open('backend-2', { kind: 'channel', slug: 'backend' })))
    ).toBe(false);
  });

  it('answers false for a taken well-known key', () => {
    open('team', { kind: 'channel', slug: 'team', wellKnown: 'team' });
    expect(
      isDmMemberSetTaken(
        thrownBy(() => open('team-2', { kind: 'channel', slug: 'team-2', wellKnown: 'team' }))
      )
    ).toBe(false);
  });

  it('answers false for a unique violation on another table entirely', () => {
    // `room_entries_room_id_entry_id_unique`, so the guard is not merely
    // distinguishing columns within one table.
    open('backend', { kind: 'channel', slug: 'backend' });
    store.appendEntry(entry({ roomId: 'backend', id: 'e1' }));
    expect(
      isDmMemberSetTaken(thrownBy(() => store.appendEntry(entry({ roomId: 'backend', id: 'e1' }))))
    ).toBe(false);
  });

  it('answers false for anything that is not an error at all', () => {
    expect(isDmMemberSetTaken(new Error('something else went wrong'))).toBe(false);
    expect(isDmMemberSetTaken(null)).toBe(false);
    expect(isDmMemberSetTaken('rooms.dm_member_key')).toBe(false);
  });

  it('finds it through a driver that WRAPPED the failure', () => {
    // The guard walks the cause chain because the error a caller catches is not
    // always the one SQLite threw — a dependency bump is free to wrap it, and a
    // guard reading only the outermost message would start answering false and
    // silently turn every adopt-the-winner path back into a 500.
    open('dm-ana', { kind: 'dm' }, ['me', 'ana']);
    const raw = thrownBy(() => open('dm-again', { kind: 'dm' }, ['me', 'ana']));
    const wrapped = new Error('Failed query: insert into "rooms"', { cause: raw });
    expect(isDmMemberSetTaken(wrapped)).toBe(true);
    expect(isDmMemberSetTaken(new Error('outer', { cause: wrapped })), 'two hops deep').toBe(true);
  });
});
