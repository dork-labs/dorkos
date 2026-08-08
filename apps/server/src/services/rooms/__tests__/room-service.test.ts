import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq, roomMembers, roomSessions, type Db } from '@dorkos/db';
import { agentAuthorRef } from '@dorkos/shared/room-schemas';
import { eventFanOut } from '../../core/event-fan-out.js';
import type { AuthorRegistry } from '../author-registry.js';
import type { ReadCursorService } from '../../core/read-cursor-service.js';
import type { RoomService } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import { RoomError } from '../room-errors.js';
import { agentLookupFor, createRoomHarness, scriptedRunner } from './room-test-harness.js';

/** Ana answers everything by manifest; Bo stays quiet unless mentioned. */
const agentLookup = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always', emoji: '🐙' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'silent' },
  // Two more bodies, so a roster whose order is left to chance has 120 ways to
  // come out and cannot match the expected one by luck.
  '/agents/cy': { name: 'cy', displayName: 'Cy', responseMode: 'silent' },
  '/agents/di': { name: 'di', displayName: 'Di', responseMode: 'silent' },
});

/**
 * How many statements touching `room_members` one `GET /api/rooms?kind=dm`
 * prepares, over an install holding `dmCount` direct messages.
 *
 * Counted off `better-sqlite3.prepare`, because the property under test — that
 * the roster is resolved in one pass — is invisible in the value returned. Only
 * the roster reads are counted: `listRooms` also issues one unread count per
 * room, which is a separate (and pre-existing) N+1 this is not measuring.
 *
 * @param dmCount - How many direct messages to seed first.
 */
function rosterReadsForListingDms(dmCount: number): number {
  // A DM per AGENT, not `dmCount` DMs with the same agent: a direct message is
  // idempotent on its member set, so asking for Ana 25 times is one room and
  // this measurement would quietly become "listing one room, twice" while still
  // reporting the number the assertion wants.
  const cast = Object.fromEntries(
    Array.from({ length: dmCount }, (_, i) => [
      `/agents/extra-${i}`,
      { name: `extra-${i}`, displayName: `Extra ${i}` },
    ])
  );
  const harness = createRoomHarness({ agents: agentLookupFor(cast) });
  for (let i = 0; i < dmCount; i++) {
    harness.service.createRoom(
      { kind: 'dm', title: `Extra ${i}`, members: [], agentPaths: [`/agents/extra-${i}`] },
      harness.human
    );
  }
  // Asserted here rather than left to the caller: the whole measurement is void
  // if the seeding did not actually produce `dmCount` distinct rooms.
  expect(harness.service.listRooms(harness.human, { kind: 'dm' })).toHaveLength(dmCount);
  // `$client` is the better-sqlite3 connection drizzle prepares against.
  const sqlite = (harness.db as unknown as { $client: { prepare: (sql: string) => unknown } })
    .$client;
  const prepare = vi.spyOn(sqlite, 'prepare');
  harness.service.listRooms(harness.human, { kind: 'dm' });
  const reads = prepare.mock.calls.filter(([sql]) => String(sql).includes('room_members')).length;
  prepare.mockRestore();
  return reads;
}

