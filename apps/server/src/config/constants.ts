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
  /**
   * Max size (bytes) the workbench text-content route (`GET /api/files/content`)
   * will read into memory. Larger files are rejected with 413 — the CodeMirror
   * viewer is not for multi-megabyte blobs.
   */
  MAX_TEXT_FILE_BYTES: 5 * 1024 * 1024,
} as const;

export const WORKBENCH = {
  /**
   * TTL (ms) of a signed workbench serve/proxy URL (DOR-216, ADR 260708-185519).
   * Short-lived by design: the token — a bearer credential embedded in the URL
   * path — authorizes the opaque-origin browser frame instead of cookie/header
   * auth, so it must expire. It still has to outlive a working preview (relative-
   * asset fetches reuse the same token), and the client re-mints on reload, so an
   * expired token is recoverable. 30 minutes keeps the bearer window tight while
   * not breaking an open preview mid-session.
   */
  SIGNED_URL_TTL_MS: 30 * 60 * 1000,
  /** Request timeout (ms) when the localhost proxy calls the dev server. */
  PROXY_TIMEOUT_MS: 30 * 1000,
  /**
   * DevTools capture ring-buffer caps per session (DOR-213). Bounded so memory
   * is O(cap), not O(page lifetime): once full, the oldest entry is dropped.
   * Console keeps more than network because a noisy page logs far more lines
   * than it makes requests.
   */
  DEVTOOLS_CONSOLE_BUFFER: 500,
  DEVTOOLS_NETWORK_BUFFER: 200,
  /**
   * Screenshots are single-slot (latest wins). The slot exists now; the capture
   * round-trip that fills it lands with `browser_screenshot` in a follow-up.
   */
  DEVTOOLS_SCREENSHOT_BUFFER: 1,
  /**
   * Max sessions holding a live capture buffer. A side store keyed by session id
   * is dropped on session close, but this caps it against leaks (a client that
   * relays then vanishes) by evicting the least-recently-updated buffer.
   */
  DEVTOOLS_MAX_SESSIONS: 50,
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
  /**
   * Per-client buffered-bytes ceiling for the broadcast fan-out. A client whose
   * socket stays congested past this is destroyed (it auto-reconnects) rather
   * than buffering server memory without bound.
   */
  MAX_BUFFERED_BYTES: 1_048_576,
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
  /**
   * Inactivity window before a detached turn is declared stalled: the watchdog
   * interrupts the runtime and closes the turn with a typed error. Resets on
   * every StreamEvent; suspended while the session lifecycle is 'blocked'
   * (a pending approval or question can legitimately sit for hours).
   * Trade-off: a legitimately silent tool run longer than this is interrupted.
   */
  TURN_STALL_TIMEOUT_MS: 10 * 60 * 1000,
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
