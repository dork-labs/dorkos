import { describe, it, expect } from 'vitest';
import { sortRoomsForPalette, paletteRoomKeywords } from '../palette-rooms';
import type { RoomSummary } from '@dorkos/shared/room-schemas';

function makeRoom(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'room-default',
    kind: 'channel',
    slug: 'default',
    title: 'Default',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-07-26T10:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    unreadCount: null,
    participants: null,
    ...overrides,
  };
}

describe('sortRoomsForPalette', () => {
  it('puts an unread room above a read one that spoke more recently', () => {
    const unread = makeRoom({
      id: 'unread',
      lastActivityAt: '2026-07-26T09:00:00.000Z',
      unreadCount: 1,
    });
    const read = makeRoom({
      id: 'read',
      lastActivityAt: '2026-07-26T18:00:00.000Z',
      unreadCount: 0,
    });

    // Fed in the order recency alone would produce, so the assertion can only
    // pass if unread genuinely outranks it.
    expect(sortRoomsForPalette([read, unread]).map((r) => r.id)).toEqual(['unread', 'read']);
  });

  it('puts an archived room below a live one, whatever either of them is owed', () => {
    // Archived rooms are in this list so a channel somebody closed can still be
    // FOUND (DOR-1051) — not so one can outrank a conversation that is still
    // going. The archived room here is both unread and the most recent thing
    // that spoke, so it wins on every other key.
    const archived = makeRoom({
      id: 'archived',
      archived: true,
      lastActivityAt: '2026-07-26T20:00:00.000Z',
      unreadCount: 3,
    });
    const live = makeRoom({
      id: 'live',
      lastActivityAt: '2026-07-26T09:00:00.000Z',
      unreadCount: 0,
    });

    expect(sortRoomsForPalette([archived, live]).map((r) => r.id)).toEqual(['live', 'archived']);
  });

  it('still ranks archived rooms against each other', () => {
    const older = makeRoom({
      id: 'older',
      archived: true,
      lastActivityAt: '2026-07-26T09:00:00.000Z',
    });
    const newer = makeRoom({
      id: 'newer',
      archived: true,
      lastActivityAt: '2026-07-26T18:00:00.000Z',
    });

    expect(sortRoomsForPalette([older, newer]).map((r) => r.id)).toEqual(['newer', 'older']);
  });

  it('treats a room the reader is not in as read, not as unread', () => {
    // `unreadCount: null` means "you are not a member", which is not zero.
    // Collapsing the two would float every room the operator has ever seen to
    // the top of an empty palette.
    const nonMember = makeRoom({
      id: 'non-member',
      lastActivityAt: '2026-07-26T09:00:00.000Z',
      unreadCount: null,
    });
    const memberCaughtUp = makeRoom({
      id: 'caught-up',
      lastActivityAt: '2026-07-26T18:00:00.000Z',
      unreadCount: 0,
    });

    expect(sortRoomsForPalette([nonMember, memberCaughtUp]).map((r) => r.id)).toEqual([
      'caught-up',
      'non-member',
    ]);
  });

  it('orders two unread rooms by which spoke last', () => {
    const older = makeRoom({
      id: 'older',
      lastActivityAt: '2026-07-26T09:00:00.000Z',
      unreadCount: 9,
    });
    const newer = makeRoom({
      id: 'newer',
      lastActivityAt: '2026-07-26T11:00:00.000Z',
      unreadCount: 1,
    });

    // The bigger count is deliberately on the older room: recency breaks the
    // tie, not badge size.
    expect(sortRoomsForPalette([older, newer]).map((r) => r.id)).toEqual(['newer', 'older']);
  });

  it('breaks an exact tie on the id, so rows never swap between renders', () => {
    const a = makeRoom({ id: 'room-a', unreadCount: 1 });
    const b = makeRoom({ id: 'room-b', unreadCount: 1 });

    expect(sortRoomsForPalette([a, b]).map((r) => r.id)).toEqual(['room-b', 'room-a']);
    expect(sortRoomsForPalette([b, a]).map((r) => r.id)).toEqual(['room-b', 'room-a']);
  });

  it('leaves the caller’s array untouched', () => {
    const read = makeRoom({ id: 'read', unreadCount: 0 });
    const unread = makeRoom({
      id: 'unread',
      lastActivityAt: '2026-07-25T09:00:00.000Z',
      unreadCount: 1,
    });
    const input = [read, unread];

    sortRoomsForPalette(input);

    // The input is the query cache's own array; sorting in place would reorder
    // the sidebar under everyone else reading it.
    expect(input.map((r) => r.id)).toEqual(['read', 'unread']);
  });
});

describe('paletteRoomKeywords', () => {
  it('carries the bare slug, so `#gen` hits `general` after the prefix is stripped', () => {
    const channel = makeRoom({ slug: 'general', title: 'General chatter' });
    expect(paletteRoomKeywords(channel)).toEqual(['General chatter', 'general']);
  });

  it('carries everyone in a direct message, so `@ana` finds a group Ana is in', () => {
    const groupDm = makeRoom({
      kind: 'dm',
      slug: null,
      title: 'Bo and Cid',
      participants: [
        { id: 'a1', kind: 'agent', displayName: 'Bo', handle: null },
        { id: 'a2', kind: 'agent', displayName: 'Cid', handle: null },
        { id: 'a3', kind: 'agent', displayName: 'Ana', handle: null },
      ],
    });

    expect(paletteRoomKeywords(groupDm)).toEqual(['Bo and Cid', 'Bo', 'Cid', 'Ana']);
  });
});
