// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
// The Security panel carries the standing-permissions block, which subscribes to
// the global event stream. This suite mounts the dialog without the app shell,
// so there is no provider — stubbing the subscription keeps the suite about the
// dialog instead of about the stream (same treatment as `SecurityPanel.test`).
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn() };
});

import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { SettingsDialog } from '../ui/SettingsDialog';

// Mock useIsMobile to always return false (desktop dialog)
vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({
  useIsMobile: () => false,
}));

// Mock TunnelDialog to avoid router dependency
vi.mock('../ui/TunnelDialog', () => ({
  TunnelDialog: () => null,
}));

// Mock AdvancedTab to avoid transport dependency in SettingsDialog tests
vi.mock('../ui/AdvancedTab', () => ({
  AdvancedTab: () => <div data-testid="advanced-tab">Advanced</div>,
}));

// Mock ServerRestartOverlay to avoid transport dependency in SettingsDialog tests
vi.mock('../ui/ServerRestartOverlay', () => ({
  ServerRestartOverlay: () => null,
}));

// Mock the URL deep-link hook — these tests don't mount a RouterProvider and
// exercise tab navigation via clicks rather than URL signals. URL-driven
// behavior is covered by `use-dialog-deep-link.test.tsx` and
// `DialogHost.test.tsx`.
// The tab is a mutable box rather than a fixed `null` so one test can exercise
// the URL path: `?settings=experiments` has to land on the Experiments panel,
// and the only thing that can go wrong there is the tab id in `SETTINGS_TABS`
// drifting from the id links are minted with (DOR-1304).
const deepLink = vi.hoisted(() => ({ tab: null as string | null }));
vi.mock('@/layers/shared/model/use-dialog-deep-link', () => ({
  useSettingsDeepLink: () => ({
    isOpen: false,
    activeTab: deepLink.tab,
    section: null,
    open: vi.fn(),
    close: vi.fn(),
    setTab: vi.fn(),
    setSection: vi.fn(),
  }),
}));

