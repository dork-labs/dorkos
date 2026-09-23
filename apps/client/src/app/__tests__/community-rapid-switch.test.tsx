// @vitest-environment jsdom
/**
 * Rapid context switching, proven against the real fences (DOR-2186, task 4.1).
 *
 * The route epoch is committed by the real `onLoad` handler the router uses
 * (`createCommunityRouteMemory`), the content is the real `ChannelsPage` keyed
 * surface, and every read, stream and send goes through the real hooks. Only
 * the router's two hooks and the network are stand-ins: the address is set by
 * hand so a test can hop A→B→A→this DorkOS→B faster than any network answers,
 * then release the stale answers in the worst order and look at what is left.
 *
 * Two Communities deliberately share one room id (`general`), so nothing but
 * the Community ref and the fences keeps their content apart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import {
  RemoteCommunityEntrySchema,
  RemoteCommunityRoomSchema,
  type RemoteCommunityEntry,
  type RemoteCommunityEvent,
} from '@dorkos/shared/community-views';
import type { Transport } from '@dorkos/shared/transport';
import {
  confirmCommunityAuthority,
  invalidateCommunityAuthority,
  registerCommunityAuthorityCleanup,
} from '@/layers/shared/lib';
import {
  communityRefFromRouteDestination,
  getCommunityRouteEpoch,
  TransportProvider,
} from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import {
  communityNavigationKeys,
  eraseCommunityOwnerState,
  useCommunityDraftStore,
} from '@/layers/entities/community';
import { ChannelsPage } from '@/layers/widgets/room-view';
import { createCommunityRouteMemory } from '../community-route-memory';

type Address = { community?: string; id?: string };

const { router } = vi.hoisted(() => ({
  router: { address: {} as { community?: string; id?: string }, navigate: vi.fn() },
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useSearch: () => router.address,
  useNavigate: () => router.navigate,
}));
vi.mock('@/layers/widgets/room-view/model/use-team-room-redirect', () => ({
  useTeamRoomRedirect: () => 'show',
}));

const ROOM = 'general';
const TEXT = { a: 'Alpha private plan', b: 'Beta roadmap' } as const;
/** Room titles are content too: a late snapshot must not write A's room anywhere. */
const TITLE = { a: 'Alpha lounge', b: 'Beta lounge' } as const;
const OWNER = 'owner-1';

const access = {
  state: 'verified',
  effective: { read: true, post: true, enrollAgent: false, stream: true },
  lastKnown: {
    lifecycle: 'active',
    capabilities: { read: true, post: true, enrollAgent: false, stream: true },
    verifiedAt: '2026-09-23T10:00:00Z',
  },
} as const;

function connection(ref: 'a' | 'b'): CommunityConnectionDescriptor {
  return {
    ref: ref as never,
    remoteCommunityId: `remote-${ref}`,
    label: ref === 'a' ? 'Alpha' : 'Beta',
    pinnedOrigin: `https://${ref}.example.test`,
    connectedHumanMemberId: `person-${ref}`,
    status: 'connected',
    expiresAt: null,
    access,
    attention: { state: 'unavailable', unreadCount: null, mentionCount: null, verifiedAt: null },
  } as CommunityConnectionDescriptor;
}

function room(ref: string) {
  return RemoteCommunityRoomSchema.parse({
    community: ref,
    roomId: ROOM,
    remoteCommunityId: `remote-${ref}`,
    kind: 'channel',
    title: TITLE[ref as 'a' | 'b'],
    slug: 'general',
    topic: null,
    archived: false,
    createdAt: '2026-09-23T10:00:00Z',
    lastActivityAt: '2026-09-23T10:00:00Z',
    unreadCount: 0,
    visibility: 'public',
    readable: true,
    writable: true,
    joined: true,
    stale: false,
    cacheCursor: null,
    lastRemoteSeq: 1,
    access,
  });
}

