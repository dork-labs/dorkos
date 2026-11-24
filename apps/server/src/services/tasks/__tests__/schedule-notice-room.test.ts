import { describe, it, expect, vi } from 'vitest';
import type { Task } from '@dorkos/shared/types';
import { createRoomHarness, agentLookupFor } from '../../rooms/__tests__/room-test-harness.js';
import { DirectChats } from '../../rooms/direct-chat/direct-chats.js';
import { scheduleNoticeRoom } from '../notices/schedule-notice-room.js';

const ANA = '/agents/ana';
function setup() {
  const h = createRoomHarness({ agents: agentLookupFor({ [ANA]: { name: 'Ana' } }) });
  const room = h.service.createRoom(
    {
      kind: 'channel',
      title: 'Work',
      members: [],
      agentPaths: [ANA],
    },
    h.human
  );
  const author = h.authors.resolveAgent(ANA, 'Ana');
  const chats = new DirectChats({
    store: h.store,
    authors: h.authors,
    rooms: h.service,
    operator: () => h.authors.getById(h.human)!,
  });
  // 'creator' is Ana's seat in the room, as a turn there would leave it.
  h.store.bindRoomSession(room.id, author.id, 'creator', new Date().toISOString());
  const post = scheduleNoticeRoom({
    within: (write) => h.db.transaction(() => write()),
    rooms: h.service,
    store: h.store,
    authors: h.authors,
    directChats: chats,
    owner: () => ({ path: ANA, name: 'Ana' }),
  });
  const task = { proposedBySessionId: 'creator', createdAt: new Date().toISOString() } as Task;
  return { h, room, author, post, task, chats };
}

describe('schedule report destination', () => {
  it('posts by DorkOS, with no mentions, session or agent turn', async () => {
    const { h, room, task, post } = setup();
    post(task, { text: 'Grooming failed twice in a row: an unknown error.' });
    await h.service.triggersIdle();
    const [entry] = h.store.listEntries(room.id, { limit: 1 });
    expect(entry.kind).toBe('notice');
    expect(h.authors.getById(entry.authorId)?.kind).toBe('system');
    expect(entry.mentions).toEqual([]);
    expect(entry.sessionId).toBeNull();
    expect(h.runner.turns).toHaveLength(0);
  });

  it('falls back to the owner DM when the original room was removed', () => {
    const { h, room, post, task, chats } = setup();
    const get = h.store.getRoom.bind(h.store);
    vi.spyOn(h.store, 'getRoom').mockImplementation((id) => (id === room.id ? null : get(id)));
    post(task, { text: 'Grooming missed 9:00, likely because this computer was asleep.' });
    const dm = chats.ensureForAgent(ANA, 'Ana');
    expect(h.store.listEntries(dm.roomId, { limit: 1 })[0].body.text).toContain('missed');
    expect(h.store.listEntries(room.id, { limit: 10 })).toHaveLength(0);
  });

  it('rechecks ownership on every post after the owner leaves', () => {
    const { h, room, author, post, task, chats } = setup();
    post(task, { text: 'First report.' });
    h.store.removeMember(room.id, author.id);
    post(task, { text: 'Second report.' });
    expect(h.store.listEntries(room.id, { limit: 10 }).map((e) => e.body.text)).toEqual([
      'First report.',
    ]);
    const dm = chats.ensureForAgent(ANA, 'Ana');
    expect(h.store.listEntries(dm.roomId, { limit: 1 })[0].body.text).toBe('Second report.');
  });

  // DOR-3753: the seat's old chat stays a real chat a person can reopen. A schedule proposed
  // there after the seat moved is that chat's, not the room's, so its notices go to the DM.
  describe('after the seat moved to a fresh chat', () => {
    function move(h: ReturnType<typeof setup>['h'], roomId: string, authorId: string): number {
      expect(h.store.rebindRoomSession(roomId, authorId, 'fresh-seat')).toBe(true);
      h.store.sessionLedger.recordSeatMove('creator', roomId, authorId);
      return h.store.sessionLedger.seatMovedFrom('creator')!.movedAt;
    }
    const at = (ms: number) => new Date(ms).toISOString();

    it('a schedule proposed from the old chat after the move posts to the owner DM', () => {
      const { h, room, author, post, chats } = setup();
      const movedAt = move(h, room.id, author.id);
      const task = { proposedBySessionId: 'creator', createdAt: at(movedAt + 60_000) } as Task;

      post(task, { text: 'Proposed after the move.' });

      expect(h.store.listEntries(room.id, { limit: 10 })).toHaveLength(0);
      const dm = chats.ensureForAgent(ANA, 'Ana');
      expect(h.store.listEntries(dm.roomId, { limit: 1 })[0].body.text).toBe(
        'Proposed after the move.'
      );
    });

    it('a schedule the seat proposed before the move still posts to the room', () => {
      const { h, room, author, post } = setup();
      const movedAt = move(h, room.id, author.id);
      const task = { proposedBySessionId: 'creator', createdAt: at(movedAt - 60_000) } as Task;

      post(task, { text: 'Proposed before the move.' });

      expect(h.store.listEntries(room.id, { limit: 1 })[0].body.text).toBe(
        'Proposed before the move.'
      );
    });

    it('a schedule with no readable proposal time posts to the owner DM', () => {
      const { h, room, author, post, chats } = setup();
      move(h, room.id, author.id);
      const task = { proposedBySessionId: 'creator', createdAt: 'not a date' } as Task;

      post(task, { text: 'Unknown time.' });

      expect(h.store.listEntries(room.id, { limit: 10 })).toHaveLength(0);
      const dm = chats.ensureForAgent(ANA, 'Ana');
      expect(h.store.listEntries(dm.roomId, { limit: 1 })[0].body.text).toBe('Unknown time.');
    });
  });
});
