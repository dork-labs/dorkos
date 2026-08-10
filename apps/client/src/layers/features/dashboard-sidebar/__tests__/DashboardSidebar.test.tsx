// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, cleanup, within, waitFor, act } from '@testing-library/react';
import {
  agentAuthorRef,
  type AuthorRef,
  type RoomSummary,
  type ThreadSummary,
} from '@dorkos/shared/room-schemas';
import { toast } from 'sonner';
import { resolveAgentVisual } from '@/layers/shared/lib';
import { useInteractionStore } from '@/layers/entities/interactions';
import { DashboardSidebar } from '../ui/DashboardSidebar';
import { SidebarProvider, TooltipProvider } from '@/layers/shared/ui';
import type { SidebarPrefs, SidebarGroup, SidebarItemRef } from '@dorkos/shared/config-schema';

/** An agent member reference — `pinned`, `muted` and `items` all hold these. */
const agent = (path: string): SidebarItemRef => ({ kind: 'agent', path });
/** A room member reference. */
const roomRef = (roomId: string): SidebarItemRef => ({ kind: 'room', roomId });

/** A room as `GET /api/rooms` carries it. */
function room(overrides: Partial<RoomSummary> & Pick<RoomSummary, 'id' | 'kind'>): RoomSummary {
  return {
    slug: null,
    title: 'Untitled',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActivityAt: '2026-07-20T10:00:00.000Z',
    unreadCount: 0,
    participants: null,
    ...overrides,
  };
}

const channel = (id: string, slug: string) => room({ id, kind: 'channel', slug, title: slug });

/**
 * A direct message with one agent in it. The `AuthorRef` deliberately carries
 * NO emoji and NO colour: the server only caches those for an agent that has one
 * stored on its manifest, and drawing this row from them is what DOR-582 was.
 */
function dmWith(id: string, agentPath: string, title: string): RoomSummary {
  const participants: AuthorRef[] = [
    { id: `${id}-you`, kind: 'human', displayName: 'You', handle: null },
    {
      id: `${id}-agent`,
      kind: 'agent',
      displayName: title,
      handle: null,
      agentRef: agentAuthorRef(agentPath),
    },
  ];
  return room({ id, kind: 'dm', title, participants });
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Navigating MOVES the location here, exactly as it does in the app. That is
// load-bearing: what stops a slow agent lookup from landing on top of a
// navigation that happened while it was out is the router's own location
// having moved, so a mock whose location never changes would test nothing.
let mockLocation: {
  pathname: string;
  search: Record<string, unknown>;
  state?: { inPlaceBase?: { pathname: string; search: Record<string, unknown> } };
} = {
  pathname: '/',
  search: {},
};
const mockNavigate = vi.fn((opts: { to?: string; search?: unknown }) => {
  const next =
    typeof opts.search === 'function'
      ? (opts.search as (p: Record<string, unknown>) => Record<string, unknown>)(
          mockLocation.search
        )
      : ((opts.search as Record<string, unknown>) ?? {});
  mockLocation = { pathname: opts.to ?? mockLocation.pathname, search: next };
  mockPathname = mockLocation.pathname;
});
let mockPathname = '/';
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useRouter: () => ({
    state: {
      get location() {
        return mockLocation;
      },
    },
  }),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: mockPathname } }),
  useSearch: () => mockLocation.search,
}));

const mockMeshPaths = vi.fn<() => string[]>(() => [
  '~/.dork/agents/dorkbot',
  '/projects/alpha',
  '/projects/beta',
]);
const mockSetGlobalPaletteOpen = vi.fn();
const mockUpdateSidebar = vi.fn<(updater: (prev: unknown) => unknown) => void>();
const mockSetRightPanelOpen = vi.fn();
const mockSetActiveRightPanelTab = vi.fn();
// `id` is required on a real `AgentManifest` and is what the agent's face is
// hashed from, so a fixture without one is not a manifest the app could ever
// receive — and leaving it out crashes the hash rather than failing an
// assertion.
const mockResolvedAgents = vi.fn<
  () => Record<string, { id: string; name: string; displayName?: string } | null>
