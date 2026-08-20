// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';

// ── Route-aware mock: control the pathname returned by useRouterState ──
//
// Mirrors apps/client/src/__tests__/app-shell-slots.test.tsx. This test proves
// PipHost survives a simulated route change, so — unlike that file — the real
// app-store is left unmocked: PipHost reads pipContent/pipGeometry off it.

let mockPathname = '/';

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
    // The phone cockpit's panels listen for a committed destination so they
    // get out of its way (P4, formerly `SidebarMobileNavigationClose`/DOR-610).
    // This suite runs at desktop width and navigates nothing, so the listener
    // is registered and never fired.
    subscribe: () => () => {},
  }),
  Outlet: () => <div data-testid="outlet">outlet</div>,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: mockPathname }),
  // The shell reads `?id=` to name the open room in the document title
  // (`useRoomDocumentTitle`). No route under test carries one.
  useSearch: () => ({}),
}));

// ── Mock child components with identifiable test markers ──

vi.mock('@/layers/features/dashboard-sidebar', async () => {
  // The zone enumeration is the REAL one: the mobile tabs widget reads it at
  // module load to derive which zones each destination draws, and the shell
  // imports that widget whatever width this suite runs at.
  const { SIDEBAR_ZONE_IDS } =
    await import('@/layers/features/dashboard-sidebar/model/build-sidebar-model');
  return {
    SIDEBAR_ZONE_IDS,
    DashboardSidebar: () => <div data-testid="dashboard-sidebar">Dashboard</div>,
    // Persistent chrome: the shell mounts it outside the `sidebar.body` swap.
    SidebarHeaderBlock: () => <div data-testid="sidebar-header-block">Header block</div>,
    SidebarFooterStrip: () => <div data-testid="sidebar-footer-strip">Footer strip</div>,
    // The phone cockpit's pieces. This suite runs at desktop width, so the
    // layout is never mounted — but the module graph is loaded either way.
    SidebarChrome: ({ children }: React.PropsWithChildren) => <>{children}</>,
    SidebarZones: () => null,
    useSidebarState: () => ({ activeTarget: null }),
    useSidebarModel: () => ({ zones: [] }),
    useAskDorkBot: () => ({ ask: vi.fn(), ready: true }),
    useLegacyPinMigration: () => {},
  };
});

vi.mock('@/layers/features/top-nav', () => ({
  SessionHeader: () => <div data-testid="session-header">Session</div>,
  DashboardHeader: () => <div data-testid="dashboard-header">Dashboard</div>,
}));

vi.mock('@/layers/widgets/app-layout', () => ({
  DialogHost: () => null,
  FeedbackDialogHost: () => null,
}));

vi.mock('@/layers/features/tours', () => ({
  TourHost: () => null,
}));

vi.mock('@/layers/widgets/app-banner', () => ({
  AppBannerSlot: () => null,
  useAppBanners: () => [],
}));

// The Inbox bell subscribes to the global event stream, which this suite
// mounts no provider for. Its placement is covered by app-shell-slots.test.tsx.
vi.mock('@/layers/widgets/inbox-bell', () => ({
  InboxBell: () => null,
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
vi.mock('@/layers/entities/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/room')>();
  return {
    ...actual,
    useRoomListStream: () => {},
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

vi.mock('@/layers/entities/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/tasks')>();
  return {
    ...actual,
    useTasksSync: () => {},
  };
});

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

describe('PIP panel route persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/';
    mockTransport = createMockTransport();
    localStorage.clear();
    act(() => {
      useAppStore.setState({ pipContent: null, pipGeometry: null });
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps the same PipHost DOM node mounted across a simulated route change', () => {
    const { rerender } = renderAppShell();

    act(() => {
      useAppStore.getState().openPip({ kind: 'demo', title: 'Route test' });
    });

    const panel = screen.getByRole('complementary');
    expect(panel).toHaveAccessibleName('Route test');

    // Simulate navigation: change the mocked route and rerender the SAME tree.
    mockPathname = '/session';
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <TransportProvider transport={mockTransport}>
          <TooltipProvider>
            <AppShell />
          </TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    );

    const panelAfterNavigation = screen.getByRole('complementary');
    expect(panelAfterNavigation).toBe(panel);
    expect(panelAfterNavigation).toHaveAccessibleName('Route test');
  });
});
