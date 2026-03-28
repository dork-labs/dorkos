// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Mock motion
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: Record<string, unknown>) => (
      <div {...props}>{children as React.ReactNode}</div>
    ),
  },
}));

// Mock useTheme
const mockSetTheme = vi.fn();
let mockTheme = 'light';
vi.mock('@/layers/shared/model/use-theme', () => ({
  useTheme: () => ({ theme: mockTheme, setTheme: mockSetTheme }),
}));

// Mock app-store
const mockSetSettingsOpen = vi.fn();
const mockSetAgentDialogOpen = vi.fn();
const mockToggleDevtools = vi.fn();
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: () => ({
    setSettingsOpen: mockSetSettingsOpen,
    setAgentDialogOpen: mockSetAgentDialogOpen,
    devtoolsOpen: false,
    toggleDevtools: mockToggleDevtools,
  }),
}));

// Mock transport
const mockGetConfig = vi.fn();
const mockUpdateConfig = vi.fn().mockResolvedValue(undefined);
vi.mock('@/layers/shared/model/TransportContext', () => ({
  useTransport: () => ({ getConfig: mockGetConfig, updateConfig: mockUpdateConfig }),
}));

// Mock TanStack Query
let mockConfigData: Record<string, unknown> | undefined;
const mockInvalidateQueries = vi.fn();
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: () => ({ data: mockConfigData }),
    useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  };
});

// Mock extension registry — provide footer button contributions
const MockIcon = () => null;
vi.mock('@/layers/shared/model/extension-registry', () => ({
  useSlotContributions: () => [
    {
      id: 'edit-agent',
      icon: MockIcon,
      label: 'Edit Agent',
      onClick: () => mockSetAgentDialogOpen(true),
      priority: 1,
    },
    {
      id: 'settings',
      icon: MockIcon,
      label: 'Settings',
      onClick: () => mockSetSettingsOpen(true),
      priority: 2,
    },
    {
      id: 'theme',
      icon: MockIcon,
      label: 'Toggle Theme',
      onClick: () => {},
      priority: 3,
    },
    {
      id: 'devtools',
      icon: MockIcon,
      label: 'Devtools',
      onClick: () => mockToggleDevtools(),
      priority: 4,
      showInDevOnly: true,
    },
  ],
}));

// Mock version-compare — use real semver-like logic
vi.mock('@/layers/features/status', () => ({
  isNewer: (a: string, b: string) => {
    const [aMaj, aMin, aPat] = a.split('.').map(Number);
    const [bMaj, bMin, bPat] = b.split('.').map(Number);
    if (aMaj !== bMaj) return aMaj > bMaj;
    if (aMin !== bMin) return aMin > bMin;
    return aPat > bPat;
  },
  isFeatureUpdate: (latest: string, current: string) => {
    const [lMaj, lMin] = latest.split('.').map(Number);
    const [cMaj, cMin] = current.split('.').map(Number);
    return lMaj !== cMaj || lMin !== cMin;
  },
}));

import { SidebarFooterBar } from '../ui/SidebarFooterBar';