// Mock Radix dialog portal to render inline
vi.mock('@radix-ui/react-dialog', async () => {
  const actual =
    await vi.importActual<typeof import('@radix-ui/react-dialog')>('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

beforeAll(() => {
  // matchMedia mock for useTheme
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

afterEach(() => {
  deepLink.tab = null;
  cleanup();
});

const mockConfig = {
  version: '1.0.0',
  port: 4242,
  uptime: 8130,
  workingDirectory: '/home/user/project',
  nodeVersion: 'v20.11.0',
  claudeCliPath: '/usr/local/bin/claude',
  boundary: '/home/user',
  dorkHome: '/home/user/.dork',
  experiments: [
    {
      key: 'runtimes.claudeCode.persistentSession',
      title: 'Keep agents warm between messages',
      description: 'Your agent stays running between messages.',
      costNote: 'Keeps up to about 1 GB of memory per warm agent.',
      enabled: false,
      lockedByEnv: false,
    },
  ],
  tunnel: {
    enabled: true,
    connected: true,
    url: 'https://abc123.ngrok.io',
    authEnabled: false,
    tokenConfigured: true,
  },
};

function createSettingsTransport(configOverrides?: Partial<typeof mockConfig>): Transport {
  return createMockTransport({
    getConfig: vi.fn().mockResolvedValue({ ...mockConfig, ...configOverrides }),
  });
}

function createWrapper(transport?: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const t = transport || createSettingsTransport();
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={t}>
        {/* The app mounts one of these at the shell; the Runtimes cards use
            tooltips and throw without it. */}
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** Click a sidebar navigation item by name to switch panels. */
function navigateTo(name: RegExp | string) {
  const tab = screen.getByRole('tab', { name });
  fireEvent.click(tab);
}

describe('SettingsDialog', () => {
  // Verifies the dialog renders with the correct title
  it('renders with "Settings" title when open', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    expect(screen.getByText('Settings')).toBeDefined();
  });

  // Verifies appearance controls are visible on the default tab
  it('displays appearance controls on the default tab', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    expect(screen.getByText('Theme')).toBeDefined();
    expect(screen.getByText('Font size')).toBeDefined();
    expect(screen.getByText('Font family')).toBeDefined();
  });

  // Verifies preference controls are visible after navigating
  it('displays preference controls when navigating to Preferences', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(/preferences/i);
    expect(screen.getByText('Show timestamps')).toBeDefined();
    expect(screen.getByText('Expand tool calls')).toBeDefined();
    expect(screen.getByText('Show dev tools')).toBeDefined();
  });

  // Verifies server config section appears with fetched data
  it('displays server configuration after loading', async () => {
    const transport = createSettingsTransport();
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, {
      wrapper: createWrapper(transport),
    });
    navigateTo(/server/i);
    const version = await screen.findByText('1.0.0');
    expect(version).toBeDefined();
    // The port is reported as the address you can act on, not as a bare number:
    // a standalone "Port 4242" row told a desktop user nothing they could copy
    // into an MCP client or a browser.
    expect(screen.getByText('http://localhost:4242')).toBeDefined();
    expect(screen.getByText('/home/user/project')).toBeDefined();
  });

  // Verifies server tab shows endpoint and directory info
  it('shows the address, the MCP endpoint, and the data directory in the server tab', async () => {
    const transport = createSettingsTransport();
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, {
      wrapper: createWrapper(transport),
    });
    navigateTo(/server/i);
    expect(await screen.findByText('http://localhost:4242')).toBeDefined();
    expect(screen.getByText('http://localhost:4242/mcp')).toBeDefined();
    expect(screen.getByText('/home/user/.dork')).toBeDefined();
  });

  // Verifies the dialog content is not rendered when closed
  it('does not render content when closed', () => {
    render(<SettingsDialog open={false} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    expect(screen.queryByText('Settings')).toBeNull();
  });

  // Verifies uptime is formatted in human-readable form
  it('formats uptime as human-readable string', async () => {
    const transport = createSettingsTransport({ uptime: 8130 });
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, {
      wrapper: createWrapper(transport),
    });
    navigateTo(/server/i);
    // 8130s = 2h 15m 30s
    const uptime = await screen.findByText('2h 15m 30s');
    expect(uptime).toBeDefined();
  });

  // Verifies sidebar navigation items render correctly (built-in tabs only —
  // the Extensions tab arrives through the settings.tabs slot, unmounted here).
  it('renders the built-in sidebar items and drops the retired Integrations and Agents tabs', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    expect(screen.getByRole('tab', { name: /appearance/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /preferences/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /server/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /tools/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /^runtimes/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /security/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /privacy & data/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /advanced/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /experiments/i })).toBeDefined();
    // The two deleted tabs are gone.
    expect(screen.queryByRole('tab', { name: /integrations/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /^agents$/i })).toBeNull();
  });

  // The staging area for flags that ship OFF (DOR-1304). Reachable by click and
  // by link, because a flag nobody can reach is a flag that never graduates.
  it('shows the Experiments panel when its tab is clicked', async () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(/experiments/i);
    expect(
      await screen.findByRole('switch', { name: /keep agents warm between messages/i })
    ).toBeDefined();
    expect(screen.getByText(/Each one graduates or goes away\./)).toBeDefined();
  });

  it('opens straight onto Experiments from ?settings=experiments', async () => {
    deepLink.tab = 'experiments';
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    // The panel, not just a selected tab: an id that did not match any tab would
    // fall back to `defaultTab` (Appearance) and still show a selected sidebar
    // item somewhere.
    expect(
      await screen.findByRole('switch', { name: /keep agents warm between messages/i })
    ).toBeDefined();
    expect(screen.queryByText('Font family')).toBeNull();
  });

  // Verifies the grouped-nav section headers render in the sidebar. Scoped to the
  // section-header slot because some group names ("System") also occur as ordinary
  // content elsewhere (the theme selector's "System" option).
  it('renders grouped-nav section headers', () => {
    const { container } = render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, {
      wrapper: createWrapper(),
    });
    const headers = Array.from(
      container.querySelectorAll('[data-slot="navigation-layout-section-header"]')
    ).map((el) => el.textContent);
    expect(headers).toEqual(['Agents & sessions', 'Access & privacy', 'System']);
  });

  // Verifies font family selector appears in the Appearance tab
  it('displays font family selector in Appearance tab', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    expect(screen.getByText('Font family')).toBeDefined();
    expect(screen.getByText('Choose the typeface for the interface')).toBeDefined();
  });

  // Verifies Theme and Font size are in Appearance tab alongside Font family
  it('displays Theme, Font family, and Font size in Appearance tab', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    expect(screen.getByText('Theme')).toBeDefined();
    expect(screen.getByText('Font family')).toBeDefined();
    expect(screen.getByText('Font size')).toBeDefined();
  });

  // The status bar has no Settings tab: what shows in the line is decided by the
  // promotion rules and the pins in the Session panel, next to each live value.
  it('has no Status Bar tab', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    expect(screen.queryByRole('tab', { name: /status bar/i })).toBeNull();
  });

  // Verifies server tab content is accessible
  it('navigates to Server and shows config', async () => {
    const transport = createSettingsTransport();
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, {
      wrapper: createWrapper(transport),
    });
    navigateTo(/server/i);
    await screen.findByText(/version/i);
  });

  it('renders "Notification sound" toggle in Preferences', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(/preferences/i);
    expect(screen.getByText('Notification sound')).toBeDefined();
    expect(
      screen.getByText('Play a sound when AI finishes responding (3s+ responses)')
    ).toBeDefined();
  });

  // Verifies the Appearance tab still has its own "Reset to defaults" button (global reset)
  it('renders a "Reset to defaults" button in the Appearance tab', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    // Appearance is the default tab
    const panel = screen.getByText('Theme').closest('[data-slot="navigation-layout-panel"]')!;
    const resetBtn = panel.querySelector('button');
    expect(resetBtn?.textContent).toBe('Reset to defaults');
  });

  // The Tools reset rides the tab def's actions slot (DOR-918); nothing else
  // pins it, so deleting `actions:` from the tools tab would pass silently
  // without this.
  it('renders a "Reset to defaults" button in the Tools tab header', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(/tools/i);
    const heading = screen.getByRole('heading', { name: 'Tools' });
    const panel = heading.closest('[data-slot="navigation-layout-panel"]')!;
    const resetBtn = panel.querySelector('button');
    expect(resetBtn?.textContent).toBe('Reset to defaults');
  });

  // Verifies the Feature suggestions toggle renders in the Preferences tab
  it('renders "Feature suggestions" toggle in Preferences tab', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(/preferences/i);
    expect(screen.getByText('Feature suggestions')).toBeDefined();
    expect(
      screen.getByText('Show feature discovery cards on the dashboard and sidebar')
    ).toBeDefined();
  });

  // Verifies Feature suggestions toggle is enabled (promoEnabled defaults to true)
  it('has Feature suggestions toggle enabled by default', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(/preferences/i);
    const label = screen.getByText('Feature suggestions');
    const row = label.closest('[data-slot="field"], [class~="justify-between"]')!;
    const toggle = row.querySelector('[role="switch"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('data-state')).toBe('checked');
  });

  // Verifies Feature suggestions toggle appears between Tasks run notifications and Show dev tools
  it('positions Feature suggestions between Tasks run notifications and Show dev tools', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(/preferences/i);
    const panel = screen
      .getByText('Show timestamps')
      .closest('[data-slot="navigation-layout-panel"]')!;
    const labels = Array.from(panel.querySelectorAll('[data-slot="field-label"]')).map(
      (el) => el.textContent
    );
    const tasksIdx = labels.indexOf('Tasks run notifications');
    const promoIdx = labels.indexOf('Feature suggestions');
    const devToolsIdx = labels.indexOf('Show dev tools');
    expect(tasksIdx).toBeGreaterThanOrEqual(0);
    expect(promoIdx).toBeGreaterThan(tasksIdx);
    expect(devToolsIdx).toBeGreaterThan(promoIdx);
  });
});

/**
 * DOR-918 — the panel title belongs to the dialog, and only to the dialog.
 *
 * `TabbedDialog` draws a `NavigationLayoutPanelHeader` for every tab, so a tab
 * component that also draws its own title heading showed the same words twice,
 * a few pixels apart. The rule is one heading per panel: the dialog's. Section
 * headings inside a panel ("Background Updates", "Logging") are a different
 * string and are not what this counts.
 */
describe('SettingsDialog — one heading per panel', () => {
  const PANELS = [
    { nav: /appearance/i, title: 'Appearance' },
    { nav: /preferences/i, title: 'Preferences' },
    { nav: /^tools/i, title: 'Tools' },
    { nav: /^runtimes/i, title: 'Runtimes' },
    { nav: /security/i, title: 'Security' },
    { nav: /privacy & data/i, title: 'Privacy & Data' },
    { nav: /dorkos account/i, title: 'DorkOS account' },
    { nav: /^server/i, title: 'Server' },
  ];

  it.each(PANELS)('shows "$title" exactly once in its panel', ({ nav, title }) => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(nav);
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getAllByRole('heading', { name: title })).toHaveLength(1);
  });
});
