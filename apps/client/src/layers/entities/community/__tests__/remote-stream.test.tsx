import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import {
  RemoteCommunityEntrySchema,
  RemoteCommunityRoomSchema,
  type RemoteCommunityEvent,
} from '@dorkos/shared/community-views';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { communityKeys } from '../model/use-community-connections';
import {
  mergeRemoteCommunityEntries,
  useRemoteCommunityStream,
} from '../model/use-remote-community-stream';

const access = {
  state: 'verified',
  effective: { read: true, post: true, enrollAgent: true, stream: true },
  lastKnown: {
    lifecycle: 'active',
    capabilities: { read: true, post: true, enrollAgent: true, stream: true },
    verifiedAt: '2026-09-16T10:00:00Z',
  },
} as const;

const room = (community = 'a') =>
  RemoteCommunityRoomSchema.parse({
    community,
    roomId: 'same',
    remoteCommunityId: `deployment-${community}`,
    kind: 'channel',
    title: 'General',
    slug: 'general',
    topic: null,
    archived: false,
    createdAt: '2026-09-16T10:00:00Z',
    lastActivityAt: '2026-09-16T10:00:00Z',
    unreadCount: 0,
    visibility: 'public',
    readable: true,
    writable: true,
    joined: true,
    stale: false,
    cacheCursor: 'opaque',
    lastRemoteSeq: 2,
    access,
  });
const entry = (community = 'a', remoteSeq = 1) =>
  RemoteCommunityEntrySchema.parse({
    community,
    roomId: 'same',
    id: `entry-${remoteSeq}`,
    authorId: 'member',
    text: `${community} only`,
    mentions: [],
    parentEntryId: null,
    threadRootEntryId: null,
    depth: 0,
    cursor: `opaque-${remoteSeq}`,
    createdAt: '2026-09-16T10:00:00Z',
    attachments: [],
    authorDisplayName: 'Alex',
    authorKind: 'human',
    remoteSeq,
  });
const snapshot = (community = 'a'): RemoteCommunityEvent => ({
  type: 'snapshot',
  room: room(community),
  entries: [entry(community)],
  cursor: entry(community).cursor,
  lastRemoteSeq: 2,
  stale: false,
});

