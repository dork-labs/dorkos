---
slug: logging-infrastructure
number: 36
created: 2026-02-16
status: specified
---

# Logging Infrastructure

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-02-16

## Overview

Replace ad-hoc `console.log/warn/error` calls across the DorkOS server with a structured logging system using consola. The logger provides pretty console output in development, NDJSON file persistence to `~/.dork/logs/`, configurable log levels via CLI flag / env var / config file, and HTTP request logging middleware.

## Background / Problem Statement

DorkOS currently uses 34 raw `console.*` calls across 7 server files with no structured logging, no file persistence, no log level control, and no HTTP request logging middleware. This creates several problems:

1. **No persistence** — Logs are lost when the terminal scrolls or the process restarts. Debugging issues after the fact is impossible.
2. **No structured fields** — Messages use string interpolation (`[sendMessage] session=abc permissionMode=default`) instead of structured JSON fields, making them hard to grep and filter.
3. **No log levels** — Debug-level session tracking messages (tool approval routing, SDK event mapping) print at the same verbosity as startup messages. No way to silence them.
4. **No request logging** — No visibility into HTTP requests hitting the API. Debugging client-server issues requires browser DevTools.
5. **Inconsistent prefixes** — Manual `[Boundary]`, `[Tunnel]`, `[DorkOS Error]`, `[CommandRegistry]` tags vary in format and are not filterable.

## Goals

- Replace all `console.*` calls in server files with structured `logger.info/warn/error/debug` calls
- Persist logs to `~/.dork/logs/dorkos.log` as NDJSON with startup rotation (>10MB) and 7-day retention
- Add `logging.level` to config schema with CLI flag / env var override support
- Add HTTP request logging middleware (method, path, status, duration at debug level)
- Maintain pretty console output in development via consola's fancy reporter
- Keep CLI user-facing output (`console.log` in banners, config commands, wizard) unchanged

## Non-Goals

- Client-side error boundaries or structured client logging (separate future spec)
- Cloud log aggregation, remote logging, or monitoring dashboards
- Distributed tracing or correlation IDs
- Log viewing UI in the DorkOS client
- Modifying CLI user-facing output (banners, config display, wizard prompts)

## Technical Dependencies

- **consola** (`^3.4.0`) — Structured logger with pretty console output, custom reporters, tagged loggers. Added to `apps/server/package.json` only.
- No other new dependencies. Log rotation uses `fs` (already available). File reporter uses `fs.appendFileSync`.
- Existing: `conf` for config persistence, Zod for schema validation, Express for middleware.

## Detailed Design

### 1. Logger Singleton (`apps/server/src/lib/logger.ts`)

Central logger module exporting a singleton and initialization function.

```typescript
import { createConsola, type LogObject } from 'consola';
import fs from 'fs';
import path from 'path';
import os from 'os';

const LOG_DIR = path.join(os.homedir(), '.dork', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'dorkos.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = 7;

/** NDJSON file reporter — appends structured log entries to disk. */
function createFileReporter() {
  return {
    log(logObj: LogObject) {
      const entry = JSON.stringify({
        level: logObj.type,
        time: logObj.date.toISOString(),
        msg: logObj.args.map(String).join(' '),
        tag: logObj.tag || undefined,
      });
      fs.appendFileSync(LOG_FILE, entry + '\n');
    },
  };
}

/** Rotate log file if >10MB. Keep last 7 rotated files. */
function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_SIZE) {
      const date = new Date().toISOString().slice(0, 10);
      const rotatedName = `dorkos-${date}-${Date.now()}.log`;
      fs.renameSync(LOG_FILE, path.join(LOG_DIR, rotatedName));

      // Clean old rotated files beyond MAX_LOG_FILES
      const files = fs.readdirSync(LOG_DIR)
        .filter(f => f.startsWith('dorkos-') && f.endsWith('.log'))
        .sort()
        .reverse();
      for (const old of files.slice(MAX_LOG_FILES)) {
        fs.unlinkSync(path.join(LOG_DIR, old));
      }
    }
  } catch {
    // File doesn't exist yet or rotation failed — continue
  }
}

/** Default logger instance (console-only until initLogger is called). */
export let logger = createConsola({
  level: 3, // info
});

/**
 * Initialize the logger with file persistence and configured log level.
 * Call once at server startup after config is loaded.
 */
export function initLogger(options?: { level?: number }): void {
  // Ensure log directory exists
  fs.mkdirSync(LOG_DIR, { recursive: true });

  // Rotate if current log exceeds size limit
  rotateIfNeeded();

  const level = options?.level ?? (process.env.NODE_ENV === 'production' ? 3 : 4);

  logger = createConsola({
    level,
    reporters: [
      // Default fancy reporter handles console output
      // (consola auto-detects CI/test and switches to basic)
    ],
  });

  // Add file reporter alongside default console reporter
  logger.addReporter(createFileReporter());
}
```

