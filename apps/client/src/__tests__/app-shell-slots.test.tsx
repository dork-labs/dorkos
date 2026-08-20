// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { act, render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { BANNER_PRIORITY, type BannerDescriptor } from '@/layers/widgets/app-banner';
import { APP_ROUTE_PATHS } from '@/layers/shared/lib';

// ── Route-aware mock: control the pathname returned by useRouterState ──

let mockPathname = '/';
// The shell reads `?id=` both to name the open room in the document title
// (`useRoomDocumentTitle`) and, since DOR-587, in the channels header
// (`ChannelsHeader`). Defaults to no room open; individual tests set it.
let mockSearch: Record<string, unknown> = {};

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({
    select,
  }: {
    select: (s: { location: { pathname: string; href: string } }) => string;
  }) => select({ location: { pathname: mockPathname, href: mockPathname } }),
  // The tab strip reads the router directly: `useAppTabsSync` subscribes to
  // history for the action type (only Back/Forward may move focus between
  // tabs), and the tab actions re-read the location once a navigation settles.
  useRouter: () => ({
    navigate: (_options: { href: string }) => Promise.resolve(),
    get state() {
      return { location: { pathname: mockPathname, href: mockPathname } };
    },
    history: { subscribe: () => () => {} },
    // Kept because the router type carries it and other shell hooks may reach
    // for it; nothing in the shell subscribes any more, since the mobile
    // auto-close retired with the drawer (P4).
    subscribe: () => () => {},
  }),
  Outlet: () => <div data-testid="outlet">outlet</div>,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: mockPathname }),
  useSearch: () => mockSearch,
}));

// ── Mock child components with identifiable test markers ──

// The roster can render with zones and without them — P2 AC-8 asks for the
// takeover to be correct in both states, and "without" is the ordinary quiet
// morning where Heads up and Today are both absent (BC-1).
let mockZonesPresent = true;
vi.mock('@/layers/features/dashboard-sidebar', async () => {
  // The zone enumeration is the REAL one, imported from the module that owns
  // it: the mobile tabs derive Home's and Library's zone sets from that tuple,
  // and a hand-written copy here would let the two drift apart silently.
  const { SIDEBAR_ZONE_IDS } =
    await import('@/layers/features/dashboard-sidebar/model/build-sidebar-model');
  return {
    SIDEBAR_ZONE_IDS,
    DashboardSidebar: () => (
      <nav aria-label="Sidebar" data-testid="dashboard-sidebar">
        {mockZonesPresent && <section data-sidebar-zone="library">Library</section>}
      </nav>
    ),
    // Both are persistent chrome: AppShell mounts them OUTSIDE the
    // `sidebar.body` swap region, so a contributed takeover replaces the body and
    // leaves the panel's identity and its navigation standing (spec R2, BC-43,
    // BC-47).
    SidebarHeaderBlock: () => <div data-testid="sidebar-header-block">Header block</div>,
    SidebarFooterStrip: () => <div data-testid="sidebar-footer-strip">Footer strip</div>,
    // What the mobile tabs compose. Stubbed at the feature seam so this suite
    // stays about the SHELL — which cockpit it mounts and where a takeover
    // lands — while `MobileTabsLayout.test.tsx` drives the real model through
    // the real zones.
    SidebarChrome: ({ children }: React.PropsWithChildren) => <>{children}</>,
    SidebarZones: ({ zoneIds }: { zoneIds?: readonly string[] }) => (
      <div data-testid={`sidebar-zones-${zoneIds?.join('+') ?? 'all'}`} />
    ),
    useSidebarState: () => ({ activeTarget: null }),
    useSidebarModel: () => ({ zones: [] }),
    useAskDorkBot: () => ({ ask: vi.fn(), ready: true }),
    useLegacyPinMigration: () => {},
    // The phone's needs-you announcement, which the tabs now render OUTSIDE
    // their panels because a panel is `inert` whenever it is put away (P4.2).
    useLiveRegionText: (text: string | undefined) => text ?? '',
  };
});

vi.mock('@/layers/features/top-nav', () => ({
  SessionHeader: () => <div data-testid="session-header">Session</div>,
  DashboardHeader: () => <div data-testid="dashboard-header">Dashboard</div>,
  ChannelsHeader: ({ roomTitle }: { roomTitle: string | null }) => (
    <div data-testid="channels-header">{roomTitle ?? 'Channels'}</div>
  ),
  MarketplaceHeader: () => <div data-testid="marketplace-header">Marketplace</div>,
  MarketplaceSourcesHeader: () => <div data-testid="marketplace-sources-header">Sources</div>,
  TeamHeader: () => <div data-testid="team-header">Team</div>,
  ActivityHeader: () => <div data-testid="activity-header">Activity</div>,
  TasksHeader: () => <div data-testid="tasks-header">Tasks</div>,
  WorkspacesHeader: () => <div data-testid="workspaces-header">Workspaces</div>,
  ConnectionsHeader: () => <div data-testid="connections-header">Connections</div>,
  FeedbackRequestsHeader: () => (
    <div data-testid="feedback-requests-header">Feedback &amp; requests</div>
  ),
}));

