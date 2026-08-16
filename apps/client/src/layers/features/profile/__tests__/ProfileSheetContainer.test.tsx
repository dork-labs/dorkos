/**
 * @vitest-environment jsdom
 *
 * The half of the profile that talks to the roster and to the URL (spec
 * `profile-unification` §1.6).
 *
 * Four things are pinned here that the view's own tests cannot see: that a
 * closed profile costs no request (it mounts on every route, so an ungated read
 * would be a roster fetch on every page load), that a link to an identity the
 * roster does not hold clears itself instead of riding the URL forever, that a
 * *failed* read is treated as "could not look" rather than "they are gone", and
 * that `?profilePage=` opens a page — including when the page names nothing
 * this build has.
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
import { TransportProvider, mergeDialogSearch, useAppStore } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { ProfileSheetContainer } from '../ui/ProfileSheetContainer';

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

  const transport = createMockTransport({
    getTeamRoster,
    getAgentByPath: vi.fn().mockResolvedValue(null),
  } as Partial<Transport>);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const onOpenChange = vi.fn();

  render(
    <HookSlotContext.Provider
      value={
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>
            <TooltipProvider>
              <ProfileSheetContainer open={open} onOpenChange={onOpenChange} />
            </TooltipProvider>
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

/** The profile panel, portalled into `document.body`. */
const panel = () => document.body.querySelector('[data-slot="profile"]');

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({
    settingsOpen: false,
    profileOpen: false,
    profileMemberId: null,
    profilePage: null,
  });
});

afterEach(() => {
  cleanup();
});

describe('what it costs when nothing is open', () => {
  it('asks for no roster while the profile is closed', async () => {
    // The container mounts on every route through `DialogHost`. An ungated read
    // here is a `GET /api/team` on every page load, for nobody.
    const harness = renderContainer({ open: false, url: '/' });
    await harness.ready();

    await waitFor(() => expect(harness.pathname()).toBe('/'));
    expect(harness.getTeamRoster).not.toHaveBeenCalled();
  });

  it('asks for no roster when the open flag has no subject behind it', async () => {
    useAppStore.setState({ profileOpen: true });
    const harness = renderContainer({ open: true, url: '/' });
    await harness.ready();

    expect(harness.getTeamRoster).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
  });
});

describe('resolving ?profile=', () => {
  it('reads the roster once and draws the identity the URL names', async () => {
    const harness = renderContainer({ url: `/?profile=${WARDEN}` });
    await harness.ready();

    expect(await screen.findByText('Warden')).toBeInTheDocument();
    expect(harness.getTeamRoster).toHaveBeenCalledTimes(1);
    expect(panel()?.getAttribute('data-member-id')).toBe(WARDEN);
  });

  it('resolves the owner from the same roster read', async () => {
    const harness = renderContainer({ url: `/?profile=${WARDEN}` });
    await harness.ready();

    expect(await screen.findByRole('button', { name: 'Managed by You' })).toBeInTheDocument();
  });

  it('clears a link to an identity the roster does not hold', async () => {
    const harness = renderContainer({ url: '/?profile=person-who-left' });
    await harness.ready();

    await waitFor(() => expect(harness.search().profile).toBeUndefined());
    expect(panel()).toBeNull();
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
    expect(panel()).toBeNull();
  });

  it('draws nothing, and clears nothing, while the read is still in flight', async () => {
    const harness = renderContainer({
      url: `/?profile=${WARDEN}`,
      getTeamRoster: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    await harness.ready();

    expect(panel()).toBeNull();
    expect(harness.search().profile).toBe(WARDEN);
  });
});

describe('resolving ?profilePage=', () => {
  it('opens straight onto the page the link names', async () => {
    const harness = renderContainer({ url: `/?profile=${OPERATOR}&profilePage=manages` });
    await harness.ready();

    expect(await screen.findByRole('heading', { name: 'Manages' })).toBeInTheDocument();
  });

  it('lands on the root when the link names a page this build has not got', async () => {
    // A bookmark minted against a later build, or a typo. The subject is still
    // good, so the profile opens — on its root, rather than on nothing.
    const harness = renderContainer({ url: `/?profile=${OPERATOR}&profilePage=not-a-page` });
    await harness.ready();

    expect(await screen.findByRole('heading', { name: 'Dorian' })).toBeInTheDocument();
    expect(document.body.querySelector('[data-slot="profile-page"]')).toBeNull();
  });

  it('writes the page onto the URL when a row pushes it', async () => {
    const harness = renderContainer({ url: `/?profile=${OPERATOR}` });
    await harness.ready();

    await userEvent.click(await screen.findByRole('button', { name: /^Manages/ }));

    await waitFor(() => expect(harness.search().profilePage).toBe('manages'));
  });

  it('takes the page back off when you go back, and keeps the subject', async () => {
    const harness = renderContainer({ url: `/?profile=${OPERATOR}&profilePage=manages` });
    await harness.ready();

    await userEvent.click(await screen.findByRole('button', { name: 'Back to profile' }));

    await waitFor(() => expect(harness.search().profilePage).toBeUndefined());
    expect(harness.search().profile).toBe(OPERATOR);
  });

  it('rewrites the subject when a chained profile is pushed, and drops the page', async () => {
    const harness = renderContainer({ url: `/?profile=${OPERATOR}&profilePage=manages` });
    await harness.ready();

    await userEvent.click(await screen.findByText('Warden'));

    await waitFor(() => expect(harness.search().profile).toBe(WARDEN));
    expect(harness.search().profilePage).toBeUndefined();
  });
});

describe('the address rule', () => {
  it('sheets a profile on /session while nothing knows that session’s agent', async () => {
    // The docked home is W2.3's. Until it can answer, every link is a sheet —
    // which is exactly what the drawer did.
    const harness = renderContainer({ url: `/session?profile=${WARDEN}` });
    await harness.ready();

    expect(await screen.findByText('Warden')).toBeInTheDocument();
  });
});
