import { describe, it, expect } from 'vitest';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { mergeRoomHistory, olderCursor } from '../lib/history';

function entry(seq: number, over: Partial<RoomEntry> = {}): RoomEntry {
  return {
    roomId: 'room-1',
    seq,
    id: `entry-${seq}`,
    authorId: 'ana',
    kind: 'post',
    body: { text: `line ${seq}` },
    mentions: [],
    sessionId: null,
    cascadeRoot: `entry-${seq}`,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
    ...over,
  };
}

const seqs = (entries: readonly RoomEntry[]) => entries.map((held) => held.seq);

describe('mergeRoomHistory', () => {
  it('puts the roots riding with a page in front of it, in seq order', () => {
    // What everything above this reads: one array, oldest first, whatever
    // shape the wire delivered it in (DOR-690).
    const merged = mergeRoomHistory(undefined, {
      entries: [entry(152), entry(153)],
      threadRoots: [entry(1)],
    });

    expect(seqs(merged)).toEqual([1, 152, 153]);
  });

  it('lands an older page entirely in front of what is held', () => {
    // The invariant the read cursor and the stream's resume cursor both stand
    // on: they take the LAST element, and reading backwards must not move it.
    const held = [entry(10), entry(11)];

    const merged = mergeRoomHistory(held, { entries: [entry(8), entry(9)], threadRoots: [] });

    expect(seqs(merged)).toEqual([8, 9, 10, 11]);
    expect(merged.at(-1)!.seq).toBe(held.at(-1)!.seq);
  });

  it('takes the arriving copy of an entry it already had', () => {
    // A root fetched from behind the page comes back as an ordinary entry once
    // the reader loads the window it lives in. That copy is the fresher read of
    // the same message — and it is the one that no longer claims a reply count
    // the loaded replies have caught up with.
    const merged = mergeRoomHistory([entry(4, { threadReplyCount: 9 })], {
      entries: [entry(3), entry(4)],
      threadRoots: [],
    });

    expect(seqs(merged)).toEqual([3, 4]);
    expect(merged.find((held) => held.seq === 4)?.threadReplyCount).toBeUndefined();
  });

  it('is a no-op for a page that answered nothing', () => {
    const held = [entry(1), entry(2)];
    expect(seqs(mergeRoomHistory(held, { entries: [], threadRoots: [] }))).toEqual([1, 2]);
  });
});

describe('olderCursor', () => {
  it('is the PAGE’s oldest seq, never a root riding in front of it', () => {
    // The whole reason the envelope survives up to here. The root is at 1 and
    // the page floor is at 152; paging from 1 would ask for entries below the
    // ROOT and make everything between it and the page unreachable for good.
    expect(olderCursor({ entries: [entry(152), entry(153)], threadRoots: [entry(1)] })).toBe(152);
  });

  it('is null for an empty page — the beginning of what this reader may see', () => {
    expect(olderCursor({ entries: [], threadRoots: [] })).toBeNull();
  });
});
