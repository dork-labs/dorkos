// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { mergeRoomReactions } from '../lib/reactions';
import { useToggleReaction } from '../model/use-toggle-reaction';

const ME = 'author-me';

function entry(reactions?: RoomEntry['reactions']): RoomEntry {
  return {
    roomId: 'room-1',
    seq: 1,
    id: 'entry-1',
    authorId: 'author-them',
    kind: 'post',
    body: { text: 'the deploy is stuck' },
    mentions: [],
    sessionId: null,
    cascadeRoot: 'entry-1',
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-30T09:00:00.000Z',
    reactions,
  };
}

function room(frequents: string[]): RoomWithRoster {
  return {
    id: 'room-1',
    kind: 'channel',
    slug: 'general',
    title: 'general',
    topic: null,
    archived: false,
    createdAt: '2026-07-30T09:00:00.000Z',
    updatedAt: '2026-07-30T09:00:00.000Z',
    members: [],
    viewerAuthorId: ME,
    reactionFrequents: frequents,
  } as unknown as RoomWithRoster;
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}

function wrapperFor(transport: Transport, queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** The reactions the cache holds for the seeded entry. */
function cached(queryClient: QueryClient): RoomEntry['reactions'] {
  return queryClient.getQueryData<RoomEntry[]>(roomKeys.entries('room-1'))?.[0]!.reactions;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useToggleReaction', () => {
  it('draws the pill before the server has answered, and names the state it is asking for', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    queryClient.setQueryData<RoomEntry[]>(roomKeys.entries('room-1'), [entry()]);
    // A request that never settles, so what is asserted is what the reader sees
    // WHILE it is in flight — the whole point of an optimistic pill.
    transport.toggleReaction = vi.fn().mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useToggleReaction(), {
      wrapper: wrapperFor(transport, queryClient),
    });

    act(() => {
      result.current.mutate({
        roomId: 'room-1',
        entryId: 'entry-1',
        emoji: '👍',
        viewerAuthorId: ME,
      });
    });

    await waitFor(() => expect(cached(queryClient)).toHaveLength(1));
    expect(cached(queryClient)![0]).toMatchObject({ emoji: '👍', authorIds: [ME] });

    // `on` is sent, never a bare flip. A flip is the one thing a retry cannot
    // survive — sent twice it undoes itself — and naming the state makes the
    // call safe to repeat (the route's own guidance).
    expect(transport.toggleReaction).toHaveBeenCalledWith('room-1', 'entry-1', {
      emoji: '👍',
      on: true,
    });
  });

  it('asks for `on: false` when the press is taking your own pill back', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    queryClient.setQueryData<RoomEntry[]>(roomKeys.entries('room-1'), [
      entry([{ emoji: '👍', authorIds: [ME], firstAt: '2026-07-30T09:00:00.000Z' }]),
    ]);
    transport.toggleReaction = vi.fn().mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useToggleReaction(), {
      wrapper: wrapperFor(transport, queryClient),
    });

    act(() => {
      result.current.mutate({
        roomId: 'room-1',
        entryId: 'entry-1',
        emoji: '👍',
        viewerAuthorId: ME,
      });
    });

    await waitFor(() => expect(cached(queryClient)).toEqual([]));
    expect(transport.toggleReaction).toHaveBeenCalledWith('room-1', 'entry-1', {
      emoji: '👍',
      on: false,
    });
  });

  it('puts the row back exactly as it was when the write is refused', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    const held = [{ emoji: '🎉', authorIds: ['author-them'], firstAt: '2026-07-30T09:00:00.000Z' }];
    queryClient.setQueryData<RoomEntry[]>(roomKeys.entries('room-1'), [entry(held)]);
    transport.toggleReaction = vi.fn().mockRejectedValue(new Error('This room is archived'));

    const { result } = renderHook(() => useToggleReaction(), {
      wrapper: wrapperFor(transport, queryClient),
    });

    act(() => {
      result.current.mutate({
        roomId: 'room-1',
        entryId: 'entry-1',
        emoji: '👍',
        viewerAuthorId: ME,
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // Not "an empty row" — the row somebody ELSE's pill was already on. A revert
    // that cleared the entry would take their 🎉 with it.
    expect(cached(queryClient)).toEqual(held);
  });

  it('does not take somebody else’s pill down when the write is refused', async () => {
    // The concurrency probe, and the reason a revert may not replay the set it
    // photographed at click time. Sequence:
    //
    //   1. the reader reacts — the pill is drawn optimistically;
    //   2. somebody ELSE reacts, and their frame arrives on the stream carrying
    //      the entry's whole set as the SERVER holds it, which does not include
    //      the write still in flight;
    //   3. the reader's write is refused.
    //
    // A revert that wrote back the click-time snapshot would erase step 2 — and
    // nothing would put it back, because nothing changed server-side, so no
    // further frame is coming. The row would stay wrong until a refetch.
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    queryClient.setQueryData<RoomEntry[]>(roomKeys.entries('room-1'), [entry()]);

    let refuse: (error: Error) => void = () => {};
    transport.toggleReaction = vi
      .fn()
      .mockReturnValue(new Promise((_resolve, reject) => (refuse = reject)));

    const { result } = renderHook(() => useToggleReaction(), {
      wrapper: wrapperFor(transport, queryClient),
    });

    act(() => {
      result.current.mutate({
        roomId: 'room-1',
        entryId: 'entry-1',
        emoji: '👍',
        viewerAuthorId: ME,
      });
    });
    await waitFor(() => expect(cached(queryClient)).toHaveLength(1));

    // Their reaction lands while ours is in flight. This is exactly what
    // `useRoomStream` does with a `reaction` frame: replace the set outright.
    const theirs = [
      { emoji: '🎉', authorIds: ['author-them'], firstAt: '2026-07-30T09:01:00.000Z' },
    ];
    act(() => {
      queryClient.setQueryData<RoomEntry[]>(roomKeys.entries('room-1'), (held) =>
        mergeRoomReactions(held, 'entry-1', theirs)
      );
    });

    act(() => refuse(new Error('This room is archived')));
    await waitFor(() => expect(result.current.isError).toBe(true));

    // Their 🎉 is still there. Only the reader's own membership was undone —
    // and it was already gone, so the revert is a no-op rather than a wipe.
    expect(cached(queryClient)).toEqual(theirs);
  });

  it('leaves the rest of a shared pill alone when it takes your own name off it', async () => {
    // The same rule at pill level: reverting your join must remove YOU, not the
    // pill. A snapshot replay happens to get this right; undoing your own
    // membership gets it right for the right reason.
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    const theirs = { emoji: '👍', authorIds: ['author-them'], firstAt: '2026-07-30T09:00:00.000Z' };
    queryClient.setQueryData<RoomEntry[]>(roomKeys.entries('room-1'), [entry([theirs])]);
    transport.toggleReaction = vi.fn().mockRejectedValue(new Error('nope'));

    const { result } = renderHook(() => useToggleReaction(), {
      wrapper: wrapperFor(transport, queryClient),
    });

    act(() => {
      result.current.mutate({
        roomId: 'room-1',
        entryId: 'entry-1',
        emoji: '👍',
        viewerAuthorId: ME,
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(cached(queryClient)).toEqual([theirs]);
  });

  it('puts your pill back when the refused write was a removal', async () => {
    // The revert runs in both directions: undoing an `on: false` means putting
    // the reader back onto the pill, against whatever the row holds now.
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    queryClient.setQueryData<RoomEntry[]>(roomKeys.entries('room-1'), [
      entry([{ emoji: '👍', authorIds: [ME], firstAt: '2026-07-30T09:00:00.000Z' }]),
    ]);
    transport.toggleReaction = vi.fn().mockRejectedValue(new Error('nope'));

    const { result } = renderHook(() => useToggleReaction(), {
      wrapper: wrapperFor(transport, queryClient),
    });

    act(() => {
      result.current.mutate({
        roomId: 'room-1',
        entryId: 'entry-1',
        emoji: '👍',
        viewerAuthorId: ME,
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(cached(queryClient)![0]).toMatchObject({ emoji: '👍', authorIds: [ME] });
  });

  it('refreshes the quick row from the answer, without a second request', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    queryClient.setQueryData<RoomEntry[]>(roomKeys.entries('room-1'), [entry()]);
    queryClient.setQueryData<RoomWithRoster>(roomKeys.detail('room-1'), room(['👍', '❤️', '🎉']));
    transport.toggleReaction = vi.fn().mockResolvedValue({
      accepted: true,
      entryId: 'entry-1',
      emoji: '👀',
      reacted: true,
      frequents: ['👀', '👍', '❤️'],
    });

    const { result } = renderHook(() => useToggleReaction(), {
      wrapper: wrapperFor(transport, queryClient),
    });

    act(() => {
      result.current.mutate({
        roomId: 'room-1',
        entryId: 'entry-1',
        emoji: '👀',
        viewerAuthorId: ME,
      });
    });

    await waitFor(() =>
      expect(
        queryClient.getQueryData<RoomWithRoster>(roomKeys.detail('room-1'))?.reactionFrequents
      ).toEqual(['👀', '👍', '❤️'])
    );
  });
});
