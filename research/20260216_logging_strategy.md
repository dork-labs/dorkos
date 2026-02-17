# Logging Strategy Research — DorkOS

**Date**: 2026-02-16
**Scope**: Express server, React SPA, CLI tool (bundled npm package)
**Mode**: Deep Research

---

## Research Summary

DorkOS currently uses ad-hoc `console.log/warn/error` calls (35 occurrences across 7 server files) with no structured logging, no file persistence, and no HTTP request logging middleware. For a local developer tool that bundles into a CLI, the logging strategy is heavily constrained by **bundle complexity** — specifically, pino's worker-thread architecture makes esbuild bundling non-trivial. The best fit for DorkOS is **consola** for pretty dev output plus a lightweight custom file transport, or **winston** for a fully batteries-included solution with minimal bundle complexity.

---

## Key Findings

### 1. Bundle Complexity Is the Primary Constraint

Pino — the performance leader — uses Node.js Worker Threads internally. Bundling it with esbuild requires a custom plugin (`esbuild-plugin-pino`) that generates **multiple separate output files** (`pino-worker.js`, `pino-file.js`, `thread-stream-worker.js`) and path override injection via `globalThis.__bundlerPathsOverrides`. This is significant complexity for a CLI tool whose entire build pipeline is currently a clean 3-step esbuild process.

DorkOS's CLI build (`packages/cli/scripts/build.ts`) already works well. Pino would require restructuring that pipeline and making the `dist/` layout more complex.

### 2. Winston Is Overengineered But Bundleable

Winston (~200KB with dependencies) is significantly larger than pino (~25KB), but bundles cleanly with esbuild. It has built-in file transports, `winston-daily-rotate-file` for log rotation, colorized console output, and TypeScript types (community-maintained via `@types/winston` — though since Winston v3 types are bundled). The downside: poor defaults that require configuration effort, and it is slower than pino for high-throughput (irrelevant for a local dev tool).

### 3. Consola Is Purpose-Built for This Use Case

Consola (unjs/consola, ~5M weekly downloads, actively maintained by the UnJS ecosystem) is designed exactly for the DorkOS scenario: **developer tools that need beautiful console output in dev and pluggable structured output in production**. It has built-in fancy/basic reporter auto-switching (CI/test environments get plain output), 80% smaller core bundle via subpath exports (`consola/core`, `consola/basic`), and a custom reporter interface that can write to files. It does **not** have built-in file rotation — that requires a custom reporter or separate package.

### 4. Current Logging Gaps (Audit of Existing Code)

| Gap | Files Affected |
|-----|----------------|
| No HTTP request logging middleware | `apps/server/src/app.ts` |
| Bracketed tag strings instead of structured fields | `agent-manager.ts`, `index.ts`, `session-broadcaster.ts` |
| No log level control | All 7 files |
| No file persistence | All server files |
| Console.log in services (not infrastructure) | `agent-manager.ts` (9 calls) |
| Startup banners mixed with operational logs | `index.ts` |

---

## Detailed Analysis

### Library Comparison

| Criteria | pino | winston | consola | tslog | debug | console wrapper |
|---|---|---|---|---|---|---|
| **Weekly downloads** | ~20M | ~12M | ~5M | ~105K | ~245M | — |
| **Install size (approx)** | ~25KB | ~200KB | ~15KB core | ~40KB | ~5KB | 0 |
| **TypeScript support** | First-class (bundled types) | Community types bundled since v3 | First-class | First-class (TypeScript-native) | Community `@types/debug` | You write it |
| **esbuild bundling** | Complex (worker thread extra files + plugin) | Clean | Clean | Clean | Clean | Clean |
| **Structured JSON output** | Yes (primary mode) | Yes (JSON format) | Via custom reporter | Yes (configurable) | No (string labels only) | You build it |
| **Pretty dev console** | Via pino-pretty (extra dep) | Via winston formats | Built-in fancy reporter | Built-in | Namespaced colorized output | You build it |
| **File transport** | Via pino-file / pino-roll | Built-in + winston-daily-rotate-file | Via custom reporter only | Via custom transport only | No | You build it |
| **Log rotation** | pino-roll (separate package) | winston-daily-rotate-file (separate package) | No built-in | No built-in | No | No |
| **Log levels** | trace/debug/info/warn/error/fatal | error/warn/info/http/verbose/debug/silly | fatal/error/warn/log/info/success/debug/trace/verbose | silly/trace/debug/info/warn/error/fatal | Namespace-based on/off | You define |
| **Request logging** | pino-http middleware | express-winston | No built-in | No built-in | No | No |
| **Maintenance (2025-2026)** | Active (v10.3.1, weekly releases) | Active (v3.18.3) | Active (UnJS ecosystem) | Active | Active (but minimal scope) | N/A |
| **Child logger / context** | Yes (built-in child()) | Yes (child()) | Via createConsola() with tag | Yes | Partial (ns extend) | You build it |

