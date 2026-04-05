// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { SettingsDialog } from '../ui/SettingsDialog';

// Mock useIsMobile to always return false (desktop dialog)
vi.mock('../../../hooks/use-is-mobile', () => ({
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
      <TransportProvider transport={t}>{children}</TransportProvider>
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
    expect(screen.getByText('4242')).toBeDefined();
    expect(screen.getByText('/home/user/project')).toBeDefined();
  });

  // Verifies server tab shows endpoint and directory info
  it('shows API URL, MCP Endpoint, and Data Directory in server tab', async () => {
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

  // Verifies sidebar navigation items render correctly
  it('renders eight sidebar items: Appearance, Preferences, Status Bar, Server, Tools, Channels, Agents, Advanced', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    expect(screen.getByRole('tab', { name: /appearance/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /preferences/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /status bar/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /server/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /tools/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /channels/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /agents/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /advanced/i })).toBeDefined();
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

  // Verifies Status Bar section shows registry-driven toggle switches
  it('navigates to Status Bar and shows toggle switches', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(/status bar/i);
    // Labels come from STATUS_BAR_REGISTRY
    expect(screen.getByText('Directory')).toBeDefined();
    expect(screen.getByText('Permission Mode')).toBeDefined();
    expect(screen.getByText('Model')).toBeDefined();
    expect(screen.getByText('Cost')).toBeDefined();
    expect(screen.getByText('Context Usage')).toBeDefined();
  });

  // Verifies all 11 status bar toggles (including version, which was missing before) default to ON
  it('has all status bar toggles enabled by default', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(/status bar/i);
    const panel = screen.getByText('Directory').closest('[data-slot="navigation-layout-panel"]')!;
    const switches = panel.querySelectorAll('[role="switch"]');
    expect(switches.length).toBe(11);
    switches.forEach((sw) => {
      expect(sw.getAttribute('data-state')).toBe('checked');
    });
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

  it('displays "Show shortcut chips" toggle in Preferences', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(/preferences/i);
    expect(screen.getByText('Show shortcut chips')).toBeDefined();
    expect(screen.getByText('Display shortcut hints below the message input')).toBeDefined();
  });

  it('shows "Git Status" toggle in Status Bar', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(/status bar/i);
    expect(screen.getByText('Git Status')).toBeDefined();
    expect(screen.getByText('Branch name and change count')).toBeDefined();
  });

  it('has git status toggle enabled by default', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(/status bar/i);
    const label = screen.getByText('Git Status');
    // Traverse up to the row container — works for both the private SettingRow
    // (div.justify-between) and the Field-based shared SettingRow (data-slot="field").
    const row = label.closest('[data-slot="field"], [class~="justify-between"]')!;
    const toggle = row.querySelector('[role="switch"]');
    expect(toggle).toBeDefined();
    expect(toggle?.getAttribute('data-state')).toBe('checked');
  });

  it('has shortcut chips toggle enabled by default', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(/preferences/i);
    const label = screen.getByText('Show shortcut chips');
    // Traverse up to the row container — works for both the private SettingRow
    // (div.justify-between) and the Field-based shared SettingRow (data-slot="field").
    const row = label.closest('[data-slot="field"], [class~="justify-between"]')!;
    const toggle = row.querySelector('[role="switch"]');
    expect(toggle).toBeDefined();
    expect(toggle?.getAttribute('data-state')).toBe('checked');
  });

  it('renders "Notification sound" toggle in Preferences', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(/preferences/i);
    expect(screen.getByText('Notification sound')).toBeDefined();
    expect(
      screen.getByText('Play a sound when AI finishes responding (3s+ responses)')
    ).toBeDefined();
  });

  it('renders "Sound" toggle in Status Bar', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(/status bar/i);
    expect(screen.getByText('Sound')).toBeDefined();
    expect(screen.getByText('Notification sound toggle')).toBeDefined();
  });

  // Verifies all 9 registry items are rendered in the Status Bar tab
  it('renders all 9 registry items in the Status Bar tab', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(/status bar/i);
    const expectedLabels = [
      'Directory',
      'Git Status',
      'Model',
      'Cost',
      'Context Usage',
      'Permission Mode',
      'Sound',
      'Sync',
      'Refresh',
    ];
    for (const label of expectedLabels) {
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  // Verifies the Status Bar tab has a "Reset to defaults" button
  it('renders a "Reset to defaults" button in the Status Bar tab', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    navigateTo(/status bar/i);
    const panel = screen.getByText('Directory').closest('[data-slot="navigation-layout-panel"]')!;
    const resetBtn = panel.querySelector('button');
    expect(resetBtn?.textContent).toBe('Reset to defaults');
  });

  // Verifies the Appearance tab still has its own "Reset to defaults" button (global reset)
  it('renders a "Reset to defaults" button in the Appearance tab', () => {
    render(<SettingsDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper() });
    // Appearance is the default tab
    const panel = screen.getByText('Theme').closest('[data-slot="navigation-layout-panel"]')!;
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
    expect(toggle).toBeDefined();
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