vi.mock('@/layers/widgets/app-layout', () => ({
  DialogHost: () => null,
  FeedbackDialogHost: () => null,
}));

vi.mock('@/layers/features/tours', () => ({
  TourHost: () => null,
}));

// Keep the real AppBannerSlot so this suite can prove *where* the global banner
// lands in the shell (DOR-389): inside SidebarInset, below the header — never
// above the shell where the fixed sidebar would paint over it. `useAppBanners` is
// driven by a mutable list so a single test can make a banner eligible; it
// defaults to empty, so every other test renders no banner and is unaffected.
let mockBanners: BannerDescriptor[] = [];
vi.mock('@/layers/widgets/app-banner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/widgets/app-banner')>();
  return { ...actual, useAppBanners: () => mockBanners };
});

// Keep the real ApprovalsIndicator so this suite can prove the approvals marker
// reaches EVERY route — the defect it fixes was a pending approval that only
// appeared on the dashboard. Only the feature slice is faked (the real hook needs
// an EventStreamProvider this shell-level suite does not mount), so the widget,
// its placement, and its render-nothing-at-zero rule are all under test.
// The marker also reads the global stream's connection state, and this suite
// mounts no EventStreamProvider. Stub that one hook; the rest of the barrel
// (TransportProvider, the already-stubbed favicon/title submodules) stays real.
// Which cockpit the shell mounts is one question — `useIsMobile()` — asked at
// one call site in AppShell, so this flag is the whole of what the mobile cases
// below change.
let mockIsMobile = false;
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventStream: () => ({
      subscribe: vi.fn(),
      connectionState: 'connected' as const,
      failedAttempts: 0,
    }),
    useIsMobile: () => mockIsMobile,
  };
});

let mockPendingApprovals: Array<{ approvalId: string }> = [];
let mockApprovalsError = false;
// The queue itself is an ENTITY now, so its stub lives on the entity — the
// approvals feature owns the cards it is rendered into and nothing else.
vi.mock('@/layers/entities/attention', () => ({
  // Nothing waiting on anybody, and nothing on its way out: the tray and the
  // pill both read these now.
  usePendingInteractions: () => ({ interactions: [], isLoading: false }),
  useSettlingAsks: () => [],
  useAskAgentNames: () => ({}),
  usePendingApprovals: () => ({
    approvals: mockPendingApprovals,
    isLoading: false,
    isError: mockApprovalsError,
    retry: vi.fn(),
  }),
}));
vi.mock('@/layers/features/approvals', () => ({
  ApprovalList: ({ approvals }: { approvals: Array<{ approvalId: string }> }) => (
    <div data-testid="approval-list">{approvals.length} cards</div>
  ),
  ApprovalsUnavailable: () => <div data-testid="approvals-unavailable">unavailable</div>,
  StandingPermissionList: () => <div data-testid="standing-permission-list" />,
  // This suite is about WHERE the marker sits, not about standing permissions.
  // An empty list keeps the marker's appearance driven solely by the pending
  // queue, which is what every assertion below is written against.
  useStandingPermissions: () => ({ permissions: [], isLoading: false, isError: false }),
}));

vi.mock('@/layers/features/command-palette', () => ({
  CommandPaletteDialog: () => null,
}));

vi.mock('@/layers/features/shortcuts', () => ({
  ShortcutsPanel: () => null,
  useShortcutsPanel: () => {},
}));

vi.mock('@/layers/features/onboarding', () => ({
  useOnboarding: () => ({
    shouldShowOnboarding: false,
    shouldShowGettingStarted: false,
    isLoading: false,
    isOnboardingComplete: false,
    isOnboardingDismissed: false,
    dismiss: vi.fn(),
  }),
  useOnboardingOverlayVisible: () => false,
  useClearOnboardingStageWhenDone: () => {},
  OnboardingFlow: () => null,
  ProgressCard: () => null,
  ProfilePromptCard: () => null,
}));

// ── Mock entity hooks ──

vi.mock('@/layers/entities/session', () => ({
  useSessionId: () => [null, vi.fn()] as const,
  useDefaultCwd: () => {},
  useDirectoryState: () => ['/test/cwd', vi.fn()] as const,
  useGlobalSessionStream: () => {},
  // AppShell reads the active session's origin for the header chip
  // (session-origin-legibility): no active session in this shell-level
  // isolation test, so it always resolves to "no origin".
  useSessionOrigin: () => ({ origin: undefined, originLabel: undefined }),
  // The tab strip badges a chat tab off this (DOR-540). Nothing is streaming in
  // a shell-level isolation test, so every tab reads idle.
  useSessionBorderState: () => ({
    kind: 'idle',
    color: 'transparent',
    pulse: false,
    label: 'Idle',
  }),
}));