>(() => ({}));
let mockSelectedCwd: string | null = null;

function makePrefs(overrides: Partial<SidebarPrefs> = {}): SidebarPrefs {
  return {
    pinned: [],
    groups: [],
    sections: {},
    muted: [],
    gettingStarted: { retired: [] },
    digest: {},
    ...overrides,
  };
}
const mockSidebarPrefs = vi.fn<() => SidebarPrefs>(() => makePrefs());

interface RecentResult {
  data:
    | { sessions: unknown[]; agentActivity: Record<string, string>; warnings?: unknown[] }
    | undefined;
  isLoading: boolean;
}
const mockRecent = vi.fn<() => RecentResult>(() => ({
  data: { sessions: [], agentActivity: {} },
  isLoading: false,
}));

const mockRooms = vi.fn<() => RoomSummary[]>(() => []);
const mockThreads = vi.fn<() => ThreadSummary[]>(() => []);
const mockTransport = {
  getConfig: vi.fn().mockResolvedValue({ agents: { defaultAgent: 'dorkbot' } }),
  listMeshAgentPaths: vi.fn(),
  resolveAgents: vi.fn().mockResolvedValue({}),
  listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
  listRooms: vi.fn(() => Promise.resolve(mockRooms())),
  listThreads: vi.fn(() => Promise.resolve(mockThreads())),
};

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useTransport: () => mockTransport,
    useNow: () => Date.now(),
    useIsMobile: () => false,
    // The room list rides the global `/api/events` fan-out, which needs the
    // app-level EventStreamProvider. Nothing here is about that stream, so it
    // is stubbed rather than dragging the provider into every sidebar test.
    useEventSubscription: () => {},
    useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        setGlobalPaletteOpen: mockSetGlobalPaletteOpen,
        selectedCwd: mockSelectedCwd,
        setRightPanelOpen: mockSetRightPanelOpen,
        setActiveRightPanelTab: mockSetActiveRightPanelTab,
      }),
  };
});

vi.mock('@/layers/entities/config', async (importOriginal) => {
  // Everything real except the two READS. The prefs mutators are pure functions
  // and they are what every collapse, pin and group assertion below actually
  // checks — a passthrough stub would let `setSectionCollapsed` do nothing and
  // leave the whole folding suite green.
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return {
    ...actual,
    useConfig: () => ({ data: { agents: { defaultAgent: 'dorkbot' } } }),
    useSidebarPrefs: () => mockSidebarPrefs(),
    useUpdateSidebarPrefs: () => ({
      update: mockUpdateSidebar,
      updateAsync: vi.fn(),
      isPending: false,
      isError: false,
    }),
  };
});

vi.mock('@/layers/features/agent-hub', () => ({
  useAgentHubStore: { getState: () => ({ openHub: vi.fn() }) },
}));

// The room-management slice brings a chip picker, a dialog and their own query
// hooks. What this suite is about is the sidebar's structure, so the two create
// surfaces are marked rather than mounted.
vi.mock('@/layers/features/room-management', () => ({
  ChannelCreateDialog: () => <div data-testid="channel-create-dialog" />,
  NewDirectMessageMenu: ({ open }: { open: boolean }) =>
    open ? <div data-testid="dm-picker" /> : null,
}));

/** The fleet as `GET /api/mesh/agent-paths` returns it — id and path deliberately unequal. */
const meshFleet = () =>
  mockMeshPaths().map((p) => ({
    id: `mesh-id${p}`,
    name: p.split('/').pop() ?? 'agent',
    projectPath: p,
  }));

/**
 * Paths the sidebar LISTS but the roster join cannot name.
 *
 * The two are separate reads in production and can genuinely disagree — a
 * directory the sidebar draws from one payload while the fleet's registry has
 * no row for it. Empty unless a case says otherwise.
 */
const mockUnmappedPaths = vi.fn<() => string[]>(() => []);

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => ({ data: { agents: meshFleet() } }),
  // The real join's SHAPE, not a stub of its answer: a row's profile link is
  // only correct if this returns the REGISTRY id for a path, and a mock keyed
  // path→path would hide exactly that.
  useMeshMemberIds: () =>
    new Map(
      meshFleet()
        .filter((a) => !mockUnmappedPaths().includes(a.projectPath))
        .map((a) => [a.projectPath, a.id])
    ),
}));

