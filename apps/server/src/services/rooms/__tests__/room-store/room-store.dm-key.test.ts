/**
 * room-store: the DM member-set key.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq, rooms, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { BridgeStore } from '../../../relay/chat-bridge/bridge-store.js';
import { RoomStore } from '../../room-store.js';
import { isDmMemberSetTaken } from '../../manage/room-dm-key.js';

import { entry } from './room-store.fixtures.js';

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

  // Only an EQUAL set matches, in any order. "Me and Ana" is a different
  // conversation from "me, Ana and Kai", so a superset match would silently
  // reopen the group chat; the same-size overlap is the case a bare COUNT(*)
  // check passes; and the human counts, so a DM is not its agents alone.
  it.each([
    { seeded: ['me', 'ana'], asked: ['me', 'ana'], found: true },
    { seeded: ['me', 'ana', 'kai'], asked: ['kai', 'me', 'ana'], found: true },
    { seeded: ['me', 'ana', 'kai'], asked: ['me', 'ana'], found: false },
    { seeded: ['me', 'ana'], asked: ['me', 'ana', 'kai'], found: false },
    { seeded: ['me', 'ana'], asked: ['me', 'kai'], found: false },
    { seeded: ['me', 'ana'], asked: ['ana'], found: false },
  ])('asked for $asked with a DM of $seeded, finds it: $found', ({ seeded, asked, found }) => {
    seedDm('dm', seeded);
    expect(store.findDmByMemberSet(asked)?.id ?? null).toBe(found ? 'dm' : null);
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
