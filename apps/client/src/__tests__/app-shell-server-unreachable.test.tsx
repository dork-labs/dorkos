// @vitest-environment jsdom
/** The shell's boot gate, told apart from the shell's boot FAILURE (DOR-1475). */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { act, render, screen, cleanup, waitFor } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
  useQuery,
} from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
import { TooltipProvider } from '@/layers/shared/ui';
import { LAUNCH_STARTED_AT } from '@/layers/shared/lib';

// ── Router: the shell mounts without a RouterProvider ──

// The web-access indicator rides the beacon but needs the live event feed, which these tests do
// not provide.
vi.mock('@/layers/widgets/apps-home', () => ({ useAppsPalette: () => {}, AppsPage: () => null }));
vi.mock('@/layers/features/web-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/features/web-access')>()),
  RemoteSessionIndicator: () => null,
}));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({
      location: { pathname: '/', href: '/', searchStr: '' },
      matches: [{ routeId: '_shell', staticData: { header: null } }],
    }),
  useRouter: () => ({
    navigate: () => Promise.resolve(),
    get state() {
      return { location: { pathname: '/', href: '/' } };
    },
    history: { subscribe: () => () => {} },
    subscribe: () => () => {},
  }),
  Outlet: () => <div data-testid="outlet">outlet</div>,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/' }),
  useSearch: () => ({}),
}));

// ── Child surfaces, stubbed at their feature seams ── Everything below is scenery for this
// suite: it exists so the shell can mount, and nothing here is under test.

vi.mock('@/layers/widgets/one-bar', () => ({
  resolveRouteHeader: () => null,
  OneBarProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
  BarFixedCluster: () => null,
}));

// Partial, because the mobile tabs draw the panel from this module's real
// model and sections — only the panel's own bodies are scenery here.
vi.mock('@/layers/features/dashboard-sidebar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/features/dashboard-sidebar')>()),
  DashboardSidebar: () => <nav aria-label="Sidebar" data-testid="dashboard-sidebar" />,
  SidebarHeaderBlock: () => null,
  SidebarLandmark: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MobileCommunityContextSwitcher: () => null,
  SidebarFooterStrip: () => null,
}));

// The first-run flow itself is not this suite's subject — only whether the shell ever gets far
// enough to show it.
vi.mock('@/layers/features/onboarding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/features/onboarding')>()),
  OnboardingFlow: () => <div data-testid="onboarding-flow" />,
}));

vi.mock('@/layers/widgets/app-layout', () => ({
  DialogHost: () => null,
  FeedbackDialogHost: () => null,
}));

vi.mock('@/layers/widgets/moments', () => ({ MomentHost: () => null }));
vi.mock('@/layers/features/tours', () => ({ TourHost: () => null }));
vi.mock('@/layers/features/notifications', () => ({ NotificationCenter: () => null }));
vi.mock('@/layers/features/shortcuts', () => ({
  ShortcutsPanel: () => null,
  useShortcutsPanel: () => {},
}));

vi.mock('react-resizable-panels', () => ({
  Panel: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  PanelGroup: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  PanelResizeHandle: () => <div />,
}));

vi.mock('@/layers/features/right-panel', () => ({
  RightPanelContainer: () => null,
  RightPanelToggle: () => null,
  useRightPanelPersistence: () => {},
  useRightPanelShortcut: () => {},
  RIGHT_PANEL_GROUP_ID: 'app-shell-right-panel',
}));

vi.mock('@/layers/features/profile', () => ({
  useProfileShortcut: () => {},
  useProfileDockDeepLink: () => {},
  useProfileRootLinks: () => {},
  useLegacyProfileLinkRedirect: () => {},
}));

// ── Live-data subscriptions: every one of these wants an EventStreamProvider ──

// The window title counts what is waiting through the Inbox's queue (DOR-2820).
// Nothing is waiting here, and the real queue needs an event stream.
vi.mock('@/layers/entities/attention', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/attention')>()),
  useWaitingQueue: () => ({ items: [], schedules: [] }),
}));

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useSessionId: () => [null, vi.fn()] as const,
  useDefaultCwd: () => {},
  useDirectoryState: () => ['/test/cwd', vi.fn()] as const,
  useGlobalSessionStream: () => {},
  useSessionOrigin: () => ({ origin: undefined, originLabel: undefined }),
  useSessionDetail: () => ({ data: undefined }),
}));

