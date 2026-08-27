// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { SidebarItemRef, SidebarPrefs } from '@dorkos/shared/config-schema';
import { SIDEBAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { agentAuthorRef, type AuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import { toast as mockToast } from 'sonner';
import { TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { configKeys, useSidebarPrefs } from '@/layers/entities/config';
import { useRoomWorkingStore } from '@/layers/entities/room';
import { TEAM_ROSTER_KEY } from '@/layers/entities/team';
import { ROOM_PANEL_ID, useRoomPanelFocusStore } from '@/layers/features/room-management';
import { RoomRow } from '../ui/rooms/RoomRow';
import type { SidebarItemVisual } from '../model/sidebar-item';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mockNavigate,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function channel(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'room-1',
    kind: 'channel',
    slug: 'general',
    title: 'General',
    topic: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-07-26T10:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    unreadCount: 0,
    participants: null,
    ...overrides,
  };
}

/** A one-to-one conversation with the agent living at `agentPath`. */
function oneToOne(agentPath: string): RoomSummary {
  const participants: AuthorRef[] = [
    { id: 'me', kind: 'human', displayName: 'You', handle: null },
    {
      id: 'a-ana',
      kind: 'agent',
      displayName: 'Ana',
      handle: null,
      agentRef: agentAuthorRef(agentPath),
    },
  ];
  return channel({
    id: 'dm-1',
    kind: 'dm',
    slug: null,
    title: 'Ana',
    participants,
  });
}

/** Mesh answers with the paths RoomRow maps a 1:1's `agentRef` back onto. */
const MESH_AGENTS = { agents: [{ projectPath: '/repo/ana' }, { projectPath: '/repo/bo' }] };

/**
 * A team roster whose one row is the viewer themselves — what `RoomRow` reads
 * to learn its own author id before it can offer "Leave".
 */
function selfTeamRoster() {
  return {
    members: [
      {
        id: 'me',
        kind: 'human' as const,
        displayName: 'You',
        handle: null,
        isSelf: true,
        ownerId: null,
        origin: 'local' as const,
      },
    ],
  };
}

/**
 * The one preferences subscription the real panel holds — `SidebarChrome`.
 *
 * Mounted here because the row no longer holds one (D8) and a write composes
 * onto whatever the config cache has: with no observer at all, `gcTime: 0`
 * collects a seeded cache before the click that reads it.
 */
function PrefsPrimer() {
  useSidebarPrefs();
  return null;
}

function renderRow(
  room: RoomSummary,
  opts: {
    transport?: Transport;
    viewAgentProfile?: (path: string) => () => void;
    /** The mark the sidebar's view model resolved for this room. */
    visual?: SidebarItemVisual;
    /** Asked for the inline group-create editor, carrying this room's reference. */
    onRequestNewGroup?: (ref: SidebarItemRef) => void;
    /** Whether this room is the one open on screen. Defaults to closed. */
    isActive?: boolean;
    /** Opening the room itself — what pressing the row does. */
    onSelect?: () => void;
    /**
     * Pre-seed the team roster cache with {@link selfTeamRoster} before the
     * first render, so `canLeave` is `true` from the very first paint instead
     * of racing the roster's own fetch. A test asserting what a room's OWN
     * shape withholds (a 1:1, #team) needs this — otherwise "no Leave" is
     * true for the wrong reason (the roster has not answered yet) and stays
     * true even if the room-shape gate is deleted, which a
     * `findByText('Archive channel')` wait does not catch: that label is on
     * screen from the first tick, roster or no roster.
     */
    selfKnownFromStart?: boolean;
    /** Whether the panel says this room is silenced in its own right. */
    isMuted?: boolean;
    /** The hand-made section the panel says this room is filed into. */
    currentGroupId?: string | null;
    /** The sections the panel offers as move targets. */
    moveTargetGroups?: readonly { id: string; name: string }[];
    /**
     * Seed the config cache before the first render.
     *
     * A preferences WRITE composes onto whatever the cache holds, and this row
     * no longer subscribes to preferences itself (D8) — so nothing here would
     * put the stored sections in front of `moveToGroup` otherwise, and the write
     * would compose onto the defaults. Seeding is deterministic where waiting on
     * the query to settle is a race.
     */
    config?: unknown;
  } = {}
) {
  // Mesh is always answered: the row maps a 1:1's `agentRef` back to a path
  // through it, so a transport that never answers would make "View profile"
  // silently absent in every test rather than in the ones that mean it.
  const transport = opts.transport ?? createMockTransport();
  transport.listMeshAgentPaths = vi.fn().mockResolvedValue(MESH_AGENTS);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  if (opts.config !== undefined) {
    queryClient.setQueryData(configKeys.current(), opts.config);
  }
  if (opts.selfKnownFromStart === true) {
    queryClient.setQueryData([...TEAM_ROSTER_KEY], selfTeamRoster());
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <PrefsPrimer />
          {children}
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  const utils = render(
    <RoomRow
      room={room}
      visual={opts.visual ?? { kind: 'sigil' }}
      isActive={opts.isActive ?? false}
      isMuted={opts.isMuted ?? false}
      currentGroupId={opts.currentGroupId ?? null}
      moveTargetGroups={opts.moveTargetGroups ?? []}
      onSelect={opts.onSelect ?? vi.fn()}
      viewAgentProfile={opts.viewAgentProfile ?? (() => vi.fn())}
      onRequestNewGroup={opts.onRequestNewGroup ?? vi.fn()}
    />,
    { wrapper }
  );
  return { ...utils, transport };
}

/** Open the "…" affordance and return its menu. */
function openDropdown(name = '#general actions'): HTMLElement {
  fireEvent.pointerDown(screen.getByLabelText(name));
  return screen.getByRole('menu');
}

/** Right-click the row and return the resulting context menu. */
function openContextMenu(): HTMLElement {
  fireEvent.contextMenu(screen.getByRole('button', { name: '#general' }));
  return screen.getByRole('menu');
}

/** Every menu item's text, in order. */
function itemLabels(menu: HTMLElement): string[] {
  return within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  // Both are module state shared by the whole graph: left as one test finished
  // them, the next would read a door somebody else opened.
  useRoomPanelFocusStore.setState({ request: null });
  useAppStore.setState({ rightPanelOpen: false, activeRightPanelTab: null });
});
afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoomRow menus', () => {
  it('renders the SAME items into the right-click menu and the "…" dropdown', () => {
    const { unmount } = renderRow(channel());
    const fromDropdown = itemLabels(openDropdown());
    unmount();

    renderRow(channel());
    expect(itemLabels(openContextMenu())).toEqual(fromDropdown);
  });

  it('writes the ellipsis onto exactly the items that open something', () => {
    renderRow(channel());
    // "Move to section" is a submenu trigger. It reads as a `menuitem` like the
    // rest, and takes no ellipsis: opening a submenu is not the row asking you
    // for anything, it is one more level of the same menu.
    expect(itemLabels(openDropdown())).toEqual([
      'Mute channel',
      'Move to section',
      'Add agents…',
      'Members…',
      'Rename…',
      'Edit topic…',
      'Archive channel',
    ]);
  });

  it('offers Mark as read only while the reader is behind', () => {
    const { unmount } = renderRow(channel({ unreadCount: 0 }));
    expect(itemLabels(openDropdown())).not.toContain('Mark as read');
    unmount();

    renderRow(channel({ unreadCount: 3 }));
    expect(itemLabels(openDropdown())).toContain('Mark as read');
  });

  it('marks read by moving the cursor onto the newest entry, not past it', async () => {
    const transport = createMockTransport({
      listRoomEntries: vi.fn().mockResolvedValue([
        {
          roomId: 'room-1',
          seq: 42,
          id: 'entry-42',
          authorId: 'a',
          kind: 'post',
          body: { text: 'hi' },
          mentions: [],
          sessionId: null,
          cascadeRoot: 'entry-42',
          cascadeDepth: 0,
          signature: null,
          createdAt: '2026-07-26T10:00:00.000Z',
        },
      ]),
    });
    renderRow(channel({ unreadCount: 3 }), { transport });

    fireEvent.click(within(openDropdown()).getByText('Mark as read'));

    await waitFor(() => expect(transport.setReadCursor).toHaveBeenCalledWith('room', 'room-1', 42));
  });

  it('jumps to the agent a one-to-one is with, matched on its directory handle', async () => {
    const viewed = vi.fn();
    const viewAgentProfile = vi.fn((path: string) => () => viewed(path));
    renderRow(oneToOne('/repo/ana'), { viewAgentProfile });

    // Awaited, because the row resolves the handle back to a directory through
    // mesh, which is a shared warm cache entry in the app and a cold request
    // here. The item appears when the answer does.
    const menu = openDropdown('Ana actions');
    fireEvent.click(await within(menu).findByText('View profile'));

    expect(viewed).toHaveBeenCalledWith('/repo/ana');
  });

  it('offers no View profile for an agent the fleet no longer knows', async () => {
    // A mesh rebuild can retire an agent under an open sidebar. Nothing should
    // offer a profile it cannot resolve to a directory.
    renderRow(oneToOne('/repo/departed'));
    const menu = openDropdown('Ana actions');
    // Waits for the SAME signal the passing case waits for, so this asserts an
    // absence after the answer arrived rather than before it.
    await within(menu).findByText('Members…');
    expect(itemLabels(menu)).not.toContain('View profile');
  });
});

