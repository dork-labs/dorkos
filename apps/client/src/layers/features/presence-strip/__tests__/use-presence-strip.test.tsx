/**
 * The strip wired to the cockpit: presence events in, a slot out, and what a
 * click on somebody else's work is allowed to do (spec `team-room-home` D3.3).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, type ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomSignalEvent } from '@dorkos/shared/room-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useRoomPresenceStore } from '@/layers/entities/room';
import { useSessionListStore } from '@/layers/entities/session';
import { usePresenceStrip } from '../model/use-presence-strip';
import { usePresenceRows } from '../model/use-presence-rows';
import type { PresenceRow } from '../lib/presence-rows';

const ROOM_ID = 'room-1';
const AUTHOR_ID = 'author-1';
const AGENT_PATH = '/code/tangerines';

/** The room the strip reads, roster and all. */
const ROOM_DETAIL = {
  id: ROOM_ID,
  kind: 'channel',
  slug: 'release-train',
  title: 'release-train',
  viewerAuthorId: 'human-1',
  members: [
    {
      roomId: ROOM_ID,
      authorId: AUTHOR_ID,
      responseMode: 'engaged',
      joinedAt: '2026-08-01T00:00:00.000Z',
      joinedSeq: 0,
      lastReadSeq: 0,
      author: {
        id: AUTHOR_ID,
        kind: 'agent',
        displayName: 'tangerines',
        handle: 'tangerines',
      },
      origin: { kind: 'local' },
    },
  ],
};

/** The same room as the sidebar's list carries it. */
const ROOM_LISTED = {
  id: ROOM_ID,
  kind: 'channel',
  slug: 'release-train',
  title: 'release-train',
  unreadCount: 0,
  participants: null,
  lastActivityAt: '2026-08-08T00:00:00.000Z',
};

/** A `progress` signal exactly as a room's own stream delivers one. */
function progress(state: 'working' | 'working_late' | 'done'): RoomSignalEvent {
  return {
    type: 'signal',
    signal: 'progress',
    authorId: AUTHOR_ID,
    state,
    entryId: 'entry-1',
    since: new Date().toISOString(),
    at: new Date().toISOString(),
  } as unknown as RoomSignalEvent;
}

/** Reads the strip performs on load — counted, so a re-render can be shown not to refetch. */
function readCount(transport: Transport): number {
  return (
    vi.mocked(transport.getRoom).mock.calls.length +
    vi.mocked(transport.listRooms).mock.calls.length +
    vi.mocked(transport.listMeshAgentPaths).mock.calls.length +
    vi.mocked(transport.resolveAgents).mock.calls.length
  );
}

/**
 * Every transport call that carries `X-Client-Id` and so takes the session
 * lock, plus the interrupt, which is the other way to disturb a running turn.
 */
function lockingCalls(transport: Transport): number {
  return (
    vi.mocked(transport.postMessage).mock.calls.length +
    vi.mocked(transport.runCommandIntent).mock.calls.length +
    vi.mocked(transport.sendUiAction).mock.calls.length +
    vi.mocked(transport.interruptSession).mock.calls.length
  );
}

/** A host that renders the slot exactly as the pinned header will. */
function Host() {
  const { occupied, node } = usePresenceStrip();
  return (
    <div>
      <span data-testid="occupied">{String(occupied)}</span>
      {node}
    </div>
  );
}

/** Render the strip under a router, because following navigates. */
function renderStrip(overrides: Partial<Transport> = {}) {
  const transport = createMockTransport({
    listRooms: vi.fn().mockResolvedValue([ROOM_LISTED]),
    getRoom: vi.fn().mockResolvedValue(ROOM_DETAIL),
    listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [{ projectPath: AGENT_PATH }] }),
    resolveAgents: vi.fn().mockResolvedValue({ [AGENT_PATH]: null }),
    ...overrides,
  } as Partial<Transport>);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: (search: Record<string, unknown>) => search,
    component: Host,
  });
  const channelsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/channels',
    validateSearch: (search: Record<string, unknown>) => search,
    component: () => <p>channels</p>,
  });
  const sessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/session',
    validateSearch: (search: Record<string, unknown>) => search,
    component: () => <p>session</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, channelsRoute, sessionRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        {/* Not the app's registered router; the cast only satisfies the generic. */}
        <RouterProvider router={router as never} />
      </TransportProvider>
    </QueryClientProvider>
  );

  return { transport, router };
}

