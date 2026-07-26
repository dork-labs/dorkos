import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { eventFanOut } from '../../core/event-fan-out.js';
import { AuthorRegistry } from '../author-registry.js';
import { RoomService } from '../room-service.js';
import { RoomError, type RoomAgentLookup } from '../room-errors.js';
import { RoomStore } from '../room-store.js';
import { RoomBroadcaster } from '../room-stream.js';

/** Ana answers everything by manifest; Bo stays quiet unless mentioned. */
const agentLookup: RoomAgentLookup = {
  byPath: (agentPath) => {
    if (agentPath === '/agents/ana') {
      return { name: 'ana', displayName: 'Ana', responseMode: 'always' };
    }
    if (agentPath === '/agents/bo') {
      return { name: 'bo', displayName: 'Bo', responseMode: 'silent' };
    }
    return null;
  },
};

describe('RoomService', () => {
  let db: Db;
  let service: RoomService;
  let authors: AuthorRegistry;
  let human: string;

  beforeEach(() => {
    db = createTestDb();
    authors = new AuthorRegistry(db);
    service = new RoomService({
      store: new RoomStore(db),
      authors,
      broadcaster: new RoomBroadcaster(),
      agents: agentLookup,
    });
    human = authors.localHuman().id;
  });

  describe('creating rooms', () => {
    it('derives a channel slug from its title and joins the creator', () => {
      const room = service.createRoom(
        { kind: 'channel', title: 'Backend Work', members: [] },
        human
      );

      expect(room.slug).toBe('backend-work');
      expect(room.members.map((m) => m.authorId)).toEqual([human]);
      expect(room.archived).toBe(false);
    });

    it('refuses a second live channel on the same slug', () => {
      service.createRoom(
        { kind: 'channel', slug: 'general', title: 'General', members: [] },
        human
      );
      expect(() =>
        service.createRoom({ kind: 'channel', slug: 'general', title: 'Also', members: [] }, human)
      ).toThrow(RoomError);
    });

    it('releases the slug once the channel is archived', () => {
      const first = service.createRoom(
        { kind: 'channel', slug: 'general', title: 'General', members: [] },
        human
      );
      service.updateRoom(first.id, { archived: true });

      const second = service.createRoom(
        { kind: 'channel', slug: 'general', title: 'General again', members: [] },
        human
      );
      expect(second.slug).toBe('general');
    });

    it('refuses a channel title with nothing sluggable in it', () => {
      expect(() =>
        service.createRoom({ kind: 'channel', title: '🎉🎉', members: [] }, human)
      ).toThrow(/slug/i);
    });

    it('announces the new room on the global event stream', () => {
      const broadcast = vi.spyOn(eventFanOut, 'broadcast');
      const room = service.createRoom({ kind: 'dm', title: 'Ana', members: [] }, human);
      expect(broadcast).toHaveBeenCalledWith(
        'room_created',
        expect.objectContaining({ roomId: room.id, kind: 'dm' })
      );
      broadcast.mockRestore();
    });
  });

  describe('seeding responseMode', () => {
    it('seeds a channel membership to mention-only, whatever the manifest says', () => {
      const room = service.createRoom({ kind: 'channel', title: 'Backend', members: [] }, human);
      const member = service.addMember(room.id, { agentPath: '/agents/ana' });
      expect(member.responseMode).toBe('mention-only');
    });

    it('seeds a DM membership from the agent manifest', () => {
      const room = service.createRoom({ kind: 'dm', title: 'Ana', members: [] }, human);
      expect(service.addMember(room.id, { agentPath: '/agents/ana' }).responseMode).toBe('always');
      expect(service.addMember(room.id, { agentPath: '/agents/bo' }).responseMode).toBe('silent');
    });

    it('takes an explicit override over either seed', () => {
      const room = service.createRoom({ kind: 'channel', title: 'Backend', members: [] }, human);
      const member = service.addMember(room.id, {
        agentPath: '/agents/ana',
        responseMode: 'direct-only',
      });
      expect(member.responseMode).toBe('direct-only');
    });

    it('does not retroactively change a stored membership when a manifest would differ', () => {
      const room = service.createRoom({ kind: 'dm', title: 'Ana', members: [] }, human);
      const joined = service.addMember(room.id, { agentPath: '/agents/ana' });
      service.updateMembership(room.id, joined.authorId, 'silent');
      expect(
        service.getRoom(room.id)?.members.find((m) => m.authorId === joined.authorId)?.responseMode
      ).toBe('silent');
    });

    it('refuses an agent path nothing is registered at', () => {
      const room = service.createRoom({ kind: 'dm', title: 'Nobody', members: [] }, human);
      expect(() => service.addMember(room.id, { agentPath: '/agents/ghost' })).toThrow(RoomError);
    });
  });

  describe('posting', () => {
    let roomId: string;
    let ana: string;

    beforeEach(() => {
      const room = service.createRoom({ kind: 'channel', title: 'Backend', members: [] }, human);
      roomId = room.id;
      ana = service.addMember(roomId, { agentPath: '/agents/ana' }).authorId;
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
      service.updateRoom(roomId, { archived: true });
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
    let parentId: string;
    let rootEntryId: string;
    let ana: string;

    beforeEach(() => {
      const room = service.createRoom({ kind: 'channel', title: 'Backend', members: [] }, human);
      parentId = room.id;
      ana = service.addMember(parentId, {
        agentPath: '/agents/ana',
        responseMode: 'direct-only',
      }).authorId;
      rootEntryId = service.post(parentId, { authorId: human, text: 'why is the build slow?' }).id;
    });

    it('opens a child room off an entry, inheriting the roster', () => {
      const thread = service.createThread(parentId, rootEntryId);

      expect(thread.kind).toBe('thread');
      expect(thread.parentId).toBe(parentId);
      expect(thread.rootEntryId).toBe(rootEntryId);
      expect(thread.members.map((m) => m.authorId).sort()).toEqual([human, ana].sort());
    });

    it('inherits the parent membership response mode, not the room-kind seed', () => {
      const thread = service.createThread(parentId, rootEntryId);
      expect(thread.members.find((m) => m.authorId === ana)?.responseMode).toBe('direct-only');
    });

    it('titles itself from the entry it hangs off', () => {
      expect(service.createThread(parentId, rootEntryId).title).toBe('why is the build slow?');
    });

    it('refuses a thread whose parent is itself a thread', () => {
      const thread = service.createThread(parentId, rootEntryId);
      const inThread = service.post(thread.id, { authorId: human, text: 'a follow-up' });

      expect(() => service.createThread(thread.id, inThread.id)).toThrow(
        expect.objectContaining({ code: 'NESTED_THREAD' })
      );
    });

    it('refuses a thread off an entry that is not in this room', () => {
      expect(() => service.createThread(parentId, 'no-such-entry')).toThrow(
        expect.objectContaining({ code: 'ENTRY_NOT_FOUND' })
      );
    });
  });

  describe('read cursor and unread counts', () => {
    let roomId: string;

    beforeEach(() => {
      roomId = service.createRoom({ kind: 'channel', title: 'Backend', members: [] }, human).id;
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

    it('keeps the cursor on the membership, so it is per (member, room)', () => {
      const other = service.createRoom({ kind: 'channel', title: 'Other', members: [] }, human).id;
      service.setReadCursor(roomId, human, 3);
      expect(service.listRooms(human).find((r) => r.id === other)?.unreadCount).toBe(0);
      expect(service.listRooms(human).find((r) => r.id === roomId)?.unreadCount).toBe(0);
    });

    it('refuses a cursor for someone who is not a member', () => {
      expect(() => service.setReadCursor(roomId, 'stranger', 1)).toThrow(RoomError);
    });
  });

  describe('removing members', () => {
    it('drops the membership and its per-room session binding', () => {
      const roomId = service.createRoom({ kind: 'dm', title: 'Ana', members: [] }, human).id;
      const ana = service.addMember(roomId, { agentPath: '/agents/ana' }).authorId;

      service.removeMember(roomId, ana);
      expect(service.getRoom(roomId)?.members.map((m) => m.authorId)).toEqual([human]);
      expect(() => service.removeMember(roomId, ana)).toThrow(RoomError);
    });
  });

  it('refuses every operation on a room that does not exist', () => {
    expect(() => service.updateRoom('nope', { title: 'x' })).toThrow(
      expect.objectContaining({ code: 'ROOM_NOT_FOUND' })
    );
    expect(() => service.post('nope', { authorId: human, text: 'x' })).toThrow(
      expect.objectContaining({ code: 'ROOM_NOT_FOUND' })
    );
    expect(service.getRoom('nope')).toBeNull();
  });
});
