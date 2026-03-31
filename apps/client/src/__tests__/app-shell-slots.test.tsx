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
}));

vi.mock('@/layers/entities/agent', () => ({
  useCurrentAgent: () => ({ data: null, isLoading: false }),
  useAgentVisual: () => ({ color: 'hsl(0,70%,55%)', emoji: '🤖' }),
}));

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
    };
    return selector ? selector(state) : state;
  },
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

    it('renders SessionSidebar at /session', () => {
      mockPathname = '/session';
      renderAppShell();
      expect(screen.getByTestId('session-sidebar')).toBeInTheDocument();
      expect(screen.queryByTestId('dashboard-sidebar')).not.toBeInTheDocument();
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
