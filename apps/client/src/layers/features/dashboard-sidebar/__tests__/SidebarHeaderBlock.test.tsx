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
import type { CommunityConnectionOwnerNotice } from '@dorkos/shared/community-connections';
import { spacesExperiment } from '@dorkos/test-utils/mock-factories';
import { confirmCommunityAuthority, invalidateCommunityAuthority } from '@/layers/shared/lib';
import { commitCommunityRouteEpoch, configKeys } from '@/layers/shared/model';
import { PageHeading, type SidebarMenuNode } from '@/layers/shared/ui';
import {
  buildHeaderBlockIdentityNodes,
  buildHeaderBlockVersionNodes,
} from '../ui/header-block-menu';
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
vi.mock('@/layers/entities/team', async (importOriginal) => ({
  teamMemberFace: (await importOriginal<typeof import('@/layers/entities/team')>()).teamMemberFace,
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
let mockCloudLinked = false;
let mockCloudAccountLabel: string | null = null;
const mockGetCloudStatus = vi.fn(() =>
  Promise.resolve({
    linked: mockCloudLinked,
    accountLabel: mockCloudAccountLabel,
    lastHeartbeatAt: null,
  })
);
const mockGetCloudPlan = vi.fn(() => Promise.resolve({ available: false }));
const mockListHostedCommunities = vi.fn(() =>
  Promise.resolve({ available: true, communities: [], moves: [], allowance: null })
);
/** Where the linked account signs a person in; none unless a test says so. */
const mockGetCommunityAccountSignIn = vi.fn(() =>
  Promise.resolve<{ available: false } | { available: true; origins: string[] }>({
    available: false,
  })
);
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
  ownerNotice?: CommunityConnectionOwnerNotice;
  attention?: {
    state: 'verified' | 'stale' | 'unavailable';
    unreadCount: number | null;
    mentionCount: number | null;
    verifiedAt: string | null;
  };
}> = [];
let mockCommunityOrder: string[] = [];
let mockConfig: {
  version?: string;
  latestVersion?: string | null;
  isDevMode?: boolean;
  experiments?: ReturnType<typeof spacesExperiment>;
  officialSpace?: { url: string } | null;
} = {
  version: '0.58.0',
  latestVersion: null,
  isDevMode: false,
  experiments: spacesExperiment(true),
};
const mockGetConfig = vi.fn(() => Promise.resolve(mockConfig));
const mockOpenExternalLink = vi.fn((_href: string) => true);
vi.mock('@/layers/shared/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/lib')>();
  return { ...actual, openExternalLink: (href: string) => mockOpenExternalLink(href) };
});
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
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
      getCloudStatus: mockGetCloudStatus,
      getCloudPlan: mockGetCloudPlan,
      listHostedCommunities: mockListHostedCommunities,
      getCommunityAccountSignIn: mockGetCommunityAccountSignIn,
      // The official-space reads list connections over the real hook.
      listCommunityConnections: () => Promise.resolve(mockConnections),
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
/** What the Disconnect confirmation reads about the agents it would remove. */
let mockDisconnectImpact: {
  data?: { agents: { localAgentId: string; displayName: string | null }[] };
  isError: boolean;
  fetchStatus: 'fetching' | 'idle';
  refetch: () => void;
} = { data: { agents: [] }, isError: false, fetchStatus: 'idle', refetch: () => {} };
vi.mock('@/layers/entities/community', async (importOriginal) => ({
  // The real wording, so the confirmation and warnings below are checked against what people see.
  disconnectAgentsLine: (await importOriginal<typeof import('@/layers/entities/community')>())
    .disconnectAgentsLine,
  disconnectOutcome: (await importOriginal<typeof import('@/layers/entities/community')>())
    .disconnectOutcome,
  unknownDisconnectAgentsLine: (
    await importOriginal<typeof import('@/layers/entities/community')>()
  ).unknownDisconnectAgentsLine,
  useCommunityDisconnectImpact: () => mockDisconnectImpact,
  openOwnerNotice: (await importOriginal<typeof import('@/layers/entities/community')>())
    .openOwnerNotice,
  useCommunityConnections: () => ({ data: mockConnections }),
  useCommunityNavigation: () => ({ data: { ownerKey: 'owner-a', order: mockCommunityOrder } }),
  useMoveCommunityNavigation: () => ({ mutate: mockMoveCommunityNavigation }),
  // The hosted-community dialogs pair through these; no test here gets that far.
  useConfirmedCommunityAuthority: () => null,
  communityKeys: (await importOriginal<typeof import('@/layers/entities/community')>())
    .communityKeys,
  withinCommunityAuthority: (_authority: unknown, run: () => unknown) => run(),
  // The connect dialog reads the app-level approval watcher; none runs here.
  communityOwnerAddress: () => '',
  useCommunityApprovalStore: (await importOriginal<typeof import('@/layers/entities/community')>())
    .useCommunityApprovalStore,
  useCommunityApprovalCheck: () => ({ error: null, isFetching: false, retry: () => {} }),
  // The real read, over the mocked transport, so a test decides where the account signs in.
  useCommunityAccountSignIn: (await importOriginal<typeof import('@/layers/entities/community')>())
    .useCommunityAccountSignIn,
  useShowCommunityApproval: () => {},
  // The official-space rules (spec `official-community-space` D5), real, over the config above.
  isSpaceVisible: (await importOriginal<typeof import('@/layers/entities/community')>())
    .isSpaceVisible,
  useSpaceVisible: (await importOriginal<typeof import('@/layers/entities/community')>())
    .useSpaceVisible,
  useOfficialSpaceOffer: (await importOriginal<typeof import('@/layers/entities/community')>())
    .useOfficialSpaceOffer,
  useJoinSpaceRequest: (await importOriginal<typeof import('@/layers/entities/community')>())
    .useJoinSpaceRequest,
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

/** Rows below the destinations this render should show, or `null` for the real builder. */
let mockMenuNodes: SidebarMenuNode[] | null = null;
vi.mock('../ui/header-block-menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/header-block-menu')>();
  return {
    ...actual,
    buildHeaderBlockVersionNodes: (
      model: Parameters<typeof actual.buildHeaderBlockVersionNodes>[0]
    ) => mockMenuNodes ?? actual.buildHeaderBlockVersionNodes(model),
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
  mockDisconnectImpact = {
    data: { agents: [] },
    isError: false,
    fetchStatus: 'idle',
    refetch: vi.fn(),
  };
  vi.clearAllMocks();
  mockSelf = { id: 'me', displayName: 'Dorian', isSelf: true };
  mockConfig = {
    version: '0.58.0',
    latestVersion: null,
    isDevMode: false,
    experiments: spacesExperiment(true),
  };
  mockMenuNodes = null;
  mockRosterPending = false;
  mockIsMobile = false;
  mockPathname = '/';
  mockSearch = {};
  mockConnections = [];
  mockCommunityOrder = [];
  mockCloudLinked = false;
  mockCloudAccountLabel = null;
  mockGetCommunityAccountSignIn.mockResolvedValue({ available: false });
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

/** The query client of the last render, so a test can wait on its config read. */
let renderedClient: QueryClient | null = null;

/**
 * Wait for the config read to answer. Space rows wait for it (DOR-2740), so a
 * test about them opens the menu once it has, as anyone in the app would.
 */
async function configAnswered() {
  await waitFor(() =>
    expect(renderedClient?.getQueryState(configKeys.current())?.status).toBe('success')
  );
}

function renderBlock() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderedClient = client;
  return render(
    <QueryClientProvider client={client}>
      <SidebarHeaderBlock />
    </QueryClientProvider>
  );
}

function renderMobileSwitcher() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderedClient = client;
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

describe('buildHeaderBlockIdentityNodes', () => {
  const base = {
    you: { name: 'Dorian', face: null, onOpen: () => {} },
    accountStatus: 'Not signed in',
    onOpenAccount: () => {},
    onOpenSettings: () => {},
  };

  it('reads you, your DorkOS account, then Settings (DOR-2628)', () => {
    expect(buildHeaderBlockIdentityNodes(base).map((n) => n.id)).toEqual([
      'you',
      'dorkos-account',
      'settings',
    ]);
  });

  it('drops the you row when the roster names nobody, rather than offering a dead row', () => {
    expect(buildHeaderBlockIdentityNodes({ ...base, you: null }).map((n) => n.id)).toEqual([
      'dorkos-account',
      'settings',
    ]);
  });
});

describe('buildHeaderBlockVersionNodes', () => {
  const base = { version: '0.58.0', isDevMode: false, onCheckForUpdates: () => {} };

  it('says "Development build" instead of a number nobody can update to', () => {
    const nodes = buildHeaderBlockVersionNodes({ ...base, isDevMode: true });
    expect(nodes.find((n) => n.id === 'version')).toMatchObject({
      kind: 'note',
      text: 'Development build',
    });
  });
});

// ---------------------------------------------------------------------------
// The block itself
// ---------------------------------------------------------------------------

describe('teamNameFor', () => {
  it('names the cockpit after the operator', () => {
    expect(teamNameFor('Dorian')).toBe('Dorian’s team');
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
    await configAnswered();
    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Dorian’s team/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('radio', { name: /Alpha/ })).toBeInTheDocument();
    // "Add a space" is a menu of distinct paths, flattened into a named
    // group on a phone rather than a second popup over the sheet.
    const add = screen.getByRole('group', { name: 'Add a space' });
    expect(within(add).getByRole('menuitem', { name: /Join a space…/ })).toBeInTheDocument();
    expect(within(add).getByRole('group', { name: 'Advanced' })).toBeInTheDocument();
    expect(
      within(add).getByRole('menuitem', { name: /Run your own space server/ })
    ).toBeInTheDocument();
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
    const search = await screen.findByRole('searchbox', { name: 'Find a space' });
    const manage = screen.getByRole('group', { name: 'Manage Community 4' });
    expect(within(manage).getByRole('menuitem', { name: /Move down/ })).toBeInTheDocument();
    fireEvent.click(within(manage).getByRole('menuitem', { name: /Move up/ }));
    expect(mockMoveCommunityNavigation).toHaveBeenCalledWith({
      ref: 'community-4',
      direction: 'up',
    });

    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Find a space' }), {
      target: { value: 'Community 7' },
    });
    expect(screen.getByRole('radio', { name: /Community 7/ })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Community 1/ })).not.toBeInTheDocument();
    expect(search).not.toBeInTheDocument();
  });

  it('is a button named after the operator, with the New button and the ⌘K pill beside it', async () => {
    renderBlock();
    const block = await screen.findByRole('button', { name: /Dorian’s team/ });
    expect(block.tagName).toBe('BUTTON');
    expect(block).toHaveTextContent('Dorian’s team');
    expect(screen.getByTestId('new-menu')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-search-pill')).toBeInTheDocument();
  });

  it('opens the settings dialog from Settings', async () => {
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Settings' }));
    expect(mockOpenSettings).toHaveBeenCalledWith();
  });

  it('opens your own profile from the row with your name', async () => {
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Dorian\s*View profile$/ }));
    expect(mockOpenProfile).toHaveBeenCalledWith('me');
  });

  it('opens Settings › DorkOS account from its row, and says when you are not signed in', async () => {
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    const row = await screen.findByRole('menuitem', { name: /DorkOS account/ });
    await waitFor(() => expect(row).toHaveTextContent('Not signed in'));
    fireEvent.click(row);
    expect(mockOpenSettings).toHaveBeenCalledWith('account');
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

  it('names a hub’s own space Private, for just you and your agents (A6)', async () => {
    mockConfig = { ...mockConfig, serverRole: 'hub' } as typeof mockConfig;
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
    await configAnswered();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    const [own] = await screen.findAllByRole('menuitemradio');
    expect(own!.textContent).toContain('Private');
    expect(own!.textContent).toContain('Just you and your agents');
    expect(own!.textContent).not.toContain('team');
    // The desktop trigger carries the lock and the line too.
    const trigger = screen.getByTestId('sidebar-header-block');
    expect(trigger).toHaveAttribute('title', 'Just you and your agents');
    expect(trigger.querySelector('svg.lucide-lock')).not.toBeNull();
  });

  it('waits for the server before naming itself, so a hub never flashes a team name', () => {
    mockGetConfig.mockReturnValueOnce(new Promise(() => {}));
    renderBlock();
    expect(screen.getByTestId('sidebar-team-name-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('Dorian’s team')).toBeNull();
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
    await configAnswered();
    const trigger = screen.getByTestId('sidebar-header-block');
    expect(trigger).toHaveAccessibleName('Alpha menu');
    fireEvent.pointerDown(trigger);
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
    // Both counts are said once, in words, on the description line; the one
    // pill (mentions, orange) is hidden from a screen reader so it is not
    // read twice, and the other unread gets no second number.
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(menu).toHaveTextContent('2 mentions, 3 other unread'));
    const pill = menu.querySelector('[data-slot="count-pill"]');
    expect(pill).toHaveTextContent('2');
    expect(pill).toHaveAttribute('aria-hidden', 'true');
    expect(pill).toHaveAttribute('data-tone', 'you');
  });

  // DOR-2543. Only the owner's connection carries a notice, and its row is the one with the dot.
  // Fails if the dot were drawn for a member, or not drawn for the owner.
  it('marks the owner’s community with a warning dot when someone asked to take it over', async () => {
    const community = (ref: string, label: string) => ({
      ref,
      remoteCommunityId: `remote-${ref}`,
      label,
      pinnedOrigin: `https://${ref}.example.com`,
      connectedHumanMemberId: `person-${ref}`,
      status: 'connected' as const,
      expiresAt: null,
    });
    mockConnections = [
      {
        ...community('a', 'Alpha'),
        ownerNotice: {
          state: 'open',
          replacementId: 'replacement-a',
          requestState: 'waiting',
          requestedAt: '2026-09-20T10:00:00.000Z',
          claimableAfter: '2026-10-04T10:00:00.000Z',
          claimReissuedAt: null,
          options: { keep: true, transfer: true, delete: true, needsPassword: false },
        },
      },
      community('b', 'Beta'),
      {
        ...community('c', 'Gamma'),
        // A completed request is news for the Inbox, never a dot.
        ownerNotice: {
          state: 'completed',
          replacementId: 'replacement-c',
          newOwnerDisplayName: 'Riley',
          completedAt: '2026-10-05T09:00:00.000Z',
        },
      },
    ];
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    const alpha = (await screen.findByText('Alpha')).closest('[role="menuitemradio"]');
    const beta = screen.getByText('Beta').closest('[role="menuitemradio"]');
    const gamma = screen.getByText('Gamma').closest('[role="menuitemradio"]');
    expect(within(gamma as HTMLElement).queryByRole('img')).not.toBeInTheDocument();
    expect(
      within(alpha as HTMLElement).getByRole('img', {
        name: 'Someone asked to take over this space',
      })
    ).toBeVisible();
    expect(within(beta as HTMLElement).queryByRole('img')).not.toBeInTheDocument();
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

  it('grows the menu without moving anything outside it (BC-43)', async () => {
    // Three rows.
    mockMenuNodes = rows(3);
    renderBlock();
    await configAnswered();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    await screen.findByRole('menuitem', { name: 'Row 0' });
    // 3 rows + the installation + the add-a-community row + you, DorkOS
    // account and Settings above the destinations.
    expect(document.querySelectorAll('[role^="menuitem"]')).toHaveLength(8);
    const short = blockMarkup();
    cleanup();

    // Six — what "communities shipped" looks like from out here.
    mockMenuNodes = rows(6);
    renderBlock();
    await configAnswered();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    await screen.findByRole('menuitem', { name: 'Row 5' });
    // The menu really did get longer — otherwise the comparison below is a
    // comparison of two identical renders and proves nothing.
    expect(document.querySelectorAll('[role^="menuitem"]')).toHaveLength(11);

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
  await configAnswered();
  fireEvent.click(screen.getByTestId('sidebar-header-block'));
  await screen.findByRole('dialog');
  return screen.getByRole('group', { name: 'Manage Alpha' });
}

describe('the context switcher’s lifecycle actions', () => {
  it('opens invites, settings and leaving on the Community’s own site, at the right section', async () => {
    mockConnections = [alpha()];
    const manage = await openManageAlpha();
    // Every row that leaves the app says where, in its accessible name.
    for (const name of ['Invite people', 'Space settings', 'Leave space…'])
      expect(
        within(manage).getByRole('menuitem', { name: `${name}, opens on a.example.com` })
      ).toBeInTheDocument();
    // Disconnect stays in the app, so it carries no such cue.
    expect(within(manage).getByRole('menuitem', { name: 'Disconnect…' })).toBeInTheDocument();

    fireEvent.click(within(manage).getByRole('menuitem', { name: /^Space settings/ }));
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
        name: /Leave space/,
      })
    );
    expect(mockOpenExternalLink).toHaveBeenLastCalledWith(
      'https://a.example.com/c/remote-a/settings/account'
    );
    // None of them opened this DorkOS's own settings.
    expect(mockOpenSettings).not.toHaveBeenCalled();
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
    act(() =>
      mockEndConnection.mock.calls[0]![1].onSuccess({ remoteRevoked: true, agentsNotRemoved: [] })
    );
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/', replace: true });
    expect(toast.success).toHaveBeenCalledWith('Alpha is disconnected.');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  // DOR-2603. Purpose: Disconnect removes the agents this app added to the Community, so the
  // confirmation must say so and name them, and the result must name any left behind. Fails if the
  // confirmation hides the agents, lets Disconnect run before it knows them, or a left-behind agent
  // goes unmentioned.
  it('names the agents Disconnect will remove before the person confirms', async () => {
    mockConnections = [alpha()];
    mockDisconnectImpact = {
      data: {
        agents: [
          { localAgentId: 'scout', displayName: 'Scout' },
          { localAgentId: 'echo', displayName: 'Echo' },
        ],
      },
      isError: false,
      fetchStatus: 'idle',
      refetch: vi.fn(),
    };
    const manage = await openManageAlpha();
    fireEvent.click(within(manage).getByRole('menuitem', { name: /^Disconnect…$/ }));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Disconnect this DorkOS from Alpha?',
    });
    expect(confirm).toHaveAccessibleDescription(
      expect.stringContaining(
        'The 2 agents you added from here will be removed from Alpha: Scout and Echo.'
      )
    );
    expect(confirm).toHaveTextContent('You stay a member of Alpha');
  });

  it('says so when it cannot check the agents, and still lets the person disconnect', async () => {
    mockConnections = [alpha()];
    const refetch = vi.fn();
    mockDisconnectImpact = { data: undefined, isError: true, fetchStatus: 'idle', refetch };
    const manage = await openManageAlpha();
    fireEvent.click(within(manage).getByRole('menuitem', { name: /^Disconnect…$/ }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByRole('alert')).toHaveTextContent(
      'Couldn’t check which of your agents are on Alpha.'
    );
    // Disconnect removes them either way, so the confirmation says that much.
    expect(confirm).toHaveTextContent('Any agents you added from here will be removed from Alpha.');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Check again' }));
    expect(refetch).toHaveBeenCalled();
    expect(within(confirm).getByRole('button', { name: 'Disconnect' })).toBeEnabled();
  });

  it('names the agents it could not remove when the Community could not be reached', async () => {
    mockConnections = [alpha()];
    mockDisconnectImpact = {
      data: { agents: [{ localAgentId: 'scout', displayName: 'Scout' }] },
      isError: false,
      fetchStatus: 'idle',
      refetch: vi.fn(),
    };
    const manage = await openManageAlpha();
    fireEvent.click(within(manage).getByRole('menuitem', { name: /^Disconnect…$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    act(() =>
      mockEndConnection.mock.calls[0]![1].onSuccess({
        remoteRevoked: false,
        agentsNotRemoved: [{ localAgentId: 'scout', displayName: 'Scout' }],
      })
    );
    expect(toast.warning).toHaveBeenCalledWith(
      'Disconnected here, but Alpha couldn’t be reached. Remove Scout and this DorkOS there.',
      expect.anything()
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('connects a space in place and sends running your own server to the guide', async () => {
    renderMobileSwitcher();
    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    const add = within(await screen.findByRole('group', { name: 'Add a space' }));
    fireEvent.click(add.getByRole('menuitem', { name: /Join a space…/ }));
    // The form opens here; nothing sends the person to Connections.
    expect(await screen.findByLabelText('Space address or invitation link')).toBeInTheDocument();
    expect(screen.getByLabelText('Name for this installation')).toBeInTheDocument();
    expect(mockOpenConnections).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByLabelText('Space address or invitation link')).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(
      within(await screen.findByRole('group', { name: 'Add a space' })).getByRole('menuitem', {
        name: /Run your own space server/,
      })
    );
    expect(mockOpenExternalLink).toHaveBeenCalledWith(
      'https://dorkos.ai/docs/self-hosting/space-server'
    );
  });

  // Purpose: linked, Start and Join lead and Your spaces carries the move
  // (spec §4). Fails if Move comes back as its own row, Your spaces hides
  // behind having a space already, or Start stops opening its form.
  it('offers Start and Your spaces while linked; Your spaces offers Move one here', async () => {
    mockCloudLinked = true;
    renderMobileSwitcher();
    await waitFor(() => expect(mockListHostedCommunities).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    const add = within(await screen.findByRole('group', { name: 'Add a space' }));
    expect(add.getAllByRole('menuitem').map((row) => row.textContent)).toEqual([
      'Start a space…',
      'Join a space…',
      'Your spaces',
      'Run your own space server',
    ]);
    fireEvent.click(add.getByRole('menuitem', { name: /Start a space…/ }));
    expect(await screen.findByLabelText('Space name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start space' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(
      within(await screen.findByRole('group', { name: 'Add a space' })).getByRole('menuitem', {
        name: 'Your spaces',
      })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Move one here' }));
    expect(await screen.findByText('First, export the old space:')).toBeInTheDocument();
  });

  // Purpose: Join is one flow (spec §4). An invitation opens on the space's
  // site and the form stays on Connect with the space's address filled in,
  // the invite left out; an address connects. Fails if an invitation pairs
  // nothing and closes, if the invite is kept, or if a lookalike link opens.
  it('opens an invitation on its own site, then stays on Connect with the address filled', async () => {
    renderMobileSwitcher();
    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(
      within(await screen.findByRole('group', { name: 'Add a space' })).getByRole('menuitem', {
        name: /Join a space…/,
      })
    );
    const field = await screen.findByLabelText('Space address or invitation link');
    // Not invitations: plain http off this machine, and a link carrying a sign-in.
    // Each is treated as an address, so it is never opened as an invite.
    for (const notInvite of [
      'http://a.example.com/c/remote-a/join#invite=secret',
      'https://someone:pw@a.example.com/c/remote-a/join#invite=secret',
    ]) {
      fireEvent.change(field, { target: { value: notInvite } });
      expect(screen.queryByRole('button', { name: 'Open invitation' })).not.toBeInTheDocument();
    }
    expect(mockOpenExternalLink).not.toHaveBeenCalled();

    const link = 'https://a.example.com/c/remote-a/join#invite=secret';
    fireEvent.change(field, { target: { value: link } });
    fireEvent.click(screen.getByRole('button', { name: 'Open invitation' }));
    expect(mockOpenExternalLink).toHaveBeenCalledWith(link);
    // Back on Connect: the space's own address, never the invite.
    expect(field).toHaveValue('https://a.example.com/c/remote-a');
    expect(field).toHaveAccessibleDescription(
      'Finish joining on a.example.com in the new tab, then connect.'
    );
    // Connect waits for this DorkOS's owner, which this test never confirms.
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(mockOpenConnections).not.toHaveBeenCalled();
  });

  it('opens a Community that needs reconnecting in the connect dialog, not Connections', async () => {
    mockConnections = [alpha({ status: 'reconnect-required' })];
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Alpha/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Reconnect Alpha' });
    expect(mockOpenConnections).not.toHaveBeenCalled();
    // Selecting it does not try to enter a Community it cannot reach.
    expect(mockNavigate).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(mockEndConnection).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'a', status: 'reconnect-required' }),
      expect.anything()
    );
  });

  it('offers Create a space, under Advanced, only for a server that says the person runs it', async () => {
    mockConnections = [alpha()];
    renderMobileSwitcher();
    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    let add = within(await screen.findByRole('group', { name: 'Add a space' }));
    expect(add.queryByRole('menuitem', { name: /Create a space/ })).not.toBeInTheDocument();
    cleanup();

    mockConnections = [alpha({ hostOperator: true })];
    renderMobileSwitcher();
    fireEvent.click(screen.getByTestId('sidebar-header-block'));
    add = within(await screen.findByRole('group', { name: 'Add a space' }));
    // In the spec's order: join, then the self-run paths under Advanced.
    expect(add.getAllByRole('menuitem').map((row) => row.textContent)).toEqual([
      'Join a space…',
      'Create a space on your server…, opens on a.example.com',
      'Run your own space server',
    ]);
    fireEvent.click(
      add.getByRole('menuitem', {
        name: 'Create a space on your server…, opens on a.example.com',
      })
    );
    // The host's own administration page, on the connection's pinned origin.
    expect(mockOpenExternalLink).toHaveBeenCalledWith('https://a.example.com/host');
    expect(mockOpenConnections).not.toHaveBeenCalled();
  });

  it('reaches Create a space from the keyboard in the desktop menu, through Advanced', async () => {
    mockSearch = { community: 'a' };
    mockConnections = [alpha({ hostOperator: true })];
    renderBlock();
    await configAnswered();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    const selected = await screen.findByRole('menuitemradio', { name: /Alpha/ });
    await waitFor(() => expect(selected).toHaveFocus());
    const manage = screen.getByRole('menuitem', { name: /Manage Alpha/ });
    fireEvent.keyDown(selected, { key: 'ArrowDown' });
    await waitFor(() => expect(manage).toHaveFocus());
    const add = screen.getByRole('menuitem', { name: /Add a space/ });
    fireEvent.keyDown(manage, { key: 'ArrowDown' });
    await waitFor(() => expect(add).toHaveFocus());
    fireEvent.keyDown(add, { key: 'ArrowRight' });
    const join = await screen.findByRole('menuitem', { name: /Join a space…/ });
    await waitFor(() => expect(join).toHaveFocus());
    const advanced = screen.getByRole('menuitem', { name: 'Advanced' });
    fireEvent.keyDown(join, { key: 'ArrowDown' });
    await waitFor(() => expect(advanced).toHaveFocus());
    fireEvent.keyDown(advanced, { key: 'ArrowRight' });
    const create = await screen.findByRole('menuitem', {
      name: 'Create a space on your server…, opens on a.example.com',
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
    const settings = await screen.findByRole('menuitem', { name: /^Space settings/ });
    fireEvent.keyDown(settings, { key: 'Enter' });
    expect(mockOpenExternalLink).toHaveBeenCalledWith('https://a.example.com/c/remote-a/settings');
  });
});

/**
 * "Selecting closes the sheet, commits navigation, and moves focus to the new
 * page heading" (spec, Phone and narrow widths; DOR-2240). The page under the
 * switcher is a stand-in `main` with the heading the real page draws; the
 * switcher is real, sheet and all.
 */
describe('focus after a phone choice', () => {
  function renderOnPage({ mobile }: { mobile: boolean }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockIsMobile = mobile;
    return render(
      <QueryClientProvider client={client}>
        {mobile ? <MobileCommunityContextSwitcher /> : <SidebarHeaderBlock />}
        <main>
          <PageHeading>Alpha · General</PageHeading>
          <button type="button">Message box</button>
        </main>
      </QueryClientProvider>
    );
  }

  const heading = () => screen.getByRole('heading', { level: 1, name: 'Alpha · General' });
  const trigger = () => screen.getByTestId('sidebar-header-block');
  const idle = () => waitFor(() => expect(trigger()).not.toHaveAttribute('aria-busy'));
  /** Let the sheet finish closing and every queued frame run. */
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

  beforeEach(() => {
    mockConnections = [alpha()];
    mockResolveCommunityNavigation.mockResolvedValue({
      ref: 'a',
      roomId: 'general',
      threadId: null,
      scrollAnchorEntryId: null,
    });
  });

  it('lands on the new page’s heading once the switch has committed', async () => {
    renderOnPage({ mobile: true });
    fireEvent.click(trigger());
    fireEvent.click(await screen.findByRole('radio', { name: /Alpha/ }));
    await idle();
    await settle();
    expect(mockNavigate).toHaveBeenLastCalledWith({
      to: '/channels',
      search: { community: 'a', id: 'general' },
    });
    expect(heading()).toHaveFocus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stays off the heading when the switch fails, and returns to the trigger', async () => {
    mockResolveCommunityNavigation.mockRejectedValue(new Error('offline'));
    renderOnPage({ mobile: true });
    fireEvent.click(trigger());
    fireEvent.click(await screen.findByRole('radio', { name: /Alpha/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await idle();
    await settle();
    expect(heading()).not.toHaveFocus();
    expect(trigger()).toHaveFocus();
  });

  it('never takes focus back from something the person focused while it loaded', async () => {
    let resolveRemembered!: (value: null) => void;
    mockResolveCommunityNavigation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRemembered = resolve;
        })
    );
    mockListRemoteCommunityRooms.mockResolvedValue({ community: 'a', rooms: [], stale: false });
    renderOnPage({ mobile: true });
    fireEvent.click(trigger());
    fireEvent.click(await screen.findByRole('radio', { name: /Alpha/ }));
    await waitFor(() => expect(mockResolveCommunityNavigation).toHaveBeenCalledOnce());
    await settle();
    const box = screen.getByRole('button', { name: 'Message box' });
    fireEvent.pointerDown(box);
    box.focus();
    resolveRemembered(null);
    await idle();
    await settle();
    expect(box).toHaveFocus();
  });
});

// Purpose: the launch ships without spaces (DOR-2740). With the experiment off
// the menu is only "You": no space rows, no Join or Start, nothing hosted asked
// for, even with connections on file. Fails if any space surface leaks through.
describe('the switcher while the spaces experiment is off (DOR-2740)', () => {
  const alpha = {
    ref: 'a',
    remoteCommunityId: 'remote-a',
    label: 'Alpha',
    pinnedOrigin: 'https://a.example.com',
    connectedHumanMemberId: 'person-a',
    status: 'connected' as const,
    expiresAt: null,
  };

  it('shows you, your account and Settings, and no space at all', async () => {
    mockConfig = { ...mockConfig, experiments: spacesExperiment(false) };
    mockConnections = [alpha];
    mockCloudLinked = true;
    renderBlock();
    await configAnswered();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    expect(await screen.findByRole('menuitem', { name: /Settings/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(screen.queryByText('Switch context')).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Add a space' })).not.toBeInTheDocument();
    expect(screen.queryByText(/space/i)).not.toBeInTheDocument();
    expect(mockListHostedCommunities).not.toHaveBeenCalled();
  });
});

// Purpose: the official DorkOS space is the one exception to the switch (spec
// `official-community-space` D5). With the experiment off and an official link
// named, its row shows and opens, and nothing else does: no other space, no
// Add a space, no Start. Fails if another space leaks through, or if the
// official one is hidden with the others.
describe('the official DorkOS space while the spaces experiment is off', () => {
  const OFFICIAL_LINK = 'https://space.example.test/c/11111111-1111-4111-8111-111111111111';
  const base = {
    connectedHumanMemberId: 'person',
    status: 'connected' as const,
    expiresAt: null,
  };
  const official = {
    ...base,
    ref: 'o',
    remoteCommunityId: '11111111-1111-4111-8111-111111111111',
    label: 'DorkOS',
    pinnedOrigin: 'https://space.example.test',
    official: true,
  };
  const alpha = {
    ...base,
    ref: 'a',
    remoteCommunityId: 'remote-a',
    label: 'Alpha',
    pinnedOrigin: 'https://a.example.com',
  };

  beforeEach(() => {
    mockConfig = {
      ...mockConfig,
      experiments: spacesExperiment(false),
      officialSpace: { url: OFFICIAL_LINK },
    };
    mockCloudLinked = true;
  });

  it('shows the official row alone, with no way to add or start any other space', async () => {
    mockConnections = [official, alpha];
    renderBlock();
    await configAnswered();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    expect(await screen.findByText('DorkOS')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Add a space' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Start a space/ })).not.toBeInTheDocument();
    // Already connected, so there is nothing to join.
    expect(
      screen.queryByRole('menuitem', { name: /Join the DorkOS community/ })
    ).not.toBeInTheDocument();
    expect(mockListHostedCommunities).not.toHaveBeenCalled();
  });

  it('offers to join it while it is not connected, and opens Join on its link', async () => {
    mockConnections = [alpha];
    renderBlock();
    await configAnswered();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Join the DorkOS community/ }));
    expect(await screen.findByLabelText('Space address or invitation link')).toHaveValue(
      OFFICIAL_LINK
    );
  });
});