describe('RoomService', () => {
  let db: Db;
  let service: RoomService;
  let store: RoomStore;
  let authors: AuthorRegistry;
  let readCursors: ReadCursorService;
  let human: string;

  beforeEach(() => {
    ({ db, service, store, authors, readCursors, human } = createRoomHarness({
      agents: agentLookup,
    }));
  });

  describe('creating rooms', () => {
    it('derives a channel slug from its title and joins the creator', () => {
      const room = service.createRoom(
        { kind: 'channel', title: 'Backend Work', members: [], agentPaths: [] },
        human
      );

      expect(room.slug).toBe('backend-work');
      expect(room.members.map((m) => m.authorId)).toEqual([human]);
      expect(room.archived).toBe(false);
    });

    it('refuses a second live channel on the same slug', () => {
      service.createRoom(
        { kind: 'channel', slug: 'general', title: 'General', members: [], agentPaths: [] },
        human
      );
      expect(() =>
        service.createRoom(
          { kind: 'channel', slug: 'general', title: 'Also', members: [], agentPaths: [] },
          human
        )
      ).toThrow(RoomError);
    });

    it('releases the slug once the channel is archived', () => {
      const first = service.createRoom(
        { kind: 'channel', slug: 'general', title: 'General', members: [], agentPaths: [] },
        human
      );
      service.updateRoom(first.id, human, { archived: true });

      const second = service.createRoom(
        { kind: 'channel', slug: 'general', title: 'General again', members: [], agentPaths: [] },
        human
      );
      expect(second.slug).toBe('general');
    });

    it('refuses a channel title with nothing sluggable in it', () => {
      expect(() =>
        service.createRoom({ kind: 'channel', title: '🎉🎉', members: [], agentPaths: [] }, human)
      ).toThrow(/slug/i);
    });

    it('announces the new room on the global event stream', () => {
      const broadcast = vi.spyOn(eventFanOut, 'broadcast');
      const room = service.createRoom(
        { kind: 'dm', title: 'Ana', members: [], agentPaths: [] },
        human
      );
      expect(broadcast).toHaveBeenCalledWith(
        'room_created',
        expect.objectContaining({ roomId: room.id, kind: 'dm' })
      );
      broadcast.mockRestore();
    });
  });

  describe('seeding responseMode', () => {
    it('seeds a channel membership to engaged, whatever the manifest says', () => {
      const room = service.createRoom(
        { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
        human
      );
      const member = service.addMember(room.id, human, { agentPath: '/agents/ana' });
      expect(member.responseMode).toBe('engaged');
    });

    it('seeds a DM membership from the agent manifest', () => {
      const room = service.createRoom(
        { kind: 'dm', title: 'Ana', members: [], agentPaths: [] },
        human
      );
      expect(service.addMember(room.id, human, { agentPath: '/agents/ana' }).responseMode).toBe(
        'always'
      );
      expect(service.addMember(room.id, human, { agentPath: '/agents/bo' }).responseMode).toBe(
        'silent'
      );
    });

    it('takes an explicit override over either seed', () => {
      const room = service.createRoom(
        { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
        human
      );
      const member = service.addMember(room.id, human, {
        agentPath: '/agents/ana',
        responseMode: 'direct-only',
      });
      expect(member.responseMode).toBe('direct-only');
    });

    it('does not retroactively change a stored membership when a manifest would differ', () => {
      const room = service.createRoom(
        { kind: 'dm', title: 'Ana', members: [], agentPaths: [] },
        human
      );
      const joined = service.addMember(room.id, human, { agentPath: '/agents/ana' });
      service.updateMembership(room.id, human, joined.authorId, 'silent');
      expect(
        service.getRoom(room.id, human)?.members.find((m) => m.authorId === joined.authorId)
          ?.responseMode
      ).toBe('silent');
    });

    it('refuses an agent path nothing is registered at', () => {
      const room = service.createRoom(
        { kind: 'dm', title: 'Nobody', members: [], agentPaths: [] },
        human
      );
      expect(() => service.addMember(room.id, human, { agentPath: '/agents/ghost' })).toThrow(
        RoomError
      );
    });
  });

  describe('posting', () => {
    let roomId: string;
    let ana: string;

    beforeEach(() => {
      const room = service.createRoom(
        { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
        human
      );
      roomId = room.id;
      ana = service.addMember(roomId, human, { agentPath: '/agents/ana' }).authorId;
    });

    it('resolves mentions once, at write, and stores the resolved ids', () => {
      const entry = service.post(roomId, { authorId: human, text: 'can you check this @ana?' });
      expect(entry.mentions).toEqual([ana]);
    });

    it('starts a fresh cascade for an untriggered post', () => {
      const entry = service.post(roomId, { authorId: human, text: 'hello' });
      expect(entry.cascadeRoot).toBe(entry.id);
      expect(entry.cascadeDepth).toBe(0);
    });

    it('inherits cascade provenance from a trigger', () => {
      const seed = service.post(roomId, { authorId: human, text: 'hello' });
      const reply = service.post(roomId, {
        authorId: ana,
        text: 'on it',
        trigger: { root: seed.id, depth: 1 },
      });
      expect(reply.cascadeRoot).toBe(seed.id);
      expect(reply.cascadeDepth).toBe(1);
    });

    it('refuses a post from someone who is not in the room', () => {
      const outsider = authors.resolveAgent('/agents/bo', 'Bo').id;
      expect(() => service.post(roomId, { authorId: outsider, text: 'hi' })).toThrow(RoomError);
    });

    it('refuses a post into an archived room', () => {
      service.updateRoom(roomId, human, { archived: true });
      expect(() => service.post(roomId, { authorId: human, text: 'hi' })).toThrow(RoomError);
    });

    it('publishes the entry to the room readers rather than returning it as delivery', () => {
      const published: unknown[] = [];
      const publish = vi.spyOn(service.stream, 'publish').mockImplementation((_room, event) => {
        published.push(event);
      });
      service.post(roomId, { authorId: human, text: 'hi' });
      expect(published).toHaveLength(1);
      publish.mockRestore();
    });
  });

  describe('threads', () => {
    let roomId: string;
    let rootEntryId: string;

    beforeEach(() => {
      const room = service.createRoom(
        { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
        human
      );
      roomId = room.id;
      service.addMember(roomId, human, {
        agentPath: '/agents/ana',
        responseMode: 'direct-only',
      });
      rootEntryId = service.post(roomId, { authorId: human, text: 'why is the build slow?' }).id;
    });

    it('writes a reply into this room, pointing at the entry it hangs off', () => {
      const reply = service.post(roomId, {
        authorId: human,
        text: 'the cache is cold',
        replyTo: rootEntryId,
      });

      // The whole change in one assertion: same room, same log, same seq space.
      expect(reply.roomId).toBe(roomId);
      expect(reply.parentEntryId).toBe(rootEntryId);
      expect(reply.threadRootEntryId).toBe(rootEntryId);
      // And no room was minted for it. `listRooms` never returns a thread
      // because there is no longer such a thing to return.
      expect(service.listRooms(human).map((r) => r.id)).toEqual([roomId]);
    });

    it('leaves the root itself outside its own thread', () => {
      service.post(roomId, { authorId: human, text: 'the cache is cold', replyTo: rootEntryId });
      const root = service.listEntries(roomId, human, { limit: 10 })[0];

      // Null on the root is what makes `countThreadReplies` mean replies. A root
      // that pointed at itself would report "2 replies" for one answer.
      expect(root.id).toBe(rootEntryId);
      expect(root.parentEntryId).toBeNull();
      expect(root.threadRootEntryId).toBeNull();
    });

    it('leaves an ordinary post at the top level', () => {
      const plain = service.post(roomId, { authorId: human, text: 'unrelated' });
      expect(plain.parentEntryId).toBeNull();
      expect(plain.threadRootEntryId).toBeNull();
    });

    it('refuses a reply whose root is itself a reply', () => {
      const reply = service.post(roomId, {
        authorId: human,
        text: 'a follow-up',
        replyTo: rootEntryId,
      });

      // One level, and it is now a rule this method enforces rather than a shape
      // the schema decided — `parent_entry_id` would happily store it.
      expect(() =>
        service.post(roomId, { authorId: human, text: 'deeper', replyTo: reply.id })
      ).toThrow(expect.objectContaining({ code: 'NESTED_THREAD' }));
    });

    it('writes nothing when the reply is refused', () => {
      const before = service.listEntries(roomId, human, { limit: 50 }).length;
      const reply = service.post(roomId, {
        authorId: human,
        text: 'a follow-up',
        replyTo: rootEntryId,
      });

      expect(() =>
        service.post(roomId, { authorId: human, text: 'deeper', replyTo: reply.id })
      ).toThrow(expect.objectContaining({ code: 'NESTED_THREAD' }));
      // The refusal happens before the append, so the log gained the one legal
      // reply and nothing else.
      expect(service.listEntries(roomId, human, { limit: 50 })).toHaveLength(before + 1);
    });

    it('refuses a reply to an entry that is not in this room', () => {
      expect(() =>
        service.post(roomId, { authorId: human, text: 'orphan', replyTo: 'no-such-entry' })
      ).toThrow(expect.objectContaining({ code: 'ENTRY_NOT_FOUND' }));
    });

    it('refuses a reply to an entry that lives in another room', () => {
      const other = service.createRoom(
        { kind: 'channel', title: 'Frontend', members: [], agentPaths: [] },
        human
      );
      const elsewhere = service.post(other.id, { authorId: human, text: 'over here' });

      // Scoped by room, so an entry id the caller can legitimately see does not
      // let it graft a reply onto a conversation in a different room.
      expect(() =>
        service.post(roomId, { authorId: human, text: 'wrong room', replyTo: elsewhere.id })
      ).toThrow(expect.objectContaining({ code: 'ENTRY_NOT_FOUND' }));
    });

    it('never writes one pointer without the other', () => {
      // The schema doc says the two columns coincide on every row while the
      // one-level policy holds. That was prose enforced nowhere, and the shape
      // it forbids is quiet: PR 2 groups by `parentEntryId` while
      // `countThreadReplies` scopes by `threadRootEntryId`, so a row with one
      // and not the other is a thread whose replies count but do not render.
      //
      // Every writer this service has, in one mix.
      const ana = authors.resolveAgent('/agents/ana', 'Ana').id;
      service.post(roomId, { authorId: human, text: 'top level' });
      service.post(roomId, { authorId: human, text: 'a reply', replyTo: rootEntryId });
      service.post(roomId, {
        authorId: ana,
        text: 'an agent answering in the thread',
        replyTo: rootEntryId,
        trigger: { root: rootEntryId, depth: 1 },
      });
      service.postNotice(roomId, { text: 'at the top level', notice: 'budget_reached' });
      service.postNotice(
        roomId,
        { text: 'inside the thread', notice: 'cascade_stopped' },
        { root: rootEntryId, depth: 1 },
        rootEntryId
      );

      const log = service.listEntries(roomId, human, { limit: 50 });
      // The mix is asserted before the invariant is, because "no row breaks the
      // rule" is trivially true of a log where no row has a pointer at all.
      expect(log.filter((entry) => entry.threadRootEntryId !== null)).toHaveLength(3);
      expect(log.filter((entry) => entry.threadRootEntryId === null)).toHaveLength(3);

      const broken = (
        db.$client
          .prepare(
            'SELECT COUNT(*) AS n FROM room_entries WHERE (parent_entry_id IS NULL) != (thread_root_entry_id IS NULL)'
          )
          .get() as { n: number }
      ).n;
      expect(broken).toBe(0);
    });
  });

  describe('read cursor and unread counts', () => {
    let roomId: string;

    beforeEach(() => {
      roomId = service.createRoom(
        { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
        human
      ).id;
      for (const text of ['one', 'two', 'three']) {
        service.post(roomId, { authorId: human, text });
      }
    });

    it('counts everything past the member cursor as unread', () => {
      expect(service.listRooms(human).find((r) => r.id === roomId)?.unreadCount).toBe(3);
      service.setReadCursor(roomId, human, 2);
      expect(service.listRooms(human).find((r) => r.id === roomId)?.unreadCount).toBe(1);
    });

    it('never moves the cursor backwards', () => {
      service.setReadCursor(roomId, human, 3);
      expect(service.setReadCursor(roomId, human, 1).lastReadSeq).toBe(3);
    });

    it('keeps a person out of the membership column, which is the agent cursor now', () => {
      // The split this phase exists for: where a PERSON has read is
      // `read_cursors`; what an AGENT has been shown is `room_members`. A human
      // write that still moved the column would leave the ambient loop believing
      // an agent had seen messages nobody showed it.
      service.setReadCursor(roomId, human, 2);

      expect(store.getMember(roomId, human)?.lastReadSeq).toBe(0);
      expect(readCursors.get(human, 'room', roomId)?.lastReadSeq).toBe(2);
    });

    it('leaves an agent on the membership column, where RP3 reads it', () => {
      service.addMember(roomId, human, { agentPath: '/agents/bo' });
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;

      service.setReadCursor(roomId, bo, 3);

      expect(store.getMember(roomId, bo)?.lastReadSeq).toBe(3);
      expect(readCursors.get(bo, 'room', roomId)).toBeNull();
    });

    it("never lets a person's reading touch an agent's cursor", () => {
      // The one way to break RP3 from the user side, asserted as its own case.
      service.addMember(roomId, human, { agentPath: '/agents/bo' });
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;
      const before = store.getMember(roomId, bo)?.lastReadSeq;

      service.setReadCursor(roomId, human, 3);

      expect(store.getMember(roomId, bo)?.lastReadSeq).toBe(before);
    });

    it('gives two people in one room independent cursors', () => {
      const second = authors.resolveExternal({
        platformType: 'telegram',
        instanceId: 'main',
        platformUserId: '77',
        displayName: 'Robin',
      }).id;
      service.addMember(roomId, human, { authorId: second });

      service.setReadCursor(roomId, human, 3);
      service.setReadCursor(roomId, second, 1);

      expect(readCursors.get(human, 'room', roomId)?.lastReadSeq).toBe(3);
      expect(readCursors.get(second, 'room', roomId)?.lastReadSeq).toBe(1);
      expect(
        service.getRoom(roomId, second)?.members.find((m) => m.authorId === second)?.lastReadSeq
      ).toBe(1);
    });

    it('reports the reader their own cursor on the roster they open the room with', () => {
      service.setReadCursor(roomId, human, 2);

      const room = service.getRoom(roomId, human)!;
      expect(room.members.find((m) => m.authorId === human)?.lastReadSeq).toBe(2);
    });

    it('keeps the cursor per (member, room)', () => {
      const other = service.createRoom(
        { kind: 'channel', title: 'Other', members: [], agentPaths: [] },
        human
      ).id;
      service.setReadCursor(roomId, human, 3);
      expect(service.listRooms(human).find((r) => r.id === other)?.unreadCount).toBe(0);
      expect(service.listRooms(human).find((r) => r.id === roomId)?.unreadCount).toBe(0);
    });

    it('refuses a cursor for someone who is not a member', () => {
      expect(() => service.setReadCursor(roomId, 'stranger', 1)).toThrow(RoomError);
    });

    it('announces a cursor that moved, carrying the count the sidebar should now draw', () => {
      const broadcast = vi.spyOn(eventFanOut, 'broadcast');
      service.setReadCursor(roomId, human, 2);

      // The count rides along because a second device cannot work it out: a room
      // summary carries no seq to measure the new cursor against, so a reader
      // holding only `lastReadSeq` could guess zero and be wrong about the third
      // message.
      //
      // One event name for every kind of thread a person reads — a room, an
      // agent session, the inbox — so a client subscribes once and filters on
      // `threadKind`.
      expect(broadcast).toHaveBeenCalledWith('read_cursor', {
        userId: human,
        threadKind: 'room',
        threadId: roomId,
        lastReadSeq: 2,
        unreadCount: 1,
      });
      broadcast.mockRestore();
    });

    it('says nothing when the write moved nothing', () => {
      service.setReadCursor(roomId, human, 3);
      const broadcast = vi.spyOn(eventFanOut, 'broadcast');

      service.setReadCursor(roomId, human, 3);
      service.setReadCursor(roomId, human, 1);

      expect(broadcast.mock.calls.map(([name]) => name)).not.toContain('read_cursor');
      broadcast.mockRestore();
    });

    it('says nothing at all for an agent, whose cursor nothing on screen draws', () => {
      // Bo is `silent`, so joining and reading cannot trigger a turn and put a
      // fourth entry in the room underneath this measurement.
      service.addMember(roomId, human, { agentPath: '/agents/bo' });
      const bo = authors.resolveAgent('/agents/bo', 'Bo').id;
      const broadcast = vi.spyOn(eventFanOut, 'broadcast');

      service.setReadCursor(roomId, bo, 3);

      // `read_cursor` is the PEOPLE stream by contract, and an agent advancing
      // its own cursor at claim time would otherwise be the loudest event on the
      // global fan-out for a fact no surface renders.
      expect(broadcast.mock.calls.map(([name]) => name)).not.toContain('read_cursor');
      broadcast.mockRestore();
    });
  });

  describe('removing members', () => {
    it('drops the membership, and removing twice is a typed refusal', () => {
      const roomId = service.createRoom(
        { kind: 'dm', title: 'Ana', members: [], agentPaths: [] },
        human
      ).id;
      const ana = service.addMember(roomId, human, { agentPath: '/agents/ana' }).authorId;

      service.removeMember(roomId, human, ana);
      expect(service.getRoom(roomId, human)?.members.map((m) => m.authorId)).toEqual([human]);
      expect(() => service.removeMember(roomId, human, ana)).toThrow(RoomError);
    });

    it('drops the per-room session binding with the membership', () => {
      const roomId = service.createRoom(
        { kind: 'dm', title: 'Ana', members: [], agentPaths: [] },
        human
      ).id;
      const ana = service.addMember(roomId, human, { agentPath: '/agents/ana' }).authorId;
      const now = new Date().toISOString();
      db.insert(roomSessions)
        .values({ roomId, authorId: ana, sessionId: 'sess-1', createdAt: now })
        .run();

      service.removeMember(roomId, human, ana);

      // The binding is what R3 would resume the agent's turn on; leaving it
      // behind would point a re-added agent at a session from a membership that
      // no longer exists.
      expect(db.select().from(roomSessions).where(eq(roomSessions.roomId, roomId)).all()).toEqual(
        []
      );
    });
  });

  it('refuses every operation on a room that does not exist', () => {
    expect(() => service.updateRoom('nope', human, { title: 'x' })).toThrow(
      expect.objectContaining({ code: 'ROOM_NOT_FOUND' })
    );
    expect(() => service.post('nope', { authorId: human, text: 'x' })).toThrow(
      expect.objectContaining({ code: 'ROOM_NOT_FOUND' })
    );
    expect(service.getRoom('nope', human)).toBeNull();
  });
});

describe('RoomService — the ancestry rule holds across a thread boundary', () => {
  /**
   * The one place the thread change makes a real bound TIGHTER
   * (room-participation spec §3.4, ADR 260728-022013).
   *
   * `authorsInCascade` is scoped `(room_id, cascade_root)`. Under the child-room
   * shape, a cascade that went from a channel into a thread crossed a `room_id`
   * boundary, the ancestry set reset, and the same authors could be triggered a
   * second time inside one exchange — the cross-room carve-out
   * ADR 260726-170127 documented and could not close. A thread reply now carries
   * the CHANNEL's `room_id`, so the set does not reset and A → thread → A is
   * refused at the first repeat instead of running to the depth ceiling.
   *
   * Driven through the real dispatcher: the guard's absence is only visible
   * under a cascade, so a test that called the guard directly would prove
   * nothing about the path that ships.
   */
  const agents = agentLookupFor({
    '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
    '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
  });

  it('refuses a cascade that opens a thread and comes back to the same author', async () => {
    const harness = createRoomHarness({
      agents,
      runner: scriptedRunner(() => 'on it'),
      // Well clear of anything this exchange can reach, so a refusal below is
      // the ancestry rule and never the depth ceiling wearing its clothes. It is
      // also what makes a broken ancestry rule LOUD here rather than subtle: an
      // A → B → A loop that is not stopped runs to this number.
      maxAgentDepth: 10,
    });
    const room = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
      harness.human
    );

    // The root goes in before either agent does, so neither is in this cascade
    // by way of a TOP-LEVEL entry. Everything that puts them in it from here is
    // a thread reply — which is exactly the thing the child-room shape kept out
    // of the set, and the thing this test has to be able to see.
    const root = harness.service.post(room.id, {
      authorId: harness.human,
      text: 'the deploy is stuck',
    });
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toEqual([]);

    const anaId = harness.service.addMember(room.id, harness.human, {
      agentPath: '/agents/ana',
      responseMode: 'always',
    }).authorId;
    const boId = harness.service.addMember(room.id, harness.human, {
      agentPath: '/agents/bo',
      responseMode: 'always',
    }).authorId;

    // Ana moves the exchange into a thread off the person's message, carrying
    // the cascade she is answering under — the same stamp
    // `RoomTriggerDispatcher` puts on a reply, passed explicitly so this is a
    // settled state rather than a race against her own in-flight claim.
    const anasReply = harness.service.post(room.id, {
      authorId: anaId,
      text: 'taking this to a thread',
      replyTo: root.id,
      trigger: { root: root.id, depth: 1 },
    });
    await harness.service.triggersIdle();

    // The mechanism FIRST, so a failure names which half broke: Ana's reply is
    // in the CHANNEL's log, under the channel's cascade. Under the child-room
    // shape all of that moved into a room of its own.
    expect(anasReply.roomId).toBe(room.id);
    expect(anasReply.threadRootEntryId).toBe(root.id);
    expect(anasReply.cascadeRoot).toBe(root.id);

    // Exactly one turn: Bo answered Ana, in the thread. Ana was then refused on
    // Bo's answer, because her thread reply put her in this cascade — the
    // ancestry rule holding across a boundary it used to reset at
    // (room-participation spec §3.4). A set that skipped thread replies would
    // never have found her, and A → B → A would have run to `maxAgentDepth`.
    expect(harness.runner.turns).toHaveLength(1);
    expect(harness.runner.turns[0].authorId).toBe(boId);

    // Bo answered inside the thread rather than beside it, which is what makes
    // the hop above a real one and not a message that escaped to the top level.
    const bosAnswer = harness.service
      .listEntries(room.id, harness.human, { limit: 50 })
      .find((entry) => entry.authorId === boId && entry.kind === 'post');
    expect(bosAnswer?.threadRootEntryId).toBe(root.id);
    expect(harness.service.authorsInCascade(room.id, root.id).sort()).toEqual(
      // The exact set: both agents, the person, and the system author that wrote
      // the refusal notice. Naming it beats "contains Ana", which would still
      // pass if Bo had fallen out of his own cascade.
      [harness.human, anaId, boId, harness.authors.system().id].sort()
    );
  });

  it('reports a refusal inside the thread it happened in', async () => {
    // `I3` — a refusal is visible. Visible at the channel's top level, about a
    // turn that was refused inside a thread, is a notice the reader cannot
    // connect to anything. Under the child-room shape this was free, because the
    // refusal was written into the thread's own room.
    //
    // Driven off the BUDGET refusal rather than the cascade one, because it is
    // the deterministic path: two agents refusing each other race on roster
    // order, and a test built on that shape passes about half the time
    // (`room-silence.test.ts` says so at length).
    const harness = createRoomHarness({
      agents,
      runner: scriptedRunner(() => 'on it'),
      maxAutomaticTurnsPerRoomPerHour: 0,
    });
    const room = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
      harness.human
    );
    // The root goes in BEFORE Ana does, so the room's one budget notice is spent
    // on the thread reply rather than on this: the notice is keyed on the room
    // and re-armed only when the room can spend again.
    const root = harness.service.post(room.id, {
      authorId: harness.human,
      text: 'the deploy is stuck',
    });
    await harness.service.triggersIdle();
    expect(
      harness.service
        .listEntries(room.id, harness.human, { limit: 50 })
        .filter((e) => e.kind === 'notice')
    ).toEqual([]);

    const anaId = harness.service.addMember(room.id, harness.human, {
      agentPath: '/agents/ana',
      responseMode: 'always',
    }).authorId;
    harness.service.post(room.id, { authorId: harness.human, text: 'any idea?', replyTo: root.id });
    await harness.service.triggersIdle();

    const notices = harness.service
      .listEntries(room.id, harness.human, { limit: 50 })
      .filter((entry) => entry.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0].body.notice).toBe('budget_reached');
    // The whole point: it is IN the thread, not beside it.
    expect(notices[0].threadRootEntryId).toBe(root.id);
    expect(notices[0].parentEntryId).toBe(root.id);
    // Ana really was the agent that would have run, so this is a refusal and not
    // an empty room writing a notice about nobody.
    expect(
      harness.service.getRoom(room.id, harness.human)?.members.map((m) => m.authorId)
    ).toContain(anaId);
  });
});

describe('RoomService — atomicity, slug reclaim and visibility', () => {
  let db: Db;
  let service: RoomService;
  let authors: AuthorRegistry;
  let human: string;

  beforeEach(() => {
    ({ db, service, authors, human } = createRoomHarness({ agents: agentLookup }));
  });

  it('creates no room at all when a seeded member does not exist', () => {
    expect(() =>
      service.createRoom(
        { kind: 'channel', title: 'Backend', members: ['ghost'], agentPaths: [] },
        human
      )
    ).toThrow(RoomError);

    // The failure must leave nothing behind: a committed room would hold the
    // slug and turn the obvious retry into a 409 for a room the caller was told
    // did not exist.
    expect(service.listRooms(human, { includeArchived: true })).toEqual([]);
    expect(
      service.createRoom({ kind: 'channel', title: 'Backend', members: [], agentPaths: [] }, human)
        .slug
    ).toBe('backend');
  });

  it('writes no entry at all when the reply target does not resolve', () => {
    const room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
      human
    );
    expect(() =>
      service.post(room.id, { authorId: human, text: 'orphan', replyTo: 'no-such-entry' })
    ).toThrow(RoomError);
    expect(service.listEntries(room.id, human, { limit: 10 })).toEqual([]);
  });

  it('refuses to un-archive a channel whose slug someone else has taken', () => {
    const first = service.createRoom(
      { kind: 'channel', slug: 'general', title: 'General', members: [], agentPaths: [] },
      human
    );
    service.updateRoom(first.id, human, { archived: true });
    service.createRoom(
      { kind: 'channel', slug: 'general', title: 'General II', members: [], agentPaths: [] },
      human
    );

    // Archiving released the slug; un-archiving tries to reclaim it. That is a
    // 409, not a raw UNIQUE violation surfacing as a 500.
    expect(() => service.updateRoom(first.id, human, { archived: false })).toThrow(
      expect.objectContaining({ code: 'SLUG_TAKEN' })
    );
  });

  it('un-archives happily when nobody took the slug', () => {
    const room = service.createRoom(
      { kind: 'channel', slug: 'general', title: 'General', members: [], agentPaths: [] },
      human
    );
    service.updateRoom(room.id, human, { archived: true });
    expect(service.updateRoom(room.id, human, { archived: false }).archived).toBe(false);
  });

  it('moves a channel’s #slug with its title, because the slug IS its name', () => {
    // A channel row reads `#general`, so a rename that changed only `title`
    // would land in the database and change nothing anybody could see.
    const room = service.createRoom(
      { kind: 'channel', title: 'General', members: [], agentPaths: [] },
      human
    );
    expect(room.slug).toBe('general');

    const renamed = service.updateRoom(room.id, human, { title: 'Backend questions' });
    expect(renamed.title).toBe('Backend questions');
    expect(renamed.slug).toBe('backend-questions');
  });

  it('refuses a rename onto a slug another live channel holds', () => {
    service.createRoom({ kind: 'channel', title: 'Backend', members: [], agentPaths: [] }, human);
    const other = service.createRoom(
      { kind: 'channel', title: 'General', members: [], agentPaths: [] },
      human
    );

    expect(() => service.updateRoom(other.id, human, { title: 'Backend' })).toThrow(
      expect.objectContaining({ code: 'SLUG_TAKEN' })
    );
    // Refused whole: the title must not land while the slug is rejected.
    expect(service.getRoom(other.id, human)?.title).toBe('General');
  });

  it('lets a channel keep its own slug through a cosmetic rename', () => {
    const room = service.createRoom(
      { kind: 'channel', title: 'General', members: [], agentPaths: [] },
      human
    );
    const renamed = service.updateRoom(room.id, human, { title: 'GENERAL' });
    expect(renamed.title).toBe('GENERAL');
    expect(renamed.slug).toBe('general');
  });

  it('refuses a channel name with nothing sluggable in it', () => {
    const room = service.createRoom(
      { kind: 'channel', title: 'General', members: [], agentPaths: [] },
      human
    );
    expect(() => service.updateRoom(room.id, human, { title: '!!!' })).toThrow(
      expect.objectContaining({ code: 'INVALID_SLUG' })
    );
  });

  it('brings an archived channel back under a new name when its old one was taken', () => {
    // The trap this closes: archiving releases a slug (the unique index skips
    // archived rooms), so a live channel can take it while the room is away.
    // Judging the un-archive against the OLD slug refused the rename that was
    // the only way out, and nothing else in the product un-archives a room —
    // so the room was stranded for good.
    const away = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
      human
    );
    service.updateRoom(away.id, human, { archived: true });
    const squatter = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
      human
    );
    expect(squatter.slug).toBe('backend');

    // Coming back under its old name is still refused — that name is taken.
    expect(() => service.updateRoom(away.id, human, { archived: false })).toThrow(
      expect.objectContaining({ code: 'SLUG_TAKEN' })
    );

    // Coming back under a new one works, because the rename is applied before
    // the un-archive is judged.
    const back = service.updateRoom(away.id, human, {
      archived: false,
      title: 'Backend two',
    });
    expect(back.archived).toBe(false);
    expect(back.slug).toBe('backend-two');
    // …and the channel that took the name is untouched.
    expect(service.getRoom(squatter.id, human)?.slug).toBe('backend');
  });

  it('still refuses an un-archive whose new name is also taken', () => {
    const away = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
      human
    );
    service.updateRoom(away.id, human, { archived: true });
    service.createRoom({ kind: 'channel', title: 'Backend', members: [], agentPaths: [] }, human);
    service.createRoom({ kind: 'channel', title: 'Frontend', members: [], agentPaths: [] }, human);

    expect(() =>
      service.updateRoom(away.id, human, { archived: false, title: 'Frontend' })
    ).toThrow(expect.objectContaining({ code: 'SLUG_TAKEN' }));
    // Refused whole: it is still archived, and still under its own old name.
    const untouched = service.getRoom(away.id, human);
    expect(untouched?.archived).toBe(true);
    expect(untouched?.slug).toBe('backend');
  });

  it('renames a direct message without inventing a slug for it', () => {
    // Only a channel has a name people type; a DM is addressed by who is in it.
    const dm = service.createRoom({ kind: 'dm', title: 'Ana', members: [], agentPaths: [] }, human);
    const renamed = service.updateRoom(dm.id, human, { title: 'Ana and Bo' });
    expect(renamed.title).toBe('Ana and Bo');
    expect(renamed.slug).toBeNull();
  });

  it('shows the operator every room, including ones they never joined', () => {
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    const room = service.createRoom(
      { kind: 'dm', title: 'Ana and Bo', members: [ana], agentPaths: [] },
      ana
    );

    const listed = service.listRooms(human);
    expect(listed.map((r) => r.id)).toContain(room.id);
    // Not a member, so there is no cursor and therefore no unread number —
    // never the room's whole entry count.
    expect(listed.find((r) => r.id === room.id)?.unreadCount).toBeNull();
  });

  it('reports a real unread count for a room the viewer is in', () => {
    const room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
      human
    );
    service.post(room.id, { authorId: human, text: 'one' });
    expect(service.listRooms(human).find((r) => r.id === room.id)?.unreadCount).toBe(1);
  });

  it("carries a direct message's roster, so the sidebar can draw who it is with", () => {
    const dm = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );

    const participants = service.listRooms(human).find((r) => r.id === dm.id)?.participants;
    // Sorted, not positional: a DM's members are all stamped with one `joinedAt`
    // at create time, so the roster's order between them is not a promise.
    expect(participants?.map((p) => p.displayName).sort()).toEqual(['Ana', 'You']);
    const counterpart = participants?.find((p) => p.kind === 'agent');
    expect(counterpart?.emoji).toBe('🐙');
    expect(counterpart?.agentRef).toBe(agentAuthorRef('/agents/ana'));
  });

  it('carries no roster for a channel — null, which is not an empty room', () => {
    const channel = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
      human
    );

    const listed = service.listRooms(human).find((r) => r.id === channel.id);
    expect(listed?.participants).toBeNull();
    // The roster is real, it is just not on the list payload.
    expect(service.getRoom(channel.id, human)?.members).toHaveLength(2);
  });

  it('resolves every listed DM in one pass, not one read per room', () => {
    const first = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    const second = service.createRoom(
      { kind: 'dm', title: 'Bo', members: [], agentPaths: ['/agents/bo'] },
      human
    );

    // Keyed by id rather than compared positionally: both rooms are created in
    // the same millisecond, so the list's `lastActivityAt` ordering between
    // them is not something this test can claim to know.
    const listed = new Map(
      service
        .listRooms(human, { kind: 'dm' })
        .map((room) => [room.id, room.participants?.map((p) => p.displayName).sort()])
    );
    expect(listed.size).toBe(2);
    expect(listed.get(first.id)).toEqual(['Ana', 'You']);
    expect(listed.get(second.id)).toEqual(['Bo', 'You']);
  });

  it('reads the roster table a fixed number of times, however many DMs there are', () => {
    // The claim above — "one pass, not one read per room" — is not something a
    // returned value can show: the same data comes back either way. So count
    // the statements SQLite is actually asked to prepare, and pin that the
    // count does not move between 2 direct messages and 25.
    expect(rosterReadsForListingDms(2)).toBe(2);
    expect(rosterReadsForListingDms(25)).toBe(2);
  });

  it('orders a roster deterministically, so a DM keeps naming the same agent', () => {
    // Every member of a room created this way is stamped with ONE `joinedAt`,
    // so the whole roster ties and the order is decided entirely by the
    // tiebreak. Without one it falls through to whatever index the planner
    // picked — which `ANALYZE` may change under a running install.
    const dm = service.createRoom(
      {
        kind: 'dm',
        title: 'A crowd',
        members: [],
        agentPaths: ['/agents/ana', '/agents/bo', '/agents/cy', '/agents/di'],
      },
      human
    );

    // The rule, computed from the stored rows rather than from the answer:
    // oldest membership first, author id breaking the tie.
    const expected = db
      .select()
      .from(roomMembers)
      .where(eq(roomMembers.roomId, dm.id))
      .all()
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.authorId.localeCompare(b.authorId))
      .map((row) => row.authorId);
    expect(expected).toHaveLength(5);

    const listed = service.listRooms(human).find((r) => r.id === dm.id)?.participants;
    expect(listed?.map((p) => p.id)).toEqual(expected);
    // The open room's header reads the roster by the other path. A reader who
    // saw two different agents for one conversation would distrust both.
    expect(service.getRoom(dm.id, human)?.members.map((m) => m.authorId)).toEqual(expected);
  });

  it('shows an agent only the rooms it belongs to', () => {
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    const mine = service.createRoom(
      { kind: 'channel', title: 'Private', members: [], agentPaths: [] },
      human
    );
    const shared = service.createRoom(
      { kind: 'channel', title: 'Shared', members: [], agentPaths: [] },
      human
    );
    service.addMember(shared.id, human, { agentPath: '/agents/ana' });

    expect(service.listRooms(ana).map((r) => r.id)).toEqual([shared.id]);
    expect(service.getRoom(mine.id, ana)).toBeNull();
    expect(() => service.listEntries(mine.id, ana, { limit: 10 })).toThrow(
      expect.objectContaining({ code: 'ROOM_NOT_FOUND' })
    );
  });

  it('makes the operator join before speaking, even though they can see everything', () => {
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    const theirs = service.createRoom(
      { kind: 'dm', title: 'Ana only', members: [ana], agentPaths: [] },
      ana
    );

    expect(service.getRoom(theirs.id, human)).not.toBeNull();
    expect(() => service.post(theirs.id, { authorId: human, text: 'hi' })).toThrow(
      expect.objectContaining({ code: 'MEMBER_NOT_FOUND' })
    );
  });

  it('stores an inert response mode for a human, not a restriction', () => {
    const room = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: [] },
      human
    );
    expect(room.members.find((m) => m.authorId === human)?.responseMode).toBe('always');
  });
});

