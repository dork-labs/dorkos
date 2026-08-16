/**
 * @vitest-environment jsdom
 *
 * The docked home: the right-panel tab on a session (spec
 * `profile-unification` §1.6).
 *
 * The sheet is handed an identity; the dock is handed a DIRECTORY and has to
 * find one. So what is pinned here is the resolution chain and its three
 * failures — nobody picked an agent, the chain is still running, and it settled
 * on nobody — plus the two rules the panel it replaced had that must survive:
 * the ambient working directory is only honest on `/session`, and the agent you
 * were looking at stays on screen while the next one resolves.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
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
import { useProfileLeaveGuard } from '../model/profile-leave-guard';
import { ProfileScope } from '../model/profile-scope';
import { ProfileDock } from '../ui/ProfileDock';

/**
 * Stands in for an editor on a pushed page that has text nobody has saved,
 * inside the panel it belongs to — the guard counts per panel, so an editor
 * that named no panel would be counted against none.
 */
function UnsavedEditor({
  home = 'docked',
  memberId = WARDEN,
}: {
  home?: 'docked' | 'sheet';
  memberId?: string;
}) {
  return (
    <ProfileScope home={home} memberId={memberId}>
      <DirtyEditor />
    </ProfileScope>
  );
}

function DirtyEditor() {
  useProfileLeaveGuard(true);
  return null;
}

const WARDEN_PATH = '/Users/dorian/agents/warden';
const WARDEN = 'agent-warden';
const SCOUT_PATH = '/Users/dorian/agents/scout';

/** The fleet as `GET /api/mesh/agent-paths` returns it. */
const FLEET = [
  { id: WARDEN, name: 'Warden', projectPath: WARDEN_PATH },
  { id: 'agent-scout', name: 'Scout', projectPath: SCOUT_PATH },
];

const testSearchSchema = mergeDialogSearch(z.object({}));
const HookSlotContext = createContext<ReactNode>(null);

function HookSlot() {
  return <>{useContext(HookSlotContext)}</>;
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

/**
 * Mount the dock under a real router and a mock transport — no hook stubs, so
 * the resolution chain under test is the one that runs in the app.
 */
function renderDock({
  url = '/session',
  fleet = FLEET,
  pendingFleet = false,
  unsaved = false,
}: {
  url?: string;
  fleet?: typeof FLEET;
  /** Leave the path → id read in flight, the one state that is a skeleton. */
  pendingFleet?: boolean;
  /** Mount an editor holding unsaved text, in the panel named here. */
  unsaved?: false | { home: 'docked' | 'sheet'; memberId?: string };
} = {}) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const makeRoute = (path: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      validateSearch: zodValidator(testSearchSchema.extend({ dir: z.string().optional() })),
      component: HookSlot,
    });
  const router = createRouter({
    routeTree: rootRoute.addChildren([makeRoute('/'), makeRoute('/session')]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });

  const transport = createMockTransport({
    getTeamRoster: vi.fn().mockResolvedValue({ members: MOCK_TEAM_ROSTER }),
    listMeshAgentPaths: pendingFleet
      ? vi.fn().mockReturnValue(new Promise(() => {}))
      : vi.fn().mockResolvedValue({ agents: fleet }),
    getAgentByPath: vi.fn().mockResolvedValue(null),
    listMemberRooms: vi.fn().mockResolvedValue({ rooms: [] }),
  } as Partial<Transport>);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  const view = render(
    <HookSlotContext.Provider
      value={
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>
            <TooltipProvider>
              <ProfileDock />
              {unsaved && <UnsavedEditor home={unsaved.home} memberId={unsaved.memberId} />}
            </TooltipProvider>
          </TransportProvider>
        </QueryClientProvider>
      }
    >
      <RouterProvider router={router} />
    </HookSlotContext.Provider>
  );

  return {
    ...view,
    ready: () => waitFor(() => expect(router.state.status).toBe('idle')),
  };
}

/** The profile panel, if one is drawn. */
const panel = () => document.body.querySelector('[data-slot="profile"]');

