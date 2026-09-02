// @vitest-environment jsdom
/**
 * The shell's boot gate, told apart from the shell's boot FAILURE (DOR-1475).
 *
 * Two states used to look identical from the outside, because both were
 * `<div class="bg-background h-dvh" />`: a config read still in flight, and a
 * config read that had failed with nothing cached. The first is a healthy boot
 * on a slow morning and must stay quiet. The second is a cockpit with no data
 * layer, and its silence was indistinguishable from the v0.63.0 black window.
 *
 * So this suite drives the REAL config query through a transport it controls —
 * rejecting, hanging, then answering — and asserts the shell tells those apart.
 * Mocking `useConfig` here would assert nothing: the whole defect lived in
 * which TanStack state means what.
 *
 * @module __tests__/app-shell-server-unreachable
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { act, render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
import { TooltipProvider } from '@/layers/shared/ui';

// ── Router: the shell mounts without a RouterProvider ──

vi.mock('@tanstack/react-router', () => ({
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

// ── Child surfaces, stubbed at their feature seams ──
//
// Everything below is scenery for this suite: it exists so the shell can mount,
// and nothing here is under test. The one module deliberately left REAL is
// `@/layers/entities/config` — the query whose states this suite is about.

vi.mock('@/layers/widgets/one-bar', () => ({
  resolveRouteHeader: () => null,
  OneBarProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
  BarFixedCluster: () => null,
}));

// Partial, because the mobile tabs derive their zone sets from this module's
// real `SIDEBAR_ZONE_IDS` at import time — only the panel's own bodies are
// scenery here.
vi.mock('@/layers/features/dashboard-sidebar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/features/dashboard-sidebar')>()),
  DashboardSidebar: () => <nav aria-label="Sidebar" data-testid="dashboard-sidebar" />,
  SidebarHeaderBlock: () => null,
  SidebarFooterStrip: () => null,
}));

// The first-run flow itself is not this suite's subject — only whether the
// shell ever gets far enough to show it. The rest of the feature (the gate's
// `isLoading`, which is the whole point) stays real.
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
  useLegacyProfileLinkRedirect: () => {},
}));

// ── Live-data subscriptions: every one of these wants an EventStreamProvider ──

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useSessionId: () => [null, vi.fn()] as const,
  useDefaultCwd: () => {},
  useDirectoryState: () => ['/test/cwd', vi.fn()] as const,
  useGlobalSessionStream: () => {},
  useSessionOrigin: () => ({ origin: undefined, originLabel: undefined }),
  useSessionDetail: () => ({ data: undefined }),
  useSessionBorderState: () => ({
    kind: 'idle',
    color: 'transparent',
    pulse: false,
    label: 'Idle',
  }),
}));

vi.mock('@/layers/entities/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/agent')>()),
  useCurrentAgent: () => ({ data: null, isLoading: false }),
  useAgentVisual: () => ({ color: 'hsl(0,70%,55%)', emoji: '🤖' }),
}));

vi.mock('@/layers/entities/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/command')>()),
  useCommandsSync: () => {},
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

vi.mock('@/layers/entities/unattended-autonomy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/unattended-autonomy')>()),
  useUnattendedAutonomySync: () => {},
}));

vi.mock('@/layers/entities/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/tasks')>()),
  useTasksSync: () => {},
}));

// The shell's banner slot reads the Inbox, to raise a standing row while a
// runtime's sign-in is dead (`widgets/app-banner`, DOR-1680). That hook
// subscribes to the `notification` stream like the rest of this section, and a
// server that will not answer has no notifications to give anyway.
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

/** The headline, spelled with the typographic apostrophe the screen renders. */
const HEADLINE = 'DorkOS can’t reach its server.';

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

function renderAppShell(seed?: (client: QueryClient) => void) {
  const queryClient = new QueryClient({
    // One attempt per fetch: this suite is about what the shell does with a
    // FAILED read, not about how many times TanStack tries first.
    defaultOptions: { queries: { retry: false } },
  });
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
    // Not the empty div, and not the first-run overlay either — that flow
    // collects answers it would have no server to save (the shell's 3s escape
    // hatch used to hand it the window).
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-flow')).not.toBeInTheDocument();
  });

  it('settles there instead of hammering the server it cannot reach', async () => {
    // **The regression this suite exists to hold.** Gated on `isError`, this
    // screen was a hot loop: TanStack rewinds a dataless query to `pending` the
    // moment a retry starts, so the shell un-rendered the very screen whose
    // mount had asked, then re-rendered it when the rejection landed — measured
    // at ~3000 requests in half a second, at a server that is already down.
    vi.mocked(transport.getConfig).mockRejectedValue(new Error('Failed to fetch'));

    renderAppShell();
    await screen.findByText(HEADLINE);

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Generous on purpose: the point is an order of magnitude, not an exact
    // count. Anything in single digits is a screen at rest; the defect was
    // four digits.
    expect(vi.mocked(transport.getConfig).mock.calls.length).toBeLessThan(5);
    // And it is still the screen, not something the churn flickered past.
    expect(screen.getByText(HEADLINE)).toBeInTheDocument();
  });

  it('says so to the returning user too, whose cockpit is painted from yesterday', async () => {
    // **The path that matters most, and the one a `data === undefined` gate
    // could never reach.** The boot cache hydrates `/api/config` out of
    // `localStorage` on every warm start, so a returning user always HAS a
    // config — and with a dead server behind it the shell painted the whole
    // cockpit from last night's copy, every action inside it failing, no
    // screen. Restored is not reachable.
    vi.mocked(transport.getConfig).mockRejectedValue(new Error('Failed to fetch'));

    renderAppShell(seedYesterdaysConfig);

    expect(await screen.findByText(HEADLINE)).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
  });

  it('leaves the returning user’s cockpit alone when the server does answer', async () => {
    // The other half of the same rule, and the reason it is a timestamp rather
    // than "did we fetch": a warm boot against a HEALTHY server must still
    // paint from cache and then quietly confirm. The screen belongs to servers
    // that do not answer, not to caches that are warm.
    vi.mocked(transport.getConfig).mockResolvedValue(settledConfig());

    renderAppShell(seedYesterdaysConfig);

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

    // Past the shell's own 3s escape, which hands the window to the cockpit
    // while the read is merely late. Deliberate: three seconds is not evidence
    // of anything, and the boot sentinel's lesson is not to accuse a machine
    // that was only slow.
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

  it('never shows for a slow boot that lands before the deadline', async () => {
    vi.useFakeTimers();
    let answer: (config: Awaited<ReturnType<Transport['getConfig']>>) => void = () => {};
    vi.mocked(transport.getConfig).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );

    renderAppShell();

    // Ten seconds of nothing — slow, cold, a laptop waking up.
    await letTimePass(10_000);
    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();

    // And then it answers, inside the deadline. The screen was never right
    // about this one and never appeared.
    await act(async () => {
      answer(settledConfig());
    });
    await letTimePass(HANG_DEADLINE_MS);

    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
  });

  it('hands the window back the moment the server answers', async () => {
    const user = userEvent.setup();
    // Down, and staying down — the screen asks again the moment it mounts, so a
    // single scripted rejection would be recovered from before anyone clicked.
    vi.mocked(transport.getConfig).mockRejectedValue(new Error('Failed to fetch'));

    renderAppShell();
    await screen.findByText(HEADLINE);

    // The server comes up; the operator asks again rather than waiting out the
    // screen's own poll.
    vi.mocked(transport.getConfig).mockResolvedValue(settledConfig());
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByTestId('app-shell')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument());
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