describe('RoomService — creating a DM in one call', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let human: string;

  beforeEach(() => {
    ({ service, authors, human } = createRoomHarness({ agents: agentLookup }));
  });

  it('joins the agent named by its directory, seeded from its manifest', () => {
    const room = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );

    const ana = room.members.find((m) => m.author.displayName === 'Ana');
    expect(ana).toBeDefined();
    // A DM seeds from the manifest, which is what makes the agent answer at all.
    expect(ana?.responseMode).toBe('always');
    expect(room.members).toHaveLength(2);
  });

  it('creates no room at all when the agent path resolves to nothing, and the retry works', () => {
    expect(() =>
      service.createRoom(
        { kind: 'dm', title: 'Ghost', members: [], agentPaths: ['/agents/ghost'] },
        human
      )
    ).toThrow(expect.objectContaining({ code: 'AGENT_NOT_FOUND' }));

    // Nothing half-written: no DM named after an agent that is not in it.
    expect(service.listRooms(human, { includeArchived: true })).toEqual([]);

    const retried = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    expect(retried.members).toHaveLength(2);
  });

  it('leaves no room behind when the SECOND of two agents is unknown', () => {
    expect(() =>
      service.createRoom(
        {
          kind: 'channel',
          title: 'Backend',
          members: [],
          agentPaths: ['/agents/ana', '/agents/ghost'],
        },
        human
      )
    ).toThrow(expect.objectContaining({ code: 'AGENT_NOT_FOUND' }));

    expect(service.listRooms(human, { includeArchived: true })).toEqual([]);
    // The slug is free, so the obvious retry is not a 409 for a room the caller
    // was told did not exist.
    expect(
      service.createRoom({ kind: 'channel', title: 'Backend', members: [], agentPaths: [] }, human)
        .slug
    ).toBe('backend');
  });

  it('does not double-join an agent named twice', () => {
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    const room = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [ana], agentPaths: ['/agents/ana'] },
      human
    );
    expect(room.members.map((m) => m.authorId).sort()).toEqual([human, ana].sort());
  });
});

