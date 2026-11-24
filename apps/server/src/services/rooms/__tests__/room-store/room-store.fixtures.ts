/**
 * Shared entry and room seeds for the `RoomStore` suites.
 *
 * @module server/services/rooms/__tests__/room-store/room-store.fixtures
 */
import { RoomStore, type NewRoomEntry } from '../../room-store.js';

export const ROOM_ID = 'room-1';

/** A minimal appendable entry; the caller supplies whatever it wants to vary. */
export function entry(overrides: Partial<NewRoomEntry> & { id: string }): NewRoomEntry {
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
export function seedRoom(store: RoomStore, id = ROOM_ID): void {
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
