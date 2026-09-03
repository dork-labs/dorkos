import { describe, it, expect } from 'vitest';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { replyRootFor, threadRootIdOf, threadReplySummary } from '../lib/thread';

function entry(seq: number, overrides: Partial<RoomEntry> = {}): RoomEntry {
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
    createdAt: '2026-07-30T09:45:00.000Z',
    ...overrides,
  };
}

describe('threadRootIdOf', () => {
  it('places a top-level entry at the head of its own thread', () => {
    expect(threadRootIdOf(entry(1))).toBeNull();
  });

  it('falls back to the relation when only the scope pointer is missing', () => {
    expect(threadRootIdOf(entry(2, { parentEntryId: 'entry-1' }))).toBe('entry-1');
  });
});

describe('replyRootFor', () => {
  it('aims at the entry itself when it heads a thread', () => {
    expect(replyRootFor(entry(1))).toBe('entry-1');
  });

  it('aims a reply-to-a-reply at the root, which is what the server accepts', () => {
    expect(replyRootFor(entry(3, { threadRootEntryId: 'entry-1', parentEntryId: 'entry-2' }))).toBe(
      'entry-1'
    );
  });
});

describe('threadReplySummary', () => {
  const replies = [
    entry(2, { createdAt: '2026-07-30T09:40:00.000Z' }),
    entry(3, { createdAt: '2026-07-30T09:45:00.000Z' }),
  ];

  it('counts the replies and dates the newest one', () => {
    const summary = threadReplySummary(replies, null);
    expect(summary.count).toBe(2);
    expect(summary.lastAt).toBe('2026-07-30T09:45:00.000Z');
  });

  it('counts the room’s number when the thread reaches past what is loaded', () => {
    // DOR-690: a thread whose root came back from behind the page knows a
    // bigger number than the array does, and the row must say the bigger one.
    const summary = threadReplySummary(replies, null, 60);
    expect(summary.count).toBe(60);
    // The timestamp takes no such correction and needs none: what is missing is
    // the OLDEST replies, so the newest one is always in hand.
    expect(summary.lastAt).toBe('2026-07-30T09:45:00.000Z');
  });

  it('reads the newest by SEQ, not by the order it was handed', () => {
    // The log is the room's own order and `seq` is the only monotonic thing on
    // it — a clock skew between two writers must not decide what "last" means.
    const summary = threadReplySummary([replies[1]!, replies[0]!], null);
    expect(summary.lastAt).toBe('2026-07-30T09:45:00.000Z');
  });

  it('counts nothing unread for a reader who is not a member', () => {
    // No cursor, so no claim can be made — and the sidebar badges them nothing
    // either, so the two agree.
    expect(threadReplySummary(replies, null).unread).toBe(0);
  });

  it('counts the replies above the reader’s cursor', () => {
    expect(threadReplySummary(replies, 2).unread).toBe(1);
  });

  it('counts every reply for a member who has read nothing', () => {
    expect(threadReplySummary(replies, 0).unread).toBe(2);
  });

  it('counts nothing unread once the cursor is past the whole thread', () => {
    expect(threadReplySummary(replies, 9).unread).toBe(0);
  });

  it('refuses an empty thread rather than inventing a last reply', () => {
    // No replies means no row, so this cannot happen from the timeline — and if
    // it ever does, failing loudly beats drawing "0 replies · last NaN". The
    // invariant that keeps it unreachable is pinned on `groupByThread`.
    expect(() => threadReplySummary([], null)).toThrow();
  });
});