**Key design decisions:**
- `logger` is a mutable module-level export so services can import it at module load time. `initLogger()` replaces it with a configured instance at startup.
- `fs.appendFileSync` is used for simplicity — DorkOS is single-user, not high-throughput.
- Rotation happens at startup only (not mid-session), keeping the file reporter stateless.
- The default export works without `initLogger()` (console-only at info level) so tests and imports before startup don't crash.

### 2. Log Level Mapping

Consola's numeric levels and their DorkOS usage:

| Level | Consola | DorkOS Usage |
|-------|---------|-------------|
| 0 | `fatal` | Server crash, unrecoverable |
| 1 | `error` | Request failures, service errors |
| 2 | `warn` | Degraded state, config warnings |
| 3 | `info` | Startup/shutdown, session lifecycle (default) |
| 4 | `debug` | Per-request details, tool routing, HTTP requests |
| 5 | `trace` | SDK events, SSE internals (deep debugging) |

### 3. Config Schema Update (`packages/shared/src/config-schema.ts`)

Add `logging` section to `UserConfigSchema`:

```typescript
const LoggingConfigSchema = z.object({
  level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

// Add to UserConfigSchema:
logging: LoggingConfigSchema.default({}),
```

Level name to consola numeric mapping:

```typescript
const LOG_LEVEL_MAP: Record<string, number> = {
  fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5,
};
```

### 4. Console Call Migration

Replace `console.*` calls in 7 server files. CLI files (`cli.ts`, `config-commands.ts`, `init-wizard.ts`, `check-claude.ts`) keep `console.log/error` — they are intentional user-facing output.

#### `apps/server/src/index.ts` (17 calls)

| Line | Current | Replacement |
|------|---------|-------------|
| 22 | `console.log('[Boundary] ...')` | `logger.info({ boundary: resolvedBoundary }, 'Directory boundary configured')` |
| 32 | `console.log('DorkOS server running...')` | `logger.info({ port: PORT, host }, 'Server started')` |
| 58-77 | Tunnel ASCII box (11 calls) | `logger.info({ url, port: tunnelPort, auth: hasAuth }, 'ngrok tunnel active')` |
| 79-83 | `console.warn('[Tunnel] Failed...')` | `logger.warn({ error: err.message }, 'Tunnel failed to start, continuing without tunnel')` |
| 90 | `console.log('Shutting down...')` | `logger.info('Shutting down')` |

**Note:** The tunnel ASCII box is replaced with a single structured log line. The box art was cosmetic — the CLI banner in `cli.ts` already shows the startup URL.

#### `apps/server/src/services/agent-manager.ts` (9 calls)

