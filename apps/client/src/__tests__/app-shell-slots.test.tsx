// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';

// ── Route-aware mock: control the pathname returned by useRouterState ──

let mockPathname = '/';

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: mockPathname } }),
  Outlet: () => <div data-testid="outlet">outlet</div>,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: mockPathname }),
}));

// ── Mock child components with identifiable test markers ──

vi.mock('@/layers/features/dashboard-sidebar', () => ({
  DashboardSidebar: () => <div data-testid="dashboard-sidebar">Dashboard</div>,
}));

// AppShell no longer imports SessionSidebar (the web session drill-in was
// retired). This mock still exports it with a test marker so the tests below can
// assert it is NEVER rendered on the web shell — a regression guard that would
// fire if the drill-in were ever re-added to AppShell.
vi.mock('@/layers/features/session-list', () => ({
  SessionSidebar: () => <div data-testid="session-sidebar">New session</div>,
  SidebarFooterBar: () => <div data-testid="sidebar-footer-bar">SidebarFooterBar</div>,
}));

vi.mock('@/layers/features/top-nav', () => ({
  SessionHeader: () => <div data-testid="session-header">Session</div>,
  DashboardHeader: () => <div data-testid="dashboard-header">Dashboard</div>,
  MarketplaceHeader: () => <div data-testid="marketplace-header">Marketplace</div>,
  MarketplaceSourcesHeader: () => <div data-testid="marketplace-sources-header">Sources</div>,
  AgentsHeader: () => <div data-testid="agents-header">Agents</div>,
  ActivityHeader: () => <div data-testid="activity-header">Activity</div>,
  TasksHeader: () => <div data-testid="tasks-header">Tasks</div>,
}));

vi.mock('@/layers/widgets/app-layout', () => ({
  DialogHost: () => null,
}));

vi.mock('@/layers/widgets/app-banner', () => ({
  AppBannerSlot: () => null,
  useAppBanners: () => [],
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
    isLoading: false,
    dismiss: vi.fn(),
  }),
  OnboardingFlow: () => null,
  ProgressCard: () => null,
}));

// ── Mock entity hooks ──

vi.mock('@/layers/entities/session', () => ({
  useSessionId: () => [null, vi.fn()] as const,
  useDefaultCwd: () => {},
  useDirectoryState: () => ['/test/cwd', vi.fn()] as const,
  useGlobalSessionStream: () => {},
}));

vi.mock('@/layers/entities/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/agent')>();
  return {
    ...actual,
    useCurrentAgent: () => ({ data: null, isLoading: false }),
    useAgentVisual: () => ({ color: 'hsl(0,70%,55%)', emoji: '🤖' }),
  };
});

// AppShell mounts useCommandsSync (UX-12), useBindingsSync, and
// useRelayAdaptersSync — each subscribes via the event stream and so needs an
// EventStreamProvider. This slot test isolates AppShell and provides no such
// provider, so no-op the subscriptions here.
vi.mock('@/layers/entities/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/command')>();
  return {
    ...actual,
    useCommandsSync: () => {},
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
      setOnboardingStep: vi.fn(),
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
  });

  describe('sidebar slots', () => {
    it('renders DashboardSidebar at /', () => {
      mockPathname = '/';
      renderAppShell();
      expect(screen.getByTestId('dashboard-sidebar')).toBeInTheDocument();
      expect(screen.queryByTestId('session-sidebar')).not.toBeInTheDocument();
    });

    it('renders the DashboardSidebar roster at /session — no session drill-in', () => {
      // The web shell keeps the roster on /session; the session drill-in
      // (SessionSidebar) was retired in favor of the right-panel inspector.
      mockPathname = '/session';
      renderAppShell();
      expect(screen.getByTestId('dashboard-sidebar')).toBeInTheDocument();
      expect(screen.queryByTestId('session-sidebar')).not.toBeInTheDocument();
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
    });

    it('replaces the roster with the contributed body on /marketplace', () => {
      mockPathname = '/marketplace';
      renderAppShell();
      expect(screen.getByTestId('marketplace-sidebar-fake')).toBeInTheDocument();
      expect(screen.queryByTestId('dashboard-sidebar')).not.toBeInTheDocument();
      expect(screen.queryByTestId('session-sidebar')).not.toBeInTheDocument();
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
      // built-in roster (DashboardSidebar) and never the SessionSidebar drill-in.
      mockPathname = '/session';
      renderAppShell();
      expect(screen.getByTestId('dashboard-sidebar')).toBeInTheDocument();
      expect(screen.queryByTestId('marketplace-sidebar-fake')).not.toBeInTheDocument();
      expect(screen.queryByTestId('session-sidebar')).not.toBeInTheDocument();
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
