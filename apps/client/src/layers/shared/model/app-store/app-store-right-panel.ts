/**
 * Right panel slice — shell-level right panel state for the app store.
 *
 * The right panel tracks structural state only: whether it is open and which
 * tab is active. That layout is persisted **per agent** (DOR-227): returning to
 * an agent restores the panel the way you left it, instead of dragging one
 * global layout across every agent. The active agent is selected by
 * `rightPanelLayoutKey`; when it is null (initial mount, non-session routes) the
 * slice falls back to the global layout, preserving the pre-DOR-227 behavior.
 * The per-agent map is LRU-capped and stored in localStorage (see
 * `readRightPanelLayout`/`writeRightPanelLayout` in app-store-helpers.ts).
 *
 * @module shared/model/app-store-right-panel
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './app-store-types';
import {
  readRightPanelState,
  readRightPanelLayout,
  writeRightPanelLayout,
} from './app-store-helpers';
import type { RightPanelStateEntry } from './app-store-helpers';

/** Read the persisted layout for the active surface (per-agent map, or global when detached). */
function readLayoutForKey(key: string | null): RightPanelStateEntry | null {
  return key === null ? readRightPanelState() : readRightPanelLayout(key);
}

// ---------------------------------------------------------------------------
// Slice interface
// ---------------------------------------------------------------------------

export interface RightPanelSlice {
  /** Whether the right panel is open. */
  rightPanelOpen: boolean;
  /** Set right panel open/closed state, persisting it under the current agent key. */
  setRightPanelOpen: (open: boolean) => void;
  /** Toggle right panel open/closed. */
  toggleRightPanel: () => void;
  /** ID of the active right panel tab. */
  activeRightPanelTab: string | null;
  /**
   * Set the active right panel tab from an explicit user pick, persisting it
   * under the current agent key. Use {@link setActiveRightPanelTabView} for the
   * auto-select fallback, which must not overwrite the stored preference.
   */
  setActiveRightPanelTab: (tabId: string | null) => void;
  /**
   * Set the active right panel tab for the current view only, WITHOUT persisting.
   *
   * The container auto-selects the first visible tab when the stored tab is not
   * available on this route/transport (e.g. a persisted "terminal" tab under a
   * transport without terminal support). That fallback updates what the user
   * sees but must NOT clobber the per-agent stored preference — so terminal is
   * restored the moment terminal support returns. Only an explicit user pick
   * ({@link setActiveRightPanelTab}) rewrites the stored preference.
   */
  setActiveRightPanelTabView: (tabId: string | null) => void;
  /**
   * The tab a LINK asked the panel to open on, and that no stored layout has
   * been allowed to overrule yet — or null when nothing is pending.
   *
   * A deep link and a persisted layout are not the same kind of statement. The
   * layout is a memory of how you last left this agent's panel; the link is an
   * instruction you just gave. They arrive in the wrong order — the link is read
   * on mount, the layouts hydrate after it — and a never-seen agent hydrates as
   * CLOSED, so the link's panel was opened and shut again before it could be
   * seen (spec `profile-unification` §1.6). This is what lets the instruction
   * outrank the memory, and it survives until you act on the panel yourself.
   */
  requestedRightPanelTab: string | null;
  /**
   * Open the panel on a tab because a LINK said so, not because somebody
   * clicked.
   *
   * Identical to setting the tab and opening the panel, plus the pending mark
   * above. Only URL-driven openers use it: a click happens after hydration and
   * has nothing to outrank, and latching one would make an agent switch ignore
   * the layout that agent was left in (DOR-227).
   *
   * @param tabId - The contribution id the link named.
   */
  requestRightPanel: (tabId: string) => void;
  /**
   * The stable identity of the agent whose layout is currently in scope, or null
   * on non-session routes / before an agent resolves. Set by
   * {@link loadRightPanelForAgent}; selects which surface write-throughs target.
   */
  rightPanelLayoutKey: string | null;
  /**
   * Bind the panel to an agent and hydrate its layout.
   *
   * Pass the agent's stable key (agent id if registered, else its cwd — resolved
   * by `useRightPanelLayoutPersistence`) to restore that agent's open/active-tab
   * layout, defaulting to closed for a never-seen agent — unless a link is
   * pending ({@link requestedRightPanelTab}), which outranks it. Pass null on
   * non-session routes to detach: subsequent writes fall back to the global
   * layout and the in-memory open/tab state is left untouched (no flash).
   *
   * @param agentKey - Stable agent identity, or null to detach to global scope.
   */
  loadRightPanelForAgent: (agentKey: string | null) => void;
  /** Load the persisted global right panel state from localStorage (initial mount). */
  loadRightPanelState: () => void;
}