vi.mock('@/layers/entities/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/agent')>()),
  useCurrentAgent: () => ({ data: null, isLoading: false }),
  useAgentVisual: () => ({ color: 'hsl(0,70%,55%)', emoji: '🤖' }),
}));

// The live extension-tools subscriber (DOR-2685) reads the event stream this
// suite does not provide; nothing here is about permissions.
vi.mock('@/layers/entities/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/permissions')>()),
  useCapabilitiesSync: () => {},
}));

vi.mock('@/layers/entities/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/command')>()),
  useCommandsSync: () => {},
}));

// AppShell keeps dev links current from the event stream (DOR-2696); this
// test provides no EventStreamProvider, so the subscription is stubbed.
vi.mock('@/layers/entities/marketplace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/marketplace')>()),
  useDevLinkReloadSync: () => {},
}));

vi.mock('@/layers/entities/room', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/room')>()),
  useRoomListStream: () => {},
  useRoom: () => ({ data: undefined }),
}));

vi.mock('@/layers/entities/binding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/binding')>()),
  useBindingsSync: () => {},
}));

vi.mock('@/layers/entities/relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/relay')>()),
  useRelayAdaptersSync: () => {},
}));

// The keep-awake status sync (spec `keep-awake`) subscribes to the event stream
// too; no-op it like the other syncs.
vi.mock('@/layers/entities/keep-awake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/keep-awake')>()),
  useKeepAwakeSync: () => {},
}));

vi.mock('@/layers/entities/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/tasks')>()),
  useTasksSync: () => {},
}));

// Agents and settings ride the same stream (DOR-2052): `useAgentsSync` refreshes the agent caches
// on `agents_changed` and `useConfigSync` re-reads settings on `config_changed`.
vi.mock('@/layers/entities/mesh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/mesh')>()),
  useAgentsSync: () => {},
}));

// The live agent-request subscriber reads the event stream this suite does not
// provide; nothing here is about agent requests.
vi.mock('@/layers/entities/connectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/connectors')>()),
  useConnectorAgentRequestsSync: () => {},
}));

// `@/layers/entities/config` stays REAL apart from this ONE export — the config query is the
// thing this suite is about, and a partial mock leaves `useConfig`, `configKeys` and everything
// else exactly as they are.
vi.mock('@/layers/entities/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/config')>()),
  useConfigSync: () => {},
}));

// Account usage updates ride the same stream; the rest of the shared model stays
// real.
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useAccountUsageSync: () => {},
}));

// `community_connections_changed` rides the same stream; its subscriber is
// stubbed for the same reason.
vi.mock('@/layers/entities/community', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/community')>()),
  useCommunityConnectionsSync: () => {},
}));

// Remote access rides the same stream (DOR-1743): `useTunnelSync` refreshes the config read on a
// `tunnel_status` event, and `useRemoteAccessAnnouncer` reads that config.
vi.mock('@/layers/entities/tunnel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/tunnel')>()),
  useTunnelSync: () => {},
  useRemoteAccessAnnouncer: () => {},
}));

// The shell's banner slot reads the Inbox, to raise a standing row while a runtime's sign-in is
// dead (`widgets/app-banner`, DOR-1680).
vi.mock('@/layers/entities/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/notifications')>()),
  useNotifications: () => ({
    notifications: [],
    unreadCount: 0,
    isLoading: false,
    isError: true,
    hasMore: false,
    loadMore: () => {},
    isLoadingMore: false,
  }),
}));

vi.mock('@/layers/widgets/pulse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/widgets/pulse')>()),
  usePulseFreshness: () => {},
}));

vi.mock('@/layers/shared/model/use-favicon', () => ({ useFavicon: () => {} }));
vi.mock('@/layers/shared/model/use-document-title', () => ({ useDocumentTitle: () => {} }));

vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));

// ── Import AppShell after the mocks are in place ──

import { AppShell } from '../AppShell';
import { resetFailureMemoryForTests } from '../app/config-failure-memory';

/** The headline, spelled with the typographic apostrophe the screen renders. */
const HEADLINE = 'DorkOS can’t reach its server';

/** The shell's own escape hatch for a config read that never lands. */
const LOADING_TIMEOUT_MS = 3000;

/** How long a read may hang before the shell calls the server unreachable. */
const HANG_DEADLINE_MS = 15_000;

/** The screen's own retry cadence, which has to clear the screen unaided. */
const RETRY_INTERVAL_MS = 5000;