function entry(ref: 'a' | 'b', text: string = TEXT[ref], seq = 1): RemoteCommunityEntry {
  return RemoteCommunityEntrySchema.parse({
    community: ref,
    roomId: ROOM,
    id: `entry-${seq}`,
    authorId: `person-${ref}`,
    authorKind: 'human',
    authorDisplayName: ref === 'a' ? 'Alex' : 'Bea',
    text,
    mentions: [],
    parentEntryId: null,
    threadRootEntryId: null,
    depth: 0,
    remoteSeq: seq,
    attachments: [],
    cursor: `cursor-${ref}-${seq}`,
    createdAt: '2026-09-23T10:00:00Z',
  });
}

function history(ref: 'a' | 'b', entries = [entry(ref)]) {
  return {
    community: ref,
    roomId: ROOM,
    entries,
    nextCursor: null,
    lastRemoteSeq: 1,
    stale: false,
  };
}

function snapshot(ref: 'a' | 'b', title?: string): RemoteCommunityEvent {
  return {
    type: 'snapshot',
    room: title === undefined ? room(ref) : { ...room(ref), title },
    entries: [entry(ref)],
    cursor: entry(ref).cursor,
    lastRemoteSeq: 1,
    stale: false,
  };
}

/** A promise this test settles by hand, recorded with the Community it belongs to. */
interface Pending<T> {
  ref: string;
  resolve: (value: T) => void;
}

function deferred<T>(ref: string, into: Pending<T>[]): Promise<T> {
  return new Promise<T>((resolve) => into.push({ ref, resolve }));
}

interface Stream {
  ref: string;
  emit: (event: RemoteCommunityEvent) => void;
  signal?: AbortSignal;
}

function setup() {
  const reads: Pending<ReturnType<typeof history>>[] = [];
  const posts: Pending<RemoteCommunityEntry>[] = [];
  const streams: Stream[] = [];
  const transport = createMockTransport() as Transport;
  vi.mocked(transport.listCommunityConnections).mockResolvedValue([
    connection('a'),
    connection('b'),
  ]);
  const navigation = {
    ownerKey: OWNER,
    installationDestination: { path: '/', search: {} },
    order: ['a', 'b'],
    destinations: [],
  };
  vi.mocked(transport.getCommunityNavigation).mockResolvedValue(navigation as never);
  vi.mocked(transport.rememberCommunityNavigation).mockResolvedValue(navigation as never);
  vi.mocked(transport.rememberCommunityInstallationDestination).mockResolvedValue(
    navigation as never
  );
  vi.mocked(transport.getRemoteCommunityRoom).mockImplementation(async (ref) => room(ref));
  vi.mocked(transport.listRemoteCommunityEntries).mockImplementation(
    (ref) => deferred(ref, reads) as never
  );
  vi.mocked(transport.listRemoteCommunityMembers).mockImplementation(
    async (ref) => ({ community: ref, roomId: ROOM, members: [], stale: false }) as never
  );
  vi.mocked(transport.listRemoteCommunityAgents).mockResolvedValue([] as never);
  vi.mocked(transport.setRemoteCommunityReadCursor).mockResolvedValue({
    cursor: null,
    unreadCount: 0,
  });
  vi.mocked(transport.postRemoteCommunityEntry).mockImplementation((ref) => deferred(ref, posts));
  vi.mocked(transport.subscribeRemoteCommunityRoom).mockImplementation(
    (ref, _room, emit, options) =>
      new Promise<void>((resolve) => {
        streams.push({ ref, emit, signal: options?.signal });
        options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      })
  );

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // The same owner-change cleanup `main.tsx` registers for the app.
  disposeCleanup = registerCommunityAuthorityCleanup(() => eraseCommunityOwnerState(client));
  const owner = invalidateCommunityAuthority();
  confirmCommunityAuthority(owner.epoch, OWNER);
  client.setQueryData(communityNavigationKeys.authority(owner.epoch), navigation);
  // The router's own `onLoad` handler: it is what commits each route epoch.
  const routeLoaded = createCommunityRouteMemory(client, transport);

  function Shell() {
    // The label the persistent trigger shows is derived from the committed
    // address, exactly as the switcher derives it.
    const ref = router.address.community;
    return (
      <main>
        <h1 data-testid="context-label">
          {ref === undefined ? 'This DorkOS' : ref === 'a' ? 'Alpha' : 'Beta'}
        </h1>
        {ref === undefined ? <p>Local home</p> : <ChannelsPage />}
      </main>
    );
  }
  const app = () => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <Shell />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  router.address = {};
  routeLoaded({ pathname: '/', search: {} });
  const view = render(app());

  /** Commit one navigation the way the router does: address, then `onLoad`, then paint. */
  function go(address: Address) {
    router.address = address;
    routeLoaded(
      address.community ? { pathname: '/channels', search: address } : { pathname: '/', search: {} }
    );
    view.rerender(app());
  }

  /** Every cached value that carries a Community's content, with the ref its key names. */
  function cachedContent() {
    return client
      .getQueryCache()
      .getAll()
      .filter((query) => query.state.data !== undefined)
      .map((query) => ({
        key: JSON.stringify(query.queryKey),
        data: JSON.stringify(query.state.data),
      }))
      .filter(({ data }) => [TEXT.a, TEXT.b, TITLE.a, TITLE.b].some((text) => data.includes(text)));
  }

  return { transport, client, reads, posts, streams, go, cachedContent };
}

