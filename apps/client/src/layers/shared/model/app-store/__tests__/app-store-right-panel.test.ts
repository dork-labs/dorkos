import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../app-store';

describe('RightPanelSlice', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset store to defaults
    useAppStore.setState({
      rightPanelOpen: false,
      activeRightPanelTab: null,
    });
  });

  it('setRightPanelOpen(true) updates state and writes to localStorage', () => {
    useAppStore.getState().setRightPanelOpen(true);
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
    const stored = JSON.parse(localStorage.getItem('dorkos-right-panel-state')!);
    expect(stored.open).toBe(true);
  });

  it('toggleRightPanel flips the boolean', () => {
    expect(useAppStore.getState().rightPanelOpen).toBe(false);
    useAppStore.getState().toggleRightPanel();
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
    useAppStore.getState().toggleRightPanel();
    expect(useAppStore.getState().rightPanelOpen).toBe(false);
  });

  it('setActiveRightPanelTab updates state and persists', () => {
    useAppStore.getState().setActiveRightPanelTab('canvas');
    expect(useAppStore.getState().activeRightPanelTab).toBe('canvas');
    const stored = JSON.parse(localStorage.getItem('dorkos-right-panel-state')!);
    expect(stored.activeTab).toBe('canvas');
  });

  it('loadRightPanelState hydrates from localStorage', () => {
    localStorage.setItem(
      'dorkos-right-panel-state',
      JSON.stringify({ open: true, activeTab: 'canvas' })
    );
    useAppStore.getState().loadRightPanelState();
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
    expect(useAppStore.getState().activeRightPanelTab).toBe('canvas');
  });

  it('loadRightPanelState defaults gracefully when localStorage is empty', () => {
    useAppStore.getState().loadRightPanelState();
    expect(useAppStore.getState().rightPanelOpen).toBe(false);
    expect(useAppStore.getState().activeRightPanelTab).toBeNull();
  });

  it('loadRightPanelState defaults gracefully when localStorage is corrupt', () => {
    localStorage.setItem('dorkos-right-panel-state', 'not-json');
    useAppStore.getState().loadRightPanelState();
    expect(useAppStore.getState().rightPanelOpen).toBe(false);
    expect(useAppStore.getState().activeRightPanelTab).toBeNull();
  });
});
