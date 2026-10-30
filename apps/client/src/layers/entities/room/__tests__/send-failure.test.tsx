// @vitest-environment jsdom
/**
 * A failed room send keeps its words and can be tried again from the toast
 * (DOR-3481). Runs the REAL mutation error policy, so the Retry asserted here
 * is the button a person actually gets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { usePendingPostStore, usePendingPosts } from '../model/pending-posts';
import { threadDraftKey, useRoomDraftStore } from '../model/room-drafts';
import {
  discardPendingPost,
  failPendingPost,
  retireFailedTwin,
  retryPendingPost,
  sendFailureOf,
} from '../model/send/send-failure';
import { usePostToRoom } from '../model/use-post-to-room';
import { useReplyInThread } from '../model/use-reply-in-thread';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

const ROOM = 'room-1';
const VIEWER = 'author-you';

function makeQueryClient(): QueryClient {
  const config = createQueryClientConfig();
  return new QueryClient({
    ...config,
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

/** What the transport throws when no response came back: the server is down. */
function unreachable(): TypeError {
  return Object.assign(new TypeError('Failed to fetch'), { noResponse: true });
}

/** The action on the last failure toast. */
function lastToastAction(): { label: string; onClick: () => void } {
  const calls = vi.mocked(toast.error).mock.calls;
  const options = calls[calls.length - 1]?.[1] as {
    action: { label: string; onClick: () => void };
  };
  return options.action;
}

beforeEach(() => {
  usePendingPostStore.setState({ posts: [] });
  useRoomDraftStore.setState({ drafts: {} });
  vi.mocked(toast.error).mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendFailureOf', () => {
  it('calls a send not sent only when no response came back', () => {
    expect(sendFailureOf(unreachable())).toBe('not-sent');
    // A TypeError the transport did not mark broke AFTER a response: the body
    // of a 202, say. The server answered, so the post may well have landed.
    expect(sendFailureOf(new TypeError('network error'))).toBe('unknown');
    expect(sendFailureOf(Object.assign(new Error('Bad Gateway'), { status: 502 }))).toBe('unknown');
    // A timeout may have landed after the server committed it.
    expect(sendFailureOf(new Error('Request timed out after 30s. Check your network'))).toBe(
      'unknown'
    );
    expect(sendFailureOf(Object.assign(new Error('Archived'), { status: 409 }))).toBe('unknown');
  });
});

describe('failPendingPost', () => {
  it('leaves an attempt that may have landed in its row alone, out of the box', () => {
    // Sending from the box skips the retry's "did it land?" check, so only a
    // send known never to have arrived goes back there.
    usePendingPostStore.getState().start({
      clientId: 'c1',
      roomId: ROOM,
      threadRootId: null,
      text: 'maybe landed',
    });

    failPendingPost(
      { clientId: 'c1', roomId: ROOM, threadRootId: null, text: 'maybe landed' },
      new Error('Request timed out after 30s. Check your network')
    );

    expect(usePendingPostStore.getState().posts[0]).toMatchObject({
      status: 'failed',
      failure: 'unknown',
    });
    expect(useRoomDraftStore.getState().drafts[ROOM] ?? '').toBe('');
  });
});

describe('discardPendingPost', () => {
  it('takes the words out of the box too, when they are still untouched there', () => {
    usePendingPostStore
      .getState()
      .start({ clientId: 'c1', roomId: ROOM, threadRootId: null, text: 'gone' });
    useRoomDraftStore.getState().set(ROOM, 'gone');

    discardPendingPost('c1');

    expect(usePendingPostStore.getState().posts).toHaveLength(0);
    expect(useRoomDraftStore.getState().drafts[ROOM]).toBe('');
  });

  it('leaves a box the person has edited since', () => {
    usePendingPostStore
      .getState()
      .start({ clientId: 'c1', roomId: ROOM, threadRootId: null, text: 'gone' });
    useRoomDraftStore.getState().set(ROOM, 'gone, but reworded');

    discardPendingPost('c1');

    expect(useRoomDraftStore.getState().drafts[ROOM]).toBe('gone, but reworded');
  });
});

