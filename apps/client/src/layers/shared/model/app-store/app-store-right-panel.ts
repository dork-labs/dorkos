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
   * The panel a LINK asked for, and that no stored layout has been allowed to
   * overrule yet — or null when nothing is pending.
   *
   * A deep link and a persisted layout are not the same kind of statement. The
   * layout is a memory of how you last left this agent's panel; the link is an
   * instruction you just gave. They arrive in the wrong order — the link is read
   * on mount, the layouts hydrate after it — and a never-seen agent hydrates as
   * CLOSED, so the link's panel was opened and shut again before it could be
   * seen (spec `profile-unification` §1.6). This is what lets the instruction
   * outrank the memory.
   *
   * **It names the agent it was for.** A mark that only said "profile" outranked
   * the layout of every agent bound after it, so switching to an agent whose
   * panel you had left closed opened it anyway — DOR-227's per-agent layout,
   * undone by somebody else's link. It is honoured for that agent and spent on
   * the first bind either way, so it can never reach a second one.
   */
  requestedRightPanel: { tabId: string; agentPath: string | null } | null;
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
   * @param agentPath - The directory the link named, or null when it named none
   *   (an `?panel=` with no agent — then the mark is spent by whichever bind
   *   comes first, which is the one the link was about).
   */
  requestRightPanel: (tabId: string, agentPath: string | null) => void;
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
   * pending FOR THAT AGENT ({@link requestedRightPanel}), which outranks it.
   * Pass null on non-session routes to detach: subsequent writes fall back to
   * the global layout and the in-memory open/tab state is left untouched (no
   * flash).
   *
   * @param agentKey - Stable agent identity, or null to detach to global scope.
   * @param agentPath - The directory that key was resolved from, which is what a
   *   pending link named itself against. Omitted only by callers that have no
   *   directory to give, in which case a pending link cannot match.
   */
  loadRightPanelForAgent: (agentKey: string | null, agentPath?: string | null) => void;
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
      const answered = open ? {} : { requestedRightPanel: null };
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
      return { activeRightPanelTab: tabId, requestedRightPanel: null };
    }),
  setActiveRightPanelTabView: (tabId) => set({ activeRightPanelTab: tabId }),

  requestedRightPanel: null,
  requestRightPanel: (tabId, agentPath) => {
    get().setActiveRightPanelTab(tabId);
    get().setRightPanelOpen(true);
    set({ requestedRightPanel: { tabId, agentPath } });
  },

  rightPanelLayoutKey: null,
  loadRightPanelForAgent: (agentKey, agentPath) => {
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
    // A link that asked for THIS agent's panel outranks the layout you left
    // behind: the link is an instruction, the layout is a memory, and a
    // never-seen agent remembers "closed". A link for a DIFFERENT agent is not
    // an instruction about this one, and this bind is the switch that ends it.
    const requested = get().requestedRightPanel;
    const forThisAgent =
      requested !== null && (requested.agentPath === null || requested.agentPath === agentPath);
    set((s) => ({
      rightPanelLayoutKey: agentKey,
      rightPanelOpen: forThisAgent || (entry?.open ?? false),
      activeRightPanelTab: forThisAgent ? requested.tabId : (entry?.activeTab ?? null),
      // Spent on the first bind either way: honoured here, or overtaken by a
      // switch. A mark that outlived one bind reached the next agent too.
      requestedRightPanel: null,
      // The link latched the agent it named as an explicit pick, which is what
      // keeps the tab visible off `/session`. That latch is the link's, not
      // yours — so it goes with the mark rather than making every later session
      // profile an agent a URL chose and you never did.
      ...(requested !== null && !forThisAgent && s.explicitAgentPath === requested.agentPath
        ? { explicitAgentPath: null }
        : {}),
    }));
  },

  loadRightPanelState: () => {
    const entry = readRightPanelState();
    if (!entry) return;
    // Same rule as the per-agent bind above, for the same reason — but this one
    // runs once on mount and has no agent to match against, so it honours a
    // pending mark WITHOUT spending it. The per-agent bind that follows on
    // `/session` is the one that decides whether the link was about that agent.
    const requested = get().requestedRightPanel;
    set({
      rightPanelOpen: requested !== null || entry.open,
      activeRightPanelTab: requested?.tabId ?? entry.activeTab,
    });
  },
});