/** A settled install: onboarding is over, so a healthy boot renders the shell. */
function settledConfig() {
  return {
    version: '0.0.0-test',
    onboarding: { completedAt: '2026-08-01T10:00:00.000Z', dismissedAt: null },
  } as unknown as Awaited<ReturnType<Transport['getConfig']>>;
}

let transport: Transport;

/**
 * The rejection an HTTP client builds from a response that ARRIVED.
 *
 * `http-client.ts` attaches `status` only when there was a response to read it
 * off; a refused connection or a timeout throws without one. That difference is
 * the whole subject of the second suite below, so the fixture is built the way
 * the real client builds it rather than being hand-waved with a message string.
 *
 * @param status - The HTTP status the reply carried.
 * @param message - The `error` field the server sent, when the test is about it.
 * @param code - The `code` field, which only this server's own refusals carry.
 */
function answeredWith(status: number, message = `HTTP ${status}`, code?: string) {
  return Object.assign(new Error(message), { status, ...(code === undefined ? {} : { code }) });
}

/**
 * Let the clock run and let React finish with it.
 *
 * **The whole reason the first cut of this suite could not fail.** A bare
 * `advanceTimersByTimeAsync` fires the shell's timers, but the state they set
 * lands in a React update that nothing flushes, so `container.innerHTML` still
 * held the FIRST paint — and an assertion about what is on screen after a
 * timeout passed while the timeout's effect had never reached the DOM. Wrapped
 * in `act`, the render commits and the assertions are about the real document.
 *
 * @param ms - How far to move the fake clock.
 */
async function letTimePass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** A client that asks once per fetch. */
function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/**
 * Mount the shell.
 *
 * @param seed - Optional writer that primes the cache before the first render.
 * @param queryClient - Pass one in to mount TWICE against the same cache, which
 *   is what a remount of the shell inside one launch really is.
 */
