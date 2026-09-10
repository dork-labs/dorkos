/**
 * @vitest-environment jsdom
 *
 * "Open session", pressed from inside a room, lands on the session that room is
 * running (DOR-1974, reported as FB-14).
 *
 * **Every door from a room into an agent's conversation is this one button.** A
 * mention pill, the face beside a message and a row in the room's member list
 * all open `?profile=<id>` and stop there; the profile's own button is the only
 * thing that navigates. So this file is the whole of the fix's behaviour, and
 * the paths are named here rather than tested four times over.
 *
 * **What made it wrong is worth stating, because it is not a race.**
 * `/session?dir=<path>` resolves the directory's most recent human
 * CONVERSATION, and `partitionSessionsByOrigin` files a room turn (origin
 * `room`) in the automated bucket deliberately. So the directory route could
 * never land on the room's session — and for an agent that has only ever worked
 * in rooms it minted a brand-new empty one instead.
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
import type { Transport } from '@dorkos/shared/transport';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import {
  agentAuthorRef,
  type RoomSessionBinding,
  type RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { mergeDialogSearch, TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { useInteractionStore } from '@/layers/entities/interactions';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { ProfileView } from '../ui/ProfileView';
import { profileStack } from '../model/profile-stack';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const ROOM_ID = 'room-general';
const OWNER = MOCK_TEAM_ROSTER.find((m) => m.id === 'person-dorian')!;
const WARDEN = MOCK_TEAM_ROSTER.find((m) => m.id === 'agent-warden')!;
const SCOUT = MOCK_TEAM_ROSTER.find((m) => m.id === 'agent-scout')!;
const WARDEN_PATH = WARDEN.agent!.projectPath!;
const SCOUT_PATH = SCOUT.agent!.projectPath!;
const ROSTER: TeamMember[] = [OWNER, WARDEN, SCOUT];

/** One agent's row on a room's roster, keyed the way the server keys one. */
function agentMember(authorId: string, agentPath: string, displayName: string) {
  return {
    roomId: ROOM_ID,
    authorId,
    responseMode: 'engaged' as const,
    joinedAt: '2026-09-01T00:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    origin: 'local' as const,
    author: {
      id: authorId,
      kind: 'agent' as const,
      displayName,
      agentRef: agentAuthorRef(agentPath),
      handle: displayName.toLowerCase(),
    },
  };
}

const ROOM = {
  id: ROOM_ID,
  kind: 'channel',
  slug: 'general',
  title: 'General',
  members: [
    agentMember('author-warden', WARDEN_PATH, 'Warden'),
    agentMember('author-scout', SCOUT_PATH, 'Scout'),
  ],
  viewerAuthorId: 'author-dorian',
  reactionFrequents: [],
} as unknown as RoomWithRoster;

/** The search params the two routes under test accept. */
const searchSchema = mergeDialogSearch(
  z.object({
    id: z.string().optional(),
    session: z.string().optional(),
    dir: z.string().optional(),
  })
);

/**
 * Mount the profile on a real route, so the assertion is the URL the press
 * produced rather than a spy on a mocked navigator.
 */
