---
slug: logging-infrastructure
number: 36
created: 2026-02-16
status: specified
---

# Logging Infrastructure — Task Breakdown

## Phase 1: Logger Core + Config Schema

### Task 1.1: Add `logging.level` to config schema

**File:** `packages/shared/src/config-schema.ts`

Add the `logging` section to `UserConfigSchema`:

```typescript
const LoggingConfigSchema = z.object({
  level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});
```

Add to `UserConfigSchema`:

```typescript
logging: LoggingConfigSchema.default({}),
```

Add the log level name-to-number mapping constant:

```typescript
export const LOG_LEVEL_MAP: Record<string, number> = {
  fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5,
};
```

**Tests** (`packages/shared/src/__tests__/config-schema.test.ts`):
- `logging.level` defaults to `'info'`
- `logging.level` accepts valid values (`fatal`, `error`, `warn`, `info`, `debug`, `trace`)
- `logging.level` rejects invalid values
- `logging` section defaults to `{ level: 'info' }` when omitted
- `LOG_LEVEL_MAP` maps all level names to correct numeric values

**Acceptance criteria:**
- Schema parses with and without `logging` section
- Invalid level values are rejected by Zod
- `USER_CONFIG_DEFAULTS` includes `logging.level: 'info'`
- Existing config tests still pass

---

### Task 1.2: Create logger singleton (`apps/server/src/lib/logger.ts`)

**File:** `apps/server/src/lib/logger.ts`

Create the central logger module with:

1. **Logger singleton** — `export let logger` initialized as console-only consola at info level
2. **`initLogger(options?)` function** — Replaces the singleton with configured instance, adds file reporter
3. **NDJSON file reporter** — Appends structured JSON entries to `~/.dork/logs/dorkos.log` via `fs.appendFileSync`
4. **Log rotation** — `rotateIfNeeded()` renames current log when >10MB, cleans up beyond 7 rotated files

Full implementation:

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
  fs.mkdirSync(LOG_DIR, { recursive: true });
  rotateIfNeeded();

  const level = options?.level ?? (process.env.NODE_ENV === 'production' ? 3 : 4);

  logger = createConsola({
    level,
    reporters: [],
  });

  logger.addReporter(createFileReporter());
}
```

**Dependency:** Install `consola` (`^3.4.0`) in `apps/server/package.json`.

**Tests** (`apps/server/src/lib/__tests__/logger.test.ts`):
- `initLogger()` creates log directory if missing
- `initLogger()` sets log level from options
- File reporter writes NDJSON lines to disk
- Log rotation triggers when file exceeds 10MB (mock `fs.statSync`)
- Old rotated files cleaned up beyond `MAX_LOG_FILES`
- Default logger works without `initLogger()` (console-only)
- Mock pattern for other tests:

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

**Acceptance criteria:**
- Logger works before `initLogger()` (console-only, no crash)
- After `initLogger()`, logs are written to `~/.dork/logs/dorkos.log` as NDJSON
- Rotation renames file and cleans old files
- `npm run typecheck` passes

---

## Phase 2: Server Console Call Migration

### Task 2.1: Migrate `index.ts` console calls to logger

**File:** `apps/server/src/index.ts`

Replace all `console.*` calls:

| Current | Replacement |
|---------|-------------|
| `console.log('[Boundary] ...')` | `logger.info({ boundary: resolvedBoundary }, 'Directory boundary configured')` |
| `console.log('DorkOS server running...')` | `logger.info({ port: PORT, host }, 'Server started')` |
| Tunnel ASCII box (11 calls) | `logger.info({ url, port: tunnelPort, auth: hasAuth }, 'ngrok tunnel active')` |
| `console.warn('[Tunnel] Failed...')` | `logger.warn({ error: err.message }, 'Tunnel failed to start, continuing without tunnel')` |
| `console.log('Shutting down...')` | `logger.info('Shutting down')` |

Add `initLogger()` call at the top of `start()`:

```typescript
import { initLogger, logger } from './lib/logger.js';

