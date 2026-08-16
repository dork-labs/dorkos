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
import { useProfileStore } from '../model/profile-store';
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
/** Where the roster says Warden lives, which is what the fleet map keys on. */
const WARDEN_PATH = '/Users/dorian/agents/warden';

/** The fleet as `GET /api/mesh/agent-paths` returns it. */
const FLEET = [{ id: WARDEN, name: 'Warden', projectPath: WARDEN_PATH }];

function renderContainer({
  url = '/',
  open = true,
  fleet = FLEET,
  getTeamRoster = vi.fn().mockResolvedValue({ members: MOCK_TEAM_ROSTER }),
}: {
  url?: string;
  open?: boolean;
  fleet?: typeof FLEET;
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
    listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: fleet }),
    listMemberRooms: vi.fn().mockResolvedValue({ rooms: [] }),
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
    selectedCwd: null,
    explicitAgentPath: null,
    rightPanelOpen: false,
    activeRightPanelTab: null,
    rightPanelLayoutKey: null,
  });
  useProfileStore.setState({ dockedEntries: {}, sheetChain: [] });
  localStorage.clear();
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
  it('docks a link to the agent whose session you are already in, and clears it', async () => {
    // A sheet over the conversation, to tell you about the person you are having
    // it with, is the surface arguing with itself (§1.6). The panel beside the
    // composer answers instead — and the URL has nothing left to say, because
    // the panel is not an address.
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    const harness = renderContainer({ url: `/session?profile=${WARDEN}&profilePage=rooms` });
    await harness.ready();

    await waitFor(() => expect(useAppStore.getState().explicitAgentPath).toBe(WARDEN_PATH));
    expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
    expect(useProfileStore.getState().dockedEntries[WARDEN_PATH]).toEqual([
      { kind: 'page', page: 'rooms' },
    ]);
    // No sheet, and no link left riding the URL.
    await waitFor(() => expect(harness.search().profile).toBeUndefined());
    expect(panel()).toBeNull();
  });

  it('sheets a link to anybody else, even on /session', async () => {
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    const harness = renderContainer({ url: `/session?profile=${OPERATOR}` });
    await harness.ready();

    expect(await screen.findByRole('heading', { name: 'Dorian' })).toBeInTheDocument();
    expect(useAppStore.getState().rightPanelOpen).toBe(false);
  });

  it('sheets it off /session, even for that same agent', async () => {
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    const harness = renderContainer({ url: `/?profile=${WARDEN}` });
    await harness.ready();

    expect(await screen.findByText('Warden')).toBeInTheDocument();
    expect(useAppStore.getState().rightPanelOpen).toBe(false);
  });

  it('sheets it while the fleet cannot yet name the session’s agent', async () => {
    // "We do not know who this session belongs to" is not "it is somebody
    // else" — but a rule that docked on a maybe would send the link nowhere.
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    const harness = renderContainer({ url: `/session?profile=${WARDEN}`, fleet: [] });
    await harness.ready();

    expect(await screen.findByText('Warden')).toBeInTheDocument();
  });
});

describe('a chained profile', () => {
  it('offers a way back to the profile it was opened from', async () => {
    const harness = renderContainer({ url: `/?profile=${WARDEN}` });
    await harness.ready();

    await userEvent.click(await screen.findByRole('button', { name: 'Managed by You' }));

    await waitFor(() => expect(harness.search().profile).toBe(OPERATOR));
    expect(await screen.findByRole('button', { name: 'Back to Warden' })).toBeInTheDocument();
  });

  it('goes back to it, subject and all', async () => {
    const harness = renderContainer({ url: `/?profile=${WARDEN}` });
    await harness.ready();
    await userEvent.click(await screen.findByRole('button', { name: 'Managed by You' }));
    await waitFor(() => expect(harness.search().profile).toBe(OPERATOR));

    await userEvent.click(await screen.findByRole('button', { name: 'Back to Warden' }));

    await waitFor(() => expect(harness.search().profile).toBe(WARDEN));
    expect(screen.queryByRole('button', { name: /^Back to/ })).not.toBeInTheDocument();
  });

  it('does not offer a way back to somebody an unrelated link replaced it with', async () => {
    // Opening a different profile over the top of a chain is a new subject, not
    // a deeper one — a "back" to whoever was there before would be a lie.
    useProfileStore.setState({ sheetChain: ['agent-scout'] });
    const harness = renderContainer({ url: `/?profile=${WARDEN}` });
    await harness.ready();

    expect(await screen.findByText('Warden')).toBeInTheDocument();
    await waitFor(() => expect(useProfileStore.getState().sheetChain).toEqual([]));
    expect(screen.queryByRole('button', { name: /^Back to/ })).not.toBeInTheDocument();
  });
});
