import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MAX_RIGHT_PANEL_LAYOUTS } from '@/layers/shared/lib';
import { useAppStore } from '../app-store';

/** Read the per-agent layout map from localStorage. */
function readLayouts(): Record<string, { open: boolean; activeTab: string | null }> {
  return JSON.parse(localStorage.getItem('dorkos-right-panel-layouts') || '{}');
}

describe('RightPanelSlice', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset store to defaults (detached from any agent).
    useAppStore.setState({
      rightPanelOpen: false,
      activeRightPanelTab: null,
      rightPanelLayoutKey: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Global surface (no agent in scope — non-session routes / initial mount)
  // -------------------------------------------------------------------------

  describe('global layout (no agent key)', () => {
    it('setRightPanelOpen(true) updates state and writes to global localStorage', () => {
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

    it('setActiveRightPanelTab updates state and persists globally', () => {
      useAppStore.getState().setActiveRightPanelTab('canvas');
      expect(useAppStore.getState().activeRightPanelTab).toBe('canvas');
      const stored = JSON.parse(localStorage.getItem('dorkos-right-panel-state')!);
      expect(stored.activeTab).toBe('canvas');
    });

    it('loadRightPanelState hydrates from global localStorage', () => {
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

  // -------------------------------------------------------------------------
  // Per-agent surface (DOR-227)
  // -------------------------------------------------------------------------

  describe('per-agent layout', () => {
    it('write-through: open/tab persist under the current agent key, not globally', () => {
      useAppStore.getState().loadRightPanelForAgent('agent-a');
      useAppStore.getState().setRightPanelOpen(true);
      useAppStore.getState().setActiveRightPanelTab('terminal');

      expect(readLayouts()['agent-a']).toMatchObject({ open: true, activeTab: 'terminal' });
      // Global surface is untouched while an agent is in scope.
      expect(localStorage.getItem('dorkos-right-panel-state')).toBeNull();
    });

    it('hydrates open + active tab when binding to an agent with a stored layout', () => {
      localStorage.setItem(
        'dorkos-right-panel-layouts',
        JSON.stringify({ 'agent-a': { open: true, activeTab: 'files', accessedAt: 1 } })
      );
      useAppStore.getState().loadRightPanelForAgent('agent-a');
      expect(useAppStore.getState().rightPanelOpen).toBe(true);
      expect(useAppStore.getState().activeRightPanelTab).toBe('files');
    });

    it('a never-seen agent starts closed with no active tab', () => {
      useAppStore.getState().loadRightPanelForAgent('brand-new-agent');
      expect(useAppStore.getState().rightPanelOpen).toBe(false);
      expect(useAppStore.getState().activeRightPanelTab).toBeNull();
    });

    it('restores each agent independently across A → B → A switches', () => {
      // Agent A: open, terminal.
      useAppStore.getState().loadRightPanelForAgent('agent-a');
      useAppStore.getState().setRightPanelOpen(true);
      useAppStore.getState().setActiveRightPanelTab('terminal');

      // Agent B: closed, canvas.
      useAppStore.getState().loadRightPanelForAgent('agent-b');
      expect(useAppStore.getState().rightPanelOpen).toBe(false);
      useAppStore.getState().setActiveRightPanelTab('canvas');

      // Back to A restores open + terminal.
      useAppStore.getState().loadRightPanelForAgent('agent-a');
      expect(useAppStore.getState().rightPanelOpen).toBe(true);
      expect(useAppStore.getState().activeRightPanelTab).toBe('terminal');

      // And B kept its own layout.
      useAppStore.getState().loadRightPanelForAgent('agent-b');
      expect(useAppStore.getState().rightPanelOpen).toBe(false);
      expect(useAppStore.getState().activeRightPanelTab).toBe('canvas');
    });

    it('open/closed round-trips for the same agent', () => {
      useAppStore.getState().loadRightPanelForAgent('agent-a');
      useAppStore.getState().setRightPanelOpen(true);
      useAppStore.getState().loadRightPanelForAgent('agent-b');
      useAppStore.getState().loadRightPanelForAgent('agent-a');
      expect(useAppStore.getState().rightPanelOpen).toBe(true);

      useAppStore.getState().setRightPanelOpen(false);
      useAppStore.getState().loadRightPanelForAgent('agent-b');
      useAppStore.getState().loadRightPanelForAgent('agent-a');
      expect(useAppStore.getState().rightPanelOpen).toBe(false);
    });

    it('uses a cwd string as the key when an agent has no id (fallback key)', () => {
      // The hook keys by `agent?.id ?? cwd`; the store treats any string key
      // identically, so a cwd fallback round-trips like an agent id.
      const cwd = '/Users/dev/projects/untracked';
      useAppStore.getState().loadRightPanelForAgent(cwd);
      useAppStore.getState().setRightPanelOpen(true);
      useAppStore.getState().setActiveRightPanelTab('agent-hub');

      useAppStore.getState().loadRightPanelForAgent('other');
      useAppStore.getState().loadRightPanelForAgent(cwd);
      expect(useAppStore.getState().rightPanelOpen).toBe(true);
      expect(useAppStore.getState().activeRightPanelTab).toBe('agent-hub');
    });

    it('detaching with a null key leaves in-memory state untouched (no flash)', () => {
      useAppStore.getState().loadRightPanelForAgent('agent-a');
      useAppStore.getState().setRightPanelOpen(true);
      useAppStore.getState().setActiveRightPanelTab('terminal');

      useAppStore.getState().loadRightPanelForAgent(null);
      expect(useAppStore.getState().rightPanelLayoutKey).toBeNull();
      expect(useAppStore.getState().rightPanelOpen).toBe(true);
      expect(useAppStore.getState().activeRightPanelTab).toBe('terminal');
    });

    it('LRU-evicts the least-recently-used agent past the cap', () => {
      // Monotonic clock so recency is strictly ordered — real navigation is
      // spaced in time; a same-millisecond test loop would tie accessedAt.
      let now = 1_000;
      vi.spyOn(Date, 'now').mockImplementation(() => (now += 1));

      // Fill one past the cap, each write bumping recency.
      for (let i = 0; i <= MAX_RIGHT_PANEL_LAYOUTS; i++) {
        useAppStore.getState().loadRightPanelForAgent(`agent-${i}`);
        useAppStore.getState().setRightPanelOpen(true);
      }
      const layouts = readLayouts();
      expect(Object.keys(layouts)).toHaveLength(MAX_RIGHT_PANEL_LAYOUTS);
      // The first-written (least-recently-used) agent was evicted; newest survives.
      expect(layouts['agent-0']).toBeUndefined();
      expect(layouts[`agent-${MAX_RIGHT_PANEL_LAYOUTS}`]).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Auto-select vs explicit pick (the container's view-only fallback)
  // -------------------------------------------------------------------------

  describe('auto-select fallback vs explicit pick', () => {
    it('setActiveRightPanelTabView updates the view WITHOUT persisting', () => {
      useAppStore.getState().loadRightPanelForAgent('agent-a');
      useAppStore.getState().setRightPanelOpen(true);
      useAppStore.getState().setActiveRightPanelTab('terminal');

      // Simulate the container auto-selecting a fallback tab (terminal hidden).
      useAppStore.getState().setActiveRightPanelTabView('canvas');
      expect(useAppStore.getState().activeRightPanelTab).toBe('canvas');
      // Stored preference is untouched — terminal returns when it is available.
      expect(readLayouts()['agent-a'].activeTab).toBe('terminal');
    });

    it('open/close after an auto-select does not clobber the stored tab preference', () => {
      useAppStore.getState().loadRightPanelForAgent('agent-a');
      useAppStore.getState().setRightPanelOpen(true);
      useAppStore.getState().setActiveRightPanelTab('terminal');

      // Auto-select changes the in-memory tab, then the user toggles the panel.
      useAppStore.getState().setActiveRightPanelTabView('canvas');
      useAppStore.getState().setRightPanelOpen(false);

      // Only `open` changed in storage; the tab preference stayed terminal.
      expect(readLayouts()['agent-a']).toMatchObject({ open: false, activeTab: 'terminal' });
    });

    it('an explicit tab pick DOES update the stored preference', () => {
      useAppStore.getState().loadRightPanelForAgent('agent-a');
      useAppStore.getState().setRightPanelOpen(true);
      useAppStore.getState().setActiveRightPanelTab('terminal');

      useAppStore.getState().setActiveRightPanelTab('files');
      expect(readLayouts()['agent-a'].activeTab).toBe('files');
    });
  });
});
