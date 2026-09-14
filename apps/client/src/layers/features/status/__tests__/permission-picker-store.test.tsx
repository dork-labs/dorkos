// @vitest-environment jsdom
/**
 * The picker publishes whether it is on screen, so a surface that offers a way
 * into it can tell the difference between "one tap away" and "not rendered"
 * (DOR-2019 review).
 *
 * This is the half a DOM click could never get right. `applyStatusBudget` does
 * not hide an item that does not fit — it drops it from the array — so at a
 * phone's two-or-three-item budget the permission trigger is simply absent, and
 * `querySelector(...)?.click()` is a button that does nothing. The two states
 * that render no popover at all are asserted here alongside the mounted one.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

const mockCaps = vi.fn<(runtime: string | null | undefined) => RuntimeCapabilities | undefined>();
vi.mock('@/layers/entities/runtime', () => ({
  useCapabilitiesForRuntime: (runtime: string | null | undefined) => mockCaps(runtime),
}));

// The popover shell only. Everything inside it is the real component, and the
// shell reports the `open` it was handed so the store's control of it is visible.
vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ResponsivePopover: ({
      children,
      open,
      onOpenChange,
    }: {
      children: React.ReactNode;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) => (
      <div data-testid="popover-root" data-open={open === true ? 'yes' : 'no'}>
        {/* Stands in for the shell's own dismissal (an outside click, Escape).
            Without it nothing in this file ever drives `onOpenChange`, and the
            round trip back out of the store would be untested. */}
        <button data-testid="popover-shell-close" onClick={() => onOpenChange?.(false)}>
          close
        </button>
        {children}
      </div>
    ),
    ResponsivePopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ResponsivePopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ResponsivePopoverTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

import { PermissionModeItem } from '../ui/PermissionModeItem';
import { useSessionPermissionPicker } from '../model/permission-picker-store';

/** Codex's shape, enough of it for the picker to render its dial. */
const CODEX = {
  type: 'codex',
  permissionModes: {
    supported: true,
    default: 'default',
    values: [
      {
        id: 'default',
        label: 'Read only',
        stop: 'ask' as const,
        asks: 'never' as const,
        reach: 'read' as const,
        promise: 'Codex can read files but not change them.',
      },
    ],
  },
} as unknown as RuntimeCapabilities;

/** A runtime with no notion of a permission mode: the picker draws nothing. */
const NO_MODES = {
  type: 'toy',
  permissionModes: { supported: false, values: [] },
} as unknown as RuntimeCapabilities;

beforeEach(() => {
  act(() => {
    useSessionPermissionPicker.setState({ available: false, open: false });
  });
  mockCaps.mockReturnValue(CODEX);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the picker publishes whether it is reachable', () => {
  it('says available while an interactive picker is mounted', () => {
    render(<PermissionModeItem mode="default" onChangeMode={() => {}} runtime="codex" />);
    expect(screen.getByTestId('permission-mode-trigger')).toBeInTheDocument();
    expect(useSessionPermissionPicker.getState().available).toBe(true);
  });

  it('says unavailable once it unmounts — the status budget dropping it', () => {
    const { unmount } = render(
      <PermissionModeItem mode="default" onChangeMode={() => {}} runtime="codex" />
    );
    expect(useSessionPermissionPicker.getState().available).toBe(true);
    unmount();
    expect(useSessionPermissionPicker.getState().available).toBe(false);
  });

  it('says unavailable while it is disabled — a session with no first turn', () => {
    render(<PermissionModeItem mode="default" onChangeMode={() => {}} runtime="codex" disabled />);
    expect(useSessionPermissionPicker.getState().available).toBe(false);
  });

  it('says unavailable for a runtime that declares no permission modes', () => {
    mockCaps.mockReturnValue(NO_MODES);
    render(<PermissionModeItem mode="default" onChangeMode={() => {}} runtime="toy" />);
    expect(screen.queryByTestId('permission-mode-trigger')).not.toBeInTheDocument();
    expect(useSessionPermissionPicker.getState().available).toBe(false);
  });

  it('shuts the panel when it goes away, so no request outlives its picker', () => {
    const { unmount } = render(
      <PermissionModeItem mode="default" onChangeMode={() => {}} runtime="codex" />
    );
    act(() => {
      useSessionPermissionPicker.getState().setOpen(true);
    });
    expect(screen.getByTestId('popover-root')).toHaveAttribute('data-open', 'yes');
    unmount();
    expect(useSessionPermissionPicker.getState().open).toBe(false);
  });

  it('opens from the store, with nobody clicking the trigger', () => {
    render(<PermissionModeItem mode="default" onChangeMode={() => {}} runtime="codex" />);
    expect(screen.getByTestId('popover-root')).toHaveAttribute('data-open', 'no');
    act(() => {
      useSessionPermissionPicker.getState().setOpen(true);
    });
    expect(screen.getByTestId('popover-root')).toHaveAttribute('data-open', 'yes');
  });

  it('writes a shell-driven close back to the store AND to the caller', async () => {
    // The offer under the dial has two homes and the caller picks between them
    // off this callback (`ChatStatusSection`'s `pickerOpen`); routing open state
    // through the store must not take it away. And a dismissal the shell owns —
    // an outside click, Escape — has to reach the store, or it would go on
    // believing the panel is up.
    const onOpenChange = vi.fn();
    render(
      <PermissionModeItem
        mode="default"
        onChangeMode={() => {}}
        runtime="codex"
        onOpenChange={onOpenChange}
      />
    );
    act(() => {
      useSessionPermissionPicker.getState().setOpen(true);
    });
    await userEvent.click(screen.getByTestId('popover-shell-close'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(useSessionPermissionPicker.getState().open).toBe(false);
    expect(screen.getByTestId('popover-root')).toHaveAttribute('data-open', 'no');
  });
});
