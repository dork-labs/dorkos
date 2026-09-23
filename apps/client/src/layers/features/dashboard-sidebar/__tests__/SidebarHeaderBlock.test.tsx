// @vitest-environment jsdom
/**
 * The header block (BC-43, BC-44, BC-46).
 *
 * The load-bearing case here is `does not relayout`: the block is a switcher in
 * waiting, and the design's promise is that communities arrive as more rows in
 * this menu with nothing outside it moving. That is asserted by rendering the
 * real block against a three-row list and a six-row one and comparing the
 * block's own markup — not by describing the promise in a comment.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  render,
  screen,
  fireEvent,
  createEvent,
  cleanup,
  waitFor,
  within,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Settings } from 'lucide-react';
import { toast } from 'sonner';
import { OPERATOR_FALLBACK_DISPLAY_NAME } from '@dorkos/shared/team-schemas';
import { confirmCommunityAuthority, invalidateCommunityAuthority } from '@/layers/shared/lib';
import { commitCommunityRouteEpoch } from '@/layers/shared/model';
import type { SidebarMenuNode } from '@/layers/shared/ui';
import { buildHeaderBlockMenuNodes } from '../ui/header-block-menu';
import { SidebarHeaderBlock, teamNameFor } from '../ui/SidebarHeaderBlock';
import { MobileCommunityContextSwitcher } from '../ui/context/CommunityContextSwitcher';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockSelf: { id: string; displayName: string; isSelf: boolean } | null = {
  id: 'me',
  displayName: 'Dorian',
  isSelf: true,
};
/** Whether the roster read has answered yet — the header's one gate (D6). */
let mockRosterPending = false;
let mockIsMobile = false;
vi.mock('@/layers/entities/team', () => ({
  useTeamRoster: () => ({
    data: mockRosterPending ? undefined : { members: mockSelf === null ? [] : [mockSelf] },
    isPending: mockRosterPending,
  }),
}));

const mockOpenSettings = vi.fn();
const mockOpenProfile = vi.fn();
const mockOpenConnections = vi.fn();
const mockNavigate = vi.fn((_options: { search?: { community?: string } }) => Promise.resolve());
const mockResolveCommunityNavigation = vi.fn();
const mockGetCommunityNavigation = vi.fn();
const mockListRemoteCommunityRooms = vi.fn();
const mockMoveCommunityNavigation = vi.fn();
const mockSetGlobalPaletteOpen = vi.fn();
let mockSearch: { community?: string } = {};
let mockPathname = '/';
let mockConnections: Array<{
  ref: string;
  remoteCommunityId: string;
  label: string;
  pinnedOrigin: string;
  connectedHumanMemberId: string | null;
  status: 'pending' | 'connected' | 'reconnect-required';
  expiresAt: string | null;
  access?: {
    state: 'verified' | 'unverified' | 'reconnect-required';
    effective: { read: boolean; post: boolean; enrollAgent: boolean; stream: boolean };
    lastKnown: {
      lifecycle: 'active' | 'archived' | 'suspended' | 'deletion_pending';
      capabilities: { read: boolean; post: boolean; enrollAgent: boolean; stream: boolean };
      verifiedAt: string;
    } | null;
  } | null;
  hostOperator?: boolean;
  attention?: {
    state: 'verified' | 'stale' | 'unavailable';
    unreadCount: number | null;
    mentionCount: number | null;
    verifiedAt: string | null;
  };
}> = [];
let mockCommunityOrder: string[] = [];
let mockConfig: { version?: string; latestVersion?: string | null; isDevMode?: boolean } = {
  version: '0.58.0',
  latestVersion: null,
  isDevMode: false,
};
const mockGetConfig = vi.fn(() => Promise.resolve(mockConfig));
const mockOpenExternalLink = vi.fn((_href: string) => true);
vi.mock('@/layers/shared/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/lib')>();
  return { ...actual, openExternalLink: (href: string) => mockOpenExternalLink(href) };
});
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useTransport: () => ({
      getConfig: mockGetConfig,
      getCommunityNavigation: mockGetCommunityNavigation,
      resolveCommunityNavigation: mockResolveCommunityNavigation,
      listRemoteCommunityRooms: mockListRemoteCommunityRooms,
    }),
    useSettingsDeepLink: () => ({ open: mockOpenSettings }),
    useProfileDeepLink: () => ({ open: mockOpenProfile }),
    useOpenConnections: () => mockOpenConnections,
    useIsMobile: () => mockIsMobile,
    useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ setGlobalPaletteOpen: mockSetGlobalPaletteOpen }),
  };
});
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
      select({ location: { pathname: mockPathname, search: mockSearch } }),
  };
});
const mockEndConnection = vi.fn();
vi.mock('@/layers/entities/community', () => ({
  useCommunityConnections: () => ({ data: mockConnections }),
  useCommunityNavigation: () => ({ data: { ownerKey: 'owner-a', order: mockCommunityOrder } }),
  useMoveCommunityNavigation: () => ({ mutate: mockMoveCommunityNavigation }),
  useEndCommunityConnection: () => ({
    mutate: mockEndConnection,
    reset: () => {},
    isPending: false,
    isError: false,
  }),
}));

// The New menu is the header block's neighbour, not its subject: it reaches for
// a router, a query client and the whole fleet, and `NewMenu.test.tsx` is where
// it is exercised. Marked here so its presence is still asserted.
vi.mock('../ui/NewMenu', () => ({ NewMenu: () => <div data-testid="new-menu" /> }));

