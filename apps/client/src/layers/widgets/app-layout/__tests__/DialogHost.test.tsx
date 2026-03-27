// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ComponentType } from 'react';

// --- Test wrapper components that simulate the real wrappers ---

function MockSettingsWrapper({ open }: { open: boolean }) {
  return open ? <div data-testid="settings-dialog">SettingsDialog</div> : null;
}

function MockDirectoryPickerWrapper({ open }: { open: boolean }) {
  return open ? <div data-testid="directory-picker">DirectoryPicker</div> : null;
}

function MockPulseWrapper({ open }: { open: boolean }) {
  return open ? <div data-testid="pulse-panel">PulsePanel</div> : null;
}

function MockRelayWrapper({ open }: { open: boolean }) {
  return open ? <div data-testid="relay-panel">RelayPanel</div> : null;
}

function MockMeshWrapper({ open }: { open: boolean }) {
  return open ? <div data-testid="mesh-panel">MeshPanel</div> : null;
}

// AgentDialog conditionally renders based on selectedCwd (handled inside the wrapper)
let mockSelectedCwd: string | null = '/test/path';

function MockAgentWrapper({ open }: { open: boolean }) {
  if (!mockSelectedCwd) return null;
  return open ? <div data-testid="agent-dialog">AgentDialog</div> : null;
}

// --- Dialog contributions matching the real DIALOG_CONTRIBUTIONS shape ---

const mockDialogContributions = [
  {
    id: 'settings',
    component: MockSettingsWrapper as ComponentType<{
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }>,
    openStateKey: 'settingsOpen',
    priority: 1,
  },
  {
    id: 'directory-picker',
    component: MockDirectoryPickerWrapper as ComponentType<{
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }>,
    openStateKey: 'pickerOpen',
    priority: 2,
  },
  {
    id: 'pulse',
    component: MockPulseWrapper as ComponentType<{
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }>,
    openStateKey: 'pulseOpen',
    priority: 3,
  },
  {
    id: 'relay',
    component: MockRelayWrapper as ComponentType<{
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }>,
    openStateKey: 'relayOpen',
    priority: 4,
  },
  {
    id: 'mesh',
    component: MockMeshWrapper as ComponentType<{
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }>,
    openStateKey: 'meshOpen',
    priority: 5,
  },
  {
    id: 'agent',
    component: MockAgentWrapper as ComponentType<{
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }>,
    openStateKey: 'agentDialogOpen',
    priority: 6,
  },
];

// Mock onboarding (still hardcoded in DialogHost)
vi.mock('@/layers/features/onboarding', () => ({
  OnboardingFlow: () => <div data-testid="onboarding-flow">OnboardingFlow</div>,
}));

// --- Mock store state ---

const mockStoreState: Record<string, unknown> = {
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
};

vi.mock('@/layers/shared/model', () => ({
  useAppStore: vi.fn((selector?: (state: Record<string, unknown>) => unknown) => {
    if (typeof selector === 'function') return selector(mockStoreState);
    return mockStoreState;
  }),
  useSlotContributions: vi.fn(() => mockDialogContributions),
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
  mockSelectedCwd = '/test/path';
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

  it('does not render AgentDialog when selectedCwd is null', () => {
    mockSelectedCwd = null;
    mockStoreState.agentDialogOpen = true;

    render(<DialogHost />);

    expect(screen.queryByTestId('agent-dialog')).not.toBeInTheDocument();
  });
});
