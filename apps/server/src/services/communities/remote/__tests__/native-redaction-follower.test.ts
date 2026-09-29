/**
 * The native view's redaction follower, against a scripted feed: where it starts, what it hands
 * on, and when it stops asking (DOR-2544).
 *
 * @module services/communities/remote/__tests__/native-redaction-follower
 */
import {
  CommunityRoomNotFoundError,
  StaleCommunityCursorError,
  type CommunityRef,
} from '@dorkos/shared/community-adapter';
import { describe, expect, it, vi } from 'vitest';
import { logger } from '../../../../lib/logger.js';
import { followNativeRedactions } from '../native-redaction-follower.js';
import {
  RemoteRedactionFeedUnsupportedError,
  type RemoteRedactionPage,
} from '../remote-community-adapter.js';
import type { NativeMirrorEntry } from '../mirror-store.js';

const REF = 'remote_follow' as CommunityRef;

function item(id: string, roomId = 'room-a'): NativeMirrorEntry {
  return {
    entry: {
      community: REF,
      roomId,
      id,
      authorId: 'a',
      text: 'This message was deleted.',
      mentions: [],
      parentEntryId: null,
      threadRootEntryId: null,
      depth: 0,
      cursor: 'c' as never,
      createdAt: '2026-09-28T00:00:00.000Z',
    },
    remoteSeq: 1,
    author: { memberId: 'a', displayName: 'A', kind: 'human' },
  };
}

function script(...pages: Array<RemoteRedactionPage | Error>) {
  const asked: Array<{ cursor?: string; from?: string }> = [];
  const readRedactions = vi.fn(async (_roomId: string, opts: { cursor?: string; from?: 'end' }) => {
    asked.push({ cursor: opts.cursor, from: opts.from });
    const next = pages.shift();
    if (!next) return { items: [], nextCursor: 'idle', hasMore: false };
    if (next instanceof Error) throw next;
    return next;
  });
  return { reader: { readRedactions }, asked };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 2));
};

describe('followNativeRedactions', () => {
  // Purpose: it starts at the feed's end, polls from the cursor it was given, hands on only this
  // room's items, and never before `start` (so never before the snapshot).
  it('starts at the end, follows the cursor, and hands on only this room’s items', async () => {
    const { reader, asked } = script(
      { items: [], nextCursor: 'end', hasMore: false },
      { items: [item('x'), item('y', 'room-b')], nextCursor: 'p1', hasMore: true },
      { items: [item('z')], nextCursor: 'p2', hasMore: false }
    );
    const seen: string[] = [];
    const controller = new AbortController();
    const follower = followNativeRedactions(reader, 'room-a', {
      signal: controller.signal,
      intervalMs: 1,
      onChanged: (items) => seen.push(...items.map((i) => i.entry.id)),
    });
    await follower.ready;
    await new Promise((r) => setTimeout(r, 10));
    expect(asked).toEqual([{ from: 'end', cursor: undefined }]);
    follower.start();
    await until(() => seen.length === 2);
    controller.abort();
    expect(seen).toEqual(['x', 'z']);
    expect(asked.slice(1, 3)).toEqual([
      { cursor: 'end', from: undefined },
      { cursor: 'p1', from: undefined },
    ]);
  });

  // Purpose: a restored server's stale cursor reads the feed again from its start, once.
  it('reads from the start after a stale cursor', async () => {
    const { reader, asked } = script(
      { items: [], nextCursor: 'end', hasMore: false },
      new StaleCommunityCursorError(REF, 'room-a', 'restored'),
      { items: [item('x')], nextCursor: 'fresh', hasMore: false }
    );
    const seen: string[] = [];
    const controller = new AbortController();
    const follower = followNativeRedactions(reader, 'room-a', {
      signal: controller.signal,
      intervalMs: 1,
      onChanged: (items) => seen.push(...items.map((i) => i.entry.id)),
    });
    follower.start();
    await until(() => seen.length === 1);
    controller.abort();
    expect(asked.slice(1, 3)).toEqual([
      { cursor: 'end', from: undefined },
      { cursor: undefined, from: undefined },
    ]);
  });

  // Purpose: a server without the feed, or a channel no longer readable, stops the polling.
  it.each([
    ['a server without the feed', new RemoteRedactionFeedUnsupportedError(REF)],
    ['an unreadable channel', new CommunityRoomNotFoundError(REF, 'room-a')],
  ])('stops asking after %s', async (_label, error) => {
    const { reader } = script(error);
    const controller = new AbortController();
    const follower = followNativeRedactions(reader, 'room-a', {
      signal: controller.signal,
      intervalMs: 1,
      onChanged: () => undefined,
    });
    follower.start();
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    expect(reader.readRedactions).toHaveBeenCalledOnce();
  });

  // Purpose: an end read that lands after the stream stopped waiting for it is ignored, so the
  // first poll reads from the start rather than skipping what changed in between.
  it('ignores an end read that lands after the wait ran out', async () => {
    vi.useFakeTimers();
    try {
      let answerEnd!: (page: RemoteRedactionPage) => void;
      const asked: Array<{ cursor?: string; from?: string }> = [];
      const readRedactions = vi.fn(
        (
          _roomId: string,
          opts: { cursor?: string; from?: 'end' }
        ): Promise<RemoteRedactionPage> => {
          asked.push({ cursor: opts.cursor, from: opts.from });
          if (opts.from === 'end') return new Promise((resolve) => (answerEnd = resolve));
          return Promise.resolve({ items: [], nextCursor: 'after', hasMore: false });
        }
      );
      const controller = new AbortController();
      const follower = followNativeRedactions({ readRedactions }, 'room-a', {
        signal: controller.signal,
        intervalMs: 10,
        onChanged: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await follower.ready;
      expect(follower.position()).toBeUndefined();
      answerEnd({ items: [], nextCursor: 'late-end', hasMore: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(follower.position()).toBeUndefined();
      follower.start();
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      expect(asked[1]).toEqual({ cursor: undefined, from: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  // Purpose: repeated transient failures wait longer each time and warn once, not every poll.
  it('backs off after repeated failures and warns once', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const readRedactions = vi.fn(async (_roomId: string, opts: { from?: 'end' }) => {
        if (opts.from === 'end') return { items: [], nextCursor: 'end', hasMore: false };
        throw new Error('temporary outage');
      });
      const controller = new AbortController();
      const follower = followNativeRedactions({ readRedactions }, 'room-a', {
        signal: controller.signal,
        intervalMs: 100,
        onChanged: () => undefined,
      });
      await follower.ready;
      follower.start();
      // Polls at 100, then +200, +400, +800: four failures within 1500ms, not fifteen.
      await vi.advanceTimersByTimeAsync(1_500);
      controller.abort();
      expect(readRedactions.mock.calls.length - 1).toBe(4);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