### Performance Note

Pino is 5-10x faster than Winston in benchmarks. This is meaningless for DorkOS — it's a local developer tool running one session at a time, not a high-throughput API server. Performance is not a selection criterion.

### The esbuild Bundling Problem With Pino

Pino's internal worker thread architecture means esbuild cannot produce a single-file bundle. The DorkOS CLI currently bundles to:
- `dist/bin/cli.js` (entry with shebang)
- `dist/server/index.js` (bundled server)
- `dist/client/` (React SPA)

Adding pino would require adding to `dist/`:
- `pino-worker.js`
- `pino-file.js`
- `thread-stream-worker.js`
- `pino-pretty.js` (if dev pretty-print desired)

Plus `globalThis.__bundlerPathsOverrides` injection. This is a material increase in build complexity for marginal benefit given the use case.

### Consola's Custom Reporter Pattern (File Logging)

Since consola has no built-in file transport, file logging requires a custom reporter:

```typescript
import { createConsola } from 'consola/core';
import { appendFileSync } from 'fs';

const fileReporter = {
  log(logObj: LogObject) {
    const line = JSON.stringify({
      level: logObj.type,
      time: new Date(logObj.date).toISOString(),
      msg: logObj.args.join(' '),
      tag: logObj.tag,
    });
    appendFileSync('/path/to/dorkos.log', line + '\n');
  }
};

export const logger = createConsola({
  reporters: [
    defaultReporter, // pretty console
    fileReporter,    // JSON to disk
  ]
});
```

This is ~20 lines of code and avoids adding another dependency for file I/O.

### Winston's Self-Contained Approach

Winston handles everything in one package install:

```typescript
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'development'
        ? winston.format.combine(winston.format.colorize(), winston.format.simple())
        : winston.format.json()
    }),
    new DailyRotateFile({
      filename: '~/.dork/logs/dorkos-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '7d',
      maxSize: '10m',
      zippedArchive: false,
    }),
  ],
});
```

More config boilerplate upfront, but completely self-contained with known behavior.

---

## Log Storage Patterns

### Where Should Log Files Live?

For a developer tool that already uses `~/.dork/` for config storage, the natural location is:

```
~/.dork/
├── config.json          # existing
└── logs/
    ├── dorkos.log        # current/today's log
    ├── dorkos-2026-02-15.log  # rotated
    └── dorkos-2026-02-14.log  # rotated
```

**Why `~/.dork/logs/` over alternatives:**
- `~/.local/state/dorkos/` — XDG Base Directory spec standard for state/logs on Linux. Valid choice but over-engineered for a tool targeting macOS-first developers.
- `/var/log/` — System logs, requires elevated permissions on macOS, not appropriate.
- `./logs/` (relative to CWD) — Would scatter logs across projects. Wrong.
- `~/.dork/logs/` — Co-located with config, users know where to look, `~/.dork/` already exists.

The CLI already creates `~/.dork/` via `fs.mkdirSync(DORK_HOME, { recursive: true })`. Extending this to create `~/.dork/logs/` on startup is trivial.

### Log Rotation Policy for a Local Dev Tool

| Policy | Recommendation | Rationale |
|--------|---------------|-----------|
| **Rotation frequency** | Daily | Simple, predictable, low overhead |
| **Max file size** | 10MB per file | Prevents runaway single sessions from filling disk |
| **Retention** | 7 days | Enough for debugging recent issues without hoarding |
| **Compression** | No | Adds complexity for marginal benefit on local disk |
| **Single vs split by level** | Single file | Simplest to `tail`, grep, and reason about |

