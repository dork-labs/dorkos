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
   * Approximate per-session byte budget across both capture rings (measured as
   * serialized-JSON chars of the retained entries). The count caps alone don't
   * bound memory — the schema permits ~56 KB per console entry, so 500 max-size
   * entries would retain ~28 MB. Past the budget, the oldest entries evict
   * first. A typical noisy page retains a few hundred KB at most, so 1 MB never
   * trims legitimate captures.
   */
  DEVTOOLS_SESSION_MAX_BYTES: 1_048_576,
  /**
   * Screenshots are single-slot (latest wins), filled by the on-demand
   * `browser_screenshot` round-trip. Size-bounded by its own ingest cap
   * (`DEVTOOLS_SCREENSHOT_MAX_CHARS` in `@dorkos/shared`), not the shared
   * session byte budget.
   */
  DEVTOOLS_SCREENSHOT_BUFFER: 1,
  /**
   * How long `browser_screenshot` waits (ms) for the capture round-trip
   * (SSE → client → frame rasterize → ingest) before returning a structured
   * "couldn't capture" note. Rasterizing a large page takes ~1-3 s; 8 s leaves
   * headroom without letting the agent's tool call hang noticeably.
   */
  DEVTOOLS_SCREENSHOT_TIMEOUT_MS: 8_000,
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

export const DIFF = {
  /**
   * Total bytes of pre-edit baselines one session may hold in memory (DOR-212).
   * Individual files are already capped at `FILE_LIMITS.MAX_TEXT_FILE_BYTES`;
   * this bounds the aggregate when an agent edits many files. Past the budget
   * the OLDEST baselines are evicted — their later diffs degrade to the
   * (disclosed) git-HEAD/empty base instead of growing the server without bound.
   */
  MAX_SESSION_BASELINE_BYTES: 32 * 1024 * 1024,
} as const;

export const SSE = {
  /** Max concurrent readers of the global broadcast stream. */
  MAX_TOTAL_CLIENTS: 500,
  /** Server keepalive interval for durable streams (ms). */
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
   * every StreamEvent; suspended while the session holds a live pending
   * interaction (an approval, question or elicitation can legitimately sit for
   * as long as the person takes, bounded by INTERACTION_TIMEOUT_MS).
   * Trade-off: a legitimately silent tool run longer than this is interrupted.
   */
  TURN_STALL_TIMEOUT_MS: 10 * 60 * 1000,
  /**
   * How long the stall watchdog waits for the runtime's interrupt to settle
   * before closing the turn anyway (DOR-782). `interruptQuery` reaches a
   * possibly-wedged subprocess, so the call that is meant to unstick a hung turn
   * can itself hang — leaving the turn frozen at `streaming`, the lock held, and
   * the stream silent, which is the exact state the watchdog exists to end.
   * Generous enough that a slow-but-working abort still reports its real outcome.
   */
  STALL_INTERRUPT_TIMEOUT_MS: 30 * 1000,
} as const;

export const TRANSCRIPT = {
  /**
   * Bytes to read from a transcript's tail for its latest status.
   *
   * Sized by the field with the FARTHEST-BACK answer: `userLastMessageAt`, the
   * time the person last wrote (BC-16). The other readings this window feeds —
   * model, permission mode, context tokens — sit in the last few records and
   * were satisfied by 16 KB; the person's last turn is a whole agent work
   * session further back. Measured over 474 real transcripts, the distance from
   * EOF to the last person-authored record is p50 27 KB / p75 47 KB, so 16 KB
   * answered only 11% of conversations (5.6% of those touched in the last week)
   * while 64 KB answers 84% (89.7% in the last week).
   *
   * Growing it is safe for the other readings by construction: every one of
   * them is last-occurrence-wins, so a wider window can never change which
   * record is last — it can only find one that was previously out of reach.
   * `lastAutoCompactAt` is the one that gains from that, and gaining coverage
   * is what its own doc already calls the disclosed limitation.
   */
  TAIL_BUFFER_BYTES: 65536,
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

export const ROOMS = {
  /**
   * How many trailing entries a cold `GET /api/rooms/:id/events` connect
   * hydrates with. The log itself is never trimmed — this bounds the opening
   * frame, not the record. Older history comes back through
   * `GET /api/rooms/:id/entries?before=<seq>` as the reader scrolls.
   */
  SNAPSHOT_HISTORY_LIMIT: 100,
} as const;
