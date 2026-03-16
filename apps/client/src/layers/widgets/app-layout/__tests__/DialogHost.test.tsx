// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Mock all dialog components as simple markers
vi.mock('@/layers/features/settings', () => ({
  SettingsDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="settings-dialog">SettingsDialog</div> : null,
}));

vi.mock('@/layers/shared/ui', () => ({
  ResponsiveDialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div>{children}</div> : null),
  ResponsiveDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResponsiveDialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResponsiveDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResponsiveDialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResponsiveDialogFullscreenToggle: () => null,
  DirectoryPicker: ({ open }: { open: boolean }) =>
    open ? <div data-testid="directory-picker">DirectoryPicker</div> : null,
}));

vi.mock('@/layers/features/pulse', () => ({
  PulsePanel: () => <div data-testid="pulse-panel">PulsePanel</div>,
}));

vi.mock('@/layers/features/relay', () => ({
  RelayPanel: () => <div data-testid="relay-panel">RelayPanel</div>,
}));

vi.mock('@/layers/features/mesh', () => ({
  MeshPanel: () => <div data-testid="mesh-panel">MeshPanel</div>,
}));

vi.mock('@/layers/features/agent-settings', () => ({
  AgentDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="agent-dialog">AgentDialog</div> : null,
}));

vi.mock('@/layers/features/onboarding', () => ({
  OnboardingFlow: () => <div data-testid="onboarding-flow">OnboardingFlow</div>,
}));

// Mock entity hooks
vi.mock('@/layers/entities/session', () => ({
  useDirectoryState: vi.fn(() => ['/test/path', vi.fn()]),
}));

vi.mock('@/layers/entities/agent', () => ({
  useResolvedAgents: vi.fn(() => ({ data: undefined })),
}));

// Mock the Zustand store
const mockStoreState = {
  settingsOpen: false,
  setSettingsOpen: vi.fn(),
  pulseOpen: false,
  setPulseOpen: vi.fn(),
  relayOpen: false,
  setRelayOpen: vi.fn(),
  meshOpen: false,
  setMeshOpen: vi.fn(),
  pickerOpen: false,
  setPickerOpen: vi.fn(),
  agentDialogOpen: false,
  setAgentDialogOpen: vi.fn(),
  onboardingStep: null as number | null,
  setOnboardingStep: vi.fn(),
  recentCwds: [] as Array<{ path: string; accessedAt: string }>,
};

vi.mock('@/layers/shared/model', () => ({
  useAppStore: vi.fn(() => mockStoreState),
}));

import { DialogHost } from '../ui/DialogHost';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  // Reset all store values to closed/defaults
  mockStoreState.settingsOpen = false;
  mockStoreState.pulseOpen = false;
  mockStoreState.relayOpen = false;
  mockStoreState.meshOpen = false;
  mockStoreState.pickerOpen = false;
  mockStoreState.agentDialogOpen = false;
  mockStoreState.onboardingStep = null;
  mockStoreState.recentCwds = [];
});

describe('DialogHost', () => {
  it('renders no dialogs when all states are false', () => {
    render(<DialogHost />);

    expect(screen.queryByTestId('settings-dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('directory-picker')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pulse-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('relay-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mesh-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-flow')).not.toBeInTheDocument();
  });

  it('renders SettingsDialog when settingsOpen is true', () => {
    mockStoreState.settingsOpen = true;

    render(<DialogHost />);

    expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();
  });

  it('renders DirectoryPicker when pickerOpen is true', () => {
    mockStoreState.pickerOpen = true;

    render(<DialogHost />);

    expect(screen.getByTestId('directory-picker')).toBeInTheDocument();
  });

  it('renders PulsePanel when pulseOpen is true', () => {
    mockStoreState.pulseOpen = true;

    render(<DialogHost />);

    expect(screen.getByTestId('pulse-panel')).toBeInTheDocument();
  });

  it('renders RelayPanel when relayOpen is true', () => {
    mockStoreState.relayOpen = true;

    render(<DialogHost />);

    expect(screen.getByTestId('relay-panel')).toBeInTheDocument();
  });

  it('renders MeshPanel when meshOpen is true', () => {
    mockStoreState.meshOpen = true;

    render(<DialogHost />);

    expect(screen.getByTestId('mesh-panel')).toBeInTheDocument();
  });

  it('renders AgentDialog when agentDialogOpen is true', () => {
    mockStoreState.agentDialogOpen = true;

    render(<DialogHost />);

    expect(screen.getByTestId('agent-dialog')).toBeInTheDocument();
  });

  it('renders OnboardingFlow when onboardingStep is non-null', () => {
    mockStoreState.onboardingStep = 0;

    render(<DialogHost />);

    expect(screen.getByTestId('onboarding-flow')).toBeInTheDocument();
  });

  it('does not render OnboardingFlow when onboardingStep is null', () => {
    mockStoreState.onboardingStep = null;

    render(<DialogHost />);

    expect(screen.queryByTestId('onboarding-flow')).not.toBeInTheDocument();
  });

  it('renders multiple dialogs simultaneously', () => {
    mockStoreState.settingsOpen = true;
    mockStoreState.pulseOpen = true;
    mockStoreState.meshOpen = true;

    render(<DialogHost />);

    expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('pulse-panel')).toBeInTheDocument();
    expect(screen.getByTestId('mesh-panel')).toBeInTheDocument();
  });

  it('does not render AgentDialog when selectedCwd is null', async () => {
    const { useDirectoryState } = await import('@/layers/entities/session');
    vi.mocked(useDirectoryState).mockReturnValue([null as unknown as string, vi.fn()]);

    mockStoreState.agentDialogOpen = true;

    render(<DialogHost />);

    expect(screen.queryByTestId('agent-dialog')).not.toBeInTheDocument();

    // Restore default mock
    vi.mocked(useDirectoryState).mockReturnValue(['/test/path', vi.fn()]);
  });
});
