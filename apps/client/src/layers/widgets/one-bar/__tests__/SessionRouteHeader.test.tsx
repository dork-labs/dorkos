/**
 * @vitest-environment jsdom
 *
 * The `/session` bar under the DM view (DOR-3074): the session bar with the
 * experiment off, the DM bar on an agent's Direct chat, and the session bar
 * saying it is behind the DM on `?view=session`, each on a real route so the
 * assertion is the URL a press produced.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
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
  useSearch,
} from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { sessionSearchSchema } from '@/layers/shared/lib';
import { SessionRouteHeader } from '../ui/SessionRouteHeader';
import { BarHarness } from './bar-harness';

vi.mock('@/layers/widgets/inbox-bell', () => ({ InboxBell: () => null }));
vi.mock('@/layers/features/right-panel', () => ({ RightPanelToggle: () => null }));
vi.mock('@/layers/features/status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/features/status')>()),
  AccountBadge: () => <span data-testid="account-badge" />,
  useSessionDiagnostics: () => ({ contextPercent: 63.6 }),
}));
const working = vi.hoisted(() => ({ current: false }));
vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useSessionStatusSignals: () => ({ working: working.current }),
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  working.current = false;
});

const SESSION = 'scout-direct';
const SCOUT_PATH = '/agents/scout';

const SCOUT_MEMBER = {
  id: 'member-scout',
  kind: 'agent',
  displayName: 'Scout',
  handle: 'scout',
  isSelf: false,
  ownerId: null,
  origin: 'local',
  agent: {
    manifestId: 'scout-manifest',
    runtime: 'claude-code',
    healthStatus: 'active',
    recentlyActive: true,
    projectPath: SCOUT_PATH,
    activity: { working: null, lastActiveAt: null },
    isDefault: false,
    isSystem: false,
    registeredAt: '2026-09-01T00:00:00.000Z',
  },
} as unknown as TeamMember;

/** A channel this person is in, as the room list carries it. */
function channel(id: string, member = true): RoomSummary {
  return {
    id,
    kind: 'channel',
    slug: id,
    title: id,
    archived: false,
    unreadCount: member ? 0 : null,
  } as RoomSummary;
}

/** Mount the bar on a real `/session` route at `at`. */
function mountBar(
  at: string,
  options: { dmView?: boolean; showSessions?: boolean; lookupPending?: boolean } = {}
) {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      experiments: [
        {
          key: 'ui.dmView',
          title: 'Chats with one agent read like a DM',
          description: '',
          enabled: options.dmView ?? true,
          lockedByEnv: false,
        },
      ],
      ui: { showSessions: options.showSessions ?? false },
    }),
    findDirectChat: options.lookupPending
      ? vi.fn().mockReturnValue(new Promise(() => {}))
      : vi.fn().mockResolvedValue({
          sessionId: SESSION,
          sessionIds: [SESSION],
          roomId: 'dm-scout',
          agentPath: SCOUT_PATH,
        }),
    getAgentByPath: vi.fn().mockResolvedValue({
      id: 'scout-manifest',
      name: 'scout',
      displayName: 'Scout',
      description: 'Reviews pull requests',
    }),
    getTeamRoster: vi.fn().mockResolvedValue({ members: [SCOUT_MEMBER] }),
    listMemberRooms: vi.fn().mockResolvedValue({
      rooms: ['launch', 'design', 'ops', 'growth', 'private'].map((id) => ({
        id,
        name: id,
        slug: id,
        kind: 'channel',
        memberCount: 3,
      })),
    }),
    listRooms: vi
      .fn()
      .mockResolvedValue([
        channel('launch'),
        channel('design'),
        channel('ops'),
        channel('growth'),
        channel('private', false),
      ]),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  function Bar() {
    const search = useSearch({ strict: false }) as { session?: string };
    return (
      <BarHarness sessionId={search.session} agentName="Scout">
        <SessionRouteHeader />
      </BarHarness>
    );
  }
  const rootRoute = createRootRoute({ staticData: { header: null }, component: () => <Outlet /> });
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/session',
    staticData: { header: null },
    validateSearch: zodValidator(sessionSearchSchema),
    component: Bar,
  });
  const channels = createRoute({
    getParentRoute: () => rootRoute,
    path: '/channels',
    staticData: { header: null },
    component: () => <div data-testid="channels-page" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route, channels]),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  render(
    <Wrapper>
      <RouterProvider router={router} />
    </Wrapper>
  );
  return { router, transport };
}

