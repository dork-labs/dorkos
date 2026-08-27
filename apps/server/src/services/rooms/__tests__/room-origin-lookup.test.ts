/**
 * The read behind the session-origin room overlay: which of these session ids
 * is a room answering with, and what is that room called.
 *
 * Driven against a real database rather than a fake, because the whole value of
 * this lookup is the join — a fake that returned a map would be asserting the
 * test's own opinion of which sessions are room turns.
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { RoomStore } from '../room-store.js';

const AT = '2026-08-01T00:00:00.000Z';

/** A store holding one channel, one DM, and nothing bound yet. */
function storeWithRooms(): RoomStore {
  const store = new RoomStore(createTestDb());
  store.createRoom(
    {
      id: 'room-general',
      kind: 'channel',
      slug: 'general',
      title: 'General',
      topic: null,
      createdAt: AT,
    },
    []
  );
  store.createRoom(
    {
      id: 'room-ana',
      kind: 'dm',
      slug: null,
      title: 'Ana',
      topic: null,
      createdAt: AT,
    },
    []
  );
  return store;
}

describe('RoomStore.resolveRoomOrigins', () => {
  it('answers for a bound session and says nothing about an unbound one', () => {
    const store = storeWithRooms();
    store.bindRoomSession('room-general', 'author-ana', 'session-in-general', AT);

    const origins = store.resolveRoomOrigins(['session-in-general', 'session-on-its-own']);

    expect(origins.get('session-in-general')).toEqual({
      roomLabel: '#general',
      roomId: 'room-general',
    });
    expect(origins.has('session-on-its-own')).toBe(false);
  });

  it('names a channel by its slug and a direct message by its title', () => {
    const store = storeWithRooms();
    store.bindRoomSession('room-general', 'author-ana', 's-channel', AT);
    store.bindRoomSession('room-ana', 'author-ana', 's-dm', AT);

    const origins = store.resolveRoomOrigins(['s-channel', 's-dm']);

    expect(origins.get('s-channel')?.roomLabel).toBe('#general');
    expect(origins.get('s-dm')?.roomLabel).toBe('Ana');
  });

  it('answers for every agent in a room — three agents mean three sessions', () => {
    const store = storeWithRooms();
    store.bindRoomSession('room-general', 'author-ana', 's-ana', AT);
    store.bindRoomSession('room-general', 'author-bo', 's-bo', AT);

    const origins = store.resolveRoomOrigins(['s-ana', 's-bo']);

    expect(origins.get('s-ana')?.roomId).toBe('room-general');
    expect(origins.get('s-bo')?.roomId).toBe('room-general');
  });

  // DOR-784: a runtime renames a session mid-turn and the ledger moves the
  // binding onto the new id. The lookup must follow the binding, not the id the
  // room first minted, or a room's live session reads as an ordinary one the
  // moment it is renamed — which is EVERY claude-code room, on turn one.
  it('follows a rebinding: the current id answers, the retired one does not', () => {
    const store = storeWithRooms();
    store.bindRoomSession('room-general', 'author-ana', 'placeholder-id', AT);
    store.sessionLedger.rebindBySessionId('placeholder-id', 'canonical-id');

    const origins = store.resolveRoomOrigins(['placeholder-id', 'canonical-id']);

    expect(origins.has('placeholder-id')).toBe(false);
    expect(origins.get('canonical-id')?.roomId).toBe('room-general');
  });

  it('asks the database nothing when asked about nothing', () => {
    expect(storeWithRooms().resolveRoomOrigins([]).size).toBe(0);
  });
});