vi.mock('@/layers/entities/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/agent')>();
  return {
    ...actual,
    useCurrentAgent: () => ({ data: null, isLoading: false }),
    useAgentVisual: () => ({ color: 'hsl(0,70%,55%)', emoji: '🤖' }),
  };
});

// AppShell mounts useCommandsSync (UX-12), useBindingsSync, useRelayAdaptersSync,
// useUnattendedAutonomySync, and usePulseFreshness — each subscribes via the
// event stream and so needs an EventStreamProvider. This slot test isolates AppShell and provides no such
// provider, so no-op the subscriptions here.
vi.mock('@/layers/entities/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/command')>();
  return {
    ...actual,
    useCommandsSync: () => {},
  };
});

vi.mock('@/layers/widgets/pulse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/widgets/pulse')>();
  return {
    ...actual,
    usePulseFreshness: () => {},
  };
});

// The shell also keeps the room list live for the browser tab's unread badge
// (`useRoomDocumentTitle` -> `useRoomListStream`) — another event-stream
// subscription, no-op'd here for the same reason.
//
// `useRoom` is overridden too, so the "names the open room" header test below
// can hand the shell a resolved room without a real transport round trip.
// Every other test leaves `mockOpenRoom` `null`, so `useRoom` degrades to "no
// room selected" — the same shape the real hook answers with a disabled query.
let mockOpenRoom: { kind: 'channel' | 'dm'; slug: string | null; title: string } | null = null;
vi.mock('@/layers/entities/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/room')>();
  return {
    ...actual,
    useRoomListStream: () => {},
    useRoom: (roomId: string | null) => ({
      data: roomId !== null ? (mockOpenRoom ?? undefined) : undefined,
    }),
  };
});

vi.mock('@/layers/entities/binding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/binding')>();
  return {
    ...actual,
    useBindingsSync: () => {},
  };
});

vi.mock('@/layers/entities/relay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/relay')>();
  return {
    ...actual,
    useRelayAdaptersSync: () => {},
  };
});

vi.mock('@/layers/entities/unattended-autonomy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/unattended-autonomy')>();
  return {
    ...actual,
    useUnattendedAutonomySync: () => {},
  };
});

// The Tasks list is kept live off the same stream (DOR-1380) via useTasksSync,
// mounted alongside the other *Sync hooks above.
vi.mock('@/layers/entities/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/tasks')>();
  return {
    ...actual,
    useTasksSync: () => {},
  };
});

// ── Mock shared model hooks ──

vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state: Record<string, unknown> = {
      sidebarOpen: true,
      setSidebarOpen: vi.fn(),
      isStreaming: false,
      activeForm: null,
      isWaitingForUser: false,
      tasksBadgeCount: 0,
      onboardingHiddenForSession: false,
      setOnboardingHiddenForSession: vi.fn(),
      loadRightPanelState: vi.fn(),
      toggleRightPanel: vi.fn(),
      pipContent: null,
      pipGeometry: null,
      closePip: vi.fn(),
      setPipGeometry: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
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

// The profile's own key and its two deep-link readers live with the profile, not
// with the panel they open — stubbed here so the shell mounts without a router.
vi.mock('@/layers/features/profile', () => ({
  useProfileShortcut: () => {},
  useProfileDockDeepLink: () => {},
  useLegacyProfileLinkRedirect: () => {},
}));

vi.mock('@/layers/shared/model/use-favicon', () => ({
  useFavicon: () => {},
}));

vi.mock('@/layers/shared/model/use-document-title', () => ({
  useDocumentTitle: () => {},
}));

// ── Mock sonner (Toaster dependency) ──

vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));

// ── Import AppShell after all mocks are set up ──

import { AppShell } from '../AppShell';
// The extension registry is a real (unmocked) singleton — the app-store mock
// above only replaces `@/layers/shared/model/app-store`, so `useSlotContributions`
// still reads this store. Tests register a `sidebar.body` contribution to
// exercise the takeover path.
import { useExtensionRegistry } from '@/layers/shared/model/extension-registry';
import type { SidebarBodyContribution } from '@/layers/shared/model/extension-registry';
import { enterDesktopShell, leaveDesktopShell } from '@/test-helpers/desktop-shell';
import { useMobilePanelStore } from '@/layers/widgets/mobile-tabs';

// ── Test setup ──

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

let mockTransport: Transport;

