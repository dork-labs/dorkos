/** Client-only constants — localStorage keys, font scales, and UI limits. */

export const STORAGE_KEYS = {
  FONT_SIZE: 'dorkos-font-size',
  FONT_FAMILY: 'dorkos-font-family',
  RECENT_CWDS: 'dorkos-recent-cwds',
  PICKER_VIEW: 'dorkos-picker-view',
  PLACEHOLDER_HINT_CYCLES: 'dorkos-placeholder-hint-cycles',
  RIGHT_PANEL_STATE: 'dorkos-right-panel-state',
  RIGHT_PANEL_LAYOUTS: 'dorkos-right-panel-layouts',
  PIP_PANEL_STATE: 'dorkos-pip-panel-state',
  ROOM_THREAD_WIDTH: 'dorkos-room-thread-width',
  /** Whether Settings' folded Advanced group is open (DOR-2629). */
  SETTINGS_ADVANCED_OPEN: 'dorkos-settings-advanced-open',
} as const;

/**
 * Maximum number of per-agent right-panel layout entries kept in localStorage
 * before the least-recently-used one is evicted (DOR-227). Bounds the map so a
 * user who visits hundreds of agents never grows the stored layout unbounded.
 */
export const MAX_RIGHT_PANEL_LAYOUTS = 50;

/**
 * Maximum number of documents kept open in a single session's canvas before the
 * least-recently-active one is evicted (multi-document canvas, DOR-219).
 *
 * The SERVER enforces this now — it owns the table — and this is the window's
 * matching bound, so an optimistic open evicts the same document the server is
 * about to. The two numbers must agree: `MAX_CANVAS_DOCUMENTS` in
 * `services/canvas/canvas-service.ts` is the other half.
 */
export const MAX_CANVAS_DOCUMENTS = 12;

export const FONT_SCALE_MAP: Record<'small' | 'medium' | 'large', string> = {
  small: '0.9',
  medium: '1',
  large: '1.15',
};

export const MAX_RECENT_CWDS = 10;

export const TIMING = {
  /** Highlight duration for newly created sessions (ms). */
  NEW_SESSION_HIGHLIGHT_MS: 300,
  /** Auto-close sidebar on mobile after session create (ms). */
  SIDEBAR_AUTO_CLOSE_MS: 300,
  /** Auto-hide completed tool calls after this delay (ms). */
  TOOL_CALL_AUTO_HIDE_MS: 5_000,
  /** Major celebration overlay display time (ms). */
  CELEBRATION_DISPLAY_MS: 2000,
  /** How long the chat status strip keeps showing a finished turn's summary before it fades (ms). */
  TURN_COMPLETE_DISMISS_MS: 8000,
  /** Long-press detection threshold (ms). */
  LONG_PRESS_MS: 500,
  /** Minimum elapsed stream time before triggering done callback (ms). */
  MIN_STREAM_DURATION_MS: 3000,
  /** Staleness timeout for relay streaming — if no SSE events arrive within this window, poll for completion (ms). */
  DONE_STALENESS_MS: 15_000,
  /**
   * Watchdog for a triggered turn that never starts (CLI-B7): if no
   * `turn_start` arrives within this window after the 202, the trigger-pending
   * latch is released so the composer is not wedged in queue mode by a turn
   * the server silently dropped.
   */
  TRIGGER_PENDING_TIMEOUT_MS: 15_000,
} as const;

/**
 * How far a pointer may drift during a hold before it stops being a hold, in
 * CSS pixels. The distance half of {@link TIMING.LONG_PRESS_MS}.
 *
 * A finger resting on a screen never sits perfectly still, so zero would mean
 * no touch device could ever long-press. Past this, the gesture is a scroll or
 * a text selection the reader has already begun.
 *
 * Compared per axis (Chebyshev distance) rather than as a true radius: it costs
 * no square root, and the shape the reader perceives — "did my finger stay put?"
 * — is not precise enough for the corners of the square to be noticeable.
 */
export const LONG_PRESS_DRIFT_PX = 10;

export const SSE_RESILIENCE = {
  /** Client heartbeat watchdog timeout — 3x server heartbeat interval (ms). */
  HEARTBEAT_TIMEOUT_MS: 45_000,
  /** Exponential backoff base delay (ms). */
  BACKOFF_BASE_MS: 500,
  /** Exponential backoff maximum delay (ms). */
  BACKOFF_CAP_MS: 30_000,
  /** Grace period before closing SSE when tab is hidden (ms). */
  VISIBILITY_GRACE_MS: 30_000,
  /** Consecutive failures before entering 'disconnected' state. */
  DISCONNECTED_THRESHOLD: 5,
  /** Delay before auto-retrying a failed POST chat stream (ms). */
  POST_RETRY_DELAY_MS: 2_000,
  /** Maximum auto-retries for transient POST stream failures. */
  POST_MAX_RETRIES: 1,
  /** Time connected before resetting failure counter (ms). */
  STABILITY_WINDOW_MS: 10_000,
} as const;

/** Time conversion constants (milliseconds). */
export const TIME_UNITS = {
  MS_PER_MINUTE: 60_000,
  MS_PER_HOUR: 3_600_000,
} as const;