beforeEach(() => {
  vi.clearAllMocks();
  useProfileStore.setState({ dockedEntries: {}, sheetChain: [] });
  useAppStore.setState({
    selectedCwd: null,
    explicitAgentPath: null,
    rightPanelOpen: true,
    activeRightPanelTab: 'profile',
    rightPanelLayoutKey: null,
    requestedRightPanel: null,
  });
  localStorage.clear();
});

afterEach(cleanup);

describe('which agent the panel is pointed at', () => {
  it('says so plainly when nobody has picked one', async () => {
    const harness = renderDock({ url: '/' });
    await harness.ready();

    expect(await screen.findByText('No agent selected')).toBeInTheDocument();
  });

  it('profiles the session’s own agent on /session', async () => {
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    const harness = renderDock();
    await harness.ready();

    expect(await screen.findByText('Warden')).toBeInTheDocument();
    expect(panel()?.getAttribute('data-home')).toBe('docked');
    expect(panel()?.getAttribute('data-member-id')).toBe(WARDEN);
  });

  it('never resolves the ambient working directory off /session', async () => {
    // Off a session, `selectedCwd` is the server's startup directory — nobody
    // picked it. Profiling it would put a stranger in the panel.
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    const harness = renderDock({ url: '/' });
    await harness.ready();

    expect(await screen.findByText('No agent selected')).toBeInTheDocument();
  });

  it('does profile an agent that WAS explicitly opened, on any route', async () => {
    useAppStore.setState({ selectedCwd: null, explicitAgentPath: WARDEN_PATH });
    const harness = renderDock({ url: '/' });
    await harness.ready();

    expect(await screen.findByText('Warden')).toBeInTheDocument();
  });

  it('prefers the explicitly opened agent over the session’s own', async () => {
    useAppStore.setState({ selectedCwd: WARDEN_PATH, explicitAgentPath: SCOUT_PATH });
    const harness = renderDock();
    await harness.ready();

    expect(await screen.findByText('Scout')).toBeInTheDocument();
  });
});

describe('when the chain cannot finish', () => {
  it('waits on a skeleton rather than guessing, while it is still running', async () => {
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    const harness = renderDock({ pendingFleet: true });
    await harness.ready();

    expect(document.body.querySelector('[data-slot="profile-dock-skeleton"]')).not.toBeNull();
    expect(screen.queryByText('Agent not found')).not.toBeInTheDocument();
  });

  it('says the agent is not here once every read has answered with nothing', async () => {
    useAppStore.setState({ selectedCwd: '/repo/not-an-agent' });
    const harness = renderDock({ fleet: [] });
    await harness.ready();

    expect(await screen.findByText('Agent not found')).toBeInTheDocument();
    expect(await screen.findByText('/repo/not-an-agent')).toBeInTheDocument();
  });

  it('switches straight to the next agent, with no skeleton in between', async () => {
    // Both reads are shared caches, so a switch resolves out of data already in
    // hand. The panel this replaced had to hold the old agent painted through a per-agent
    // manifest fetch; there is nothing here to paint over.
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    const harness = renderDock();
    await harness.ready();
    expect(await screen.findByText('Warden')).toBeInTheDocument();

    useAppStore.setState({ selectedCwd: SCOUT_PATH });

    expect(await screen.findByText('Scout')).toBeInTheDocument();
    expect(document.body.querySelector('[data-slot="profile-dock-skeleton"]')).toBeNull();
  });

  it('goes back to "not found" when the panel is pointed somewhere dead', async () => {
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    const harness = renderDock();
    await harness.ready();
    expect(await screen.findByText('Warden')).toBeInTheDocument();

    useAppStore.setState({ selectedCwd: '/repo/gone' });

    expect(await screen.findByText('Agent not found')).toBeInTheDocument();
  });
});

