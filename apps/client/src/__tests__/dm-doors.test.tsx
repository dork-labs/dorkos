/**
 * @vitest-environment jsdom
 *
 * Every door to an agent lands in the same DM (DOR-3074): with the DM view on,
 * the profile's Open chat, the card's Message and the ⌘K agent pick each open
 * the agent's one Direct chat, even from inside a room where that agent has a
 * session of its own. Each is pressed on a real route, so the assertion is the
 * URL the press produced.
 *
 * The sidebar's agent row and the New menu's one-agent message open the Direct
 * chat whatever the setting; their own suites hold that
 * (`DashboardSidebar.test.tsx`, `NewMenu.test.tsx`).
 */
import type { ReactNode } from 'react';
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
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { agentAuthorRef, type RoomWithRoster } from '@dorkos/shared/room-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { configKeys, mergeDialogSearch, TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { useInteractionStore } from '@/layers/entities/interactions';
import { ProfileView, profileStack } from '@/layers/features/profile';
import { AgentHoverCard } from '@/layers/features/direct-message';
import { usePaletteActions } from '@/layers/features/command-palette';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const ROOM_ID = 'room-general';
const OWNER = MOCK_TEAM_ROSTER.find((m) => m.id === 'person-dorian')!;
const WARDEN = MOCK_TEAM_ROSTER.find((m) => m.id === 'agent-warden')!;
const WARDEN_PATH = WARDEN.agent!.projectPath!;
const ROSTER: TeamMember[] = [OWNER, WARDEN];

const ROOM = {
  id: ROOM_ID,
  kind: 'channel',
  slug: 'general',
  title: 'General',
  members: [
    {
      roomId: ROOM_ID,
      authorId: 'author-warden',
      responseMode: 'engaged',
      joinedAt: '2026-09-01T00:00:00.000Z',
      joinedSeq: 0,
      lastReadSeq: 0,
      origin: 'local',
      author: {
        id: 'author-warden',
        kind: 'agent',
        displayName: 'Warden',
        agentRef: agentAuthorRef(WARDEN_PATH),
        handle: 'warden',
      },
    },
  ],
  viewerAuthorId: 'author-dorian',
  reactionFrequents: [],
} as unknown as RoomWithRoster;

/** The DM every door must land in. */
const THE_DM = { session: 'direct-chat', launchRef: 'test-location', draft: '1' };

/** Every door, side by side, the way a room page holds them. */
function Doors() {
  const actions = usePaletteActions(() => {});
  return (
    <>
      <ProfileView
        member={WARDEN}
        roster={ROSTER}
        home="sheet"
        stack={profileStack(WARDEN.id)}
        onPush={vi.fn()}
        onPop={vi.fn()}
      />
      <AgentHoverCard
        identity={{ kind: 'agent', displayName: 'Warden' }}
        agentPath={WARDEN_PATH}
        openOnClick
      >
        <span>Warden’s face</span>
      </AgentHoverCard>
      <button
        type="button"
        onClick={() =>
          actions.handleAgentSelect({ id: 'warden-mesh', projectPath: WARDEN_PATH } as never)
        }
      >
        Pick Warden in the palette
      </button>
    </>
  );
}