describe('RoomService — only the operator changes a roster', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let human: string;
  let roomId: string;
  let ana: string;

  beforeEach(() => {
    ({ service, authors, human } = createRoomHarness({ agents: agentLookup }));
    const room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    roomId = room.id;
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
  });

  it('refuses an agent adding another member', () => {
    expect(() => service.addMember(roomId, ana, { agentPath: '/agents/bo' })).toThrow(
      expect.objectContaining({ code: 'OPERATOR_ONLY' })
    );
    expect(service.getRoom(roomId, human)?.members).toHaveLength(2);
  });

  it('refuses an agent widening a room-mate response mode', () => {
    service.addMember(roomId, human, { agentPath: '/agents/bo' });
    const bo = authors.resolveAgent('/agents/bo', 'Bo').id;

    // This is the amplification lever: `always` on a room-mate means every
    // message Ana writes gets an answer Ana can then answer.
    expect(() => service.updateMembership(roomId, ana, bo, 'always')).toThrow(
      expect.objectContaining({ code: 'OPERATOR_ONLY' })
    );
    expect(
      service.getRoom(roomId, human)?.members.find((m) => m.authorId === bo)?.responseMode
    ).toBe('engaged');
  });

  it('refuses an agent removing a member', () => {
    expect(() => service.removeMember(roomId, ana, human)).toThrow(
      expect.objectContaining({ code: 'OPERATOR_ONLY' })
    );
    expect(service.getRoom(roomId, human)?.members.map((m) => m.authorId)).toContain(human);
  });

  it('refuses an agent conscripting a second agent into a room it opens', () => {
    expect(() =>
      service.createRoom({ kind: 'dm', title: 'Bo', members: [], agentPaths: ['/agents/bo'] }, ana)
    ).toThrow(expect.objectContaining({ code: 'OPERATOR_ONLY' }));
    expect(service.listRooms(human).map((r) => r.title)).not.toContain('Bo');
  });

  it('still lets an agent open a room for itself', () => {
    const own = service.createRoom(
      { kind: 'dm', title: 'Ana notes', members: [], agentPaths: [] },
      ana
    );
    expect(own.members.map((m) => m.authorId)).toEqual([ana]);
  });

  it('lets an agent reply in a thread beside a second agent, and keeps the bound that mattered', () => {
    // The seeding gate used to cover `createThread`, because a thread was a new
    // room: a fresh roster, a fresh budget window and — the real prize — a fresh
    // `(room_id, cascade_root)` namespace the ancestry rule had never seen.
    //
    // A thread reply buys none of those any more (ADR 260728-022013), so the
    // gate has nothing left to protect and replying is exactly as allowed as
    // posting. This test pins BOTH halves, because the loosening is only safe if
    // the second one holds: the reply lands in the channel's own cascade set.
    service.addMember(roomId, human, { agentPath: '/agents/bo' });
    const entry = service.post(roomId, { authorId: human, text: 'worth a thread' });

    const reply = service.post(roomId, {
      authorId: ana,
      text: 'looking',
      replyTo: entry.id,
      trigger: { root: entry.cascadeRoot, depth: 1 },
    });

    expect(reply.roomId).toBe(roomId);
    expect(reply.threadRootEntryId).toBe(entry.id);
    expect(service.authorsInCascade(roomId, entry.cascadeRoot).sort()).toEqual([human, ana].sort());
  });

  it('lets the operator do all three', () => {
    const bo = service.addMember(roomId, human, { agentPath: '/agents/bo' }).authorId;
    expect(service.updateMembership(roomId, human, bo, 'always').responseMode).toBe('always');
    service.removeMember(roomId, human, bo);
    expect(service.getRoom(roomId, human)?.members.map((m) => m.authorId)).not.toContain(bo);
  });
});

