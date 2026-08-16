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
import { TransportProvider } from '@/layers/shared/model';
import { useRoomWorkingStore } from '@/layers/entities/room';
import { TEAM_ROSTER_KEY } from '@/layers/entities/team';
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
    workspaceId: null,
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

/**
 * The fleet the membership surfaces read for themselves.
 *
 * Mocked at the hook rather than injected as a prop, because these components
 * now fetch it — which is the point of the slice owning it. Each test that
 * cares sets `mockRoster` to the state it is about; the hook's own three-state
 * behaviour is asserted in `use-agent-picker-candidates.test.tsx` and the
 * rendering of each state in `AgentRosterPicker.test.tsx`.
 */
const { mockRosterRef } = vi.hoisted(() => ({
  mockRosterRef: { current: null as unknown },
}));
vi.mock('@/layers/features/room-management/model/use-agent-picker-candidates', () => ({
  useAgentPickerCandidates: () => mockRosterRef.current,
}));

// The room sheet this row opens reads route state to decide where each member
// row's face leads (`useProfileDeepLink`), and this file mounts it with no
// router. Where that link goes has its own file —
// `features/room-management/__tests__/RoomMemberRow.click-to-profile.test.tsx`,
// which mounts a real router and asserts the id that travels.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useProfileDeepLink: () => ({ isOpen: false, memberId: null, open: vi.fn(), close: vi.fn() }),
  };
});

/** A fleet that has been read successfully. The state is named, never defaulted. */
function settled(candidates: { agentPath: string; displayName: string }[]) {
  return { candidates, isLoading: false, isError: false, retry: vi.fn() };
}

const FLEET = [{ agentPath: '/repo/ana', displayName: 'Ana' }];

