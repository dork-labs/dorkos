// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useAppStore,
  useExtensionRegistry,
  createInitialSlots,
  type SidebarTabContribution,
} from '@/layers/shared/model';
import { SIDEBAR_TAB_CONTRIBUTIONS } from '../sidebar-contributions';
import { useSidebarTabs } from '../use-sidebar-tabs';

const CONTRIBUTED_ID = 'linear-issues:linear-loop-sidebar';

function registerBuiltins(only?: string[]) {
  const { register } = useExtensionRegistry.getState();
  for (const tab of SIDEBAR_TAB_CONTRIBUTIONS) {
    if (!only || only.includes(tab.id)) register('sidebar.tabs', tab);
  }
}

function registerContributed(id: string = CONTRIBUTED_ID) {
  const contribution: SidebarTabContribution = {
    id,
    label: 'Linear',
    component: () => null,
    priority: 5,
  };
  act(() => {
    useExtensionRegistry.getState().register('sidebar.tabs', contribution);
  });
}

function setActive(tab: string) {
  useAppStore.setState({ sidebarActiveTab: tab, sidebarOpen: true });
}

describe('useSidebarTabs', () => {
  beforeEach(() => {
    useExtensionRegistry.setState({ slots: createInitialSlots() });
    setActive('overview');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists built-in tabs then extension contributions by priority', () => {
    registerBuiltins();
    registerContributed();

    const { result } = renderHook(() => useSidebarTabs());

    expect(result.current.visibleTabs.map((t) => t.id)).toEqual([
      'overview',
      'sessions',
      'schedules',
      'connections',
      CONTRIBUTED_ID,
    ]);
  });

  it('falls back to overview when the active id is a hidden built-in (immediately)', () => {
    // 'schedules' is active but not registered (as if filtered out) — a built-in
    // that is gone falls back with no grace period.
    setActive('schedules');
    registerBuiltins(['overview', 'sessions', 'connections']);

    renderHook(() => useSidebarTabs());

    expect(useAppStore.getState().sidebarActiveTab).toBe('overview');
  });

  it('falls back to overview when a persisted contributed id references a gone extension', () => {
    vi.useFakeTimers();
    setActive(CONTRIBUTED_ID); // extension never registers
    registerBuiltins();

    renderHook(() => useSidebarTabs());

    // Still on the (orphaned) contributed id until the grace window elapses.
    expect(useAppStore.getState().sidebarActiveTab).toBe(CONTRIBUTED_ID);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(useAppStore.getState().sidebarActiveTab).toBe('overview');
  });

  it('lands on a contributed tab that registers within the grace window (race)', () => {
    vi.useFakeTimers();
    setActive(CONTRIBUTED_ID); // switch arrives before the extension registers
    registerBuiltins();

    renderHook(() => useSidebarTabs());

    // Extension registers partway through the grace window (remount completes).
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    registerContributed();
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // Landed on the tab — the pending fallback was cancelled when it appeared.
    expect(useAppStore.getState().sidebarActiveTab).toBe(CONTRIBUTED_ID);
  });

  it('binds Cmd/Ctrl+1..4 to the four built-in tabs, ignoring higher numbers', () => {
    registerBuiltins();
    registerContributed();
    renderHook(() => useSidebarTabs());

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', metaKey: true }));
    });
    expect(useAppStore.getState().sidebarActiveTab).toBe('schedules');

    // No number selects the contributed tab (it is 5th) — Cmd+5 is a no-op.
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '5', metaKey: true }));
    });
    expect(useAppStore.getState().sidebarActiveTab).toBe('schedules');
  });
});
