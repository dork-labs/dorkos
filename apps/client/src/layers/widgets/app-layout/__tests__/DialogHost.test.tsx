// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useEffect, type ComponentType } from 'react';

// --- Test wrapper components that simulate the real wrappers ---

function MockSettingsWrapper({ open }: { open: boolean }) {
  return open ? <div data-testid="settings-dialog">SettingsDialog</div> : null;
}

function MockDirectoryPickerWrapper({ open }: { open: boolean }) {
  return open ? <div data-testid="directory-picker">DirectoryPicker</div> : null;
}

function MockTasksWrapper({ open }: { open: boolean }) {
  return open ? <div data-testid="tasks-panel">TasksPanel</div> : null;
}

function MockRelayWrapper({ open }: { open: boolean }) {
  return open ? <div data-testid="relay-panel">RelayPanel</div> : null;
}

let mockSelectedCwd: string | null = '/test/path';

// --- Dialog contributions matching the real DIALOG_CONTRIBUTIONS shape ---

// Matches the real `DialogContribution['urlParam']` union — keeps `vi.mocked()`
// happy without importing the type across the mock boundary.
type DialogUrlParam = 'settings' | 'tasks' | 'relay';

const mockDialogContributions: Array<{
  id: string;
  component: ComponentType<{ open: boolean; onOpenChange: (open: boolean) => void }>;
  openStateKey: string;
  priority: number;
  urlParam?: DialogUrlParam;
}> = [
  {
    id: 'settings',
    component: MockSettingsWrapper,
    openStateKey: 'settingsOpen',
    priority: 1,
    urlParam: 'settings',
  },
  {
    id: 'directory-picker',
    component: MockDirectoryPickerWrapper,
    openStateKey: 'pickerOpen',
    priority: 2,
    // Intentionally no `urlParam` — drives the "contribution.urlParam is undefined" case.
  },
  {
    id: 'tasks',
    component: MockTasksWrapper,
    openStateKey: 'tasksOpen',
    priority: 3,
    urlParam: 'tasks',
  },
  {
    id: 'relay',
    component: MockRelayWrapper,
    openStateKey: 'relayOpen',
    priority: 4,
    urlParam: 'relay',
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
  tasksOpen: false,
  setTasksOpen: vi.fn(),
  relayOpen: false,
  setRelayOpen: vi.fn(),
  pickerOpen: false,
  setPickerOpen: vi.fn(),
  onboardingStep: null as number | null,
  setOnboardingStep: vi.fn(),
};

// Inert URL deep-link hooks — test contributions don't declare `urlParam`, so
// `useDialogUrlSignal` always falls through to the `default` branch anyway.
// These mocks only need to exist so the hook call sites don't explode.
// (Factory is hoisted by vi.mock, so the stub is defined inline.)
vi.mock('@/layers/shared/model', () => {
  const inertDeepLink = () => ({ isOpen: false, close: vi.fn(), open: vi.fn() });
  return {
    useAppStore: vi.fn((selector?: (state: Record<string, unknown>) => unknown) => {
      if (typeof selector === 'function') return selector(mockStoreState);
      return mockStoreState;
    }),
    useSlotContributions: vi.fn(() => mockDialogContributions),
    useSettingsDeepLink: vi.fn(inertDeepLink),
    useTasksDeepLink: vi.fn(inertDeepLink),
    useRelayDeepLink: vi.fn(inertDeepLink),
  };
});

import { DialogHost } from '../ui/DialogHost';
import { useSettingsDeepLink, useTasksDeepLink, useRelayDeepLink } from '@/layers/shared/model';

// Build an inert deep-link return value for per-test reset. Factored here (not
// hoisted into the vi.mock factory) so tests can also use it as a default.
function inertDeepLinkReturn() {
  return { isOpen: false, close: vi.fn(), open: vi.fn() };
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  // Reset all store values to closed/defaults
  mockStoreState.settingsOpen = false;
  mockStoreState.tasksOpen = false;
  mockStoreState.relayOpen = false;
  mockStoreState.pickerOpen = false;
  mockStoreState.onboardingStep = null;
  mockSelectedCwd = '/test/path';

  // Reset deep-link hook mocks to inert defaults. Individual tests override
  // with `vi.mocked(useXxxDeepLink).mockReturnValue(...)` as needed.
  vi.mocked(useSettingsDeepLink).mockReturnValue(
    inertDeepLinkReturn() as unknown as ReturnType<typeof useSettingsDeepLink>
  );
  vi.mocked(useTasksDeepLink).mockReturnValue(
    inertDeepLinkReturn() as unknown as ReturnType<typeof useTasksDeepLink>
  );
  vi.mocked(useRelayDeepLink).mockReturnValue(
    inertDeepLinkReturn() as unknown as ReturnType<typeof useRelayDeepLink>
  );
});

