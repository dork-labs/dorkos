// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, cleanup, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  agentAuthorRef,
  type AuthorRef,
  type RoomSummary,
  type ThreadSummary,
} from '@dorkos/shared/room-schemas';
import { toast } from 'sonner';
import { resolveAgentVisual } from '@/layers/shared/lib';
import { useInteractionStore } from '@/layers/entities/interactions';
import { useRoomOpenThreadStore } from '@/layers/entities/room';
import { useDiscoveryStore } from '@/layers/entities/discovery';
import { TransportProvider, useAgentCreationStore } from '@/layers/shared/model';
import { useCreateFlowStore } from '../model/create-flow-store';
import { DashboardSidebar } from '../ui/DashboardSidebar';
import { ALL_CLEAR_BEAT_MS } from '../model/use-all-clear-beat';
import { LIVE_REGION_DEBOUNCE_MS } from '../model/use-live-region-text';
import { useTodayRevealStore } from '../model/today-reveal-store';
import { SidebarProvider, TooltipProvider } from '@/layers/shared/ui';
import type { SidebarPrefs, SidebarGroup, SidebarItemRef } from '@dorkos/shared/config-schema';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import type { Task } from '@dorkos/shared/types';
import { useSessionListStore } from '@/layers/entities/session';

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
  return groupDmWith(id, [agentPath], title);
}

/**
 * A direct message with several agents in it — a GROUP message, which is the
 * only hand-made direct message Library lists (`sidebar-simplification` D2).
 *
 * Most cases here want a DM with a row in Direct messages, and a one-to-one no
 * longer has one: it is the agent's own session under a second name, so the
 * agent's row stands for it. {@link dmWith} is what a one-to-one is spelled
 * with, and it is used where the suppression itself is the subject.
 *
 * @param id - The room id.
 * @param agentPaths - The agents on the roster.
 * @param title - What the conversation is called.
 */
function groupDmWith(id: string, agentPaths: string[], title: string): RoomSummary {
  const participants: AuthorRef[] = [
    { id: `${id}-you`, kind: 'human', displayName: 'You', handle: null },
    ...agentPaths.map((agentPath, index) => ({
      id: `${id}-agent-${index}`,
      kind: 'agent' as const,
      displayName: `${title} ${index}`,
      handle: null,
      agentRef: agentAuthorRef(agentPath),
    })),
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
/**
 * The router's own `navigate`, which takes a raw `href`.
 *
 * Separate from `mockNavigate` because the two are different doors: a typed
 * route goes through `useNavigate`, and an attention row's deep link is a
 * string the signal supplied, so `SidebarChrome` hands it to the router
 * directly. A test that watched only the first would see a schedule row do
 * nothing at all.
 */
const mockRouterNavigate = vi.fn();
/**
 * The panel's boot phase, settled by default so these cases are about what they
 * are named after rather than about the gate. One case turns it off, because
 * "pending is not empty" is exactly what it asserts. The gate's own behaviour
 * is covered in `model/boot/__tests__` (spec `sidebar-simplification` D6).
 */
const boot = vi.hoisted(() => ({
  state: {
    phase: 'settled' as 'cold' | 'warm' | 'settled',
    settled: true,
    fleetKnown: true,
    startedWarm: false,
  },
}));
vi.mock('../model/boot/use-boot-state', () => ({ useBootState: () => boot.state }));
afterEach(() => {
  boot.state = { phase: 'settled', settled: true, fleetKnown: true, startedWarm: false };
});

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useRouter: () => ({
    navigate: mockRouterNavigate,
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
  isSuccess?: boolean;
}
const mockRecent = vi.fn<() => RecentResult>(() => ({
  data: { sessions: [], agentActivity: {} },
  isLoading: false,
  isSuccess: true,
}));

/** Approvals waiting on a person, as `GET /api/approvals/pending` returns them. */
const mockApprovals = vi.fn<() => PendingApproval[]>(() => []);

/**
 * Whether this cockpit has the Tasks subsystem switched on.
 *
 * Off by default, which is what every case that predates schedules-in-Heads-up
 * assumes: a cockpit with tasks disabled parks nothing, so those rows are the
 * rows they always were.
 */
let mockTasksEnabled = false;

/** The schedules `GET /api/tasks` returns. Empty unless a case says otherwise. */
const mockTasks = vi.fn<() => Task[]>(() => []);

/** A schedule an agent proposed and parked (DOR-504). */
function parkedSchedule(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    name: overrides.id,
    displayName: null,
    description: null,
    prompt: 'Audit the config migration.',
    cron: '0 3 * * *',
    timezone: 'UTC',
    agentId: null,
    enabled: false,
    maxRuntime: null,
    permissionMode: 'default',
    status: 'pending_approval',
    filePath: `/tasks/${overrides.id}.json`,
    createdAt: '2026-08-19T09:00:00.000Z',
    updatedAt: '2026-08-19T09:00:00.000Z',
    reason: null,
    proposedBySessionId: null,
    proposedByAgentPath: null,
    proposedByName: null,
    origin: null,
    reasonSource: null,
    nextRuns: [],
    ...overrides,
  };
}

/**
 * Whether the operator asked for less motion.
 *
 * A `let` behind a mock rather than a redefined `matchMedia`: BC-50 turns on
 * this one answer, and driving it through the media query would make the case
 * depend on when motion happens to read it.
 */
let mockReducedMotion = false;
vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('motion/react')>()),
  useReducedMotion: () => mockReducedMotion,
}));

