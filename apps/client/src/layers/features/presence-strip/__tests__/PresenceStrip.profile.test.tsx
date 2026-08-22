// @vitest-environment jsdom
/**
 * The presence strip's hover card can open the agent it describes (spec
 * `profile-unification` §3, bug 7 — its footer read **soon** on a strip whose
 * every row could name its agent).
 *
 * Two claims, and the second is the one that would rot silently. **The card's
 * footer opens the ROSTER's id**, which for an agent is its manifest id and
 * never the author id a room claim carries — a click that opened the latter
 * lands on an empty profile. And **pressing the chip still follows the work**:
 * the strip's whole subject is live work, and re-pointing its press at a
 * settings surface would take away the one thing this line exists to offer.
 *
 * Driven through `usePresenceStrip` rather than the view, because the wiring is
 * what is under test: a view handed a spy would agree with any id, and the URL
 * is where the truth lives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { agentAuthorRef, type RoomSignalEvent } from '@dorkos/shared/room-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useInteractionStore } from '@/layers/entities/interactions';
import { useRoomPresenceStore } from '@/layers/entities/room';
import { useSessionListStore } from '@/layers/entities/session';
import { usePresenceStrip } from '../model/use-presence-strip';

const ROOM_ID = 'room-1';
/** The id the ROOM speaks in — the one that must never reach a profile. */
const AUTHOR_ID = 'author-1';
const AGENT_PATH = '/code/tangerines';
/**
 * The id the TEAM roster speaks in — the one a profile opens on. It comes from
 * the mesh REGISTRY, and is deliberately not the id the manifest below carries:
 * the two usually agree, and a fixture where they did would let the strip read
 * either one and stay green.
 */
const REGISTRY_ID = '01JZREGISTRY000000000001';
/** What the agent calls itself on disk. Never a profile address. */
const ON_DISK_ID = '01JZONDISK00000000000001';

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
        // The join key, and the reason the row can be named at all: the fleet
        // is indexed by this, never by a display name.
        agentRef: agentAuthorRef(AGENT_PATH),
      },
      origin: { kind: 'local' },
    },
  ],
};

const ROOM_LISTED = {
  id: ROOM_ID,
  kind: 'channel',
  slug: 'release-train',
  title: 'release-train',
  unreadCount: 0,
  participants: null,
  lastActivityAt: '2026-08-08T00:00:00.000Z',
};

const MANIFEST = {
  id: ON_DISK_ID,
  name: 'tangerines',
  displayName: 'tangerines',
  runtime: 'claude-code',
  color: '#6366f1',
  icon: '🍊',
} as unknown as AgentManifest;

/** A `progress` signal exactly as a room's own stream delivers one. */
function working(): RoomSignalEvent {
  return {
    type: 'signal',
    signal: 'progress',
    authorId: AUTHOR_ID,
    state: 'working',
    entryId: 'entry-1',
    since: new Date().toISOString(),
    at: new Date().toISOString(),
  } as unknown as RoomSignalEvent;
}

/** A host that renders the slot exactly as the pinned header will. */
function Host() {
  return <>{usePresenceStrip().node}</>;
}

/**
 * Mount the strip under a real router.
 *
 * @param resolved - What `resolveAgents` answers for the agent's directory.
 *   `null` is the fleet failing to name it, which is what leaves a row with no
 *   profile to open.
 */
function renderStrip(resolved: AgentManifest | null = MANIFEST) {
  const transport = createMockTransport({
    listRooms: vi.fn().mockResolvedValue([ROOM_LISTED]),
    getRoom: vi.fn().mockResolvedValue(ROOM_DETAIL),
    listMeshAgentPaths: vi.fn().mockResolvedValue({
      agents: [{ id: REGISTRY_ID, name: 'tangerines', projectPath: AGENT_PATH }],
    }),
    resolveAgents: vi.fn().mockResolvedValue({ [AGENT_PATH]: resolved }),
  } as Partial<Transport>);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  const rootRoute = createRootRoute({ staticData: { header: null }, component: () => <Outlet /> });
  const indexRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: (search: Record<string, unknown>) => search,
    component: Host,
  });
  // Where following a room claim goes — mounted so the press has somewhere real
  // to land and the difference between the two verbs is visible in the URL.
  const channelsRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/channels',
    validateSearch: (search: Record<string, unknown>) => search,
    component: () => <p>channels</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, channelsRoute]),
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

  return {
    transport,
    /** Whose profile the URL is holding open, or `null` while it holds none. */
    openProfileId: () => (router.state.location.search as { profile?: string }).profile ?? null,
    /** Where the strip has taken the reader, if anywhere. */
    pathname: () => router.state.location.pathname,
  };
}

/** The chip, once the strip has heard that somebody is working. */
async function chip(): Promise<HTMLElement> {
  return screen.findByRole('button', { name: /^Watch tangerines/ });
}

describe('the presence strip’s hover card opens a profile', () => {
  beforeEach(() => {
    useRoomPresenceStore.setState({ rooms: {} });
    useSessionListStore.setState({ statuses: {}, statusCwds: {} });
    useInteractionStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('opens the agent’s REGISTRY id — not the author id, not the on-disk id', async () => {
    const user = userEvent.setup();
    const { transport, openProfileId } = renderStrip();
    await waitFor(() => expect(transport.listRooms).toHaveBeenCalled());
    useRoomPresenceStore.getState().observe(ROOM_ID, working());

    await user.hover(await chip());
    await user.click(await screen.findByRole('button', { name: 'View profile' }));

    expect(openProfileId()).toBe(REGISTRY_ID);
    // Spelled out because this is the whole point: BOTH of the other ids this
    // row was built from would have opened a profile the roster does not hold.
    expect(openProfileId()).not.toBe(AUTHOR_ID);
    expect(openProfileId()).not.toBe(ON_DISK_ID);
  });

  it('still follows the work when the chip itself is pressed', async () => {
    // The strip's press is a window onto live work, not a door to settings.
    // Red the day "View profile" is moved onto the chip.
    const user = userEvent.setup();
    const { transport, openProfileId, pathname } = renderStrip();
    await waitFor(() => expect(transport.listRooms).toHaveBeenCalled());
    useRoomPresenceStore.getState().observe(ROOM_ID, working());

    await user.click(await chip());

    await waitFor(() => expect(pathname()).toBe('/channels'));
    expect(openProfileId()).toBeNull();
  });

  it('leaves the footer marked “soon” for an agent the fleet could not name', async () => {
    const user = userEvent.setup();
    const { transport } = renderStrip(null);
    await waitFor(() => expect(transport.listRooms).toHaveBeenCalled());
    useRoomPresenceStore.getState().observe(ROOM_ID, working());

    await user.hover(await chip());

    expect(await screen.findByText('soon')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View profile' })).not.toBeInTheDocument();
  });
});
