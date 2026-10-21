// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, cleanup, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { agentAuthorRef, type AuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import { toast } from 'sonner';
import { getPrefersReducedMotion } from '@/test-setup';
import { useInteractionStore } from '@/layers/entities/interactions';
import { createInitialSlots, TransportProvider, useExtensionRegistry } from '@/layers/shared/model';
import { useCreateFlowStore } from '../model/create-flow-store';
import { DashboardSidebar } from '../ui/DashboardSidebar';
import { SidebarProvider, TooltipProvider } from '@/layers/shared/ui';
import type { SidebarPrefs, SidebarGroup, SidebarItemRef } from '@dorkos/shared/config-schema';
import { useSessionListStore } from '@/layers/entities/session';

import { lexWithoutComments } from '../../../../../../../scripts/lib/code-only.mjs';

/** An agent member reference — `pinned`, `muted` and `items` all hold these. */
const agent = (path: string): SidebarItemRef => ({ kind: 'agent', path });

/** A room as `GET /api/rooms` carries it. */
function room(overrides: Partial<RoomSummary> & Pick<RoomSummary, 'id' | 'kind'>): RoomSummary {
  return {
    slug: null,
    title: 'Untitled',
    topic: null,
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
 * A direct message with one agent in it — the agent's Direct chat, which the
 * list draws as the agent's own row. The `AuthorRef` deliberately carries NO
 * emoji and NO colour: the server only caches those for an agent that has one
 * stored on its manifest, and drawing this row from them is what DOR-582 was.
 */
function dmWith(id: string, agentPath: string, title: string): RoomSummary {
  return groupDmWith(id, [agentPath], title);
}

/**
 * A direct message with several agents in it — a GROUP message, which no one
 * agent stands for, so it keeps a room row of its own.
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
 * route goes through `useNavigate`, and a mini app's page is an address the
 * extension registered, so `SidebarChrome` hands it to the router directly.
 */
const mockRouterNavigate = vi.fn();
/** Every `onBeforeNavigate` listener the sidebar subscribed, to fire by hand. */
const beforeNavigateListeners = new Set<() => void>();
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

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mockNavigate,
  useRouter: () => ({
    navigate: mockRouterNavigate,
    subscribe: (_event: 'onBeforeNavigate', listener: () => void) => {
      beforeNavigateListeners.add(listener);
      return () => beforeNavigateListeners.delete(listener);
    },
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

// This file runs the REAL motion library, not the jsdom-safe stand-in every
// other suite gets from test-setup.ts's global mock, so a row's fold and lift
// behave as they do in the app. `useReducedMotion` still reads the SAME shared
// toggle test-setup.ts exports (`getPrefersReducedMotion`); only the rest of
// the module is the real one (DOR-1416 review).
vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('motion/react')>()),
  useReducedMotion: () => getPrefersReducedMotion(),
}));