| Line | Current | Replacement |
|------|---------|-------------|
| 151-153 | `console.log('[sendMessage] session=...')` | `logger.debug({ sessionId, permissionMode, hasStarted, resume: sdkSessionId }, 'sendMessage')` |
| 185-187 | `console.log('[canUseTool] AskUserQuestion...')` | `logger.debug({ toolName, toolUseID: context.toolUseID }, 'Routing to question handler')` |
| 192-194 | `console.log('[canUseTool] requesting approval...')` | `logger.debug({ toolName, toolUseID: context.toolUseID }, 'Requesting tool approval')` |
| 198-200 | `console.log('[canUseTool] auto-allow...')` | `logger.debug({ toolName, permissionMode, toolUseID: context.toolUseID }, 'Auto-allowing tool')` |
| 439-441 | `console.log('[updateSession] permissionMode...')` | `logger.debug({ sessionId, from: old, to: new }, 'Permission mode changed')` |
| 444-446 | `console.log('[updateSession] setPermissionMode...')` | `logger.debug({ sessionId, permissionMode }, 'Setting permission mode on active query')` |
| 448 | `console.error('[updateSession] setPermissionMode failed')` | `logger.error({ sessionId, error: err }, 'setPermissionMode failed')` |
| 462-464 | `console.log('[approveTool] NOT FOUND...')` | `logger.debug({ sessionId, toolCallId, approved }, 'Tool approval target not found')` |
| 467-469 | `console.log('[approveTool] resolving...')` | `logger.debug({ sessionId, toolCallId, approved }, 'Resolving tool approval')` |

All agent-manager calls become `logger.debug` (invisible at default info level) except the error call.

#### `apps/server/src/services/session-broadcaster.ts` (3 calls)

| Line | Current | Replacement |
|------|---------|-------------|
| 143-145 | `console.error('[SessionBroadcaster] Failed to broadcast...')` | `logger.error({ sessionId, error: err }, 'Failed to broadcast update')` |
| 218-220 | `console.error('[SessionBroadcaster] Failed to write...')` | `logger.error({ sessionId, error: err }, 'Failed to write to client')` |
| 225 | `console.error('[SessionBroadcaster] Failed to read offset...')` | `logger.error({ sessionId, error: err }, 'Failed to read offset')` |

#### `apps/server/src/services/config-manager.ts` (2 calls)

| Line | Current | Replacement |
|------|---------|-------------|
| 56 | `console.warn('Warning: Corrupt config...')` | `logger.warn({ backupPath }, 'Corrupt config backed up')` |
| 57 | `console.warn('Creating fresh config...')` | `logger.warn('Creating fresh config with defaults')` |

#### `apps/server/src/services/command-registry.ts` (2 calls)

| Line | Current | Replacement |
|------|---------|-------------|
| 87 | `console.warn('[CommandRegistry] Skipping...')` | `logger.warn({ file, error: fileErr.message }, 'Skipping command file')` |
| 95 | `console.warn('[CommandRegistry] Could not read...')` | `logger.warn({ error: err.message }, 'Could not read commands directory')` |

#### `apps/server/src/middleware/error-handler.ts` (1 call)

| Line | Current | Replacement |
|------|---------|-------------|
| 4 | `console.error('[DorkOS Error]', err.message, err.stack)` | `logger.error({ error: err.message, stack: err.stack }, 'Unhandled server error')` |

### 5. Tagged Loggers

Services that log frequently use `logger.withTag()` for consistent prefixing:

```typescript
// In agent-manager.ts
import { logger } from '../lib/logger.js';
const log = logger.withTag('agent-manager');
// Usage: log.debug({ sessionId }, 'sendMessage')
// Output: [agent-manager] sendMessage { sessionId: 'abc-123' }

// In session-broadcaster.ts
const log = logger.withTag('session-broadcaster');

// In error-handler.ts
const log = logger.withTag('error-handler');
```

**Important:** Tagged loggers are created at the top of each file, not inside functions. Since `logger` is a module-level export that gets replaced by `initLogger()`, tagged loggers created before `initLogger()` would point to the old instance. To handle this, services should import and call `logger.withTag()` lazily (inside the first function call) or import `logger` directly and call methods on it with a tag string in the structured fields.