function renderAppShell(
  seed?: (client: QueryClient) => void,
  queryClient: QueryClient = makeQueryClient()
) {
  seed?.(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <AppShell />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

/**
 * Seed the cache the way the boot cache does on a returning user's first paint.
 *
 * `query-persister.ts` hydrates `configKeys.current()` straight out of
 * `localStorage`, carrying the `dataUpdatedAt` from whenever it was originally
 * fetched — up to 24 hours old. `setQueryData`'s `updatedAt` is the same lever
 * `hydrate` pulls, so this is the real shape of a warm boot and not a mime of
 * one.
 *
 * @param client - The query client the shell will read from.
 */
function seedYesterdaysConfig(client: QueryClient) {
  client.setQueryData(configKeys.current(), settledConfig(), {
    updatedAt: Date.now() - 60 * 60 * 1000,
  });
}

/**
 * Seed a warm boot whose remembered config also remembers an old failure.
 *
 * **The real shape of the flash, not a mime of it.** `dehydrate` copies a
 * query's WHOLE state into `localStorage`, and TanStack never resets
 * `errorUpdateCount` or `errorUpdatedAt` on a later success — so one blip an
 * hour ago (a server restart, a laptop waking, a logged-out tab) is still in
 * the blob when the config read that followed it succeeded. `hydrate` restores
 * that state verbatim, `setState` being the exact lever it pulls.
 *
 * @param client - The query client the shell will read from.
 */
function seedYesterdaysConfigAfterAnOldBlip(client: QueryClient) {
  seedYesterdaysConfig(client);
  const anHourAgo = Date.now() - 60 * 60 * 1000;
  client
    .getQueryCache()
    .find({ queryKey: configKeys.current() })
    ?.setState({ errorUpdateCount: 2, errorUpdatedAt: anHourAgo });
}

/**
 * Put the clock a moment into THIS launch, and seed the config this tab read a
 * moment before it reloaded.
 *
 * **The shape of a quick reload, which every seed above misses (DOR-2649).** A
 * config read a few seconds before a reload is restored by the boot cache still
 * inside its 30s `staleTime`, so TanStack sees nothing to refetch on mount — and
 * an hour-old seed never exercised that, because an hour-old entry is stale and
 * always refetched. Pinned to `LAUNCH_STARTED_AT` rather than `Date.now()`:
 * that constant was sampled when this file was imported, and a seed dated
 * relative to "now" could land AFTER it, reading as an answer from this launch
 * and passing for the wrong reason.
 *
 * Needs fake timers already installed, since it sets the system time.
 *
 * @param client - The query client the shell will read from.
 */
function seedConfigFromJustBeforeAReload(client: QueryClient) {
  vi.setSystemTime(LAUNCH_STARTED_AT + 2000);
  client.setQueryData(configKeys.current(), settledConfig(), {
    updatedAt: LAUNCH_STARTED_AT - 3000,
  });
}

beforeAll(() => {
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

beforeEach(() => {
  vi.clearAllMocks();
  transport = createMockTransport();
  // Each case is its own launch.
  resetFailureMemoryForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AppShell, when the server will not answer', () => {
  it('says so instead of painting an empty window', async () => {
    vi.mocked(transport.getConfig).mockRejectedValue(new Error('Failed to fetch'));

    renderAppShell();

    expect(await screen.findByText(HEADLINE)).toBeInTheDocument();
    // Not the empty div, and not the first-run overlay either — that flow collects answers it
    // would have no server to save (the shell's 3s escape hatch used to hand it the window).
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-flow')).not.toBeInTheDocument();
  });

  it('settles there instead of hammering the server it cannot reach', async () => {
    // **The regression this suite exists to hold.** Gated on `isError`, this screen was a hot
    // loop: TanStack rewinds a dataless query to `pending` the moment a retry starts, so the
    // shell un-rendered the very screen whose mount had asked, then re-rendered it when the
    // rejection landed — measured at ~3000 requests in half a second, at a server that is already
    vi.mocked(transport.getConfig).mockRejectedValue(new Error('Failed to fetch'));

    renderAppShell();
    await screen.findByText(HEADLINE);

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Generous on purpose: the point is an order of magnitude, not an exact count.
    expect(vi.mocked(transport.getConfig).mock.calls.length).toBeLessThan(5);
    // And it is still the screen, not something the churn flickered past.
    expect(screen.getByText(HEADLINE)).toBeInTheDocument();
  });

  it('says so to the returning user too, whose cockpit is painted from yesterday', async () => {
    // **The path that matters most, and the one a `data === undefined` gate could never reach.**
    // The boot cache hydrates `/api/config` out of `localStorage` on every warm start, so a
    // returning user always HAS a config — and with a dead server behind it the shell painted the
    // whole cockpit from last night's copy, every action inside it failing, no screen.
    vi.mocked(transport.getConfig).mockRejectedValue(new Error('Failed to fetch'));

    renderAppShell(seedYesterdaysConfig);

    expect(await screen.findByText(HEADLINE)).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
  });

  it('does not accuse a healthy server of a failure that happened last launch', async () => {
    // **The flash this fix exists for.** The boot cache carries the config query's
    // `errorUpdateCount` forward for as long as the entry lives, and that counter never rewinds —
    // so one old blip meant every later refresh opened on the failure screen, over a server
    // answering fine, until the screen's own 5s retry cleared it.
    vi.mocked(transport.getConfig).mockResolvedValue(settledConfig());

    renderAppShell(seedYesterdaysConfigAfterAnOldBlip);

    // Asserted on the FIRST paint, because the defect was only ever a flash:
    // wait for the refetch and the screen would have cleared itself.
    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();
    expect(await screen.findByTestId('app-shell')).toBeInTheDocument();
    await waitFor(() => expect(transport.getConfig).toHaveBeenCalled());
    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();
  });

  it('waits out a slow read, then says so once the hang deadline passes', async () => {
    vi.useFakeTimers();
    // Accepted, and then silence — the wedged server. It never rejects, so
    // there is no failure to count and a deadline is the only evidence there is.
    vi.mocked(transport.getConfig).mockReturnValue(new Promise(() => {}));

    renderAppShell();

    // Past the shell's own 3s escape, which hands the window to the cockpit while the read is
    // merely late.
    await letTimePass(LOADING_TIMEOUT_MS + 500);
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();

    // Still nothing at ten seconds.
    await letTimePass(6500);
    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();

    // Past fifteen, with nothing fresh in hand all session: that is evidence.
    await letTimePass(HANG_DEADLINE_MS - 10_000 + 500);
    expect(screen.getByText(HEADLINE)).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
  });

  it('clears itself when the server comes back, with nobody pressing anything', async () => {
    vi.useFakeTimers();
    vi.mocked(transport.getConfig).mockRejectedValue(new Error('Failed to fetch'));

    renderAppShell();
    await vi.waitFor(() => expect(screen.getByText(HEADLINE)).toBeInTheDocument());

    // The copy promises DorkOS keeps checking. Nobody touches the page.
    vi.mocked(transport.getConfig).mockResolvedValue(settledConfig());
    await letTimePass(RETRY_INTERVAL_MS + 500);

    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
  });
});

describe('AppShell, after a quick reload', () => {
  it('does not call a healthy server unreachable when the remembered config is seconds old', async () => {
    // **The flash this case exists for (DOR-2649).** Reload within 30s of the last config read
    // and the boot cache restores a copy TanStack calls fresh, so nothing asked the server — and
    // with nothing able to answer "this launch", the 15s hang deadline replaced the whole app
    // with this screen over a server that was fine, wiping whatever was open until the screen's
    vi.useFakeTimers();
    vi.mocked(transport.getConfig).mockResolvedValue(settledConfig());

    renderAppShell(seedConfigFromJustBeforeAReload);
    await letTimePass(HANG_DEADLINE_MS + 1000);

    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    // And the reason it stayed away is that the server was actually asked —
    // not that the deadline stopped looking.
    expect(transport.getConfig).toHaveBeenCalled();
  });
});

describe('AppShell, when the config read stalls for reasons of its own', () => {
  // **Why the hang deadline runs from mount and not from "a read is in flight".** Gating it on
  // `fetchStatus === 'fetching'` looked tidier, but the config query has readers this shell does
  // not control: a paused read (the browser thinks it is offline, the tab is hidden mid-retry)
  // never reports `fetching`, and an optimistic settings write cancels the read and puts it back
  afterEach(() => {
    onlineManager.setOnline(true);
    focusManager.setFocused(undefined);
  });

  it('still says so when the browser is offline and another reader asked first', async () => {
    // Several config readers keep TanStack's default `networkMode: 'online'`, and the onboarding
    // gate mounts one before the shell's own.
    vi.useFakeTimers();
    onlineManager.setOnline(false);
    vi.mocked(transport.getConfig).mockReturnValue(new Promise(() => {}));
    const queryClient = makeQueryClient();
    function OnlineModeReader() {
      useQuery({
        queryKey: configKeys.current(),
        queryFn: () => transport.getConfig(),
        staleTime: 30_000,
      });
      return null;
    }
    seedYesterdaysConfig(queryClient);
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <TooltipProvider>
            <OnlineModeReader />
            <AppShell />
          </TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    );

    await letTimePass(HANG_DEADLINE_MS + 1000);

    // The premise, so this case cannot pass for a different reason.
    expect(queryClient.getQueryState(configKeys.current())?.fetchStatus).toBe('paused');
    expect(screen.getByText(HEADLINE)).toBeInTheDocument();
  });
});

describe('AppShell, when the server answers with an error', () => {
  it('does not tell the operator a server that just replied is not there', async () => {
    // **The defect (issue #1841).** A 500 is proof the server accepted the connection, ran, and
    // answered — the reporter's was passing 45 of 45 health checks on a stable PID — and the
    // shell showed "DorkOS can't reach its server.
    vi.mocked(transport.getConfig).mockRejectedValue(answeredWith(500));

    renderAppShell();

    expect(await screen.findByTestId('server-error')).toBeInTheDocument();
    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();
    // The one fact worth repeating to whoever helps next.
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  });

  it('hands a host refusal its own words, which say what to do about it', async () => {
    // A 403 from `hostGuard` is not a fault to wait out: the address is not one this instance
    // answers to, and the server's message names both the address and the two ways out.
    const refusal =
      'This instance does not answer to the address "phone.ngrok.app". ' +
      'If that is how you reach DorkOS, list it in DORKOS_TRUSTED_HOSTS, or turn on login.';
    vi.mocked(transport.getConfig).mockRejectedValue(
      answeredWith(403, refusal, 'HOST_NOT_ALLOWED')
    );

    renderAppShell();

    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();
  });

  it('will not print a stranger’s 403 as if DorkOS wrote it', async () => {
    // A proxy, a captive portal or a CDN can answer 403 with any body it likes, and the status
    // alone cannot tell one from this server's host guard.
    vi.mocked(transport.getConfig).mockRejectedValue(
      answeredWith(403, 'Access denied by CorpProxy. Sign in at portal.example.com to continue.')
    );

    renderAppShell();

    expect(await screen.findByTestId('server-error')).toBeInTheDocument();
    expect(screen.getByText(/didn’t load \(HTTP 403\)/)).toBeInTheDocument();
    expect(screen.queryByText(/CorpProxy/)).not.toBeInTheDocument();
  });
});
