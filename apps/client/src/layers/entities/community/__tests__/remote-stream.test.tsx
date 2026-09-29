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
import { getCommunityRouteEpoch, TransportProvider } from '@/layers/shared/model';
import { confirmCommunityAuthority, invalidateCommunityAuthority } from '@/layers/shared/lib';
import { communityKeys } from '../model/use-community-connections';
import { communityNavigationKeys } from '../model/use-community-navigation';
import {
  applyRemoteCommunityRevisions,
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
const snapshot = (community = 'a'): Extract<RemoteCommunityEvent, { type: 'snapshot' }> => ({
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
  const transport = createMockTransport({
    subscribeRemoteCommunityRoom: subscribe,
    getCommunityNavigation: vi
      .fn()
      .mockResolvedValue({ ownerKey: 'owner-a', order: [], destinations: [] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const authority = invalidateCommunityAuthority();
  confirmCommunityAuthority(authority.epoch, 'owner-a');
  const confirmed = {
    epoch: authority.epoch,
    ownerKey: 'owner-a',
    route: getCommunityRouteEpoch(),
    accessFingerprint: 'legacy',
  };
  client.setQueryData(communityNavigationKeys.authority(authority.epoch), {
    ownerKey: 'owner-a',
    order: [],
    destinations: [],
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { streams, subscribe, client, wrapper, authority: confirmed };
}
afterEach(() => {
  cleanup();
  invalidateCommunityAuthority();
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
    const { streams, wrapper, client, authority } = setup();
    client.setQueryData(communityKeys.entries(authority, 'a', 'same'), { private: true });
    client.setQueryData(communityKeys.entries(authority, 'b', 'same'), { keep: true });
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
    expect(client.getQueryData(communityKeys.entries(authority, 'a', 'same'))).toBeUndefined();
    expect(client.getQueryData(communityKeys.entries(authority, 'b', 'same'))).toEqual({
      keep: true,
    });
  });

  it('keeps last authorized history explicitly stale and unwritable during an outage', async () => {
    const { streams, wrapper, client, authority } = setup();
    const hook = renderHook(() => useRemoteCommunityStream('a', 'same'), { wrapper });
    act(() => streams[0].emit(snapshot()));
    act(() => streams[0].reject(Object.assign(new Error('Unavailable'), { status: 503 })));
    await waitFor(() => expect(hook.result.current.status).toBe('offline'));
    expect(hook.result.current.entries).toHaveLength(1);
    expect(hook.result.current.room).toMatchObject({ writable: false, stale: true });
    expect(client.getQueryData(communityKeys.room(authority, 'a', 'same'))).toMatchObject({
      writable: false,
      stale: true,
    });
  });

  it('turns a verified stream into cache-only history without reconnecting', () => {
    const { streams, wrapper } = setup();
    const hook = renderHook(
      ({ enabled, cacheReadable }) =>
        useRemoteCommunityStream('a', 'same', enabled, 0, 'verified-generation', cacheReadable),
      { wrapper, initialProps: { enabled: true, cacheReadable: false } }
    );
    act(() => streams[0].emit(snapshot()));
    hook.rerender({ enabled: false, cacheReadable: true });

    expect(streams[0].signal?.aborted).toBe(true);
    expect(streams).toHaveLength(1);
    expect(hook.result.current.status).toBe('offline');
    expect(hook.result.current.entries).toHaveLength(1);
    expect(hook.result.current.room).toMatchObject({ stale: true, writable: false });
  });

  it('discards late stream events after the owner generation is invalidated', () => {
    const { streams, wrapper, client, authority } = setup();
    const hook = renderHook(() => useRemoteCommunityStream('a', 'same'), { wrapper });
    act(() => streams[0].emit(snapshot()));
    expect(hook.result.current.entries).toHaveLength(1);

    act(() => {
      invalidateCommunityAuthority();
      client.removeQueries({ queryKey: communityKeys.remote(authority, 'a') });
      streams[0].emit({ type: 'entry', entry: entry('a', 2) });
    });

    expect(hook.result.current.entries).toEqual([]);
    expect(hook.result.current.status).toBe('connecting');
    expect(client.getQueryData(communityKeys.room(authority, 'a', 'same'))).toBeUndefined();
  });

  // DOR-2544. Purpose: a `revision` rewrites the held entry and the cached history pages in
  // place, keeping what the view derived (thread summary, native order), and never adds a row.
  it('replaces a held entry in place, in the stream and the cached history, and adds nothing', () => {
    const { streams, wrapper, client, authority } = setup();
    const root = RemoteCommunityEntrySchema.parse({
      ...entry('a', 1),
      thread: { replyCount: 2, lastReplyAt: '2026-09-16T10:05:00Z' },
      threadLastReplySeq: 4,
    });
    client.setQueryData(communityKeys.entries(authority, 'a', 'same'), {
      pages: [
        {
          community: 'a',
          roomId: 'same',
          entries: [root],
          nextCursor: null,
          lastRemoteSeq: 1,
          stale: false,
        },
      ],
      pageParams: [undefined],
    });
    const hook = renderHook(() => useRemoteCommunityStream('a', 'same'), { wrapper });
    act(() => streams[0].emit({ ...snapshot(), entries: [root, entry('a', 2)] }));
    const tombstone = RemoteCommunityEntrySchema.parse({
      ...entry('a', 1),
      text: 'This message was erased.',
      authorDisplayName: 'Erased member',
    });

    act(() => streams[0].emit({ type: 'revision', entry: tombstone }));
    act(() =>
      streams[0].emit({ type: 'revision', entry: { ...tombstone, id: 'unknown', remoteSeq: 9 } })
    );

    const [first, second] = hook.result.current.entries;
    expect(hook.result.current.entries).toHaveLength(2);
    expect(first).toMatchObject({
      id: 'entry-1',
      text: 'This message was erased.',
      authorDisplayName: 'Erased member',
      thread: { replyCount: 2 },
      threadLastReplySeq: 4,
      remoteSeq: 1,
    });
    expect(second?.text).toBe('a only');
    // A change to a message this view cannot show is not remembered: a replay of the whole feed
    // must not crowd out the ones that matter.
    expect([...hook.result.current.revisions.keys()]).toEqual(['entry-1']);
    const cached = client.getQueryData<{ pages: Array<{ entries: unknown[] }> }>(
      communityKeys.entries(authority, 'a', 'same')
    );
    expect(cached?.pages[0]?.entries).toEqual([
      expect.objectContaining({
        text: 'This message was erased.',
        thread: { replyCount: 2, lastReplyAt: '2026-09-16T10:05:00Z' },
      }),
    ]);
    // A history page answered before the change still shows it.
    expect(
      applyRemoteCommunityRevisions([root], hook.result.current.revisions).map((item) => item.text)
    ).toEqual(['This message was erased.']);
  });

  // DOR-2544. Purpose: the feed position from the snapshot and each revision is sent back on a
  // resume, so a message deleted or erased while disconnected still arrives.
  it('sends the last feed position back when it resumes', async () => {
    const { streams, subscribe, wrapper } = setup();
    renderHook(() => useRemoteCommunityStream('a', 'same'), { wrapper });
    act(() => streams[0].emit({ ...snapshot(), redactionCursor: 'feed-1' }));
    act(() =>
      streams[0].emit({
        type: 'revision',
        entry: RemoteCommunityEntrySchema.parse({ ...entry('a', 1), text: 'deleted' }),
        redactionCursor: 'feed-2',
      })
    );
    act(() => streams[0].reject(Object.assign(new Error('Unavailable'), { status: 503 })));
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    expect(subscribe.mock.calls[1]![3]).toMatchObject({
      since: entry('a', 1).cursor,
      redactions: 'feed-2',
    });
  });

  // DOR-2544. Purpose: a revision from a previous connection generation must never reach the view
  // or the cache after a switch. It fails if the stream callback's fence is bypassed.
  it('ignores a revision from a previous connection generation', () => {
    const { streams, wrapper, client, authority } = setup();
    const hook = renderHook(
      ({ fingerprint }) => useRemoteCommunityStream('a', 'same', true, 0, fingerprint),
      { wrapper, initialProps: { fingerprint: 'generation-1' } }
    );
    act(() => streams[0].emit(snapshot()));
    hook.rerender({ fingerprint: 'generation-2' });
    act(() => streams[1].emit(snapshot()));
    const next = { ...authority, accessFingerprint: 'generation-2' };
    client.setQueryData(communityKeys.entries(next, 'a', 'same'), {
      pages: [
        {
          community: 'a',
          roomId: 'same',
          entries: [entry('a', 1)],
          nextCursor: null,
          lastRemoteSeq: 1,
          stale: false,
        },
      ],
      pageParams: [undefined],
    });

    act(() =>
      streams[0].emit({
        type: 'revision',
        entry: RemoteCommunityEntrySchema.parse({ ...entry('a', 1), text: 'stale change' }),
      })
    );

    expect(hook.result.current.entries.map((item) => item.text)).toEqual(['a only']);
    expect(hook.result.current.revisions.size).toBe(0);
    const cached = client.getQueryData<{ pages: Array<{ entries: Array<{ text: string }> }> }>(
      communityKeys.entries(next, 'a', 'same')
    );
    expect(cached?.pages[0]?.entries[0]?.text).toBe('a only');
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
