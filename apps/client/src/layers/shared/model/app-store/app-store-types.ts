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

/**
 * A pre-launch choice, carrying the session it was made in.
 *
 * The store is a module global; the surfaces that read it mount and unmount as
 * the operator moves around the cockpit. A bare value in here therefore outlives
 * the conversation it was chosen for: pick an account on a draft session, walk to
 * /tasks, start a different chat, and the new chat inherits a billing choice
 * nobody made for it — while the menu that took the choice promised "this session
 * only". Neither clearing on mount nor clearing on a transition can close that:
 * the first destroys a pick whenever a second surface mounts, the second relies
 * on instance lifetime the store does not have.
 *
 * Pairing the value with its owner makes the promise a property of the DATA, so
 * every reader enforces it by construction: a pick is shown and sent only to the
 * session whose id it names, and a remount of that same session keeps it.
 *
 * @typeParam ValueKey - Name of the value field, so each pick reads in its own
 *   vocabulary (`type` for a runtime, `id` for an account) rather than a
 *   uniform `value` that says nothing at the call site.
 */
export type PendingLaunchPick<ValueKey extends string> = {
  [K in ValueKey]: string;
} & {
  /** Session this choice belongs to. No other session may show or send it. */
  sessionId: string;
};

export interface CoreSlice {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;

  /**
   * Target of the embedded `switch_sidebar_tab` UI command — set by a Shape's
   * pinned `sidebarTab` and `control_ui`, and reported in the embedded
   * `get_ui_state` snapshot. No surface renders from it since the legacy embed
   * tab strip (`SessionSidebar`) was retired for the roster + right-panel
   * Inspector (DOR-401); kept as write-and-report state for those channels.
   */
  sidebarActiveTab: string;
  setSidebarActiveTab: (tab: string) => void;

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
   * (through the docked profile — `openProfileDocked`), or null when none has
   * been picked.
   *
   * This is the honest, click-driven counterpart to {@link selectedCwd}, which
   * is auto-set to the server's default working directory at startup. The
   * right-panel visibility predicates read it to keep the Profile tab hidden
   * off `/session` until the user actually selects an agent, rather than
   * surfacing the ambient startup agent nobody chose. Published here (mirrored
   * from a feature store) so cross-feature, synchronous readers can
   * see it without importing that feature — the same role {@link currentAgentId}
   * plays for the extension host. Transient: never persisted.
   *
   * Sticky for the session, but reconciled against agent existence:
   * {@link useReconcileExplicitAgentPath} (mounted beside `useSyncCurrentAgentId`)
   * clears this field when the opened agent no longer resolves — so an
   * opened-then-deleted agent's Profile tab disappears off /session rather than
   * lingering on a stale selection. It is otherwise only set forward by the
   * explicit-selection writer (`openProfileDocked`); no route change or ambient
   * cwd shift clears it. `ProfileDock` still degrades to "Agent not found"
   * (non-crashing) if rendered on a dead path before the reconcile fires, or on
   * /session, where the tab is always visible.
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
   *
   * **Carries the session it was made in** — see {@link PendingLaunchPick}.
   */
  pendingRuntime: PendingLaunchPick<'type'> | null;
  /** Set the shared pending pre-launch runtime selection (null clears it). */
  setPendingRuntime: (pick: PendingLaunchPick<'type'> | null) => void;

  /**
   * Pending pre-launch BILLING ACCOUNT selection made from the status-bar chip —
   * a registry id (`runtimes.claudeCode.accounts[].id`), never a path. Sent as
   * the `account` launch hint on the session-creating first message and nothing
   * else; null means "no hint", which leaves the server's own ladder (the
   * agent's account, else the default) in charge.
   *
   * Deliberately transient AND deliberately absent from the URL, unlike
   * {@link pendingRuntime}. Billing is not a deep link: a shared or bookmarked
   * cockpit URL must never be able to decide whose subscription a stranger's
   * turn spends. **And it carries the session it was made in** — see
   * {@link PendingLaunchPick}, which is what makes "this session only" true.
   */
  pendingAccount: PendingLaunchPick<'id'> | null;
  /** Set the pending pre-launch account hint (null clears it, meaning "no hint"). */
  setPendingAccount: (pick: PendingLaunchPick<'id'> | null) => void;

  /**
   * A living tour (DOR-419) requested by name from anywhere in the app — the
   * on-demand "Show me around" doors set it, and the tour host consumes and
   * clears it. A cross-feature request seam so features that cannot import the
   * tours feature (e.g. onboarding) can still launch a tour. Null when none is
   * requested.
   */
  requestedTour: string | null;
  /** Request a tour by id (the tour host runs it, then clears this). */
  requestTour: (id: string) => void;
  /** Clear the pending tour request (the host calls this after running it). */
  clearRequestedTour: () => void;

  devtoolsOpen: boolean;
  toggleDevtools: () => void;

  routerDevtoolsOpen: boolean;
  toggleRouterDevtools: () => void;

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