function mountProfile(
  member: TeamMember,
  options: {
    at: string;
    bindings?: RoomSessionBinding[];
    listRoomSessions?: Transport['listRoomSessions'];
  }
) {
  const listRoomSessions: Transport['listRoomSessions'] =
    options.listRoomSessions ??
    vi.fn<Transport['listRoomSessions']>().mockResolvedValue({
      bindings: options.bindings ?? [],
    });
  const transport = createMockTransport({
    getAgentByPath: vi.fn().mockResolvedValue(null),
    getRoom: vi.fn().mockResolvedValue(ROOM),
    listRoomSessions,
    listRooms: vi.fn().mockResolvedValue([]),
    reportError: vi.fn().mockResolvedValue(undefined),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  function Subject() {
    return (
      <ProfileView
        member={member}
        roster={ROSTER}
        home="sheet"
        stack={profileStack(member.id)}
        onPush={vi.fn()}
        onPop={vi.fn()}
      />
    );
  }

  const rootRoute = createRootRoute({ staticData: { header: null }, component: () => <Outlet /> });
  const routeAt = (path: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      staticData: { header: null },
      validateSearch: zodValidator(searchSchema),
      component: Subject,
    });
  const router = createRouter({
    routeTree: rootRoute.addChildren([routeAt('/'), routeAt('/channels'), routeAt('/session')]),
    history: createMemoryHistory({ initialEntries: [options.at] }),
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
    router,
    transport,
    listRoomSessions,
    where: () => ({
      pathname: router.state.location.pathname,
      search: router.state.location.search as { session?: string; dir?: string },
    }),
  };
}

/** Press the header's one navigating control. */
async function pressOpenSession() {
  const button = await screen.findByRole('button', { name: 'Open session' });
  await userEvent.click(button);
}

beforeEach(() => {
  vi.clearAllMocks();
  useInteractionStore.getState().reset();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(cleanup);

describe('Open session, from inside a room', () => {
  it('lands on the session the room bound for that agent', async () => {
    const view = mountProfile(WARDEN, {
      at: `/channels?id=${ROOM_ID}`,
      bindings: [
        { authorId: 'author-scout', sessionId: 'scout-in-general' },
        { authorId: 'author-warden', sessionId: 'warden-in-general' },
      ],
    });

    await pressOpenSession();

    // Red against the unfixed code, which navigated to `/session?dir=<path>`
    // and let the loader pick the newest HUMAN conversation — a bucket a room
    // turn is deliberately never in.
    await waitFor(() => {
      expect(view.where()).toEqual({
        pathname: '/session',
        search: { session: 'warden-in-general' },
      });
    });
  });

  it('keeps two agents in the same room apart', async () => {
    const view = mountProfile(SCOUT, {
      at: `/channels?id=${ROOM_ID}`,
      bindings: [
        { authorId: 'author-warden', sessionId: 'warden-in-general' },
        { authorId: 'author-scout', sessionId: 'scout-in-general' },
      ],
    });

    await pressOpenSession();

    await waitFor(() => {
      expect(view.where().search.session).toBe('scout-in-general');
    });
  });

  it('carries no directory with the room session', async () => {
    // A room turn can run in the ROOM's worktree rather than the agent's own
    // folder, and every per-session read is addressed by id AND directory — so
    // pairing the room's session with the agent's path is how a real
    // conversation reads as an empty one (DOR-1836). The server resolves the
    // session's own directory when none is named.
    const view = mountProfile(WARDEN, {
      at: `/channels?id=${ROOM_ID}`,
      bindings: [{ authorId: 'author-warden', sessionId: 'warden-in-general' }],
    });

    await pressOpenSession();

    await waitFor(() => expect(view.where().search.session).toBe('warden-in-general'));
    expect(view.where().search.dir).toBeUndefined();
  });

  it('falls back to the directory when the room has no binding for that agent yet', async () => {
    // A room binds a session on the first TURN, not at join. An agent that has
    // not spoken here has no session to open, and the honest destination is the
    // one every other surface uses.
    const view = mountProfile(WARDEN, {
      at: `/channels?id=${ROOM_ID}`,
      bindings: [{ authorId: 'author-scout', sessionId: 'scout-in-general' }],
    });

    await pressOpenSession();

    await waitFor(() => {
      expect(view.where()).toEqual({ pathname: '/session', search: { dir: WARDEN_PATH } });
    });
  });

  it('falls back to the directory when the bindings read fails', async () => {
    const view = mountProfile(WARDEN, {
      at: `/channels?id=${ROOM_ID}`,
      listRoomSessions: vi.fn().mockRejectedValue(new Error('nope')),
    });

    await pressOpenSession();

    await waitFor(() => {
      expect(view.where()).toEqual({ pathname: '/session', search: { dir: WARDEN_PATH } });
    });
  });
});

describe('Open session, from anywhere else', () => {
  it('still opens the directory, and asks no room anything', async () => {
    // The docked profile and every non-room route resolve exactly as they did.
    const view = mountProfile(WARDEN, { at: '/session?dir=/somewhere/else' });

    await pressOpenSession();

    await waitFor(() => {
      expect(view.where()).toEqual({ pathname: '/session', search: { dir: WARDEN_PATH } });
    });
    expect(view.listRoomSessions).not.toHaveBeenCalled();
    expect(view.transport.getRoom).not.toHaveBeenCalled();
  });
});
