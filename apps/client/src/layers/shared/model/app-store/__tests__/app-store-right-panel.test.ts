import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MAX_RIGHT_PANEL_LAYOUTS } from '@/layers/shared/lib/constants';
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
      requestedRightPanel: null,
      explicitAgentPath: null,
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
      useAppStore.getState().setActiveRightPanelTab('canvas');

      useAppStore.getState().loadRightPanelForAgent('other');
      useAppStore.getState().loadRightPanelForAgent(cwd);
      expect(useAppStore.getState().rightPanelOpen).toBe(true);
      expect(useAppStore.getState().activeRightPanelTab).toBe('canvas');
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

    it('revisiting an agent (read-hydrate) bumps its recency, so eviction is least-recently-USED', () => {
      let now = 1_000;
      vi.spyOn(Date, 'now').mockImplementation(() => (now += 1));

      // Fill exactly to the cap (agents 0..cap-1), oldest first.
      for (let i = 0; i < MAX_RIGHT_PANEL_LAYOUTS; i++) {
        useAppStore.getState().loadRightPanelForAgent(`agent-${i}`);
        useAppStore.getState().setRightPanelOpen(true);
      }
      // Revisit agent-0 WITHOUT writing — the read-hydrate alone bumps recency.
      useAppStore.getState().loadRightPanelForAgent('agent-0');

      // One more agent pushes past the cap: agent-1 is now the true LRU.
      useAppStore.getState().loadRightPanelForAgent('agent-new');
      useAppStore.getState().setRightPanelOpen(true);

      const layouts = readLayouts();
      expect(layouts['agent-0']).toBeDefined();
      expect(layouts['agent-1']).toBeUndefined();
      expect(layouts['agent-new']).toBeDefined();
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

  // -------------------------------------------------------------------------
  // A link outranks a remembered layout
  // -------------------------------------------------------------------------

  describe('a panel a link asked for', () => {
    it('stays open when an agent whose layout says CLOSED binds under it', () => {
      // The order these arrive in is fixed and wrong: the link is read on mount,
      // the per-agent layout hydrates after it, and an agent you have never
      // opened hydrates as closed. Without the request outranking it, the panel
      // was opened and shut again on the same frame and nobody ever saw it.
      localStorage.setItem(
        'dorkos-right-panel-layouts',
        JSON.stringify({ 'agent-a': { open: false, activeTab: 'files', accessedAt: 1 } })
      );
      useAppStore.getState().requestRightPanel('profile', '/repo/a');

      useAppStore.getState().loadRightPanelForAgent('agent-a', '/repo/a');

      expect(useAppStore.getState().rightPanelOpen).toBe(true);
      expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
    });

    it('survives the global hydrate that runs before the agent binds', () => {
      useAppStore.getState().requestRightPanel('profile', '/repo/a');
      // Seeded AFTER the request, deliberately: the request writes through to
      // whichever surface is in scope, so seeding first would have this read
      // back the very value it is supposed to be outranking.
      localStorage.setItem(
        'dorkos-right-panel-state',
        JSON.stringify({ open: false, activeTab: 'files' })
      );

      useAppStore.getState().loadRightPanelState();

      expect(useAppStore.getState().rightPanelOpen).toBe(true);
      expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
    });

    it('is answered once you close the panel yourself, and stops outranking', () => {
      localStorage.setItem(
        'dorkos-right-panel-layouts',
        JSON.stringify({ 'agent-a': { open: false, activeTab: 'files', accessedAt: 1 } })
      );
      useAppStore.getState().requestRightPanel('profile', '/repo/a');

      useAppStore.getState().setRightPanelOpen(false);
      useAppStore.getState().loadRightPanelForAgent('agent-a', '/repo/a');

      expect(useAppStore.getState().requestedRightPanel).toBeNull();
      expect(useAppStore.getState().rightPanelOpen).toBe(false);
      expect(useAppStore.getState().activeRightPanelTab).toBe('files');
    });

    it('is answered by picking another tab', () => {
      localStorage.setItem(
        'dorkos-right-panel-layouts',
        JSON.stringify({ 'agent-a': { open: false, activeTab: 'files', accessedAt: 1 } })
      );
      useAppStore.getState().requestRightPanel('profile', '/repo/a');

      useAppStore.getState().setActiveRightPanelTab('canvas');
      useAppStore.getState().loadRightPanelForAgent('agent-a', '/repo/a');

      expect(useAppStore.getState().requestedRightPanel).toBeNull();
      expect(useAppStore.getState().rightPanelOpen).toBe(false);
    });

    it('does not reach the NEXT agent — its closed layout wins, and the mark is gone', () => {
      // The leak this scoping exists for: a mark that only said "profile"
      // outranked the layout of every agent bound after it, so switching to an
      // agent whose panel you had left closed opened it anyway — somebody
      // else's link undoing DOR-227's per-agent layout, one switch at a time.
      localStorage.setItem(
        'dorkos-right-panel-layouts',
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

    it('leaves the panel alone at a bind for SOMEBODY ELSE, and stays pending', () => {
      // `/session?dir=<Warden>&panel=profile&agentPath=<Scout>`: the bind is
      // about the session, the panel is about the link. Spending the mark here
      // — which an earlier shape did — closed the panel the link had just
      // opened and cleared the subject with it, so the link opened nothing.
      localStorage.setItem(
        'dorkos-right-panel-layouts',
        JSON.stringify({ warden: { open: false, activeTab: 'pulse', accessedAt: 1 } })
      );
      useAppStore.setState({ explicitAgentPath: '/repo/scout' });
      useAppStore.getState().requestRightPanel('profile', '/repo/scout');

      useAppStore.getState().loadRightPanelForAgent('warden', '/repo/warden');

      expect(useAppStore.getState().rightPanelOpen).toBe(true);
      expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
      // The subject the link chose survives — it is what the panel is showing.
      expect(useAppStore.getState().explicitAgentPath).toBe('/repo/scout');
      // Unanswered: only the agent it names, or the dock, can answer it.
      expect(useAppStore.getState().requestedRightPanel).not.toBeNull();
      // The layout key still follows the session, so writes land on the session.
      expect(useAppStore.getState().rightPanelLayoutKey).toBe('warden');
    });

    it('sits through the ARRIVAL bind only — the next agent gets its layout back', () => {
      // The protection above is for the bind that happens as the link lands.
      // Unscoped, it applied to every bind after it too, so an agent you
      // switched to later had its stored layout ignored — the same DOR-227 leak
      // the mark's agent name was added to close, one level up.
      localStorage.setItem(
        'dorkos-right-panel-layouts',
        JSON.stringify({
          warden: { open: false, activeTab: 'pulse', accessedAt: 1 },
          ranger: { open: false, activeTab: 'pulse', accessedAt: 1 },
        })
      );
      useAppStore.getState().requestRightPanel('profile', '/repo/scout');

      // Arrival: Warden's session, link for Scout. Panel left as the link set it.
      useAppStore.getState().loadRightPanelForAgent('warden', '/repo/warden');
      expect(useAppStore.getState().rightPanelOpen).toBe(true);

      // A switch you made, to somebody the link never named.
      useAppStore.getState().loadRightPanelForAgent('ranger', '/repo/ranger');

      expect(useAppStore.getState().rightPanelOpen).toBe(false);
      expect(useAppStore.getState().activeRightPanelTab).toBe('pulse');
      expect(useAppStore.getState().requestedRightPanel).toBeNull();
    });

    it('still honours the link if you walk into its agent’s session first', () => {
      // Expiry is about binds for OTHER agents. The one the link named answers
      // it whenever it comes, and its own stored layout is the thing outranked.
      localStorage.setItem(
        'dorkos-right-panel-layouts',
        JSON.stringify({
          warden: { open: false, activeTab: 'pulse', accessedAt: 1 },
          scout: { open: false, activeTab: 'pulse', accessedAt: 1 },
        })
      );
      useAppStore.getState().requestRightPanel('profile', '/repo/scout');
      useAppStore.getState().loadRightPanelForAgent('warden', '/repo/warden');

      useAppStore.getState().loadRightPanelForAgent('scout', '/repo/scout');

      expect(useAppStore.getState().rightPanelOpen).toBe(true);
      expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
      expect(useAppStore.getState().requestedRightPanel).toBeNull();
    });

    it('is answered when the agent it named turns out not to exist', () => {
      // The ending a bind cannot supply: nothing ever binds an agent whose
      // session you are not in, so `ProfileDock` reports it instead.
      useAppStore.setState({ explicitAgentPath: '/repo/gone' });
      useAppStore.getState().requestRightPanel('profile', '/repo/gone');

      useAppStore.getState().releaseRightPanelRequest('/repo/gone');

      expect(useAppStore.getState().requestedRightPanel).toBeNull();
      // And the latch goes with it: a directory nothing answers to must not be
      // the panel's subject for the rest of the session.
      expect(useAppStore.getState().explicitAgentPath).toBeNull();
    });

    it('ignores a release for an agent the pending link did not name', () => {
      useAppStore.setState({ explicitAgentPath: '/repo/scout' });
      useAppStore.getState().requestRightPanel('profile', '/repo/scout');

      useAppStore.getState().releaseRightPanelRequest('/repo/somebody-else');

      expect(useAppStore.getState().requestedRightPanel).not.toBeNull();
      expect(useAppStore.getState().explicitAgentPath).toBe('/repo/scout');
    });

    it('an ordinary click does NOT outrank the next agent’s layout', () => {
      // A click lands after hydration and has nothing to argue with. Latching it
      // would force every agent you switch to open, discarding the per-agent
      // layout DOR-227 exists to restore.
      localStorage.setItem(
        'dorkos-right-panel-layouts',
        JSON.stringify({ 'agent-b': { open: false, activeTab: 'files', accessedAt: 1 } })
      );
      useAppStore.getState().setActiveRightPanelTab('profile');
      useAppStore.getState().setRightPanelOpen(true);

      useAppStore.getState().loadRightPanelForAgent('agent-b', '/repo/b');

      expect(useAppStore.getState().rightPanelOpen).toBe(false);
      expect(useAppStore.getState().activeRightPanelTab).toBe('files');
    });
  });

  // -------------------------------------------------------------------------
  // Renamed tabs
  // -------------------------------------------------------------------------

  describe('a tab that was renamed under an existing user', () => {
    it('restores the old agent panel’s stored layout as the Profile tab, per agent', () => {
      // What is in the browser of anybody who used the old agent panel before it
      // became the Profile. Without the translation the id names no
      // contribution, the container falls back to whichever tab is first, and a
      // preference somebody set is silently thrown away.
      localStorage.setItem(
        'dorkos-right-panel-layouts',
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
