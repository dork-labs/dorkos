/** Server-only constants — timeouts, limits, and tuning parameters. */

export const INTERVALS = {
  /** How often to run session health checks (ms). */
  HEALTH_CHECK_MS: 5 * 60 * 1000,
} as const;

export const FILE_LIMITS = {
  /** Max buffer for `git ls-files` output (bytes). */
  GIT_MAX_BUFFER: 10 * 1024 * 1024,
  /** Max recursion depth for readdir fallback. */
  MAX_READDIR_DEPTH: 8,
} as const;

export const WATCHER = {
  /** chokidar awaitWriteFinish stabilityThreshold (ms). */
  STABILITY_THRESHOLD_MS: 50,
  /** chokidar awaitWriteFinish pollInterval (ms). */
  POLL_INTERVAL_MS: 25,
  /** Debounce interval for file-change broadcasts (ms). */
  DEBOUNCE_MS: 100,
} as const;

export const GIT = {
  /** Timeout for `git status` commands (ms). */
  STATUS_TIMEOUT_MS: 5000,
} as const;

export const SSE = {
  /** Max SSE clients connected to a single session. */
  MAX_CLIENTS_PER_SESSION: 10,
  /** Max total SSE clients across all sessions. */
  MAX_TOTAL_CLIENTS: 500,
  /** Server keepalive interval for SSE connections (ms). */
  HEARTBEAT_INTERVAL_MS: 15_000,
} as const;

export const SESSIONS = {
  /** In-memory session expiry (ms). */
  TIMEOUT_MS: 30 * 60 * 1000,
  /** Session write-lock TTL (ms). */
  LOCK_TTL_MS: 5 * 60 * 1000,
  /** Interactive tool approval/question timeout (ms). */
  INTERACTION_TIMEOUT_MS: 10 * 60 * 1000,
  /** Maximum number of concurrent in-memory sessions. */
  MAX_SESSIONS: 50,
} as const;

export const TRANSCRIPT = {
  /** Bytes to read from file tail for latest status. */
  TAIL_BUFFER_BYTES: 16384,
  /** Bytes to read from file head for metadata. */
  HEAD_BUFFER_BYTES: 8192,
  /** Max characters for session title. */
  TITLE_MAX_LENGTH: 80,
  /** Characters to show from session ID in fallback title. */
  SESSION_ID_PREVIEW_LENGTH: 8,
} as const;

export const FILE_LISTING = {
  /** Maximum files returned by file lister. */
  MAX_FILES: 10_000,
  /** File list cache TTL (ms). */
  CACHE_TTL_MS: 5 * 60 * 1000,
  /** Directories excluded from recursive readdir. */
  EXCLUDED_DIRS: new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    '.next',
    'coverage',
    '__pycache__',
    '.cache',
  ]),
} as const;
