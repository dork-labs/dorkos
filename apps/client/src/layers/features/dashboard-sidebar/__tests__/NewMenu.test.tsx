// @vitest-environment jsdom
/**
 * The one create surface (BC-45).
 *
 * Every case here presses the real item and checks the real surface it reached
 * — the demo-claim gate applied to a menu: an item that opened nothing would
 * still render, still read correctly, and still be a lie.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { enterDesktopShell, leaveDesktopShell } from '@/test-helpers/desktop-shell';
import { useCreateFlowStore } from '../model/create-flow-store';
import { buildNewMenuNodes, NewMenu, type NewMenuModel } from '../ui/NewMenu';

// ---------------------------------------------------------------------------
// Mocks — everything the menu reaches for, and nothing else
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

const mockStartNewSession = vi.fn();
let mockSelectedCwd: string | null = null;
vi.mock('@/layers/entities/session', () => ({
  useStartNewSession: () => mockStartNewSession,
  useDirectoryState: () => [mockSelectedCwd, vi.fn()],
}));

const mockAgentCreationOpen = vi.fn();
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useAgentCreationStore: { getState: () => ({ open: mockAgentCreationOpen }) },
  };
});

let mockPaths: string[] = ['/projects/alpha', '/projects/beta'];
vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => ({ data: { agents: mockPaths.map((p) => ({ projectPath: p })) } }),
}));

let mockManifests: Record<string, { id: string; name: string; runtime: string } | null> = {};
vi.mock('@/layers/entities/agent', async () => ({
  // The real namer: what the Session note line promises has to be the name the
  // rest of the sidebar would draw, not a stub's idea of one.
  ...(await vi.importActual<
    typeof import('@/layers/entities/agent/lib/disambiguate-display-names')
  >('@/layers/entities/agent/lib/disambiguate-display-names')),
  useResolvedAgents: () => ({ data: mockManifests }),
}));

const mockUpdatePrefs = vi.fn();
vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return {
    ...actual,
    useUpdateSidebarPrefs: () => ({ update: mockUpdatePrefs }),
  };
});

const mockStartDm = vi.fn();
vi.mock('@/layers/entities/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/room')>();
  return { ...actual, useStartDirectMessage: () => ({ mutate: mockStartDm }) };
});

vi.mock('@/layers/features/room-management', () => ({
  ChannelCreateDialog: () => <div data-testid="channel-create-dialog" />,
  NewDirectMessageMenu: ({ open }: { open: boolean }) =>
    open ? <div data-testid="dm-picker" /> : null,
}));

vi.mock('../ui/SmartGroupRuleDialog', () => ({
  SmartGroupRuleDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="smart-group-dialog" /> : null,
}));

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPaths = ['/projects/alpha', '/projects/beta'];
  mockManifests = {};
  mockSelectedCwd = null;
  useCreateFlowStore.setState({ menuOpen: false, preselect: null, groupCreation: null });
});

afterEach(() => {
  cleanup();
  leaveDesktopShell();
});

function renderMenu() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NewMenu />
    </QueryClientProvider>
  );
}

/** Open the menu the way a person does, and wait for its items. */
async function openMenu() {
  fireEvent.pointerDown(screen.getByTestId('sidebar-new-button'));
  // A regex, not the exact string: on desktop the item's accessible name
  // carries its ⌘N hint too.
  await screen.findByRole('menuitem', { name: /Session/ });
}

/** Every item id the open menu is showing, in order. */
function itemIds(): string[] {
  return [...document.querySelectorAll('[data-menu-item-id]')].map(
    (el) => el.getAttribute('data-menu-item-id') ?? ''
  );
}

/** A fleet big enough for BC-32 to offer grouping. */
function bigFleet() {
  mockPaths = Array.from({ length: 8 }, (_, i) => `/projects/p${i}`);
  mockManifests = Object.fromEntries(
    mockPaths.map((p) => [p, { id: `id${p}`, name: p.slice(10), runtime: 'claude-code' }])
  );
}

// ---------------------------------------------------------------------------
// The item list, as data
// ---------------------------------------------------------------------------

function model(overrides: Partial<NewMenuModel> = {}): NewMenuModel {
  return {
    onNewSession: vi.fn(),
    lastUsedAgentName: null,
    onNewChannel: vi.fn(),
    onNewMessage: vi.fn(),
    onNewAgent: vi.fn(),
    smartGroupPresets: [],
    onCreatePresetSmartGroup: vi.fn(),
    onOpenSmartGroupDialog: vi.fn(),
    showSessionShortcut: false,
    ...overrides,
  };
}