For a local developer tool on macOS, even without rotation the logs will rarely exceed a few MB per day (DorkOS handles one user, not thousands of requests). Rotation is a convenience, not a necessity.

### Log Level Strategy

```
FATAL  — Server crash, unrecoverable
ERROR  — Request failures, service errors (always logged)
WARN   — Degraded state, recoverable problems, config warnings
INFO   — Startup/shutdown, session lifecycle events
DEBUG  — Per-request details, tool call routing (development only)
TRACE  — SDK events, SSE stream internals (deep debugging only)
```

Default production level: `INFO`. Default dev level: `DEBUG`.

---

## Express HTTP Request Logging

### Morgan vs pino-http vs Custom Middleware

| Option | Fit for DorkOS |
|--------|---------------|
| **morgan** | Reasonable for simple access logs. Outputs combined/common Apache format (not JSON). Not maintained by an active team as of 2025. Cannot log custom fields. |
| **pino-http** | Best JSON request logging, integrates pino's child logger for request context. Requires pino as base — brings the bundling problem. |
| **Custom middleware** | ~15 lines, logs exactly what's needed, no extra dependency, integrates with whatever logger is chosen. |

**Recommendation**: Custom middleware using the chosen logger. For DorkOS's needs (local dev tool), a simple middleware logging `[method] [path] [status] [duration]ms` is entirely sufficient.

```typescript
// Example: 5-line Express request logger using any logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
    }, 'request');
  });
  next();
});
```

### What Fields Matter

| Field | Reason |
|-------|--------|
| `method` | GET/POST/DELETE |
| `path` | Route (not full URL — avoids logging query params with potential sensitive data) |
| `status` | HTTP status code |
| `ms` | Response time in milliseconds |
| `sessionId` | When available from params (req.params.id) |

**Omit**: `body`, `headers`, `query` — these may contain sensitive data (API keys, auth tokens) and are rarely needed for local debugging.

**Separate from operational logs?**: No. Request logs at `DEBUG` or `INFO` level can go to the same file. The volume on a local tool is negligible.

---

## Client-Side Logging (React SPA)

### Is It Worth It for a Dev Tool?

**Short answer: No for file logging, Yes for error boundaries.**

DorkOS is a developer-facing tool — users can open DevTools themselves. A full client-side logging infrastructure (capture, serialize, send to server) adds complexity without proportional value.

**What IS worth implementing:**

1. **React Error Boundary** — Catch rendering errors and display a helpful fallback UI. React 19 added `onUncaughtError` and `onCaughtError` hooks at the root level. Use `react-error-boundary` library or a manual class component.

2. **Console capture for bug reports** — If a user wants to file a bug, a "Copy debug info" button that captures recent `console.error` calls is useful. This does not require a logging library.

3. **What to skip**: Sending client logs to the server, localStorage-based log buffers, client-side log files.

### React Error Boundary Pattern (React 19)

```typescript
// Root-level in main.tsx
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ReactRoot
      onUncaughtError={(error, errorInfo) => {
        console.error('[DorkOS] Uncaught React error:', error, errorInfo);
      }}
    >
      <App />
    </ReactRoot>
  </React.StrictMode>
);
```

---

## Structured Logging Best Practices

### Log Format — What Every Entry Should Include

```json
{
  "level": "info",
  "time": "2026-02-16T10:30:00.000Z",
  "msg": "Session created",
  "sessionId": "abc-123",
  "service": "agent-manager",
  "pid": 12345
}
```

**Required fields**: `level`, `time`, `msg`
**Contextual fields**: `sessionId`, `service`, `method`, `path`, `status`, `ms`
**Never include**: API keys, auth tokens, file contents, user messages (privacy), `req.body`

### Structured Logging vs. Current Pattern

Current DorkOS pattern (opaque, grep-unfriendly):
```
console.log('[sendMessage] session=abc-123 permissionMode=default hasStarted=true resume=N/A')
```

Structured replacement:
```typescript
logger.debug({ sessionId, permissionMode, hasStarted }, 'sendMessage');
```

The structured form is:
- Greppable by field value: `grep '"sessionId":"abc-123"'`
- Filterable by level programmatically
- Compatible with log aggregators if DorkOS ever runs in a shared environment