/** Menu rows this render should show, or `null` for the real builder. */
let mockMenuNodes: SidebarMenuNode[] | null = null;
vi.mock('../ui/header-block-menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/header-block-menu')>();
  return {
    ...actual,
    buildHeaderBlockMenuNodes: (model: Parameters<typeof actual.buildHeaderBlockMenuNodes>[0]) =>
      mockMenuNodes ?? actual.buildHeaderBlockMenuNodes(model),
  };
});

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
  mockSelf = { id: 'me', displayName: 'Dorian', isSelf: true };
  mockConfig = { version: '0.58.0', latestVersion: null, isDevMode: false };
  mockMenuNodes = null;
  mockRosterPending = false;
  mockIsMobile = false;
  mockPathname = '/';
  mockSearch = {};
  mockConnections = [];
  mockCommunityOrder = [];
  mockResolveCommunityNavigation.mockResolvedValue(null);
  mockGetCommunityNavigation.mockResolvedValue({
    ownerKey: 'owner-a',
    installationDestination: { path: '/', search: {} },
    order: [],
    destinations: [],
  });
  mockListRemoteCommunityRooms.mockResolvedValue({
    community: 'community-a',
    rooms: [],
    stale: false,
  });
  const authority = invalidateCommunityAuthority();
  confirmCommunityAuthority(authority.epoch, 'owner-a');
  commitCommunityRouteEpoch(`test:${authority.epoch}`);
});

afterEach(() => cleanup());

function renderBlock() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SidebarHeaderBlock />
    </QueryClientProvider>
  );
}

function renderMobileSwitcher() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockIsMobile = true;
  return render(
    <QueryClientProvider client={client}>
      <MobileCommunityContextSwitcher />
    </QueryClientProvider>
  );
}

/**
 * The header block's own markup, with Radix's per-render ids neutralised.
 *
 * Those ids are a counter, not a layout: they differ between any two renders of
 * the same tree, so leaving them in would make this comparison fail for a
 * reason that has nothing to do with the claim. Everything else — structure,
 * every class, every attribute — is compared verbatim.
 */
function blockMarkup(): string {
  const root = screen.getByTestId('sidebar-header-block').closest('[data-slot]');
  if (root === null) throw new Error('header block has no slot root');
  return root.outerHTML.replace(/radix-[\w-]+/g, 'radix-id');
}

/** N interchangeable menu rows — the stand-in for "communities shipped". */
function rows(count: number): SidebarMenuNode[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: 'action' as const,
    id: `row-${i}`,
    label: `Row ${i}`,
    icon: Settings,
    opensInput: false,
    run: () => {},
  }));
}

// ---------------------------------------------------------------------------
// The menu, as data
// ---------------------------------------------------------------------------

describe('buildHeaderBlockMenuNodes', () => {
  const base = {
    onOpenSettings: () => {},
    onOpenAccount: () => {},
    version: '0.58.0',
    isDevMode: false,
    onCheckForUpdates: () => {},
  };

  it('carries Workspace settings, Account and the version line, in that order', () => {
    expect(buildHeaderBlockMenuNodes(base).map((n) => n.id)).toEqual([
      'workspace-settings',
      'account',
      'sep-version',
      'version',
    ]);
  });

  it('spells the version line the way the design does', () => {
    const version = buildHeaderBlockMenuNodes(base).find((n) => n.id === 'version');
    expect(version).toMatchObject({ label: 'v0.58.0 beta', hint: 'Check for updates' });
  });

  it('drops Account when the roster names nobody, rather than offering a dead row', () => {
    expect(
      buildHeaderBlockMenuNodes({ ...base, onOpenAccount: null }).map((n) => n.id)
    ).not.toContain('account');
  });

  it('says "Development build" instead of a number nobody can update to', () => {
    const nodes = buildHeaderBlockMenuNodes({ ...base, isDevMode: true });
    expect(nodes.find((n) => n.id === 'version')).toMatchObject({
      kind: 'note',
      text: 'Development build',
    });
  });

  it('withholds the version line entirely until the server has answered', () => {
    expect(buildHeaderBlockMenuNodes({ ...base, version: null }).map((n) => n.id)).not.toContain(
      'version'
    );
  });

  it('says "workspace" once, and only where it names the settings surface', () => {
    const said = buildHeaderBlockMenuNodes(base)
      .filter((n) => n.kind === 'action' || n.kind === 'note')
      .map((n) => (n.kind === 'note' ? n.text : n.label))
      .filter((text) => /workspace/i.test(text));
    expect(said).toEqual(['Workspace settings']);
  });
});

// ---------------------------------------------------------------------------
// The block itself
// ---------------------------------------------------------------------------

describe('teamNameFor', () => {
  it('names the cockpit after the operator', () => {
    expect(teamNameFor('Dorian')).toBe('Dorian’s team');
  });

  it('does not double the s on a name that already ends in one', () => {
    expect(teamNameFor('Chris')).toBe('Chris’ team');
  });

  it('falls back to a name it can say honestly when the roster is empty', () => {
    expect(teamNameFor(null)).toBe('Your team');
    expect(teamNameFor('  ')).toBe('Your team');
  });

  it('does not say "You\u2019s team" before the operator has given a name', () => {
    // The roster answers with the literal 'You' until Settings › Profile is
    // filled in. A browser run caught this one, not a test.
    expect(teamNameFor(OPERATOR_FALLBACK_DISPLAY_NAME)).toBe('Your team');
  });
});