export async function start() {
  const logLevel = parseInt(process.env.DORKOS_LOG_LEVEL || '3', 10);
  initLogger({ level: logLevel });
  // ... rest of startup
}
```

The tunnel ASCII box is replaced with a single structured log line. The box art was cosmetic -- the CLI banner in `cli.ts` already shows the startup URL.

**Acceptance criteria:**
- No `console.*` calls remain in `index.ts`
- `initLogger()` called before any `logger.*` calls
- Tunnel info logged as structured fields, not ASCII art
- Server starts and runs normally

---

### Task 2.2: Migrate `agent-manager.ts` console calls to logger

**File:** `apps/server/src/services/agent-manager.ts`

Replace 9 `console.*` calls. All become `logger.debug` except the error call:

| Current | Replacement |
|---------|-------------|
| `console.log('[sendMessage] session=...')` | `logger.debug({ sessionId, permissionMode, hasStarted, resume: sdkSessionId }, 'sendMessage')` |
| `console.log('[canUseTool] AskUserQuestion...')` | `logger.debug({ toolName, toolUseID: context.toolUseID }, 'Routing to question handler')` |
| `console.log('[canUseTool] requesting approval...')` | `logger.debug({ toolName, toolUseID: context.toolUseID }, 'Requesting tool approval')` |
| `console.log('[canUseTool] auto-allow...')` | `logger.debug({ toolName, permissionMode, toolUseID: context.toolUseID }, 'Auto-allowing tool')` |
| `console.log('[updateSession] permissionMode...')` | `logger.debug({ sessionId, from: old, to: new }, 'Permission mode changed')` |
| `console.log('[updateSession] setPermissionMode...')` | `logger.debug({ sessionId, permissionMode }, 'Setting permission mode on active query')` |
| `console.error('[updateSession] setPermissionMode failed')` | `logger.error({ sessionId, error: err }, 'setPermissionMode failed')` |
| `console.log('[approveTool] NOT FOUND...')` | `logger.debug({ sessionId, toolCallId, approved }, 'Tool approval target not found')` |
| `console.log('[approveTool] resolving...')` | `logger.debug({ sessionId, toolCallId, approved }, 'Resolving tool approval')` |

Import: `import { logger } from '../lib/logger.js';`

**Test updates** (`apps/server/src/services/__tests__/agent-manager.test.ts`):
- Add `vi.mock('../lib/logger.js')` with mock logger object
- Remove any `vi.spyOn(console, ...)` calls
- Verify `logger.debug` / `logger.error` called with structured fields where appropriate

**Acceptance criteria:**
- No `console.*` calls remain in `agent-manager.ts`
- All existing agent-manager tests pass
- Debug-level messages invisible at default info level

---

### Task 2.3: Migrate remaining service files to logger

**Files:**
- `apps/server/src/services/session-broadcaster.ts` (3 `console.error` calls)
- `apps/server/src/services/config-manager.ts` (2 `console.warn` calls)
- `apps/server/src/services/command-registry.ts` (2 `console.warn` calls)
- `apps/server/src/middleware/error-handler.ts` (1 `console.error` call)

**session-broadcaster.ts:**

| Current | Replacement |
|---------|-------------|
| `console.error('[SessionBroadcaster] Failed to broadcast...')` | `logger.error({ sessionId, error: err }, 'Failed to broadcast update')` |
| `console.error('[SessionBroadcaster] Failed to write...')` | `logger.error({ sessionId, error: err }, 'Failed to write to client')` |
| `console.error('[SessionBroadcaster] Failed to read offset...')` | `logger.error({ sessionId, error: err }, 'Failed to read offset')` |

**config-manager.ts:**

| Current | Replacement |
|---------|-------------|
| `console.warn('Warning: Corrupt config...')` | `logger.warn({ backupPath }, 'Corrupt config backed up')` |
| `console.warn('Creating fresh config...')` | `logger.warn('Creating fresh config with defaults')` |

**command-registry.ts:**

| Current | Replacement |
|---------|-------------|
| `console.warn('[CommandRegistry] Skipping...')` | `logger.warn({ file, error: fileErr.message }, 'Skipping command file')` |
| `console.warn('[CommandRegistry] Could not read...')` | `logger.warn({ error: err.message }, 'Could not read commands directory')` |

**error-handler.ts:**

| Current | Replacement |
|---------|-------------|
| `console.error('[DorkOS Error]', err.message, err.stack)` | `logger.error({ error: err.message, stack: err.stack }, 'Unhandled server error')` |

All files: add `import { logger } from '../lib/logger.js';` (adjust path for middleware).

**Test updates:**
- `apps/server/src/middleware/__tests__/error-handler.test.ts` — mock `logger` instead of `console.error`
- `apps/server/src/services/__tests__/config-manager.test.ts` — mock `logger` instead of `console.warn`
- `apps/server/src/services/__tests__/command-registry.test.ts` (if exists) — mock `logger`
- Any test that uses `vi.spyOn(console, 'warn')` or `vi.spyOn(console, 'error')` for these files

**Acceptance criteria:**
- No `console.*` calls remain in any of the 4 files
- All existing tests pass with updated mocks
- Error/warn messages use structured fields

---

## Phase 3: HTTP Request Logging + CLI Integration

### Task 3.1: Create HTTP request logging middleware

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

**Register in `apps/server/src/app.ts`:**

```typescript
import { requestLogger } from './middleware/request-logger.js';
// Add after express.json(), before routes:
app.use(requestLogger);
```

**Tests** (`apps/server/src/middleware/__tests__/request-logger.test.ts`):
- Logs method, path, status, duration for completed requests
- Does NOT log req.body or headers
- Uses debug level (verify with mock logger)
- Calls `next()` to pass control

**Acceptance criteria:**
- Request logger registered before routes in `app.ts`
- Every HTTP request logged at debug level with method, path, status, ms
- No sensitive data logged (body, headers)
- Tests pass

---

### Task 3.2: Add `--log-level` CLI flag and log directory creation

**File:** `packages/cli/src/cli.ts`

1. Add `'log-level'` to `parseArgs` options:

```typescript
'log-level': { type: 'string', short: 'l' },
```

2. Add to help text:

```
  -l, --log-level <level>  Log level (fatal|error|warn|info|debug|trace)
