/** Server-only constants — timeouts, limits, and tuning parameters. */

export const INTERVALS = {
  /** How often to run session health checks (ms). */
  HEALTH_CHECK_MS: 5 * 60 * 1000,
  /**
   * How often to ask whether today's database snapshot has been taken (ms).
   *
   * The snapshot itself is once per UTC day; this is only the tick that notices
   * the day has turned. Hourly rather than daily so a server started at 23:50
   * does not wait until the following evening for its first one, and so nothing
   * here has to work out when midnight is.
   */
  DAILY_SNAPSHOT_CHECK_MS: 60 * 60 * 1000,
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
   * TTL (ms) of a signed workbench token (DOR-216, DOR-1260).
   *
   * Short-lived by design: the token is a bearer credential that authorizes a
   * frame the API's own auth cannot reach — carried in the URL path for a
   * `serve` frame (opaque origin, no credentials) and in a cookie on the preview
   * listener for a dev server (a separate port, not the API). Either way it has
   * to expire.
   *
   * It also has to outlive a working preview, since every asset the page fetches
   * reuses it. 30 minutes keeps the bearer window tight; the client re-mints on
   * every navigation and reload, so an expired token is always recoverable by
   * reloading.
   */
  SIGNED_URL_TTL_MS: 30 * 60 * 1000,
  /** Request timeout (ms) when a preview listener calls the dev server it fronts. */
  PROXY_TIMEOUT_MS: 30 * 1000,
  /**
   * How long a dev-server preview listener stays open with no requests before it
   * gives its port back (DOR-1260).
   *
   * Long enough to survive reading a page, switching tabs and coming back —
   * reopening is invisible but re-mints the frame, which reloads it. Short
   * enough that a laptop left running overnight is not still holding a bound
   * port for a dev server that stopped hours ago.
   *
   * The same number as {@link SIGNED_URL_TTL_MS}, but NOT the same clock, and
   * the difference shows: this one restarts on every request (and never runs at
   * all while a live-reload socket is open), while the token's expiry is
   * absolute from the moment it was minted. So a preview left open and in use
   * keeps its listener and loses its token — at 30 minutes its next request
   * meets the "this preview link has expired" page, and reloading the canvas
   * mints a fresh one. Deliberate: an unbounded bearer credential would be the
   * worse trade.
   */
  PREVIEW_IDLE_TTL_MS: 30 * 60 * 1000,
  /**
   * How much of an HTML preview response may be held in memory to inject the
   * DevTools shim into it (DOR-1260).
   *
   * The shim has to go in before the page's first script runs, which means
   * buffering the document rather than streaming it. "An HTML document" is
   * whatever the dev server labels one, though, and a generated report or a
   * data-URI-heavy artifact can be tens of megabytes. Past this cap the response
   * streams through uninstrumented instead — the same disclosed degradation a
   * page declaring a non-UTF-8 charset already gets. 5 MB is far above any real
   * app shell and far below anything that would trouble the server.
   */
  PREVIEW_HTML_INJECT_MAX_BYTES: 5 * 1024 * 1024,
  /**
   * How long the loopback port probe waits for a connection before answering
   * "nothing is listening". A connection to a port on this same machine either
   * completes or is refused within a millisecond or two, so this is a ceiling
   * for a wedged socket, not a budget — and it runs before every dev-server
   * preview, so it has to stay well under the time a person would notice.
   */
  PROBE_TIMEOUT_MS: 1000,
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
  /**
   * How long an interactive tool approval/question counts down before it parks
   * (ms).
   *
   * This is no longer when the agent gives up. It is when it stops counting
   * down and starts waiting; {@link SESSIONS.INTERACTION_PARK_CEILING_MS} is
   * when it gives up (spec `ask-parks-on-timeout`).
   */
  INTERACTION_TIMEOUT_MS: 10 * 60 * 1000,
  /**
   * How long a prompt nobody answered waits before it is finally refused
   * (spec `ask-parks-on-timeout`).
   *
   * `INTERACTION_TIMEOUT_MS` above is no longer when the agent gives up; it is
   * when the agent stops counting down and starts waiting. This is when it
   * gives up. The first ten minutes look exactly as they did — a live
   * countdown, the urgency bands, "answer this now" — and past them the card
   * says the agent is waiting and the turn stays open.
   *
   * **Why there is a ceiling at all, when the SDK has none.** A held permission
   * decision is indefinite as far as the Claude Agent SDK is concerned
   * (`sdk.d.ts:196-205`). Three DorkOS bounds are not:
   *
   * 1. `SessionStateProjector.hasPendingInteractions` bounds a pending entry on
   *    purpose, because an entry CAN strand and a stranded entry read as "still
   *    waiting" would make the stall watchdog and the session write-lock
   *    immortal (DOR-782).
   * 2. A session RECORD is evicted at `TIMEOUT_MS`, which a park has to be
   *    exempt from, and an unbounded exemption is an unbounded map.
   * 3. A session parked on a person declines every warm reap
   *    (`session-pump.ts`) and only WARM pumps are reclaim candidates, so N
   *    parked sessions shrink the twelve-slot ceiling by N. At twelve, every new
   *    agent launch on the machine is refused — and the person who hits that
   *    refusal is not the person who walked away.
   *
   * **Why four hours.** Twenty-four times the countdown. It covers every failure
   * on record with a wide margin — DOR-784's forty-one minutes, a lunch, a
   * meeting, a school run — and it keeps a machine abandoned at six in the
   * evening from still holding twelve subprocesses at midnight. A number in days
   * would trade a real resource ceiling for a case nobody has reported.
   */
  INTERACTION_PARK_CEILING_MS: 4 * 60 * 60 * 1000,
  /** Maximum number of concurrent in-memory sessions. */
  MAX_SESSIONS: 50,
  /**
   * How long a WARM session's subprocess may sit with no turn open before it is
   * given back (spec `persistent-session-runtime` §4.3).
   *
   * This is **not** session eviction. `TIMEOUT_MS` retires the session RECORD
   * after 30 minutes and the person loses their place; this closes a PROCESS
   * after 5 minutes and the person cannot tell — the record, the transcript and
   * the conversation are untouched, and the next message resumes. Eviction
   * implies a reap; a reap never implies eviction.
   *
   * Five minutes is long enough that somebody thinking between turns keeps their
   * warm prompt cache, and short enough that a session abandoned mid-afternoon
   * is not still holding a CLI subprocess (and its MCP children) at dinner.
   */
  WARM_IDLE_MS: 5 * 60 * 1000,
  /**
   * How many sessions may hold a subprocess at once (spec §4.4).
   *
   * This counts PROCESSES; `MAX_SESSIONS` (50) counts session RECORDS, and the
   * two are deliberately different numbers. Fifty concurrent CLI subprocesses
   * plus their MCP children on a laptop is not a shape to ship, so warmth stops
   * at twelve while records stay at fifty — which keeps `ensureSession`'s throw
   * the genuinely exceptional path it is today.
   *
   * It is also **not** a refusal ceiling in the way `MAX_SESSIONS` is. Warmth is
   * a cache, so the thirteenth warm session does not fail: the least recently
   * used warm process is reaped to make room for it, and only a host where
   * nothing is reclaimable — every process mid-turn or parked on a person — is
   * refused.
   */
  MAX_WARM_SESSIONS: 12,
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
   * The same watchdog's window for a turn's FIRST event, which is shorter, and
   * shorter for a reason the ten minutes above cannot cover (DOR-1229).
   *
   * `TURN_STALL_TIMEOUT_MS` is generous because a running agent's quiet is often
   * honest work — a long tool call, a big read. That argument rests on evidence
   * the turn is alive, and before the first event there is none: nothing has
   * started, nothing has been spent, and there is no work to lose by giving up.
   * A launch that never yields (a runtime binary that will not start, a subprocess
   * wedged on its own boot, an MCP handshake that never completes) is a failure
   * from its first second, and ten minutes of an agent shown as "working" with
   * literally nothing having happened is not something to make anyone sit through.
   *
   * Two minutes because a real cold launch is nowhere near it: the measured
   * claude-code launch on 2026-08-16 — fresh session, MCP servers connecting, 88
   * commands and 9 subagents cached — produced its first event 4 seconds in,
   * leaving thirty times that headroom for a machine already running ten agents.
   *
   * **What that 4 seconds actually was, because it is conditional.** The SDK's
   * `system`/`init` message is the earliest thing a turn can emit, and
   * `system-event-mapper.ts` turns it into a `session_status` ONLY when that
   * message carries a model (`if (initModel)`). So on an SDK build that omits the
   * model, the first event is instead whatever the turn produces next — its first
   * assistant delta or tool call — and the margin is the model's time-to-first-
   * token rather than process boot. That is still seconds, not minutes, on every
   * runtime here; the number is sized for the slower of the two on purpose, and
   * this is the dependency to re-measure if it is ever tightened.
   *
   * A turn parked on a person cannot trip it, and not by luck: an approval,
   * question or elicitation IS an event, so a turn that has one has already left
   * this window behind.
   */
  TURN_FIRST_EVENT_TIMEOUT_MS: 2 * 60 * 1000,
  /**
   * How long a turn about to open waits for an ABANDONED turn's terminal to
   * reach the projector before opening anyway (DOR-1295).
   *
   * Only ever spent when the runtime reported that it had to end a turn nobody
   * could finish — an ordinary turn never reaches this wait. What is being
   * waited for is a stream unwinding through mappers and generators that are
   * already holding their terminal, which is microtasks; two seconds is orders
   * of magnitude of slack for a machine running ten agents, and short enough
   * that the fallback — a person's message starting a couple of seconds late —
   * beats the alternative it replaces, which was that message settling as the
   * abandoned turn's error.
   */
  STRANDED_TURN_SETTLE_MS: 2_000,
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

  /**
   * Lock identity every room-triggered turn takes. One id, not one per turn: the
   * session write-lock is per session and a room binds one session per agent, so
   * two turns for the same agent in the same room are the same writer and the
   * second must queue rather than be refused as a foreign client.
   *
   * It lives HERE rather than in `room-turn-runner.ts` because a second module
   * has to recognise it: the message dispatcher sweeps legacy queue rows written
   * under it (`adoptQueuedMessages`), and the dispatcher is the neutral ingress —
   * it must not import a room. A shared constant is the seam; see the sweep for
   * why it can only be matched by this id.
   */
  CLIENT_ID: 'dorkos-room',
} as const;
