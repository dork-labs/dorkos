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
  vi.spyOn(h.service.handoffs.reports, 'seatOf').mockReturnValue({
    roomId: room.id,
    authorId: author.id,
  });
  const post = scheduleNoticeRoom({
    within: (write) => h.db.transaction(() => write()),
    rooms: h.service,
    store: h.store,
    authors: h.authors,
    directChats: chats,
    owner: () => ({ path: ANA, name: 'Ana' }),
  });
  const task = { proposedBySessionId: 'creator' } as Task;
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
    post(task, { text: 'Grooming skipped 9:00 because this computer was asleep.' });
    const dm = chats.ensureForAgent(ANA, 'Ana');
    expect(h.store.listEntries(dm.roomId, { limit: 1 })[0].body.text).toContain('skipped');
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
});
