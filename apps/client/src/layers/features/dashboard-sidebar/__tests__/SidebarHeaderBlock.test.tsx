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
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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
const mockNavigate = vi.fn(() => Promise.resolve());
const mockResolveCommunityNavigation = vi.fn();
const mockListRemoteCommunityRooms = vi.fn();
const mockMoveCommunityNavigation = vi.fn();
const mockSetGlobalPaletteOpen = vi.fn();
let mockSearch: { community?: string } = {};
let mockConnections: Array<{
  ref: string;
  remoteCommunityId: string;
  label: string;
  pinnedOrigin: string;
  connectedHumanMemberId: string | null;
  status: 'pending' | 'connected' | 'reconnect-required';
  expiresAt: string | null;
}> = [];
let mockCommunityOrder: string[] = [];
let mockConfig: { version?: string; latestVersion?: string | null; isDevMode?: boolean } = {
  version: '0.58.0',
  latestVersion: null,
  isDevMode: false,
};
const mockGetConfig = vi.fn(() => Promise.resolve(mockConfig));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useTransport: () => ({
      getConfig: mockGetConfig,
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
      select({ location: { search: mockSearch } }),
  };
});
vi.mock('@/layers/entities/community', () => ({
  useCommunityConnections: () => ({ data: mockConnections }),
  useCommunityNavigation: () => ({ data: { ownerKey: 'owner-a', order: mockCommunityOrder } }),
  useMoveCommunityNavigation: () => ({ mutate: mockMoveCommunityNavigation }),
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
  mockSearch = {};
  mockConnections = [];
  mockCommunityOrder = [];
  mockResolveCommunityNavigation.mockResolvedValue(null);
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
    expect(screen.getByRole('button', { name: /Add community/ })).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Move Community 4 up' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Move Community 4 up' }));
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

  it('leaves the committed route unchanged when target reauthorization fails', async () => {
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
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Couldn’t open Alpha'));
    expect(mockNavigate).not.toHaveBeenCalled();
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
    expect(mockNavigate).not.toHaveBeenCalled();
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
    expect(mockNavigate).not.toHaveBeenCalled();
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
    expect(mockNavigate).not.toHaveBeenCalled();

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