const mockRooms = vi.fn<() => RoomSummary[]>(() => []);
const mockTransport = {
  getConfig: vi.fn(() => Promise.resolve({ agents: { defaultAgent: 'dorkbot' } })),
  listMeshAgentPaths: vi.fn(),
  resolveAgents: vi.fn().mockResolvedValue({}),
  listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
  listRooms: vi.fn(() => Promise.resolve(mockRooms())),
  // An agent row's door: its Direct chat (rule S12), opened as a new chat would be.
  openDirectChat: vi.fn(),
  createSessionLocation: vi.fn().mockResolvedValue({ id: 'test-location' }),
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
  // Nothing is paused in these rooms (spec `audit-trail` PR5).
  useAgentPauses: () => ({ data: { pauses: [] } }),
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

// These fixtures carry no live sessions or recent-activity timestamps, so the
// real hook would classify every path 'inactive'. The cases here are about
// layout, not attention filtering, so the default treats every agent as
// 'active', applied at the mock instead of threading timestamps through every
// fixture.
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
  // Real, and the door every agent row goes through (DOR-3074): the Direct
  // chat, or the latest chat for anyone refused one.
  agentChatTarget: (await importOriginal<typeof import('@/layers/entities/session')>())
    .agentChatTarget,
  beginSessionNavigation: (await importOriginal<typeof import('@/layers/entities/session')>())
    .beginSessionNavigation,
  notifySessionLookupFailed: (await importOriginal<typeof import('@/layers/entities/session')>())
    .notifySessionLookupFailed,
  // Real too: it routes through `useSafeNavigate`, which resolves to the mocked
  // `useNavigate` here — so "New session" is exercised end to end rather than
  // against a stub that cannot be wrong.
  useStartNewSession: (await importOriginal<typeof import('@/layers/entities/session')>())
    .useStartNewSession,
  // Real: it is where the open chat's agent comes from (DOR-2845), and it is a
  // plain store with nothing to stub.
  useSessionRouteContext: (await importOriginal<typeof import('@/layers/entities/session')>())
    .useSessionRouteContext,
  // Real too, for the same reason: the row an agent click lights while its
  // lookup is out (DOR-2891).
  markPendingSessionTarget: (await importOriginal<typeof import('@/layers/entities/session')>())
    .markPendingSessionTarget,
  usePendingSessionTarget: (await importOriginal<typeof import('@/layers/entities/session')>())
    .usePendingSessionTarget,
  clearPendingSessionTarget: (await importOriginal<typeof import('@/layers/entities/session')>())
    .clearPendingSessionTarget,
  useAgentSessions: () => ({ sessions: [], activeSessionId: null, isLoading: false }),
  useAgentHottestStatus: () => ({ kind: 'idle', color: 'x', pulse: false, label: 'Idle' }),
  useAgentsAggregateStatus: () => false,
  useAgentAttentionMap: (paths: string[], broken?: string[]) => mockAttentionMap(paths, broken),
  usePulseMotion: () => ({ animate: undefined, transition: undefined, pulsing: false }),
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
  SessionOriginMark: () => null,
  // Real, not stubbed. Both are pure functions over a list, and this file used
  // to carry a hand-written mirror of the partition — a second spelling of the
  // one rule that says what counts as automated, in a wholesale mock, which is
  // precisely the drift DOR-1137 was about. Importing them costs nothing and
  // cannot disagree with the product.
  chatOwnership: (await importOriginal<typeof import('@/layers/entities/session')>()).chatOwnership,
  partitionSessionsByOwnership: (await importOriginal<typeof import('@/layers/entities/session')>())
    .partitionSessionsByOwnership,
  nonAutomatedSessionIds: (await importOriginal<typeof import('@/layers/entities/session')>())
    .nonAutomatedSessionIds,
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
    // move a server-backed list from inside a test.
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        {/* The real provider, not the `useTransport` stub above: hooks reached
            through `shared/model`'s barrel get the stub, but some import
            `TransportContext` by relative path and need a context that really
            exists. */}
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
 * The repo's shared stripper does that, not a regex pair plus a whole-line `//`
 * filter (DOR-1714). `lexWithoutComments` and not `lex`, because one of the
 * forbidden shapes — a `model/rules` import — is spelled inside a string, and
 * the literal-blanking stripper would erase the very thing being looked for.
 *
 * @param source - The component's source text.
 * @param fileName - Its path, which decides how the stripper lexes it.
 */
function rulesIn(source: string, fileName: string): string[] {
  const { code, parseErrors } = lexWithoutComments(source, fileName);
  // The honesty channel the module's own docs ask callers to assert: a source
  // the parser could not read has a comment map made of guesses, and a rule list
  // that comes back empty for that reason looks exactly like a pure renderer.
  expect(parseErrors, `${fileName} did not parse, so this scan read guesswork`).toBe(0);
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

/** The panel's landmark. */
function panel(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Sidebar' });
}

/** Every section heading in the panel, in DOM order. */
function headings(): string[] {
  // The LABEL, not the header's whole text: a folded header can also carry a
  // working mark, so reading `textContent` off the `<h3>` is reading more than
  // the label.
  return Array.from(panel().querySelectorAll('h3')).map(
    (h) => h.querySelector('.truncate')?.textContent?.trim() ?? h.textContent?.trim() ?? ''
  );
}

/** One section's `<h3>`, by its label. */
function sectionHeading(label: string): HTMLElement {
  const heading = Array.from(panel().querySelectorAll('h3')).find(
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

/** One section's body, by its id. */
function sectionBody(id: string): HTMLElement {
  const body = panel().querySelector(`[data-sidebar-section="${id}"]`);
  expect(body, `no "${id}" section`).not.toBeNull();
  return body as HTMLElement;
}

/** Mount the panel, with a way to re-render it in place. */
function mountSidebar() {
  return renderWithProviders(<DashboardSidebar />);
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
    mockRouterNavigate.mockReset();
    mockResolvedAgents.mockReset();
    mockResolvedAgents.mockReturnValue({});
    mockMeshPaths.mockReturnValue(['~/.dork/agents/dorkbot', '/projects/alpha', '/projects/beta']);
    mockSidebarPrefs.mockReturnValue(makePrefs());
    mockRecent.mockReturnValue({
      data: { sessions: [], agentActivity: {} },
      isLoading: false,
      isSuccess: true,
    });
    useSessionListStore.getState().resetStatuses();
    mockRooms.mockReset();
    mockRooms.mockReturnValue([]);
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
    /** The fleet, narrowed to one agent with a direct message, so a single face is unambiguous. */
    function renderOneAgent() {
      mockMeshPaths.mockReturnValue(['/projects/alpha']);
      mockResolvedAgents.mockReturnValue({
        '/projects/alpha': { id: 'a1', name: 'alpha' },
      });
      mockRooms.mockReturnValue([dmWith('dm-alpha', '/projects/alpha', 'alpha')]);
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
      // genuinely disagree. What opens is a panel that says the agent is gone;
      // that half is asserted in `ProfileDock.test.tsx`.
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
      expect(panel()).toBeInTheDocument();
    });

    it('draws no top-level route navigation of its own — that is the shell’s now', () => {
      // The header block and footer are persistent chrome mounted by AppShell
      // OUTSIDE the `sidebar.body` swap region (spec R2, P2 AC-8).
      renderWithProviders(<DashboardSidebar />);
      expect(screen.queryByText('Connections')).not.toBeInTheDocument();
      expect(screen.queryByText('Marketplace')).not.toBeInTheDocument();
    });

    it('draws no Heads up, no Today and no Library — places only', async () => {
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(headings()).toContain('Channels'));
      for (const gone of ['Heads up', 'Today', 'Library', 'Getting started', 'Agents', 'Pins']) {
        expect(screen.queryByText(gone), `${gone} is still drawn`).not.toBeInTheDocument();
      }
      expect(panel().querySelector('[data-sidebar-zone]')).toBeNull();
    });
  });

  // ── The order, top to bottom ──

  describe('the list, top to bottom', () => {
    it('reads the top items, Channels, Direct messages', async () => {
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(headings()).toContain('Channels'));
      expect(
        Array.from(panel().querySelectorAll('[data-sidebar-section]')).map((el) =>
          el.getAttribute('data-sidebar-section')
        )
      ).toEqual(['top', 'channels', 'dms']);
      expect(headings()).toEqual(['Channels', 'Direct messages']);
    });

    it('opens Threads and the Directory from the top items', async () => {
      renderWithProviders(<DashboardSidebar />);
      const top = sectionBody('top');
      fireEvent.click(within(top).getByRole('button', { name: 'Threads' }));
      expect(mockNavigate).toHaveBeenLastCalledWith({ to: '/threads' });
      fireEvent.click(within(top).getByRole('button', { name: 'Directory' }));
      expect(mockNavigate).toHaveBeenLastCalledWith({ to: '/team' });
    });

    it('lights the top item whose page is open', async () => {
      mockPathname = '/threads';
      mockLocation = { pathname: '/threads', search: {} };
      renderWithProviders(<DashboardSidebar />);
      const top = sectionBody('top');
      expect(within(top).getByRole('button', { name: 'Threads' })).toHaveAttribute(
        'aria-current',
        'page'
      );
      expect(within(top).getByRole('button', { name: 'Directory' })).not.toHaveAttribute(
        'aria-current'
      );
    });

    it('draws a hand-made section as a peer, right under the top items (D3)', async () => {
      mockSidebarPrefs.mockReturnValue(
        makePrefs({ groups: [group({ items: [agent('/projects/alpha')] })] })
      );
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(headings()).toContain('Clients'));
      expect(headings()[0]).toBe('Clients');
      expect(screen.queryByRole('heading', { name: /Clients/, level: 4 })).not.toBeInTheDocument();
    });
  });

  // ── Direct messages: an agent is its direct message ──

  describe('Direct messages', () => {
    it('shows "Message an agent" while there is none, and it opens the Directory on agents', async () => {
      renderWithProviders(<DashboardSidebar />);
      const dms = await waitFor(() => sectionBody('dms'));
      const row = within(dms).getByRole('button', { name: 'Message an agent' });
      expect(
        within(dms)
          .getAllByRole('button')
          .filter((el) => el.tagName === 'BUTTON')
      ).toContain(row);
      fireEvent.click(row);
      expect(mockNavigate).toHaveBeenLastCalledWith({ to: '/team', search: { kind: 'agents' } });
    });

    it('draws an agent’s direct message as the agent, and ends with a way to message anyone', async () => {
      mockResolvedAgents.mockReturnValue({ '/projects/alpha': { id: 'a1', name: 'alpha' } });
      mockRooms.mockReturnValue([
        dmWith('dm-alpha', '/projects/alpha', 'alpha'),
        groupDmWith('dm-group', ['/projects/alpha', '/projects/beta'], 'Launch crew'),
      ]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(agentRowButton('alpha')).toBeInTheDocument());
      const dms = sectionBody('dms');
      // The agent, by its own row — and the group message, which no one agent
      // stands for, as a room.
      expect(within(dms).getByText('Launch crew')).toBeInTheDocument();
      expect(within(dms).queryByText('Message an agent')).not.toBeInTheDocument();
      const last = within(dms).getByRole('button', { name: 'Message an agent or person' });
      fireEvent.click(last);
      expect(mockNavigate).toHaveBeenLastCalledWith({ to: '/team' });
      // Every other agent is in the Directory, not on the panel.
      expect(
        screen.queryByRole('button', { name: /Switch to beta/ }),
        'beta has no direct message and no pin'
      ).not.toBeInTheDocument();
    });

    it('keeps a pinned agent in reach before anybody has written to it', async () => {
      mockSidebarPrefs.mockReturnValue(makePrefs({ pinned: [agent('/projects/beta')] }));
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(agentRowButton('beta')).toBeInTheDocument());
      expect(sectionBody('dms')).toContainElement(agentRowButton('beta'));
    });

    it('opens an agent’s Direct chat when its row is pressed (S12)', async () => {
      // Not its newest chat: one standing chat per agent, so the place its row
      // leads never moves.
      mockTransport.listSessions.mockResolvedValue({
        sessions: [{ id: 's9', cwd: '/projects/alpha', title: 'Ship it' }],
      });
      mockTransport.openDirectChat.mockResolvedValue({
        sessionId: 'direct-alpha',
        sessionIds: ['direct-alpha'],
        roomId: 'dm-alpha',
        agentPath: '/projects/alpha',
      });
      mockRooms.mockReturnValue([dmWith('dm-alpha', '/projects/alpha', 'alpha')]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(agentRowButton('alpha')).toBeInTheDocument());
      fireEvent.click(agentRowButton('alpha'));
      await waitFor(() =>
        expect(mockNavigate).toHaveBeenCalledWith(
          expect.objectContaining({
            to: '/session',
            search: expect.objectContaining({ session: 'direct-alpha', draft: '1' }),
          })
        )
      );
      expect(mockTransport.openDirectChat).toHaveBeenCalledWith({ agentPath: '/projects/alpha' });
    });

    it('lights the agent while any chat of its is open, and the pressed one at once (DOR-2891)', async () => {
      mockSidebarPrefs.mockReturnValue(
        makePrefs({ pinned: [agent('/projects/alpha'), agent('/projects/beta')] })
      );
      mockPathname = '/session';
      mockLocation = { pathname: '/session', search: { session: 's1', dir: '/projects/alpha' } };
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(agentRowButton('alpha')).toHaveAttribute('aria-current', 'page'));
      expect(agentRowButton('beta')).not.toHaveAttribute('aria-current');

      // The server never answers: before, nothing on screen moved until it did.
      mockTransport.openDirectChat.mockImplementation(() => new Promise(() => {}));
      fireEvent.click(agentRowButton('beta'));
      await waitFor(() => expect(agentRowButton('beta')).toHaveAttribute('aria-current', 'page'));
      expect(agentRowButton('alpha')).not.toHaveAttribute('aria-current');
      // Any navigation hands the answer back to the router, so a lookup that
      // was overtaken cannot keep the row lit.
      act(() => beforeNavigateListeners.forEach((listener) => listener()));
      await waitFor(() => expect(agentRowButton('beta')).not.toHaveAttribute('aria-current'));
      expect(agentRowButton('alpha')).toHaveAttribute('aria-current', 'page');
    });

    it('draws no session row and no thread row, whatever is running', async () => {
      mockSidebarPrefs.mockReturnValue(makePrefs({ pinned: [agent('/projects/alpha')] }));
      mockRecent.mockReturnValue({
        data: {
          sessions: [
            {
              id: 's1',
              title: 'Wire the model',
              cwd: '/projects/alpha',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              permissionMode: 'default',
              runtime: 'claude-code',
            },
          ],
          agentActivity: {},
        },
        isLoading: false,
        isSuccess: true,
      });
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(agentRowButton('alpha')).toBeInTheDocument());
      expect(screen.queryByText('Wire the model')).not.toBeInTheDocument();
    });
  });

  // ── Add-ons: the pages mini apps add (spec `mini-app-placement` Part 2) ──

  describe('Add-ons — the pages mini apps add', () => {
    /** Register one page the way `api.registerPage` does. */
    function registerPage(
      extensionId: string,
      path: string,
      title: string,
      options: { menu?: boolean; icon?: unknown } = {}
    ) {
      useExtensionRegistry.getState().register('pages', {
        id: `${extensionId}:${path}`,
        extensionId,
        path,
        component: () => null,
        title,
        menu: options.menu ?? true,
        icon: options.icon as never,
      });
    }

    /** One Add-ons row's button, by the page's title. */
    function addOnRow(title: string): HTMLElement {
      return within(sectionBody('addons')).getByRole('button', { name: title });
    }

    beforeEach(() => useExtensionRegistry.setState({ slots: createInitialSlots() }));
    afterEach(() => useExtensionRegistry.setState({ slots: createInitialSlots() }));

    it('is absent when no mini app added a page', async () => {
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(headings()).toContain('Channels'));
      expect(headings()).not.toContain('Add-ons');
    });

    it('lists every listed page last, by its own title', async () => {
      registerPage('social-queue', '', 'Social Queue');
      registerPage('flow', '', 'Flow');
      // Neither of these can be opened from a list: one asked not to be, the
      // other needs a value no menu can fill in.
      registerPage('flow', 'debug', 'Debug', { menu: false });
      registerPage('flow', 'p/:name', 'Project');
      renderWithProviders(<DashboardSidebar />);

      await waitFor(() => expect(headings()).toContain('Add-ons'));
      expect(headings().at(-1)).toBe('Add-ons');
      // The header's own toggle, then one row per page, sorted by title.
      expect(
        within(sectionBody('addons'))
          .getAllByRole('button')
          .map((el) => el.textContent?.trim())
      ).toEqual(['Add-ons', 'Flow', 'Social Queue']);
    });

    it('opens a page when its row is pressed', async () => {
      registerPage('flow', 'settings', 'Flow settings');
      renderWithProviders(<DashboardSidebar />);

      await userEvent.click(await waitFor(() => addOnRow('Flow settings')));
      expect(mockRouterNavigate).toHaveBeenCalledWith({ href: '/x/flow/settings' });
    });

    it('marks the page you are on, and only that one', async () => {
      registerPage('flow', '', 'Flow');
      registerPage('flow', 'settings', 'Flow settings');
      mockPathname = '/x/flow/settings/accounts';
      mockLocation = { pathname: mockPathname, search: {} };
      renderWithProviders(<DashboardSidebar />);

      const current = await waitFor(() => addOnRow('Flow settings'));
      expect(current).toHaveAttribute('aria-current', 'page');
      expect(addOnRow('Flow')).not.toHaveAttribute('aria-current');
    });

    it('keeps the row when a page’s icon cannot be drawn', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      registerPage('flow', '', 'Flow', { icon: { name: 'flow' } });
      registerPage('broken', '', 'Broken', {
        icon: () => {
          throw new Error('boom');
        },
      });
      renderWithProviders(<DashboardSidebar />);

      expect(await waitFor(() => addOnRow('Flow'))).toBeInTheDocument();
      expect(addOnRow('Broken')).toBeInTheDocument();
    });

    it('folds under its own stored id', async () => {
      registerPage('flow', '', 'Flow');
      renderWithProviders(<DashboardSidebar />);

      await waitFor(() => expect(headings()).toContain('Add-ons'));
      fireEvent.click(sectionToggle('Add-ons'));
      expect(lastPrefsWrite().sections?.addons?.collapsed).toBe(true);
    });
  });

  // ── BC-29 / BC-30: the collapse gestures ──

  describe('BC-29 / BC-30 — folding', () => {
    it('folds a section from anywhere on its header row', async () => {
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(headings()).toContain('Channels'));
      fireEvent.click(sectionToggle('Channels'));
      expect(lastPrefsWrite().sections?.channels?.collapsed).toBe(true);
    });

    it('folds EVERY section on Alt-click, not just the one pressed', async () => {
      mockSidebarPrefs.mockReturnValue(
        makePrefs({ groups: [group({ items: [agent('/projects/alpha')] })] })
      );
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(headings()).toContain('Channels'));
      fireEvent.click(sectionToggle('Channels'), { altKey: true });
      const next = lastPrefsWrite();
      expect(next.sections?.channels?.collapsed).toBe(true);
      expect(next.sections?.dms?.collapsed).toBe(true);
      expect(next.groups[0]?.collapsed).toBe(true);
    });

    it('unfolds everything when everything is already folded', async () => {
      mockSidebarPrefs.mockReturnValue(
        makePrefs({ sections: { channels: { collapsed: true }, dms: { collapsed: true } } })
      );
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(headings()).toContain('Channels'));
      fireEvent.click(sectionToggle('Channels'), { altKey: true });
      expect(lastPrefsWrite().sections?.channels?.collapsed).toBe(false);
    });

    it('hides a folded section’s rows and keeps its header reachable', async () => {
      mockSidebarPrefs.mockReturnValue(makePrefs({ sections: { channels: { collapsed: true } } }));
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(headings()).toContain('Channels'));
      expect(screen.queryByText('#general')).not.toBeInTheDocument();
      expect(sectionToggle('Channels')).toHaveAttribute('aria-expanded', 'false');
    });
  });

  // ── BC-31: a folded section keeps its signal ──

  it('BC-31 — a folded section keeps its unread rows on screen and carries no unread count', async () => {
    mockSidebarPrefs.mockReturnValue(makePrefs({ sections: { dms: { collapsed: true } } }));
    mockRooms.mockReturnValue([
      {
        ...groupDmWith('r2', ['/projects/alpha', '/projects/beta'], 'Quiet chat'),
        unreadCount: 3,
        working: 2,
      },
      { ...groupDmWith('r3', ['/projects/alpha', '/projects/beta'], 'Read chat'), unreadCount: 0 },
    ]);
    renderWithProviders(<DashboardSidebar />);
    // Direct messages always stands, so wait for the rooms rather than the header.
    expect(await screen.findByText('Quiet chat')).toBeInTheDocument();
    const heading = screen.getByRole('heading', { name: /Direct messages/, level: 3 });
    // The read conversation folds away; the one with something new stays put.
    expect(screen.queryByText('Read chat')).not.toBeInTheDocument();
    // The header carries no unread number — only how many rows the fold hides
    // (DOR-3200), and a dot while a member works.
    expect(heading.textContent).not.toMatch(/3/);
    expect(heading.textContent).toContain('· 2 more');
    expect(sectionToggle('Direct messages')).toHaveAccessibleDescription('2 more');
    expect(within(heading).getByRole('img', { name: 'Agent working' })).toBeInTheDocument();
  });

  // ── The section "+" and the keyboard ──

  describe('section chrome and the keyboard', () => {
    it('reveals each section "+" on focus as well as on hover — a keyboard has no hover', async () => {
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(headings()).toContain('Channels'));

      for (const label of ['New channel', 'New direct message']) {
        const plus = screen.getByRole('button', { name: label });
        expect(plus.className).toContain('group-focus-within/section:opacity-100');
        expect(plus.className).toContain('group-hover/section:opacity-100');
      }
    });

    it('points the Direct messages "+" at the one New menu instead of a handler', async () => {
      renderWithProviders(<DashboardSidebar />);
      await screen.findByRole('heading', { name: /Direct messages/, level: 3 });
      expect(useCreateFlowStore.getState().menuOpen).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'New direct message' }));

      expect(useCreateFlowStore.getState()).toMatchObject({
        menuOpen: true,
        preselect: 'new-message',
      });
    });

    it('makes each section "+" a keyboard stop, reachable by arrowing off the header', async () => {
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await screen.findByText('#general');
      const toggle = sectionToggle('Channels');
      toggle.focus();
      fireEvent.keyDown(toggle, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New channel' }));
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(screen.getByText('#general').closest('button'));
    });

    it('reaches a row with the arrow keys and opens it with Enter', async () => {
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await screen.findByText('#general');
      const toggle = sectionToggle('Channels');
      toggle.focus();
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

    it('picks a row up from the keyboard, on the row the arrows actually reach (DOR-1746)', async () => {
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await screen.findByText('#general');

      // No drag root is in the tab order — the whole reason the activator has
      // to be the row rather than the root that wraps it.
      const dragRoots = document.querySelectorAll('[data-sidebar-drag-root]');
      expect(dragRoots.length).toBeGreaterThan(0);
      expect([...dragRoots].map((root) => root.getAttribute('tabindex'))).toEqual(
        [...dragRoots].map(() => '-1')
      );

      const toggle = sectionToggle('Channels');
      toggle.focus();
      fireEvent.keyDown(toggle, { key: 'ArrowDown' });
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
      const row = screen.getByText('#general').closest('button');
      expect(document.activeElement).toBe(row);

      fireEvent.keyDown(document.activeElement!, { code: 'Space' });

      const lifted = document.querySelectorAll('[data-sidebar-dragging]');
      expect(lifted.length, 'Space on the focused row did not pick anything up').toBe(1);
      expect(lifted[0]).toBe(row?.closest('[data-sidebar-drag-root]'));
      expect(document.querySelector('[id^="DndLiveRegion"]')?.textContent ?? '').not.toBe('');

      // Escape right away: dnd-kit is not listening yet, so the key is held and
      // handed to it once it is (DOR-3151). The outcome lands a task or two
      // later, which is why it is waited for rather than read at once.
      fireEvent.keyDown(row!, { code: 'Escape' });
      await waitFor(() =>
        expect(document.querySelectorAll('[data-sidebar-dragging]')).toHaveLength(0)
      );
    });

    it('picks a SECTION you made up from its own header, and Escape puts it back', async () => {
      mockSidebarPrefs.mockReturnValue(makePrefs({ groups: [group({ items: [] })] }));
      renderWithProviders(<DashboardSidebar />);
      await screen.findByRole('heading', { name: /Clients/, level: 3 });

      const header = sectionToggle('Clients');
      header.focus();
      fireEvent.keyDown(header, { code: 'Space' });

      const lifted = document.querySelectorAll('[data-sidebar-dragging]');
      expect(lifted.length, 'Space on the focused section header lifted nothing').toBe(1);
      expect(lifted[0]).toBe(header.closest('[data-sidebar-drag-root]'));

      // Held until dnd-kit listens, then handed over (DOR-3151).
      fireEvent.keyDown(header, { code: 'Escape' });
      await waitFor(() =>
        expect(document.querySelectorAll('[data-sidebar-dragging]')).toHaveLength(0)
      );
    });

    it('leaves a FIXED section header undraggable, so its Space is still the fold’s', async () => {
      mockRooms.mockReturnValue([channel('r1', 'general')]);
      renderWithProviders(<DashboardSidebar />);
      await screen.findByText('#general');

      const header = sectionToggle('Channels');
      expect(header.closest('[data-sidebar-drag-root]')).toBeNull();
      expect(header.getAttribute('aria-roledescription')).toBeNull();

      header.focus();
      fireEvent.keyDown(header, { code: 'Space' });
      expect(document.querySelectorAll('[data-sidebar-dragging]')).toHaveLength(0);
    });

    it('offers no "advanced mode" toggle anywhere', () => {
      renderWithProviders(<DashboardSidebar />);
      expect(screen.queryByText(/advanced mode/i)).not.toBeInTheDocument();
    });
  });

  // ── Behaviour that had to survive the rewrite ──

  describe('what the rewrite had to keep', () => {
    it('migrates legacy localStorage pins into server config, once', async () => {
      localStorage.setItem('dorkos-pinned-agents', JSON.stringify(['/projects/alpha']));
      renderWithProviders(<DashboardSidebar />);
      await waitFor(() => expect(mockUpdateSidebar).toHaveBeenCalled());
      expect(lastPrefsWrite().pinned).toEqual([{ kind: 'agent', path: '/projects/alpha' }]);
      expect(localStorage.getItem('dorkos-pinned-agents')).toBeNull();
    });

    it('renders a section you just made, empty, with somewhere to drop into', async () => {
      mockSidebarPrefs.mockReturnValue(makePrefs({ groups: [group({ items: [] })] }));
      renderWithProviders(<DashboardSidebar />);
      await screen.findByRole('heading', { name: /Clients/, level: 3 });
      expect(screen.getByText(/Drag channels, DMs or agents here/)).toBeInTheDocument();
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
      renderWithProviders(<DashboardSidebar />);

      const slot = document.querySelector('[data-slot="sidebar-bottom-slot"]');
      expect(slot).not.toBeNull();
      expect(slot!.closest('[data-slot="sidebar-content"]')).toBeNull();
      expect(slot!.closest('nav[aria-label="Sidebar"]')).not.toBeNull();
    });

    it('draws the winning card, and draws it after the scroller in the DOM', () => {
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
    const RENDERER = join(__dirname, '..', 'ui', 'DashboardSidebar.tsx');
    const source = readFileSync(RENDERER, 'utf8');

    it('is under 200 lines', () => {
      expect(source.split('\n').length).toBeLessThan(200);
    });

    it('transforms nothing — no array work, no model field, no arithmetic', () => {
      expect(rulesIn(source, RENDERER)).toEqual([]);
    });

    it('reds on every rule a reviewer could put back', () => {
      // **This runs the REAL scanner**, over sources that differ from the
      // component only by the line under test.
      const cases: [string, string][] = [
        ['membership', 'const shown = rows.filter((row) => !row.muted);'],
        ['a cap', 'const capped = rows.slice(0, 8);'],
        ['ordering', 'const ordered = rows.toSorted((a, b) => a.primary > b.primary ? 1 : -1);'],
        ['a badge count', 'const n = rows.reduce((sum, row) => sum + (row.unread.count ?? 0), 0);'],
        ['a fold decision', 'const open = !section.collapsed;'],
        ['arithmetic on the model', 'const spare = Math.max(0, rows.length - 3);'],
        // The one forbidden shape that is a STRING — an import specifier.
        ['a rule import', "import { buildSections } from '../model/rules/build-sections';"],
      ];
      for (const [what, line] of cases) {
        expect(
          rulesIn(`${source}\n${line}\n`, RENDERER),
          `${what} walked past the guard`
        ).not.toEqual([]);
      }
    });

    it('does not fire on the renderer’s own prose', () => {
      expect(
        rulesIn('/** Never .filter() or .sort() here. */\n// and no unread either\n', RENDERER)
      ).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// D6 — the first paint
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
    // Two agents, both pinned so each has a row in Direct messages once the
    // fleet is known — a row absent for another reason would prove nothing.
    mockMeshPaths.mockReturnValue(['/projects/alpha', '/projects/beta']);
    mockResolvedAgents.mockReturnValue({});
    mockSidebarPrefs.mockReturnValue(
      makePrefs({ pinned: [agent('/projects/alpha'), agent('/projects/beta')] })
    );
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
    expect(screen.queryByRole('button', { name: /Switch to alpha/ })).toBeNull();
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
    expect(screen.getAllByRole('button', { name: /Switch to alpha/ }).length).toBeGreaterThan(0);
  });
});