/** Mount the doors on a room page, with the DM view on. */
function mountDoors(options: { owner?: boolean } = {}) {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      experiments: [
        { key: 'ui.dmView', title: '', description: '', enabled: true, lockedByEnv: false },
      ],
      ui: { showSessions: false },
    }),
    getAgentByPath: vi.fn().mockResolvedValue(null),
    getRoom: vi.fn().mockResolvedValue(ROOM),
    // Warden HAS a session in this room: the doors must still open its DM.
    listRoomSessions: vi.fn().mockResolvedValue({
      bindings: [{ authorId: 'author-warden', sessionId: 'warden-in-general' }],
    }),
    listRooms: vi.fn().mockResolvedValue([]),
    reportError: vi.fn().mockResolvedValue(undefined),
    openDirectChat:
      options.owner === false
        ? vi.fn().mockRejectedValue(Object.assign(new Error('owner only'), { status: 403 }))
        : vi.fn().mockResolvedValue({
            sessionId: 'direct-chat',
            sessionIds: ['direct-chat'],
            roomId: 'dm-room',
            agentPath: WARDEN_PATH,
          }),
    // Anyone but the owner gets the agent's latest chat with them.
    listSessions: vi.fn().mockResolvedValue({
      sessions: [{ id: 'latest-with-warden', cwd: WARDEN_PATH, title: 'Hi' }],
    }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const searchSchema = mergeDialogSearch(
    z.object({
      id: z.string().optional(),
      session: z.string().optional(),
      launchRef: z.string().optional(),
      draft: z.string().optional(),
    })
  );
  const rootRoute = createRootRoute({ staticData: { header: null }, component: () => <Outlet /> });
  const routeAt = (path: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      staticData: { header: null },
      validateSearch: zodValidator(searchSchema),
      component: Doors,
    });
  const router = createRouter({
    routeTree: rootRoute.addChildren([routeAt('/channels'), routeAt('/session')]),
    history: createMemoryHistory({ initialEntries: [`/channels?id=${ROOM_ID}`] }),
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <TooltipProvider>{children}</TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    );
  }
  render(
    <Wrapper>
      <RouterProvider router={router} />
    </Wrapper>
  );
  return {
    transport,
    where: () => ({
      pathname: router.state.location.pathname,
      search: router.state.location.search,
    }),
    /** Wait until the app knows the DM view is on, as it does after boot. */
    ready: () =>
      waitFor(() => expect(queryClient.getQueryData(configKeys.current())).toBeDefined()),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useInteractionStore.getState().reset();
});

afterEach(cleanup);

describe('every door to an agent opens its DM, with the DM view on', () => {
  it('the profile’s Open chat, even from a room where it has a session', async () => {
    const view = mountDoors();
    await view.ready();

    await userEvent.click(await screen.findByRole('button', { name: 'Open chat' }));

    await waitFor(() => expect(view.where()).toEqual({ pathname: '/session', search: THE_DM }));
    expect(view.transport.openDirectChat).toHaveBeenCalledWith({ agentPath: WARDEN_PATH });
    expect(view.transport.listRoomSessions).not.toHaveBeenCalled();
  });

  it('the card’s Message, opened by a click on the face', async () => {
    const view = mountDoors();
    await view.ready();

    await userEvent.click(screen.getByText('Warden’s face'));
    await userEvent.click(await screen.findByRole('button', { name: 'Message' }));

    await waitFor(() => expect(view.where()).toEqual({ pathname: '/session', search: THE_DM }));
    expect(view.transport.openDirectChat).toHaveBeenCalledWith({ agentPath: WARDEN_PATH });
  });

  it('the agent picked in ⌘K, rather than its newest chat', async () => {
    const view = mountDoors();
    await view.ready();

    await userEvent.click(screen.getByRole('button', { name: 'Pick Warden in the palette' }));

    await waitFor(() => expect(view.where()).toEqual({ pathname: '/session', search: THE_DM }));
    expect(view.transport.openDirectChat).toHaveBeenCalledWith({ agentPath: WARDEN_PATH });
    await waitFor(() =>
      expect(Object.keys(useInteractionStore.getState().opened)).toContain(`agent:${WARDEN_PATH}`)
    );
  });
});

describe('every door, for anyone but the owner', () => {
  // Only the owner has Direct chats: the server refuses anyone else, and every
  // door then opens the agent's latest chat with them, never an error.
  const LATEST = { pathname: '/session', search: { session: 'latest-with-warden' } };

  it('the card’s Message', async () => {
    const view = mountDoors({ owner: false });
    await view.ready();

    await userEvent.click(screen.getByText('Warden’s face'));
    await userEvent.click(await screen.findByRole('button', { name: 'Message' }));

    await waitFor(() => expect(view.where()).toEqual(LATEST));
  });

  it('the agent picked in ⌘K', async () => {
    const view = mountDoors({ owner: false });
    await view.ready();

    await userEvent.click(screen.getByRole('button', { name: 'Pick Warden in the palette' }));

    await waitFor(() => expect(view.where()).toEqual(LATEST));
  });

  it('the profile’s Open chat', async () => {
    const view = mountDoors({ owner: false });
    await view.ready();

    await userEvent.click(await screen.findByRole('button', { name: 'Open chat' }));

    await waitFor(() => expect(view.where()).toEqual(LATEST));
  });
});