// ---------------------------------------------------------------------------
// Slice creator
// ---------------------------------------------------------------------------

/** Creates the right panel slice (per-agent persisted shell-level panel UI state). */
export const createRightPanelSlice: StateCreator<
  AppState,
  [['zustand/devtools', never]],
  [],
  RightPanelSlice
> = (set, get) => ({
  rightPanelOpen: false,
  setRightPanelOpen: (open) =>
    set((s) => {
      // Closing it yourself answers a pending link: you have seen the panel it
      // asked for and decided otherwise.
      const answered = open ? {} : { requestedRightPanelTab: null };
      // Preserve the stored active-tab preference across open/close: the
      // in-memory tab may have been changed by the container's view-only
      // auto-select (DOR-227), which must never overwrite the stored preference.
      // Fall back to the in-memory tab only when the agent has no stored entry.
      const stored = readLayoutForKey(s.rightPanelLayoutKey);
      const activeTab = stored?.activeTab ?? s.activeRightPanelTab;
      writeRightPanelLayout(s.rightPanelLayoutKey, { open, activeTab });
      return { rightPanelOpen: open, ...answered };
    }),
  toggleRightPanel: () => {
    const current = get().rightPanelOpen;
    get().setRightPanelOpen(!current);
  },

  activeRightPanelTab: null,
  setActiveRightPanelTab: (tabId) =>
    set((s) => {
      writeRightPanelLayout(s.rightPanelLayoutKey, { open: s.rightPanelOpen, activeTab: tabId });
      // Picking a tab yourself answers a pending link the same way closing the
      // panel does — including the pick a URL-driven open makes on its way
      // through, which is why `requestRightPanel` marks it AFTER this runs.
      return { activeRightPanelTab: tabId, requestedRightPanelTab: null };
    }),
  setActiveRightPanelTabView: (tabId) => set({ activeRightPanelTab: tabId }),

  requestedRightPanelTab: null,
  requestRightPanel: (tabId) => {
    get().setActiveRightPanelTab(tabId);
    get().setRightPanelOpen(true);
    set({ requestedRightPanelTab: tabId });
  },

  rightPanelLayoutKey: null,
  loadRightPanelForAgent: (agentKey) => {
    if (agentKey === null) {
      // Detach to global scope without re-hydrating — leaving a session must not
      // flash the panel or clobber the just-shown layout. Consequence (bounded,
      // intentional): the first global write after leaving /session inherits the
      // last agent's in-memory tab — the panel still shows that layout, so
      // persisting what the user is looking at is the honest snapshot.
      set({ rightPanelLayoutKey: null });
      return;
    }
    const entry = readRightPanelLayout(agentKey);
    if (entry) {
      // Re-stamp accessedAt so eviction is least-recently-USED, not
      // least-recently-written — revisiting an agent keeps its layout alive.
      writeRightPanelLayout(agentKey, entry);
    }
    // A link that asked for the panel outranks the layout you left behind: the
    // link is an instruction, the layout is a memory, and a never-seen agent
    // remembers "closed".
    const requested = get().requestedRightPanelTab;
    set({
      rightPanelLayoutKey: agentKey,
      rightPanelOpen: requested !== null || (entry?.open ?? false),
      activeRightPanelTab: requested ?? entry?.activeTab ?? null,
    });
  },

  loadRightPanelState: () => {
    const entry = readRightPanelState();
    if (!entry) return;
    // Same rule as the per-agent bind above, for the same reason.
    const requested = get().requestedRightPanelTab;
    set({
      rightPanelOpen: requested !== null || entry.open,
      activeRightPanelTab: requested ?? entry.activeTab,
    });
  },
});