export const QUERY_TIMING = {
  /** Default TanStack Query staleTime (ms). */
  DEFAULT_STALE_TIME_MS: 30_000,
  /** Default TanStack Query retry count. */
  DEFAULT_RETRY: 1,
  /** Active-tab message polling interval (ms). */
  ACTIVE_TAB_REFETCH_MS: 3000,
  /** Background-tab message polling interval (ms). */
  BACKGROUND_TAB_REFETCH_MS: 10_000,
  /** Command registry staleTime (ms). */
  COMMANDS_STALE_TIME_MS: 5 * 60 * 1000,
  /** Command registry garbage collection time (ms). */
  COMMANDS_GC_TIME_MS: 30 * 60 * 1000,
  /** File list staleTime (ms). */
  FILES_STALE_TIME_MS: 5 * 60 * 1000,
  /** File list garbage collection time (ms). */
  FILES_GC_TIME_MS: 30 * 60 * 1000,
  /** File-explorer directory-listing staleTime (ms) — instant within a page session. */
  FILE_TREE_STALE_TIME_MS: 30_000,
  /** File-explorer directory-listing garbage collection time (ms). */
  FILE_TREE_GC_TIME_MS: 30 * 60_000,
  /** Git status refetch interval (ms). */
  GIT_STATUS_REFETCH_MS: 10_000,
  /** Git status staleTime (ms). */
  GIT_STATUS_STALE_TIME_MS: 5_000,
  /** Message history staleTime (ms). */
  MESSAGE_STALE_TIME_MS: 0,
} as const;

export const CELEBRATIONS = {
  /** Debounce window for rapid task completions (ms). */
  DEBOUNCE_WINDOW_MS: 2000,
  /** Number of completions in window to trigger debounce. */
  DEBOUNCE_THRESHOLD: 3,
  /** Probability of mini celebration on single task complete. */
  MINI_PROBABILITY: 0.3,
  /** Minimum completed tasks for a major celebration. */
  MIN_TASKS_FOR_MAJOR: 3,
  /** Idle timeout for celebration engine (ms). */
  IDLE_TIMEOUT_MS: 30_000,
} as const;

// ---------------------------------------------------------------------------
// Settings tabs
// ---------------------------------------------------------------------------

/** The Settings tabs DorkOS itself ships — every {@link SettingsTab} but an extension's. */
export type BuiltInSettingsTab =
  | 'profile'
  | 'account'
  | 'appearance'
  | 'preferences'
  | 'notifications'
  | 'server'
  | 'tools'
  | 'security'
  | 'remote-access'
  | 'runtimes'
  | 'rooms'
  | 'connections'
  | 'permissions'
  | 'privacy'
  | 'danger'
  | 'experiments';

/** The sidebar group that starts folded, at the bottom of Settings (DOR-2629). */
export const SETTINGS_ADVANCED_GROUP = 'Advanced';

/** One built-in Settings tab, as every door into it names it. */
export interface SettingsTabEntry {
  /** The id `?settings=` links and `open(tab)` calls are minted with. Never renamed. */
  id: BuiltInSettingsTab;
  /** What the sidebar, the panel header and the command palette call it. */
  label: string;
  /** The sidebar group it sits under. */
  group: 'You' | 'Agents' | 'This computer' | typeof SETTINGS_ADVANCED_GROUP;
}

/**
 * The built-in Settings tabs, in sidebar order — the one list the dialog and
 * the command palette both read, so a tab cannot be renamed in one and not the
 * other.
 *
 * You, Agents and This computer are the eleven everyday tabs. Advanced folds
 * away the five most people set once or never; folding is not hiding, since
 * every one keeps its id and so its links.
 */
export const SETTINGS_TAB_DIRECTORY: readonly SettingsTabEntry[] = [
  // `profile` is what the profile drawer's Edit button deep-links to.
  { id: 'profile', label: 'Profile', group: 'You' },
  // The DorkOS account's one home, directly after Profile: who you are, then
  // the account attached to you (DOR-2628).
  { id: 'account', label: 'DorkOS account', group: 'You' },
  { id: 'appearance', label: 'Appearance', group: 'You' },
  { id: 'preferences', label: 'Preferences', group: 'You' },
  // "How loud may this be?" is a personal preference, not a system question.
  { id: 'notifications', label: 'Notifications', group: 'You' },
  { id: 'runtimes', label: 'Runtimes', group: 'Agents' },
  // What agents may do, for everyone — the answer to "why did my agent ask".
  { id: 'permissions', label: 'Permissions', group: 'Agents' },
  // How DorkOS reaches your apps; the Connections page is for the apps.
  { id: 'connections', label: 'Connections', group: 'Agents' },
  // The local half of what was the Access tab (DOR-2628).
  { id: 'security', label: 'Login & security', group: 'This computer' },
  { id: 'remote-access', label: 'Remote access', group: 'This computer' },
  { id: 'privacy', label: 'Privacy & Data', group: 'This computer' },
  { id: 'server', label: 'Server', group: SETTINGS_ADVANCED_GROUP },
  { id: 'tools', label: 'Tools', group: SETTINGS_ADVANCED_GROUP },
  // Only the DEFAULTS every room follows: each room keeps its own limits in
  // its own panel. The id stays `rooms` for old links.
  { id: 'rooms', label: 'Room limits', group: SETTINGS_ADVANCED_GROUP },
  // A place to try things; every flag keeps a direct link (DOR-1304).
  { id: 'experiments', label: 'Experiments', group: SETTINGS_ADVANCED_GROUP },
  // Only the three actions you cannot take back by hand (DOR-1758).
  { id: 'danger', label: 'Danger zone', group: SETTINGS_ADVANCED_GROUP },
];