describe('SidebarHeaderBlock', () => {
  it('opens the shared destinations as a bottom sheet from phone top chrome', async () => {
    mockConnections = [
      {
        ref: 'a',
        remoteCommunityId: 'remote-a',
        label: 'Alpha',
        pinnedOrigin: 'https://a.example.com',
        connectedHumanMemberId: 'person-a',
        status: 'connected',
        expiresAt: null,
      },
    ];
    renderMobileSwitcher();
    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Dorian’s team/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('radio', { name: /Alpha/ })).toBeInTheDocument();
    // "Add community" is a menu of distinct paths, flattened into a named
    // group on a phone rather than a second popup over the sheet.
    const add = screen.getByRole('group', { name: 'Add community' });
    expect(within(add).getByRole('menuitem', { name: /Connect a community/ })).toBeInTheDocument();
    expect(
      within(add).getByRole('menuitem', { name: /Join with an invitation…/ })
    ).toBeInTheDocument();
    expect(
      within(add).getByRole('menuitem', { name: /Run your own community/ })
    ).toBeInTheDocument();
  });

  it('keeps Workspace settings, Account and the version line on phones', async () => {
    // This menu is the version number's one home in the chrome (BC-44), and
    // the footer menu deliberately does not repeat these rows, so a phone that
    // lost them here would have no way to reach them at all.
    renderMobileSwitcher();
    // The phone trigger is an icon to fit the top bar at 390px, so its name
    // has to live in its accessible name rather than on screen.
    expect(screen.getByTestId('sidebar-header-block')).toHaveAccessibleName(/Dorian’s team menu/);
    expect(screen.getByTestId('sidebar-header-block')).not.toHaveTextContent('Dorian’s team');
    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    const sheet = await screen.findByRole('dialog');
    expect(await screen.findByRole('menuitem', { name: /v0\.58\.0 beta/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Account/ })).toBeInTheDocument();
    // A menu item is only a menu item inside a menu (axe aria-required-parent).
    const actions = within(sheet).getByRole('menu', { name: 'Actions' });
    expect(within(actions).getByRole('menuitem', { name: /Account/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /Workspace settings/ }));
    expect(mockOpenSettings).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(sheet).not.toBeInTheDocument());
  });

  it('adds phone search at eight communities and exposes keyboard-safe reorder actions', async () => {
    mockSearch = { community: 'community-4' };
    mockConnections = Array.from({ length: 8 }, (_, index) => ({
      ref: `community-${index}`,
      remoteCommunityId: `remote-${index}`,
      label: `Community ${index}`,
      pinnedOrigin: `https://community-${index}.example.com`,
      connectedHumanMemberId: `person-${index}`,
      status: 'connected' as const,
      expiresAt: null,
    }));
    renderMobileSwitcher();
    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    const search = await screen.findByRole('searchbox', { name: 'Find a community' });
    const manage = screen.getByRole('group', { name: 'Manage Community 4' });
    expect(within(manage).getByRole('menuitem', { name: /Move down/ })).toBeInTheDocument();
    fireEvent.click(within(manage).getByRole('menuitem', { name: /Move up/ }));
    expect(mockMoveCommunityNavigation).toHaveBeenCalledWith({
      ref: 'community-4',
      direction: 'up',
    });

    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Find a community' }), {
      target: { value: 'Community 7' },
    });
    expect(screen.getByRole('radio', { name: /Community 7/ })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Community 1/ })).not.toBeInTheDocument();
    expect(search).not.toBeInTheDocument();
  });

  it('is a button named after the operator, with the New button and the ⌘K pill beside it', () => {
    renderBlock();
    const block = screen.getByRole('button', { name: /Dorian’s team/ });
    expect(block.tagName).toBe('BUTTON');
    expect(block).toHaveTextContent('Dorian’s team');
    expect(screen.getByTestId('new-menu')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-search-pill')).toBeInTheDocument();
  });

  it('says "workspace" nowhere in the block itself — not even to a screen reader', async () => {
    renderBlock();
    // Observable first: the block IS rendered and DOES carry an accessible
    // name, so the absence below is about the wording and not about an empty
    // document.
    const block = screen.getByTestId('sidebar-header-block');
    expect(block.getAttribute('aria-label')).toMatch(/team/);
    expect(block.outerHTML).not.toMatch(/workspace/i);

    // …and inside the menu it is said exactly once, naming the settings
    // surface that already carries that word (§16, R4).
    fireEvent.pointerDown(block);
    const menu = await screen.findByRole('menu');
    expect(menu.textContent?.match(/workspace/gi)).toHaveLength(1);
  });

  it('opens the settings dialog from Workspace settings', async () => {
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Workspace settings…' }));
    expect(mockOpenSettings).toHaveBeenCalledOnce();
  });

  it('opens your own profile from Account', async () => {
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Account…' }));
    expect(mockOpenProfile).toHaveBeenCalledWith('me');
  });

  it('shows the running version in the menu once the server answers', async () => {
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    expect(await screen.findByRole('menuitem', { name: /v0\.58\.0 beta/ })).toBeInTheDocument();
  });

  it('keeps the installed app first and orders communities by the owner preference', async () => {
    mockConnections = [
      {
        ref: 'a',
        remoteCommunityId: 'remote-a',
        label: 'Alpha',
        pinnedOrigin: 'https://a.example.com',
        connectedHumanMemberId: 'person-a',
        status: 'connected',
        expiresAt: null,
      },
      {
        ref: 'b',
        remoteCommunityId: 'remote-b',
        label: 'Beta',
        pinnedOrigin: 'https://b.example.com',
        connectedHumanMemberId: 'person-b',
        status: 'connected',
        expiresAt: null,
      },
    ];
    mockCommunityOrder = ['b', 'a'];
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    const items = await screen.findAllByRole('menuitemradio');
    expect(items.slice(0, 3).map((item) => item.textContent)).toEqual([
      expect.stringContaining('Dorian’s team'),
      expect.stringContaining('Beta'),
      expect.stringContaining('Alpha'),
    ]);
  });

  it('reauthorizes the remembered destination before committing a Community route', async () => {
    mockConnections = [
      {
        ref: 'a',
        remoteCommunityId: 'remote-a',
        label: 'Alpha',
        pinnedOrigin: 'https://a.example.com',
        connectedHumanMemberId: 'person-a',
        status: 'connected',
        expiresAt: null,
      },
    ];
    mockResolveCommunityNavigation.mockResolvedValue({
      ref: 'a',
      roomId: 'general',
      threadId: 'thread-1',
      scrollAnchorEntryId: null,
    });
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Alpha/ }));
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/channels',
        search: { community: 'a', id: 'general', thread: 'thread-1' },
      })
    );
    expect(mockListRemoteCommunityRooms).not.toHaveBeenCalled();
  });

  it('re-reads and restores the owner’s local route only on explicit installation selection', async () => {
    mockSearch = { community: 'a' };
    mockConnections = [
      {
        ref: 'a',
        remoteCommunityId: 'remote-a',
        label: 'Alpha',
        pinnedOrigin: 'https://a.example.com',
        connectedHumanMemberId: 'person-a',
        status: 'connected',
        expiresAt: null,
      },
    ];
    mockGetCommunityNavigation.mockResolvedValue({
      ownerKey: 'owner-a',
      installationDestination: { path: '/tasks', search: { view: 'board' } },
      order: ['a'],
      destinations: [],
    });
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Dorian’s team/ }));

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/tasks', search: { view: 'board' } })
    );
    expect(mockGetCommunityNavigation).toHaveBeenCalledOnce();
  });

  it('discards a delayed installation route after the owner changes', async () => {
    let resolveNavigation!: (value: {
      ownerKey: string;
      installationDestination: { path: '/tasks'; search: {} };
      order: string[];
      destinations: [];
    }) => void;
    mockSearch = { community: 'a' };
    mockConnections = [
      {
        ref: 'a',
        remoteCommunityId: 'remote-a',
        label: 'Alpha',
        pinnedOrigin: 'https://a.example.com',
        connectedHumanMemberId: 'person-a',
        status: 'connected',
        expiresAt: null,
      },
    ];
    mockGetCommunityNavigation.mockReturnValue(
      new Promise((resolve) => {
        resolveNavigation = resolve;
      })
    );
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Dorian’s team/ }));
    await waitFor(() => expect(mockGetCommunityNavigation).toHaveBeenCalledOnce());

    const nextOwner = invalidateCommunityAuthority();
    confirmCommunityAuthority(nextOwner.epoch, 'owner-b');
    resolveNavigation({
      ownerKey: 'owner-a',
      installationDestination: { path: '/tasks', search: {} },
      order: [],
      destinations: [],
    });

    await waitFor(() =>
      expect(screen.getByTestId('sidebar-header-block')).not.toHaveAttribute('aria-busy')
    );
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('names and focuses the route-selected Community when the menu opens', async () => {
    mockSearch = { community: 'a' };
    mockConnections = [
      {
        ref: 'a',
        remoteCommunityId: 'remote-a',
        label: 'Alpha',
        pinnedOrigin: 'https://a.example.com',
        connectedHumanMemberId: 'person-a',
        status: 'connected',
        expiresAt: null,
      },
    ];
    renderBlock();
    const trigger = screen.getByTestId('sidebar-header-block');
    expect(trigger).toHaveAccessibleName('Alpha menu');
    fireEvent.pointerDown(trigger);
    const selected = await screen.findByRole('menuitemradio', { name: /Alpha/ });
    expect(selected).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(selected).toHaveFocus());
  });

  it('focuses the route-selected Community when the shortcut opens the menu', async () => {
    // Spec: "Opening focuses the selected row." Opening by shortcut skipped
    // the focus step that a click takes, so Radix left focus on the first row.
    mockSearch = { community: 'a' };
    mockConnections = [
      {
        ref: 'a',
        remoteCommunityId: 'remote-a',
        label: 'Alpha',
        pinnedOrigin: 'https://a.example.com',
        connectedHumanMemberId: 'person-a',
        status: 'connected',
        expiresAt: null,
      },
    ];
    renderBlock();
    await act(async () => undefined);
    fireEvent.keyDown(document.body, { key: 'K', metaKey: true, shiftKey: true });
    const selected = await screen.findByRole('menuitemradio', { name: /Alpha/ });
    expect(selected).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(selected).toHaveFocus());
  });

  it('returns to the prior route and says so when the target destination read fails', async () => {
    mockConnections = [
      {
        ref: 'a',
        remoteCommunityId: 'remote-a',
        label: 'Alpha',
        pinnedOrigin: 'https://a.example.com',
        connectedHumanMemberId: 'person-a',
        status: 'connected',
        expiresAt: null,
      },
    ];
    mockResolveCommunityNavigation.mockRejectedValue(new Error('offline'));
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Alpha/ }));
    await waitFor(() => expect(mockResolveCommunityNavigation).toHaveBeenCalledOnce());
    expect(mockNavigate).toHaveBeenNthCalledWith(1, {
      to: '/channels',
      search: { community: 'a' },
    });
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenNthCalledWith(2, {
        to: '/',
        search: {},
        replace: true,
      })
    );
    // "Switch request failure: remain in the old committed context …; announce the failure."
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Couldn’t open Alpha.', {
        description: 'You’re still where you were. Try again in a moment.',
      })
    );
  });

  it('reenables selection when the initial qualified navigation rejects', async () => {
    mockConnections = [
      {
        ref: 'a',
        remoteCommunityId: 'remote-a',
        label: 'Alpha',
        pinnedOrigin: 'https://a.example.com',
        connectedHumanMemberId: 'person-a',
        status: 'connected',
        expiresAt: null,
      },
    ];
    mockNavigate.mockRejectedValueOnce(new Error('navigation interrupted'));
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Alpha/ }));
    await waitFor(() =>
      expect(screen.getByTestId('sidebar-header-block')).not.toHaveAttribute('aria-busy')
    );
    expect(mockResolveCommunityNavigation).not.toHaveBeenCalled();
  });

  it('opens the remembered room after the qualified target commits', async () => {
    mockConnections = [
      {
        ref: 'a',
        remoteCommunityId: 'remote-a',
        label: 'Alpha',
        pinnedOrigin: 'https://a.example.com',
        connectedHumanMemberId: 'person-a',
        status: 'connected',
        expiresAt: null,
      },
    ];
    mockNavigate.mockImplementation(async ({ search }: { search?: { community?: string } }) => {
      if (search?.community === 'a') commitCommunityRouteEpoch('community:a');
    });
    mockResolveCommunityNavigation.mockResolvedValue({
      ref: 'a',
      roomId: 'general',
      threadId: 'thread-1',
      scrollAnchorEntryId: 'entry-4',
    });
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Alpha/ }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(2));
    expect(mockNavigate).toHaveBeenLastCalledWith({
      to: '/channels',
      search: { community: 'a', id: 'general', thread: 'thread-1' },
    });
  });

  it('opens from the global context shortcut, from a message box too', async () => {
    renderBlock();
    await act(async () => undefined);
    fireEvent.keyDown(document.body, { key: 'K', metaKey: true, shiftKey: true });
    expect(await screen.findByText('Switch context')).toBeVisible();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Switch context')).not.toBeInTheDocument());
    // Landing in a channel puts the cursor in its composer; the shortcut has
    // to work from there, or it is dead where people switch from.
    const composer = document.createElement('div');
    composer.setAttribute('contenteditable', 'true');
    composer.tabIndex = 0;
    document.body.append(composer);
    composer.focus();
    const event = createEvent.keyDown(composer, { key: 'K', metaKey: true, shiftKey: true });
    fireEvent(composer, event);
    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByText('Switch context')).toBeVisible();
    // Closing without choosing puts focus back in the message box.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Switch context')).not.toBeInTheDocument());
    await waitFor(() => expect(composer).toHaveFocus());
    composer.remove();
  });

  it('returns focus to the trigger when the message box is gone by the time the menu closes', async () => {
    renderBlock();
    await act(async () => undefined);
    const composer = document.createElement('div');
    composer.setAttribute('contenteditable', 'true');
    composer.tabIndex = 0;
    document.body.append(composer);
    composer.focus();
    fireEvent.keyDown(composer, { key: 'K', metaKey: true, shiftKey: true });
    expect(await screen.findByText('Switch context')).toBeVisible();
    // The page under the menu changes and the message box goes away.
    composer.remove();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Switch context')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('sidebar-header-block')).toHaveFocus());
  });

  it('leaves a key that is still composing text to the input method', async () => {
    renderBlock();
    await act(async () => undefined);
    fireEvent.keyDown(document.body, {
      key: 'K',
      metaKey: true,
      shiftKey: true,
      isComposing: true,
    });
    await act(async () => undefined);
    expect(screen.queryByText('Switch context')).not.toBeInTheDocument();
  });

  it('announces mentions separately from other unread activity', async () => {
    mockConnections = [
      {
        ref: 'a',
        remoteCommunityId: 'remote-a',
        label: 'Alpha',
        pinnedOrigin: 'https://a.example.com',
        connectedHumanMemberId: 'person-a',
        status: 'connected',
        expiresAt: null,
        attention: {
          state: 'verified',
          unreadCount: 5,
          mentionCount: 2,
          verifiedAt: '2026-09-21T12:00:00.000Z',
        },
      },
    ];
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    expect(await screen.findByLabelText('2 mentions')).toBeVisible();
    expect(screen.getByLabelText('3 other unread')).toBeVisible();
  });

  it('discards a delayed destination after the local owner changes', async () => {
    let resolveRemembered!: (value: {
      ref: string;
      roomId: string;
      threadId: null;
      scrollAnchorEntryId: null;
    }) => void;
    mockConnections = [
      {
        ref: 'a',
        remoteCommunityId: 'remote-a',
        label: 'Alpha',
        pinnedOrigin: 'https://a.example.com',
        connectedHumanMemberId: 'person-a',
        status: 'connected',
        expiresAt: null,
      },
    ];
    mockResolveCommunityNavigation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRemembered = resolve;
        })
    );
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Alpha/ }));
    await waitFor(() => expect(mockResolveCommunityNavigation).toHaveBeenCalledOnce());

    const nextOwner = invalidateCommunityAuthority();
    confirmCommunityAuthority(nextOwner.epoch, 'owner-b');
    resolveRemembered({
      ref: 'a',
      roomId: 'general',
      threadId: null,
      scrollAnchorEntryId: null,
    });

    await waitFor(() =>
      expect(screen.getByTestId('sidebar-header-block')).not.toHaveAttribute('aria-busy')
    );
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('discards a delayed destination after another route commits', async () => {
    let resolveRemembered!: (value: null) => void;
    mockConnections = [
      {
        ref: 'a',
        remoteCommunityId: 'remote-a',
        label: 'Alpha',
        pinnedOrigin: 'https://a.example.com',
        connectedHumanMemberId: 'person-a',
        status: 'connected',
        expiresAt: null,
      },
    ];
    mockResolveCommunityNavigation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRemembered = resolve;
        })
    );
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Alpha/ }));
    await waitFor(() => expect(mockResolveCommunityNavigation).toHaveBeenCalledOnce());

    commitCommunityRouteEpoch('test:other-route');
    resolveRemembered(null);

    await waitFor(() =>
      expect(screen.getByTestId('sidebar-header-block')).not.toHaveAttribute('aria-busy')
    );
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('lets a newer choice win: a failed read for the older one neither navigates back nor speaks', async () => {
    let rejectRemembered!: (error: Error) => void;
    mockConnections = [
      {
        ref: 'a',
        remoteCommunityId: 'remote-a',
        label: 'Alpha',
        pinnedOrigin: 'https://a.example.com',
        connectedHumanMemberId: 'person-a',
        status: 'connected',
        expiresAt: null,
      },
    ];
    mockResolveCommunityNavigation.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRemembered = reject;
        })
    );
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Alpha/ }));
    await waitFor(() => expect(mockResolveCommunityNavigation).toHaveBeenCalledOnce());

    // The person goes somewhere else (Back, a link) while Alpha's read waits.
    commitCommunityRouteEpoch('test:newer-choice');
    rejectRemembered(new Error('offline'));

    await waitFor(() =>
      expect(screen.getByTestId('sidebar-header-block')).not.toHaveAttribute('aria-busy')
    );
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says "still where you were" only once the way back has landed', async () => {
    mockConnections = [
      {
        ref: 'a',
        remoteCommunityId: 'remote-a',
        label: 'Alpha',
        pinnedOrigin: 'https://a.example.com',
        connectedHumanMemberId: 'person-a',
        status: 'connected',
        expiresAt: null,
      },
    ];
    mockResolveCommunityNavigation.mockRejectedValue(new Error('offline'));
    mockNavigate
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('navigation interrupted'));
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Alpha/ }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId('sidebar-header-block')).not.toHaveAttribute('aria-busy')
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('disables keyboard selection of the installation while a destination is pending', async () => {
    let resolveRemembered!: (value: null) => void;
    mockSearch = { community: 'b' };
    mockConnections = [
      {
        ref: 'a',
        remoteCommunityId: 'remote-a',
        label: 'Alpha',
        pinnedOrigin: 'https://a.example.com',
        connectedHumanMemberId: 'person-a',
        status: 'connected',
        expiresAt: null,
      },
      {
        ref: 'b',
        remoteCommunityId: 'remote-b',
        label: 'Beta',
        pinnedOrigin: 'https://b.example.com',
        connectedHumanMemberId: 'person-b',
        status: 'connected',
        expiresAt: null,
      },
    ];
    mockResolveCommunityNavigation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRemembered = resolve;
        })
    );
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Alpha/ }));
    await waitFor(() => expect(mockResolveCommunityNavigation).toHaveBeenCalledOnce());

    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    const installation = await screen.findByRole('menuitemradio', { name: /Dorian’s team/ });
    expect(installation).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(installation, { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledTimes(1);

    resolveRemembered(null);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/channels',
      search: { community: 'a' },
    });
  });

  it('grows the menu without moving anything outside it (BC-43)', async () => {
    // Three rows.
    mockMenuNodes = rows(3);
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    await screen.findByRole('menuitem', { name: 'Row 0' });
    expect(document.querySelectorAll('[role^="menuitem"]')).toHaveLength(5);
    const short = blockMarkup();
    cleanup();

    // Six — what "communities shipped" looks like from out here.
    mockMenuNodes = rows(6);
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    await screen.findByRole('menuitem', { name: 'Row 5' });
    // The menu really did get longer — otherwise the comparison below is a
    // comparison of two identical renders and proves nothing.
    expect(document.querySelectorAll('[role^="menuitem"]')).toHaveLength(8);

    expect(blockMarkup()).toBe(short);
  });

  it('asks the server again when you check for updates, and reports being current', async () => {
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    await screen.findByRole('menuitem', { name: /v0\.58\.0 beta/ });
    const asked = mockGetConfig.mock.calls.length;

    fireEvent.click(screen.getByRole('menuitem', { name: /v0\.58\.0 beta/ }));

    await waitFor(() => expect(mockGetConfig.mock.calls.length).toBeGreaterThan(asked));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('You’re up to date'));
  });

  it('names the newer release when the server has one', async () => {
    mockConfig = { version: '0.58.0', latestVersion: '0.59.0', isDevMode: false };
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /v0\.58\.0 beta/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Version 0.59.0 is available'));
  });
});

