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

  it('tolerates and persists an arbitrary extension-contributed tab id', () => {
    const contributedId = 'linear-issues:linear-loop-sidebar';
    useAppStore.getState().setSidebarActiveTab(contributedId);
    expect(useAppStore.getState().sidebarActiveTab).toBe(contributedId);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(contributedId);
  });

  it('resetPreferences returns the active tab to overview and clears storage', () => {
    useAppStore.getState().setSidebarActiveTab('linear-issues:linear-loop-sidebar');
    useAppStore.getState().resetPreferences();
    expect(useAppStore.getState().sidebarActiveTab).toBe('overview');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
