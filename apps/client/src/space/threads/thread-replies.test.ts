import { describe, expect, it } from 'vitest';
import type { CommunityWireThreadSummary } from '@dorkos/shared/community-wire';
import {
  THREAD_SUMMARY_BATCH,
  threadReplies,
  threadRepliesLabel,
  threadSummaryBatches,
} from './thread-replies.js';
import type { Entry } from '../types.js';

const ROOT = '00000000-0000-4000-8000-000000000001';
const OTHER_ROOT = '00000000-0000-4000-8000-000000000002';

function reply(id: number, seq: number, root = ROOT): Entry {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    channelId: '00000000-0000-4000-8000-00000000000c',
    seq,
    authorMemberId: '00000000-0000-4000-8000-00000000000a',
    authorDisplayName: 'Maya',
    authorKind: 'human',
    text: `reply ${seq}`,
    mentions: [],
    parentEntryId: root,
    threadRootEntryId: root,
    createdAt: `2026-09-29T10:00:${String(seq).padStart(2, '0')}.000Z`,
    cursor: `cursor-${seq}`,
    attachments: [],
  };
}

function summary(count: number, lastReplySeq: number, root = ROOT): CommunityWireThreadSummary {
  return {
    rootEntryId: root,
    replyCount: count,
    lastReplyAt: '2026-09-29T09:00:00.000Z',
    lastReplySeq,
  };
}

const seen = (...entries: Entry[]) => new Map(entries.map((entry) => [entry.id, entry]));

describe('threadReplies', () => {
  it('shows the server count for a root', () => {
    const lines = threadReplies(new Map([[ROOT, summary(3, 20)]]), new Map());
    expect(lines.get(ROOT)).toEqual({ count: 3, lastAt: '2026-09-29T09:00:00.000Z' });
  });

  it('adds a reply that arrived after the count, and dates the line by it', () => {
    const lines = threadReplies(new Map([[ROOT, summary(3, 20)]]), seen(reply(1, 21)));
    expect(lines.get(ROOT)).toEqual({ count: 4, lastAt: '2026-09-29T10:00:21.000Z' });
  });

  it('never counts twice a reply the server count already holds', () => {
    const lines = threadReplies(
      new Map([[ROOT, summary(3, 20)]]),
      seen(reply(1, 19), reply(2, 20), reply(3, 22))
    );
    expect(lines.get(ROOT)?.count).toBe(4);
  });

  it('counts live replies for a root the server had no count for', () => {
    const lines = threadReplies(new Map(), seen(reply(1, 5), reply(2, 6)));
    expect(lines.get(ROOT)).toEqual({ count: 2, lastAt: '2026-09-29T10:00:06.000Z' });
  });

  it('keeps each root to its own replies, and leaves a root with none out', () => {
    const lines = threadReplies(
      new Map([[OTHER_ROOT, summary(1, 3, OTHER_ROOT)]]),
      seen(reply(1, 4))
    );
    expect(lines.get(ROOT)?.count).toBe(1);
    expect(lines.get(OTHER_ROOT)?.count).toBe(1);
    expect(lines.size).toBe(2);
    expect(threadReplies(new Map(), new Map()).size).toBe(0);
  });

  it('ignores a top-level message', () => {
    const topLevel = { ...reply(1, 9), parentEntryId: null, threadRootEntryId: null };
    expect(threadReplies(new Map(), seen(topLevel)).size).toBe(0);
  });
});

describe('threadSummaryBatches', () => {
  it('splits roots into batches the route accepts, without repeats', () => {
    const ids = Array.from({ length: THREAD_SUMMARY_BATCH + 5 }, (_, index) => `id-${index}`);
    const batches = threadSummaryBatches([...ids, 'id-0']);
    expect(batches.map((batch) => batch.length)).toEqual([THREAD_SUMMARY_BATCH, 5]);
    expect(threadSummaryBatches([])).toEqual([]);
  });
});

describe('threadRepliesLabel', () => {
  it('says reply or replies', () => {
    expect(threadRepliesLabel({ count: 1, lastAt: '' }, '9:45 AM')).toBe('1 reply · last 9:45 AM');
    expect(threadRepliesLabel({ count: 3, lastAt: '' }, '9:45 AM')).toBe(
      '3 replies · last 9:45 AM'
    );
  });
});
