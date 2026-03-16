/** Client-only constants — localStorage keys, font scales, and UI limits. */

export const STORAGE_KEYS = {
  FONT_SIZE: 'dorkos-font-size',
  FONT_FAMILY: 'dorkos-font-family',
  RECENT_CWDS: 'dorkos-recent-cwds',
  PICKER_VIEW: 'dorkos-picker-view',
  GESTURE_HINT_COUNT: 'dorkos-gesture-hint-count',
} as const;

export const FONT_SCALE_MAP: Record<'small' | 'medium' | 'large', string> = {
  small: '0.9',
  medium: '1',
  large: '1.15',
};

export const MAX_RECENT_CWDS = 10;

export const TIMING = {
  /** Feedback delay after clipboard copy (ms). */
  COPY_FEEDBACK_MS: 1500,
  /** Highlight duration for newly created sessions (ms). */
  NEW_SESSION_HIGHLIGHT_MS: 300,
  /** Auto-close sidebar on mobile after session create (ms). */
  SIDEBAR_AUTO_CLOSE_MS: 300,
  /** Auto-hide completed tool calls after this delay (ms). */
  TOOL_CALL_AUTO_HIDE_MS: 5_000,
  /** Major celebration overlay display time (ms). */
  CELEBRATION_DISPLAY_MS: 2000,
  /** Gesture hint auto-dismiss delay (ms). */
  GESTURE_HINT_DISMISS_MS: 4000,
  /** Long-press detection threshold (ms). */
  LONG_PRESS_MS: 500,
  /** Minimum elapsed stream time before triggering done callback (ms). */
  MIN_STREAM_DURATION_MS: 3000,
  /** Auto-clear session busy state after this delay (ms). */
  SESSION_BUSY_CLEAR_MS: 5000,
  /** Staleness timeout for relay streaming — if no SSE events arrive within this window, poll for completion (ms). */
  DONE_STALENESS_MS: 15_000,
  /** Auto-dismiss duration for ephemeral system status messages. */
  SYSTEM_STATUS_DISMISS_MS: 4_000,
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
  /** Session list refetch interval (ms). */
  SESSIONS_REFETCH_MS: 60_000,
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