function renderAppShell() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        <TooltipProvider>
          <AppShell />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('AppShell slot integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport = createMockTransport();
  });

  afterEach(() => {
    cleanup();
    leaveDesktopShell();
    mockSearch = {};
    mockOpenRoom = null;
    mockIsMobile = false;
    useMobilePanelStore.setState({ panelUp: false });
  });

  describe('the phone cockpit (P4)', () => {
    beforeEach(() => {
      mockIsMobile = true;
      mockPathname = '/';
    });

    // ── P4 AC-1 ──
    it('mounts no sidebar panel and no sheet — there is no drawer to open', async () => {
      renderAppShell();
      expect(document.querySelector('[data-slot="sidebar"]')).toBeNull();
      expect(screen.queryByTestId('dashboard-sidebar')).not.toBeInTheDocument();

      // **Asked the only way that can answer.** A Radix Sheet renders NOTHING
      // while it is closed, so "there is no `[data-mobile="true"]` in the DOM"
      // is equally true of a mounted-but-shut drawer — it passed with `<Sidebar>`
      // rendered unconditionally, which is a check that cannot fail. So the
      // drawer is asked to OPEN first: `SidebarProvider` still owns ⌘B, and on a
      // phone that gesture is exactly `setOpenMobile(true)`. Nothing opens
      // because there is nothing mounted to open.
      await userEvent.keyboard('{Meta>}b{/Meta}');
      expect(document.querySelector('[data-mobile="true"]')).toBeNull();
      expect(screen.queryByTestId('dashboard-sidebar')).not.toBeInTheDocument();
      expect(document.querySelector('[data-slot="sidebar"]')).toBeNull();
    });

    it('drops the toggle with the panel — no hamburger that opens nothing', () => {
      renderAppShell();
      expect(screen.queryByRole('button', { name: 'Toggle Sidebar' })).not.toBeInTheDocument();
    });

    it('mounts the four destinations along the bottom instead', () => {
      renderAppShell();
      expect(screen.getByTestId('mobile-tab-bar')).toBeInTheDocument();
      expect(screen.getByTestId('mobile-tab-home')).toBeInTheDocument();
    });

    it('keeps the routed content alongside the tabs, never inside them', () => {
      renderAppShell();
      const outlet = screen.getByTestId('outlet');
      expect(document.querySelector('[data-slot="sidebar-inset"]')).toContainElement(outlet);
      expect(screen.getByTestId('mobile-tab-panels')).not.toContainElement(outlet);
    });

    // ── review B2 ──
    describe('the page a panel covers is unreachable, not merely hidden', () => {
      // Paired, because either half alone is satisfiable by an accident. "The
      // page is inert" passes on a shell that inerts it always; "the page is
      // reachable" passes on one that never inerts it. Only the transition
      // between the two states says the shell is reading the right bit.
      const inset = () => document.querySelector('[data-slot="sidebar-inset"]');

      it('is reachable while the panels are down — the cold-load state', () => {
        renderAppShell();
        expect(useMobilePanelStore.getState().panelUp).toBe(false);
        expect(inset()).not.toHaveAttribute('inert');
      });

      it('goes inert the moment a destination is opened, and comes back', () => {
        renderAppShell();
        act(() => useMobilePanelStore.getState().raise());
        // `inert` removes the subtree from the tab order AND the accessibility
        // tree — both halves of the modality the Radix Sheet used to provide.
        expect(inset()).toHaveAttribute('inert');
        expect(inset()).toContainElement(screen.getByTestId('outlet'));

        act(() => useMobilePanelStore.getState().lower());
        expect(inset()).not.toHaveAttribute('inert');
      });

      it('never inerts the page at desktop width, whatever the store says', () => {
        // The store outlives the layout, so a stale raised bit must not reach
        // through to a width that has no panels at all.
        mockIsMobile = false;
        act(() => useMobilePanelStore.getState().raise());
        renderAppShell();
        expect(inset()).not.toHaveAttribute('inert');
      });
    });

    it('puts Now and Today in Home and Library in its own destination', () => {
      renderAppShell();
      // The zone sets the layout asked for, read off the stub that records them.
      expect(
        within(screen.getByTestId('mobile-tab-panel-home')).getByTestId(
          'sidebar-zones-getting-started+now+today'
        )
      ).toBeInTheDocument();
      expect(
        within(screen.getByTestId('mobile-tab-panel-library')).getByTestId('sidebar-zones-library')
      ).toBeInTheDocument();
    });

    it('carries the four places DorkOS goes into You, so nothing is stranded', () => {
      renderAppShell();
      expect(
        within(screen.getByTestId('mobile-tab-panel-you')).getByTestId('sidebar-footer-strip')
      ).toBeInTheDocument();
    });

    describe('a sidebar.body takeover', () => {
      let unregister: () => void;
      beforeEach(() => {
        unregister = useExtensionRegistry.getState().register('sidebar.body', {
          id: 'marketplace-facets',
          component: () => <div data-testid="marketplace-sidebar-fake">Marketplace facets</div>,
          visibleWhen: ({ pathname }) => pathname.startsWith('/marketplace'),
          priority: 10,
        });
      });
      afterEach(() => unregister?.());

      it('lands inside Library and nowhere else on a phone', () => {
        mockPathname = '/marketplace';
        renderAppShell();
        const takeover = screen.getByTestId('marketplace-sidebar-fake');
        expect(screen.getByTestId('mobile-tab-panel-library')).toContainElement(takeover);
        expect(screen.getByTestId('mobile-tab-panel-home')).not.toContainElement(takeover);
        // …and Home keeps its zones: browsing the marketplace is not a reason
        // to stop being told what needs you.
        expect(
          within(screen.getByTestId('mobile-tab-panel-home')).getByTestId(
            'sidebar-zones-getting-started+now+today'
          )
        ).toBeInTheDocument();
      });
    });
  });

  describe('desktop is unaffected (regression guard for the AppShell edit)', () => {
    it('still mounts the panel, its chrome and its toggle — and no tab bar', () => {
      mockPathname = '/';
      renderAppShell();
      expect(document.querySelector('[data-slot="sidebar"]')).not.toBeNull();
      expect(screen.getByTestId('dashboard-sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('sidebar-header-block')).toBeInTheDocument();
      expect(screen.getByTestId('sidebar-footer-strip')).toBeInTheDocument();
      // `getAll`: the rail is a second control with the same name, and the
      // point here is that the toggle exists at all — not how many there are.
      expect(screen.getAllByRole('button', { name: 'Toggle Sidebar' }).length).toBeGreaterThan(0);
      expect(screen.queryByTestId('mobile-tab-bar')).not.toBeInTheDocument();
    });
  });

  describe('sidebar slots', () => {
    it('renders DashboardSidebar at /', () => {
      mockPathname = '/';
      renderAppShell();
      expect(screen.getByTestId('dashboard-sidebar')).toBeInTheDocument();
    });

    it('renders the DashboardSidebar roster at /session — no session drill-in', () => {
      // The web shell keeps the roster on /session; the session drill-in was
      // retired in favor of the right-panel inspector.
      mockPathname = '/session';
      renderAppShell();
      expect(screen.getByTestId('dashboard-sidebar')).toBeInTheDocument();
    });
  });

  describe('sidebar body takeover (sidebar.body slot)', () => {
    let unregister: () => void;

    beforeEach(() => {
      unregister = useExtensionRegistry.getState().register('sidebar.body', {
        id: 'marketplace-facets',
        component: () => <div data-testid="marketplace-sidebar-fake">Marketplace facets</div>,
        visibleWhen: ({ pathname }) => pathname.startsWith('/marketplace'),
        priority: 10,
      });
    });

    afterEach(() => {
      unregister?.();
      mockZonesPresent = true;
    });

    // ── P2 AC-8 ──
    it.each([true, false])(
      'keeps the header block OUTSIDE the swap region, so a takeover cannot take it (zones present: %s)',
      (zones) => {
        // **Structural, not presence.** Chrome rendered inside the animated
        // body would still be on screen on the roster route and would still be
        // "mounted" after a takeover swapped a different body in — because the
        // shell mounts it either way. What distinguishes the two arrangements is
        // whether the swap region CONTAINS it. An earlier version of this test
        // asserted presence and passed with the chrome moved inside.
        mockZonesPresent = zones;
        mockPathname = '/';
        renderAppShell();

        const swap = screen.getByTestId('sidebar-body-swap');
        const footer = screen.getByTestId('sidebar-footer-strip');
        expect(swap).toContainElement(screen.getByTestId('dashboard-sidebar'));
        expect(swap).not.toContainElement(footer);
        // The zones themselves live inside the body, whichever state they are in.
        expect(document.querySelector('[data-sidebar-zone="library"]') !== null).toBe(zones);
        cleanup();

        // And the takeover swaps only what the swap region held.
        mockPathname = '/marketplace';
        renderAppShell();
        expect(screen.getByTestId('marketplace-sidebar-fake')).toBeInTheDocument();
        expect(screen.queryByTestId('dashboard-sidebar')).not.toBeInTheDocument();
        expect(screen.getByTestId('sidebar-footer-strip')).toBeInTheDocument();
      }
    );

    it('replaces the roster with the contributed body on /marketplace', () => {
      mockPathname = '/marketplace';
      renderAppShell();
      expect(screen.getByTestId('marketplace-sidebar-fake')).toBeInTheDocument();
      expect(screen.queryByTestId('dashboard-sidebar')).not.toBeInTheDocument();
    });

    it('takes over on a nested marketplace route too', () => {
      mockPathname = '/marketplace/sources';
      renderAppShell();
      expect(screen.getByTestId('marketplace-sidebar-fake')).toBeInTheDocument();
    });

    it('restores the dashboard roster when navigating away from marketplace', () => {
      mockPathname = '/';
      renderAppShell();
      expect(screen.getByTestId('dashboard-sidebar')).toBeInTheDocument();
      expect(screen.queryByTestId('marketplace-sidebar-fake')).not.toBeInTheDocument();
    });

    it('does not hijack the session route roster', () => {
      // The marketplace body only matches /marketplace*, so /session keeps its
      // built-in roster (DashboardSidebar).
      mockPathname = '/session';
      renderAppShell();
      expect(screen.getByTestId('dashboard-sidebar')).toBeInTheDocument();
      expect(screen.queryByTestId('marketplace-sidebar-fake')).not.toBeInTheDocument();
    });

    it('a throwing contributed body degrades to an inline fallback, not a dead shell', () => {
      // React + the boundary both log the caught error — silence the noise.
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // Replace the healthy body with one that throws during render —
        // simulates a chunk-load 404 after a redeploy or a bug in the panel.
        unregister();
        unregister = useExtensionRegistry.getState().register('sidebar.body', {
          id: 'marketplace-facets',
          component: () => {
            throw new Error('boom');
          },
          visibleWhen: ({ pathname }) => pathname.startsWith('/marketplace'),
          priority: 10,
        });

        mockPathname = '/marketplace';
        renderAppShell();

        // The shell survives: chrome, header, and the footer strip all still render, and
        // the sidebar body area shows the boundary's inline fallback instead of
        // the whole app being replaced by the router's error component.
        expect(screen.getByTestId('app-shell')).toBeInTheDocument();
        expect(screen.getByTestId('marketplace-header')).toBeInTheDocument();
        expect(screen.getByTestId('sidebar-footer-strip')).toBeInTheDocument();
        expect(screen.getByTestId('sidebar-body-error')).toBeInTheDocument();
      } finally {
        consoleError.mockRestore();
      }
    });

    it('a malformed contribution without visibleWhen never takes over (runtime guard)', () => {
      // Simulates a rogue generic registration that omitted the required
      // predicate — the shell must treat it as never matching, not crash.
      unregister();
      unregister = useExtensionRegistry.getState().register('sidebar.body', {
        id: 'marketplace-facets',
        component: () => <div data-testid="rogue-body">rogue</div>,
      } as unknown as SidebarBodyContribution);

      mockPathname = '/marketplace';
      renderAppShell();

      expect(screen.getByTestId('dashboard-sidebar')).toBeInTheDocument();
      expect(screen.queryByTestId('rogue-body')).not.toBeInTheDocument();
    });
  });

  describe('sidebar body clip (shell seam)', () => {
    it('wraps the sliding body in an overflow-hidden clip ancestor', () => {
      // The body swap slides the motion.div horizontally (x: ±100%). The
      // transform lives on the motion.div itself, so its own `overflow-hidden`
      // can only clip its children — never its own translated box. The clip must
      // therefore live on the ancestor wrapper, or mid-flight content spills past
      // the sidebar's edge. AnimatePresence renders no DOM node, so the swap
      // element's DOM parent is that wrapper.
      mockPathname = '/';
      renderAppShell();
      const body = screen.getByTestId('sidebar-body-swap');
      const clipWrapper = body.parentElement;
      expect(clipWrapper).not.toBeNull();
      expect(clipWrapper).toHaveClass('overflow-hidden');
    });

    it('keeps the clip on every body swap, including contributed takeovers', () => {
      // Register a marketplace-style takeover so the swapped-in body is a
      // contributed one, not the built-in roster — the clip is a shell property,
      // so it must hold for current and future bodies alike.
      const unregister = useExtensionRegistry.getState().register('sidebar.body', {
        id: 'clip-check-takeover',
        component: () => <div data-testid="clip-check-body">takeover</div>,
        visibleWhen: ({ pathname }) => pathname.startsWith('/marketplace'),
        priority: 10,
      });
      try {
        mockPathname = '/marketplace';
        renderAppShell();
        const body = screen.getByTestId('sidebar-body-swap');
        expect(body).toContainElement(screen.getByTestId('clip-check-body'));
        expect(body.parentElement).toHaveClass('overflow-hidden');
      } finally {
        unregister();
      }
    });
  });

  describe('header slots', () => {
    it('renders DashboardHeader at /', () => {
      mockPathname = '/';
      renderAppShell();
      expect(screen.getByTestId('dashboard-header')).toBeInTheDocument();
      expect(screen.queryByTestId('session-header')).not.toBeInTheDocument();
    });

    it('renders SessionHeader at /session', () => {
      mockPathname = '/session';
      renderAppShell();
      expect(screen.getByTestId('session-header')).toBeInTheDocument();
      expect(screen.queryByTestId('dashboard-header')).not.toBeInTheDocument();
    });

    // DOR-587: /channels had no case in the route switch, so it fell through
    // to `default` and rendered DashboardHeader — every channel and every DM
    // read "Dashboard" in the chrome above it.
    it('renders ChannelsHeader at /channels, not the dashboard header', () => {
      mockPathname = '/channels';
      renderAppShell();
      expect(screen.getByTestId('channels-header')).toBeInTheDocument();
      expect(screen.queryByTestId('dashboard-header')).not.toBeInTheDocument();
    });

    it("names the open room in the channels header, not the route's generic name", () => {
      mockPathname = '/channels';
      mockSearch = { id: 'room_1' };
      mockOpenRoom = { kind: 'channel', slug: 'general', title: 'general' };
      renderAppShell();
      expect(screen.getByTestId('channels-header')).toHaveTextContent('#general');
    });

    it('hands a null roomTitle through to ChannelsHeader when no room is open', () => {
      // The mock above reimplements the fallback, so this test pins only the
      // shell's null-threading; the real `?? 'Channels'` fallback is pinned in
      // ChannelsHeader.test.tsx against the real component.
      mockPathname = '/channels';
      renderAppShell();
      expect(screen.getByTestId('channels-header')).toHaveTextContent('Channels');
    });

    // DOR-919 (sibling of DOR-587): /workspaces, /connections, and
    // /feedback-requests had no case in the route switch either, so all three
    // fell through to `default` and rendered DashboardHeader — "Dashboard"
    // over a page whose body said something else.
    it('renders WorkspacesHeader at /workspaces, not the dashboard header', () => {
      mockPathname = '/workspaces';
      renderAppShell();
      expect(screen.getByTestId('workspaces-header')).toBeInTheDocument();
      expect(screen.queryByTestId('dashboard-header')).not.toBeInTheDocument();
    });

    it('renders ConnectionsHeader at /connections, not the dashboard header', () => {
      mockPathname = '/connections';
      renderAppShell();
      expect(screen.getByTestId('connections-header')).toBeInTheDocument();
      expect(screen.queryByTestId('dashboard-header')).not.toBeInTheDocument();
    });

    it('renders FeedbackRequestsHeader at /feedback-requests, not the dashboard header', () => {
      mockPathname = '/feedback-requests';
      renderAppShell();
      expect(screen.getByTestId('feedback-requests-header')).toBeInTheDocument();
      expect(screen.queryByTestId('dashboard-header')).not.toBeInTheDocument();
    });
  });

  describe('header slot completeness (drift guard)', () => {
    // DOR-587 and DOR-919 were both the same shape: a route added to the
    // router with no case in useHeaderSlot's switch, so it fell through to
    // `default` and silently rendered DashboardHeader instead of its own
    // header. This iterates the router's real, current route list — the same
    // source app-route-paths.test.ts checks against — so a future route added
    // the same way fails here by name instead of waiting for a human to
    // notice "Dashboard" over the wrong page.
    // `/agents` is the one route with no header of its own on purpose: it is a
    // `beforeLoad` redirect to `/team` and renders no page at all, so the shell
    // never draws a header for it. Excluded by name rather than by loosening
    // the guard, so a route that genuinely forgets its header still fails.
    const HEADERLESS_ROUTES: readonly string[] = ['/agents'];

    it('renders a non-dashboard header for every route except /', () => {
      const nonRootRoutes = APP_ROUTE_PATHS.filter(
        (path) => path !== '/' && !HEADERLESS_ROUTES.includes(path)
      );
      for (const path of nonRootRoutes) {
        mockPathname = path;
        renderAppShell();
        expect(
          screen.queryByTestId('dashboard-header'),
          `${path} rendered the dashboard header — give it a case in useHeaderSlot (AppShell.tsx)`
        ).not.toBeInTheDocument();
        cleanup();
      }
    });

    it('renders DashboardHeader at / — the one route allowed to use it', () => {
      mockPathname = '/';
      renderAppShell();
      expect(screen.getByTestId('dashboard-header')).toBeInTheDocument();
    });
  });

  describe('global banner placement (DOR-389)', () => {
    afterEach(() => {
      mockBanners = [];
    });

    it('mounts the standing banner inside the content inset and below the header — never behind the fixed sidebar', () => {
      // Regression guard for DOR-389. The first-run telemetry notice once mounted
      // above the shell, where the fixed (z-10) sidebar painted over its opening
      // line and it shoved the header down. The global slot now lives inside
      // SidebarInset, below the header. Lock the structural invariant that keeps
      // the notice readable from its first word: the rendered banner sits within
      // the content inset, after the header, and outside the fixed sidebar.
      mockBanners = [
        {
          id: 'placement-probe',
          variant: 'neutral',
          priority: BANNER_PRIORITY.neutral,
          render: () => <div data-testid="standing-banner">standing notice</div>,
        },
      ];
      mockPathname = '/';
      renderAppShell();

      const banner = screen.getByTestId('standing-banner');

      // Inside the content inset...
      const inset = document.querySelector('[data-slot="sidebar-inset"]');
      expect(inset).not.toBeNull();
      expect(inset).toContainElement(banner);

      // ...below the header (its own row, not nested in the header)...
      const header = inset?.querySelector('header');
      expect(header).not.toBeNull();
      expect(header).not.toContainElement(banner);
      expect(
        header && header.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();

      // ...and outside the fixed sidebar that would otherwise occlude it.
      const sidebar = document.querySelector('[data-slot="sidebar"]');
      expect(sidebar).not.toBeNull();
      expect(sidebar).not.toContainElement(banner);
    });
  });

  describe('window tabs (DOR-540)', () => {
    // Tabs are a desktop-app feature (DOR-568); the browser case has its own
    // block below.
    beforeEach(enterDesktopShell);

    it('mounts the tab strip at the top of the content inset, above the header', () => {
      // The strip is the inset's top band on macOS: it carries the drag region
      // and the traffic-light clearance the header used to need, so it has to
      // come FIRST inside the inset, not after the header.
      mockPathname = '/';
      renderAppShell();

      const strip = screen.getByRole('tablist', { name: 'Open tabs' });
      const inset = document.querySelector('[data-slot="sidebar-inset"]');
      expect(inset).toContainElement(strip);

      const header = inset?.querySelector('header');
      expect(header).not.toBeNull();
      expect(header).not.toContainElement(strip);
      expect(
        header && header.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_PRECEDING
      ).toBeTruthy();
    });

    it('names the active tab after the route the router is on', () => {
      // Proves the shell feeds the strip the real location, not a placeholder.
      mockPathname = '/team';
      renderAppShell();

      expect(screen.getByRole('tab', { selected: true })).toHaveAccessibleName(/Team/);
    });

    it('points the active tab at the routed content region', () => {
      mockPathname = '/';
      renderAppShell();

      const active = screen.getByRole('tab', { selected: true });
      const panelId = active.getAttribute('aria-controls');
      expect(panelId).toBeTruthy();
      expect(document.getElementById(panelId!)).not.toBeNull();
    });
  });

  describe('no window tabs in a browser (DOR-568)', () => {
    it('renders no strip — the browser already has one, and a better one', () => {
      mockPathname = '/';
      renderAppShell();

      expect(screen.queryByRole('tablist', { name: 'Open tabs' })).not.toBeInTheDocument();
      expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    });

    it('keeps the header, its drag region and its chrome — the inset just starts higher', () => {
      // The strip carried the drag region and the macOS traffic-light
      // clearance. Removing it must not take the header's own chrome with it.
      mockPathname = '/';
      renderAppShell();

      const inset = document.querySelector('[data-slot="sidebar-inset"]');
      const header = inset?.querySelector('header');
      expect(header).not.toBeNull();
      expect(header).toHaveClass('app-drag-region');
      // The header is now the inset's first child, with nothing above it.
      expect(inset?.firstElementChild).toBe(header);
      // …and the routed content region the tabs pointed at is still there.
      expect(inset?.querySelector('main')).not.toBeNull();
    });

    it('writes nothing to the tab store — no sessionStorage either', () => {
      sessionStorage.clear();
      mockPathname = '/team';
      renderAppShell();

      expect(sessionStorage.length).toBe(0);
    });
  });

  describe('approvals marker placement', () => {
    afterEach(() => {
      mockPendingApprovals = [];
      mockApprovalsError = false;
    });

    it('shows the marker in the header on /session, not only on the dashboard', () => {
      // The whole point of the widget: an agent asks while its operator is in a
      // session, and before this the question only existed on the dashboard.
      mockPendingApprovals = [{ approvalId: '01JZ1' }];
      mockPathname = '/session';
      renderAppShell();

      const marker = screen.getByTestId('approvals-indicator');
      const header = document.querySelector('[data-slot="sidebar-inset"] header');
      expect(header).not.toBeNull();
      expect(header).toContainElement(marker);
    });

    it('shows the marker on the dashboard route too', () => {
      mockPendingApprovals = [{ approvalId: '01JZ1' }];
      mockPathname = '/';
      renderAppShell();

      expect(screen.getByTestId('approvals-indicator')).toBeInTheDocument();
    });

    it('renders no marker when nothing is waiting', () => {
      mockPathname = '/session';
      renderAppShell();

      expect(screen.queryByTestId('approvals-indicator')).not.toBeInTheDocument();
    });
  });

  describe('static chrome', () => {
    it('renders the footer strip regardless of route', () => {
      mockPathname = '/';
      renderAppShell();
      expect(screen.getByTestId('sidebar-footer-strip')).toBeInTheDocument();

      cleanup();

      mockPathname = '/session';
      renderAppShell();
      expect(screen.getByTestId('sidebar-footer-strip')).toBeInTheDocument();
    });

    it('renders the app-shell container on both routes', () => {
      mockPathname = '/';
      renderAppShell();
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();

      cleanup();

      mockPathname = '/session';
      renderAppShell();
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    });
  });
});