vi.mock('@/layers/entities/agent', async () => ({
  // The two naming helpers are pure and are what the sidebar's ORDER comes
  // from, so they are the real ones — a stub would make every sort assertion
  // below a test of the stub.
  ...(await vi.importActual<
    typeof import('@/layers/entities/agent/lib/disambiguate-display-names')
  >('@/layers/entities/agent/lib/disambiguate-display-names')),
  ...(await vi.importActual<typeof import('@/layers/entities/agent/lib/agent-choices')>(
    '@/layers/entities/agent/lib/agent-choices'
  )),
  useResolvedAgents: () => ({ data: mockResolvedAgents() }),
  useExecutionExceptions: () => mockExecutionExceptions(),
  useAgentVisual: () => ({ color: '#aaaaaa', emoji: '🤖' }),
  // The face is a control now, so the stub grows one: without it the row's
  // profile link has nothing to press and the id the sidebar hands down is
  // untestable from here (the join it comes from lives in this component).
  AgentIdentity: ({
    name,
    emoji,
    onAvatarClick,
    avatarLabel,
  }: {
    name: string;
    emoji: string;
    onAvatarClick?: () => void;
    avatarLabel?: string;
  }) => (
    <span>
      {onAvatarClick ? (
        <button type="button" aria-label={avatarLabel} onClick={onAvatarClick}>
          {emoji}
        </button>
      ) : (
        <span>{emoji}</span>
      )}
      <span>{name}</span>
    </span>
  ),
  AgentAvatar: ({ emoji }: { emoji: string }) => <span data-testid="avatar">{emoji}</span>,
}));

// DOR-329 fixtures carry no live sessions or recent-activity timestamps, so
// the real hook would classify every path 'inactive' and collapse it behind
// the DOR-339 reveal row. These pre-existing tests are about layout/sort, not
// attention filtering, so the default treats every agent as 'active' — the
// same "keep fixtures fresh" intent the spec calls for, applied at the mock
// instead of threading timestamps through every fixture. DOR-339 tests
// override this per-case via `mockAttentionMap.mockImplementation(...)`.
const mockAttentionMap = vi.fn((paths: string[], _broken?: string[]) =>
  Object.fromEntries(paths.map((p) => [p, 'active']))
);

/** Which agents' execution settings are broken. Empty unless a case says otherwise. */
const mockExecutionExceptions = vi.fn(() => ({
  exceptions: [],
  brokenPaths: [] as string[],
  defaultRuntime: 'claude-code',
}));

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  // The query-key factory is the real one: a stub here would let the sidebar
  // read a cache key nothing in the app writes and never say so (DOR-497).
  sessionKeys: (await importOriginal<typeof import('@/layers/entities/session')>()).sessionKeys,
  // Real for the same reason: which session a click opens — and which of two
  // competing clicks wins — is the behaviour these cases assert, so a stub
  // would be asserting the stub.
  resolveSessionForCwd: (await importOriginal<typeof import('@/layers/entities/session')>())
    .resolveSessionForCwd,
  beginSessionNavigation: (await importOriginal<typeof import('@/layers/entities/session')>())
    .beginSessionNavigation,
  notifySessionLookupFailed: (await importOriginal<typeof import('@/layers/entities/session')>())
    .notifySessionLookupFailed,
  // Real too: it routes through `useSafeNavigate`, which resolves to the mocked
  // `useNavigate` here — so "New session" is exercised end to end rather than
  // against a stub that cannot be wrong.
  useStartNewSession: (await importOriginal<typeof import('@/layers/entities/session')>())
    .useStartNewSession,
  useAgentSessions: () => ({ sessions: [], activeSessionId: null, isLoading: false }),
  useSessionBorderState: () => ({ kind: 'idle', color: 'x', pulse: false, label: 'Idle' }),
  useAgentHottestStatus: () => ({ kind: 'idle', color: 'x', pulse: false, label: 'Idle' }),
  useAgentsAggregateStatus: () => false,
  useAgentAttentionMap: (paths: string[], broken?: string[]) => mockAttentionMap(paths, broken),
  usePulseMotion: () => ({ animate: undefined, transition: undefined }),
  useRenameSession: () => ({ mutate: vi.fn() }),
  useRecentSessions: () => mockRecent(),
  // The real store: the lifecycle projection the assembly hook selects out of
  // it is the thing the memo-stability contract rests on, and a stub would
  // remove the very object whose identity is under test.
  useSessionListStore: (await importOriginal<typeof import('@/layers/entities/session')>())
    .useSessionListStore,
  sessionDisplayTitle: (t: string) => t,
  SessionRow: () => null,
  SessionOriginMark: () => null,
  // Stubbed rather than imported: mirrors the real partition (session-origin-legibility)
  // without pulling the real module into this wholesale mock.
  partitionSessionsByOrigin: (sessions: Array<{ origin?: string }>) => ({
    conversations: sessions.filter((s) => !s.origin || s.origin === 'user'),
    automated: sessions.filter((s) => s.origin && s.origin !== 'user'),
  }),
}));

