import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { eq, roomSessions, type Db } from '@dorkos/db';
import { eventFanOut } from '../../../core/event-fan-out.js';
import type { AuthorRegistry } from '../../author-registry.js';
import type { ReadCursorService } from '../../../core/read-cursor-service.js';
import type { RoomService } from '../../room-service.js';
import type { RoomStore } from '../../room-store.js';
import { RoomError } from '../../room-errors.js';
import { createRoomHarness, roomSpec } from '../room-test-harness.js';

import { agentLookup } from './room-service.fixtures.js';

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
      const room = service.createRoom(roomSpec('channel', 'Backend Work'), human);

      expect(room.slug).toBe('backend-work');
      expect(room.members.map((m) => m.authorId)).toEqual([human]);
      expect(room.archived).toBe(false);
    });

    // The slug derivation trimmed hyphens with `^-+|-+$`, which CodeQL flags as
    // quadratic (js/polynomial-redos) and which the collapse on the line above
    // defuses — an invariant invisible from the line it protects, on a path
    // where a title arrives from a request. `^-|-$` answers identically; these
    // are the cases that say so, including the 80-character truncation, which
    // is the one place a trailing hyphen can appear after the trim.
    it.each([
      ['--- Backend ---', 'backend'],
      ['!!!Backend!!!', 'backend'],
      ['Backend - - - Work', 'backend-work'],
      ['   Backend   ', 'backend'],
      [`${'a'.repeat(79)} b`, 'a'.repeat(79)],
      [`${'a'.repeat(80)}b`, 'a'.repeat(80)],
    ])('derives the slug for the hyphen-heavy title %j', (title, expected) => {
      const room = service.createRoom(
        { kind: 'channel', title, members: [], agentPaths: [] },
        human
      );
      expect(room.slug).toBe(expected);
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
      expect(() => service.createRoom(roomSpec('channel', '🎉🎉'), human)).toThrow(/slug/i);
    });

    it('announces the new room on the global event stream', () => {
      const broadcast = vi.spyOn(eventFanOut, 'broadcast');
      const room = service.createRoom(roomSpec('dm', 'Ana'), human);
      expect(broadcast).toHaveBeenCalledWith(
        'room_created',
        expect.objectContaining({ roomId: room.id, kind: 'dm' }),
        expect.any(Function)
      );
      broadcast.mockRestore();
    });
  });

  describe('seeding responseMode', () => {
    it('seeds a channel membership to engaged, whatever the manifest says', () => {
      const room = service.createRoom(roomSpec('channel', 'Backend'), human);
      const member = service.addMember(room.id, human, { agentPath: '/agents/ana' });
      expect(member.responseMode).toBe('engaged');
    });

    it('seeds a DM membership from the agent manifest', () => {
      const room = service.createRoom(roomSpec('dm', 'Ana'), human);
      expect(service.addMember(room.id, human, { agentPath: '/agents/ana' }).responseMode).toBe(
        'always'
      );
      expect(service.addMember(room.id, human, { agentPath: '/agents/bo' }).responseMode).toBe(
        'silent'
      );
    });

    it('takes an explicit override over either seed', () => {
      const room = service.createRoom(roomSpec('channel', 'Backend'), human);
      const member = service.addMember(room.id, human, {
        agentPath: '/agents/ana',
        responseMode: 'direct-only',
      });
      expect(member.responseMode).toBe('direct-only');
    });

    it('does not retroactively change a stored membership when a manifest would differ', () => {
      const room = service.createRoom(roomSpec('dm', 'Ana'), human);
      const joined = service.addMember(room.id, human, { agentPath: '/agents/ana' });
      service.updateMembership(room.id, human, joined.authorId, 'silent');
      expect(
        service.getRoom(room.id, human)?.members.find((m) => m.authorId === joined.authorId)
          ?.responseMode
      ).toBe('silent');
    });

    it('refuses an agent path nothing is registered at', () => {
      const room = service.createRoom(roomSpec('dm', 'Nobody'), human);
      expect(() => service.addMember(room.id, human, { agentPath: '/agents/ghost' })).toThrow(
        RoomError
      );
    });
  });

  describe('posting', () => {
    let roomId: string;
    let ana: string;

    beforeEach(() => {
      const room = service.createRoom(roomSpec('channel', 'Backend'), human);
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
      // The other publish is the room's 👀 receipt for Ana (DOR-2823).
      expect(published.filter((event) => (event as { type: string }).type !== 'reaction')).toEqual([
        expect.objectContaining({ type: 'entry' }),
      ]);
      publish.mockRestore();
    });
  });

  describe('threads', () => {
    let roomId: string;
    let rootEntryId: string;

    beforeEach(() => {
      const room = service.createRoom(roomSpec('channel', 'Backend'), human);
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

    it('refuses a reply whose root is itself a reply, and writes nothing', () => {
      const before = service.listEntries(roomId, human, { limit: 50 }).length;
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
      const other = service.createRoom(roomSpec('channel', 'Frontend'), human);
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

    // A spy left behind by a failed assertion would leak into every later test.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    beforeEach(() => {
      roomId = service.createRoom(roomSpec('channel', 'Backend'), human).id;
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
      const other = service.createRoom(roomSpec('channel', 'Other'), human).id;
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
      expect(broadcast).toHaveBeenCalledWith(
        'read_cursor',
        { userId: human, threadKind: 'room', threadId: roomId, lastReadSeq: 2, unreadCount: 1 },
        expect.any(Function)
      );
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
      const roomId = service.createRoom(roomSpec('dm', 'Ana'), human).id;
      const ana = service.addMember(roomId, human, { agentPath: '/agents/ana' }).authorId;

      service.removeMember(roomId, human, ana);
      expect(service.getRoom(roomId, human)?.members.map((m) => m.authorId)).toEqual([human]);
      expect(() => service.removeMember(roomId, human, ana)).toThrow(RoomError);
    });

    it('drops the per-room session binding with the membership', () => {
      const roomId = service.createRoom(roomSpec('dm', 'Ana'), human).id;
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