describe('DialogHost', () => {
  it('renders no dialogs when all states are false', () => {
    render(<DialogHost />);

    expect(screen.queryByTestId('settings-dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('directory-picker')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tasks-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('relay-panel')).not.toBeInTheDocument();
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

  it('renders TasksPanel when tasksOpen is true', () => {
    mockStoreState.tasksOpen = true;

    render(<DialogHost />);

    expect(screen.getByTestId('tasks-panel')).toBeInTheDocument();
  });

  it('renders RelayPanel when relayOpen is true', () => {
    mockStoreState.relayOpen = true;

    render(<DialogHost />);

    expect(screen.getByTestId('relay-panel')).toBeInTheDocument();
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
    mockStoreState.tasksOpen = true;

    render(<DialogHost />);

    expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('tasks-panel')).toBeInTheDocument();
  });
});

describe('RegistryDialog with urlParam', () => {
  it('opens when URL param is set', () => {
    // Store flag is false, URL signal reports open — dialog should render.
    vi.mocked(useSettingsDeepLink).mockReturnValue({
      isOpen: true,
      close: vi.fn(),
      open: vi.fn(),
    } as unknown as ReturnType<typeof useSettingsDeepLink>);

    render(<DialogHost />);

    expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();
  });

  it('opens when store flag is set', () => {
    // URL signal is inert (reset in beforeEach) — store flag alone should open.
    mockStoreState.settingsOpen = true;

    render(<DialogHost />);

    expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();
  });

  it('opens when both are set', () => {
    mockStoreState.settingsOpen = true;
    vi.mocked(useSettingsDeepLink).mockReturnValue({
      isOpen: true,
      close: vi.fn(),
      open: vi.fn(),
    } as unknown as ReturnType<typeof useSettingsDeepLink>);

    render(<DialogHost />);

    // Only one instance even though both signals are active.
    expect(screen.getAllByTestId('settings-dialog')).toHaveLength(1);
  });

  it('closing the dialog clears both URL and store', () => {
    const closeUrl = vi.fn();
    const setSettingsOpen = vi.fn();
    mockStoreState.setSettingsOpen = setSettingsOpen;
    mockStoreState.settingsOpen = true;
    vi.mocked(useSettingsDeepLink).mockReturnValue({
      isOpen: true,
      close: closeUrl,
      open: vi.fn(),
    } as unknown as ReturnType<typeof useSettingsDeepLink>);

    // Render a capturing wrapper that lets us invoke onOpenChange(false).
    // Capture via `useEffect` to keep the render function pure (satisfies
    // the react-hooks immutability lint rule).
    const handleRef: { current: ((open: boolean) => void) | null } = { current: null };
    function CapturingSettingsWrapper({
      open,
      onOpenChange,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }) {
      useEffect(() => {
        handleRef.current = onOpenChange;
      }, [onOpenChange]);
      return open ? <div data-testid="settings-dialog">SettingsDialog</div> : null;
    }

    // Swap in the capturing wrapper for this test only.
    const originalComponent = mockDialogContributions[0].component;
    mockDialogContributions[0].component = CapturingSettingsWrapper;

    try {
      render(<DialogHost />);
      expect(handleRef.current).not.toBeNull();

      // Simulate the dialog requesting close.
      handleRef.current!(false);

      // Store setter was called with `false`.
      expect(setSettingsOpen).toHaveBeenCalledWith(false);
      // URL close was also called to clear the search param.
      expect(closeUrl).toHaveBeenCalledTimes(1);
    } finally {
      mockDialogContributions[0].component = originalComponent;
    }
  });

  it('does not read URL when contribution.urlParam is undefined', () => {
    // The directory-picker contribution has no `urlParam`. Even if every
    // deep-link hook reports `isOpen: true`, the dialog stays closed because
    // `useDialogUrlSignal` falls through to the default branch.
    const openHook = {
      isOpen: true,
      close: vi.fn(),
      open: vi.fn(),
    };
    vi.mocked(useSettingsDeepLink).mockReturnValue(
      openHook as unknown as ReturnType<typeof useSettingsDeepLink>
    );
    vi.mocked(useTasksDeepLink).mockReturnValue(
      openHook as unknown as ReturnType<typeof useTasksDeepLink>
    );
    vi.mocked(useRelayDeepLink).mockReturnValue(
      openHook as unknown as ReturnType<typeof useRelayDeepLink>
    );
    // Store flag stays false (default from beforeEach).

    render(<DialogHost />);

    // Picker has no urlParam — URL signal cannot open it.
    expect(screen.queryByTestId('directory-picker')).not.toBeInTheDocument();
  });
});