/** What `getRoom` answers with for the members panel: the operator plus Ana. */
function roomWithRoster() {
  return {
    ...channel(),
    members: [
      {
        roomId: 'room-1',
        authorId: 'me',
        responseMode: 'always' as const,
        joinedAt: '2026-07-26T10:00:00.000Z',
        joinedSeq: 0,
        lastReadSeq: 0,
        author: { id: 'me', kind: 'human' as const, displayName: 'You' },
      },
      {
        roomId: 'room-1',
        authorId: 'author-ana',
        responseMode: 'mention-only' as const,
        joinedAt: '2026-07-26T10:00:00.000Z',
        joinedSeq: 0,
        lastReadSeq: 0,
        author: {
          id: 'author-ana',
          kind: 'agent' as const,
          displayName: 'Ana',
          agentRef: agentAuthorRef('/repo/ana'),
        },
      },
    ],
  };
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

function renderRow(
  room: RoomSummary,
  opts: {
    transport?: Transport;
    viewAgentProfile?: (path: string) => (() => void) | undefined;
    /** The mark the sidebar's view model resolved for this room. */
    visual?: SidebarItemVisual;
    /** Asked for the inline group-create editor, carrying this room's reference. */
    onRequestNewGroup?: (ref: SidebarItemRef) => void;
    /** Whether this room is the one open on screen. Defaults to closed. */
    isActive?: boolean;
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
  if (opts.selfKnownFromStart === true) {
    queryClient.setQueryData([...TEAM_ROSTER_KEY], selfTeamRoster());
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  const utils = render(
    <RoomRow
      room={room}
      visual={opts.visual ?? { kind: 'sigil' }}
      isActive={opts.isActive ?? false}
      onSelect={vi.fn()}
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
  mockRosterRef.current = settled(FLEET);
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
    // "Move to group" is a submenu trigger. It reads as a `menuitem` like the
    // rest, and takes no ellipsis: opening a submenu is not the row asking you
    // for anything, it is one more level of the same menu.
    expect(itemLabels(openDropdown())).toEqual([
      'Mute channel',
      'Move to group',
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

describe('RoomRow surfaces opened from the menu', () => {
  // These cross the menu seam on purpose. A panel that places focus correctly
  // when rendered on its own still lands in the wrong place through a menu:
  // the menu closes in a SECOND commit and restores focus to its own trigger,
  // overwriting whatever the panel just focused. Rendering the panel directly
  // cannot see that, and once certified it below the seam.
  it('puts the cursor in the search field when the reader asked to add agents', async () => {
    renderRow(channel(), {
      transport: createMockTransport({ getRoom: vi.fn().mockResolvedValue(roomWithRoster()) }),
    });
    fireEvent.click(within(openDropdown()).getByText('Add agents…'));

    const search = await screen.findByRole('combobox', { name: 'Search agents' });
    await waitFor(() => expect(search).toHaveFocus());
  });

  it('leaves the search field alone when the reader asked for the roster', async () => {
    renderRow(channel(), {
      transport: createMockTransport({ getRoom: vi.fn().mockResolvedValue(roomWithRoster()) }),
    });
    fireEvent.click(within(openDropdown()).getByText('Members…'));

    const panel = await screen.findByRole('dialog');
    await within(panel).findByRole('region', { name: 'Current members' });
    // Adding is still one row at the foot of the roster: "Members…" asked for
    // who is in here, so nothing has opened a field to type into.
    expect(
      within(panel).queryByRole('combobox', { name: 'Search agents' })
    ).not.toBeInTheDocument();
    // …and focus is still inside the panel, not left behind on the sidebar.
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it('takes an added agent off the picker rather than offering to add it twice', async () => {
    // The selection lives in the picker, so only a test that actually picks
    // somebody and commits can see what happens to it afterwards — calling the
    // panel's own add handler passes whatever the chips go on to do.
    const [me, ana] = roomWithRoster().members;
    let members = [me!];
    const transport = createMockTransport({
      getRoom: vi.fn().mockImplementation(() => Promise.resolve({ ...channel(), members })),
      addRoomMember: vi.fn().mockImplementation(() => {
        members = [...members, ana!];
        return Promise.resolve(ana!);
      }),
    });
    mockRosterRef.current = settled([...FLEET, { agentPath: '/repo/bo', displayName: 'Bo' }]);
    renderRow(channel(), { transport });
    fireEvent.click(within(openDropdown()).getByText('Add agents…'));

    // Scoped to the add half: once Ana is in the room the roster grows a
    // "Remove Ana" of its own, and that one is a different verb entirely.
    const picker = () => within(screen.getByRole('region', { name: 'Add agents' }));
    fireEvent.click(await picker().findByRole('option', { name: 'Ana' }));
    expect(picker().getByRole('button', { name: 'Remove Ana' })).toBeInTheDocument();

    fireEvent.click(picker().getByRole('button', { name: 'Add agent' }));
    await waitFor(() => expect(transport.addRoomMember).toHaveBeenCalledTimes(1));

    // Ana lands, joins the roster, and stops being offerable — so her chip goes
    // and the button has nothing left to commit.
    await waitFor(() =>
      expect(picker().queryByRole('button', { name: 'Remove Ana' })).not.toBeInTheDocument()
    );
    expect(picker().getByRole('button', { name: 'Add agent' })).toBeDisabled();
    fireEvent.click(picker().getByRole('button', { name: 'Add agent' }));
    expect(transport.addRoomMember).toHaveBeenCalledTimes(1);
    // Bo was never picked and is still on offer.
    expect(picker().getAllByRole('option')).toHaveLength(1);
  });
});

describe('RoomRow topic', () => {
  it('opens the room sheet on the topic, cursor already in it', async () => {
    // "Edit topic…" used to raise a modal holding one text field, over a room
    // the reader was already looking at. It now opens the sheet with the topic
    // line already in its editor. Crossing the menu seam matters: the menu
    // closes a commit later and restores focus to its own trigger, which
    // overwrites anything the field focused on mount.
    const { transport } = renderRow(channel(), {
      transport: createMockTransport({ getRoom: vi.fn().mockResolvedValue(roomWithRoster()) }),
    });
    fireEvent.click(within(openDropdown()).getByText('Edit topic…'));

    // The sheet, not a dialog of its own: the roster is right there under it.
    const panel = await screen.findByRole('dialog');
    await within(panel).findByRole('region', { name: 'Current members' });

    const input = within(panel).getByRole('textbox', { name: 'Topic' });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: 'Clicker planning' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { topic: 'Clicker planning' })
    );
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
    // The dimming rides the row's outer wrapper — the same element the drag
    // layer binds to (mirrors `AgentListItem.test.tsx`'s "muted rendering").
    const dimmed = hint.closest('li')!.firstElementChild!;
    expect(dimmed.className).toContain('opacity-60');

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
// Organization: mute + move to group (rooms-in-groups, DOR-581)
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

/** Open "Move to group ▸" and return the submenu that appears. */
async function openMoveToGroup(): Promise<HTMLElement> {
  fireEvent.pointerDown(screen.getByLabelText('#general actions'));
  fireEvent.click(await screen.findByText('Move to group'));
  const menus = await screen.findAllByRole('menu');
  // The submenu is the one mounted last; the trigger's own menu stays open.
  return menus[menus.length - 1]!;
}

describe('RoomRow organization', () => {
  it('mutes a room into the SHARED muted list, as a room reference', async () => {
    const transport = transportWithGroups();
    renderRow(channel(), { transport });
    await screen.findByRole('button', { name: '#general' });

    fireEvent.pointerDown(screen.getByLabelText('#general actions'));
    fireEvent.click(screen.getByText('Mute channel'));

    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalled());
    // The one list agents write into too — never a second, room-only one.
    expect(lastSidebarWrite(transport).muted).toEqual([{ kind: 'room', roomId: 'room-1' }]);
  });

  it('reads its own mute state back: the item says Unmute and the row is marked', async () => {
    const transport = transportWithGroups({ muted: [{ kind: 'room', roomId: 'room-1' }] });
    renderRow(channel(), { transport });

    await waitFor(() => expect(screen.getByLabelText('Muted')).toBeInTheDocument());
    expect(itemLabels(openDropdown())).toContain('Unmute channel');
  });

  it('unmutes by removing the reference rather than writing a false', async () => {
    const transport = transportWithGroups({ muted: [{ kind: 'room', roomId: 'room-1' }] });
    renderRow(channel(), { transport });
    await waitFor(() => expect(screen.getByLabelText('Muted')).toBeInTheDocument());

    fireEvent.pointerDown(screen.getByLabelText('#general actions'));
    fireEvent.click(screen.getByText('Unmute channel'));

    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalled());
    expect(lastSidebarWrite(transport).muted).toEqual([]);
  });

  it('offers only MANUAL groups as move targets — a room in a smart group vanishes', async () => {
    // A smart group derives its members from rules about agents and draws those
    // instead of its stored `items`, while `groupedRoomIds` still counts the
    // room as grouped and hides it from Channels. Offering it would file the
    // room somewhere no section draws it.
    const transport = transportWithGroups();
    renderRow(channel(), { transport });
    await screen.findByRole('button', { name: '#general' });

    // A group target is a tickable choice, so it reads as `menuitemcheckbox` —
    // asserting over exactly those is what makes "not offered" mean it.
    const submenu = await openMoveToGroup();
    const targets = within(submenu)
      .getAllByRole('menuitemcheckbox')
      .map((item) => item.textContent ?? '');
    expect(targets).toEqual(['Clients']);
  });

  it('files the room into the group that was picked', async () => {
    const transport = transportWithGroups();
    renderRow(channel(), { transport });
    await screen.findByRole('button', { name: '#general' });

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
    fireEvent.click(within(submenu).getByText('New group…'));

    expect(onRequestNewGroup).toHaveBeenCalledWith({ kind: 'room', roomId: 'room-1' });
  });
});
