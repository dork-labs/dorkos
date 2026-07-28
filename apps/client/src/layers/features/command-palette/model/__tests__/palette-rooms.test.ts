import { describe, it, expect } from 'vitest';
import {
  sortRoomsForPalette,
  paletteRoomTarget,
  paletteRoomKeywords,
  threadParentLabel,
} from '../palette-rooms';
import type { RoomSummary } from '@dorkos/shared/room-schemas';

function makeRoom(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'room-default',
    kind: 'channel',
    parentId: null,
    slug: 'default',
    title: 'Default',
    topic: null,
    workspaceId: null,
    rootEntryId: null,
    archived: false,
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

describe('paletteRoomTarget', () => {
  it('addresses a channel by its own id', () => {
    expect(paletteRoomTarget(makeRoom({ id: 'room-general' }))).toEqual({ id: 'room-general' });
  });

  it('keeps a thread’s parent in the URL so leaving the thread returns to it', () => {
    const thread = makeRoom({ id: 'thread-1', kind: 'thread', parentId: 'room-general' });
    expect(paletteRoomTarget(thread)).toEqual({ id: 'room-general', thread: 'thread-1' });
  });

  it('falls back to the thread itself when it carries no parent', () => {
    const orphan = makeRoom({ id: 'thread-1', kind: 'thread', parentId: null });
    expect(paletteRoomTarget(orphan)).toEqual({ id: 'thread-1' });
  });
});

describe('threadParentLabel', () => {
  const parent = makeRoom({ id: 'room-general', slug: 'general', title: 'General' });
  const thread = makeRoom({
    id: 'thread-1',
    kind: 'thread',
    slug: null,
    parentId: 'room-general',
    title: 'Deploy fallout',
  });
  const byId = new Map([
    [parent.id, parent],
    [thread.id, thread],
  ]);

  it('names the room a thread hangs off, the way people say it', () => {
    expect(threadParentLabel(thread, byId)).toBe('#general');
  });

  it('drops the breadcrumb rather than inventing one when the parent is not visible', () => {
    expect(threadParentLabel(thread, new Map([[thread.id, thread]]))).toBeNull();
  });

  it('answers null for a room that is not a thread', () => {
    expect(threadParentLabel(parent, byId)).toBeNull();
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
        { id: 'a1', kind: 'agent', displayName: 'Bo' },
        { id: 'a2', kind: 'agent', displayName: 'Cid' },
        { id: 'a3', kind: 'agent', displayName: 'Ana' },
      ],
    });

    expect(paletteRoomKeywords(groupDm)).toEqual(['Bo and Cid', 'Bo', 'Cid', 'Ana']);
  });
});