/** Is this frame showing another Community's content under the labelled one? */
function assertFrameIsolated() {
  const label = screen.getByTestId('context-label').textContent;
  const body = document.body.textContent ?? '';
  if (label !== 'Alpha') for (const text of [TEXT.a, TITLE.a]) expect(body).not.toContain(text);
  if (label !== 'Beta') for (const text of [TEXT.b, TITLE.b]) expect(body).not.toContain(text);
}

beforeEach(() => {
  router.navigate.mockReset();
});
let disposeCleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  disposeCleanup();
  invalidateCommunityAuthority();
  useCommunityDraftStore.getState().discardAll();
  vi.clearAllMocks();
});

describe('rapid Community switching', () => {
  it('discards every stale read and stream event after A→B→A→this DorkOS→B, and lands on B', async () => {
    const { reads, streams, go, cachedContent, transport } = setup();

    // Each hop mounts its surface and starts its reads and stream before the
    // next hop, so every one of them is in flight when the route moves on.
    const hops: Address[] = [
      { community: 'a', id: ROOM },
      { community: 'b', id: ROOM },
      { community: 'a', id: ROOM },
      {},
      { community: 'b', id: ROOM },
    ];
    for (const [index, address] of hops.entries()) {
      act(() => go(address));
      const opened = hops.slice(0, index + 1).filter((hop) => hop.community).length;
      if (address.community) {
        await waitFor(() => expect(streams).toHaveLength(opened));
        await waitFor(() => expect(reads).toHaveLength(opened));
        expect(streams.filter((stream) => !stream.signal?.aborted)).toHaveLength(1);
      } else {
        // This DorkOS: every Community stream is closed, nothing of either shows.
        expect(streams.every((stream) => stream.signal?.aborted)).toBe(true);
      }
      assertFrameIsolated();
    }

    // Only the final B stream is open; A's two and the first B's are closed.
    expect(streams.map((stream) => [stream.ref, Boolean(stream.signal?.aborted)])).toEqual([
      ['a', true],
      ['b', true],
      ['a', true],
      ['b', false],
    ]);

    // Room reads answered while each hop was current, so they may sit under
    // their own hop's key for return navigation. Nothing else may change.
    const before = cachedContent();
    for (const { key, data } of before) if (key.includes('"b"')) expect(data).not.toMatch(/Alpha/);

    // Release every stale answer, newest-stale first, while B is on screen:
    // the returned A's read, the first B's read, the first A's read, plus
    // events on every closed stream.
    await act(async () => {
      for (const index of [2, 1, 0]) reads[index]!.resolve(history(reads[index]!.ref as 'a' | 'b'));
      // A late snapshot carries a changed room, so a write it made anywhere
      // (even under its own old key) would show up as a changed cache value.
      for (const stream of streams.slice(0, 3)) {
        const ref = stream.ref as 'a' | 'b';
        stream.emit(snapshot(ref, `${TITLE[ref]} (late)`));
      }
    });
    assertFrameIsolated();
    expect(document.body.textContent).not.toContain(TEXT.a);
    // No stale answer was written to the cache under any key, for either Community.
    expect(cachedContent()).toEqual(before);
    expect(JSON.stringify(before)).not.toContain(TEXT.a);

    // The final B's own answers do land, under B's label.
    await act(async () => {
      reads[3]!.resolve(history('b'));
      streams[3]!.emit(snapshot('b'));
    });
    expect(await screen.findByText(TEXT.b)).toBeInTheDocument();
    expect(screen.getByTestId('context-label')).toHaveTextContent('Beta');
    assertFrameIsolated();
    const cached = cachedContent();
    expect(cached.some(({ data }) => data.includes(TEXT.b))).toBe(true);
    for (const { key, data } of cached) {
      // B's content lives only under B's keys, and B's keys hold nothing of A.
      if (data.includes(TEXT.b) || data.includes(TITLE.b)) expect(key).toContain('"b"');
      if (key.includes('"b"')) expect(data).not.toMatch(/Alpha/);
    }
    // The committed route is the last one chosen.
    expect(communityRefFromRouteDestination(getCommunityRouteEpoch().destination)).toBe('b');
    // Switching alone marked nothing read; the one read cursor written is B's
    // own, for the room B is showing.
    for (const call of vi.mocked(transport.setRemoteCommunityReadCursor).mock.calls)
      expect(call).toEqual(['b', ROOM, 'cursor-b-1']);
  });

  it('shows only the last context when every hop lands inside one frame', async () => {
    const { reads, streams, go } = setup();
    act(() => {
      go({ community: 'a', id: ROOM });
      go({ community: 'b', id: ROOM });
      go({ community: 'a', id: ROOM });
      go({});
      go({ community: 'b', id: ROOM });
    });
    await waitFor(() =>
      expect(streams.filter((stream) => !stream.signal?.aborted).map((s) => s.ref)).toEqual(['b'])
    );
    await waitFor(() => expect(reads.some((read) => read.ref === 'b')).toBe(true));
    await act(async () => {
      for (const read of reads) read.resolve(history(read.ref as 'a' | 'b'));
      for (const stream of streams) stream.emit(snapshot(stream.ref as 'a' | 'b'));
    });
    expect(await screen.findByText(TEXT.b)).toBeInTheDocument();
    expect(screen.getByTestId('context-label')).toHaveTextContent('Beta');
    expect(document.body.textContent).not.toContain(TEXT.a);
  });

  it('keeps a send made in A bound to A: its receipt never shows in B, and does not revive A’s old frame', async () => {
    const { reads, posts, streams, go, transport } = setup();
    act(() => go({ community: 'a', id: ROOM }));
    await waitFor(() => expect(streams).toHaveLength(1));
    await act(async () => {
      streams[0]!.emit(snapshot('a'));
      reads[0]!.resolve(history('a'));
    });
    expect(await screen.findByText(TEXT.a)).toBeInTheDocument();

    const input = await screen.findByRole('combobox');
    fireEvent.change(input, { target: { value: 'Sent from Alpha' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(vi.mocked(transport.postRemoteCommunityEntry).mock.calls[0]!.slice(0, 2)).toEqual([
      'a',
      ROOM,
    ]);

    act(() => go({ community: 'b', id: ROOM }));
    await waitFor(() => expect(streams).toHaveLength(2));
    await act(async () => {
      streams[1]!.emit(snapshot('b'));
      reads[1]!.resolve(history('b'));
    });
    expect(await screen.findByText(TEXT.b)).toBeInTheDocument();

    // The server confirms A's send while B is on screen.
    await act(async () => posts[0]!.resolve(entry('a', 'Sent from Alpha', 2)));
    expect(document.body.textContent).not.toContain('Sent from Alpha');
    expect(screen.queryByText('Delivery not confirmed.')).toBeNull();
    assertFrameIsolated();

    // Back on A, the new epoch reads its own history; the old receipt did not
    // write itself into it, so A shows only what A's server now returns.
    act(() => go({ community: 'a', id: ROOM }));
    await waitFor(() => expect(streams).toHaveLength(3));
    await act(async () => {
      streams[2]!.emit(snapshot('a'));
      reads[2]!.resolve(history('a'));
    });
    expect(await screen.findByText(TEXT.a)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Sent from Alpha');
    expect(document.body.textContent).not.toContain(TEXT.b);
  });

  it('discards a read that lands after the local owner changed, even back on the same route', async () => {
    const { reads, streams, go, cachedContent, client, transport } = setup();
    act(() => go({ community: 'a', id: ROOM }));
    await waitFor(() => expect(reads).toHaveLength(1));
    // From here the local server answers for the new owner, as it would after
    // a real sign-in; answering for owner 1 would (rightly) re-confirm owner 1.
    const ownerTwo = {
      ownerKey: 'owner-2',
      installationDestination: { path: '/', search: {} },
      order: [],
      destinations: [],
    };
    vi.mocked(transport.getCommunityNavigation).mockResolvedValue(ownerTwo as never);
    vi.mocked(transport.rememberCommunityNavigation).mockResolvedValue(ownerTwo as never);

    // Sign-out / owner change: authority is invalidated first, then the new
    // owner is confirmed. Owner 1's read is still in flight.
    act(() => {
      const next = invalidateCommunityAuthority();
      confirmCommunityAuthority(next.epoch, 'owner-2');
      client.setQueryData(communityNavigationKeys.authority(next.epoch), ownerTwo);
    });
    expect(streams[0]!.signal?.aborted).toBe(true);
    await act(async () => {
      reads[0]!.resolve(history('a'));
      streams[0]!.emit(snapshot('a'));
    });
    expect(document.body.textContent).not.toContain(TEXT.a);
    expect(cachedContent().filter(({ key }) => key.includes(OWNER))).toEqual([]);
  });

  it('brings each Community’s unsent draft back after A→B→A, never shows it in the other, and drops both when the owner changes', async () => {
    const { streams, go, client, transport } = setup();
    const composer = () => screen.findByRole('combobox');
    const type = async (text: string) =>
      fireEvent.change(await composer(), { target: { value: text } });
    const shown = async () => ((await composer()) as HTMLTextAreaElement).value;

    act(() => go({ community: 'a', id: ROOM }));
    await waitFor(() => expect(streams).toHaveLength(1));
    await type('Alpha draft, not sent');

    // B shares the room id; A's words must not be in its composer.
    act(() => go({ community: 'b', id: ROOM }));
    await waitFor(() => expect(streams).toHaveLength(2));
    expect(await shown()).toBe('');
    assertFrameIsolated();
    await type('Beta draft, not sent');

    act(() => go({}));
    expect(document.body.textContent).not.toContain('draft, not sent');

    act(() => go({ community: 'a', id: ROOM }));
    await waitFor(() => expect(streams).toHaveLength(3));
    expect(await shown()).toBe('Alpha draft, not sent');

    act(() => go({ community: 'b', id: ROOM }));
    await waitFor(() => expect(streams).toHaveLength(4));
    expect(await shown()).toBe('Beta draft, not sent');
    // Nothing was sent by switching.
    expect(transport.postRemoteCommunityEntry).not.toHaveBeenCalled();

    // A new local owner finds neither draft, even back on the same route.
    const ownerTwo = {
      ownerKey: 'owner-2',
      installationDestination: { path: '/', search: {} },
      order: ['a', 'b'],
      destinations: [],
    };
    vi.mocked(transport.getCommunityNavigation).mockResolvedValue(ownerTwo as never);
    act(() => {
      const next = invalidateCommunityAuthority();
      confirmCommunityAuthority(next.epoch, 'owner-2');
      client.setQueryData(communityNavigationKeys.authority(next.epoch), ownerTwo);
    });
    expect(useCommunityDraftStore.getState().drafts).toEqual({});
    act(() => go({ community: 'a', id: ROOM }));
    expect(await shown()).toBe('');
    expect(document.body.textContent).not.toContain('draft, not sent');
  });
});