```

3. After config manager init, before server import, resolve log level:

```typescript
const logLevelName = values['log-level']
  || process.env.LOG_LEVEL
  || cfgMgr.getDot('logging.level')
  || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const LOG_LEVEL_MAP: Record<string, number> = {
  fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5,
};
process.env.DORKOS_LOG_LEVEL = String(LOG_LEVEL_MAP[logLevelName as keyof typeof LOG_LEVEL_MAP] ?? 3);
```

4. Create `~/.dork/logs/` alongside existing `~/.dork/` creation:

```typescript
fs.mkdirSync(path.join(DORK_HOME, 'logs'), { recursive: true });
```

**Acceptance criteria:**
- `dorkos --log-level debug` sets `DORKOS_LOG_LEVEL=4`
- `LOG_LEVEL` env var works as fallback
- Config `logging.level` works as fallback
- `~/.dork/logs/` created at CLI startup
- Help text updated with new flag
- CLI build succeeds: `npm run build -w packages/cli`

---

## Phase 4: Documentation + Verification

### Task 4.1: Update documentation

**Files to update:**

1. `contributing/configuration.md` — Add `logging.level` to settings reference table
2. `packages/cli/README.md` — Add `--log-level` flag to CLI options
3. `docs/getting-started/configuration.mdx` — Add logging section for external users

**Content for settings reference (`contributing/configuration.md`):**

Add row to settings table:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `logging.level` | `fatal\|error\|warn\|info\|debug\|trace` | `info` | Server log verbosity |

**Content for CLI README (`packages/cli/README.md`):**

Add to options list:

```
-l, --log-level <level>  Log level (fatal|error|warn|info|debug|trace)
```

Add to environment variables section:

```
LOG_LEVEL              Override log verbosity (fatal|error|warn|info|debug|trace)
```

**Content for external docs (`docs/getting-started/configuration.mdx`):**

Add logging section explaining:
- Default log file location: `~/.dork/logs/dorkos.log`
- How to set log level via CLI flag, env var, or config file
- NDJSON format for grep/jq filtering

**Acceptance criteria:**
- All three documentation files updated
- Settings reference includes `logging.level`
- CLI help and README consistent

---

### Task 4.2: Full verification and smoke test

Run the complete verification suite:

1. `npm test -- --run` — All tests pass
2. `npm run typecheck` — No type errors
3. `npm run lint` — No new lint errors
4. `npm run build -w packages/cli` — CLI builds successfully
5. Manual smoke test: Start server, verify `~/.dork/logs/dorkos.log` contains NDJSON entries
6. Verify no `console.*` calls remain in server source (excluding CLI files)
7. Verify no sensitive data in log output (req.body, headers)

**Acceptance criteria:**
- All tests pass
- No type errors
- CLI builds
- Log file created with structured entries
- No regressions