// ---------------------------------------------------------------------------
// D6 — the team name is reserved, never guessed
// ---------------------------------------------------------------------------

describe('the team name while the roster is still coming (spec `sidebar-simplification` D6)', () => {
  it('reserves the space instead of saying "Your team"', () => {
    // "Your team" is the honest answer for an install with no name to give. It
    // is the WRONG answer for the second before the roster lands, where the
    // name is known and simply has not arrived — a returning operator watching
    // their own name replace a placeholder.
    mockRosterPending = true;
    renderBlock();

    expect(screen.getByTestId('sidebar-team-name-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('Your team')).toBeNull();
    expect(screen.queryByText('Dorian’s team')).toBeNull();
    // …and the control is still named for a screen reader while it waits.
    expect(screen.getByTestId('sidebar-header-block')).toHaveAttribute(
      'aria-label',
      'Context menu'
    );
  });

  it('paints the name the moment the roster answers', () => {
    mockRosterPending = false;
    renderBlock();

    expect(screen.queryByTestId('sidebar-team-name-skeleton')).toBeNull();
    expect(screen.getByText('Dorian’s team')).toBeInTheDocument();
  });

  it('still says "Your team" for an install that genuinely has no name', () => {
    // The counter-proof: the placeholder is about the QUERY, not about the
    // answer. A roster that has answered with nobody gets the honest fallback,
    // not bones forever.
    mockRosterPending = false;
    mockSelf = null;
    renderBlock();

    expect(screen.queryByTestId('sidebar-team-name-skeleton')).toBeNull();
    expect(screen.getByText('Your team')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle actions (DOR-2185)
// ---------------------------------------------------------------------------

const all = { read: true, post: true, enrollAgent: true, stream: true };
const none = { read: false, post: false, enrollAgent: false, stream: false };

function alpha(
  overrides: Partial<(typeof mockConnections)[number]> = {}
): (typeof mockConnections)[number] {
  return {
    ref: 'a',
    remoteCommunityId: 'remote-a',
    label: 'Alpha',
    pinnedOrigin: 'https://a.example.com',
    connectedHumanMemberId: 'person-a',
    status: 'connected',
    expiresAt: null,
    access: {
      state: 'verified',
      effective: all,
      lastKnown: { lifecycle: 'active', capabilities: all, verifiedAt: '2026-09-21T00:00:00.000Z' },
    },
    ...overrides,
  };
}

/** Open the phone sheet on Alpha and return its "Manage Alpha" group. */
async function openManageAlpha() {
  mockSearch = { community: 'a' };
  renderMobileSwitcher();
  fireEvent.click(screen.getByTestId('sidebar-header-block'));
  await screen.findByRole('dialog');
  return screen.getByRole('group', { name: 'Manage Alpha' });
}

describe('the context switcher’s lifecycle actions', () => {
  it('opens invites, settings and leaving on the Community’s own site, at the right section', async () => {
    mockConnections = [alpha()];
    const manage = await openManageAlpha();
    // Every row that leaves the app says where, in its accessible name.
    for (const name of ['Invite people', 'Community settings', 'Leave community…'])
      expect(
        within(manage).getByRole('menuitem', { name: `${name}, opens on a.example.com` })
      ).toBeInTheDocument();
    // Disconnect stays in the app, so it carries no such cue.
    expect(within(manage).getByRole('menuitem', { name: 'Disconnect…' })).toBeInTheDocument();

    fireEvent.click(within(manage).getByRole('menuitem', { name: /Community settings/ }));
    expect(mockOpenExternalLink).toHaveBeenLastCalledWith(
      'https://a.example.com/c/remote-a/settings'
    );

    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(
      within(await screen.findByRole('group', { name: 'Manage Alpha' })).getByRole('menuitem', {
        name: /Invite people/,
      })
    );
    expect(mockOpenExternalLink).toHaveBeenLastCalledWith(
      'https://a.example.com/c/remote-a/settings/community'
    );

    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(
      within(await screen.findByRole('group', { name: 'Manage Alpha' })).getByRole('menuitem', {
        name: /Leave community/,
      })
    );
    expect(mockOpenExternalLink).toHaveBeenLastCalledWith(
      'https://a.example.com/c/remote-a/settings/account'
    );
    // None of them opened this DorkOS's own settings.
    expect(mockOpenSettings).not.toHaveBeenCalled();
  });

  it('opens this DorkOS’s settings, never a Community’s, from Workspace settings', async () => {
    mockConnections = [alpha()];
    await openManageAlpha();
    fireEvent.click(screen.getByRole('menuitem', { name: /Workspace settings/ }));
    expect(mockOpenSettings).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalLink).not.toHaveBeenCalled();
  });

  it('hides every action that needs the Community’s site while it is offline', async () => {
    mockConnections = [
      alpha({
        access: {
          state: 'unverified',
          effective: none,
          lastKnown: {
            lifecycle: 'active',
            capabilities: all,
            verifiedAt: '2026-09-21T00:00:00.000Z',
          },
        },
      }),
    ];
    const manage = await openManageAlpha();
    expect(within(manage).queryByRole('menuitem', { name: /Invite/ })).not.toBeInTheDocument();
    expect(within(manage).queryByRole('menuitem', { name: /settings/ })).not.toBeInTheDocument();
    expect(within(manage).queryByRole('menuitem', { name: /Leave/ })).not.toBeInTheDocument();
    // Disconnecting is local, so it still works offline.
    expect(within(manage).getByRole('menuitem', { name: /^Disconnect…$/ })).toBeInTheDocument();
  });

  it('offers no invitations for an archived Community, and still reaches its settings', async () => {
    mockConnections = [
      alpha({
        access: {
          state: 'verified',
          effective: { ...none, read: true },
          lastKnown: {
            lifecycle: 'archived',
            capabilities: { ...none, read: true },
            verifiedAt: '2026-09-21T00:00:00.000Z',
          },
        },
      }),
    ];
    const manage = await openManageAlpha();
    expect(within(manage).queryByRole('menuitem', { name: /Invite/ })).not.toBeInTheDocument();
    expect(
      within(manage).getByRole('menuitem', { name: /Community settings/ })
    ).toBeInTheDocument();
  });

  it('shows no Community actions while this DorkOS is selected', async () => {
    mockConnections = [alpha()];
    renderMobileSwitcher();
    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('group', { name: /Manage/ })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Add community' })).toBeInTheDocument();
  });

  it('confirms before disconnecting, and then leaves only the Community it disconnected', async () => {
    mockConnections = [alpha()];
    commitCommunityRouteEpoch(JSON.stringify(['community', 'a', null, null]));
    const manage = await openManageAlpha();
    fireEvent.click(within(manage).getByRole('menuitem', { name: /^Disconnect…$/ }));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Disconnect this DorkOS from Alpha?',
    });
    expect(confirm).toHaveTextContent('You stay a member of Alpha');
    expect(mockEndConnection).not.toHaveBeenCalled();

    // "Keep connected" changes nothing.
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep connected' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockEndConnection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(
      within(await screen.findByRole('group', { name: 'Manage Alpha' })).getByRole('menuitem', {
        name: /^Disconnect…$/,
      })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(mockEndConnection).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'a' }),
      expect.anything()
    );
    // The server confirmed: route away from the Community that is gone.
    act(() => mockEndConnection.mock.calls[0]![1].onSuccess());
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/', replace: true });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('stays put after disconnecting a Community that was not on screen', async () => {
    mockConnections = [alpha()];
    commitCommunityRouteEpoch(JSON.stringify(['community', 'b', null, null]));
    const manage = await openManageAlpha();
    fireEvent.click(within(manage).getByRole('menuitem', { name: /^Disconnect…$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    act(() => mockEndConnection.mock.calls[0]![1].onSuccess());
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('sends Connect to Connections and running your own server to the guide', async () => {
    renderMobileSwitcher();
    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    const add = within(await screen.findByRole('group', { name: 'Add community' }));
    fireEvent.click(add.getByRole('menuitem', { name: /Connect a community/ }));
    expect(mockOpenConnections).toHaveBeenCalledWith('messaging');

    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(
      within(await screen.findByRole('group', { name: 'Add community' })).getByRole('menuitem', {
        name: /Run your own community/,
      })
    );
    expect(mockOpenExternalLink).toHaveBeenCalledWith(
      'https://dorkos.ai/docs/guides/cli-usage#community-server'
    );
  });

  it('opens an invitation link on its own site, and refuses anything else', async () => {
    renderMobileSwitcher();
    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(
      within(await screen.findByRole('group', { name: 'Add community' })).getByRole('menuitem', {
        name: /Join with an invitation…/,
      })
    );
    const field = await screen.findByLabelText('Invitation link');
    for (const refused of [
      'http://a.example.com/c/remote-a/join#invite=secret',
      'https://someone:pw@a.example.com/c/remote-a/join#invite=secret',
    ]) {
      fireEvent.change(field, { target: { value: refused } });
      expect(screen.queryByText(/^Opens on/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Open invitation' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('That isn’t an invitation link.');
    }
    fireEvent.change(field, { target: { value: 'https://a.example.com/c/remote-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open invitation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That isn’t an invitation link.');
    expect(mockOpenExternalLink).not.toHaveBeenCalled();

    const link = 'https://a.example.com/c/remote-a/join#invite=secret';
    fireEvent.change(field, { target: { value: link } });
    // Where it will open is said before it opens.
    expect(screen.getByText('Opens on a.example.com')).toBeInTheDocument();
    expect(field).toHaveAccessibleDescription('Opens on a.example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Open invitation' }));
    expect(mockOpenExternalLink).toHaveBeenCalledWith(link);
    await waitFor(() => expect(screen.queryByLabelText('Invitation link')).not.toBeInTheDocument());
    // Joining is not pairing: nothing here connected this installation.
    expect(mockOpenConnections).not.toHaveBeenCalled();
  });

  it('sends a Community that needs reconnecting to Connections › Messaging', async () => {
    mockConnections = [alpha({ status: 'reconnect-required' })];
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Alpha/ }));
    expect(mockOpenConnections).toHaveBeenCalledWith('messaging');
  });

  it('offers Create a community only for a host that says the person runs it', async () => {
    mockConnections = [alpha()];
    renderMobileSwitcher();
    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    let add = within(await screen.findByRole('group', { name: 'Add community' }));
    expect(add.queryByRole('menuitem', { name: /Create a community/ })).not.toBeInTheDocument();
    cleanup();

    mockConnections = [alpha({ hostOperator: true })];
    renderMobileSwitcher();
    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    add = within(await screen.findByRole('group', { name: 'Add community' }));
    // In the spec's order: connect, join, create, then run your own.
    expect(add.getAllByRole('menuitem').map((row) => row.textContent)).toEqual([
      'Connect a community',
      'Join with an invitation…',
      'Create a community…, opens on a.example.com',
      'Run your own community',
    ]);
    fireEvent.click(
      add.getByRole('menuitem', { name: 'Create a community…, opens on a.example.com' })
    );
    // The host's own administration page, on the connection's pinned origin.
    expect(mockOpenExternalLink).toHaveBeenCalledWith('https://a.example.com/host');
    expect(mockOpenConnections).not.toHaveBeenCalled();
  });

  it('names each host when the person runs more than one, once per host', async () => {
    mockConnections = [
      alpha({ hostOperator: true }),
      alpha({ ref: 'a2', remoteCommunityId: 'remote-a2', label: 'Alpha Two', hostOperator: true }),
      alpha({
        ref: 'b',
        remoteCommunityId: 'remote-b',
        label: 'Beta',
        pinnedOrigin: 'https://b.example.com',
        hostOperator: true,
      }),
      alpha({
        ref: 'c',
        remoteCommunityId: 'remote-c',
        label: 'Gamma',
        pinnedOrigin: 'https://c.example.com',
      }),
    ];
    renderMobileSwitcher();
    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    const add = within(await screen.findByRole('group', { name: 'Add community' }));
    expect(
      add
        .getAllByRole('menuitem', { name: /^Create a community/ })
        .map((row) => row.getAttribute('data-menu-item-id'))
    ).toEqual(['add-community-create-a.example.com', 'add-community-create-b.example.com']);
    fireEvent.click(
      add.getByRole('menuitem', {
        name: 'Create a community on b.example.com…, opens on b.example.com',
      })
    );
    expect(mockOpenExternalLink).toHaveBeenCalledWith('https://b.example.com/host');
  });

  it('reaches Create a community from the keyboard in the desktop menu', async () => {
    mockSearch = { community: 'a' };
    mockConnections = [alpha({ hostOperator: true })];
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    const selected = await screen.findByRole('menuitemradio', { name: /Alpha/ });
    await waitFor(() => expect(selected).toHaveFocus());
    const manage = screen.getByRole('menuitem', { name: /Manage Alpha/ });
    fireEvent.keyDown(selected, { key: 'ArrowDown' });
    await waitFor(() => expect(manage).toHaveFocus());
    const add = screen.getByRole('menuitem', { name: /Add community/ });
    fireEvent.keyDown(manage, { key: 'ArrowDown' });
    await waitFor(() => expect(add).toHaveFocus());
    fireEvent.keyDown(add, { key: 'ArrowRight' });
    const create = await screen.findByRole('menuitem', {
      name: 'Create a community…, opens on a.example.com',
    });
    fireEvent.keyDown(create, { key: 'Enter' });
    expect(mockOpenExternalLink).toHaveBeenCalledWith('https://a.example.com/host');
  });

  it('reaches the Community’s actions from the keyboard in the desktop menu', async () => {
    mockSearch = { community: 'a' };
    mockConnections = [alpha()];
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    // Opening focuses the selected row one frame later; let that settle so it
    // cannot pull focus back off the submenu trigger.
    const selected = await screen.findByRole('menuitemradio', { name: /Alpha/ });
    await waitFor(() => expect(selected).toHaveFocus());
    const trigger = screen.getByRole('menuitem', { name: /Manage Alpha/ });
    fireEvent.keyDown(selected, { key: 'ArrowDown' });
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.keyDown(trigger, { key: 'ArrowRight' });
    const settings = await screen.findByRole('menuitem', { name: /Community settings/ });
    fireEvent.keyDown(settings, { key: 'Enter' });
    expect(mockOpenExternalLink).toHaveBeenCalledWith('https://a.example.com/c/remote-a/settings');
  });
});
