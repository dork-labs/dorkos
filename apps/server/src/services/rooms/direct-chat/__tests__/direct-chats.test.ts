/**
 * Each agent's standing Direct chat (rule S12, DOR-2997), over the real rooms
 * graph: which rooms are one, which session they open, and what a turn there
 * is told about messages that never reached it.
 *
 * @module server/services/rooms/direct-chat/__tests__/direct-chats
 */
import { describe, expect, it } from 'vitest';
import {
  agentLookupFor,
  createRoomHarness,
  type RoomHarness,
} from '../../__tests__/room-test-harness.js';
import { DirectChats, DIRECT_NOTES_LIMIT } from '../direct-chats.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana' },
  '/agents/bo': { name: 'bo', displayName: 'Bo' },
});

let harness: RoomHarness;
let minted = 0;

function open(): { harness: RoomHarness; chats: DirectChats } {
  harness = createRoomHarness({ agents });
  minted = 0;
  const chats = new DirectChats({
    store: harness.store,
    authors: harness.authors,
    rooms: harness.service,
    operator: () => harness.authors.getMany([harness.human]).get(harness.human)!,
    mintSessionId: () => `session-${++minted}`,
    now: () => '2026-10-17T12:00:00.000Z',
  });
  return { harness, chats };
}

/** The person's DM with Ana, opened the way the app opens one. */
function anaDm(h: RoomHarness) {
  return h.service.createRoom(
    { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
    h.human
  );
}

describe('opening a Direct chat', () => {
  it('opens one DM and one session the first time, and the same ones after', () => {
    const { harness: h, chats } = open();
    const first = chats.ensureForAgent('/agents/ana', 'Ana');
    const again = chats.ensureForAgent('/agents/ana', 'Ana');
    expect(again).toEqual(first);
    expect(first.sessionId).toBe('session-1');
    expect(first.agentPath).toBe('/agents/ana');
    expect(h.store.listMembers(first.roomId)).toHaveLength(2);
    expect(chats.ensureForRoom(first.roomId)).toEqual(first);
  });

  it('folds in an existing DM, keeping the session that already answers there', () => {
    const { harness: h, chats } = open();
    const room = anaDm(h);
    const ana = h.authors.resolveAgent('/agents/ana', 'Ana').id;
    h.store.bindRoomSession(room.id, ana, 'old-room-session', '2026-10-01T00:00:00.000Z');

    const chat = chats.ensureForRoom(room.id);

    expect(chat).toMatchObject({ roomId: room.id, sessionId: 'old-room-session' });
    expect(chats.ensureForAgent('/agents/ana', 'Ana')).toEqual(chat);
    expect(minted).toBe(0);
  });

  it('brings an archived DM back rather than opening a second one', () => {
    const { harness: h, chats } = open();
    const room = anaDm(h);
    h.service.updateRoom(room.id, h.human, { archived: true });

    expect(chats.ensureForAgent('/agents/ana', 'Ana').roomId).toBe(room.id);
    expect(h.store.getRoom(room.id)?.archived).toBe(false);
  });
});

describe('what is not a Direct chat', () => {
  it('a channel', () => {
    const { harness: h, chats } = open();
    const room = h.service.createRoom(
      { kind: 'channel', slug: 'general', agentPaths: ['/agents/ana'], members: [] },
      h.human
    );
    expect(chats.ensureForRoom(room.id)).toBeNull();
  });

  it('a DM with two agents', () => {
    const { harness: h, chats } = open();
    const room = h.service.createRoom(
      { kind: 'dm', title: 'Ana and Bo', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
      h.human
    );
    expect(chats.ensureForRoom(room.id)).toBeNull();
  });

  it('a DM that gained a member, and the next one opens fresh', () => {
    const { harness: h, chats } = open();
    const first = chats.ensureForAgent('/agents/ana', 'Ana');
    h.service.addMember(first.roomId, h.human, { agentPath: '/agents/bo' });

    expect(chats.ensureForRoom(first.roomId)).toBeNull();
    expect(chats.forSession(first.sessionId)).toBeNull();
    const next = chats.ensureForAgent('/agents/ana', 'Ana');
    expect(next.roomId).not.toBe(first.roomId);
    expect(next.sessionId).not.toBe(first.sessionId);
  });

  it('a bridged chat with the same two members', () => {
    const { harness: h, chats } = open();
    const bridged = h.service.createBridgedRoom({
      adapterId: 'tg-main',
      chatId: '555',
      bindingId: 'binding-ana',
      chatType: 'private',
      channelType: null,
      title: 'Ana',
      agentPath: '/agents/ana',
      operatorAuthorId: h.human,
    });
    expect(chats.ensureForRoom(bridged.id)).toBeNull();
  });

  it('a session no room answers with', () => {
    const { chats } = open();
    expect(chats.forSession('nobody')).toBeNull();
    expect(chats.takeUnseen('nobody')).toBeNull();
  });
});

describe('what a turn in a Direct chat is told', () => {
  it('carries pings once, marked as the agent’s own, oldest first', () => {
    const { harness: h, chats } = open();
    const chat = chats.ensureForAgent('/agents/ana', 'Ana');
    h.service.post(chat.roomId, { authorId: chat.agentAuthorId, text: 'deploy is green' });
    h.service.post(chat.roomId, { authorId: chat.agentAuthorId, text: 'need your OK on #42' });

    const notes = chats.takeUnseen(chat.sessionId);

    expect(notes?.notes.map((note) => [note.text, note.fromYou])).toEqual([
      ['deploy is green', true],
      ['need your OK on #42', true],
    ]);
    expect(notes?.omitted).toBe(0);
    chats.turnStarted(chat.sessionId);
    expect(chats.takeUnseen(chat.sessionId)).toBeNull();
  });

  it('keeps them for the next turn when the turn that took them never starts', () => {
    const { harness: h, chats } = open();
    const chat = chats.ensureForAgent('/agents/ana', 'Ana');
    h.service.post(chat.roomId, { authorId: chat.agentAuthorId, text: 'need your OK' });

    expect(chats.takeUnseen(chat.sessionId)?.notes).toHaveLength(1);
    // Held, refused or failed on the way in: no turn started.
    expect(chats.takeUnseen(chat.sessionId)?.notes).toHaveLength(1);
    chats.turnStarted(chat.sessionId);
    expect(chats.takeUnseen(chat.sessionId)).toBeNull();
  });

  it('leaves out what this session already said there', () => {
    const { harness: h, chats } = open();
    const chat = chats.ensureForAgent('/agents/ana', 'Ana');
    h.service.post(chat.roomId, {
      authorId: chat.agentAuthorId,
      text: 'from this session',
      sessionId: chat.sessionId,
    });
    h.service.post(chat.roomId, { authorId: chat.agentAuthorId, text: 'from elsewhere' });

    expect(chats.takeUnseen(chat.sessionId)?.notes.map((note) => note.text)).toEqual([
      'from elsewhere',
    ]);
  });

  it('keeps the newest when there are too many, and says how many it left out', () => {
    const { harness: h, chats } = open();
    const chat = chats.ensureForAgent('/agents/ana', 'Ana');
    for (let i = 1; i <= DIRECT_NOTES_LIMIT + 3; i += 1) {
      h.service.post(chat.roomId, { authorId: chat.agentAuthorId, text: `ping ${i}` });
    }

    const notes = chats.takeUnseen(chat.sessionId);

    expect(notes?.notes).toHaveLength(DIRECT_NOTES_LIMIT);
    expect(notes?.notes[0].text).toBe('ping 4');
    expect(notes?.omitted).toBe(3);
  });
});
