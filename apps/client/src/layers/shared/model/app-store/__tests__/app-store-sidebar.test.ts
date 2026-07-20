import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useAppStore } from '../app-store';

const STORAGE_KEY = 'dorkos-sidebar-active-tab';

describe('CoreSlice — sidebarActiveTab', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ sidebarActiveTab: 'overview' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists a built-in tab id to state and localStorage', () => {
    useAppStore.getState().setSidebarActiveTab('connections');
    expect(useAppStore.getState().sidebarActiveTab).toBe('connections');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('connections');
  });

  it('tolerates and persists an arbitrary (legacy namespaced) tab id', () => {
    // The store keeps whatever it is given; SessionSidebar resolves a non-built-in
    // id back to overview on read, so a leftover namespaced id survives storage.
    const legacyId = 'linear-issues:linear-loop-sidebar';
    useAppStore.getState().setSidebarActiveTab(legacyId);
    expect(useAppStore.getState().sidebarActiveTab).toBe(legacyId);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(legacyId);
  });

  it('resetPreferences returns the active tab to overview and clears storage', () => {
    useAppStore.getState().setSidebarActiveTab('linear-issues:linear-loop-sidebar');
    useAppStore.getState().resetPreferences();
    expect(useAppStore.getState().sidebarActiveTab).toBe('overview');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