function setup() {
  const streams: Array<{
    ref: string;
    emit: (event: RemoteCommunityEvent) => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
  }> = [];
  const subscribe = vi.fn<Transport['subscribeRemoteCommunityRoom']>(
    (ref, _room, emit, options) =>
      new Promise<void>((resolve, reject) => {
        streams.push({ ref, emit, reject, signal: options?.signal });
        options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      })
  );
  const transport = createMockTransport({ subscribeRemoteCommunityRoom: subscribe });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { streams, subscribe, client, wrapper };
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('remote room stream lifecycle', () => {
  it('isolates identical IDs during a route change and ignores late events from the old stream', async () => {
    const { streams, wrapper } = setup();
    const hook = renderHook(({ ref }) => useRemoteCommunityStream(ref, 'same'), {
      wrapper,
      initialProps: { ref: 'a' },
    });
    act(() => streams[0].emit(snapshot()));
    expect(hook.result.current.entries[0]?.text).toBe('a only');
    hook.rerender({ ref: 'b' });
    expect(hook.result.current.entries).toEqual([]);
    expect(streams[0].signal?.aborted).toBe(true);
    act(() => {
      streams[0].emit(snapshot());
      streams[1].emit(snapshot('b'));
    });
    expect(hook.result.current.entries.map((item) => item.text)).toEqual(['b only']);
    hook.unmount();
    expect(streams[1].signal?.aborted).toBe(true);
  });

  it('erases revoked community caches while keeping another community intact', () => {
    const { streams, wrapper, client } = setup();
    client.setQueryData(communityKeys.entries('a', 'same'), { private: true });
    client.setQueryData(communityKeys.entries('b', 'same'), { keep: true });
    const hook = renderHook(() => useRemoteCommunityStream('a', 'same'), { wrapper });
    act(() => streams[0].emit(snapshot()));
    act(() =>
      streams[0].emit({
        type: 'closed',
        community: room().community,
        roomId: 'same',
        reason: 'revoked',
      })
    );
    expect(hook.result.current.status).toBe('removed');
    expect(hook.result.current.entries).toEqual([]);
    expect(client.getQueryData(communityKeys.entries('a', 'same'))).toBeUndefined();
    expect(client.getQueryData(communityKeys.entries('b', 'same'))).toEqual({ keep: true });
  });

  it('keeps last authorized history explicitly stale and unwritable during an outage', async () => {
    const { streams, wrapper, client } = setup();
    const hook = renderHook(() => useRemoteCommunityStream('a', 'same'), { wrapper });
    act(() => streams[0].emit(snapshot()));
    act(() => streams[0].reject(Object.assign(new Error('Unavailable'), { status: 503 })));
    await waitFor(() => expect(hook.result.current.status).toBe('offline'));
    expect(hook.result.current.entries).toHaveLength(1);
    expect(hook.result.current.room).toMatchObject({ writable: false, stale: true });
    expect(client.getQueryData(communityKeys.room('a', 'same'))).toMatchObject({
      writable: false,
      stale: true,
    });
  });

  it('replaces private agent deliveries and removes them only on a matching remote confirmation', () => {
    const { streams, wrapper } = setup();
    const hook = renderHook(() => useRemoteCommunityStream('a', 'same'), { wrapper });
    const delivery = {
      idempotencyKey: 'own-output',
      author: { kind: 'agent' as const, displayName: 'Helper' },
      text: 'Pending agent reply',
      parentEntryId: null,
      attachments: [],
      state: 'pending' as const,
      failure: null,
      retryable: false,
    };
    const pending: RemoteCommunityEvent = {
      type: 'deliveries',
      community: room().community,
      roomId: 'same',
      deliveries: [delivery],
    };
    act(() => {
      streams[0].emit(snapshot());
      streams[0].emit(pending);
    });
    expect(hook.result.current.deliveries).toEqual([delivery]);
    act(() => streams[0].emit({ type: 'entry', entry: { ...entry('a', 2), text: delivery.text } }));
    expect(hook.result.current.deliveries).toHaveLength(1);
    act(() =>
      streams[0].emit({
        type: 'entry',
        entry: { ...entry('a', 3), originIdempotencyKey: delivery.idempotencyKey },
      })
    );
    expect(hook.result.current.deliveries).toEqual([]);
    act(() => streams[0].emit(pending));
    expect(hook.result.current.deliveries).toEqual([]);
    act(() =>
      streams[0].emit({
        ...pending,
        deliveries: [
          {
            idempotencyKey: 'another',
            author: delivery.author,
            text: delivery.text,
            parentEntryId: delivery.parentEntryId,
            attachments: delivery.attachments,
            state: 'failed',
            failure: 'expired',
          },
        ],
      })
    );
    expect(hook.result.current.deliveries[0]?.state).toBe('failed');
    act(() => streams[0].emit({ ...pending, deliveries: [] }));
    expect(hook.result.current.deliveries).toEqual([]);
  });

  it('clears private deliveries on revocation and refuses a late event from that subscription', () => {
    const { streams, wrapper } = setup();
    const hook = renderHook(() => useRemoteCommunityStream('a', 'same'), { wrapper });
    const pending: RemoteCommunityEvent = {
      type: 'deliveries',
      community: room().community,
      roomId: 'same',
      deliveries: [
        {
          idempotencyKey: 'secret',
          author: { kind: 'agent', displayName: 'Helper' },
          text: 'private',
          parentEntryId: null,
          attachments: [],
          state: 'pending',
          failure: null,
          retryable: false,
        },
      ],
    };
    act(() => {
      streams[0].emit(snapshot());
      streams[0].emit(pending);
    });
    expect(hook.result.current.deliveries).toHaveLength(1);
    act(() =>
      streams[0].emit({
        type: 'closed',
        community: room().community,
        roomId: 'same',
        reason: 'revoked',
      })
    );
    act(() => streams[0].emit(pending));
    expect(hook.result.current.deliveries).toEqual([]);
    expect(hook.result.current.status).toBe('removed');
  });

  it('merges receipt and echo once in native order, independent of timestamps', () => {
    const first = entry('a', 1);
    const second = { ...entry('a', 2), createdAt: '2020-01-01T00:00:00Z' };
    expect(
      mergeRemoteCommunityEntries('a', 'same', [second], [first, second]).map((item) => item.id)
    ).toEqual(['entry-1', 'entry-2']);
    expect(() => mergeRemoteCommunityEntries('a', 'same', [entry('b')])).toThrow('different room');
  });
});