describe('RoomService — a DM is idempotent on its member set', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let human: string;

  /** Open a direct message with these agents, named after the first of them. */
  function openDm(agentPaths: string[], title = 'Conversation'): string {
    return service.createRoom({ kind: 'dm', title, members: [], agentPaths }, human).id;
  }

  beforeEach(() => {
    ({ service, authors, human } = createRoomHarness({ agents: agentLookup }));
  });

  it('answers with the conversation you already have, rather than a second one', () => {
    const first = openDm(['/agents/ana'], 'Ana');
    expect(openDm(['/agents/ana'], 'Ana')).toBe(first);
    expect(service.listRooms(human, { kind: 'dm' })).toHaveLength(1);
  });

  it('reports whether it created the room, which the body cannot say', () => {
    const request = { kind: 'dm' as const, title: 'Ana', members: [], agentPaths: ['/agents/ana'] };
    expect(service.createRoom(request, human).created).toBe(true);
    expect(service.createRoom(request, human).created).toBe(false);
    // A channel never matches an existing room, so it is always a creation.
    expect(
      service.createRoom({ kind: 'channel', title: 'Backend', members: [], agentPaths: [] }, human)
        .created
    ).toBe(true);
  });

  it('leaves the conversation where it was in the activity order', () => {
    // Opening a conversation is not activity in it. Bumping `lastActivityAt`
    // would float a silent room to the top of a recency-sorted sidebar and tell
    // the reader something had happened in it.
    const first = openDm(['/agents/ana'], 'Ana');
    const before = service.getRoom(first, human)?.lastActivityAt;

    expect(openDm(['/agents/ana'], 'Ana')).toBe(first);
    expect(service.getRoom(first, human)?.lastActivityAt).toBe(before);
  });

  it('leaves an un-archived conversation where it was too', () => {
    const first = openDm(['/agents/ana'], 'Ana');
    const before = service.getRoom(first, human)?.lastActivityAt;
    service.updateRoom(first, human, { archived: true });

    const reopened = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    expect(reopened.archived).toBe(false);
    expect(reopened.lastActivityAt).toBe(before);
  });

  it('matches whatever order the agents were named in', () => {
    const group = openDm(['/agents/ana', '/agents/bo'], 'Ana and Bo');
    expect(openDm(['/agents/bo', '/agents/ana'], 'Bo and Ana')).toBe(group);
    expect(service.listRooms(human, { kind: 'dm' })).toHaveLength(1);
  });

  it('keeps a one-to-one and a group holding that agent apart', () => {
    // Ana alone and Ana + Bo are different conversations. This is the whole
    // reason the picker may no longer filter out agents that already have a DM.
    const alone = openDm(['/agents/ana'], 'Ana');
    const group = openDm(['/agents/ana', '/agents/bo'], 'Ana and Bo');

    expect(group).not.toBe(alone);
    expect(service.listRooms(human, { kind: 'dm' })).toHaveLength(2);
  });

  it('does not answer with a group when asked for a smaller conversation inside it', () => {
    const group = openDm(['/agents/ana', '/agents/bo'], 'Ana and Bo');
    expect(openDm(['/agents/ana'], 'Ana')).not.toBe(group);
  });

  it('does not answer with a one-to-one when asked for a group containing it', () => {
    const alone = openDm(['/agents/ana'], 'Ana');
    expect(openDm(['/agents/ana', '/agents/bo'], 'Ana and Bo')).not.toBe(alone);
  });

  it('un-archives the conversation instead of minting one beside it', () => {
    const first = openDm(['/agents/ana'], 'Ana');
    service.updateRoom(first, human, { archived: true });

    const reopened = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    expect(reopened.id).toBe(first);
    expect(reopened.archived).toBe(false);
    // One room, and the history is still in it — not stranded in an archived twin.
    expect(service.listRooms(human, { kind: 'dm', includeArchived: true })).toHaveLength(1);
  });

  it('leaves the existing title alone — asking for a conversation is not renaming it', () => {
    const first = openDm(['/agents/ana'], 'Ana');
    service.updateRoom(first, human, { title: 'Deploy questions' });

    const again = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    expect(again.title).toBe('Deploy questions');
  });

  it('keeps the history and the roster it already had', () => {
    const first = openDm(['/agents/ana'], 'Ana');
    service.post(first, { authorId: human, text: 'morning' });

    const again = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    expect(again.members).toHaveLength(2);
    expect(service.listEntries(again.id, human, { limit: 10 }).map((e) => e.body.text)).toEqual([
      'morning',
    ]);
  });

  it('announces nothing on the global stream when no room was created', () => {
    openDm(['/agents/ana'], 'Ana');
    const broadcast = vi.spyOn(eventFanOut, 'broadcast');
    openDm(['/agents/ana'], 'Ana');

    expect(broadcast.mock.calls.map(([type]) => type)).not.toContain('room_created');
    broadcast.mockRestore();
  });

  it('announces the un-archive, so a stale sidebar hears about it', () => {
    const first = openDm(['/agents/ana'], 'Ana');
    service.updateRoom(first, human, { archived: true });

    const broadcast = vi.spyOn(eventFanOut, 'broadcast');
    openDm(['/agents/ana'], 'Ana');
    expect(broadcast).toHaveBeenCalledWith(
      'room_updated',
      expect.objectContaining({ roomId: first, archived: false })
    );
    broadcast.mockRestore();
  });

  it('does not dedupe a channel — two channels may hold the same people', () => {
    const first = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    const second = service.createRoom(
      { kind: 'channel', title: 'Frontend', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    expect(second.id).not.toBe(first.id);
  });

  it('does not let an existing DM turn the operator-only seeding rule into a bypass', () => {
    // The refusal comes first, so an agent gets the same 403 whether or not the
    // conversation it named already exists — no probing for one.
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    openDm(['/agents/ana', '/agents/bo'], 'Ana and Bo');

    expect(() =>
      service.createRoom(
        { kind: 'dm', title: 'Ana and Bo', members: [], agentPaths: ['/agents/bo'] },
        ana
      )
    ).toThrow(expect.objectContaining({ code: 'OPERATOR_ONLY' }));
  });

  it('returns the agent its own DM with the operator rather than a second one', () => {
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    const first = service.createRoom(
      { kind: 'dm', title: 'Ana and you', members: [human], agentPaths: [] },
      ana
    );
    const again = service.createRoom(
      { kind: 'dm', title: 'Ana and you', members: [human], agentPaths: [] },
      ana
    );
    expect(again.id).toBe(first.id);
  });
});

describe('RoomService — how an author renders', () => {
  it('carries the agent emoji and a stable handle, and never its directory', () => {
    const { service, human } = createRoomHarness({ agents: agentLookup });
    const room = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      human
    );

    const ana = room.members.find((m) => m.author.kind === 'agent')?.author;
    expect(ana?.emoji).toBe('🐙');
    // The handle is derived from the path, so it survives a rename and a mesh
    // rebuild — but the path itself is not on the wire.
    expect(ana?.agentRef).toBe(agentAuthorRef('/agents/ana'));
    expect(JSON.stringify(ana)).not.toContain('/agents/ana');
  });

  it('refreshes the render cache when the agent gets an emoji it did not have', () => {
    const harness = createRoomHarness({
      agents: agentLookupFor({ '/agents/ana': { name: 'ana', displayName: 'Ana' } }),
    });
    const first = harness.authors.resolveAgent('/agents/ana', 'Ana');
    expect(first.emoji).toBeNull();

    const refreshed = harness.authors.resolveAgent('/agents/ana', 'Ana', { emoji: '🐙' });
    expect(refreshed.id).toBe(first.id);
    expect(harness.authors.getById(first.id)?.emoji).toBe('🐙');
  });

  it('does not blank the render cache for a caller that only knows the name', () => {
    const harness = createRoomHarness({ agents: agentLookup });
    const seeded = harness.authors.resolveAgent('/agents/ana', 'Ana', { emoji: '🐙' });

    // This is the identity-header path: it carries a display name and nothing else.
    harness.authors.resolveAgent('/agents/ana', 'Ana');
    expect(harness.authors.getById(seeded.id)?.emoji).toBe('🐙');
  });
});