**Recommended pattern** (avoids stale reference):

```typescript
import { logger } from '../lib/logger.js';

// Use logger directly with tag in structured fields
logger.debug({ tag: 'agent-manager', sessionId }, 'sendMessage');

// OR use a getter pattern
function getLog() { return logger.withTag('agent-manager'); }
```

### 6. HTTP Request Logging Middleware

**New file:** `apps/server/src/middleware/request-logger.ts`

```typescript
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';

/**
 * Express middleware that logs every HTTP request at debug level.
 * Logs method, path, status code, and response time.
 * Never logs req.body (may contain user messages) or headers (may contain auth tokens).
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    logger.debug({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
    }, 'request');
  });
  next();
}
```

Register in `apps/server/src/app.ts` before route handlers:

```typescript
import { requestLogger } from './middleware/request-logger.js';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(requestLogger);  // <-- Add here, before routes
  // ... route registration
}
```

### 7. CLI Integration (`packages/cli/src/cli.ts`)

Add `--log-level` flag to the existing `parseArgs` call:

```typescript
'log-level': { type: 'string', short: 'l' },
```

Log level precedence (highest to lowest):
1. `--log-level` CLI flag
2. `LOG_LEVEL` env var
3. `~/.dork/config.json` → `logging.level`
4. Default: `info` in production, `debug` in dev

```typescript
// After config manager init, before server import:
const logLevelName = values['log-level']
  || process.env.LOG_LEVEL
  || cfgMgr.get('logging.level')
  || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const LOG_LEVEL_MAP = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
process.env.DORKOS_LOG_LEVEL = String(LOG_LEVEL_MAP[logLevelName] ?? 3);
```

Create `~/.dork/logs/` alongside existing `~/.dork/` creation:

```typescript
fs.mkdirSync(path.join(DORK_HOME, 'logs'), { recursive: true });
```

### 8. Server Startup Integration (`apps/server/src/index.ts`)

Call `initLogger()` early in the `start()` function:

```typescript
import { initLogger, logger } from './lib/logger.js';

export async function start() {
  const logLevel = parseInt(process.env.DORKOS_LOG_LEVEL || '3', 10);
  initLogger({ level: logLevel });

  // ... rest of startup
  logger.info({ boundary: resolvedBoundary }, 'Directory boundary configured');
}
```

## User Experience

**For users running `dorkos` CLI:**
- Startup banner unchanged (still `console.log`)
- Operational logs now persist to `~/.dork/logs/dorkos.log`
- Can set log verbosity: `dorkos --log-level debug` or `dorkos config set logging.level debug`
- Logs have pretty colored output in terminal via consola fancy reporter

**For developers running `npm run dev`:**
- Pretty console output with service tags (e.g., `[agent-manager]`)
- Debug-level messages visible by default in dev
- HTTP requests logged to console at debug level
- Logs also persist to `~/.dork/logs/` for post-mortem debugging

**For debugging:**
- `tail -f ~/.dork/logs/dorkos.log` — watch live NDJSON
- `grep '"sessionId":"abc"' ~/.dork/logs/dorkos.log` — filter by session
- `jq 'select(.level == "error")' ~/.dork/logs/dorkos.log` — filter by level

## Testing Strategy

### Unit Tests

**`apps/server/src/lib/__tests__/logger.test.ts`:**
- `initLogger()` creates log directory if missing
- `initLogger()` sets log level from options
- File reporter writes NDJSON to disk
- Log rotation triggers when file exceeds 10MB (use mock fs)
- Old rotated files cleaned up beyond MAX_LOG_FILES
- Default logger works without `initLogger()` (console-only)
- `logger.withTag()` produces tagged output

**`apps/server/src/middleware/__tests__/request-logger.test.ts`:**
- Logs method, path, status, duration for completed requests
- Does NOT log req.body or headers
- Uses debug level (verify with mock logger)

