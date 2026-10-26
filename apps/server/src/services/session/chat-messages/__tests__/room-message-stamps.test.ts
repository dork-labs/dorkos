/**
 * A forwarded comment's "via" rides the room stamp only from the room's own
 * record of the entry, never from what a runtime wrote (DOR-3325).
 */
import { describe, it, expect } from 'vitest';
import { completeRoomStamp, type RoomMessageFacts } from '../room-message-stamps.js';

const VIA = { extensionId: 'desk', appName: 'Dorian Desk', itemId: 'item-7' };

const facts = (over: Partial<RoomMessageFacts> = {}): RoomMessageFacts => ({
  roomLabel: 'PM',
  author: { id: 'a', kind: 'human', displayName: 'Dorian', handle: 'dorian', you: true },
  text: 'Yes',
  ...over,
});

describe('completeRoomStamp', () => {
  it('carries the via the room recorded for the entry', () => {
    const stamp = completeRoomStamp({ roomId: 'r', entryId: 'e' }, 'Yes', () =>
      facts({ via: VIA })
    );
    expect(stamp?.via).toEqual(VIA);
  });

  it('drops a via a runtime wrote into the stamp itself', () => {
    const stamp = completeRoomStamp({ roomId: 'r', entryId: 'e', via: VIA }, 'Yes', () => facts());
    expect(stamp?.via).toBeUndefined();
  });

  it('drops a runtime-written via when the room no longer has the entry', () => {
    const stamp = completeRoomStamp({ roomId: 'r', entryId: 'e', via: VIA }, 'Yes', () => null);
    expect(stamp).toEqual({ roomId: 'r', entryId: 'e' });
  });
});