describe('SessionRouteHeader', () => {
  it('is the session bar, and asks nothing new, with the DM view off', async () => {
    const { transport } = mountBar(`/session?session=${SESSION}`, { dmView: false });

    expect(await screen.findByTestId('session-agent-name')).toHaveTextContent('Scout');
    expect(screen.queryByTestId('dm-header-identity')).not.toBeInTheDocument();
    // The Direct chat question is the session bar's own (its "Direct" title),
    // and the DM view asks the agent and the roster nothing on top of it.
    expect(transport.getTeamRoster).not.toHaveBeenCalled();
  });

  it('draws a neutral bar, none of the session’s chrome, while it asks which chat this is', async () => {
    mountBar(`/session?session=${SESSION}`, { lookupPending: true });

    expect(await screen.findByTestId('session-bar-pending')).toHaveTextContent('Scout');
    expect(screen.queryByTestId('session-title')).not.toBeInTheDocument();
    expect(screen.queryByTestId('account-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dm-header-identity')).not.toBeInTheDocument();
  });

  it('draws the agent, its role and the channels you share on its Direct chat', async () => {
    mountBar(`/session?session=${SESSION}`);

    const identity = await screen.findByTestId('dm-header-identity');
    await waitFor(() => expect(identity).toHaveTextContent('Scout'));
    await waitFor(() => expect(identity).toHaveTextContent('Reviews pull requests'));
    const shared = await screen.findByTestId('dm-shared-channels');
    // Three named, the fourth counted, and the channel this person never
    // joined left out entirely.
    expect(shared).toHaveTextContent('Also in#launch,#design,#ops+1');
    expect(shared).not.toHaveTextContent('private');
    // The machinery stays behind Show sessions.
    expect(screen.queryByTestId('dm-session-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('account-badge')).not.toBeInTheDocument();
  });

  it('says the agent is working while it works', async () => {
    working.current = true;
    mountBar(`/session?session=${SESSION}`);

    const identity = await screen.findByTestId('dm-header-identity');
    await waitFor(() => expect(identity).toHaveTextContent('Working'));
    expect(identity).not.toHaveTextContent('Reviews pull requests');
  });

  it('links each shared channel to its room', async () => {
    const { router } = mountBar(`/session?session=${SESSION}`);

    await userEvent.click(await screen.findByRole('button', { name: '#design' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/channels'));
    expect(router.state.location.search).toEqual({ id: 'design' });
  });

  it('opens the session behind the DM from the chip, with Show sessions on', async () => {
    const { router } = mountBar(`/session?session=${SESSION}`, { showSessions: true });

    const chip = await screen.findByTestId('dm-session-chip');
    expect(chip).toHaveTextContent('Session· 64%');
    await userEvent.click(chip);

    await waitFor(() =>
      expect(router.state.location.search).toEqual({ session: SESSION, view: 'session' })
    );
    // The bar under it is the session bar, saying what it is behind.
    expect(await screen.findByTestId('session-behind-dm')).toHaveTextContent(
      'Session ·behind your DM with Scout'
    );
  });

  it('goes back to the DM from the session view, and Back returns to it too', async () => {
    const { router } = mountBar(`/session?session=${SESSION}&view=session`);

    await userEvent.click(await screen.findByRole('button', { name: 'behind your DM with Scout' }));

    await waitFor(() => expect(router.state.location.search).toEqual({ session: SESSION }));
    expect(await screen.findByTestId('dm-header-identity')).toBeInTheDocument();

    router.history.back();
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ session: SESSION, view: 'session' })
    );
  });
});
