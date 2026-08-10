// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
    // `SidebarMobileNavigationClose` listens for a committed destination so the
    // mobile sheet gets out of its way (DOR-610). Nothing here navigates, so
    // the listener is registered and never fired.
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
// morning where Now and Today are both absent (BC-1).
let mockZonesPresent = true;
vi.mock('@/layers/features/dashboard-sidebar', () => ({
  DashboardSidebar: () => (
    <nav aria-label="Sidebar" data-testid="dashboard-sidebar">
      {mockZonesPresent && <section data-sidebar-zone="library">Library</section>}
    </nav>
  ),
  // The header block is persistent chrome: AppShell mounts it OUTSIDE the
  // `sidebar.body` swap region (spec R2).
  SidebarNavHeader: () => <div data-testid="sidebar-nav-header">Nav</div>,
}));

// AppShell imports only SidebarFooterBar from session-list — the web session
// drill-in (SessionSidebar) was retired for the persistent roster + right-panel
// inspector and has since been deleted (DOR-401).
vi.mock('@/layers/features/session-list', () => ({
  SidebarFooterBar: () => <div data-testid="sidebar-footer-bar">SidebarFooterBar</div>,
}));

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
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventStream: () => ({
      subscribe: vi.fn(),
      connectionState: 'connected' as const,
      failedAttempts: 0,
    }),
  };
});

let mockPendingApprovals: Array<{ approvalId: string }> = [];
let mockApprovalsError = false;
vi.mock('@/layers/features/approvals', () => ({
  ApprovalList: ({ approvals }: { approvals: Array<{ approvalId: string }> }) => (
    <div data-testid="approval-list">{approvals.length} cards</div>
  ),
  ApprovalsUnavailable: () => <div data-testid="approvals-unavailable">unavailable</div>,
  usePendingApprovals: () => ({
    approvals: mockPendingApprovals,
    isLoading: false,
    isError: mockApprovalsError,
    retry: vi.fn(),
  }),
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
  useAgentProfileShortcut: () => {},
  RIGHT_PANEL_GROUP_ID: 'app-shell-right-panel',
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
      'swaps ONLY the body — header block and footer strip stay mounted (zones present: %s)',
      (zones) => {
        mockZonesPresent = zones;

        // Before: the roster, with the chrome around it.
        mockPathname = '/';
        renderAppShell();
        expect(screen.getByTestId('dashboard-sidebar')).toBeInTheDocument();
        expect(screen.getByTestId('sidebar-nav-header')).toBeInTheDocument();
        expect(screen.getByTestId('sidebar-footer-bar')).toBeInTheDocument();
        cleanup();

        // After: the body is gone, the chrome is not.
        mockPathname = '/marketplace';
        renderAppShell();
        expect(screen.getByTestId('marketplace-sidebar-fake')).toBeInTheDocument();
        expect(screen.queryByTestId('dashboard-sidebar')).not.toBeInTheDocument();
        expect(screen.getByTestId('sidebar-nav-header')).toBeInTheDocument();
        expect(screen.getByTestId('sidebar-footer-bar')).toBeInTheDocument();
      }
    );

    it('keeps the header block outside the swap region, not merely on screen', () => {
      // The distinction that matters: a header INSIDE the animated body would
      // still be present on the roster route and would vanish with it on a
      // takeover. This asserts the structural fact instead.
      mockPathname = '/';
      renderAppShell();
      const swap = screen.getByTestId('sidebar-body-swap');
      expect(swap).not.toContainElement(screen.getByTestId('sidebar-nav-header'));
      expect(swap).toContainElement(screen.getByTestId('dashboard-sidebar'));
    });

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

        // The shell survives: chrome, header, and footer all still render, and
        // the sidebar body area shows the boundary's inline fallback instead of
        // the whole app being replaced by the router's error component.
        expect(screen.getByTestId('app-shell')).toBeInTheDocument();
        expect(screen.getByTestId('marketplace-header')).toBeInTheDocument();
        expect(screen.getByTestId('sidebar-footer-bar')).toBeInTheDocument();
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
    it('renders SidebarFooterBar regardless of route', () => {
      mockPathname = '/';
      renderAppShell();
      expect(screen.getByTestId('sidebar-footer-bar')).toBeInTheDocument();

      cleanup();

      mockPathname = '/session';
      renderAppShell();
      expect(screen.getByTestId('sidebar-footer-bar')).toBeInTheDocument();
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