### Existing Test Updates

**`apps/server/src/middleware/__tests__/error-handler.test.ts`:**
- Currently mocks `console.error` — update to mock `logger.error` instead
- Verify error handler calls `logger.error` with structured fields

**Other service tests:**
- Tests that suppress `console.warn/error` via `vi.spyOn(console, ...)` should be updated to mock `logger` instead
- Import `{ logger }` from `../lib/logger.js` and use `vi.mock('../lib/logger.js')` with a mock object

### Mock Pattern for Tests

```typescript
vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
  initLogger: vi.fn(),
}));
```

### Config Schema Tests

**`packages/shared/src/__tests__/config-schema.test.ts`:**
- `logging.level` defaults to `'info'`
- `logging.level` accepts valid values (`fatal`, `error`, `warn`, `info`, `debug`, `trace`)
- `logging.level` rejects invalid values

## Performance Considerations

- **Negligible impact** — DorkOS is a single-user local tool. `fs.appendFileSync` adds microseconds per log call.
- **No async overhead** — Synchronous file writes are acceptable for this throughput level (<100 logs/minute typical).
- **Startup rotation** — Log rotation only runs at startup, not during request handling. No mid-request filesystem scanning.
- **Console output** — Consola's fancy reporter is slightly slower than raw `console.log` due to formatting, but the difference is imperceptible for a local tool.

## Security Considerations

- **Never log `req.body`** — May contain user messages sent to Claude (privacy-sensitive)
- **Never log `req.headers`** — May contain auth tokens (ngrok basic auth)
- **Never log file contents** — Session transcripts contain full conversation history
- **Log path is `~/.dork/logs/`** — User-owned directory, standard permissions
- **Config values** — `logging.level` is not sensitive; not added to `SENSITIVE_CONFIG_KEYS`

## Documentation

- Update `contributing/configuration.md` — Add `logging.level` to settings reference
- Update `packages/cli/README.md` — Add `--log-level` flag documentation
- Update `docs/getting-started/configuration.mdx` — Add logging section for external users

## Implementation Phases

### Phase 1: Logger Core + Config

- Create `apps/server/src/lib/logger.ts` (singleton, file reporter, rotation)
- Add `logging.level` to `UserConfigSchema` in `packages/shared/src/config-schema.ts`
- Add config schema tests
- Add logger unit tests

### Phase 2: Server Migration

- Replace `console.*` calls in all 7 server files with `logger.*` calls
- Use structured fields instead of string interpolation
- Update existing tests that mock `console.*`

### Phase 3: HTTP Request Logging + CLI

- Create `apps/server/src/middleware/request-logger.ts`
- Register middleware in `apps/server/src/app.ts`
- Add `--log-level` CLI flag to `packages/cli/src/cli.ts`
- Create `~/.dork/logs/` at CLI startup
- Add request logger tests

### Phase 4: Verification

- Run full test suite (`npm test`)
- Run typecheck (`npm run typecheck`)
- Verify CLI build (`npm run build -w packages/cli`)
- Manual smoke test: start server, create session, check `~/.dork/logs/dorkos.log`
- Verify no sensitive data in log output

## Open Questions

None — all questions resolved during ideation.

## Related ADRs

None currently. Consider creating an ADR for "Logging library choice: consola over pino/winston" if the team wants to document the rationale for future reference.

## References

- [consola GitHub (unjs/consola)](https://github.com/unjs/consola) — Logger library
- [Ideation document](../logging-infrastructure/01-ideation.md) — Problem analysis and research
- [Research document](../../research/20260216_logging_strategy.md) — Full library comparison
- [Boundary spec](../directory-boundary-enforcement/02-specification.md) — Similar `lib/` utility pattern
- [Config spec](../dorkos-config-file-system/02-specification.md) — Config schema patterns