/**
 * The behaviour DOR-598 exists for: until this landed, `seesEveryRoom` and
 * `requireOperator` both granted on `kind === 'human'`, which was the same
 * question as "is the operator" only while an install minted exactly one human
 * author. Every test here fails on the old code — which is the point.
 *
 * ADR 260727-184933 D6 makes this MORE relevant, not less. The local install
 * stays single-user for good, so there is no second local account — but joining
 * a community will fill this same `authors` table with other humans, cached
 * remote members whose messages you hold. Any code reading `kind === 'human'`
 * and concluding "operator" is wrong on your own machine the moment one of them
 * lands, with no second account anywhere. `humanWhoIsNotTheOwner` below is that
 * row.
 *
 * The harness is given an `ownerUserId`, so ownership resolves through the real
 * `AuthorRegistry.isOwner` rather than a stub.
 */
describe('RoomService — a human who is not the owner is not the operator', () => {
  const OWNER_USER = 'user-dorian';
  let service: RoomService;
  let authors: AuthorRegistry;
  let owner: string;
  let priya: string;
  let ownersRoom: string;
  let sharedRoom: string;

  beforeEach(() => {
    ({
      service,
      authors,
      human: owner,
    } = createRoomHarness({
      agents: agentLookup,
      ownerUserId: OWNER_USER,
    }));
    // A human author that is not the owner — the shape a cached remote member
    // takes, and the shape `resolveCaller` would mint for an account that is not
    // the owner's.
    priya = authors.human('user-priya').id;

    ownersRoom = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
      owner
    ).id;
    sharedRoom = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
      owner
    ).id;
    service.addMember(sharedRoom, owner, { authorId: priya });
  });

  it('shows her the rooms she is in and nothing else', () => {
    expect(service.listRooms(priya).map((room) => room.id)).toEqual([sharedRoom]);
  });

  it('hides the owner DM with an agent, by id as well as by listing', () => {
    // The same `ROOM_NOT_FOUND` a room that does not exist gets, so holding an
    // id proves nothing about whether one is there.
    expect(service.getRoom(ownersRoom, priya)).toBeNull();
    expect(() => service.post(ownersRoom, { authorId: priya, text: 'hello?' })).toThrow(
      expect.objectContaining({ code: 'ROOM_NOT_FOUND' })
    );
  });

  it('refuses her every roster write in a room she IS in', () => {
    expect(() => service.addMember(sharedRoom, priya, { agentPath: '/agents/bo' })).toThrow(
      expect.objectContaining({ code: 'OPERATOR_ONLY' })
    );
    expect(() => service.updateMembership(sharedRoom, priya, priya, 'always')).toThrow(
      expect.objectContaining({ code: 'OPERATOR_ONLY' })
    );
    expect(() => service.removeMember(sharedRoom, priya, owner)).toThrow(
      expect.objectContaining({ code: 'OPERATOR_ONLY' })
    );
    // Sorted: a roster's order is not part of the contract, and two authors
    // minted in the same millisecond order by ULID randomness.
    expect(
      service
        .getRoom(sharedRoom, owner)
        ?.members.map((m) => m.authorId)
        .sort()
    ).toEqual([owner, priya].sort());
  });

  it('keeps the refusal wording the install has always had', () => {
    // Deliberately NOT the owner's account name. Under D6 the only caller that
    // ever reads this is an agent, for which "you" already means the operator —
    // and putting the owner's real name into an agent-visible error string
    // would leak it into agent context for nothing.
    expect(() => service.removeMember(sharedRoom, priya, owner)).toThrow(
      'Only you can change who is in a room'
    );
  });

  it('refuses her assembling a room whose agents answer each other', () => {
    // `/api/rooms` is reachable by a member — her own rooms live behind it — so
    // without this she could have built the amplification room `addMember`
    // refuses, spending the owner's model quota inside it.
    expect(() =>
      service.createRoom(
        { kind: 'channel', title: 'Mine', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
        priya
      )
    ).toThrow(expect.objectContaining({ code: 'OPERATOR_ONLY' }));
    expect(service.listRooms(owner).map((r) => r.title)).not.toContain('Mine');
  });

  it('lets her read and post in the room she was admitted to', () => {
    expect(service.getRoom(sharedRoom, priya)?.id).toBe(sharedRoom);
    expect(service.post(sharedRoom, { authorId: priya, text: 'hello' }).authorId).toBe(priya);
  });

  it('tells her which member she is, on every room body she can get', () => {
    expect(service.getRoom(sharedRoom, priya)?.viewerAuthorId).toBe(priya);
    expect(service.snapshot(sharedRoom, priya, 10).room.viewerAuthorId).toBe(priya);
    expect(service.getRoom(sharedRoom, owner)?.viewerAuthorId).toBe(owner);
  });

  it('changes nothing at all for an agent, in either direction', () => {
    // The predicate that replaced `kind === 'human'` is strictly NARROWER:
    // `isOwner` returns false for anything that is not a human author, so
    // `isOwnerAuthor(x)` implies `x.kind === 'human'`. An agent therefore fails
    // the old test and the new one identically, and the set of refused callers
    // grew by exactly one thing — a human who is not the owner.
    //
    // Pinned on `createRoom`, which is now the whole of what
    // `requireSeedingAllowed` guards: a careless widening here would let an
    // agent assemble a room whose members answer each other. Both answers below
    // are the pre-DOR-598 ones.
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;

    // Alone with the owner: nothing is conscripted, so it is allowed.
    expect(
      service.createRoom({ kind: 'dm', title: 'Ana notes', members: [], agentPaths: [] }, ana)
        .members
    ).toHaveLength(1);

    // Conscripting a second agent: refused, exactly as it was before.
    expect(() =>
      service.createRoom(
        { kind: 'channel', title: 'Pair', members: [], agentPaths: ['/agents/bo'] },
        ana
      )
    ).toThrow(expect.objectContaining({ code: 'OPERATOR_ONLY' }));
  });

  it('leaves the owner passing everything, unchanged', () => {
    expect(
      service
        .listRooms(owner)
        .map((room) => room.id)
        .sort()
    ).toEqual([ownersRoom, sharedRoom].sort());
    expect(service.getRoom(ownersRoom, owner)?.id).toBe(ownersRoom);
    expect(service.addMember(sharedRoom, owner, { agentPath: '/agents/bo' }).authorId).toBeTruthy();
    service.removeMember(sharedRoom, owner, priya);
    expect(service.getRoom(sharedRoom, owner)?.members.map((m) => m.authorId)).not.toContain(priya);
  });
});