### Request Correlation / Trace IDs

For a local single-user tool, correlation IDs provide minimal value. They become important in distributed systems or multi-user deployments.

**When to add them**: If DorkOS gains multi-user support (shared team server, cloud deployment), add correlation IDs via `express-trace-id` or `AsyncLocalStorage`. For now, `sessionId` in log entries is sufficient correlation.

### Sensitive Data

DorkOS specific risks:
- `req.body` may contain user messages sent to Claude (privacy-sensitive)
- Config endpoints may expose ngrok auth tokens
- Session transcripts contain full conversation history

**Rule**: Never log `req.body` in HTTP middleware. Log only structured metadata (method, path, status, duration).

---

## CLI Logging Strategy

### The Two-Channel Approach

CLI tools should maintain two distinct output channels:

| Channel | Purpose | Target |
|---------|---------|--------|
| **User-facing output** (stdout) | Startup banners, status messages, update notices | Always printed |
| **Operational logs** (file) | Service events, request logs, errors | `~/.dork/logs/dorkos.log` |

Current `cli.ts` mixes these: `console.log` handles both the startup banner (`DorkOS v1.x.x / Local: http://localhost:4242`) and operational errors. This is acceptable for a CLI tool — the separation only matters if you want `dorkos 2>/dev/null` to silence operational noise without suppressing the startup URL.

**How similar tools handle this:**
- **npm**: Writes operational logs to `~/.npm/_logs/` (rotating), prints user-facing to stderr. Two explicit channels.
- **Vite/Turbo**: Pretty console output only, no file logging. Relies on terminal scrollback.
- **pnpm/yarn**: Pretty console only, level-controlled via `--loglevel`.

**Recommendation for DorkOS**: Adopt the two-channel approach:
1. Keep `console.log` for user-facing startup banner (already works well)
2. Route operational server logs through the chosen logger to `~/.dork/logs/`
3. Add `--log-level` CLI flag (or honor `LOG_LEVEL` env var) for verbosity control

---

## Recommendation

### Primary Recommendation: Consola + Custom File Reporter

**Rationale**: DorkOS is a developer tool with a bundled CLI. Consola:
- Bundles cleanly with esbuild (no worker thread complexity)
- Has beautiful built-in pretty output for dev (fancy reporter)
- Automatically switches to plain output in CI/tests
- Has ~5M weekly downloads and active UnJS maintenance
- `consola/core` subpath export minimizes bundle impact
- File logging requires ~20 lines of custom reporter code — acceptable

**What to add alongside consola**:
- Custom file reporter writing NDJSON to `~/.dork/logs/dorkos.log`
- Simple log rotation: check file size at startup, rename if >10MB, keep last 7
- Custom Express middleware for request logging (5 lines, no extra dep)
- `LOG_LEVEL` env var support (default: `info` in prod, `debug` in dev)

### Alternative: Winston

Use winston if:
- You want batteries-included log rotation without writing custom code
- The team prefers established patterns over newer UnJS ecosystem tools
- You need multiple output destinations with different formats per destination

Winston's larger bundle size (~200KB vs ~15KB for consola) is acceptable since both are server-only and not bundled into the React SPA.

### What to Avoid

- **pino**: Excellent library, wrong fit due to esbuild bundling complexity
- **tslog**: Low adoption (105K weekly downloads vs 5M+), file logging requires custom work same as consola but without consola's pretty output advantage
- **debug**: Not a structured logger, just namespaced console filtering. Useful as a complement but not a replacement
- **No library (raw console)**: Current state — functional but loses structured fields, level control, and file persistence

### Implementation Roadmap

**Phase 1 — Minimal (1-2 hours)**
- Create `apps/server/src/lib/logger.ts` with consola or winston instance
- Export a named `logger` singleton
- Replace all `console.log/warn/error` in server files with `logger.info/warn/error`
- Add structured fields to key log calls (sessionId, method, etc.)

**Phase 2 — File Logging (2-3 hours)**
- Add custom file reporter (consola) or winston DailyRotateFile transport
- Create `~/.dork/logs/` directory at CLI startup
- Add `LOG_LEVEL` env var support

