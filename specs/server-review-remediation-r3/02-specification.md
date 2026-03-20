---
slug: server-review-remediation-r3
number: 76
created: 2026-02-28
status: specified
---

# Specification: Server Code Review Remediation — Round 3

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-02-28

## Overview

Address 18 findings from the comprehensive server code review: 4 Critical (2 security, 2 code quality), 6 Important (performance, security, bugs, quality), and 8 Minor (quality, testing). Two findings (I3 auth, I8 server internals) are deferred to a separate spec.

## Background / Problem Statement

A thorough code review of `apps/server/`, `packages/shared/`, `packages/cli/`, and `packages/test-utils/` identified 20 findings. Previous remediation rounds (specs #73, #74, #75) addressed Relay, Mesh, and Telegram adapter issues. This round targets the remaining server-core, routing, and service-level issues. The two most urgent are security vulnerabilities: error message leaking (C1) and missing boundary validation (C2).

## Goals

- Fix 2 security vulnerabilities (C1 error leaking, C2 boundary bypass)
- Fix 1 prototype pollution vector (I4)
- Split 2 oversized files below the 500-line limit (C3, C4)
- Add session cap and reverse lookup index (I1, I2)
- Add SSE connection limits (I5)
- Fix SSE keepalive race condition (I6)
- Centralize vault root resolution (I7)
- Standardize error responses and route param validation (M2, M3)
- Fix API 404 catch-all (M6)
- Replace unsafe type assertions (M4, M7)
- Add security-focused tests (M8)

## Non-Goals

- **I3 — Authentication / rate limiting**: Deferred to a dedicated auth spec. Requires feature design, not a bugfix.
- **I8 — Server internals exposure**: Depends on I3 auth infrastructure. Deferred alongside.
- **M5 — Directory restructuring**: Already well-organized into `core/`, `pulse/`, `relay/`, `session/`, `mesh/`. No action needed.
- Client-side changes (unless an API contract change requires it)
- New feature development

## Technical Dependencies

- No new npm dependencies
- Existing: `zod`, `express`, `chokidar`, `@anthropic-ai/claude-agent-sdk`
- All changes are server-side within `apps/server/src/`

## Detailed Design

### Phase 1: Security Fixes (C1, C2, I4)

#### C1 — Error Handler: Hide Internal Messages in Production

**File:** `apps/server/src/middleware/error-handler.ts`

```typescript
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error('[DorkOS Error]', err.message, err.stack);
  const isDev = process.env.NODE_ENV !== 'production';
  res.status(500).json({
    error: isDev ? err.message : 'Internal Server Error',
    code: 'INTERNAL_ERROR',
  });
}
```

#### C2 — Add Boundary Checks to PATCH and Stream Routes

**File:** `apps/server/src/routes/sessions.ts`

**PATCH route (line ~133):** Add `assertBoundary` before using `cwd`:

```typescript
router.patch('/:id', async (req, res) => {
  // ... existing validation ...
  const cwd = (req.query.cwd as string) || vaultRoot;
  if (!(await assertBoundary(cwd, res))) return; // ADD THIS
  const session = await transcriptReader.getSession(cwd, req.params.id);
  // ...
});
```

**Stream route (line ~313):** Add `assertBoundary` before registering client:

```typescript
router.get('/:id/stream', async (req, res) => {
  // Make async
  const sessionId = req.params.id;
  const cwd = (req.query.cwd as string) || vaultRoot;
  if (!(await assertBoundary(cwd, res))) return; // ADD THIS
  // ...
  sessionBroadcaster.registerClient(sessionId, cwd, res, clientId);
});
```

#### I4 — Prototype Pollution Guard in deepMerge

**File:** `apps/server/src/routes/config.ts` (lines 20-47)

Add dangerous key filter at the top of the loop:

```typescript
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    if (DANGEROUS_KEYS.has(key)) continue; // ADD THIS
    // ... rest unchanged ...
  }
  return result;
}
```

### Phase 2: File Splits (C3, C4)

#### C3 — Split mcp-tool-server.ts (940 lines) into Domain Modules

**Current:** Single `createDorkOsToolServer()` factory in one 940-line file.

**Target structure:**

```
services/core/mcp-tools/
├── index.ts           # createDorkOsToolServer() composition root (~80 lines)
├── types.ts           # McpToolDeps interface + shared types (~30 lines)
├── core-tools.ts      # ping, get_server_info, get_session_count (~60 lines)
├── pulse-tools.ts     # list/create/update/delete schedules, run history (~130 lines)
├── relay-tools.ts     # relay_send, relay_inbox, relay_list, relay_test (~120 lines)
├── binding-tools.ts   # binding_list, binding_create, binding_delete (~80 lines)
├── mesh-tools.ts      # discover, register, list, deny, unregister, status, inspect, topology (~200 lines)
└── agent-tools.ts     # agent_get_current, resolve, create, update (~100 lines)
```

**Each domain module exports a registration function:**

```typescript
// Example: pulse-tools.ts
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { McpToolDeps } from './types.js';

export function registerPulseTools(
  server: ReturnType<typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer>,
  deps: McpToolDeps
): void {
  if (!deps.pulseStore) return;
  // ... tool registrations ...
}
```

**Composition root (`index.ts`):**

```typescript
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpToolDeps } from './types.js';
import { registerCoreTools } from './core-tools.js';
import { registerPulseTools } from './pulse-tools.js';
import { registerRelayTools } from './relay-tools.js';
import { registerBindingTools } from './binding-tools.js';
import { registerMeshTools } from './mesh-tools.js';
import { registerAgentTools } from './agent-tools.js';

export type { McpToolDeps } from './types.js';

export function createDorkOsToolServer(deps: McpToolDeps) {
  const server = createSdkMcpServer({ name: 'dorkos-tools', version: '1.0.0' });

  registerCoreTools(server, deps);
  registerPulseTools(server, deps);
  registerRelayTools(server, deps);
  registerBindingTools(server, deps);
  registerMeshTools(server, deps);
  registerAgentTools(server, deps);

  return server;
}
```

**Migration:** The old `mcp-tool-server.ts` is replaced entirely. All imports of `createDorkOsToolServer` and `McpToolDeps` from `'../services/core/mcp-tool-server.js'` must update to `'../services/core/mcp-tools/index.js'` (or use barrel re-export).

#### C4 — Split adapter-manager.ts (957 lines)

**Extract 2 modules:**

1. **`adapter-error.ts`** (~20 lines): `AdapterError` class + error codes type
2. **`adapter-config.ts`** (~200 lines): Config loading, validation, merge, and hot-reload logic:
   - `loadAdapterConfig(configPath)` — reads and validates YAML/JSON config
   - `mergeAdapterConfig(existing, incoming)` — config merge with validation
   - `watchAdapterConfig(configPath, onChange)` — chokidar watcher with debounce
   - `AdapterConfigSchema` — Zod schema for adapter config

**`AdapterManager`** stays in `adapter-manager.ts` but delegates config operations to `adapter-config.ts`. Target: <450 lines for the main file.

### Phase 3: Performance & Reliability (I1, I2, I5, I6)

#### I1 — Session Map Cap

**File:** `apps/server/src/config/constants.ts`

Add to the existing `SESSIONS` section:

```typescript
export const SESSIONS = {
  TIMEOUT_MS: 30 * 60 * 1000,
  HEALTH_CHECK_INTERVAL_MS: 5 * 60 * 1000,
  MAX_CONCURRENT: 50, // ADD THIS
} as const;
```

**File:** `apps/server/src/services/core/agent-manager.ts` (`ensureSession`)

```typescript
ensureSession(sessionId: string, opts: { ... }): void {
  if (!this.sessions.has(sessionId)) {
    if (this.sessions.size >= SESSIONS.MAX_CONCURRENT) {
      throw new Error(`Maximum concurrent sessions (${SESSIONS.MAX_CONCURRENT}) reached`);
    }
    this.sessions.set(sessionId, { ... });
  }
}
```

The route handler calling `ensureSession` should catch this and return 503.

#### I2 — Reverse Lookup Index for findSession

**File:** `apps/server/src/services/core/agent-manager.ts`

Add a reverse map alongside the sessions map:

```typescript
private sessions = new Map<string, AgentSession>();
private sdkSessionIndex = new Map<string, string>(); // sdkSessionId → sessionId

private findSession(sessionId: string): AgentSession | undefined {
  const direct = this.sessions.get(sessionId);
  if (direct) return direct;
  // O(1) reverse lookup instead of O(n) scan
  const mappedId = this.sdkSessionIndex.get(sessionId);
  return mappedId ? this.sessions.get(mappedId) : undefined;
}
```

Update the index when an SDK session ID is assigned (in `mapSdkMessage` or when `sdkSessionId` is set):

```typescript
// When SDK assigns a session ID:
session.sdkSessionId = sdkId;
this.sdkSessionIndex.set(sdkId, sessionId);
```

Clean up in `checkSessionHealth()` when sessions expire:

```typescript
if (session.sdkSessionId) {
  this.sdkSessionIndex.delete(session.sdkSessionId);
}
this.sessions.delete(id);
```

#### I5 — SSE Connection Limits

**File:** `apps/server/src/config/constants.ts`

```typescript
export const SSE = {
  MAX_CLIENTS_PER_SESSION: 10,
  MAX_TOTAL_CLIENTS: 500,
} as const;
```

**File:** `apps/server/src/services/session/session-broadcaster.ts`

Add connection counting and a `getClientCount()` method:

```typescript
private totalClientCount = 0;

getClientCount(sessionId?: string): number {
  if (sessionId) {
    return this.clients.get(sessionId)?.size ?? 0;
  }
  return this.totalClientCount;
}

registerClient(sessionId: string, vaultRoot: string, res: Response, clientId?: string): void {
  if (this.totalClientCount >= SSE.MAX_TOTAL_CLIENTS) {
    res.status(503).json({ error: 'SSE connection limit reached', code: 'SSE_LIMIT' });
    return;
  }
  const sessionClients = this.clients.get(sessionId);
  if (sessionClients && sessionClients.size >= SSE.MAX_CLIENTS_PER_SESSION) {
    res.status(503).json({ error: 'Too many connections for this session', code: 'SSE_SESSION_LIMIT' });
    return;
  }
  this.totalClientCount++;
  res.on('close', () => { this.totalClientCount--; });
  // ... existing registration logic ...
}
```

#### I6 — SSE Keepalive Race Fix

**File:** `apps/server/src/routes/relay.ts` (lines 357-364)

```typescript
const keepalive = setInterval(() => {
  if (res.writableEnded) {
    clearInterval(keepalive);
    return;
  }
  try {
    res.write(`: keepalive\n\n`);
  } catch {
    clearInterval(keepalive);
  }
}, 15_000);
```

### Phase 4: Code Quality (I7, M1-M4, M6, M7)

#### I7 + M1 — Centralize Vault Root Resolution

**New file:** `apps/server/src/lib/resolve-root.ts`

```typescript
import { env } from '../env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));

/** Default CWD for the server — prefers env var, falls back to repo root. */
export const DEFAULT_CWD: string = env.DORKOS_DEFAULT_CWD ?? path.resolve(thisDir, '../../../');
```

**Update consumers:**

- `routes/sessions.ts`: Replace `__dirname` + `vaultRoot` with `import { DEFAULT_CWD } from '../lib/resolve-root.js'`. Remove `fileURLToPath` import. (Fixes M1)
- `routes/relay.ts`: Replace inline `vaultRoot` computation with `DEFAULT_CWD` import
- `routes/commands.ts`: Replace `defaultRoot` computation with `DEFAULT_CWD` import
- `agent-manager.ts`: Use `DEFAULT_CWD` as fallback in constructor

#### M2 — UUID Validation for Route Params

**File:** `apps/server/src/lib/route-utils.ts` (add to existing file)

```typescript
import { z } from 'zod';

const uuidSchema = z.string().uuid();

/**
 * Validates a route param as a UUID. Sends 400 and returns null if invalid.
 */
export function parseSessionId(value: string, res: Response): string | null {
  const result = uuidSchema.safeParse(value);
  if (!result.success) {
    res.status(400).json({ error: 'Invalid session ID format', code: 'INVALID_ID' });
    return null;
  }
  return result.data;
}
```

**Apply in `routes/sessions.ts`** for all routes that accept `:id`:

```typescript
router.get('/:id', async (req, res) => {
  const sessionId = parseSessionId(req.params.id, res);
  if (!sessionId) return;
  // ... rest unchanged, use sessionId instead of req.params.id ...
});
```

Apply to: `GET /:id`, `PATCH /:id`, `POST /:id/messages`, `POST /:id/approve`, `POST /:id/deny`, `POST /:id/submit-answers`, `GET /:id/stream`.

#### M3 — Standardize Error Responses

**File:** `apps/server/src/lib/route-utils.ts` (add to existing file)

```typescript
/**
 * Sends a standardized JSON error response.
 */
export function sendError(
  res: Response,
  status: number,
  error: string,
  code: string,
  extra?: Record<string, unknown>
): void {
  res.status(status).json({ error, code, ...extra });
}
```

Incrementally adopt across routes. Start with `sessions.ts` where error shapes are most inconsistent. Example:

```typescript
// Before:
res.status(404).json({ error: 'Session not found' });
// After:
sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
```

This is a gradual migration — not all routes need updating in this PR.

#### M4 — Replace Unsafe Type Assertions in index.ts

**File:** `apps/server/src/index.ts`

Replace the three `as` assertions with Zod parsing. Add schemas near the top of the file:

```typescript
import { z } from 'zod';

const SchedulerConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxConcurrentRuns: z.number().default(5),
    timezone: z.string().nullable().default(null),
    retentionCount: z.number().default(100),
  })
  .default({});

const RelayConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    dataDir: z.string().nullable().optional(),
  })
  .default({});

const MeshConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .default({});
```

Then:

```typescript
const schedulerConfig = SchedulerConfigSchema.parse(configManager.get('scheduler') ?? {});
const relayConfig = RelayConfigSchema.parse(configManager.get('relay') ?? {});
const meshConfig = MeshConfigSchema.parse(configManager.get('mesh') ?? {});
```

#### M6 — API 404 Before SPA Catch-All

**File:** `apps/server/src/app.ts`

Add an API 404 handler before the production block:

```typescript
// API 404 — must come after all /api routes, before SPA catch-all
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found', code: 'API_NOT_FOUND' });
});

// In production, serve the built React app
if (env.NODE_ENV === 'production') {
  // ... existing SPA catch-all ...
}
```

Mount unconditionally so it works in both dev and production.

#### M7 — Replace Record<string, unknown> Casts

**File:** `apps/server/src/services/core/agent-manager.ts`

Replace the `as Record<string, unknown>` casts with a type-safe approach:

```typescript
// Define extended options type
interface ExtendedQueryOptions {
  model?: string;
  mcpServers?: Record<string, unknown>;
}

// In sendMessage():
const extendedOptions: ExtendedQueryOptions = {};
if (session.model) {
  extendedOptions.model = session.model;
}
if (Object.keys(this.mcpServers).length > 0) {
  extendedOptions.mcpServers = this.mcpServers;
}

const sdkOptions = {
  ...baseOptions,
  ...extendedOptions,
};
```

### Phase 5: Testing (M8)

#### Test: Error Handler Production Mode

**File:** `apps/server/src/middleware/__tests__/error-handler-prod.test.ts`

```typescript
describe('errorHandler in production', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('hides error message in production', () => {
    process.env.NODE_ENV = 'production';
    const res = mockResponse();
    errorHandler(new Error('DB connection failed at /internal/path'), mockReq, res, mockNext);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Internal Server Error',
      code: 'INTERNAL_ERROR',
    });
  });

  it('shows error message in development', () => {
    process.env.NODE_ENV = 'development';
    const res = mockResponse();
    errorHandler(new Error('Specific error'), mockReq, res, mockNext);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Specific error',
      code: 'INTERNAL_ERROR',
    });
  });
});
```

#### Test: Boundary Checks on PATCH and Stream

**File:** `apps/server/src/routes/__tests__/sessions-boundary.test.ts`

Test that PATCH and stream routes reject `cwd` values outside the boundary:

```typescript
describe('session routes boundary validation', () => {
  it('PATCH /:id rejects cwd outside boundary', async () => {
    const res = await request(app)
      .patch('/api/sessions/test-id?cwd=/etc/passwd')
      .send({ permissionMode: 'default' });
    expect(res.status).toBe(403);
  });

  it('GET /:id/stream rejects cwd outside boundary', async () => {
    const res = await request(app).get('/api/sessions/test-id/stream?cwd=/etc/passwd');
    expect(res.status).toBe(403);
  });
});
```

#### Test: Prototype Pollution Prevention

**File:** `apps/server/src/routes/__tests__/config-deepmerge.test.ts`

```typescript
describe('deepMerge prototype pollution', () => {
  it('ignores __proto__ keys', () => {
    const target = { a: 1 };
    const source = JSON.parse('{"__proto__": {"polluted": true}}');
    const result = deepMerge(target, source);
    expect(({} as any).polluted).toBeUndefined();
    expect(result).not.toHaveProperty('__proto__');
  });

  it('ignores constructor keys', () => {
    const result = deepMerge({}, { constructor: { polluted: true } } as any);
    expect(({} as any).polluted).toBeUndefined();
  });
});
```

#### Test: UUID Validation

**File:** `apps/server/src/lib/__tests__/route-utils.test.ts`

```typescript
describe('parseSessionId', () => {
  it('accepts valid UUID', () => {
    const res = mockResponse();
    const result = parseSessionId('550e8400-e29b-41d4-a716-446655440000', res);
    expect(result).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects non-UUID string', () => {
    const res = mockResponse();
    const result = parseSessionId('../../etc/passwd', res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects empty string', () => {
    const res = mockResponse();
    const result = parseSessionId('', res);
    expect(result).toBeNull();
  });
});
```

## User Experience

No user-visible changes. All fixes are server-side hardening. Clients may see new error codes (`INVALID_ID`, `SSE_LIMIT`, `SSE_SESSION_LIMIT`, `API_NOT_FOUND`) but these are additive and backward-compatible.

## Testing Strategy

- **Unit tests:** 4 new test files for security-critical paths (C1, C2, I4, M2)
- **Regression:** All existing 51 test files must continue passing
- **Verification:** `pnpm test -- --run`, `pnpm typecheck`, `pnpm lint` must all pass
- **File splits (C3, C4):** No new tests — verified by existing test suite passing + typecheck

## Performance Considerations

- **I1 (session cap):** Prevents memory exhaustion from unbounded session creation
- **I2 (reverse lookup):** Eliminates O(n) scan on every tool approval/answer submission, replacing with O(1) Map lookup
- **I5 (SSE limits):** Prevents resource exhaustion from unlimited SSE connections
- **I6 (keepalive fix):** Prevents unhandled write errors on closed connections

## Security Considerations

- **C1:** Prevents leaking internal error details (DB paths, stack traces) to clients in production
- **C2:** Prevents directory traversal via `cwd` query parameter on 2 session routes
- **I4:** Prevents prototype pollution via `__proto__`/`constructor`/`prototype` keys in config PATCH
- **M2:** Prevents processing of malformed session IDs (defense-in-depth)

## Documentation

No documentation changes needed. Internal server hardening only.

## Implementation Phases

### Phase 1: Security (C1, C2, I4)

- Error handler production guard
- Boundary checks on PATCH and stream routes
- Prototype pollution guard in deepMerge

### Phase 2: File Splits (C3, C4)

- Split mcp-tool-server.ts into 8 domain modules
- Extract adapter-error.ts and adapter-config.ts from adapter-manager.ts

### Phase 3: Performance & Reliability (I1, I2, I5, I6)

- Session Map cap with MAX_CONCURRENT constant
- Reverse lookup index for findSession
- SSE connection limits in SessionBroadcaster
- Keepalive race condition fix

### Phase 4: Code Quality (I7, M1-M4, M6, M7)

- Centralize vault root to lib/resolve-root.ts
- UUID validation helper in route-utils.ts
- Standardized sendError helper
- Replace unsafe type assertions in index.ts
- API 404 catch-all before SPA
- Replace Record<string, unknown> casts

### Phase 5: Testing (M8)

- Error handler production mode test
- Boundary validation tests
- Prototype pollution test
- UUID validation test

## Open Questions

None. All decisions resolved during ideation.

## Related ADRs

- **ADR-0001**: Use Hexagonal Architecture — informs Transport interface usage
- **ADR-0017**: Standardize Subsystem Integration Pattern — relevant to config parsing (M4)
- **ADR-0021**: Restructure Server Services into Domain Folders — confirms M5 is already done

## References

- Ideation: `specs/server-review-remediation-r3/01-ideation.md`
- OWASP Prototype Pollution Prevention: https://cheatsheetseries.owasp.org/cheatsheets/Prototype_Pollution_Prevention_Cheat_Sheet.html
- Express Error Handling: https://expressjs.com/en/guide/error-handling.html