describe('buildNewMenuNodes', () => {
  it('offers the five items the design names, in order, once grouping is offered', () => {
    const ids = buildNewMenuNodes(model({ onNewGroup: vi.fn() }))
      .filter((node) => node.kind === 'action' || node.kind === 'submenu')
      .map((node) => node.id);
    expect(ids).toEqual(['new-session', 'new-channel', 'new-message', 'new-agent', 'new-group']);
  });

  it('withholds only Agent group below the grouping threshold', () => {
    const ids = buildNewMenuNodes(model())
      .filter((node) => node.kind === 'action' || node.kind === 'submenu')
      .map((node) => node.id);
    expect(ids).toEqual(['new-session', 'new-channel', 'new-message', 'new-agent']);
  });

  it('makes Agent group a submenu — by hand, or from rules', () => {
    const group = buildNewMenuNodes(
      model({
        onNewGroup: vi.fn(),
        smartGroupPresets: [{ label: 'Active now', rules: { statuses: ['active'] } }],
      })
    ).find((n) => n.id === 'new-group');
    expect(group?.kind).toBe('submenu');
  });

  it('names the last-used agent under Session, and says nothing when it cannot', () => {
    const withName = buildNewMenuNodes(model({ lastUsedAgentName: 'Alpha' }));
    expect(withName.find((n) => n.id === 'new-session-note')).toMatchObject({
      kind: 'note',
      text: 'Starts with Alpha (last used)',
    });
    expect(buildNewMenuNodes(model()).find((n) => n.id === 'new-session-note')).toBeUndefined();
  });

  it('advertises ⌘N only where the key can be honoured', () => {
    const shown = buildNewMenuNodes(model({ showSessionShortcut: true })).find(
      (n) => n.id === 'new-session'
    );
    expect(shown).toMatchObject({ hint: expect.stringMatching(/N$/) });
    expect(buildNewMenuNodes(model()).find((n) => n.id === 'new-session')).not.toHaveProperty(
      'hint'
    );
  });

  it('offers a group by hand and every preset under the one Agent group item', () => {
    const nodes = buildNewMenuNodes(
      model({
        onNewGroup: vi.fn(),
        smartGroupPresets: [{ label: 'Active now', rules: { statuses: ['active'] } }],
      })
    );
    const group = nodes.find((n) => n.id === 'new-group');
    expect(group?.kind === 'submenu' && group.items.map((i) => i.id)).toEqual([
      'new-group-empty',
      'sep-smart',
      'new-group-preset:Active now',
      'new-group-custom',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Every item reaches a real surface
// ---------------------------------------------------------------------------

describe('NewMenu', () => {
  it('lists the four always-available items for a small cockpit', async () => {
    renderMenu();
    await openMenu();
    expect(itemIds()).toEqual(['new-session', 'new-channel', 'new-message', 'new-agent']);
  });

  it('adds Agent group once the fleet reaches the grouping threshold (BC-32)', async () => {
    bigFleet();
    renderMenu();
    await openMenu();
    expect(itemIds()).toContain('new-group');
  });

  it('starts a session with the last-used agent, and says which one that is', async () => {
    mockSelectedCwd = '/projects/beta';
    mockManifests = {
      '/projects/alpha': { id: 'a', name: 'Alpha', runtime: 'claude-code' },
      '/projects/beta': { id: 'b', name: 'Beta', runtime: 'claude-code' },
    };
    renderMenu();
    await openMenu();

    expect(screen.getByText('Starts with Beta (last used)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Session' }));
    expect(mockStartNewSession).toHaveBeenCalledWith('/projects/beta');
  });

  it('opens the real channel dialog from Channel', async () => {
    renderMenu();
    await openMenu();
    expect(screen.queryByTestId('channel-create-dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Channel…' }));
    expect(await screen.findByTestId('channel-create-dialog')).toBeInTheDocument();
  });

  it('opens the real direct-message picker from Direct message', async () => {
    renderMenu();
    await openMenu();
    expect(screen.queryByTestId('dm-picker')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Direct message…' }));
    expect(await screen.findByTestId('dm-picker')).toBeInTheDocument();
  });

  it('opens the agent-creation flow from Agent', async () => {
    renderMenu();
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Agent…' }));
    expect(mockAgentCreationOpen).toHaveBeenCalledOnce();
  });

  it('starts the inline group editor from Agent group ▸ Empty group', async () => {
    bigFleet();
    renderMenu();
    await openMenu();
    expect(useCreateFlowStore.getState().groupCreation).toBeNull();

    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Agent group' }), {
      key: 'ArrowRight',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Empty group…' }));

    expect(useCreateFlowStore.getState().groupCreation).toEqual({ pendingRef: null });
  });

  it('makes a smart group straight from a preset', async () => {
    bigFleet();
    renderMenu();
    await openMenu();

    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Agent group' }), {
      key: 'ArrowRight',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Active now' }));

    expect(mockUpdatePrefs).toHaveBeenCalledOnce();
  });

  it('lands focus on the item a section’s "+" deep-linked to', async () => {
    renderMenu();
    useCreateFlowStore.getState().openMenu('new-channel');
    const channel = await screen.findByRole('menuitem', { name: 'Channel…' });
    await waitFor(() => expect(document.activeElement).toBe(channel));
  });

  it('opens on the first item when nothing deep-linked it', async () => {
    renderMenu();
    await openMenu();
    // Radix's own roving focus keeps the top of the list; nothing steals it.
    await waitFor(() =>
      expect(document.activeElement).not.toBe(screen.getByRole('menuitem', { name: 'Channel…' }))
    );
  });

  it('shows the ⌘N hint on the desktop app', async () => {
    enterDesktopShell();
    renderMenu();
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /Session/ }).textContent).toMatch(/N$/);
  });

  it('withholds the ⌘N hint in a browser, which takes that key for itself', async () => {
    renderMenu();
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /Session/ }).textContent).not.toMatch(/N$/);
  });
});