**Phase 3 — HTTP Request Logging (1 hour)**
- Add custom Express middleware in `app.ts`
- Log method, path, status, duration at `DEBUG` level

**Phase 4 — CLI Integration (1 hour)**
- Keep startup banner as `console.log` (intentional user output)
- Route server operational logs to file only in production CLI mode
- Add `--log-level` flag to `cli.ts`

---

## Sources & Evidence

- "Pino is up to 5x faster than Winston" — [Pino vs Winston comparison, Better Stack](https://betterstack.com/community/comparisons/pino-vs-winston/)
- "Winston has a significantly larger footprint at ~200KB+ with dependencies, while Pino is notably more compact at ~25KB" — [Better Stack Pino vs Winston](https://betterstack.com/community/comparisons/pino-vs-winston/)
- "Pino offers first-class TypeScript support, whereas Winston relies on community-maintained types" — [Better Stack Pino vs Winston](https://betterstack.com/community/comparisons/pino-vs-winston/)
- "it is not possible to bundle Pino *without* generating additional files" — [Pino bundling docs](https://github.com/pinojs/pino/blob/main/docs/bundling.md)
- "esbuild-plugin-pino is the esbuild plugin to generate extra pino files for bundling... pino-worker.js, pino-file.js, thread-stream-worker.js" — [esbuild-plugin-pino](https://github.com/wd-David/esbuild-plugin-pino)
- "Consola offers consola/basic, consola/core and consola/browser subpath exports saving up to 80% of bundle size" — [unjs/consola README](https://github.com/unjs/consola/blob/main/README.md)
- "Consola population is classified as a key ecosystem project... 4,877,055 weekly downloads" — [Snyk Consola Package Health](https://app.snyk.io/advisor/npm-package/consola)
- "pino has 20,693,203 weekly downloads" — [npm pino trends](https://npmtrends.com/pino)
- "Signale is purpose-built for CLI logging enhancement... does not support structured logging" — [Better Stack Node.js logging libraries](https://betterstack.com/community/guides/logging/best-nodejs-logging-libraries/)
- "pino-roll automatically rolls your files based on a given frequency, size, or both" — [pino-roll npm](https://www.npmjs.com/package/pino-roll)
- "winston-daily-rotate-file can rotate files by minute, hour, day, month, year or weekday" — [winston-daily-rotate-file GitHub](https://github.com/winstonjs/winston-daily-rotate-file)
- React 19 `onUncaughtError` and `onCaughtError` — [React error handling 2025 edition](https://javascript.plainenglish.io/react-error-handling-2025-edition-onuncaughterror-boundaries-logging-ea7a679de22a)

---

## Research Gaps & Limitations

- **Consola file logging performance**: No benchmarks found for consola's custom reporter + fs.appendFileSync pattern vs winston's file transport. For a local dev tool this is academic, but worth noting.
- **tslog v5 features**: The tslog docs reference limited community content; may have added file transport in recent versions.
- **Exact install sizes**: Bundlephobia serves JS-rendered pages that couldn't be scraped. Sizes above are from secondary sources and npm install measurements mentioned in blog posts. Use `npm-size` CLI to verify before implementation.
- **UnJS ecosystem longevity**: Consola is backed by UnJS (Nuxt team) which has strong momentum, but is less battle-tested in non-Nuxt Express contexts than winston.

---

## Contradictions & Disputes

- Sources disagree on whether `morgan` is actively maintained. Some 2025 articles recommend it; its GitHub shows infrequent commits. Safe to skip in favor of a custom middleware.
- "Pino for everything" is a common recommendation in Node.js circles that doesn't account for bundled CLI tools. The esbuild complexity is real and documented in pino's own docs.
- Winston's type support: older articles call it "community-maintained" but since v3, types are shipped with the package. This is no longer a disadvantage.

---

## Search Methodology

- **Searches performed**: 12
- **Most productive search terms**: "pino esbuild bundling", "consola unjs features bundle size", "pino-roll winston-daily-rotate-file retention"
- **Primary information sources**: Better Stack comparison articles, official pino bundling docs, unjs/consola README, npm package pages

---

*Research completed by research-expert agent. For implementation guidance, see `contributing/architecture.md` for server patterns.*