describe('the stack, and how long it lasts', () => {
  it('opens on the page a deep link seeded, and can come back off it', async () => {
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    useProfileStore.setState({
      dockedEntries: { [WARDEN_PATH]: [{ kind: 'page', page: 'rooms' }] },
    });
    const harness = renderDock();
    await harness.ready();

    expect(await screen.findByRole('heading', { name: 'Rooms' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back to profile' }));

    await waitFor(() => expect(useProfileStore.getState().dockedEntries[WARDEN_PATH]).toEqual([]));
  });

  it('survives the tab flip that unmounts it, while the panel stays open', async () => {
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    useProfileStore.setState({
      dockedEntries: { [WARDEN_PATH]: [{ kind: 'page', page: 'rooms' }] },
    });
    const harness = renderDock();
    await harness.ready();
    expect(await screen.findByRole('heading', { name: 'Rooms' })).toBeInTheDocument();

    // Flipping to Files drops this component; the panel itself is still open.
    cleanup();

    expect(useProfileStore.getState().dockedEntries[WARDEN_PATH]).toEqual([
      { kind: 'page', page: 'rooms' },
    ]);
  });

  it('is dropped when the panel closes, so a fresh open lands on the root', async () => {
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    useProfileStore.setState({
      dockedEntries: { [WARDEN_PATH]: [{ kind: 'page', page: 'rooms' }] },
    });
    const harness = renderDock();
    await harness.ready();
    expect(await screen.findByRole('heading', { name: 'Rooms' })).toBeInTheDocument();

    useAppStore.getState().setRightPanelOpen(false);

    await waitFor(() =>
      expect(useProfileStore.getState().dockedEntries[WARDEN_PATH] ?? []).toEqual([])
    );
  });
});

describe('a link naming an agent other than the session’s', () => {
  it('opens the panel on the LINK’s agent, against the session agent’s closed layout', async () => {
    // `/session?dir=<Warden>&panel=profile&agentPath=<Scout>`. The session binds
    // Warden's layout — closed — while the panel is filled by Scout's profile.
    // A shape that spent the mark at that bind closed the panel the link had
    // just opened and cleared its subject with it, so the link opened nothing.
    localStorage.setItem(
      'dorkos-right-panel-layouts',
      JSON.stringify({ [WARDEN_PATH]: { open: false, activeTab: 'pulse', accessedAt: 1 } })
    );
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    useProfileStore.getState().openProfileDockedFromLink(SCOUT_PATH, 'rooms');

    const harness = renderDock();
    await harness.ready();

    // The session's own bind, as `useRightPanelLayoutPersistence` makes it.
    useAppStore.getState().loadRightPanelForAgent(WARDEN_PATH, WARDEN_PATH);

    expect(await screen.findByText('Scout')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Rooms' })).toBeInTheDocument();
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
    expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
  });

  it('lets go of a link whose agent this install does not have', async () => {
    // Nothing binds an agent whose session you are not in, so without the dock
    // reporting it the mark would outrank layouts — and its explicit-pick latch
    // would hold the panel on a dead directory — for the rest of the session.
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    useProfileStore.getState().openProfileDockedFromLink('/repo/never-existed');

    const harness = renderDock();
    await harness.ready();

    await waitFor(() => expect(useAppStore.getState().requestedRightPanel).toBeNull());
    expect(useAppStore.getState().explicitAgentPath).toBeNull();
    // And with the latch gone the panel falls back to the session's own agent,
    // which is a better ending than "Agent not found" for the rest of the
    // session over a directory nothing answers to.
    expect(await screen.findByText('Warden')).toBeInTheDocument();
  });

  it('keeps holding a link whose agent is still resolving', async () => {
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    useProfileStore.getState().openProfileDockedFromLink(SCOUT_PATH, 'rooms');

    const harness = renderDock({ pendingFleet: true });
    await harness.ready();

    expect(useAppStore.getState().requestedRightPanel).not.toBeNull();
    expect(useAppStore.getState().explicitAgentPath).toBe(SCOUT_PATH);
  });
});

describe('closing the panel over unsaved text', () => {
  it('asks before throwing away what is on a pushed page', async () => {
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    useProfileStore.setState({
      dockedEntries: { [WARDEN_PATH]: [{ kind: 'page', page: 'rooms' }] },
    });
    const harness = renderDock({ unsaved: { home: 'docked' } });
    await harness.ready();
    expect(await screen.findByRole('heading', { name: 'Rooms' })).toBeInTheDocument();

    // The toggle, Escape, a drag to the edge and ⌘⇧A all arrive as this.
    useAppStore.getState().setRightPanelOpen(false);

    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
    // And nothing is thrown away while the question is still on screen.
    expect(useProfileStore.getState().dockedEntries[WARDEN_PATH]).toEqual([
      { kind: 'page', page: 'rooms' },
    ]);
  });

  it('puts the panel back when you keep editing', async () => {
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    useProfileStore.setState({
      dockedEntries: { [WARDEN_PATH]: [{ kind: 'page', page: 'rooms' }] },
    });
    const harness = renderDock({ unsaved: { home: 'docked' } });
    await harness.ready();
    expect(await screen.findByRole('heading', { name: 'Rooms' })).toBeInTheDocument();
    useAppStore.getState().setRightPanelOpen(false);
    await screen.findByText('Discard your changes?');

    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    await waitFor(() => expect(useAppStore.getState().rightPanelOpen).toBe(true));
    expect(useProfileStore.getState().dockedEntries[WARDEN_PATH]).toEqual([
      { kind: 'page', page: 'rooms' },
    ]);
  });

  it('lets the close stand when you discard', async () => {
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    useProfileStore.setState({
      dockedEntries: { [WARDEN_PATH]: [{ kind: 'page', page: 'rooms' }] },
    });
    const harness = renderDock({ unsaved: { home: 'docked' } });
    await harness.ready();
    expect(await screen.findByRole('heading', { name: 'Rooms' })).toBeInTheDocument();
    useAppStore.getState().setRightPanelOpen(false);
    await screen.findByText('Discard your changes?');

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() =>
      expect(useProfileStore.getState().dockedEntries[WARDEN_PATH] ?? []).toEqual([])
    );
    expect(useAppStore.getState().rightPanelOpen).toBe(false);
  });

  it('asks nothing about a sheet’s unsaved text — that is not this panel’s', async () => {
    // Both homes are on screen at once on `/session`: the docked profile of the
    // agent you are in, and a sheet over it for somebody else. One global count
    // let a half-written SOUL.md in the sheet refuse to close the panel, which
    // is a confirmation about work that is not in the thing you are closing.
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    useProfileStore.setState({
      dockedEntries: { [WARDEN_PATH]: [{ kind: 'page', page: 'rooms' }] },
    });
    const harness = renderDock({ unsaved: { home: 'sheet', memberId: 'person-dorian' } });
    await harness.ready();
    expect(await screen.findByRole('heading', { name: 'Rooms' })).toBeInTheDocument();

    useAppStore.getState().setRightPanelOpen(false);

    await waitFor(() =>
      expect(useProfileStore.getState().dockedEntries[WARDEN_PATH] ?? []).toEqual([])
    );
    expect(screen.queryByText('Discard your changes?')).not.toBeInTheDocument();
  });

  it('asks nothing when there is nothing unsaved', async () => {
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    useProfileStore.setState({
      dockedEntries: { [WARDEN_PATH]: [{ kind: 'page', page: 'rooms' }] },
    });
    const harness = renderDock();
    await harness.ready();
    expect(await screen.findByRole('heading', { name: 'Rooms' })).toBeInTheDocument();

    useAppStore.getState().setRightPanelOpen(false);

    await waitFor(() =>
      expect(useProfileStore.getState().dockedEntries[WARDEN_PATH] ?? []).toEqual([])
    );
    expect(screen.queryByText('Discard your changes?')).not.toBeInTheDocument();
  });
});

describe('a chained profile in the panel', () => {
  it('shows the owner, and a way back to the agent underneath', async () => {
    useAppStore.setState({ selectedCwd: WARDEN_PATH });
    const harness = renderDock();
    await harness.ready();
    expect(await screen.findByText('Warden')).toBeInTheDocument();

    await userEvent.click(await screen.findByRole('button', { name: 'Managed by You' }));

    // The owner's own profile is now the subject — and the panel has no browser
    // Back button, so the bar is the only way out.
    await waitFor(() => expect(panel()?.getAttribute('data-member-id')).toBe('person-dorian'));
    const back = await screen.findByRole('button', { name: 'Back to Warden' });

    await userEvent.click(back);

    await waitFor(() => expect(panel()?.getAttribute('data-member-id')).toBe(WARDEN));
  });
});
