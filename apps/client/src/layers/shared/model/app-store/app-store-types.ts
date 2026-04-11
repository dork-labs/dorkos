/**
 * Combined AppState type for the app store.
 *
 * Lives in its own file to break the circular type dependency that would arise
 * if slice files imported AppState from app-store.ts (which imports the slices).
 *
 * Dependency order (no cycles):
 *   app-store-helpers → (nothing store-related)
 *   app-store-panels  → app-store-helpers
 *   app-store-prefs   → app-store-helpers
 *   app-store-canvas  → app-store-helpers
 *   app-store-types   → all three slice files  ← this file
 *   app-store         → app-store-types + slice files
 *
 * @module shared/model/app-store-types
 */
import type { PanelsSlice } from './app-store-panels';
import type { PreferencesSlice } from './app-store-preferences';
import type { CanvasSlice } from './app-store-canvas';
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

  devtoolsOpen: boolean;
  toggleDevtools: () => void;

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

  /** Reset all persisted preferences to defaults and sync state + localStorage. */
  resetPreferences: () => void;
}

// ---------------------------------------------------------------------------
// Combined state type
// ---------------------------------------------------------------------------

/** Complete store state — intersection of all four slices. */
export type AppState = CoreSlice & PanelsSlice & PreferencesSlice & CanvasSlice;
