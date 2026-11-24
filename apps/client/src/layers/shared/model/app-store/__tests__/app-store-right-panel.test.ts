// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MAX_RIGHT_PANEL_LAYOUTS } from '@/layers/shared/lib/constants';
import { useAppStore } from '../app-store';

/** Read the per-agent layout map from localStorage. */
function readLayouts(): Record<string, { open: boolean; activeTab: string | null }> {
  return JSON.parse(localStorage.getItem('dorkos-right-panel-layouts-v2') || '{}');
}

describe('RightPanelSlice', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset store to defaults (detached from any agent).
    useAppStore.setState({
      panelViewPreferences: {},
      rightPanelOpen: false,
      activeRightPanelTab: null,
      rightPanelLayoutKey: null,
      requestedRightPanel: null,
      explicitAgentPath: null,
      inheritedRightPanelTab: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------------- Global surface (no
  // agent in scope — non-session routes / initial mount)
  // -------------------------------------------------------------------------

  describe('global layout (no agent key)', () => {
    it('setRightPanelOpen(true) updates state and writes to global localStorage', () => {
      useAppStore.getState().setRightPanelOpen(true);
      expect(useAppStore.getState().rightPanelOpen).toBe(true);
      const stored = JSON.parse(localStorage.getItem('dorkos-right-panel-state')!);
      expect(stored.open).toBe(true);
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

    it('loadRightPanelState defaults gracefully when localStorage is corrupt', () => {
      localStorage.setItem('dorkos-right-panel-state', 'not-json');
      useAppStore.getState().loadRightPanelState();
      expect(useAppStore.getState().rightPanelOpen).toBe(false);
      expect(useAppStore.getState().activeRightPanelTab).toBeNull();
    });

    describe('the pre-DOR-2579 per-agent map', () => {
      const LEGACY = 'dorkos-right-panel-layouts';

      it('moves open layouts to the new key and drops closed ones', () => {
        // A closed entry there is usually the old switch bug, not a choice.
        localStorage.setItem(
          LEGACY,
          JSON.stringify({
            'agent-a': { open: true, activeTab: 'agent-hub', accessedAt: 5 },
            'agent-b': { open: false, activeTab: 'pulse', accessedAt: 6 },
          })
        );
        useAppStore.getState().loadRightPanelState();

        expect(localStorage.getItem(LEGACY)).toBeNull();
        // The renamed tab is translated on the way over, recency kept.
        expect(readLayouts()).toEqual({
          'agent-a': { open: true, activeTab: 'profile', accessedAt: 5 },
        });
      });

      it('never overwrites a layout already saved under the new key', () => {
        localStorage.setItem(
          'dorkos-right-panel-layouts-v2',
          JSON.stringify({ 'agent-a': { open: false, activeTab: 'files', accessedAt: 9 } })
        );
        localStorage.setItem(
          LEGACY,
          JSON.stringify({ 'agent-a': { open: true, activeTab: 'canvas', accessedAt: 1 } })
        );
        useAppStore.getState().loadRightPanelState();

        expect(readLayouts()['agent-a']).toMatchObject({ open: false, activeTab: 'files' });
      });

      it('keeps migrated layouts when the new key holds something other than a map', () => {
        localStorage.setItem('dorkos-right-panel-layouts-v2', '[1,2]');
        localStorage.setItem(
          LEGACY,
          JSON.stringify({ 'agent-a': { open: true, activeTab: 'files', accessedAt: 3 } })
        );
        useAppStore.getState().loadRightPanelState();
        expect(readLayouts()).toEqual({
          'agent-a': { open: true, activeTab: 'files', accessedAt: 3 },
        });
      });

      it('drops a corrupt old map without touching the new one', () => {
        localStorage.setItem(LEGACY, 'not-json');
        useAppStore.getState().loadRightPanelState();
        expect(localStorage.getItem(LEGACY)).toBeNull();
        expect(localStorage.getItem('dorkos-right-panel-layouts-v2')).toBeNull();
      });
    });

    it('setActiveRightPanelTab updates state and persists globally', () => {
      useAppStore.getState().setActiveRightPanelTab('canvas');
      expect(useAppStore.getState().activeRightPanelTab).toBe('canvas');
      const stored = JSON.parse(localStorage.getItem('dorkos-right-panel-state')!);
      expect(stored.activeTab).toBe('canvas');
    });
  });

  // ------------------------------------------------------------------------- Per-agent surface
  // (DOR-227) -------------------------------------------------------------------------

  describe('per-agent layout', () => {
    it('write-through: open/tab persist under the agent key, mirrored to global', () => {
      useAppStore.getState().loadRightPanelForAgent('agent-a');
      useAppStore.getState().setRightPanelOpen(true);
      useAppStore.getState().setActiveRightPanelTab('terminal');

      expect(readLayouts()['agent-a']).toMatchObject({ open: true, activeTab: 'terminal' });
      // Global holds the last layout you looked at, so a reload restores it.
      expect(JSON.parse(localStorage.getItem('dorkos-right-panel-state')!)).toEqual({
        open: true,
        activeTab: 'terminal',
      });
    });

    it('hydrates open + active tab when binding to an agent with a stored layout', () => {
      localStorage.setItem(
        'dorkos-right-panel-layouts-v2',
        JSON.stringify({ 'agent-a': { open: true, activeTab: 'files', accessedAt: 1 } })
      );
      useAppStore.getState().loadRightPanelForAgent('agent-a');
      expect(useAppStore.getState().rightPanelOpen).toBe(true);
      expect(useAppStore.getState().activeRightPanelTab).toBe('files');
    });

    it('a never-seen agent inherits the open panel and its tab (DOR-2579)', () => {
      // Switching to another project's chat used to hydrate it as closed, so an
      // extension tab had to be reopened on every switch.
      useAppStore.getState().loadRightPanelForAgent('agent-a', '/repo/a');
      useAppStore.getState().setRightPanelOpen(true);
      useAppStore.getState().setActiveRightPanelTab('flow');

      useAppStore.getState().loadRightPanelForAgent('agent-b', '/repo/b');

      expect(useAppStore.getState().rightPanelOpen).toBe(true);
      expect(useAppStore.getState().activeRightPanelTab).toBe('flow');
      expect(useAppStore.getState().rightPanelLayoutKey).toBe('agent-b');
    });

    it('restores each agent independently across A → B → A switches', () => {
      // Agent A: open, terminal.
      useAppStore.getState().loadRightPanelForAgent('agent-a');
      useAppStore.getState().setRightPanelOpen(true);
      useAppStore.getState().setActiveRightPanelTab('terminal');

      // Agent B: inherits A's open panel on first visit, then closed, canvas.
      useAppStore.getState().loadRightPanelForAgent('agent-b');
      expect(useAppStore.getState().rightPanelOpen).toBe(true);
      useAppStore.getState().setRightPanelOpen(false);
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

    it('closing the panel saves the carried tab, not the fallback shown in its place', () => {
      useAppStore.getState().loadRightPanelForAgent('agent-a');
      useAppStore.getState().setRightPanelOpen(true);
      useAppStore.getState().setActiveRightPanelTab('a-only');
      useAppStore.getState().loadRightPanelForAgent('agent-b');
      // Agent B cannot show `a-only`, so the container falls back on screen.
      useAppStore.getState().setActiveRightPanelTabView('profile');

      useAppStore.getState().setRightPanelOpen(false);

      expect(readLayouts()['agent-b']).toMatchObject({ open: false, activeTab: 'a-only' });
    });
  });

  // ------------------------------------------------------------------------- Auto-select vs
  // explicit pick (the container's view-only fallback)
  // -------------------------------------------------------------------------

  describe('auto-select fallback vs explicit pick', () => {
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
  });

  // ------------------------------------------------------------------------- A link outranks a
  // remembered layout -------------------------------------------------------------------------

  describe('a panel a link asked for', () => {
    it('stays open when an agent whose layout says CLOSED binds under it', () => {
      // The order these arrive in is fixed and wrong: the link is read on mount, the per-agent
      // layout hydrates after it, and an agent you have never opened hydrates as closed.
      localStorage.setItem(
        'dorkos-right-panel-layouts-v2',
        JSON.stringify({ 'agent-a': { open: false, activeTab: 'files', accessedAt: 1 } })
      );
      useAppStore.getState().requestRightPanel('profile', '/repo/a');

      useAppStore.getState().loadRightPanelForAgent('agent-a', '/repo/a');

      expect(useAppStore.getState().rightPanelOpen).toBe(true);
      expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
    });

    it('does not reach the NEXT agent — its closed layout wins, and the mark is gone', () => {
      // The leak this scoping exists for: a mark that only said "profile" outranked the layout of
      // every agent bound after it, so switching to an agent whose panel you had left closed
      // opened it anyway — somebody else's link undoing DOR-227's per-agent layout, one switch at
      // a time.
      localStorage.setItem(
        'dorkos-right-panel-layouts-v2',
        JSON.stringify({
          'agent-a': { open: false, activeTab: 'pulse', accessedAt: 1 },
          'agent-b': { open: false, activeTab: 'pulse', accessedAt: 1 },
        })
      );
      useAppStore.getState().requestRightPanel('profile', '/repo/a');

      // The agent the link named binds first, and is answered.
      useAppStore.getState().loadRightPanelForAgent('agent-a', '/repo/a');
      expect(useAppStore.getState().rightPanelOpen).toBe(true);
      expect(useAppStore.getState().requestedRightPanel).toBeNull();

      // Then you switch, having touched nothing.
      useAppStore.getState().loadRightPanelForAgent('agent-b', '/repo/b');

      expect(useAppStore.getState().rightPanelOpen).toBe(false);
      expect(useAppStore.getState().activeRightPanelTab).toBe('pulse');
    });
  });

  // ------------------------------------------------------------------------- Renamed tabs
  // -------------------------------------------------------------------------

  describe('a tab that was renamed under an existing user', () => {
    it('restores the old agent panel’s stored layout as the Profile tab, per agent', () => {
      // What is in the browser of anybody who used the old agent panel before it became the
      // Profile.
      localStorage.setItem(
        'dorkos-right-panel-layouts-v2',
        JSON.stringify({ 'agent-a': { open: true, activeTab: 'agent-hub', accessedAt: 1 } })
      );

      useAppStore.getState().loadRightPanelForAgent('agent-a');

      expect(useAppStore.getState().rightPanelOpen).toBe(true);
      expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
    });

    it('restores it from the global surface too', () => {
      localStorage.setItem(
        'dorkos-right-panel-state',
        JSON.stringify({ open: true, activeTab: 'agent-hub' })
      );

      useAppStore.getState().loadRightPanelState();

      expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
    });

    it('leaves every other tab id alone', () => {
      localStorage.setItem(
        'dorkos-right-panel-state',
        JSON.stringify({ open: true, activeTab: 'terminal' })
      );

      useAppStore.getState().loadRightPanelState();

      expect(useAppStore.getState().activeRightPanelTab).toBe('terminal');
    });
  });
});