describe('RoomService — an install with no accounts is unchanged', () => {
  it('treats the unbound local author as the operator, and says "you"', () => {
    // The default posture: login off, nobody registered. With no account there
    // is nobody else the operator could be, so the `'local'` sentinel is it —
    // and the refusal keeps the second-person wording it has always had.
    const { service, authors, human } = createRoomHarness({ agents: agentLookup });
    const room = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    const ana = authors.resolveAgent('/agents/ana', 'Ana').id;

    expect(service.getRoom(room.id, human)?.id).toBe(room.id);
    expect(service.addMember(room.id, human, { agentPath: '/agents/bo' }).authorId).toBeTruthy();
    expect(() => service.removeMember(room.id, ana, human)).toThrow(
      'Only you can change who is in a room'
    );
  });
});

describe('RoomService — enabling login moves nothing', () => {
  it('keeps every room, membership, message and cursor across the rebind', () => {
    // The migration this phase turns on: an install runs unowned for months,
    // then somebody enables login. The `'local'` author is rebound onto the new
    // account IN PLACE, so the opaque id every row points at does not move.
    const harness = createRoomHarness({ agents: agentLookup });
    const before = harness.human;
    const room = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
      before
    );
    harness.service.post(room.id, { authorId: before, text: 'said before there were accounts' });
    const second = harness.service.post(room.id, { authorId: before, text: 'and again' });
    harness.service.setReadCursor(room.id, before, second.seq);

    const after = harness.setOwner('user-dorian');

    expect(after).toBe(before);
    const reopened = harness.service.getRoom(room.id, after);
    expect(reopened?.id).toBe(room.id);
    expect(reopened?.members.map((m) => m.authorId)).toContain(after);
    expect(reopened?.members.find((m) => m.authorId === after)?.lastReadSeq).toBe(second.seq);
    expect(
      harness.service.listEntries(room.id, after, { limit: 10 }).map((e) => e.authorId)
    ).toEqual([before, before]);
    // Still the operator, and still "You": the rebind moves the natural key, not
    // the render cache. Writing the account name here would have retroactively
    // relabelled both messages above, because there is one name column per author.
    expect(harness.service.listRooms(after).map((r) => r.id)).toEqual([room.id]);
    expect(reopened?.members.find((m) => m.authorId === after)?.author.displayName).toBe('You');
  });
});