vi.mock('@/layers/features/feature-promos', () => ({ PromoSlot: () => null }));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SidebarProvider>{ui}</SidebarProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function group(overrides: Partial<SidebarGroup> = {}): SidebarGroup {
  return {
    id: 'g1',
    name: 'Clients',
    items: [],
    sortMode: 'manual',
    collapsed: false,
    displayFilter: 'all',
    muted: false,
    kind: 'manual',
    ...overrides,
  };
}

/**
 * One agent's row BUTTON.
 *
 * `getByRole('button')` is ambiguous here: the drag layer gives every draggable
 * row a wrapper with `role="button"` and the same accessible name, so a role
 * query matches two nodes and the outer one is not the thing a person presses.
 */
function agentRowButton(name: string): HTMLElement {
  const rows = screen
    .getAllByRole('button', { name: new RegExp(`Switch to ${name}`) })
    .filter((el) => el.tagName === 'BUTTON');
  expect(rows, `expected one row button for ${name}`).toHaveLength(1);
  return rows[0]!;
}

/**
 * The rules found in a source, or `[]` when it holds none.
 *
 * The renderer's contract is stronger than "no sorting": it TRANSFORMS NOTHING.
 * A list of forbidden spellings is whack-a-mole — the first version of this
 * caught `.sort(` and was walked past by `.toSorted(` — so the rule is stated
 * as the shape of the thing instead: no collection method, no model field that
 * only a rule should read, no arithmetic. Membership, caps, ordering and badge
 * counts cannot be expressed without at least one of them.
 *
 * Comments are stripped first: the docblock deliberately NAMES the things the
 * component may not do, which is how the rule is written down where the next
 * author will read it.
 *
 * @param source - The component's source text.
 */
function rulesIn(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const forbidden: [string, RegExp][] = [
    [
      'a collection method',
      /\.(map|filter|flatMap|reduce|reduceRight|sort|toSorted|slice|splice|some|every|find|findIndex|findLast|includes|concat|length)\b/,
    ],
    ['a model field only a rule reads', /\b(unread|collapsed|rollup|draggable|reservesVerbLine)\b/],
    ['arithmetic', /\bMath\./],
    ['a rule import', /model\/rules/],
  ];
  return forbidden
    .filter(([, pattern]) => pattern.test(code))
    .map(([what, pattern]) => `${what} (${String(pattern)})`);
}

/** The Library zone's `<section>`, or `null` when the model emitted none. */
function libraryZone(): HTMLElement | null {
  return document.querySelector('[data-sidebar-zone="library"]');
}

/** Every section heading inside Library, in DOM order. */
function libraryHeadings(): string[] {
  const zone = libraryZone();
  if (zone === null) return [];
  return Array.from(zone.querySelectorAll('h3')).map((h) => h.textContent?.trim() ?? '');
}