const mockRooms = vi.fn<() => RoomSummary[]>(() => []);
const mockThreads = vi.fn<() => ThreadSummary[]>(() => []);
const mockTransport = {
  // `tasks.enabled` is read live rather than pinned: `useFeatureEnabled` gates
  // the schedule queue on it, and the queue is what puts a parked schedule in
  // Heads up (DOR-1391).
  getConfig: vi.fn(() =>
    Promise.resolve({
      agents: { defaultAgent: 'dorkbot' },
      tasks: { enabled: mockTasksEnabled },
    })
  ),
  listMeshAgentPaths: vi.fn(),
  resolveAgents: vi.fn().mockResolvedValue({}),
  listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
  listRooms: vi.fn(() => Promise.resolve(mockRooms())),
  // The permission queue Heads up draws from (BC-5). Empty unless a case says otherwise.
  listPendingApprovals: vi.fn(() => Promise.resolve({ approvals: mockApprovals() })),
  // The schedule queue behind the fourth blockage. Empty unless a case parks one.
  listTasks: vi.fn(() => Promise.resolve(mockTasks())),
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

/**
 * The docked profile's opener, stable across `getState()` calls so a test can
 * assert it was reached. A fresh `vi.fn()` per call — which this used to be —
 * records into an object nobody holds.
 */
const mockOpenProfileDocked = vi.fn<(agentPath: string) => void>();

vi.mock('@/layers/features/profile', () => ({
  useProfileStore: { getState: () => ({ openProfileDocked: mockOpenProfileDocked }) },
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
  // `isSuccess` is what tells Getting started's facts apart from a roster query
  // that has not answered — without it the journey never resolves and the zone
  // can never appear (BC-12).
  useMeshAgentPaths: () => ({ data: { agents: meshFleet() }, isSuccess: true }),
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
  useResolvedAgents: () => ({ data: mockResolvedAgents(), isSuccess: true }),
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
  // The shared recent-sessions window, real for the same reason: it is half of
  // the cache key every recents caller shares (spec `sidebar-simplification` D6).
  RECENT_SESSIONS_WINDOW: (await importOriginal<typeof import('@/layers/entities/session')>())
    .RECENT_SESSIONS_WINDOW,
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
  // Real for the same reason: `entities/attention` reads what each ATTACHED
  // session is blocked on out of it, and that read is on the same identity
  // path as the lifecycle one above.
  useSessionStreamStore: (await importOriginal<typeof import('@/layers/entities/session')>())
    .useSessionStreamStore,
  sessionDisplayTitle: (t: string) => t,
  // **Real, not stubbed.** It is the whole of the sidebar's live verb (BC-37,
  // spec R1) and it reads the real `useSessionListStore` above, so the rows in
  // this file say what a row in the app says. A stub would make every
  // assertion about a second line an assertion about the stub.
  SessionVerbLine: (await importOriginal<typeof import('@/layers/entities/session')>())
    .SessionVerbLine,
  SessionRow: () => null,
  SessionOriginMark: () => null,
  // Real, not stubbed. Both are pure functions over a list, and this file used
  // to carry a hand-written mirror of the partition — a second spelling of the
  // one rule that says what counts as automated, in a wholesale mock, which is
  // precisely the drift DOR-1137 was about. Importing them costs nothing and
  // cannot disagree with the product.
  partitionSessionsByOrigin: (await importOriginal<typeof import('@/layers/entities/session')>())
    .partitionSessionsByOrigin,
  humanOriginSessionIds: (await importOriginal<typeof import('@/layers/entities/session')>())
    .humanOriginSessionIds,
}));

// The slot's candidates come from three features and a config read; this file
// is about the PANEL, so the promo is the one candidate stubbed to qualify —
// it gives the slot something to draw so its POSITION can be asserted. The old
// `PromoSlot: () => null` stub drew nothing at all, which is why the promo
// sitting inside the scroller went unnoticed here for as long as it did.
vi.mock('@/layers/features/feature-promos', () => ({
  usePromoCandidate: () => ({
    id: 'promo:test',
    show: true,
    render: () => <div data-testid="bottom-slot-card">A promo</div>,
  }),
}));

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
  return {
    // Handed back so a case can make a query answer again — the only way to
    // move a server-backed list (the approvals queue) from inside a test.
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        {/* The real provider, not the `useTransport` stub above: hooks reached
            through `shared/model`'s barrel get the stub, but `useFeatureEnabled`
            imports `TransportContext` by relative path — so the schedule queue
            behind Heads up's fourth blockage needs a context that really
            exists (DOR-1391). */}
        <TransportProvider transport={mockTransport as never}>
          <TooltipProvider>
            <SidebarProvider>{ui}</SidebarProvider>
          </TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    ),
  };
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
  // The LABEL, not the header's whole text: a folded header also carries its
  // roll-up ("12 · 3 unread"), so reading `textContent` off the `<h3>` turned
  // "Channels" into "Channels1" the moment somebody collapsed it.
  return Array.from(zone.querySelectorAll('h3')).map(
    (h) => h.querySelector('.truncate')?.textContent?.trim() ?? h.textContent?.trim() ?? ''
  );
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
    mockRecent.mockReturnValue({
      data: { sessions: [], agentActivity: {} },
      isLoading: false,
      isSuccess: true,
    });
    // Every suggestion already answered, so Getting started stays out of the way
    // of the cases that are about Heads up. The block that IS about Getting started
    // gives itself an unretired set (BC-4: they share one slot).
    mockSidebarPrefs.mockReturnValue(makePrefs({ gettingStarted: { retired: ALL_SUGGESTIONS } }));
    mockApprovals.mockReset();
    mockApprovals.mockReturnValue([]);
    mockTasks.mockReset();
    mockTasks.mockReturnValue([]);
    mockTasksEnabled = false;
    mockReducedMotion = false;
    useSessionListStore.getState().resetStatuses();
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
    mockUnmappedPaths.mockReset();
    mockUnmappedPaths.mockReturnValue([]);
    mockOpenProfileDocked.mockReset();
  });

  // ── One door to a profile, for every agent the panel lists (DOR-1255) ──

  describe('the face on an agent row', () => {
    /** The fleet, narrowed to one agent so a single face is unambiguous. */
    function renderOneAgent() {
      mockMeshPaths.mockReturnValue(['/projects/alpha']);
      mockResolvedAgents.mockReturnValue({
        '/projects/alpha': { id: 'a1', name: 'alpha' },
      });
      return renderWithProviders(<DashboardSidebar />);
    }

    it('opens the SHEET by roster id when the fleet can name the agent', async () => {
      renderOneAgent();

      await userEvent.click(await screen.findByRole('button', { name: 'Open alpha’s profile' }));

      // The sheet is an address: `?profile=<registry id>`, never the path, and
      // never the docked panel — which is a different home for the same subject.
      expect(mockNavigate).toHaveBeenCalledWith(
        expect.objectContaining({ search: expect.any(Function) })
      );
      const updater = mockNavigate.mock.calls.at(-1)![0].search as (p: unknown) => unknown;
      expect(updater({})).toMatchObject({ profile: 'mesh-id/projects/alpha' });
      expect(mockOpenProfileDocked).not.toHaveBeenCalled();
    });

    it('still has a door — the docked panel — when the fleet cannot name it', async () => {
      // The roster join and the path listing are separate reads and can
      // genuinely disagree: an agent retired mid-session, or a roster whose
      // account source degraded, has a directory but no id. Offering nothing
      // there left the face as plain art and the menu item missing, so the one
      // agent you most needed to look at was the one that answered you with
      // nothing at all (DOR-1255).
      //
      // **What opens is a panel, not a profile.** `ProfileDock` resolves the
      // identity through the same path → id map, so it settles on "Agent not
      // found" and names the dead directory. That is asserted from the other
      // end, in `ProfileDock.test.tsx` — this half only pins that the row still
      // reaches for the door.
      mockUnmappedPaths.mockReturnValue(['/projects/alpha']);
      renderOneAgent();

      const face = await screen.findByRole('button', { name: 'Open alpha’s profile' });
      await userEvent.click(face);

      expect(mockOpenProfileDocked).toHaveBeenCalledWith('/projects/alpha');
    });
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

    it('names each zone for assistive tech and paints no heading of its own (D1)', async () => {
      // The sidebar is two levels now, and "Library" was the word for a third
      // that named nothing an operator recognised. The REGION survives — the id,
      // the collapse keys, the DnD containers and the accessible name are all
      // untouched — so a screen reader still reaches "Library" and nobody sees
      // it. Red if the `<h2>` comes back, and red if the name goes with it.
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      const { container } = renderWithProviders(<DashboardSidebar />);
      await waitFor(() =>
        expect(container.querySelector('[data-sidebar-zone="library"]')).not.toBeNull()
      );
      const zone = container.querySelector('[data-sidebar-zone="library"]')!;
      expect(zone.getAttribute('aria-label')).toBe('Library');
      expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
      expect(screen.queryByText('Library')).not.toBeInTheDocument();
    });
  });

  // ── BC-28: what Library holds, and in what order ──

  describe('BC-28 — Library’s sections', () => {
    it('reads Pins, Channels, Direct messages, Agents', async () => {
      mockSidebarPrefs.mockReturnValue(makePrefs({ pinned: [agent('/projects/alpha')] }));
      mockRooms.mockReturnValue([
        channel('r1', 'general'),
        groupDmWith('r2', ['/projects/alpha', '/projects/beta'], 'beta'),
      ]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(libraryHeadings().length).toBe(4));
      expect(libraryHeadings()).toEqual(['Pins', 'Channels', 'Direct messages', 'Agents']);
    });

    it('draws no Direct messages section for a one-to-one, which the agent’s row already is', async () => {
      // One door to an agent (`sidebar-simplification` D2): a 1:1 direct message
      // is that agent's session under a second name, so Library lists the agent
      // and not both.
      mockRooms.mockReturnValue([channel('r1', 'general'), dmWith('r2', '/projects/beta', 'beta')]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(libraryHeadings()).toContain('Channels'));
      expect(libraryHeadings()).not.toContain('Direct messages');
    });

    it('draws a hand-made section as a peer, above the fixed four (D3)', async () => {
      // What this catches: a return to the pre-D3 shape, where the section
      // rendered as an <h4> nested inside the Agents wrapper.
      mockSidebarPrefs.mockReturnValue(
        makePrefs({ groups: [group({ items: [agent('/projects/alpha')] })] })
      );
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(libraryHeadings()).toContain('Clients'));
      expect(libraryHeadings()[0]).toBe('Clients');
      expect(screen.queryByRole('heading', { name: /Clients/, level: 4 })).not.toBeInTheDocument();
      expect(sectionHeading('Agents').closest('[data-slot="sidebar-group"]')).not.toContainElement(
        screen.getByRole('heading', { name: /Clients/, level: 3 })
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

    it('folds Heads up and Today too, from a header in a different zone (D1)', async () => {
      // **The widening, asserted by NAME.** Alt-click used to enumerate the
      // Library zone's sections and nothing else, so Heads up and Today stayed
      // open while everything under them shut — a whole-panel gesture that did
      // three-quarters of a job. Now every header folds, so "fold everything"
      // has to mean everything, and the press has to work from any header
      // rather than only from one inside Library.
      //
      // Counting the write would pass on a build that folded six of the wrong
      // sections. Each id is named.
      mockApprovals.mockReturnValue([pendingApproval()]);
      mockSidebarPrefs.mockReturnValue(
        makePrefs({
          pinned: [agent('/projects/alpha')],
          groups: [group({ items: [agent('/projects/beta')] })],
        })
      );
      mockRooms.mockReturnValue([
        { ...channel('r1', 'general'), unreadCount: 2 },
        groupDmWith('r2', ['/projects/alpha', '/projects/beta'], 'beta'),
      ]);
      // Today is recency-driven, so a room has to have been OPENED to be in it.
      useInteractionStore.getState().recordOpened('room', 'r1', Date.now() - 5_000);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(todayZone()).not.toBeNull());
      await waitFor(() => expect(libraryHeadings()).toContain('Channels'));

      // Pressed on TODAY's header — a zone that could not fold at all before —
      // so this proves the gesture is no longer Library's private affordance.
      const todayToggle = todayZone()!.querySelector(
        '[data-sidebar-section-toggle]'
      ) as HTMLElement;
      fireEvent.click(todayToggle, { altKey: true });

      const next = lastPrefsWrite();
      for (const id of ['now', 'today', 'pins', 'channels', 'dms', 'agents'] as const) {
        expect(next.sections?.[id]?.collapsed, `Alt-click left "${id}" open`).toBe(true);
      }
      // …and a user's own section goes with them, which is where the fold lives
      // for a group rather than in `sections`.
      expect(next.groups[0]?.collapsed, 'Alt-click left the user’s own section open').toBe(true);
    });

    it('unfolds everything when everything is already folded', async () => {
      // **"Everything" has to mean every header the panel is CURRENTLY drawing**,
      // Getting started included — it folds like the rest now (D1), so a fixture
      // that left it open would make this press mean "fold the one that is
      // still open" and the assertion below would be testing the other branch.
      mockSidebarPrefs.mockReturnValue(
        makePrefs({
          sections: {
            'getting-started': { collapsed: true },
            channels: { collapsed: true },
            agents: { collapsed: true },
          },
        })
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
      {
        ...groupDmWith('r2', ['/projects/alpha', '/projects/beta'], 'Quiet chat'),
        unreadCount: 3,
        working: 2,
      },
    ]);
    renderWithProviders(<DashboardSidebar />);
    const heading = await screen.findByRole('heading', { name: /Direct messages/, level: 3 });
    // The rows are gone…
    expect(screen.queryByText('Quiet chat')).not.toBeInTheDocument();
    // …and everything they were carrying is on the header, in words. It used to
    // be a dot and a pill — two shapes borrowed from the row vocabulary, drawn
    // where no row was. One MEMBER is working, not two: BC-31 counts members
    // currently streaming, so one conversation with two agents in it is one.
    expect(heading.textContent).toContain('1 · 3 unread · 1 working');
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

    // The eight-agents / two-runtimes gate itself moved with the thing it
    // gates: "Agent group" is a New-menu item now, and `NewMenu.test.tsx`
    // asserts the threshold there. What is left to assert HERE is that the
    // section header stopped offering a second door to it (BC-45).
    it('offers no create action from the Agents section header, at any fleet size', async () => {
      mockMeshPaths.mockReturnValue(Array.from({ length: 8 }, (_, i) => `/a/${i}`));
      renderWithProviders(<DashboardSidebar />);
      await screen.findByRole('heading', { name: /Agents/, level: 3 });
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Agents section actions' }));
      // The menu is open and has items — otherwise the two absences below are
      // true of an empty document and prove nothing.
      expect(await screen.findByRole('menuitem', { name: /Show/ })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: /New agent/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: /New section/ })).not.toBeInTheDocument();
    });

    it('reveals each section "+" on focus as well as on hover — a keyboard has no hover', async () => {
      mockRooms.mockReturnValue([
        channel('r1', 'general'),
        groupDmWith('d1', ['/a/1', '/a/2'], 'Alpha'),
      ]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(libraryHeadings()).toContain('Channels'));

      // All three, so a section that quietly loses its keyboard path fails
      // here rather than in a screen reader (R2).
      for (const label of ['New channel', 'New direct message', 'New agent']) {
        const plus = screen.getByRole('button', { name: label });
        // `focus-within` on the SECTION, not `focus-visible` on the control:
        // the `+` is a roving stop now, so arrowing onto it has to reveal it —
        // and `focus-visible` on a button that is invisible until you focus it
        // is a race the browser does not always win.
        expect(plus.className).toContain('group-focus-within/section:opacity-100');
        expect(plus.className).toContain('group-hover/section:opacity-100');
      }
    });

    it('makes each section "+" a keyboard stop, reachable by arrowing off the header', async () => {
      // The defect: `useRovingFocus` stamped every focusable in the section
      // `tabIndex={-1}` and offered stops only for the header and the rows, so
      // "New channel" had a pointer door and no keyboard one at all. Red the
      // moment the `+` drops out of `stopsIn`.
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await screen.findByText('#general');
      const toggle = sectionToggle('Channels');
      toggle.focus();
      fireEvent.keyDown(toggle, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New channel' }));
      // …and one more step reaches the first row, so the `+` is on the way to
      // the list rather than a dead end in it.
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(screen.getByText('#general').closest('button'));
    });

    it('points the Agents section "+" at the one New menu instead of a handler', async () => {
      mockMeshPaths.mockReturnValue(['/a/1', '/a/2', '/a/3']);
      renderWithProviders(<DashboardSidebar />);
      await screen.findByRole('heading', { name: /Agents/, level: 3 });
      expect(useCreateFlowStore.getState().menuOpen).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'New agent' }));

      expect(useCreateFlowStore.getState()).toMatchObject({
        menuOpen: true,
        preselect: 'new-agent',
      });
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
    // **Two rows say "alpha" now, and that is BC-33 itself.** The conversation
    // is Today's anchor and its agent is a Library member, so it renders in
    // both places — a deep link puts a row in Today even before the session
    // list has answered (BC-21). This case is about the LIBRARY copy taking the
    // tint, so it waits for that one by name.
    await waitFor(() => expect(agentRowButton('alpha')).toBeInTheDocument());
    expect(agentRowButton('alpha')).toHaveAttribute('aria-current', 'page');
    expect(agentRowButton('beta')).not.toHaveAttribute('aria-current');
    // Both copies are the SAME conversation, which is what makes the dual
    // presence readable rather than confusing: Today's row is `s1` under
    // alpha's name, and the Library row is alpha itself.
    const anchor = within(todayZone()!).getByRole('button', { current: 'page' });
    expect(anchor.getAttribute('title')).toContain('alpha');
    expect(anchor).not.toBe(agentRowButton('alpha'));
  });

  // ── P2 AC-9 (this task's half): keyboard only ──

  describe('P2 AC-9 — no pointer at any step', () => {
    it('reaches a Library row with the arrow keys and opens it with Enter', async () => {
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await screen.findByText('#general');
      const toggle = sectionToggle('Channels');
      toggle.focus();
      // ArrowDown walks the section: header → its "+" → first row.
      fireEvent.keyDown(toggle, { key: 'ArrowDown' });
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
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

    it('renders a section you just made, empty, with somewhere to drop into', async () => {
      // The one section allowed to render empty. Every other one appears
      // because something is in it — but a section that vanished the instant it
      // was created could never be dragged into, which is exactly how it is
      // filled. The browser spec drives that flow end to end.
      mockSidebarPrefs.mockReturnValue(makePrefs({ groups: [group({ items: [] })] }));
      renderWithProviders(<DashboardSidebar />);
      await screen.findByRole('heading', { name: /Clients/, level: 3 });
      expect(screen.getByText(/Drag channels, conversations or agents here/)).toBeInTheDocument();
    });

    it('tells a smart section with no matches so, rather than hiding it', async () => {
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
      await screen.findByRole('heading', { name: /Wedged/, level: 3 });
      expect(screen.getByText('No agents match these rules')).toBeInTheDocument();
    });

    it('keeps a smart section’s members out of the drag layer', async () => {
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
      const heading = await screen.findByRole('heading', { name: /Live now/, level: 3 });
      // A rule-owned row is not a drag source: dragging one out would ask the
      // operator to hand-edit a list the rules rebuild on the next render. The
      // section HEADER stays draggable (sections reorder), so the assertion is
      // scoped to the rows.
      const body = heading.closest('[data-slot="sidebar-group"]');
      const rows = body?.querySelectorAll('[data-sidebar-row]') ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.closest('[aria-roledescription="sortable"]')).toBeNull();
      }
    });
  });

  // ── The bottom slot is pinned, not scrolled (spec `sidebar-simplification` D4) ──

  describe('the bottom slot', () => {
    it('sits outside the scroller, so a long list can never push it out of sight', () => {
      // The defect this replaces: `PromoSlot` was the LAST CHILD of
      // `SidebarContent`, which is the `overflow-auto` element. Anyone with
      // more than a screen of rows never saw the card again. Moving it back
      // inside the scroller reds this.
      renderWithProviders(<DashboardSidebar />);

      const slot = document.querySelector('[data-slot="sidebar-bottom-slot"]');
      expect(slot).not.toBeNull();
      expect(slot!.closest('[data-slot="sidebar-content"]')).toBeNull();
      // And it really is inside the panel's landmark, not floating loose.
      expect(slot!.closest('nav[aria-label="Sidebar"]')).not.toBeNull();
    });

    it('draws the winning card, and draws it after the scroller in the DOM', () => {
      // Order matters for reading order and for the visual result: the slot is
      // pinned BELOW the list, above the footer.
      renderWithProviders(<DashboardSidebar />);

      const scroller = document.querySelector('[data-slot="sidebar-content"]');
      const slot = document.querySelector('[data-slot="sidebar-bottom-slot"]');
      expect(screen.getByTestId('bottom-slot-card')).toBeTruthy();
      // CONTAINED_BY is excluded deliberately: a descendant also reports as
      // FOLLOWING, so the bare flag would be true for the very arrangement this
      // case exists to forbid — the slot back inside the scroller.
      const position = scroller!.compareDocumentPosition(slot!);
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(position & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeFalsy();
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

// ---------------------------------------------------------------------------
// Heads up, Getting started, and the all-clear beat (P2.2)
// ---------------------------------------------------------------------------

/** DorkBot's directory, the one agent every install has. */
const DORKBOT = '~/.dork/agents/dorkbot';

/** Every suggestion id, so a case can put Getting started to bed wholesale. */
const ALL_SUGGESTIONS = [
  'suggestion:agents-found',
  'suggestion:add-agent',
  'suggestion:first-session',
  'suggestion:say-hi-team',
  'suggestion:ask-dorkbot',
];

/** The Heads up zone's `<section>`, or `null` when the model emitted none. */
function nowZone(): HTMLElement | null {
  return document.querySelector('[data-sidebar-zone="now"]');
}

/**
 * Every row inside a zone, in DOM order, as the words a person reads.
 *
 * The face is dropped: `AgentAvatar` is stubbed to its emoji here, and a row's
 * mark is not part of its sentence.
 */
function zoneRows(zone: HTMLElement | null): string[] {
  if (zone === null) return [];
  return Array.from(zone.querySelectorAll('[data-sidebar-row]')).map((row) => {
    const copy = row.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[data-testid="avatar"]').forEach((node) => node.remove());
    return copy.textContent?.trim() ?? '';
  });
}

/** A session as `GET /api/sessions/recent` carries it. */
function recentSession(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Session ${id}`,
    cwd: '/projects/alpha',
    createdAt: new Date(Date.now() - 7_200_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    permissionMode: 'default',
    runtime: 'claude-code',
    ...overrides,
  };
}

/** An approval waiting on a person. */
function pendingApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: 'apr-1',
    capabilityId: 'files.write',
    capabilityTitle: 'Write a file',
    tier: 'destructive',
    summary: 'Write src/index.ts',
    requestedBy: 'alpha',
    hasAgentPath: true,
    requestedAt: new Date(Date.now() - 540_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

/** Put sessions on the wire and give each one a lifecycle on the live stream. */
function seedSessions(
  entries: { session: ReturnType<typeof recentSession>; lifecycle: SessionLifecycle }[]
) {
  mockRecent.mockReturnValue({
    data: { sessions: entries.map((e) => e.session), agentActivity: {} },
    isLoading: false,
    isSuccess: true,
  });
  act(() => {
    for (const entry of entries) {
      useSessionListStore.getState().setSessionStatus(entry.session.id, {
        lifecycle: entry.lifecycle,
      } as never);
    }
  });
}

/** Mount the sidebar and wait for the approvals read to land. */
async function renderSidebarWithNow() {
  const view = renderWithProviders(<DashboardSidebar />);
  await waitFor(() => expect(mockTransport.listPendingApprovals).toHaveBeenCalled());
  return view;
}

describe('Heads up — the zone that justifies the redesign', () => {
  afterEach(() => cleanup());

  // Its own resets, because this is a sibling of the suite above rather than a
  // block inside it — and a shared mock left holding the previous suite's last
  // answer is exactly how a zone assertion goes green for the wrong reason.
  beforeEach(() => {
    localStorage.clear();
    useInteractionStore.getState().reset();
    useSessionListStore.getState().resetStatuses();
    mockReducedMotion = false;
    mockMeshPaths.mockReset();
    mockMeshPaths.mockReturnValue(['~/.dork/agents/dorkbot', '/projects/alpha', '/projects/beta']);
    mockResolvedAgents.mockReset();
    mockResolvedAgents.mockReturnValue({});
    mockSidebarPrefs.mockReset();
    mockSidebarPrefs.mockReturnValue(makePrefs());
    mockUpdateSidebar.mockReset();
    mockRecent.mockReset();
    mockRecent.mockReturnValue({
      data: { sessions: [], agentActivity: {} },
      isLoading: false,
      isSuccess: true,
    });
    // Every suggestion already answered, so Getting started stays out of the way
    // of the cases that are about Heads up. The block that IS about Getting started
    // gives itself an unretired set (BC-4: they share one slot).
    mockSidebarPrefs.mockReturnValue(makePrefs({ gettingStarted: { retired: ALL_SUGGESTIONS } }));
    mockApprovals.mockReset();
    mockApprovals.mockReturnValue([]);
    mockTasks.mockReset();
    mockTasks.mockReturnValue([]);
    mockTasksEnabled = false;
    mockRooms.mockReset();
    mockRooms.mockReturnValue([]);
    mockThreads.mockReset();
    mockThreads.mockReturnValue([]);
    mockNavigate.mockReset();
    mockAttentionMap.mockReset();
    mockAttentionMap.mockImplementation((paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, 'active']))
    );
    mockSelectedCwd = null;
    mockPathname = '/';
    mockLocation = { pathname: '/', search: {} };
  });

  describe('P2 AC-1 — empty is ABSENT, not hidden', () => {
    it('renders zero DOM nodes with nothing waiting and nothing working', async () => {
      await renderSidebarWithNow();
      // Absence, not a hidden class: there is no element to interrogate.
      expect(nowZone()).toBeNull();
      expect(document.querySelector('[data-sidebar-zone="getting-started"]')).toBeNull();
      expect(document.querySelector('[data-slot="sidebar-all-clear"]')).toBeNull();
      // And the sidebar itself DID render — otherwise "no zone" is only a
      // statement about a tree that never mounted.
      expect(document.querySelector('[data-sidebar-zone="library"]')).not.toBeNull();
    });

    it('renders the zone the moment something needs you', async () => {
      mockApprovals.mockReturnValue([pendingApproval()]);
      await renderSidebarWithNow();
      await waitFor(() => expect(nowZone()).not.toBeNull());
      expect(zoneRows(nowZone())).toEqual(['alpha›Write a file']);
    });

    // The zone's id is `now` and its heading is "Heads up" — the split DOR-1155
    // deliberately left in place, because renaming the id would cost a
    // persisted-config migration and buy the operator nothing. Both halves are
    // asserted in one breath: the element is found BY the id, and read FOR the
    // label, so a rename of either without the other reddens here.
    it('heads the zone "Heads up", under the id `now` (DOR-1155)', async () => {
      mockApprovals.mockReturnValue([pendingApproval()]);
      await renderSidebarWithNow();
      await waitFor(() => expect(nowZone()).not.toBeNull());
      // The name moved from a zone `<h2>` onto the section's own `<h3>` (D1) —
      // Heads up wears the same header as every other section now, and the
      // landmark carries the name for assistive tech.
      expect(nowZone()!.querySelector('h2')).toBeNull();
      expect(nowZone()!.getAttribute('aria-label')).toBe('Heads up');
      const heading = nowZone()!.querySelector('h3');
      expect(heading).not.toBeNull();
      expect(heading!.textContent).toContain('Heads up');
    });

    it('folds Heads up like any other header, and keeps the needs-you count on it', async () => {
      // The exception D1 removed, and the safety that let it go: folding Heads
      // up may never be a quiet way to put a permission prompt out of sight, so
      // the folded header counts what NEEDS answering rather than its rows.
      mockApprovals.mockReturnValue([pendingApproval()]);
      mockSidebarPrefs.mockReturnValue(makePrefs({ sections: { now: { collapsed: true } } }));
      await renderSidebarWithNow();
      await waitFor(() => expect(nowZone()).not.toBeNull());
      const heading = nowZone()!.querySelector('h3')!;
      expect(heading.textContent).toContain('1 need you');
      expect(heading.querySelector('[data-sidebar-section-toggle]')).toHaveAttribute(
        'aria-expanded',
        'false'
      );
    });

    it('writes Heads up’s fold to its own persisted key', async () => {
      mockApprovals.mockReturnValue([pendingApproval()]);
      await renderSidebarWithNow();
      await waitFor(() => expect(nowZone()).not.toBeNull());
      const toggle = nowZone()!.querySelector('[data-sidebar-section-toggle]') as HTMLElement;
      fireEvent.click(toggle);
      // Without `now` in `SidebarSectionIdSchema` this write has nowhere to go
      // and `toggleCollapsed` returns early — a chevron that does nothing.
      expect(lastPrefsWrite().sections?.now?.collapsed).toBe(true);
    });
  });

  describe('P2 AC-5 — what can never be in Heads up', () => {
    it('keeps mentions, DMs, unread channels and automated activity out', async () => {
      // The name is honest again as of the 2026-08-10 ruling: a scheduled run is
      // not counted as working, so an automated session streaming on its own
      // leaves Heads up with nothing at all to say. Before that ruling this exact
      // fixture drew a "1 working" row — automated activity rendered in the one
      // zone that promises to hold only what needs you.
      mockRooms.mockReturnValue([
        { ...channel('c1', 'deploys'), unreadCount: 12 },
        { ...groupDmWith('d1', ['/projects/alpha', '/projects/beta'], 'alpha'), unreadCount: 6 },
      ]);
      seedSessions([
        {
          session: recentSession('auto', { origin: 'task', title: 'Nightly sweep' }),
          lifecycle: 'streaming',
        },
      ]);
      mockSelectedCwd = null;
      await renderSidebarWithNow();

      // The rooms and the automated session ARE in the panel — this is not a
      // test of an empty cockpit.
      await waitFor(() => expect(document.body.textContent).toContain('deploys'));
      expect(document.querySelector('[data-sidebar-zone="library"]')).not.toBeNull();
      // And Heads up is absent entirely: no rollup, no room, no DM, no unread count.
      expect(nowZone()).toBeNull();
    });

    it('does raise the rollup for a HUMAN session, so the absence above is the filter', async () => {
      // The discriminating half. Identical to the case above but for the
      // session's origin — remove the exclusion and both draw a rollup, so only
      // this one would still be passing for the right reason.
      mockRooms.mockReturnValue([{ ...channel('c1', 'deploys'), unreadCount: 12 }]);
      seedSessions([
        { session: recentSession('human', { title: 'Ship the parser' }), lifecycle: 'streaming' },
      ]);
      await renderSidebarWithNow();

      await waitFor(() => expect(zoneRows(nowZone())).toEqual(['1 working']));
    });
  });

  describe('BC-6 — priority order', () => {
    it('answers permission prompt, then error — and says nothing about quiet', async () => {
      mockApprovals.mockReturnValue([]);
      seedSessions([
        // Quiet for 45 minutes, which is exactly what the retired idle nudge
        // fired on (DOR-1391). Its absence from the rows is the assertion, and
        // the two rows beside it are what keeps that absence meaningful.
        {
          session: recentSession('idle-1', {
            title: 'Idle one',
            updatedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
          }),
          lifecycle: 'idle',
        },
        { session: recentSession('err-1', { title: 'Wedged one' }), lifecycle: 'error' },
        { session: recentSession('blk-1', { title: 'Blocked one' }), lifecycle: 'blocked' },
      ]);
      await renderSidebarWithNow();
      await waitFor(() => expect(nowZone()).not.toBeNull());

      expect(zoneRows(nowZone())).toEqual(['alpha›Waiting on you', 'alpha›Stopped with an error']);
    });

    it('puts a parked schedule between the prompts and the error (DOR-1391)', async () => {
      mockTasksEnabled = true;
      mockTasks.mockReturnValue([parkedSchedule({ id: 'tsk-1', displayName: 'Nightly audit' })]);
      seedSessions([
        { session: recentSession('err-1', { title: 'Wedged one' }), lifecycle: 'error' },
        { session: recentSession('blk-1', { title: 'Blocked one' }), lifecycle: 'blocked' },
      ]);
      await renderSidebarWithNow();

      await waitFor(() =>
        expect(zoneRows(nowZone())).toEqual([
          'alpha›Waiting on you',
          'Nightly audit›Wants to run on a timer',
          'alpha›Stopped with an error',
        ])
      );
    });

    it('opens the Tasks page when the schedule row is pressed', async () => {
      mockTasksEnabled = true;
      mockTasks.mockReturnValue([parkedSchedule({ id: 'tsk-1', displayName: 'Nightly audit' })]);
      await renderSidebarWithNow();
      await waitFor(() =>
        expect(zoneRows(nowZone())).toEqual(['Nightly audit›Wants to run on a timer'])
      );

      mockNavigate.mockClear();
      fireEvent.click(nowZone()!.querySelector('[data-sidebar-row]')!);
      // An attention row travels by raw href, which is what `SidebarChrome`
      // hands the router for every signal's deep link.
      expect(mockRouterNavigate).toHaveBeenCalledWith({ href: '/tasks' });
    });
  });

  describe('BC-7 / BC-8 — the cap, the overflow, and never scrolling', () => {
    it('shows three rows and "+ N more", and the overflow goes to the home surface', async () => {
      mockApprovals.mockReturnValue(
        Array.from({ length: 7 }, (_, i) =>
          pendingApproval({
            approvalId: `apr-${i}`,
            capabilityTitle: `Capability ${i}`,
            requestedAt: new Date(Date.now() - (7 - i) * 60_000).toISOString(),
          })
        )
      );
      await renderSidebarWithNow();
      await waitFor(() => expect(nowZone()).not.toBeNull());

      const rows = zoneRows(nowZone());
      expect(rows).toHaveLength(4);
      expect(rows.at(-1)).toBe('+ 4 more');

      mockNavigate.mockClear();
      const overflow = Array.from(nowZone()!.querySelectorAll('[data-sidebar-row]')).at(-1)!;
      fireEvent.click(overflow);
      // The real route, not a stubbed handler: `/` is where the triage header
      // already holds the full list (BC-7).
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/' });
    });

    it('never grows past five rows, however much is waiting', async () => {
      mockApprovals.mockReturnValue(
        Array.from({ length: 7 }, (_, i) => pendingApproval({ approvalId: `apr-${i}` }))
      );
      seedSessions([
        { session: recentSession('w1'), lifecycle: 'streaming' },
        { session: recentSession('w2'), lifecycle: 'streaming' },
      ]);
      await renderSidebarWithNow();
      await waitFor(() => expect(nowZone()).not.toBeNull());
      // 3 attention + 1 overflow + 1 working rollup, a fixed ceiling (BC-8).
      await waitFor(() => expect(zoneRows(nowZone())).toHaveLength(5));
    });
  });

  describe('BC-9 — the working rollup', () => {
    it('aggregates three streaming sessions into one line', async () => {
      seedSessions([
        { session: recentSession('w1'), lifecycle: 'streaming' },
        { session: recentSession('w2'), lifecycle: 'streaming' },
        { session: recentSession('w3'), lifecycle: 'streaming' },
      ]);
      await renderSidebarWithNow();
      await waitFor(() => expect(zoneRows(nowZone())).toEqual(['3 working']));
    });

    // DOR-1105: the row looked pressable and did nothing. Home is where the
    // presence of who is working already lives, so that is where it goes — the
    // same destination "+ N more" has. Delete the `working` arm from
    // `SidebarChrome`'s rollup case and this goes red.
    it('goes to the home surface when pressed, rather than nowhere', async () => {
      seedSessions([
        { session: recentSession('w1'), lifecycle: 'streaming' },
        { session: recentSession('w2'), lifecycle: 'streaming' },
      ]);
      await renderSidebarWithNow();
      await waitFor(() => expect(zoneRows(nowZone())).toEqual(['2 working']));

      mockNavigate.mockClear();
      const rollup = nowZone()!.querySelector('[data-sidebar-row]')!;
      fireEvent.click(rollup);

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/' });
    });

    it('says nothing when the ONE working session is the one you are looking at', async () => {
      seedSessions([{ session: recentSession('w1'), lifecycle: 'streaming' }]);
      mockLocation = { pathname: '/session', search: { session: 'w1', dir: '/projects/alpha' } };
      mockPathname = '/session';
      await renderSidebarWithNow();
      expect(nowZone()).toBeNull();
    });
  });

  describe('BC-42 / DOR-1391 — nothing in Heads up can be waved away', () => {
    it('draws no row at all for a session that has only gone quiet', async () => {
      // The retired nudge, at the exact staleness it used to fire on. The zone
      // does not appear, because nothing else here needs anybody.
      seedSessions([
        {
          session: recentSession('idle-1', {
            updatedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
          }),
          lifecycle: 'idle',
        },
      ]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(document.body.textContent).toContain('Agents'));

      expect(nowZone()).toBeNull();
      expect(document.body.textContent).not.toContain('Went quiet');
    });

    it('offers no row menu anywhere in Heads up', async () => {
      // Every kind at once, including the schedule that arrived with DOR-1391:
      // not one of them is dismissible, so not one of them has a "⋯".
      mockApprovals.mockReturnValue([pendingApproval()]);
      mockTasksEnabled = true;
      mockTasks.mockReturnValue([parkedSchedule({ id: 'tsk-1', displayName: 'Nightly audit' })]);
      seedSessions([
        { session: recentSession('err-1', { title: 'Wedged one' }), lifecycle: 'error' },
      ]);
      await renderSidebarWithNow();
      // Three rows first: an assertion about "no menus" over an empty zone
      // would pass against a sidebar that drew nothing at all.
      await waitFor(() => expect(zoneRows(nowZone())).toHaveLength(3));

      expect(nowZone()!.querySelectorAll('[data-sidebar-actions]')).toHaveLength(0);
    });

    it('and a row that DOES carry a menu still draws one, elsewhere in the panel', async () => {
      // The discriminating half: `data-sidebar-actions` is a real handle this
      // panel emits, so its absence above is a fact about Heads up rather than
      // about the selector.
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(document.body.textContent).toContain('Agents'));

      expect(document.querySelectorAll('[data-sidebar-actions]').length).toBeGreaterThan(0);
    });

    it('offers no snooze and no dismiss anywhere in the sidebar', () => {
      const dir = join(__dirname, '..');
      const files = [
        'ui/SidebarModelRow.tsx',
        'ui/SidebarZone.tsx',
        'ui/SidebarZones.tsx',
        'ui/AllClearBeat.tsx',
        'model/rules/select-now-items.ts',
        'model/rules/cap-now-items.ts',
      ];
      // Comments stripped: both words appear in prose SAYING there is neither,
      // and a scan that reds on its own explanation would be satisfied by
      // deleting the explanation.
      const code = files.map((f) =>
        readFileSync(join(dir, f), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '')
      );
      // Named files, read for real: a scan over a directory that had been
      // renamed would report the same clean answer as one that is really clean.
      expect(code).toHaveLength(files.length);
      for (const source of code) {
        expect(source.toLowerCase()).not.toContain('snooze');
        // DOR-1391 retired the one dismissible thing in the zone with the idle
        // nudge itself, so the store, its helper and the menu that ran it are
        // all gone from these files.
        expect(source).not.toContain('dismiss');
      }
      // And the read reaches real code — a spelling that IS there is found.
      expect(code.some((source) => source.includes('selectNowItems'))).toBe(true);
    });
  });

  describe('BC-11 — the live region announces counts, and only counts', () => {
    it('publishes the count once, a second after it changes', async () => {
      vi.useFakeTimers();
      try {
        mockApprovals.mockReturnValue([
          pendingApproval({ approvalId: 'a' }),
          pendingApproval({ approvalId: 'b' }),
        ]);
        renderWithProviders(<DashboardSidebar />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
        const region = () =>
          nowZone()?.querySelector('[aria-live="polite"]')?.textContent?.trim() ?? '';

        // The zone is up and the region is still silent: the debounce is real.
        expect(nowZone()).not.toBeNull();
        expect(region()).toBe('');

        await act(async () => {
          await vi.advanceTimersByTimeAsync(LIVE_REGION_DEBOUNCE_MS);
        });
        expect(region()).toBe('2 agents need you');
      } finally {
        vi.useRealTimers();
      }
    });

    it('says nothing new across twenty activity events', async () => {
      vi.useFakeTimers();
      try {
        mockApprovals.mockReturnValue([pendingApproval({ approvalId: 'a' })]);
        seedSessions([{ session: recentSession('w1'), lifecycle: 'streaming' }]);
        renderWithProviders(<DashboardSidebar />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(LIVE_REGION_DEBOUNCE_MS + 100);
        });
        const region = () =>
          nowZone()?.querySelector('[aria-live="polite"]')?.textContent?.trim() ?? '';
        expect(region()).toBe('1 agent needs you');

        for (let i = 0; i < 20; i += 1) {
          act(() => {
            useSessionListStore.getState().setSessionStatus('w1', {
              lifecycle: 'streaming',
              activity: { kind: 'tool', toolName: `Tool${i}`, at: new Date().toISOString() },
            } as never);
          });
        }
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_000);
        });
        expect(region()).toBe('1 agent needs you');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('BC-50 — the all-clear beat', () => {
    it('settles with "All clear" for 2.5s, then folds away', async () => {
      vi.useFakeTimers();
      try {
        mockApprovals.mockReturnValue([pendingApproval()]);
        const view = renderWithProviders(<DashboardSidebar />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
        expect(nowZone()).not.toBeNull();

        // The last item resolves.
        mockApprovals.mockReturnValue([]);
        await act(async () => {
          void view.queryClient.invalidateQueries();
          await vi.advanceTimersByTimeAsync(50);
        });

        expect(document.querySelector('[data-slot="sidebar-all-clear"]')?.textContent).toContain(
          'All clear'
        );

        await act(async () => {
          await vi.advanceTimersByTimeAsync(ALL_CLEAR_BEAT_MS);
        });
        expect(document.querySelector('[data-slot="sidebar-all-clear"]')).toBeNull();
        expect(nowZone()).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('abandons the beat when Heads up comes straight back holding a working session', async () => {
      // **The interleaving that stranded the flag.** Resolve the last approval,
      // and an agent starts a turn inside the beat's own 2.5 seconds: Heads up
      // returns holding only "1 working", so the needs-you count is still zero
      // while the zone exists again. The effect re-runs, React's cleanup has
      // already cancelled the timer that would have lowered the flag, and every
      // early return left it raised — so when the turn ended and the zone went
      // away, "All clear ✓" came back with nothing to take it away again.
      vi.useFakeTimers();
      try {
        mockApprovals.mockReturnValue([pendingApproval()]);
        const view = renderWithProviders(<DashboardSidebar />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
        expect(nowZone()).not.toBeNull();

        // The last thing needing you resolves. The beat starts.
        mockApprovals.mockReturnValue([]);
        await act(async () => {
          void view.queryClient.invalidateQueries();
          await vi.advanceTimersByTimeAsync(50);
        });
        expect(document.querySelector('[data-slot="sidebar-all-clear"]')).not.toBeNull();

        // An agent starts a turn, well inside the beat.
        await act(async () => {
          useSessionListStore
            .getState()
            .setSessionStatus('w1', { lifecycle: 'streaming' } as never);
          await vi.advanceTimersByTimeAsync(200);
        });
        // The zone is back, and it is the working rollup — not the beat.
        expect(zoneRows(nowZone())).toEqual(['1 working']);
        expect(document.querySelector('[data-slot="sidebar-all-clear"]')).toBeNull();

        // The turn ends. Nothing is waiting and nothing is working, so the zone
        // must be gone — permanently, not until something re-renders.
        await act(async () => {
          useSessionListStore.getState().setSessionStatus('w1', { lifecycle: 'idle' } as never);
          await vi.advanceTimersByTimeAsync(50);
        });
        expect(document.querySelector('[data-slot="sidebar-all-clear"]')).toBeNull();
        expect(nowZone()).toBeNull();

        // And it stays gone long past the beat's own life, which is what says
        // the flag was lowered rather than merely waiting on a timer.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ALL_CLEAR_BEAT_MS * 4);
        });
        expect(document.querySelector('[data-slot="sidebar-all-clear"]')).toBeNull();
        expect(nowZone()).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('never renders under a reduced-motion preference', async () => {
      vi.useFakeTimers();
      mockReducedMotion = true;
      try {
        mockApprovals.mockReturnValue([pendingApproval()]);
        const view = renderWithProviders(<DashboardSidebar />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
        expect(nowZone()).not.toBeNull();

        mockApprovals.mockReturnValue([]);
        await act(async () => {
          void view.queryClient.invalidateQueries();
          await vi.advanceTimersByTimeAsync(50);
        });

        expect(document.querySelector('[data-slot="sidebar-all-clear"]')).toBeNull();
        expect(nowZone()).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('Getting started — Heads up’s first life stage (BC-4, BC-12 → BC-14)', () => {
  afterEach(() => cleanup());

  /** The Getting-started zone's `<section>`, or `null`. */
  const zone = () => document.querySelector<HTMLElement>('[data-sidebar-zone="getting-started"]');

  beforeEach(() => {
    localStorage.clear();
    useInteractionStore.getState().reset();
    useSessionListStore.getState().resetStatuses();
    useDiscoveryStore.setState({ candidates: [] });
    mockReducedMotion = false;
    // A day-one install: DorkBot and nothing else, no session ever.
    mockMeshPaths.mockReset();
    mockMeshPaths.mockReturnValue([DORKBOT]);
    mockResolvedAgents.mockReset();
    mockResolvedAgents.mockReturnValue({
      [DORKBOT]: { id: 'dorkbot', name: 'dorkbot', isSystem: true } as never,
    });
    mockSidebarPrefs.mockReset();
    mockSidebarPrefs.mockReturnValue(makePrefs());
    mockUpdateSidebar.mockReset();
    mockRecent.mockReset();
    mockRecent.mockReturnValue({
      data: { sessions: [], agentActivity: {} },
      isLoading: false,
      isSuccess: true,
    });
    mockApprovals.mockReset();
    mockApprovals.mockReturnValue([]);
    mockTasks.mockReset();
    mockTasks.mockReturnValue([]);
    mockTasksEnabled = false;
    mockRooms.mockReset();
    mockRooms.mockReturnValue([]);
    mockThreads.mockReset();
    mockThreads.mockReturnValue([]);
    mockNavigate.mockReset();
    mockAttentionMap.mockReset();
    mockAttentionMap.mockImplementation((paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, 'active']))
    );
    mockSelectedCwd = null;
    mockPathname = '/';
    mockLocation = { pathname: '/', search: {} };
  });

  it('offers what a day-one install has not done yet', async () => {
    await renderSidebarWithNow();
    await waitFor(() => expect(zone()).not.toBeNull());
    expect(zoneRows(zone())).toEqual(['Add your first agent', 'Ask DorkBot anything']);
  });

  it('counts what discovery found, and drops the fallback when it found any', async () => {
    act(() => {
      useDiscoveryStore.setState({
        candidates: [
          {
            path: '/code/one',
            strategy: 'fs',
            hints: {},
            discoveredAt: '2026-08-09T00:00:00.000Z',
          },
          {
            path: '/code/two',
            strategy: 'fs',
            hints: {},
            discoveredAt: '2026-08-09T00:00:00.000Z',
          },
        ] as never,
      });
    });
    await renderSidebarWithNow();
    await waitFor(() => expect(zone()).not.toBeNull());
    // `agents-found` and `add-agent` are mutually exclusive: telling somebody to
    // add their first agent when the product just found two is nonsense.
    expect(zoneRows(zone())).toEqual(['Meet the 2 agents we found', 'Ask DorkBot anything']);
  });

  it('gives Heads up the slot the moment something real needs you (BC-4)', async () => {
    mockApprovals.mockReturnValue([pendingApproval()]);
    await renderSidebarWithNow();
    await waitFor(() => expect(nowZone()).not.toBeNull());
    expect(zone()).toBeNull();
  });

  /**
   * Make the sidebar look again.
   *
   * A store tick rather than RTL's `rerender`, which re-renders the element it
   * is handed into the same container and so drops the providers around it.
   */
  const tick = () =>
    act(() => {
      useDiscoveryStore.setState({ candidates: [...useDiscoveryStore.getState().candidates] });
    });

  it('retires a suggestion the operator has answered, permanently (BC-13)', async () => {
    await renderSidebarWithNow();
    await waitFor(() => expect(zoneRows(zone())).toContain('Add your first agent'));
    expect(mockUpdateSidebar).not.toHaveBeenCalled();

    // The operator adds an agent. `add-agent` stops applying.
    mockMeshPaths.mockReturnValue([DORKBOT, '/projects/alpha']);
    mockResolvedAgents.mockReturnValue({
      [DORKBOT]: { id: 'dorkbot', name: 'dorkbot', isSystem: true } as never,
      '/projects/alpha': { id: 'alpha', name: 'alpha' } as never,
    });
    tick();

    await waitFor(() => expect(mockUpdateSidebar).toHaveBeenCalled());
    expect(lastPrefsWrite().gettingStarted.retired).toEqual(['suggestion:add-agent']);
  });

  it('does not retire anything before the roster has answered', async () => {
    // The loading placeholder says "nothing to suggest" for every fact, which is
    // indistinguishable from an operator finishing all five at once. Retiring on
    // it would erase the whole of Getting started on a cold load, for good.
    // Since D6 the bit that tells the two apart is the boot gate, so this case
    // is a cold panel rather than one unanswered query.
    boot.state = { phase: 'cold', settled: false, fleetKnown: false, startedWarm: false };
    mockRecent.mockReturnValue({ data: undefined, isLoading: true, isSuccess: false });
    await renderSidebarWithNow();
    tick();
    expect(zone()).toBeNull();
    expect(mockUpdateSidebar).not.toHaveBeenCalled();
  });

  it('is gone for good once every suggestion is retired (BC-14)', async () => {
    mockSidebarPrefs.mockReturnValue(makePrefs({ gettingStarted: { retired: ALL_SUGGESTIONS } }));
    await renderSidebarWithNow();
    // The panel rendered — this is not a statement about an empty tree.
    expect(document.querySelector('[data-sidebar-zone="library"]')).not.toBeNull();
    expect(zone()).toBeNull();
  });

  it('sends each suggestion somewhere real', async () => {
    await renderSidebarWithNow();
    await waitFor(() => expect(zone()).not.toBeNull());
    const rows = Array.from(zone()!.querySelectorAll('[data-sidebar-row]'));
    expect(rows).toHaveLength(2);

    fireEvent.click(rows[0]!);
    expect(useAgentCreationStore.getState().isOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Today — the zone whose whole promise is that it holds still (BC-15 → BC-22,
// BC-36, BC-41)
// ---------------------------------------------------------------------------

/** The Today zone's `<section>`, or `null` when the model emitted none. */
function todayZone(): HTMLElement | null {
  return document.querySelector('[data-sidebar-zone="today"]');
}

/** Today's row elements, in DOM order. */
function todayRowNodes(): HTMLElement[] {
  const zone = todayZone();
  if (zone === null) return [];
  return Array.from(zone.querySelectorAll('[data-sidebar-row]'));
}

/**
 * What Today is showing, in DOM order, as one stable label per row.
 *
 * Read off the DOM rather than off the model on purpose: BC-17 is a claim about
 * what MOVED on screen, and a model diff cannot see a deferral that the
 * renderer applied.
 *
 * The `title` attribute rather than the row's text, and that matters: the text
 * includes the second line, so a live verb changing from "Reading…" to
 * "Editing…" would look exactly like a row that moved. `composeRowLabel` builds
 * this from the who and the title, both of which are what the row IS.
 */
function todayOrder(): string[] {
  return todayRowNodes().map((row) => row.getAttribute('title') ?? row.textContent?.trim() ?? '');
}

/** The element the operator's pointer and focus enter — the zone's wrapper. */
function todayWrapper(): HTMLElement {
  const zone = todayZone();
  expect(zone, 'no Today zone rendered').not.toBeNull();
  const wrapper = zone!.parentElement;
  expect(wrapper, 'Today has no wrapper to hold pointer state').not.toBeNull();
  return wrapper as HTMLElement;
}

/** Put the router on a session, exactly as opening one does. */
function openRoute(sessionId: string, cwd = '/projects/alpha') {
  mockPathname = '/session';
  mockLocation = { pathname: '/session', search: { session: sessionId, dir: cwd } };
}

/**
 * Mount the sidebar with a `refresh` that keeps its providers.
 *
 * RTL's own `rerender` replaces the WHOLE tree with what it is handed, so
 * `rerender(<DashboardSidebar />)` would drop the query client the panel reads
 * through — the router is mocked at module scope here, so a route change needs
 * a re-render to be seen, and it must be a re-render of the same tree.
 */
function mountSidebar() {
  const view = renderWithProviders(<DashboardSidebar />);
  const refresh = () =>
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <TransportProvider transport={mockTransport as never}>
          <TooltipProvider>
            <SidebarProvider>
              <DashboardSidebar />
            </SidebarProvider>
          </TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    );
  return { ...view, refresh };
}

describe('Today — what you were doing, and it holds still', () => {
  /** Every `scrollIntoView` this test's rows received. */
  let scrolls: { node: Element; options: ScrollIntoViewOptions | undefined }[];
  let originalScrollIntoView: typeof Element.prototype.scrollIntoView;

  afterEach(() => {
    cleanup();
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  beforeEach(() => {
    localStorage.clear();
    useInteractionStore.getState().reset();
    useSessionListStore.getState().resetStatuses();
    mockReducedMotion = false;
    mockMeshPaths.mockReset();
    mockMeshPaths.mockReturnValue(['~/.dork/agents/dorkbot', '/projects/alpha', '/projects/beta']);
    mockResolvedAgents.mockReset();
    mockResolvedAgents.mockReturnValue({});
    mockSidebarPrefs.mockReset();
    mockSidebarPrefs.mockReturnValue(makePrefs({ gettingStarted: { retired: ALL_SUGGESTIONS } }));
    mockUpdateSidebar.mockReset();
    mockRecent.mockReset();
    mockRecent.mockReturnValue({
      data: { sessions: [], agentActivity: {} },
      isLoading: false,
      isSuccess: true,
    });
    mockApprovals.mockReset();
    mockApprovals.mockReturnValue([]);
    mockTasks.mockReset();
    mockTasks.mockReturnValue([]);
    mockTasksEnabled = false;
    mockRooms.mockReset();
    mockRooms.mockReturnValue([]);
    mockThreads.mockReset();
    mockThreads.mockReturnValue([]);
    mockNavigate.mockReset();
    mockAttentionMap.mockReset();
    mockAttentionMap.mockImplementation((paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, 'active']))
    );
    mockSelectedCwd = null;
    mockPathname = '/';
    mockLocation = { pathname: '/', search: {} };
    useTodayRevealStore.getState().reset();

    // jsdom implements no scrolling at all, so the method has to exist before
    // anything can be said about how it was called.
    scrolls = [];
    originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoViewSpy(
      options?: boolean | ScrollIntoViewOptions
    ) {
      scrolls.push({ node: this, options: options as ScrollIntoViewOptions | undefined });
    };
  });

  /** Three conversations, opened in a known order, oldest touch first. */
  function seedThreeConversations() {
    seedSessions([
      { session: recentSession('ses-a', { title: 'Alpha work' }), lifecycle: 'idle' },
      { session: recentSession('ses-b', { title: 'Beta work' }), lifecycle: 'idle' },
      { session: recentSession('ses-c', { title: 'Gamma work' }), lifecycle: 'idle' },
    ]);
    act(() => {
      useInteractionStore.getState().recordOpened('session', 'ses-a', Date.now() - 30_000);
      useInteractionStore.getState().recordOpened('session', 'ses-b', Date.now() - 20_000);
      useInteractionStore.getState().recordOpened('session', 'ses-c', Date.now() - 10_000);
    });
  }

  describe('BC-21 / P2 AC-3 — the anchor', () => {
    it('is Today’s first row on every route change', () => {
      seedThreeConversations();
      // `ses-a` is the OLDEST touch, so anything but the anchor rule puts it last.
      openRoute('ses-a');
      const view = mountSidebar();
      expect(todayOrder()[0]).toContain('Alpha work');

      openRoute('ses-b');
      view.refresh();
      expect(todayOrder()[0]).toContain('Beta work');

      openRoute('ses-c');
      view.refresh();
      expect(todayOrder()[0]).toContain('Gamma work');
    });

    it('never appears in Heads up', () => {
      seedThreeConversations();
      openRoute('ses-a');
      mountSidebar();
      expect(zoneRows(nowZone())).not.toContainEqual(expect.stringContaining('Alpha work'));
    });
  });

  describe('BC-17 — rows never move under a cursor that is about to click', () => {
    it('withholds a legitimate reorder while the pointer is inside, and applies it on leave', () => {
      seedThreeConversations();
      mountSidebar();
      const before = todayOrder();
      expect(before[0]).toContain('Gamma work');

      fireEvent.pointerEnter(todayWrapper());

      // A real reorder: this operator touched `ses-a` on another device, which
      // is the one thing that legitimately moves a Today row.
      act(() => {
        useInteractionStore.getState().recordOpened('session', 'ses-a', Date.now() + 60_000);
      });
      expect(todayOrder()).toEqual(before);

      // The paired half — without it, "did not move" would also pass on a
      // sidebar that never reorders at all.
      fireEvent.pointerLeave(todayWrapper());
      expect(todayOrder()[0]).toContain('Alpha work');
    });

    it('does the same for a focused row, and releases on blur', () => {
      seedThreeConversations();
      mountSidebar();
      const before = todayOrder();

      fireEvent.focus(todayRowNodes()[0]!);
      act(() => {
        useInteractionStore.getState().recordOpened('session', 'ses-a', Date.now() + 60_000);
      });
      expect(todayOrder()).toEqual(before);

      fireEvent.blur(todayRowNodes()[0]!);
      expect(todayOrder()[0]).toContain('Alpha work');
    });

    it('still lets a row’s CONTENT change while its place is held', () => {
      // The hold is about position, not about freezing the panel: a row that
      // went quiet under the pointer must still stop saying it is working.
      seedThreeConversations();
      mountSidebar();
      fireEvent.pointerEnter(todayWrapper());
      act(() => {
        useSessionListStore.getState().setSessionStatus('ses-c', {
          lifecycle: 'streaming',
        } as never);
      });
      const streaming = todayRowNodes()[0]!;
      expect(streaming.querySelector('[data-slot="sidebar-row-second-line"]')).not.toBeNull();
    });

    it('lets the operator’s own conversation switch through immediately', () => {
      // The hold defers reorders nobody asked for. Switching conversations IS
      // the ask (BC-21), and a pointer resting in the zone must not out-vote it.
      seedThreeConversations();
      const view = mountSidebar();
      fireEvent.pointerEnter(todayWrapper());
      openRoute('ses-a');
      view.refresh();
      expect(todayOrder()[0]).toContain('Alpha work');
    });
  });

  describe('BC-36 — scroll-to-active, and its guardrails', () => {
    it('scrolls on a conversation switch, and not on an activity event', () => {
      seedThreeConversations();
      openRoute('ses-a');
      const view = mountSidebar();
      // Arriving on a page is not a switch — the panel PLACES the open row on
      // its first settled model and never travels to it (spec D6).
      expect(scrolls).toHaveLength(1);
      expect(scrolls[0]!.options?.behavior).toBe('auto');
      scrolls.length = 0;

      act(() => {
        useSessionListStore.getState().setSessionStatus('ses-b', {
          lifecycle: 'streaming',
          activity: { kind: 'tool', toolName: 'Read', at: new Date().toISOString() },
        } as never);
      });
      view.refresh();
      expect(scrolls, 'an agent working is not a reason to move the panel').toHaveLength(0);

      openRoute('ses-b');
      view.refresh();
      expect(scrolls).toHaveLength(1);
      expect(scrolls[0]!.node.getAttribute('aria-current')).toBe('page');
      expect(todayZone()!.contains(scrolls[0]!.node)).toBe(true);
    });

    it('does not scroll on an unread change', async () => {
      seedThreeConversations();
      mockRooms.mockReturnValue([channel('c1', 'general')]);
      act(() => {
        useInteractionStore.getState().recordOpened('room', 'c1', Date.now() - 5_000);
      });
      openRoute('ses-a');
      const view = mountSidebar();
      // The room list is a real query over the mocked transport, so the row it
      // draws arrives a tick later. Without this wait the case would assert
      // "nothing scrolled" about a panel that had no room in it.
      await waitFor(() => expect(todayOrder()).toContainEqual(expect.stringContaining('general')));
      scrolls.length = 0;

      mockRooms.mockReturnValue([{ ...channel('c1', 'general'), unreadCount: 4 }]);
      await view.queryClient.invalidateQueries();
      await waitFor(() =>
        expect(
          todayRowNodes().find((row) => row.textContent?.includes('general'))?.className
        ).toContain('font-medium')
      );
      expect(scrolls).toHaveLength(0);

      // Paired: the same tree DOES scroll when the conversation changes.
      openRoute('ses-b');
      view.refresh();
      expect(scrolls).toHaveLength(1);
    });

    it('does not scroll on a model rebuild that changed no conversation', () => {
      seedThreeConversations();
      openRoute('ses-a');
      const view = mountSidebar();
      scrolls.length = 0;
      view.refresh();
      view.refresh();
      expect(scrolls).toHaveLength(0);
    });

    it('jumps instantly under a reduced-motion preference', () => {
      mockReducedMotion = true;
      seedThreeConversations();
      openRoute('ses-a');
      const view = mountSidebar();
      openRoute('ses-b');
      view.refresh();
      expect(scrolls[0]?.options?.behavior).toBe('auto');
    });

    it('travels when motion is allowed — the other half of the same switch', () => {
      seedThreeConversations();
      openRoute('ses-a');
      const view = mountSidebar();
      // The boot's own positioning, discarded: it is instant by design, and
      // what this case is about is the switch that follows it.
      scrolls.length = 0;
      openRoute('ses-b');
      view.refresh();
      expect(scrolls[0]?.options?.behavior).toBe('smooth');
    });

    it('never opens a collapsed Library section to reach the same conversation', () => {
      seedThreeConversations();
      mockSidebarPrefs.mockReturnValue(
        makePrefs({
          gettingStarted: { retired: ALL_SUGGESTIONS },
          sections: { agents: { collapsed: true } },
        })
      );
      openRoute('ses-a');
      const view = mountSidebar();
      expect(sectionToggle('Agents').getAttribute('aria-expanded')).toBe('false');
      scrolls.length = 0;

      openRoute('ses-b');
      view.refresh();
      expect(scrolls).toHaveLength(1);
      expect(sectionToggle('Agents').getAttribute('aria-expanded')).toBe('false');
      expect(mockUpdateSidebar).not.toHaveBeenCalled();
    });
  });

  describe('P2 AC-2 — a hundred activity events move nothing and redraw nothing', () => {
    it('changes no row’s position and touches only the row the events belong to', () => {
      seedThreeConversations();
      mountSidebar();

      // All three streaming first: STARTING a turn is a lifecycle change and is
      // allowed to redraw — it is what `reservesVerbLine` is derived from. What
      // follows is activity, and only activity.
      const ids = ['ses-a', 'ses-b', 'ses-c'];
      act(() => {
        for (const id of ids) {
          useSessionListStore.getState().setSessionStatus(id, { lifecycle: 'streaming' } as never);
        }
      });

      const before = todayOrder();
      expect(before.length).toBeGreaterThan(2);
      const rowFor = (title: string) => {
        const row = todayRowNodes().find((node) => node.getAttribute('title')?.includes(title));
        expect(row, `no Today row for ${title}`).toBeDefined();
        return row!;
      };
      const gamma = rowFor('Gamma work');
      const alpha = rowFor('Alpha work');

      // Every DOM change inside Today, at the finest grain the browser reports.
      const observer = new MutationObserver(() => {});
      observer.observe(todayZone()!, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });

      const tools = ['Read', 'Edit', 'Bash', 'Grep', 'Write'];
      act(() => {
        for (let event = 0; event < 100; event += 1) {
          useSessionListStore.getState().setSessionStatus('ses-c', {
            lifecycle: 'streaming',
            activity: {
              kind: 'tool',
              toolName: `${tools[event % tools.length]}-${event}`,
              at: new Date().toISOString(),
            },
          } as never);
        }
      });
      const touched = observer.takeRecords();

      // Half one: nothing moved.
      expect(todayOrder()).toEqual(before);

      // Half two: only the row those events belong to was redrawn, and only its
      // verb line. A model that carried the verb would have rebuilt every row.
      expect(touched.length, 'a hundred activity events redrew nothing at all').toBeGreaterThan(0);
      const strays = touched
        .map((record) => record.target)
        .filter((node) => !gamma.contains(node) && gamma !== node);
      expect(strays, 'an activity event redrew a row it had nothing to do with').toEqual([]);
      expect(
        touched.every((record) => gamma.contains(record.target)),
        'the verb line is where the words live'
      ).toBe(true);

      // The counter-proof: the observer CAN see another row change.
      act(() => {
        useSessionListStore.getState().setSessionStatus('ses-a', {
          lifecycle: 'streaming',
          activity: { kind: 'tool', toolName: 'Read', at: new Date().toISOString() },
        } as never);
      });
      const second = observer.takeRecords();
      observer.disconnect();
      expect(
        second.some((record) => alpha.contains(record.target)),
        'the observer was blind — it saw no change in a row that demonstrably changed'
      ).toBe(true);
    });
  });

  describe('BC-21 / BC-37 — the anchor carries live status', () => {
    it('says what the open conversation is doing, and shows its preview when it is not', () => {
      seedSessions([
        {
          session: recentSession('ses-a', {
            title: 'Alpha work',
            lastMessagePreview: 'Left off on the parser.',
          }),
          lifecycle: 'idle',
        },
      ]);
      act(() => {
        useInteractionStore.getState().recordOpened('session', 'ses-a', Date.now() - 10_000);
      });
      openRoute('ses-a');
      const view = mountSidebar();

      // Idle: the preview, which is the line the row earned.
      const secondLine = () =>
        todayRowNodes()[0]?.querySelector('[data-slot="sidebar-row-second-line"]')?.textContent;
      expect(secondLine()).toBe('Left off on the parser.');

      // Streaming with a tool reading: the verb, from the leaf subscription.
      act(() => {
        useSessionListStore.getState().setSessionStatus('ses-a', {
          lifecycle: 'streaming',
          activity: {
            kind: 'tool',
            toolName: 'Read',
            target: 'parser.ts',
            at: new Date().toISOString(),
          },
        } as never);
      });
      view.refresh();
      expect(secondLine()).toMatch(/parser\.ts/);

      // Streaming with no reading yet: the honest floor of the ladder, never a
      // blank line held open (BC-37).
      act(() => {
        useSessionListStore.getState().setSessionStatus('ses-a', {
          lifecycle: 'streaming',
        } as never);
      });
      view.refresh();
      expect(secondLine()).toBe('Working…');
    });
  });

  describe('BC-21 / D6 — the anchor survives a deep link and a reload', () => {
    it('draws the open conversation even when no session list has arrived', () => {
      // Exactly a reload mid-conversation: the router knows the session and the
      // directory, and nothing else does yet.
      mockRecent.mockReturnValue({
        data: { sessions: [], agentActivity: {} },
        isLoading: false,
        isSuccess: true,
      });
      openRoute('ses-deep', '/projects/alpha');
      mountSidebar();

      expect(todayZone(), 'a reload left the operator with no Today at all').not.toBeNull();
      expect(todayOrder()[0]).toContain('alpha');
      expect(todayRowNodes()[0]?.getAttribute('aria-current')).toBe('page');
    });

    it('draws an automated session the operator opened by hand', () => {
      // BC-19 keeps runs off Today's top level because they are work nobody
      // asked for. Opening one is asking for it.
      seedSessions([
        {
          session: recentSession('ses-run', { title: 'Nightly digest', origin: 'task' }),
          lifecycle: 'idle',
        },
      ]);
      openRoute('ses-run');
      mountSidebar();
      expect(todayOrder()[0]).toContain('Nightly digest');
      expect(todayRowNodes()[0]?.getAttribute('aria-current')).toBe('page');
    });

    it('still keeps an automated session nobody opened off the top level', () => {
      // The paired half — without it the case above would also pass on a model
      // that had simply stopped filtering runs.
      seedSessions([
        { session: recentSession('ses-a', { title: 'Alpha work' }), lifecycle: 'idle' },
        {
          session: recentSession('ses-run', { title: 'Nightly digest', origin: 'task' }),
          lifecycle: 'idle',
        },
      ]);
      act(() => {
        useInteractionStore.getState().recordOpened('session', 'ses-a', Date.now() - 10_000);
      });
      openRoute('ses-a');
      mountSidebar();
      expect(todayOrder()).not.toContainEqual(expect.stringContaining('Nightly digest'));
      expect(todayOrder()).toContainEqual(expect.stringContaining('+ 1 automated'));
    });
  });

  describe('BC-15 / BC-33 — a thread and the room it lives in are two rows', () => {
    /** A channel with one thread hanging off an entry in it. */
    function seedThreadedChannel() {
      mockRooms.mockReturnValue([channel('c1', 'general')]);
      mockThreads.mockReturnValue([
        {
          roomId: 'c1',
          roomKind: 'channel',
          roomSlug: 'general',
          roomTitle: 'general',
          rootEntryId: 'entry-77',
          rootAuthorId: 'a1',
          rootPreview: 'Anything else to check?',
          replyCount: 2,
          unreadCount: 0,
          lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ]);
      act(() => {
        useInteractionStore.getState().recordOpened('room', 'c1', Date.now() - 10_000);
      });
    }

    /** Put the router on a room, optionally inside one of its threads. */
    function openRoom(roomId: string, thread?: string) {
      mockPathname = '/channels';
      mockLocation = {
        pathname: '/channels',
        search: { id: roomId, ...(thread === undefined ? {} : { thread }) },
      };
    }

    it('lights exactly one of them when the ROOM is open', async () => {
      seedThreadedChannel();
      openRoom('c1');
      mountSidebar();
      await waitFor(() => expect(todayOrder().join('|')).toContain('Anything else'));

      const active = todayRowNodes().filter((row) => row.getAttribute('aria-current') === 'page');
      expect(active).toHaveLength(1);
      expect(active[0]?.getAttribute('title')).not.toContain('Anything else');
    });

    it('lights the THREAD, and only the thread, when the thread is open', async () => {
      seedThreadedChannel();
      openRoom('c1', 'entry-77');
      const view = mountSidebar();
      await waitFor(() => expect(todayOrder().join('|')).toContain('Anything else'));
      view.refresh();

      const active = todayRowNodes().filter((row) => row.getAttribute('aria-current') === 'page');
      // Two rows carry `roomId: 'c1'`. Exactly one of them is what the operator
      // opened, and `aria-current="page"` has to stay unique or scroll-to-active
      // has no anchor to find (BC-36).
      expect(active).toHaveLength(1);
      expect(active[0]?.getAttribute('title')).toContain('Anything else');
      // BC-21: and it is Today's first row, not its parent channel.
      expect(todayOrder()[0]).toContain('Anything else');
    });

    it('opens the thread panel rather than only the room it lives in', async () => {
      seedThreadedChannel();
      openRoom('c1');
      mountSidebar();
      await waitFor(() => expect(todayOrder().join('|')).toContain('Anything else'));

      const threadRow = todayRowNodes().find((row) =>
        row.getAttribute('title')?.includes('Anything else')
      );
      expect(threadRow, 'no thread row in Today').toBeDefined();
      fireEvent.click(threadRow!);
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/channels',
        search: { id: 'c1', thread: 'entry-77' },
      });
      // And the STORE, which is what the room widget actually draws from. The
      // URL alone gets mirrored away a frame later when the reader is already
      // in that room (`use-thread-url-sync.ts`), so the click would open
      // nothing — which is exactly what the browser found.
      expect(useRoomOpenThreadStore.getState().open.c1?.rootEntryId).toBe('entry-77');
      expect(useRoomOpenThreadStore.getState().open.c1?.focusComposer).toBe(false);
    });
  });

  describe('BC-19 — the automated reveal', () => {
    function seedAutomated() {
      seedSessions([
        { session: recentSession('ses-a', { title: 'Alpha work' }), lifecycle: 'idle' },
        {
          session: recentSession('ses-run', { title: 'Nightly digest', origin: 'task' }),
          lifecycle: 'idle',
        },
      ]);
      act(() => {
        useInteractionStore.getState().recordOpened('session', 'ses-a', Date.now() - 10_000);
      });
    }

    it('keeps automated runs off Today until the operator asks for them', () => {
      seedAutomated();
      mountSidebar();
      expect(todayOrder()).not.toContainEqual(expect.stringContaining('Nightly digest'));
      expect(todayOrder()).toContainEqual(expect.stringContaining('+ 1 automated'));
    });

    it('unfolds them where they are, and folds them back', async () => {
      seedAutomated();
      mountSidebar();
      const reveal = todayRowNodes().find((row) => row.textContent?.includes('+ 1 automated'));
      expect(reveal).toBeDefined();

      fireEvent.click(reveal!);
      expect(todayOrder()).toContainEqual(expect.stringContaining('Nightly digest'));
      expect(todayOrder()).toContainEqual(expect.stringContaining('Hide automated'));
      // A reveal is not a navigation.
      expect(mockNavigate).not.toHaveBeenCalled();

      const hide = todayRowNodes().find((row) => row.textContent?.includes('Hide automated'));
      fireEvent.click(hide!);
      // Awaited rather than asserted on the spot: a row leaving Today fades for
      // 120 ms now (spec D5), so it is still in the document for the frame after
      // the press. This file runs the REAL motion library, so what it measures
      // is the row actually going rather than a mock removing it instantly.
      await waitFor(() =>
        expect(todayOrder()).not.toContainEqual(expect.stringContaining('Nightly digest'))
      );
    });
  });

  describe('BC-41 — the sidebar reads read state and never writes its own', () => {
    it('writes no watermark of its own when a conversation is opened', async () => {
      seedThreeConversations();
      mockRooms.mockReturnValue([channel('c1', 'general')]);
      act(() => {
        useInteractionStore.getState().recordOpened('room', 'c1', Date.now() - 5_000);
      });
      mountSidebar();
      await waitFor(() => expect(todayOrder()).toContainEqual(expect.stringContaining('general')));
      localStorage.clear();

      const roomRow = todayRowNodes().find((row) => row.textContent?.includes('general'));
      expect(roomRow, 'no room row in Today to open').toBeDefined();
      fireEvent.click(roomRow!);

      // Opening records WHEN you opened it — Today's order key — and nothing
      // about what you have read. A read watermark in local storage is the bug
      // BC-41 forbids: the cursors are cross-device and server-held.
      const keys = Object.keys(localStorage);
      expect(keys).toEqual(['dorkos:interactions-v1']);
      expect(JSON.stringify(localStorage)).not.toMatch(/read|unread|cursor|seq|watermark/i);
    });
  });
});

// ---------------------------------------------------------------------------
// D6 — a cold boot shows bones, and says so on the landmark
// ---------------------------------------------------------------------------

describe('the first paint (spec `sidebar-simplification` D6)', () => {
  it('draws the skeleton and marks the panel busy while the boot gate is shut', () => {
    boot.state = { phase: 'cold', settled: false, fleetKnown: false, startedWarm: false };
    mockRooms.mockReturnValue([channel('c1', 'general')]);
    mountSidebar();

    expect(screen.getByTestId('sidebar-skeleton')).toBeInTheDocument();
    // Not one row of the real panel — "pending" and "empty" being the same
    // value is what made the panel assemble itself in front of the operator.
    expect(document.querySelectorAll('[data-sidebar-row]')).toHaveLength(0);
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).toHaveAttribute(
      'aria-busy',
      'true'
    );
  });

  it('replaces the bones with the panel, and stops saying busy, once it settles', () => {
    mockRooms.mockReturnValue([channel('c1', 'general')]);
    mountSidebar();

    expect(screen.queryByTestId('sidebar-skeleton')).toBeNull();
    expect(document.querySelectorAll('[data-sidebar-row]').length).toBeGreaterThan(0);
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).not.toHaveAttribute('aria-busy');
  });
});

// ---------------------------------------------------------------------------
// D6 / DOR-1143 — the fleet is withheld, never guessed
// ---------------------------------------------------------------------------

describe('the fleet waits for its manifests (DOR-1143)', () => {
  /** Every row the panel painted, as text. */
  const rowTexts = () =>
    [...document.querySelectorAll('[data-sidebar-row]')].map((r) => r.textContent ?? '');
  /** The 1500 ms ceiling fired with the manifests still in flight. */
  function degradedBoot() {
    boot.state = { phase: 'settled', settled: true, fleetKnown: false, startedWarm: false };
  }

  beforeEach(() => {
    // Two agents, so the direct message below is a GROUP message: a 1:1 DM is
    // suppressed from the Library by design (D2), and a row that is absent for
    // another reason would prove nothing here.
    mockMeshPaths.mockReturnValue(['/projects/alpha', '/projects/beta']);
    mockResolvedAgents.mockReturnValue({});
    mockSidebarPrefs.mockReturnValue(makePrefs({ gettingStarted: { retired: ALL_SUGGESTIONS } }));
  });

  it('paints the panel but no agent row while the manifests are still in flight', async () => {
    // The regression this pins: mesh and manifests are two SERIAL round trips,
    // so a slow install reaches the ceiling knowing the DIRECTORIES and not the
    // manifests. Painting an agent row there means hashing its face out of the
    // directory — a face that changes the moment the manifest lands, for every
    // agent at once, which is DOR-1143 exactly.
    degradedBoot();
    mockRooms.mockReturnValue([channel('c1', 'general')]);
    mountSidebar();

    // The panel itself is up — the timeout is allowed to degrade everything
    // else, and a channel is not an identity.
    expect(screen.queryByTestId('sidebar-skeleton')).toBeNull();
    await waitFor(() => expect(rowTexts().some((t) => t.includes('general'))).toBe(true));
    // But nothing that would have to guess a face.
    expect(screen.queryByText('Agents')).toBeNull();
  });

  it('withholds a direct message too, because its faces are the fleet’s', async () => {
    // A DM's mark is its agent participants' faces joined through the
    // manifests. Without them the row falls back to the room's own letter and
    // grows faces a beat later — the same flip, one row further out.
    degradedBoot();
    mockRooms.mockReturnValue([
      channel('c1', 'general'),
      groupDmWith('d1', ['/projects/alpha', '/projects/beta'], 'Alpha chat'),
    ]);
    mountSidebar();

    await waitFor(() => expect(rowTexts().some((t) => t.includes('general'))).toBe(true));
    expect(rowTexts().some((t) => t.includes('Alpha chat'))).toBe(false);
  });

  it('draws both, once, as soon as the manifests answer', async () => {
    // The other half: withholding is a wait, not a deletion.
    mockResolvedAgents.mockReturnValue({
      '/projects/alpha': { id: 'alpha-ulid', name: 'alpha' },
      '/projects/beta': { id: 'beta-ulid', name: 'beta' },
    });
    mockRooms.mockReturnValue([
      channel('c1', 'general'),
      groupDmWith('d1', ['/projects/alpha', '/projects/beta'], 'Alpha chat'),
    ]);
    mountSidebar();

    await waitFor(() => expect(rowTexts().some((t) => t.includes('general'))).toBe(true));
    expect(rowTexts().some((t) => t.includes('Alpha chat'))).toBe(true);
    expect(screen.getByText('Agents')).toBeInTheDocument();
  });
});