describe('SidebarFooterBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTheme = 'light';
    mockConfigData = {
      version: '1.2.3',
      latestVersion: null,
      isDevMode: false,
      dismissedUpgradeVersions: [],
    };
  });

  afterEach(() => {
    cleanup();
  });

  // --- Existing icon bar tests ---

  it('renders branding link with correct href, target, and rel', () => {
    render(<SidebarFooterBar />);

    const link = screen.getByRole('link');
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', 'https://dorkos.ai');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('calls setSettingsOpen(true) when settings button is clicked', () => {
    render(<SidebarFooterBar />);

    fireEvent.click(screen.getByLabelText('Settings'));
    expect(mockSetSettingsOpen).toHaveBeenCalledWith(true);
  });

  it('cycles theme from light to dark', () => {
    mockTheme = 'light';
    render(<SidebarFooterBar />);

    fireEvent.click(screen.getByLabelText(/Theme: light/));
    expect(mockSetTheme).toHaveBeenCalledWith('dark');
  });

  it('cycles theme from dark to system', () => {
    mockTheme = 'dark';
    render(<SidebarFooterBar />);

    fireEvent.click(screen.getByLabelText(/Theme: dark/));
    expect(mockSetTheme).toHaveBeenCalledWith('system');
  });

  it('cycles theme from system to light', () => {
    mockTheme = 'system';
    render(<SidebarFooterBar />);

    fireEvent.click(screen.getByLabelText(/Theme: system/));
    expect(mockSetTheme).toHaveBeenCalledWith('light');
  });

  it('displays the current theme in the toggle button aria-label', () => {
    mockTheme = 'dark';
    render(<SidebarFooterBar />);

    expect(screen.getByLabelText('Theme: dark. Click to cycle.')).toBeInTheDocument();
  });

  // --- Version display tests ---

  it('shows version text when config loaded', () => {
    render(<SidebarFooterBar />);

    expect(screen.getByText(/v1\.2\.3/)).toBeInTheDocument();
  });

  it('shows DEV badge in dev mode', () => {
    mockConfigData = { version: '0.0.0', isDevMode: true };
    render(<SidebarFooterBar />);

    expect(screen.getByText('DEV')).toBeInTheDocument();
    expect(screen.queryByText(/v0\.0\.0/)).not.toBeInTheDocument();
  });

  it('shows no upgrade card when no update available', () => {
    render(<SidebarFooterBar />);

    expect(screen.queryByText('New features available')).not.toBeInTheDocument();
    expect(screen.queryByText('Patch update available')).not.toBeInTheDocument();
  });

  it('shows upgrade card for feature update', () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.4.0',
      isDevMode: false,
      dismissedUpgradeVersions: [],
    };
    render(<SidebarFooterBar />);

    expect(screen.getByText('New features available')).toBeInTheDocument();
  });

  it('does not auto-show card for patch update', () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.2.4',
      isDevMode: false,
      dismissedUpgradeVersions: [],
    };
    render(<SidebarFooterBar />);

    expect(screen.queryByText('Patch update available')).not.toBeInTheDocument();
  });

  it('shows dot indicator when update available', () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.2.4',
      isDevMode: false,
      dismissedUpgradeVersions: [],
    };
    const { container } = render(<SidebarFooterBar />);

    const dot = container.querySelector('.rounded-full');
    expect(dot).toBeInTheDocument();
  });

  it('shows amber dot for feature update', () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.4.0',
      isDevMode: false,
      dismissedUpgradeVersions: [],
    };
    const { container } = render(<SidebarFooterBar />);

    const dot = container.querySelector('.bg-amber-500');
    expect(dot).toBeInTheDocument();
  });

  it('clicking version row toggles patch card', () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.2.4',
      isDevMode: false,
      dismissedUpgradeVersions: [],
    };
    render(<SidebarFooterBar />);

    // Card not shown initially
    expect(screen.queryByText('Patch update available')).not.toBeInTheDocument();

    // Click version row to open
    fireEvent.click(screen.getByRole('button', { name: /Version 1\.2\.3/ }));
    expect(screen.getByText('Patch update available')).toBeInTheDocument();

    // Click again to close
    fireEvent.click(screen.getByRole('button', { name: /Version 1\.2\.3/ }));
    expect(screen.queryByText('Patch update available')).not.toBeInTheDocument();
  });

  it('dismiss calls updateConfig and invalidates query', async () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.4.0',
      isDevMode: false,
      dismissedUpgradeVersions: [],
    };
    render(<SidebarFooterBar />);

    fireEvent.click(screen.getByLabelText('Dismiss upgrade notification'));

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      ui: { dismissedUpgradeVersions: ['1.4.0'] },
    });
  });

  it('does not show card for dismissed version', () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.4.0',
      isDevMode: false,
      dismissedUpgradeVersions: ['1.4.0'],
    };
    render(<SidebarFooterBar />);

    expect(screen.queryByText('New features available')).not.toBeInTheDocument();
  });
});
