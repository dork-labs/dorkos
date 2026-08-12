/**
 * @vitest-environment jsdom
 *
 * The half of the drawer that talks to the roster and to the URL.
 *
 * Three things are pinned here that the presentational tests cannot see: that a
 * closed drawer costs no request (it mounts on every route, so an ungated read
 * would be a roster fetch on every page load), that a link to an identity the
 * roster does not hold clears itself instead of riding the URL forever, and
 * that a *failed* read is treated as "could not look", not "they are gone".
 */
import { createContext, useContext, type ReactNode } from 'react';
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
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { useInteractionStore } from '@/layers/entities/interactions';
import { TransportProvider, mergeDialogSearch, useAppStore } from '@/layers/shared/model';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { ProfileDrawerContainer } from '../ui/ProfileDrawerContainer';

const WARDEN = 'agent-warden';
const OPERATOR = 'person-dorian';

const testSearchSchema = mergeDialogSearch(z.object({}));
const HookSlotContext = createContext<ReactNode>(null);

function HookSlot() {
  return <>{useContext(HookSlotContext)}</>;
}

/**
 * A one-route memory router carrying the merged dialog search schema, so the
 * container's deep-link hooks read and write the same params they do in the app.
 */
function renderContainer({
  url = '/',
  open = true,
  getTeamRoster = vi.fn().mockResolvedValue({ members: MOCK_TEAM_ROSTER }),
}: {
  url?: string;
  open?: boolean;
  getTeamRoster?: Transport['getTeamRoster'];
} = {}) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: zodValidator(testSearchSchema),
    component: HookSlot,
  });
  const sessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/session',
    validateSearch: zodValidator(testSearchSchema.extend({ dir: z.string().optional() })),
    component: HookSlot,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, sessionRoute]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });

  const transport = createMockTransport({ getTeamRoster } as Partial<Transport>);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const onOpenChange = vi.fn();

  render(
    <HookSlotContext.Provider
      value={
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>
            <ProfileDrawerContainer open={open} onOpenChange={onOpenChange} />
          </TransportProvider>
        </QueryClientProvider>
      }
    >
      <RouterProvider router={router} />
    </HookSlotContext.Provider>
  );

  return {
    getTeamRoster,
    onOpenChange,
    search: () => router.state.location.search as Record<string, unknown>,
    pathname: () => router.state.location.pathname,
    ready: () => waitFor(() => expect(router.state.status).toBe('idle')),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ settingsOpen: false, profileOpen: false, profileMemberId: null });
  useInteractionStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe('ProfileDrawerContainer — what it costs when nothing is open', () => {
  it('asks for no roster while the drawer is closed', async () => {
    // The container mounts on every route through `DialogHost`. An ungated read
    // here is a `GET /api/team` on every page load, for nobody.
    const harness = renderContainer({ open: false, url: '/' });
    await harness.ready();

    await waitFor(() => expect(harness.pathname()).toBe('/'));
    expect(harness.getTeamRoster).not.toHaveBeenCalled();
  });

  it('asks for no roster when the open flag has no subject behind it', async () => {
    // The store half can be flipped on without a member id; that is an open
    // drawer with nobody in it, and it has nothing to look up.
    useAppStore.setState({ profileOpen: true });
    const harness = renderContainer({ open: true, url: '/' });
    await harness.ready();

    expect(harness.getTeamRoster).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-slot="profile-drawer"]')).toBeNull();
  });
});

describe('ProfileDrawerContainer — resolving ?profile=', () => {
  it('reads the roster once and draws the identity the URL names', async () => {
    const harness = renderContainer({ url: `/?profile=${WARDEN}` });
    await harness.ready();

    expect(await screen.findByText('Warden')).toBeInTheDocument();
    expect(harness.getTeamRoster).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-member-id]')?.getAttribute('data-member-id')).toBe(
      WARDEN
    );
  });

  it('resolves the owner from the same roster read', async () => {
    const harness = renderContainer({ url: `/?profile=${WARDEN}` });
    await harness.ready();

    expect(await screen.findByText('Managed by @dorian')).toBeInTheDocument();
  });

  it('clears a link to an identity the roster does not hold', async () => {
    const harness = renderContainer({ url: '/?profile=person-who-left' });
    await harness.ready();

    await waitFor(() => expect(harness.search().profile).toBeUndefined());
    expect(document.body.querySelector('[data-slot="profile-drawer"]')).toBeNull();
  });

  it('keeps the link when the roster could not be read at all', async () => {
    // "We could not look" is not "they are gone". Clearing here would destroy a
    // good link because the server hiccuped.
    const harness = renderContainer({
      url: `/?profile=${WARDEN}`,
      getTeamRoster: vi.fn().mockRejectedValue(new Error('roster unreachable')),
    });
    await harness.ready();

    await waitFor(() => expect(harness.getTeamRoster).toHaveBeenCalled());
    await waitFor(() => expect(harness.search().profile).toBe(WARDEN));
    expect(document.body.querySelector('[data-slot="profile-drawer"]')).toBeNull();
  });

  it('draws nothing, and clears nothing, while the read is still in flight', async () => {
    const harness = renderContainer({
      url: `/?profile=${WARDEN}`,
      getTeamRoster: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    await harness.ready();

    expect(document.body.querySelector('[data-slot="profile-drawer"]')).toBeNull();
    expect(harness.search().profile).toBe(WARDEN);
  });
});

describe('ProfileDrawerContainer — its two actions', () => {
  it('sends Edit to the Settings profile tab, and leaves the drawer open', async () => {
    const harness = renderContainer({ url: `/?profile=${OPERATOR}` });
    await harness.ready();

    await userEvent.click(await screen.findByRole('button', { name: 'Edit profile' }));

    await waitFor(() => expect(harness.search().settings).toBe('profile'));
    expect(harness.search().profile).toBe(OPERATOR);
  });

  it('opens a session in the agent’s own project directory', async () => {
    const placed = MOCK_TEAM_ROSTER.map((member) =>
      member.id === WARDEN && member.agent
        ? { ...member, agent: { ...member.agent, projectPath: '/Users/dorian/code/dorkos' } }
        : member
    );
    const harness = renderContainer({
      url: `/?profile=${WARDEN}`,
      getTeamRoster: vi.fn().mockResolvedValue({ members: placed }),
    });
    await harness.ready();

    await userEvent.click(await screen.findByRole('button', { name: 'Open a session' }));

    await waitFor(() => expect(harness.pathname()).toBe('/session'));
    expect(harness.search().dir).toBe('/Users/dorian/code/dorkos');
    // The roster's door records the AGENT (DOR-1156). It names a directory and
    // not a session — which conversation opens is resolved afterwards — so the
    // agent is the only honest thing to write, and it is the one ⌘K and the New
    // menu's "last used" read.
    expect(Object.keys(useInteractionStore.getState().opened)).toEqual([
      'agent:/Users/dorian/code/dorkos',
    ]);
  });
});
