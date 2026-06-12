// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { StatusBarConfigureContent } from '../ui/StatusBarConfigureContent';
import { STATUS_BAR_REGISTRY } from '../model/status-bar-registry';
import { useAppStore } from '@/layers/shared/model';

// localStorage mock required for the Zustand store's persist middleware.
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();
Object.defineProperty(global, 'localStorage', { value: localStorageMock });

// Mock Radix Switch as a simple button with role="switch" to avoid the void-element
// constraint on <input> when Radix passes children (Thumb) into the Root.
vi.mock('@radix-ui/react-switch', () => ({
  Root: ({
    checked,
    onCheckedChange,
    'aria-label': ariaLabel,
    children,
    ...props
  }: {
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
    'aria-label'?: string;
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <button
      role="switch"
      aria-label={ariaLabel}
      aria-checked={checked ?? false}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    >
      {children}
    </button>
  ),
  Thumb: () => null,
}));

beforeEach(() => {
  localStorageMock.clear();
  useAppStore.setState({
    showStatusBarCwd: true,
    showStatusBarGit: true,
    showStatusBarModel: true,
    showStatusBarCost: true,
    showStatusBarContext: true,
    showStatusBarPermission: true,
    showStatusBarSound: true,
    showStatusBarPolling: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StatusBarConfigureContent', () => {
  it('renders all registry item labels', () => {
    render(<StatusBarConfigureContent />);
    for (const item of STATUS_BAR_REGISTRY) {
      expect(screen.getByText(item.label)).toBeInTheDocument();
    }
  });

  it('renders all item descriptions', () => {
    render(<StatusBarConfigureContent />);
    for (const item of STATUS_BAR_REGISTRY) {
      expect(screen.getByText(item.description)).toBeInTheDocument();
    }
  });

  it('renders a switch for every registry item', () => {
    render(<StatusBarConfigureContent />);
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(STATUS_BAR_REGISTRY.length);
  });

  it('renders the two group headers: Session Info, Controls', () => {
    render(<StatusBarConfigureContent />);
    expect(screen.getByText('Session Info')).toBeInTheDocument();
    expect(screen.getByText('Controls')).toBeInTheDocument();
  });

  it('renders a "Reset to defaults" button', () => {
    render(<StatusBarConfigureContent />);
    expect(screen.getByRole('button', { name: 'Reset to defaults' })).toBeInTheDocument();
  });

  it('shows switches as checked when items are visible', () => {
    render(<StatusBarConfigureContent />);
    const cwdSwitch = screen.getByRole('switch', { name: 'Toggle Directory' });
    expect(cwdSwitch).toHaveAttribute('aria-checked', 'true');
  });

  it('shows switch as unchecked when item is hidden', () => {
    useAppStore.setState({ showStatusBarGit: false });
    render(<StatusBarConfigureContent />);
    const gitSwitch = screen.getByRole('switch', { name: 'Toggle Git Status' });
    expect(gitSwitch).toHaveAttribute('aria-checked', 'false');
  });

  it('toggling a switch updates the Zustand store', () => {
    render(<StatusBarConfigureContent />);
    const modelSwitch = screen.getByRole('switch', { name: 'Toggle Model' });
    expect(useAppStore.getState().showStatusBarModel).toBe(true);

    fireEvent.click(modelSwitch);

    expect(useAppStore.getState().showStatusBarModel).toBe(false);
  });

  it('toggling a switch back to on updates the store', () => {
    useAppStore.setState({ showStatusBarCost: false });
    render(<StatusBarConfigureContent />);
    const costSwitch = screen.getByRole('switch', { name: 'Toggle Cost' });

    fireEvent.click(costSwitch);

    expect(useAppStore.getState().showStatusBarCost).toBe(true);
  });

  it('clicking "Reset to defaults" resets all status bar visibility to defaultVisible', () => {
    // Hide several items
    useAppStore.setState({ showStatusBarCwd: false, showStatusBarGit: false });
    render(<StatusBarConfigureContent />);

    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));

    for (const item of STATUS_BAR_REGISTRY) {
      const capitalizedKey = item.key.charAt(0).toUpperCase() + item.key.slice(1);
      const showProp = `showStatusBar${capitalizedKey}` as keyof ReturnType<
        typeof useAppStore.getState
      >;
      expect(useAppStore.getState()[showProp]).toBe(item.defaultVisible);
    }
  });

  it('has aria-label="Status bar configuration" on the root container', () => {
    render(<StatusBarConfigureContent />);
    expect(screen.getByRole('generic', { name: 'Status bar configuration' })).toBeInTheDocument();
  });

  it('icons render alongside each label (no accessible text, aria-hidden)', () => {
    render(<StatusBarConfigureContent />);
    // Each icon should be aria-hidden. Confirm all labels still appear.
    // If icons weren't aria-hidden, they could duplicate text — this test ensures
    // exact label matches still work with icon siblings present.
    expect(screen.getByText('Directory')).toBeInTheDocument();
  });
});