/** One Library section's `<h3>`, by its label. */
function sectionHeading(label: string): HTMLElement {
  const zone = libraryZone();
  expect(zone, 'no Library zone rendered').not.toBeNull();
  const heading = Array.from(zone!.querySelectorAll('h3')).find(
    (h) => h.textContent?.trim().startsWith(label) === true
  );
  expect(heading, `no "${label}" section`).toBeTruthy();
  return heading as HTMLElement;
}

/** The button that folds a section — the whole header row is it (BC-29). */
function sectionToggle(label: string): HTMLElement {
  const toggle = sectionHeading(label).querySelector('[data-sidebar-section-toggle]');
  expect(toggle, `"${label}" has no toggle`).toBeTruthy();
  return toggle as HTMLElement;
}

/** What `update()` produced, applied to the prefs the component was given. */
function lastPrefsWrite(): SidebarPrefs {
  const updater = mockUpdateSidebar.mock.calls.at(-1)?.[0] as (p: SidebarPrefs) => SidebarPrefs;
  expect(updater, 'no prefs write happened').toBeTypeOf('function');
  return updater(mockSidebarPrefs());
}

describe('DashboardSidebar', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    localStorage.clear();
    useInteractionStore.getState().reset();
    mockMeshPaths.mockReset();
    mockSidebarPrefs.mockReset();
    mockUpdateSidebar.mockReset();
    mockRecent.mockReset();
    mockNavigate.mockReset();
    mockResolvedAgents.mockReset();
    mockResolvedAgents.mockReturnValue({});
    mockMeshPaths.mockReturnValue(['~/.dork/agents/dorkbot', '/projects/alpha', '/projects/beta']);
    mockSidebarPrefs.mockReturnValue(makePrefs());
    mockRecent.mockReturnValue({ data: { sessions: [], agentActivity: {} }, isLoading: false });
    mockRooms.mockReset();
    mockRooms.mockReturnValue([]);
    mockThreads.mockReset();
    mockThreads.mockReturnValue([]);
    mockTransport.listSessions.mockReset();
    mockTransport.listSessions.mockResolvedValue({ sessions: [] });
    vi.mocked(toast.error).mockReset();
    mockAttentionMap.mockReset();
    mockAttentionMap.mockImplementation((paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, 'active']))
    );
    mockSelectedCwd = null;
    mockPathname = '/';
    mockLocation = { pathname: '/', search: {} };
  });

  // ── The shell (spec §A3, R2) ──

  describe('the panel shell', () => {
    it('is one landmark, named', () => {
      renderWithProviders(<DashboardSidebar />);
      expect(screen.getByRole('navigation', { name: 'Sidebar' })).toBeInTheDocument();
    });

    it('draws no top-level route navigation of its own — that is the shell’s now', () => {
      // The header block is persistent chrome mounted by AppShell OUTSIDE the
      // `sidebar.body` swap region, so a marketplace takeover leaves it standing
      // (spec R2, P2 AC-8). If it drifted back in here, the takeover would take
      // it with it and nobody would notice until they opened /marketplace.
      renderWithProviders(<DashboardSidebar />);
      expect(screen.queryByText('Connections')).not.toBeInTheDocument();
      expect(screen.queryByText('Marketplace')).not.toBeInTheDocument();
    });

    it('labels each zone with a heading, never a button (BC-2)', async () => {
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      const heading = await screen.findByRole('heading', { name: 'Library', level: 2 });
      expect(heading.tagName).toBe('H2');
      expect(heading.querySelector('button')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Library' })).not.toBeInTheDocument();
    });
  });

  // ── BC-28: what Library holds, and in what order ──

  describe('BC-28 — Library’s sections', () => {
    it('reads Pins, Channels, Direct messages, Agents', async () => {
      mockSidebarPrefs.mockReturnValue(makePrefs({ pinned: [agent('/projects/alpha')] }));
      mockRooms.mockReturnValue([channel('r1', 'general'), dmWith('r2', '/projects/beta', 'beta')]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(libraryHeadings().length).toBe(4));
      expect(libraryHeadings()).toEqual(['Pins', 'Channels', 'Direct messages', 'Agents']);
    });

    it('nests a group inside Agents, one level down, as an <h4>', async () => {
      mockSidebarPrefs.mockReturnValue(
        makePrefs({ groups: [group({ items: [agent('/projects/alpha')] })] })
      );
      renderWithProviders(<DashboardSidebar />);
      const heading = await screen.findByRole('heading', { name: /Clients/, level: 4 });
      expect(sectionHeading('Agents').closest('[data-slot="sidebar-group"]')).toContainElement(
        heading
      );
    });
  });

  // ── BC-29 / BC-30: the collapse gestures ──

  describe('BC-29 / BC-30 — folding', () => {
    it('folds a section from anywhere on its header row', async () => {
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(libraryHeadings()).toContain('Channels'));
      fireEvent.click(sectionToggle('Channels'));
      expect(lastPrefsWrite().sections?.channels?.collapsed).toBe(true);
    });

    it('folds EVERY Library section on Alt-click, not just the one pressed', async () => {
      mockSidebarPrefs.mockReturnValue(
        makePrefs({ groups: [group({ items: [agent('/projects/alpha')] })] })
      );
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(libraryHeadings()).toContain('Channels'));
      fireEvent.click(sectionToggle('Channels'), { altKey: true });
      const next = lastPrefsWrite();
      expect(next.sections?.channels?.collapsed).toBe(true);
      expect(next.sections?.agents?.collapsed).toBe(true);
      expect(next.groups[0]?.collapsed).toBe(true);
    });

    it('unfolds everything when everything is already folded', async () => {
      mockSidebarPrefs.mockReturnValue(
        makePrefs({ sections: { channels: { collapsed: true }, agents: { collapsed: true } } })
      );
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(libraryHeadings()).toContain('Channels'));
      fireEvent.click(sectionToggle('Channels'), { altKey: true });
      expect(lastPrefsWrite().sections?.channels?.collapsed).toBe(false);
    });

    it('hides a folded section’s rows and keeps its header reachable', async () => {
      mockSidebarPrefs.mockReturnValue(makePrefs({ sections: { channels: { collapsed: true } } }));
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(libraryHeadings()).toContain('Channels'));
      expect(screen.queryByText('#general')).not.toBeInTheDocument();
      expect(sectionToggle('Channels')).toHaveAttribute('aria-expanded', 'false');
    });
  });

  // ── BC-31: a folded section keeps its signal ──

  it('BC-31 — a folded section still shows the numbers its rows carried', async () => {
    mockSidebarPrefs.mockReturnValue(makePrefs({ sections: { dms: { collapsed: true } } }));
    // Named apart from every agent on purpose: `beta` is also a row in Agents,
    // and a "the rows are gone" assertion that matched it would pass on the
    // wrong element.
    mockRooms.mockReturnValue([
      { ...dmWith('r2', '/projects/beta', 'Quiet chat'), unreadCount: 3, working: 2 },
    ]);
    renderWithProviders(<DashboardSidebar />);
    const heading = await screen.findByRole('heading', { name: /Direct messages/, level: 3 });
    // The rows are gone…
    expect(screen.queryByText('Quiet chat')).not.toBeInTheDocument();
    // …and the count and the working dot survived onto the header.
    expect(within(heading).getByLabelText('3 unread')).toHaveTextContent('3');
    // One MEMBER is working, not two: BC-31 counts members currently
    // streaming, so a single conversation with two agents in it is one.
    expect(within(heading).getByLabelText('1 agent working')).toBeInTheDocument();
  });

  // ── BC-32: chrome by data volume ──

  describe('BC-32 — chrome appears by data volume', () => {
    it('draws no Direct messages section until a conversation exists', async () => {
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(libraryHeadings()).toContain('Channels'));
      expect(libraryHeadings()).not.toContain('Direct messages');
    });

    it('draws no Pins section until something is pinned', async () => {
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(libraryHeadings()).toContain('Channels'));
      expect(libraryHeadings()).not.toContain('Pins');
    });

    it('offers no grouping to a small cockpit, and offers it at eight agents', async () => {
      // The changelog says grouping "shows up once you are running eight agents
      // or two different kinds". It said that before anything gated it, which
      // is a release note describing behaviour the code did not have.
      mockMeshPaths.mockReturnValue(['/a/1', '/a/2', '/a/3']);
      renderWithProviders(<DashboardSidebar />);
      await screen.findByRole('heading', { name: /Agents/, level: 3 });
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Agents section actions' }));
      expect(await screen.findByRole('menuitem', { name: /New agent/ })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: /New group/ })).not.toBeInTheDocument();
      cleanup();

      mockMeshPaths.mockReturnValue(Array.from({ length: 8 }, (_, i) => `/a/${i}`));
      renderWithProviders(<DashboardSidebar />);
      await screen.findByRole('heading', { name: /Agents/, level: 3 });
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Agents section actions' }));
      expect(await screen.findByRole('menuitem', { name: /New group/ })).toBeInTheDocument();
    });

    it('offers grouping at two runtimes however small the fleet', async () => {
      mockMeshPaths.mockReturnValue(['/a/1', '/a/2']);
      mockResolvedAgents.mockReturnValue({
        '/a/1': { id: 'a1', name: 'one', runtime: 'claude-code' },
        '/a/2': { id: 'a2', name: 'two', runtime: 'codex' },
      } as never);
      renderWithProviders(<DashboardSidebar />);
      await screen.findByRole('heading', { name: /Agents/, level: 3 });
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Agents section actions' }));
      expect(await screen.findByRole('menuitem', { name: /New group/ })).toBeInTheDocument();
    });

    it('offers no "advanced mode" toggle anywhere', () => {
      renderWithProviders(<DashboardSidebar />);
      expect(screen.queryByText(/advanced mode/i)).not.toBeInTheDocument();
    });
  });

  // ── BC-33: dual presence ──

  it('BC-33 — the open conversation’s agent row takes the active tint in Library', async () => {
    mockPathname = '/session';
    mockLocation = { pathname: '/session', search: { session: 's1', dir: '/projects/alpha' } };
    renderWithProviders(<DashboardSidebar />);
    await screen.findByText('alpha');
    expect(agentRowButton('alpha')).toHaveAttribute('aria-current', 'page');
    expect(agentRowButton('beta')).not.toHaveAttribute('aria-current');
  });

  // ── P2 AC-9 (this task's half): keyboard only ──

  describe('P2 AC-9 — no pointer at any step', () => {
    it('reaches a Library row with the arrow keys and opens it with Enter', async () => {
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await screen.findByText('#general');
      const toggle = sectionToggle('Channels');
      toggle.focus();
      // ArrowDown walks the section: header → first row.
      fireEvent.keyDown(toggle, { key: 'ArrowDown' });
      const row = screen.getByText('#general').closest('button');
      expect(document.activeElement).toBe(row);
      fireEvent.click(document.activeElement as HTMLElement);
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/channels', search: { id: 'r1' } });
    });

    it('folds a section from the keyboard with ArrowLeft', async () => {
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await screen.findByText('#general');
      const toggle = sectionToggle('Channels');
      toggle.focus();
      fireEvent.keyDown(toggle, { key: 'ArrowLeft' });
      expect(lastPrefsWrite().sections?.channels?.collapsed).toBe(true);
    });
  });

  // ── Behaviour that had to survive the rewrite ──

  describe('what the rewrite had to keep', () => {
    it('opens an agent’s most recent conversation when its row is pressed (BC-34)', async () => {
      mockTransport.listSessions.mockResolvedValue({
        sessions: [{ id: 's9', cwd: '/projects/alpha', title: 'Ship it' }],
      });
      renderWithProviders(<DashboardSidebar />);
      await screen.findByText('alpha');
      fireEvent.click(agentRowButton('alpha'));
      await waitFor(() =>
        expect(mockNavigate).toHaveBeenCalledWith({
          to: '/session',
          search: { dir: '/projects/alpha', session: 's9' },
        })
      );
    });

    it('migrates legacy localStorage pins into server config, once', async () => {
      localStorage.setItem('dorkos-pinned-agents', JSON.stringify(['/projects/alpha']));
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(mockUpdateSidebar).toHaveBeenCalled());
      expect(lastPrefsWrite().pinned).toEqual([{ kind: 'agent', path: '/projects/alpha' }]);
      expect(localStorage.getItem('dorkos-pinned-agents')).toBeNull();
    });

    it('renders a group you just made, empty, with somewhere to drop into', async () => {
      // The one section allowed to render empty. Every other one appears
      // because something is in it — but a group that vanished the instant it
      // was created could never be dragged into, which is exactly how it is
      // filled. The browser spec drives that flow end to end.
      mockSidebarPrefs.mockReturnValue(makePrefs({ groups: [group({ items: [] })] }));
      renderWithProviders(<DashboardSidebar />);
      await screen.findByRole('heading', { name: /Clients/, level: 4 });
      expect(screen.getByText(/Drag agents, channels, or conversations here/)).toBeInTheDocument();
    });

    it('tells a smart group with no matches so, rather than hiding it', async () => {
      mockSidebarPrefs.mockReturnValue(
        makePrefs({
          groups: [
            group({
              id: 'sg',
              name: 'Wedged',
              kind: 'smart',
              sortMode: 'recent',
              rules: { pathPrefix: '/nothing-matches-this' },
            }),
          ],
        })
      );
      renderWithProviders(<DashboardSidebar />);
      await screen.findByRole('heading', { name: /Wedged/, level: 4 });
      expect(screen.getByText('No agents match these rules')).toBeInTheDocument();
    });

    it('keeps a smart group’s members out of the drag layer', async () => {
      mockSidebarPrefs.mockReturnValue(
        makePrefs({
          groups: [
            group({
              id: 'sg',
              name: 'Live now',
              kind: 'smart',
              sortMode: 'recent',
              rules: { statuses: ['needs-attention', 'active'] },
            }),
          ],
        })
      );
      renderWithProviders(<DashboardSidebar />);
      const heading = await screen.findByRole('heading', { name: /Live now/, level: 4 });
      // A rule-owned row is not a drag source: dragging one out would ask the
      // operator to hand-edit a list the rules rebuild on the next render. The
      // group HEADER stays draggable (groups reorder), so the assertion is
      // scoped to the rows.
      const body = heading.closest('[data-slot="sidebar-group"]');
      const rows = body?.querySelectorAll('[data-sidebar-row]') ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.closest('[aria-roledescription="sortable"]')).toBeNull();
      }
    });
  });

  // ── The rule this whole task exists to make true ──

  describe('the renderer holds no rules', () => {
    const source = readFileSync(join(__dirname, '..', 'ui', 'DashboardSidebar.tsx'), 'utf8');

    it('is under 200 lines', () => {
      expect(source.split('\n').length).toBeLessThan(200);
    });

    it('transforms nothing — no array work, no model field, no arithmetic', () => {
      expect(rulesIn(source)).toEqual([]);
    });

    it('reds on every rule a reviewer could put back', () => {
      // **This runs the REAL scanner**, over sources that differ from the
      // component only by the line under test. The previous version of this
      // case matched the regexes against a hand-written literal and never
      // touched the pipeline it claimed to prove — so an adversarial review put
      // all four rules back into the renderer and all 24 tests stayed green.
      const cases: [string, string][] = [
        ['membership', 'const shown = rows.filter((row) => !row.muted);'],
        ['a cap', 'const capped = rows.slice(0, 8);'],
        ['ordering', 'const ordered = rows.toSorted((a, b) => a.primary > b.primary ? 1 : -1);'],
        ['a badge count', 'const n = rows.reduce((sum, row) => sum + (row.unread.count ?? 0), 0);'],
        ['a fold decision', 'const open = !section.collapsed;'],
        ['arithmetic on the model', 'const spare = Math.max(0, rows.length - 3);'],
      ];
      for (const [what, line] of cases) {
        expect(rulesIn(`${source}\n${line}\n`), `${what} walked past the guard`).not.toEqual([]);
      }
    });

    it('does not fire on the renderer’s own prose', () => {
      // The other half: a guard that reds on the docblock would be satisfied by
      // deleting a comment, which is not the property anyone wants.
      expect(rulesIn('/** Never .filter() or .sort() here. */\n// and no unread either\n')).toEqual(
        []
      );
    });
  });
});
