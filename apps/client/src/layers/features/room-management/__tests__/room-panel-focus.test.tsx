// @vitest-environment jsdom
/**
 * The one door into the room panel, and the room each press is about.
 *
 * `openRoomPanel` is what every entry point calls (spec `one-bar-header` §3.6),
 * so what it writes IS the contract between three widgets and a panel none of
 * them can see. The panel half — which requests it answers and which it lets go
 * — is asserted here through the real component, because the guard only matters
 * in the moment two rooms are in play.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { REACTION_FREQUENTS_DEFAULT, type RoomWithRoster } from '@dorkos/shared/room-schemas';
import { TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { openRoomPanel, ROOM_PANEL_ID, useRoomPanelFocusStore } from '../model/room-panel-focus';
import { RoomPanel } from '../ui/RoomPanel';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../model/use-agent-picker-candidates', () => ({
  useAgentPickerCandidates: () => ({
    candidates: [{ agentPath: '/repo/ana', displayName: 'Ana', visual: null, description: null }],
    isLoading: false,
    isError: false,
    retry: vi.fn(),
  }),
}));

/** The route the panel resolves its room from, per test. */
const route = { pathname: '/channels', search: {} as { id?: string } };
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useSafePathname: () => route.pathname,
    useSafeSearch: () => route.search,
    useProfileDeepLink: () => ({ isOpen: false, memberId: null, open: vi.fn(), close: vi.fn() }),
  };
});

function roomNamed(id: string, title: string): RoomWithRoster {
  return {
    id,
    kind: 'channel',
    slug: title.toLowerCase(),
    title,
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-08-22T09:00:00.000Z',
    lastActivityAt: '2026-08-22T09:00:00.000Z',
    unreadCount: 0,
    participants: null,
    // An agent is in here on purpose: an EMPTY room opens its own picker (see
    // `RoomPanelBody`), which would make "the picker is shut" true or false for
    // a reason that has nothing to do with the request under test.
    members: [
      {
        roomId: id,
        authorId: 'me',
        responseMode: 'always',
        joinedAt: '2026-08-22T09:00:00.000Z',
        joinedSeq: 0,
        lastReadSeq: 0,
        origin: 'local',
        author: { id: 'me', kind: 'human', displayName: 'You', handle: null },
      },
      {
        roomId: id,
        authorId: 'author-ana',
        responseMode: 'mention-only',
        joinedAt: '2026-08-22T09:00:00.000Z',
        joinedSeq: 1,
        lastReadSeq: 0,
        origin: 'local',
        author: {
          id: 'author-ana',
          kind: 'agent',
          displayName: 'Ana',
          handle: 'ana',
          agentRef: 'ref-ana',
        },
      },
    ],
    viewerAuthorId: 'me',
    reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
  } as unknown as RoomWithRoster;
}

/** Mount the ROUTE-resolving panel — the component the contribution mounts. */
function renderPanel(transport?: Transport) {
  const port =
    transport ??
    createMockTransport({
      getRoom: vi.fn((id: string) => Promise.resolve(roomNamed(id, 'General'))),
    });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(<RoomPanel />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={port}>
          <TooltipProvider>{children}</TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    ),
  });
}

beforeEach(() => {
  route.pathname = '/channels';
  route.search = { id: 'room-1' };
  useRoomPanelFocusStore.setState({ request: null });
  useAppStore.setState({ rightPanelOpen: false, activeRightPanelTab: null });
});
afterEach(cleanup);

describe('openRoomPanel', () => {
  it('opens the panel on the Room tab, naming the part and the room', () => {
    openRoomPanel('add', 'room-7');

    expect(useAppStore.getState().rightPanelOpen).toBe(true);
    expect(useAppStore.getState().activeRightPanelTab).toBe(ROOM_PANEL_ID);
    expect(useRoomPanelFocusStore.getState().request).toEqual({ focus: 'add', roomId: 'room-7' });
  });

  it('makes a repeated press a new request, so the panel acts on it again', () => {
    // The same focus about the same room, pressed twice — collapsing the picker
    // and asking for it again. An effect only re-runs for a value that changed,
    // so a request that was equal AND identical would be silently ignored the
    // second time. Red if `ask` ever starts reusing the object.
    openRoomPanel('add', 'room-7');
    const first = useRoomPanelFocusStore.getState().request;
    openRoomPanel('add', 'room-7');

    expect(useRoomPanelFocusStore.getState().request).not.toBe(first);
    expect(useRoomPanelFocusStore.getState().request).toEqual(first);
  });
});

describe('the panel answering a request', () => {
  it('answers a press about the room it is showing', async () => {
    useRoomPanelFocusStore.setState({ request: { focus: 'add', roomId: 'room-1' } });
    renderPanel();

    // 'add' opens the picker, which is the visible half of the request being
    // taken — and the store is emptied, so a remount cannot act on it twice.
    expect(await screen.findByRole('combobox', { name: 'Search agents' })).toBeInTheDocument();
    expect(useRoomPanelFocusStore.getState().request).toBeNull();
  });

  it('leaves a press about a DIFFERENT room alone while that room is on screen', async () => {
    // The sidebar's menu navigates first and the panel follows. Until it has,
    // the panel on screen is still the room being left — and it must not
    // swallow a request meant for the one arriving, or the picker springs open
    // in the wrong room and never opens in the right one.
    //
    // The press lands on an ALREADY-MOUNTED panel, which is what makes this the
    // real race rather than the stale-request case below: a panel that is
    // merely sitting there is never the one a fresh press is about.
    renderPanel();
    await screen.findByRole('region', { name: 'Current members' });
    act(() => {
      useRoomPanelFocusStore.setState({ request: { focus: 'add', roomId: 'room-2' } });
    });
    expect(screen.queryByRole('combobox', { name: 'Search agents' })).not.toBeInTheDocument();
    expect(useRoomPanelFocusStore.getState().request).toEqual({ focus: 'add', roomId: 'room-2' });
  });

  it('forgets a press whose room never opened, once another panel does', async () => {
    // The failure this closes: a press for a room that never arrives — the
    // navigation failed, the room was gone — used to sit in the store forever,
    // and the next room whose panel opened sprang its picker open for it.
    useRoomPanelFocusStore.setState({ request: { focus: 'add', roomId: 'gone' } });
    renderPanel();

    await waitFor(() => expect(useRoomPanelFocusStore.getState().request).toBeNull());
    expect(screen.queryByRole('combobox', { name: 'Search agents' })).not.toBeInTheDocument();
  });
});

describe('the panel resolving its own room', () => {
  it('says so plainly when the route names a room that is not there', async () => {
    // Spec §5 case 6, said in the panel as well as on the page. The read fails,
    // and the honest answer is about the ROOM — not "couldn't read who is in
    // here" under a name that never arrives.
    renderPanel(
      createMockTransport({ getRoom: vi.fn().mockRejectedValue(new Error('404 Not Found')) })
    );

    expect(await screen.findByText("That room isn't here")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Current members' })).not.toBeInTheDocument();
  });

  it('offers to read again rather than asking the reader to close and reopen', async () => {
    const getRoom = vi.fn().mockRejectedValue(new Error('offline'));
    renderPanel(createMockTransport({ getRoom }));

    const retry = await screen.findByRole('button', { name: 'Try again' });
    const before = getRoom.mock.calls.length;
    retry.click();

    await waitFor(() => expect(getRoom.mock.calls.length).toBeGreaterThan(before));
  });

  it('has nothing to describe on a route that shows no room', () => {
    route.pathname = '/session';
    renderPanel();

    expect(screen.getByText('No room open')).toBeInTheDocument();
  });
});
