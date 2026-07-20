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

  /**
   * Active sidebar tab id. A built-in (`overview` | `sessions` | `schedules` |
   * `connections`) or an extension-contributed tab id (`${extId}:${id}`). Stored
   * as-is; `useSidebarTabs` reconciles an id whose tab isn't currently rendered
   * (extension disabled/uninstalled, or a switch that raced its extension's
   * registration) back to `overview`.
   */
  sidebarActiveTab: string;
  setSidebarActiveTab: (tab: string) => void;

  /** Which sidebar level is visible: top-level dashboard nav or agent-scoped session view. */
  sidebarLevel: 'dashboard' | 'session';
  setSidebarLevel: (level: 'dashboard' | 'session') => void;

  sessionId: string | null;
  setSessionId: (id: string | null) => void;

  selectedCwd: string | null;
  setSelectedCwd: (cwd: string) => void;
  recentCwds: RecentCwd[];

  /**
   * ID of the agent registered at {@link selectedCwd}, or null when none is
   * registered there (or resolution hasn't completed yet). Kept fresh by
   * `useSyncCurrentAgentId`; transient — derived from the cwd, never persisted.
   * Lets synchronous readers (the extension host) tell which agent is active
   * without re-fetching.
   */
  currentAgentId: string | null;
  /** Set the resolved current-agent id (null clears it). No-op when unchanged. */
  setCurrentAgentId: (id: string | null) => void;

  /**
   * Path of the agent the operator *explicitly* opened to inspect this session
   * (through the Agent Hub — `openHub`), or null when none has been picked.
   *
   * This is the honest, click-driven counterpart to {@link selectedCwd}, which
   * is auto-set to the server's default working directory at startup. The
   * right-panel visibility predicates read it to keep the Agent Profile tab
   * hidden off `/session` until the user actually selects an agent, rather than
   * surfacing the ambient startup agent nobody chose. Published here (mirrored
   * from the agent-hub feature store) so cross-feature, synchronous readers can
   * see it without importing that feature — the same role {@link currentAgentId}
   * plays for the extension host. Transient: never persisted.
   *
   * Deliberately NOT self-healing: unlike {@link currentAgentId} — which
   * `useSyncCurrentAgentId` reconciles continuously against the resolved cwd —
   * this field is only ever set forward by the explicit-selection writers and
   * has no clearing/reconcile path. An opened-then-deleted agent therefore keeps
   * the tab visible, rendering AgentNotFound (a non-crashing degradation, locked
   * by test). A clearing + reconcile lifecycle is intentionally deferred to
   * Inspector Wave 2 (Pulse), which reworks this surface.
   */
  explicitAgentPath: string | null;
  /** Set the explicitly-opened agent path (null clears it). No-op when unchanged. */
  setExplicitAgentPath: (path: string | null) => void;

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
