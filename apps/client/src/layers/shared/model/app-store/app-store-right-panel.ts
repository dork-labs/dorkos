/**
 * Right panel slice — shell-level right panel state for the app store.
 *
 * Panel open/closed and active tab are persisted to localStorage independently
 * of canvas per-session state. The right panel tracks structural state only.
 *
 * @module shared/model/app-store-right-panel
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './app-store-types';
import { readRightPanelState, writeRightPanelState } from './app-store-helpers';

// ---------------------------------------------------------------------------
// Slice interface
// ---------------------------------------------------------------------------

export interface RightPanelSlice {
  /** Whether the right panel is open. */
  rightPanelOpen: boolean;
  /** Set right panel open/closed state. */
  setRightPanelOpen: (open: boolean) => void;
  /** Toggle right panel open/closed. */
  toggleRightPanel: () => void;
  /** ID of the active right panel tab. */
  activeRightPanelTab: string | null;
  /** Set the active right panel tab by contribution ID. */
  setActiveRightPanelTab: (tabId: string | null) => void;
  /** Load persisted right panel state from localStorage. */
  loadRightPanelState: () => void;
}

// ---------------------------------------------------------------------------
// Slice creator
// ---------------------------------------------------------------------------

/** Creates the right panel slice (persisted shell-level panel UI state). */
export const createRightPanelSlice: StateCreator<
  AppState,
  [['zustand/devtools', never]],
  [],
  RightPanelSlice
> = (set, get) => ({
  rightPanelOpen: false,
  setRightPanelOpen: (open) =>
    set((s) => {
      writeRightPanelState({ open, activeTab: s.activeRightPanelTab });
      return { rightPanelOpen: open };
    }),
  toggleRightPanel: () => {
    const current = get().rightPanelOpen;
    get().setRightPanelOpen(!current);
  },

  activeRightPanelTab: null,
  setActiveRightPanelTab: (tabId) =>
    set((s) => {
      writeRightPanelState({ open: s.rightPanelOpen, activeTab: tabId });
      return { activeRightPanelTab: tabId };
    }),

  loadRightPanelState: () => {
    const entry = readRightPanelState();
    if (entry) {
      set({ rightPanelOpen: entry.open, activeRightPanelTab: entry.activeTab });
    }
  },
});
