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
  PermissionBanner: () => null,
  DialogHost: () => null,
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

let mockSidebarLevel: 'dashboard' | 'session' = 'dashboard';

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
      sidebarLevel: mockSidebarLevel,
      setSidebarLevel: vi.fn((level: string) => {
        mockSidebarLevel = level as 'dashboard' | 'session';
      }),
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
    mockSidebarLevel = 'dashboard';
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

    it('renders DashboardSidebar at /session by default', () => {
      mockPathname = '/session';
      mockSidebarLevel = 'dashboard';
      renderAppShell();
      expect(screen.getByTestId('dashboard-sidebar')).toBeInTheDocument();
      expect(screen.queryByTestId('session-sidebar')).not.toBeInTheDocument();
    });

    it('renders SessionSidebar at /session when drilled into session level', () => {
      mockPathname = '/session';
      mockSidebarLevel = 'session';
      renderAppShell();
      expect(screen.getByTestId('session-sidebar')).toBeInTheDocument();
      expect(screen.queryByTestId('dashboard-sidebar')).not.toBeInTheDocument();
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

    it('does not hijack the session sidebar', () => {
      mockPathname = '/session';
      mockSidebarLevel = 'session';
      renderAppShell();
      expect(screen.getByTestId('session-sidebar')).toBeInTheDocument();
      expect(screen.queryByTestId('marketplace-sidebar-fake')).not.toBeInTheDocument();
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