describe('RoomRow doors into the room panel', () => {
  /**
   * Three menu items, one door.
   *
   * "Add agents…", "Members…" and "Edit topic…" all open the right panel's Room
   * tab — the surface that replaced the modal room sheet in phase R2 — and they
   * differ only in the part of it they ask for. The panel itself is mounted by
   * the shell and describes whichever room the PAGE is showing, so what a row
   * owes is exactly two things: open the room, and ask for the right part. Both
   * are asserted here; what the panel then does with the request is
   * `RoomPanel.test.tsx`.
   */
  function pressed(item: string): void {
    fireEvent.click(within(openDropdown()).getByText(item));
  }

  it.each([
    ['Add agents…', 'add'],
    ['Members…', 'members'],
    ['Edit topic…', 'topic'],
  ])('opens the panel from %s, asking for the %s part', (item, focus) => {
    renderRow(channel());

    pressed(item);

    const request = useRoomPanelFocusStore.getState().request;
    expect(request).toMatchObject({ focus, roomId: 'room-1' });
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
    expect(useAppStore.getState().activeRightPanelTab).toBe(ROOM_PANEL_ID);
  });

  it('opens the room too, because the panel follows the page', () => {
    // The sidebar lists rooms you are NOT looking at. A panel opened over the
    // room you are still reading would describe the wrong one — so the row does
    // what pressing the row does first. Red if the navigation is dropped: the
    // request would name a room the panel never gets to.
    const onSelect = vi.fn();
    renderRow(channel(), { onSelect });

    pressed('Members…');

    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('RoomRow rename', () => {
  it('opens an inline editor seeded with the title behind the #slug', () => {
    renderRow(channel());
    fireEvent.click(within(openDropdown()).getByText('Rename…'));

    expect(screen.getByRole('textbox', { name: 'Rename #general' })).toHaveValue('General');
  });

  it('writes the new name through the Transport port on Enter', async () => {
    const { transport } = renderRow(channel());
    fireEvent.click(within(openDropdown()).getByText('Rename…'));

    const input = screen.getByRole('textbox', { name: 'Rename #general' });
    fireEvent.change(input, { target: { value: 'Backend' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { title: 'Backend' })
    );
  });

  it('writes nothing on Escape, and puts the row back', () => {
    const { transport } = renderRow(channel());
    fireEvent.click(within(openDropdown()).getByText('Rename…'));

    const input = screen.getByRole('textbox', { name: 'Rename #general' });
    fireEvent.change(input, { target: { value: 'Backend' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(transport.updateRoom).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '#general' })).toBeInTheDocument();
  });

  it('does NOT commit when the field is right-clicked, and opens no room menu', () => {
    // Right-click-to-paste is the ordinary gesture in a text field. It used to
    // open the ROOM menu — the row is the context-menu trigger and the editor
    // sits inside it — which blurred the editor and blur-committed a half-typed
    // name nobody had confirmed.
    const { transport } = renderRow(channel());
    fireEvent.click(within(openDropdown()).getByText('Rename…'));

    const input = screen.getByRole('textbox', { name: 'Rename #general' });
    fireEvent.change(input, { target: { value: 'Half typed' } });
    fireEvent.contextMenu(input);

    expect(transport.updateRoom).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Rename #general' })).toHaveValue('Half typed');
  });

  it('gives the focus back to the row when the editor closes', async () => {
    // The editor unmounts under the cursor; without handing focus back, a
    // keyboard reader is dropped to <body> and has to Tab in from the top of
    // the page to reach the row they just renamed.
    renderRow(channel());
    fireEvent.click(within(openDropdown()).getByText('Rename…'));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename #general' }), { key: 'Escape' });

    await waitFor(() => expect(screen.getByRole('button', { name: '#general' })).toHaveFocus());
  });

  it('writes nothing when the name comes back unchanged or empty', () => {
    const { transport } = renderRow(channel());
    fireEvent.click(within(openDropdown()).getByText('Rename…'));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename #general' }), { key: 'Enter' });
    expect(transport.updateRoom).not.toHaveBeenCalled();

    fireEvent.click(within(openDropdown()).getByText('Rename…'));
    const input = screen.getByRole('textbox', { name: 'Rename #general' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(transport.updateRoom).not.toHaveBeenCalled();
  });
});

describe('RoomRow archive', () => {
  it('archives nothing until the confirmation is accepted', async () => {
    const { transport } = renderRow(channel());
    fireEvent.click(within(openDropdown()).getByText('Archive channel'));

    expect(screen.getByRole('alertdialog')).toHaveTextContent('Archive #general?');
    expect(transport.updateRoom).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { archived: true })
    );
  });

  it('leaves the room alone when the confirmation is refused', () => {
    const { transport } = renderRow(channel());
    fireEvent.click(within(openDropdown()).getByText('Archive channel'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(transport.updateRoom).not.toHaveBeenCalled();
  });
});

describe('RoomRow leave', () => {
  it('withholds Leave until this viewer’s own author id is known', async () => {
    // Not just a cold-sidebar beat: the default mock transport answers the
    // team roster with nobody on it, which is also what a degraded roster
    // read looks like — this stays true until the account source recovers,
    // on either path.
    renderRow(channel());
    const menu = openDropdown();
    await within(menu).findByText('Archive channel');
    expect(itemLabels(menu)).not.toContain('Leave channel');
  });

  it('withholds Leave from #team — the server refuses it outright, so the menu never offers it', () => {
    // `selfKnownFromStart` matters here specifically: `findByText('Archive
    // channel')` alone proves nothing, because that label is on screen from
    // the first tick whether or not the roster has answered — this test
    // used to pass with `isSystemRoom` inverted, because "no Leave" was true
    // for the LOADING reason (`canLeave: false`) rather than the room-shape
    // one. Pre-seeding the roster removes that race: `canLeave` is `true`
    // from the first render, so what is left withholding Leave can only be
    // `isSystemRoom`.
    renderRow(channel({ wellKnown: 'team' }), { selfKnownFromStart: true });
    const menu = openDropdown();
    expect(itemLabels(menu)).not.toContain('Leave channel');
    expect(itemLabels(menu)).not.toContain('Rejoin channel');
  });

  it('withholds Leave on a 1:1 whose agent the fleet no longer knows — still a 1:1', async () => {
    // `oneToOne('/repo/departed')` is the same fixture the "Agent profile"
    // test next door uses: the DM names exactly one agent, but its
    // `agentRef` matches nothing in `MESH_AGENTS`, so `soleAgentPath`
    // resolves to `null` — the same `null` a channel or an unresolved DM
    // reads. Leaving must not read that as "not a 1:1": the room is still
    // one agent and no human, exactly what leaving would strand.
    renderRow(oneToOne('/repo/departed'), { selfKnownFromStart: true });
    const menu = openDropdown('Ana actions');
    // Waits for the same signal the fleet-resolution test does, so this is
    // an absence asserted after mesh resolution lands, not before it.
    await within(menu).findByText('Members…');
    expect(itemLabels(menu)).not.toContain('Leave channel');
    expect(itemLabels(menu)).not.toContain('Rejoin channel');
  });

  it('leaves nothing until the confirmation is accepted', async () => {
    const transport = createMockTransport({
      getTeamRoster: vi.fn().mockResolvedValue(selfTeamRoster()),
    });
    renderRow(channel(), { transport });
    const menu = openDropdown();
    fireEvent.click(await within(menu).findByText('Leave channel'));

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Leave #general?');
    // The confirm copy no longer claims "someone" adds you back — on this
    // single-operator install there is nobody else who could.
    expect(dialog).toHaveTextContent('You can rejoin from this menu');
    expect(transport.removeRoomMember).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(transport.removeRoomMember).toHaveBeenCalledWith('room-1', 'me'));
  });

  it('leaves the room alone when the confirmation is refused', async () => {
    const transport = createMockTransport({
      getTeamRoster: vi.fn().mockResolvedValue(selfTeamRoster()),
    });
    renderRow(channel(), { transport });
    const menu = openDropdown();
    fireEvent.click(await within(menu).findByText('Leave channel'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(transport.removeRoomMember).not.toHaveBeenCalled();
  });

  it('navigates off the room once left, when it is the one open on screen', async () => {
    const transport = createMockTransport({
      getTeamRoster: vi.fn().mockResolvedValue(selfTeamRoster()),
    });
    renderRow(channel(), { transport, isActive: true });
    const menu = openDropdown();
    fireEvent.click(await within(menu).findByText('Leave channel'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: '/channels', search: {} }));
  });

  it('stays put when the room being left is not the one open', async () => {
    // Leaving from a row in the background changes the roster, not where the
    // reader is — there is nothing on screen to navigate away from.
    const transport = createMockTransport({
      getTeamRoster: vi.fn().mockResolvedValue(selfTeamRoster()),
    });
    renderRow(channel(), { transport, isActive: false });
    const menu = openDropdown();
    fireEvent.click(await within(menu).findByText('Leave channel'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));

    await waitFor(() => expect(transport.removeRoomMember).toHaveBeenCalled());
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('offers Undo on the leave toast, which rejoins by the same author id', async () => {
    // Undo IS possible: the server never restricted `addMember` to agents,
    // only this hook's own input type used to (DOR-1233 follow-up) — so this
    // mirrors Archive's undo exactly rather than being absent.
    const transport = createMockTransport({
      getTeamRoster: vi.fn().mockResolvedValue(selfTeamRoster()),
      removeRoomMember: vi.fn().mockResolvedValue(undefined),
      addRoomMember: vi.fn().mockResolvedValue({
        roomId: 'room-1',
        authorId: 'me',
        responseMode: 'always',
        joinedAt: '2026-07-26T10:00:00.000Z',
        joinedSeq: 0,
        lastReadSeq: 0,
        author: { id: 'me', kind: 'human', displayName: 'You' },
      }),
    });
    renderRow(channel(), { transport });
    const menu = openDropdown();
    fireEvent.click(await within(menu).findByText('Leave channel'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));

    await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
    const [, options] = vi.mocked(mockToast.success).mock.calls[0]!;
    const action = options?.action as { onClick: () => void } | undefined;
    action?.onClick();

    await waitFor(() =>
      expect(transport.addRoomMember).toHaveBeenCalledWith('room-1', { authorId: 'me' })
    );
  });

  it('marks a left room with a dimmed row and a hint, and offers Rejoin in its place', async () => {
    // `unreadCount: null` is the server's own tell for "not a member" — the
    // same fact the unread badge already reads this way, not a signal
    // invented for this feature.
    const transport = createMockTransport({
      getTeamRoster: vi.fn().mockResolvedValue(selfTeamRoster()),
      addRoomMember: vi.fn().mockResolvedValue({
        roomId: 'room-1',
        authorId: 'me',
        responseMode: 'always',
        joinedAt: '2026-07-26T10:00:00.000Z',
        joinedSeq: 0,
        lastReadSeq: 0,
        author: { id: 'me', kind: 'human', displayName: 'You' },
      }),
    });
    renderRow(channel({ unreadCount: null }), { transport });

    const hint = screen.getByLabelText('You left this channel');
    expect(hint).toBeInTheDocument();
    // The hint is what says so, NOT a dimming (DOR-1098): the room's name stays
    // at full contrast, because a room you left is still one you read. Red the
    // moment the old `opacity-60` comes back to the row's outer wrapper.
    const wrapper = hint.closest('li')!.firstElementChild!;
    expect(wrapper.className).not.toContain('opacity-60');

    const menu = openDropdown();
    expect(itemLabels(menu)).not.toContain('Leave channel');
    fireEvent.click(await within(menu).findByText('Rejoin channel'));

    await waitFor(() =>
      expect(transport.addRoomMember).toHaveBeenCalledWith('room-1', { authorId: 'me' })
    );
  });
});

describe('RoomRow working dot', () => {
  beforeEach(() => useRoomWorkingStore.setState({ rooms: {} }));

  it('draws a dot from the list count alone, before any event has arrived', () => {
    // The fresh-page-load case: the room list carries the server's live claim
    // count, so a reader who opens the cockpit mid-turn does not stare at an
    // idle-looking sidebar until the next republish tick.
    renderRow(channel({ working: 1 }));
    expect(screen.getByLabelText('1 agent working')).toBeInTheDocument();
  });

  it('says how many agents, so a reader who cannot see the dot still gets the count', () => {
    renderRow(channel({ working: 3 }));
    expect(screen.getByLabelText('3 agents working')).toBeInTheDocument();
  });

  it('wears the theme token, not the palette value it happens to resolve to', () => {
    // The room sheet draws the identical fact with `bg-status-success`. One
    // fact spelled two ways is one that drifts the first time either theme
    // moves, and the raw class is invisible to a theme that redefines it.
    renderRow(channel({ working: 1 }));

    const dot = screen.getByLabelText('1 agent working');
    expect(dot).toHaveClass('bg-status-success');
    expect(dot.className).not.toMatch(/emerald/);
  });

  it('draws nothing for a quiet room', () => {
    renderRow(channel({ working: 0 }));
    expect(screen.queryByLabelText(/working/)).not.toBeInTheDocument();
  });

  it('appears when the stream says a room went busy, and clears when it says done', () => {
    renderRow(channel({ working: 0 }));
    act(() => useRoomWorkingStore.getState().observe({ roomId: 'room-1', working: 1 }));
    expect(screen.getByLabelText('1 agent working')).toBeInTheDocument();
    act(() => useRoomWorkingStore.getState().observe({ roomId: 'room-1', working: 0 }));
    expect(screen.queryByLabelText(/working/)).not.toBeInTheDocument();
  });

  it('keeps the working dot and the unread badge apart', () => {
    // Two different facts about one row — messages waiting to be read, and work
    // running right now — so one must never be mistaken for the other.
    renderRow(channel({ working: 1, unreadCount: 2 }));
    expect(screen.getByLabelText('1 agent working')).toBeInTheDocument();
    expect(screen.getByLabelText('2 unread')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Organization: mute + move to (rooms-in-groups, DOR-581)
// ---------------------------------------------------------------------------

/** A stored `ui.sidebar` with one manual group and one smart group. */
function configWithGroups(overrides: Partial<SidebarPrefs> = {}) {
  return {
    ui: {
      sidebar: {
        ...SIDEBAR_PREFS_DEFAULTS,
        groups: [
          {
            id: 'g-manual',
            name: 'Clients',
            items: [],
            sortMode: 'manual' as const,
            collapsed: false,
            displayFilter: 'all' as const,
            muted: false,
            kind: 'manual' as const,
          },
          {
            id: 'g-smart',
            name: 'Active now',
            items: [],
            sortMode: 'recent' as const,
            collapsed: false,
            displayFilter: 'all' as const,
            muted: false,
            kind: 'smart' as const,
            rules: { statuses: ['active' as const] },
          },
        ],
        ...overrides,
      },
    },
  };
}

/** A transport whose config carries the groups above. */
function transportWithGroups(overrides: Partial<SidebarPrefs> = {}) {
  const transport = createMockTransport();
  transport.getConfig = vi.fn().mockResolvedValue(configWithGroups(overrides));
  return transport;
}

/** The `ui.sidebar` payload of the last `updateConfig` call. */
function lastSidebarWrite(transport: Transport): SidebarPrefs {
  const calls = vi.mocked(transport.updateConfig).mock.calls;
  const last = calls.at(-1)?.[0] as { ui?: { sidebar?: SidebarPrefs } } | undefined;
  if (!last?.ui?.sidebar) throw new Error('expected a ui.sidebar write');
  return last.ui.sidebar;
}

/** Open "Move to section ▸" and return the submenu that appears. */
async function openMoveToGroup(): Promise<HTMLElement> {
  fireEvent.pointerDown(screen.getByLabelText('#general actions'));
  fireEvent.click(await screen.findByText('Move to section'));
  const menus = await screen.findAllByRole('menu');
  // The submenu is the one mounted last; the trigger's own menu stays open.
  return menus[menus.length - 1]!;
}

describe('RoomRow organization', () => {
  it('mutes a room into the SHARED muted list, as a room reference', async () => {
    const transport = transportWithGroups();
    renderRow(channel(), { transport, config: configWithGroups() });

    fireEvent.pointerDown(screen.getByLabelText('#general actions'));
    fireEvent.click(screen.getByText('Mute channel'));

    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalled());
    // The one list agents write into too — never a second, room-only one.
    expect(lastSidebarWrite(transport).muted).toEqual([{ kind: 'room', roomId: 'room-1' }]);
  });

  it('draws the mute it is TOLD about, and offers the way back out of it', () => {
    // The row no longer reads preferences for itself (D8): the panel holds the
    // one subscription and hands each row its answer. Red when the row starts
    // deriving mute from anywhere but this prop.
    renderRow(channel(), { transport: transportWithGroups(), isMuted: true });

    expect(screen.getByLabelText('Muted')).toBeInTheDocument();
    expect(itemLabels(openDropdown())).toContain('Unmute channel');
  });

  it('unmutes by removing the reference rather than writing a false', async () => {
    const muted: Partial<SidebarPrefs> = { muted: [{ kind: 'room', roomId: 'room-1' }] };
    const transport = transportWithGroups(muted);
    renderRow(channel(), { transport, isMuted: true, config: configWithGroups(muted) });

    fireEvent.pointerDown(screen.getByLabelText('#general actions'));
    fireEvent.click(screen.getByText('Unmute channel'));

    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalled());
    expect(lastSidebarWrite(transport).muted).toEqual([]);
  });

  it('offers exactly the sections it was handed, and ticks the one it is in', async () => {
    // Which sections may be offered at all is the panel's answer now — smart
    // ones are filtered out in `moveTargetGroups`, pinned by
    // `use-sidebar-prefs.test.tsx`. What this pins is that the row offers that
    // list and nothing it invented.
    renderRow(channel(), {
      transport: transportWithGroups(),
      moveTargetGroups: [{ id: 'g-manual', name: 'Clients' }],
      currentGroupId: 'g-manual',
    });

    // A group target is a tickable choice, so it reads as `menuitemcheckbox` —
    // asserting over exactly those is what makes "not offered" mean it.
    const submenu = await openMoveToGroup();
    const targets = within(submenu).getAllByRole('menuitemcheckbox');
    expect(targets.map((item) => item.textContent ?? '')).toEqual(['Clients']);
    expect(targets[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('files the room into the group that was picked', async () => {
    const transport = transportWithGroups();
    renderRow(channel(), {
      transport,
      config: configWithGroups(),
      moveTargetGroups: [{ id: 'g-manual', name: 'Clients' }],
    });

    const submenu = await openMoveToGroup();
    fireEvent.click(within(submenu).getByText('Clients'));

    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalled());
    const groups = lastSidebarWrite(transport).groups;
    expect(groups.find((g) => g.id === 'g-manual')?.items).toEqual([
      { kind: 'room', roomId: 'room-1' },
    ]);
  });

  it('hands the group-create flow this room, so the new group is not born empty', async () => {
    const onRequestNewGroup = vi.fn();
    const transport = transportWithGroups();
    renderRow(channel(), { transport, onRequestNewGroup });
    await screen.findByRole('button', { name: '#general' });

    const submenu = await openMoveToGroup();
    fireEvent.click(within(submenu).getByText('New section…'));

    expect(onRequestNewGroup).toHaveBeenCalledWith({ kind: 'room', roomId: 'room-1' });
  });
});
