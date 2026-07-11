/**
 * Combined AppState type for the app store.
 *
 * Lives in its own file to break the circular type dependency that would arise
 * if slice files imported AppState from app-store.ts (which imports the slices).
 *
 * Dependency order (no cycles):
 *   app-store-helpers      → (nothing store-related)
 *   app-store-panels       → app-store-helpers
 *   app-store-prefs        → app-store-helpers
 *   app-store-canvas       → app-store-helpers
 *   app-store-right-panel  → app-store-helpers
 *   app-store-pip          → app-store-helpers
 *   app-store-types        → all slice files  ← this file
 *   app-store              → app-store-types + slice files
 *
 * @module shared/model/app-store-types
 */
import type { PanelsSlice } from './app-store-panels';
import type { PreferencesSlice } from './app-store-preferences';
import type { CanvasSlice } from './app-store-canvas';
import type { RightPanelSlice } from './app-store-right-panel';
import type { PipSlice } from './app-store-pip';
import type { ContextFile, RecentCwd } from './app-store-helpers';

// ---------------------------------------------------------------------------
// Core slice interface (defined here so slice files can use it via AppState)
// ---------------------------------------------------------------------------

export interface CoreSlice {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;

  sidebarActiveTab: 'overview' | 'sessions' | 'schedules' | 'connections';
  setSidebarActiveTab: (tab: 'overview' | 'sessions' | 'schedules' | 'connections') => void;

  /** Which sidebar level is visible: top-level dashboard nav or agent-scoped session view. */
  sidebarLevel: 'dashboard' | 'session';
  setSidebarLevel: (level: 'dashboard' | 'session') => void;

  sessionId: string | null;
  setSessionId: (id: string | null) => void;

  selectedCwd: string | null;
  setSelectedCwd: (cwd: string) => void;
  recentCwds: RecentCwd[];

  /**
   * Pending pre-launch runtime selection made from the status-bar chip (the
   * `?runtime=` choice), lifted here so every `useRuntimeChip` consumer — the
   * status bar and ChatPanel's command-palette query among them — reads one
   * shared value and a chip change propagates to all of them the same tick.
   * Null when no in-session override is active; the chip then falls back to the
   * `?runtime=` URL seed and finally the server default. Transient (not
   * persisted) — the URL carries the choice across reloads and deep-links.
   */
  pendingRuntime: string | null;
  /** Set the shared pending pre-launch runtime selection (null clears it). */
  setPendingRuntime: (runtime: string | null) => void;

  devtoolsOpen: boolean;
  toggleDevtools: () => void;

  routerDevtoolsOpen: boolean;
  toggleRouterDevtools: () => void;

  previousCwd: string | null;
  setPreviousCwd: (cwd: string | null) => void;

  isStreaming: boolean;
  setIsStreaming: (v: boolean) => void;
  isTextStreaming: boolean;
  setIsTextStreaming: (v: boolean) => void;
  isWaitingForUser: boolean;
  setIsWaitingForUser: (v: boolean) => void;
  activeForm: string | null;
  setActiveForm: (v: string | null) => void;
  tasksBadgeCount: number;
  setTasksBadgeCount: (v: number) => void;

  contextFiles: ContextFile[];
  addContextFile: (file: Omit<ContextFile, 'id'>) => void;
  removeContextFile: (id: string) => void;
  clearContextFiles: () => void;

  /** Ordered list of agent paths pinned by the user. Persisted to localStorage. */
  pinnedAgentPaths: string[];
  /** Pin an agent. Appends to end of pinned list if not already pinned. */
  pinAgent: (path: string) => void;
  /** Remove an agent from the pinned list. No-op if not pinned. */
  unpinAgent: (path: string) => void;

  /** Reset all persisted preferences to defaults and sync state + localStorage. */
  resetPreferences: () => void;
}

// ---------------------------------------------------------------------------
// Combined state type
// ---------------------------------------------------------------------------

/** Complete store state — intersection of all six slices. */
export type AppState = CoreSlice &
  PanelsSlice &
  PreferencesSlice &
  CanvasSlice &
  RightPanelSlice &
  PipSlice;
