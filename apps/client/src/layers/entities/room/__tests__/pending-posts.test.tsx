// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomEntry, RoomEvent } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { usePendingPostStore, usePendingPosts } from '../model/pending-posts';
import { useRoomDraftStore } from '../model/room-drafts';
import { usePostToRoom } from '../model/use-post-to-room';
import { useReplyInThread } from '../model/use-reply-in-thread';
import { useRoomStream } from '../model/use-room-stream';

const ROOM = 'room-1';

function entry(seq: number, id: string): RoomEntry {
  return {
    roomId: ROOM,
    seq,
    id,
    authorId: 'author-you',
    kind: 'post',
    body: { text: 'ok' },
    mentions: [],
    sessionId: null,
    cascadeRoot: id,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-30T10:00:00.000Z',
  };
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

beforeEach(() => {
  usePendingPostStore.setState({ posts: [] });
  useRoomDraftStore.setState({ drafts: {} });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a message in flight', () => {
  it('is on screen from the keystroke, not from the echo', async () => {
    // The hole this fills: a post is trigger-only, so between Enter and the
    // entry arriving on the stream there was nothing on screen at all. On a slow
    // link the sentence simply disappeared for the round trip.
    const transport = createMockTransport();
    let release!: (value: { accepted: true; entryId: string; seq: number }) => void;
    transport.postToRoom = vi
      .fn()
      .mockReturnValue(new Promise<never>((resolve) => (release = resolve as never)));

    const { result } = renderHook(
      () => ({ post: usePostToRoom(), pending: usePendingPosts(ROOM, null) }),
      { wrapper: wrapperFor(transport, makeQueryClient()) }
    );

    act(() =>
      result.current.post.mutate({ roomId: ROOM, text: 'is the build ok?', clientId: 'c1' })
    );

    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    expect(result.current.pending[0]).toMatchObject({
      text: 'is the build ok?',
      status: 'sending',
      threadRootId: null,
    });

    release({ accepted: true, entryId: 'entry-a', seq: 9 });
    // Still there after the 202: the server saying it HAS the message is not the
    // room showing it, and everybody else is looking at the echo.
    await waitFor(() => expect(result.current.pending[0]?.entryId).toBe('entry-a'));
    expect(result.current.pending).toHaveLength(1);
  });

  it('is retired by its own echo, and not by somebody else’s', async () => {
    const transport = createMockTransport();
    transport.listRoomEntries = vi.fn().mockResolvedValue([]);
    transport.postToRoom = vi
      .fn()
      .mockResolvedValue({ accepted: true, entryId: 'entry-mine', seq: 9 });

    let emit!: (event: RoomEvent) => void;
    transport.subscribeRoom = vi.fn().mockImplementation(() =>
      (async function* (): AsyncIterable<RoomEvent> {
        const queue: RoomEvent[] = [];
        let wake: (() => void) | null = null;
        emit = (event) => {
          queue.push(event);
          wake?.();
        };
        for (;;) {
          while (queue.length > 0) yield queue.shift()!;
          await new Promise<void>((resolve) => (wake = resolve));
        }
      })()
    );

    const queryClient = makeQueryClient();
    const { result } = renderHook(
      () => ({
        post: usePostToRoom(),
        pending: usePendingPosts(ROOM, null),
        stream: useRoomStream(ROOM, true),
      }),
      { wrapper: wrapperFor(transport, queryClient) }
    );

    act(() => result.current.post.mutate({ roomId: ROOM, text: 'ok', clientId: 'c1' }));
    await waitFor(() => expect(result.current.pending[0]?.entryId).toBe('entry-mine'));

    // Somebody else says something first. Keyed on the id rather than the text,
    // so this cannot retire a row it is not the echo of.
    await act(async () => emit({ type: 'entry', seq: 8, entry: entry(8, 'entry-theirs') }));
    expect(result.current.pending).toHaveLength(1);

    await act(async () => emit({ type: 'entry', seq: 9, entry: entry(9, 'entry-mine') }));
    await waitFor(() => expect(result.current.pending).toHaveLength(0));
  });

  it('is retired even when the echo beats the response home', async () => {
    // A real race, not a rare one: the entry is fanned out before the response
    // reaches the browser. The echo's `settle` finds a row with no id yet and
    // matches nothing, so without the check on the way back the row would sit
    // under its own message forever.
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    queryClient.setQueryData<RoomEntry[]>(roomKeys.entries(ROOM), [entry(9, 'entry-mine')]);
    transport.postToRoom = vi
      .fn()
      .mockResolvedValue({ accepted: true, entryId: 'entry-mine', seq: 9 });

    const { result } = renderHook(
      () => ({ post: usePostToRoom(), pending: usePendingPosts(ROOM, null) }),
      { wrapper: wrapperFor(transport, queryClient) }
    );

    act(() => result.current.post.mutate({ roomId: ROOM, text: 'ok', clientId: 'c1' }));

    await waitFor(() => expect(result.current.pending).toHaveLength(0));
  });

  it('goes to a failed row rather than back into the composer', async () => {
    // The reversal: restoring merged a refused sentence into whatever had been
    // typed since, and could not say WHICH message failed once two were in
    // flight. The row says both, where the message already was.
    const transport = createMockTransport();
    transport.postToRoom = vi.fn().mockRejectedValue(new Error('This room is archived'));

    const { result } = renderHook(
      () => ({ post: usePostToRoom(), pending: usePendingPosts(ROOM, null) }),
      { wrapper: wrapperFor(transport, makeQueryClient()) }
    );

    act(() =>
      result.current.post.mutate({ roomId: ROOM, text: 'is the build ok?', clientId: 'c1' })
    );

    await waitFor(() => expect(result.current.pending[0]?.status).toBe('failed'));
    expect(result.current.pending[0]?.text).toBe('is the build ok?');
    expect(useRoomDraftStore.getState().drafts[ROOM] ?? '').toBe('');
  });

  it('moves the row already on screen when it is tried again', async () => {
    const transport = createMockTransport();
    transport.postToRoom = vi
      .fn()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValue({ accepted: true, entryId: 'entry-a', seq: 9 });

    const { result } = renderHook(
      () => ({ post: usePostToRoom(), pending: usePendingPosts(ROOM, null) }),
      { wrapper: wrapperFor(transport, makeQueryClient()) }
    );

    act(() => result.current.post.mutate({ roomId: ROOM, text: 'ok', clientId: 'c1' }));
    await waitFor(() => expect(result.current.pending[0]?.status).toBe('failed'));

    act(() => result.current.post.mutate({ roomId: ROOM, text: 'ok', clientId: 'c1' }));

    // One row, back in flight — not a second copy of the same sentence under
    // the first.
    await waitFor(() => expect(result.current.pending[0]?.entryId).toBe('entry-a'));
    expect(result.current.pending).toHaveLength(1);
  });

  it('waits in the thread it was typed in, not at the bottom of the room', async () => {
    const transport = createMockTransport();
    transport.replyInThread = vi.fn().mockReturnValue(new Promise(() => {}) as Promise<never>);

    const { result } = renderHook(
      () => ({
        reply: useReplyInThread(),
        inRoom: usePendingPosts(ROOM, null),
        inThread: usePendingPosts(ROOM, 'root-1'),
      }),
      { wrapper: wrapperFor(transport, makeQueryClient()) }
    );

    act(() =>
      result.current.reply.mutate({
        roomId: ROOM,
        rootEntryId: 'root-1',
        text: 'in the thread',
        clientId: 'c1',
      })
    );

    await waitFor(() => expect(result.current.inThread).toHaveLength(1));
    // The room's composer has its own tail, and a thread reply is not on it.
    expect(result.current.inRoom).toHaveLength(0);
  });
});