describe('usePresenceStrip', () => {
  beforeEach(() => {
    useRoomPresenceStore.setState({ rooms: {} });
    useSessionListStore.setState({ statuses: {}, statusCwds: {} });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('stands down when nobody is working, rather than saying so', async () => {
    const { transport } = renderStrip();

    await waitFor(() => expect(transport.listRooms).toHaveBeenCalled());

    expect(screen.getByTestId('occupied')).toHaveTextContent('false');
    expect(screen.queryByTestId('presence-strip')).not.toBeInTheDocument();
  });

  it('adds an agent on a working signal and drops it when the work ends', async () => {
    const { transport } = renderStrip();
    await waitFor(() => expect(transport.listRooms).toHaveBeenCalled());

    useRoomPresenceStore.getState().observe(ROOM_ID, progress('working'));

    expect(
      await screen.findByRole('button', { name: 'Watch tangerines — replying in #release-train' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('occupied')).toHaveTextContent('true');

    // Baseline taken with the strip already drawn, so what follows measures
    // what a CHANGE in presence costs — the first claim legitimately reads the
    // roster of the room it names, and only once.
    const readsSettled = readCount(transport);

    useRoomPresenceStore.getState().observe(ROOM_ID, progress('working_late'));

    expect(
      await screen.findByRole('button', {
        name: 'Watch tangerines — replying in #release-train · taking longer than usual',
      })
    ).toBeInTheDocument();
    // The signal carries the whole fact, so nothing goes back to the server for
    // it. A strip that refetched would turn every busy agent into a poll of the
    // room list — which is exactly why `room_presence` is handled and not
    // invalidated on the global stream.
    expect(readCount(transport)).toBe(readsSettled);

    useRoomPresenceStore.getState().observe(ROOM_ID, progress('done'));

    await waitFor(() => expect(screen.queryByTestId('presence-strip')).not.toBeInTheDocument());
    expect(screen.getByTestId('occupied')).toHaveTextContent('false');
    expect(readCount(transport)).toBe(readsSettled);
  });

  it('follows a working agent into its room without claiming its session', async () => {
    const user = userEvent.setup();
    const { transport, router } = renderStrip();
    await waitFor(() => expect(transport.listRooms).toHaveBeenCalled());
    useRoomPresenceStore.getState().observe(ROOM_ID, progress('working'));

    await user.click(await screen.findByRole('button', { name: /Watch tangerines/ }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/channels'));
    expect(router.state.location.search).toEqual({ id: ROOM_ID });
    // Watch, not hijack: the lock is taken only by writes, and following makes
    // none. Red the moment this grows a "take over" or a kickoff message.
    expect(lockingCalls(transport)).toBe(0);
  });

  it('follows a session-only agent into its session, in the directory it runs in', async () => {
    const user = userEvent.setup();
    const { transport, router } = renderStrip({
      resolveAgents: vi.fn().mockResolvedValue({
        [AGENT_PATH]: {
          id: '01JZAGENT0000000000000001',
          name: 'tangerines',
          displayName: 'tangerines',
          runtime: 'claude-code',
        },
      }),
    });
    await waitFor(() => expect(transport.resolveAgents).toHaveBeenCalled());

    useSessionListStore.setState({
      statuses: { 'sess-1': { lifecycle: 'streaming' } as never },
      statusCwds: { 'sess-1': AGENT_PATH },
    });

    await user.click(
      await screen.findByRole('button', { name: 'Watch tangerines — working in a session' })
    );

    await waitFor(() => expect(router.state.location.pathname).toBe('/session'));
    expect(router.state.location.search).toEqual({ session: 'sess-1', dir: AGENT_PATH });
    expect(lockingCalls(transport)).toBe(0);
  });

  it('says nothing about a session whose runtime never reported where it runs', async () => {
    const { transport } = renderStrip({
      resolveAgents: vi.fn().mockResolvedValue({
        [AGENT_PATH]: {
          id: '01JZAGENT0000000000000001',
          name: 'tangerines',
          runtime: 'claude-code',
        },
      }),
    });
    await waitFor(() => expect(transport.resolveAgents).toHaveBeenCalled());

    // A lifecycle with no working directory beside it: `statusCwds` never gets
    // the session, so nothing can attribute the turn — and an unattributable
    // turn is not presence.
    useSessionListStore.setState({
      statuses: { 'sess-1': { lifecycle: 'streaming' } as never },
      statusCwds: {},
    });

    await waitFor(() => expect(screen.getByTestId('occupied')).toHaveTextContent('false'));
    expect(screen.queryByTestId('presence-strip')).not.toBeInTheDocument();
  });

  it('leaves an automated run out of "working", the way Now does (§18)', async () => {
    // The fourth surface to count what is running, and the one Now's "N
    // working" rollup NAVIGATES to (`SidebarChrome`): a nightly task counted
    // here and not there meant clicking "3 working" landed on a strip saying
    // four (DOR-1137 review, B2).
    const { transport } = renderStrip({
      resolveAgents: vi.fn().mockResolvedValue({
        [AGENT_PATH]: {
          id: '01JZAGENT0000000000000001',
          name: 'tangerines',
          runtime: 'claude-code',
        },
      }),
    });
    await waitFor(() => expect(transport.resolveAgents).toHaveBeenCalled());

    useSessionListStore.setState({
      statuses: { 'sess-task': { lifecycle: 'streaming' } as never },
      statusCwds: { 'sess-task': AGENT_PATH },
      sessions: {
        'sess-task': {
          id: 'sess-task',
          title: 'Nightly digest',
          cwd: AGENT_PATH,
          origin: 'task',
          createdAt: '2026-08-09T09:00:00.000Z',
          updatedAt: '2026-08-09T10:00:00.000Z',
        } as never,
      },
    });

    await waitFor(() => expect(screen.getByTestId('occupied')).toHaveTextContent('false'));
    expect(screen.queryByTestId('presence-strip')).not.toBeInTheDocument();
  });

  it('still draws the same session once it is a human conversation', async () => {
    // The sibling that makes the absence above mean something: identical
    // status, identical directory, identical everything except `origin`.
    const { transport } = renderStrip({
      resolveAgents: vi.fn().mockResolvedValue({
        [AGENT_PATH]: {
          id: '01JZAGENT0000000000000001',
          name: 'tangerines',
          runtime: 'claude-code',
        },
      }),
    });
    await waitFor(() => expect(transport.resolveAgents).toHaveBeenCalled());

    useSessionListStore.setState({
      statuses: { 'sess-task': { lifecycle: 'streaming' } as never },
      statusCwds: { 'sess-task': AGENT_PATH },
      sessions: {
        'sess-task': {
          id: 'sess-task',
          title: 'Wire the model',
          cwd: AGENT_PATH,
          origin: 'user',
          createdAt: '2026-08-09T09:00:00.000Z',
          updatedAt: '2026-08-09T10:00:00.000Z',
        } as never,
      },
    });

    expect(
      await screen.findByRole('button', { name: 'Watch tangerines — working in a session' })
    ).toBeInTheDocument();
  });

  it('never filters the room half — "replying in" is automated by design', async () => {
    // The carve-out, and the one that would quietly empty the feature: a room
    // claim IS an agent answering a trigger, so every one of them is
    // automated-origin. The rule belongs to the working-sessions half alone.
    const { transport } = renderStrip();
    await waitFor(() => expect(transport.listRooms).toHaveBeenCalled());

    useRoomPresenceStore.getState().observe(ROOM_ID, progress('working'));

    expect(
      await screen.findByRole('button', { name: 'Watch tangerines — replying in #release-train' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('occupied')).toHaveTextContent('true');
  });
});

describe('usePresenceStrip — what a quiet fleet costs', () => {
  beforeEach(() => {
    useRoomPresenceStore.setState({ rooms: {} });
    useSessionListStore.setState({ statuses: {}, statusCwds: {} });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  /** One session-status projection, as the global stream delivers one. */
  function status(lifecycle: string, outputTokens: number) {
    return {
      lifecycle,
      contextUsage: { outputTokens },
      cost: null,
      usage: null,
      cacheStats: null,
      model: null,
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: 0,
      lastError: null,
    } as never;
  }

  it('holds its answer still through status events that change nobody', async () => {
    // The probe that failed review: twenty `session_status` events carrying
    // token counts — the ordinary traffic of ONE agent taking a turn — moved
    // the rows array twenty times, and every avatar and hover card under it
    // with them. Nothing about who is working changed in any of them.
    const seen: (readonly PresenceRow[])[] = [];
    const nodes: ReactNode[] = [];

    function Probe() {
      const { node } = usePresenceStrip();
      const rows = usePresenceRows();
      seen.push(rows);
      nodes.push(node);
      return <>{node}</>;
    }

    const transport = createMockTransport({
      listRooms: vi.fn().mockResolvedValue([ROOM_LISTED]),
      getRoom: vi.fn().mockResolvedValue(ROOM_DETAIL),
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [{ projectPath: AGENT_PATH }] }),
      resolveAgents: vi.fn().mockResolvedValue({
        [AGENT_PATH]: {
          id: '01JZAGENT0000000000000001',
          name: 'tangerines',
          displayName: 'tangerines',
          runtime: 'claude-code',
        },
      }),
    } as Partial<Transport>);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      validateSearch: (search: Record<string, unknown>) => search,
      component: Probe,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <RouterProvider router={router as never} />
        </TransportProvider>
      </QueryClientProvider>
    );

    useSessionListStore.setState({
      statuses: { 'sess-1': status('streaming', 0) },
      statusCwds: { 'sess-1': AGENT_PATH },
    });
    await screen.findByRole('button', { name: /Watch tangerines/ });

    const settledRows = seen.at(-1);
    const settledNode = nodes.at(-1);

    // Twenty events that move a token count and nothing else. Each one is a
    // fresh `statuses` object, exactly as the stream binding writes it.
    for (let tick = 1; tick <= 20; tick++) {
      act(() => {
        useSessionListStore.setState({
          statuses: { 'sess-1': status('streaming', tick * 37) },
          statusCwds: { 'sess-1': AGENT_PATH },
        });
      });
    }

    // The rows are the same rows — not merely equal, the same array — so the
    // strip's element is the same element, and React re-renders none of it.
    expect(seen.at(-1)).toBe(settledRows);
    expect(nodes.at(-1)).toBe(settledNode);
    // And the answer is still true, rather than stale-and-stable.
    expect(screen.getByRole('button', { name: /Watch tangerines/ })).toBeInTheDocument();
  });

  it('moves its answer the moment the working set actually changes', async () => {
    // The other half of the same claim: a memo that never invalidates would
    // pass the test above and be a bug. This is what makes that one honest.
    const seen: (readonly PresenceRow[])[] = [];

    function Probe() {
      seen.push(usePresenceRows());
      return null;
    }

    const transport = createMockTransport({
      listRooms: vi.fn().mockResolvedValue([ROOM_LISTED]),
      getRoom: vi.fn().mockResolvedValue(ROOM_DETAIL),
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [{ projectPath: AGENT_PATH }] }),
      resolveAgents: vi.fn().mockResolvedValue({
        [AGENT_PATH]: {
          id: '01JZAGENT0000000000000001',
          name: 'tangerines',
          displayName: 'tangerines',
          runtime: 'claude-code',
        },
      }),
    } as Partial<Transport>);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <Probe />
        </TransportProvider>
      </QueryClientProvider>
    );

    await waitFor(() => expect(transport.resolveAgents).toHaveBeenCalled());
    act(() => {
      useSessionListStore.setState({
        statuses: { 'sess-1': status('streaming', 0) },
        statusCwds: { 'sess-1': AGENT_PATH },
      });
    });
    await waitFor(() => expect(seen.at(-1)).toHaveLength(1));

    act(() => {
      useSessionListStore.setState({
        statuses: { 'sess-1': status('idle', 0) },
        statusCwds: { 'sess-1': AGENT_PATH },
      });
    });

    await waitFor(() => expect(seen.at(-1)).toHaveLength(0));
  });
});