describe('RoomService — a thread reply is an addressing act', () => {
  /**
   * What the cockpit's new reply affordance actually costs (DOR-731).
   *
   * Replying in a thread posts through `POST /:id/threads`, which is
   * `RoomService.post` with a `replyTo` — so it runs the SAME addressing,
   * budget and cascade rules an ordinary post does. The client adds no
   * mechanism for any of that, which is exactly why it has to be pinned here:
   * nothing in the browser can tell "the reply reached the agent" apart from
   * "the reply rendered" if the agent never had to answer.
   *
   * `mention-only` on purpose. A channel seeds `engaged`, which would leave Ana
   * answerable for ten minutes after the first message and make the SECOND
   * assertion below true for a reason that has nothing to do with the thread.
   */
  const agents = agentLookupFor({
    '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
  });

  it('triggers the agent a reply names, and answers inside the same thread', async () => {
    const harness = createRoomHarness({
      agents,
      runner: scriptedRunner(() => 'the cache is cold'),
    });
    const room = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
      harness.human
    );
    const ana = harness.service.addMember(room.id, harness.human, {
      agentPath: '/agents/ana',
      responseMode: 'mention-only',
    }).authorId;

    // A root nobody is named in: the thread is the only thing that can trigger her.
    const root = harness.service.post(room.id, {
      authorId: harness.human,
      text: 'the build is slow',
    });
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toEqual([]);

    harness.service.post(room.id, {
      authorId: harness.human,
      text: `@ana any idea?`,
      replyTo: root.id,
    });
    await harness.service.triggersIdle();

    // She ran, and she ran on the reply's own words.
    expect(harness.runner.turns).toHaveLength(1);
    expect(harness.runner.turns[0]?.authorId).toBe(ana);
    expect(harness.runner.turns[0]?.prompt).toBe('@ana any idea?');

    // And her answer is in the thread, not loose in the room. An answer that
    // surfaced in the channel would move the conversation out from under the
    // aside it belongs to — the thing threads exist to prevent.
    const log = harness.service.listEntries(room.id, harness.human, { limit: 50 });
    const answer = log.find((entry) => entry.authorId === ana);
    expect(answer?.body.text).toBe('the cache is cold');
    expect(answer?.threadRootEntryId).toBe(root.id);
  });

  it('spends the room budget the same way a top-level message does', async () => {
    // The reply route adds no fresh allowance. A thread that could not run out
    // would be a way around the one limit that keeps a room from running all
    // night.
    const harness = createRoomHarness({
      agents,
      runner: scriptedRunner(() => null),
      maxAutomaticTurnsPerRoomPerHour: 1,
    });
    const room = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
      harness.human
    );
    harness.service.addMember(room.id, harness.human, {
      agentPath: '/agents/ana',
      responseMode: 'mention-only',
    });

    const root = harness.service.post(room.id, { authorId: harness.human, text: '@ana ping' });
    await harness.service.triggersIdle();
    expect(harness.runner.turns).toHaveLength(1);

    harness.service.post(room.id, {
      authorId: harness.human,
      text: '@ana again',
      replyTo: root.id,
    });
    await harness.service.triggersIdle();

    expect(harness.runner.turns).toHaveLength(1);
  });
});

describe('RoomService — a committed post never fails because dispatching from it did', () => {
  // The poster's own successful message used to 500.
  //
  // `dispatch` runs its target selection SYNCHRONOUSLY inside `post`, and the
  // routes map anything that is not a `RoomError` to a 500 — so one SQLite write
  // that lost a race, deep inside trigger selection, surfaced to the person as a
  // failure of the message they had just sent. It was already committed,
  // published, and visible to everyone else in the room.
  //
  // Losing the replies to a message is bad, visible in the room, and recoverable
  // by asking again. Losing the message looks like a broken product.

  const agents = agentLookupFor({
    '/agents/ana': { name: 'ana', displayName: 'Ana' },
    '/agents/bo': { name: 'bo', displayName: 'Bo' },
  });

  /** A channel holding Ana and Bo, each answering only when named. */
  function open(): ReturnType<typeof createRoomHarness> & { roomId: string } {
    const harness = createRoomHarness({ agents, runner: scriptedRunner(() => 'on it') });
    const room = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
      harness.human
    );
    for (const agentPath of ['/agents/ana', '/agents/bo']) {
      harness.service.addMember(room.id, harness.human, {
        agentPath,
        responseMode: 'mention-only',
      });
    }
    return { ...harness, roomId: room.id };
  }

  it('drops only the agent whose session binding could not be written', async () => {
    // Two agents named by one message, and the first bind throws. The binds run
    // in their own pass BEFORE any claim is taken, so there is nothing to unwind
    // — the failed target simply never becomes one, and the other still answers.
    const harness = open();
    const realBind = harness.store.bindRoomSession.bind(harness.store);
    let firstBind = true;
    const bindings = vi.spyOn(harness.store, 'bindRoomSession').mockImplementation((...args) => {
      if (!firstBind) return realBind(...args);
      firstBind = false;
      throw new Error('SQLITE_BUSY: database is locked');
    });

    const entry = harness.service.post(harness.roomId, {
      authorId: harness.human,
      text: '@ana @bo can you both look?',
    });
    await harness.service.triggersIdle();
    bindings.mockRestore();

    // The message is committed and returned, not a 500.
    expect(entry.body.text).toBe('@ana @bo can you both look?');
    expect(
      harness.service.listEntries(harness.roomId, harness.human, { limit: 10 })
    ).toContainEqual(expect.objectContaining({ id: entry.id }));
    // One agent lost its turn; the other kept it.
    expect(harness.runner.turns).toHaveLength(1);
    // And nothing is left saying somebody is working. A claim taken for a target
    // that never ran would be re-stated every ten seconds forever, which is the
    // one stale indicator a client's TTL cannot heal.
    expect(harness.service.listRooms(harness.human)[0].working).toBe(0);
  });

  it('keeps the message when trigger selection throws outright', async () => {
    // The whole dispatch, not one target: whatever else in there learns to throw
    // later is covered by the same guard.
    const harness = open();
    const ancestry = vi.spyOn(harness.store, 'authorsInCascade').mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });

    const entry = harness.service.post(harness.roomId, {
      authorId: harness.human,
      text: '@ana can you look?',
    });
    await harness.service.triggersIdle();
    ancestry.mockRestore();

    expect(
      harness.service.listEntries(harness.roomId, harness.human, { limit: 10 })
    ).toContainEqual(expect.objectContaining({ id: entry.id }));
    expect(harness.runner.turns).toHaveLength(0);
    expect(harness.service.listRooms(harness.human)[0].working).toBe(0);
  });
});