describe('the failure toast', () => {
  it('offers Retry, which sends the same message again even after the composer is gone', async () => {
    const transport = createMockTransport();
    transport.postToRoom = vi
      .fn()
      .mockRejectedValueOnce(unreachable())
      .mockResolvedValue({ accepted: true, entryId: 'entry-a', seq: 9 });
    const queryClient = makeQueryClient();

    const { result, unmount } = renderHook(() => usePostToRoom(), {
      wrapper: wrapperFor(transport, queryClient),
    });
    act(() => result.current.mutate({ roomId: ROOM, text: 'still there?', clientId: 'c1' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const action = lastToastAction();
    expect(action.label).toBe('Retry');
    // The words are back in the box, and the row says what is known.
    expect(useRoomDraftStore.getState().drafts[ROOM]).toBe('still there?');
    expect(usePendingPostStore.getState().posts[0]).toMatchObject({
      status: 'failed',
      failure: 'not-sent',
    });

    // The person left the room before pressing it.
    unmount();
    act(() => action.onClick());

    await waitFor(() => expect(usePendingPostStore.getState().posts[0]?.entryId).toBe('entry-a'));
    expect(transport.postToRoom).toHaveBeenCalledTimes(2);
    expect(transport.postToRoom).toHaveBeenLastCalledWith(ROOM, { text: 'still there?' });
    // Taken back out of the box, so it is not also waiting to be sent by hand.
    expect(useRoomDraftStore.getState().drafts[ROOM]).toBe('');
    expect(usePendingPostStore.getState().posts).toHaveLength(1);
  });

  it('offers Retry for a thread reply, into the same thread', async () => {
    const transport = createMockTransport();
    transport.replyInThread = vi
      .fn()
      .mockRejectedValueOnce(unreachable())
      .mockResolvedValue({ accepted: true, entryId: 'entry-r', seq: 10 });
    const queryClient = makeQueryClient();

    const { result } = renderHook(() => useReplyInThread(), {
      wrapper: wrapperFor(transport, queryClient),
    });
    act(() =>
      result.current.mutate({ roomId: ROOM, rootEntryId: 'root-1', text: 'reply', clientId: 'r1' })
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(useRoomDraftStore.getState().drafts[threadDraftKey(ROOM, 'root-1')]).toBe('reply');
    act(() => lastToastAction().onClick());

    await waitFor(() =>
      expect(transport.replyInThread).toHaveBeenLastCalledWith(ROOM, {
        rootEntryId: 'root-1',
        text: 'reply',
      })
    );
  });

  it('does nothing once the row was already retried or thrown away', async () => {
    const transport = createMockTransport();
    transport.postToRoom = vi.fn().mockRejectedValue(unreachable());
    const queryClient = makeQueryClient();

    const { result } = renderHook(
      () => ({ post: usePostToRoom(), pending: usePendingPosts(ROOM, null) }),
      { wrapper: wrapperFor(transport, queryClient) }
    );
    act(() => result.current.post.mutate({ roomId: ROOM, text: 'x', clientId: 'c1' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());

    act(() => usePendingPostStore.getState().discard('c1'));
    act(() => lastToastAction().onClick());

    expect(transport.postToRoom).toHaveBeenCalledTimes(1);
  });
});

describe('retryPendingPost', () => {
  it('retires the row instead of posting twice when the words already landed', () => {
    const queryClient = makeQueryClient();
    usePendingPostStore.getState().start({
      clientId: 'c1',
      roomId: ROOM,
      threadRootId: null,
      text: 'ok',
      now: Date.parse('2026-10-30T10:00:00.000Z'),
    });
    usePendingPostStore.getState().failed('c1');
    queryClient.setQueryData<RoomEntry[]>(roomKeys.entries(ROOM), [
      {
        roomId: ROOM,
        seq: 1,
        id: 'entry-1',
        authorId: VIEWER,
        kind: 'post',
        body: { text: 'ok' },
        mentions: [],
        sessionId: null,
        cascadeRoot: 'entry-1',
        cascadeDepth: 0,
        parentEntryId: null,
        threadRootEntryId: null,
        signature: null,
        createdAt: '2026-10-30T10:00:01.000Z',
      },
    ]);
    const resend = vi.fn();

    retryPendingPost(queryClient, 'c1', resend, VIEWER);

    expect(resend).not.toHaveBeenCalled();
    expect(usePendingPostStore.getState().posts).toHaveLength(0);
  });
});

describe('retireFailedTwin', () => {
  it('retires only the newest of two identical failed rows', () => {
    // Two failed "ok" rows are two messages; one send replaces one of them.
    const store = usePendingPostStore.getState();
    store.start({ clientId: 'c1', roomId: ROOM, threadRootId: null, text: 'ok' });
    store.failed('c1', 'not-sent');
    store.start({ clientId: 'c2', roomId: ROOM, threadRootId: null, text: 'ok' });
    store.failed('c2', 'not-sent');

    retireFailedTwin({ roomId: ROOM, threadRootId: null }, 'ok');

    expect(usePendingPostStore.getState().posts.map((post) => post.clientId)).toEqual(['c1']);
  });

  it('retires the failed row whose words are being sent again from the box', () => {
    const store = usePendingPostStore.getState();
    store.start({ clientId: 'c1', roomId: ROOM, threadRootId: null, text: 'same' });
    store.failed('c1', 'not-sent');
    store.start({ clientId: 'c2', roomId: ROOM, threadRootId: null, text: 'other' });
    store.failed('c2', 'not-sent');
    store.start({ clientId: 'c3', roomId: ROOM, threadRootId: 'root-1', text: 'same' });
    store.failed('c3', 'not-sent');

    retireFailedTwin({ roomId: ROOM, threadRootId: null }, 'same');

    expect(usePendingPostStore.getState().posts.map((post) => post.clientId)).toEqual(['c2', 'c3']);
  });
});
