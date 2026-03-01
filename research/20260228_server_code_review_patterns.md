---
title: "Server Code Review Patterns Research"
date: 2026-02-28
type: implementation
status: archived
tags: [code-review, patterns, express, typescript, server, remediation]
feature_slug: server-review-remediation-r3
---

# Server Code Review Patterns Research

**Date**: 2026-02-28
**Mode**: Deep Research
**Topic**: Practical patterns for 8 server code review findings (C1, C3, C4, I1, I2, I4, I5, M2, M6, I7)

---

## Research Summary

Researched best practices for eight distinct code quality findings across Express error handling, file
splitting, prototype pollution, bounded Maps, SSE connection limits, API 404 routing, path
centralization, and session ID validation. All recommendations are grounded in the existing DorkOS
codebase (`apps/server/src/`).

---

## Key Findings

### 1. C1 — Express Error Handler Security

**Current code** (`apps/server/src/middleware/error-handler.ts`):
```typescript
res.status(500).json({
  error: err.message || 'Internal Server Error',  // leaks internal message
  code: 'INTERNAL_ERROR',
});
```

**Problem**: `err.message` leaks implementation details to clients in production. Any thrown error
— database connection string, file path, internal state — becomes visible in the HTTP response body.

**Recommended approach**: Use `NODE_ENV` to gate message exposure. Always log the real message
server-side, but return a generic string to the client in production.

```typescript
// apps/server/src/middleware/error-handler.ts
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error('[DorkOS Error]', err.message, err.stack);

  const isDev = process.env.NODE_ENV !== 'production';
  res.status(500).json({
    error: isDev ? err.message : 'Internal Server Error',
    code: 'INTERNAL_ERROR',
  });
}
```

**Packages to consider**:
- No package needed. The two-line check is sufficient and idiomatic.
- `express-error-toolkit` does this automatically when `NODE_ENV=production`, but adds a
  dependency for one conditional — not worth it.

**Trade-offs**:
- Simpler alternative is to always return `'Internal Server Error'` regardless of env. The
  downside is slightly worse local development DX. The NODE_ENV gate is the Node.js ecosystem
  standard.
- Do not use `err.status` or `err.statusCode` to set the HTTP status unless you've validated the
  value is within `400–599`. Unvalidated `err.status` can result in invalid HTTP responses.

---

### 2. C3/C4 — File Splitting for Large Service Files

Two files are flagged: `mcp-tool-server.ts` (~940 lines) and `adapter-manager.ts` (~957 lines).
The project's own `.claude/rules/file-size.md` mandates splitting at 500+ lines.

#### Pattern: Domain Registration Modules

The cleanest pattern for a tool server that registers tools across N domains is **domain
registration modules** — one file per domain that exports a `registerXxxTools(server, deps)`
function. The composition root (the original file) becomes an orchestrator that calls each
registration function.

**For `mcp-tool-server.ts`** — current domains visible in the file: core, agent, pulse, relay,
trace, mesh, binding. Each becomes its own file:

```
services/core/mcp-tools/
├── index.ts              # createDorkOsToolServer() — composition root, ~40 lines
├── core-tools.ts         # ping, get_server_info, get_session_count — ~60 lines
├── agent-tools.ts        # agent_get_current — ~40 lines
├── pulse-tools.ts        # list/create/update/delete schedules, run history — ~120 lines
├── relay-tools.ts        # relay_send, relay_inbox, relay_list_endpoints, relay_register_endpoint — ~100 lines
├── trace-tools.ts        # relay_get_trace, relay_get_metrics — ~60 lines
├── mesh-tools.ts         # mesh_discover, mesh_register, mesh_deny, etc. — ~140 lines
└── binding-tools.ts      # binding_list, binding_create, binding_delete — ~80 lines
```

Each domain module has the shape:
```typescript
// pulse-tools.ts
import type { McpToolDeps } from './types.js'; // shared deps type lives in a types.ts

export function registerPulseTools(server: ReturnType<typeof createSdkMcpServer>, deps: McpToolDeps): void {
  if (!deps.pulseStore) return; // feature guard stays in the domain module

  server.tool('list_schedules', { enabled_only: z.boolean().optional() }, createListSchedulesHandler(deps));
  server.tool('create_schedule', CreateScheduleSchema, createCreateScheduleHandler(deps));
  // ...
}
```

Composition root:
```typescript
// index.ts (was mcp-tool-server.ts)
export function createDorkOsToolServer(deps: McpToolDeps) {
  const server = createSdkMcpServer({ name: 'dorkos' });
  registerCoreTools(server, deps);
  registerAgentTools(server, deps);
  registerPulseTools(server, deps);  // no-op when deps.pulseStore is undefined
  registerRelayTools(server, deps);
  registerTraceTools(server, deps);
  registerMeshTools(server, deps);
  registerBindingTools(server, deps);
  return server;
}
```

This preserves `McpToolDeps` and all handler factories exactly as-is. Existing tests for handler
factories still work without modification. Only the `createDorkOsToolServer` call site (`index.ts`)
is touched.

#### Pattern: Adapter Manager Splitting

`adapter-manager.ts` has four distinct responsibilities: CRUD operations, hot-reload/config watching,
plugin loading (npm/local), and the catalog of available adapters. Split on responsibility lines:

```
services/relay/adapter-manager/
├── index.ts              # AdapterManager class (constructor + initialize + public API) — ~150 lines
├── adapter-crud.ts       # add/remove/update adapter methods + AdapterError — ~150 lines
├── config-watcher.ts     # chokidar-based hot-reload logic — ~120 lines
├── plugin-loader.ts      # npm plugin + local file plugin loading — ~100 lines
└── catalog.ts            # getCatalog, getManifest, populateBuiltinManifests — ~80 lines
```

The `AdapterManager` class delegates to these modules as private helpers, keeping its public
interface unchanged. The test file `adapter-manager.test.ts` needs no changes — it tests the
public interface.

**Key principle for both splits**: Keep the composition root's public API surface identical.
Nothing outside the service module changes. Only the internals are reorganized.

---

### 3. I4 — Prototype Pollution Prevention in deepMerge

**Problem**: Custom `deepMerge` implementations that naively spread or assign object keys will
pollute `Object.prototype` if an attacker passes `{ "__proto__": { "isAdmin": true } }`.

**Recommended approach**: Filter dangerous keys during the merge. The three dangerous keys are
`__proto__`, `constructor`, and `prototype`. This is the OWASP-recommended approach.

```typescript
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) continue; // skip pollution vectors
    const sourceVal = source[key as keyof T];
    const targetVal = result[key as keyof T];
    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key as keyof T] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      ) as T[keyof T];
    } else if (sourceVal !== undefined) {
      result[key as keyof T] = sourceVal;
    }
  }
  return result;
}
```

**Packages to consider**:
- `deepmerge` (npm) — popular, ~2M weekly downloads, handles prototype pollution via `isMergeableObject`. Use `deepmerge(target, source)`. Well-tested, actively maintained.
- `ts-deepmerge` — had CVE-2022-25907 (fixed in v2+). Acceptable if using current version.
- `@75lb/deep-merge` — had CVE-2024-38986 via lodash dependency. Avoid.

**Recommendation for DorkOS**: The key-filtering pattern above is ~12 lines and has no dependency.
For a config-merge use case (which is the typical DorkOS pattern), this is the right trade-off.
If the usage is more complex, add `deepmerge` directly.

**`Object.create(null)` vs key filtering**:
- `Object.create(null)` creates a prototype-free object, solving pollution for the result, but
  does not prevent pollution of the shared `Object.prototype` during the merge itself.
- Key filtering is the correct defense — block the dangerous keys before they are ever assigned.
- `Object.freeze(Object.prototype)` is a global nuclear option; it can break third-party libs
  and is not recommended for library code.

---

### 4. I1 — Session Map Bounding and I2 — Reverse Lookup Index

These two issues appear in `BindingRouter` (`services/relay/binding-router.ts`).

**I1 — Bounded Map**: The current code sets `MAX_SESSIONS = 10_000` as a constant but the
`sessionMap` is still a plain `Map<string, string>`. When the map exceeds 10,000 entries, nothing
evicts old entries. The fix is to replace `Map` with `lru-cache`.

**`lru-cache` (isaacs/node-lru-cache)** is the de facto standard. It has TypeScript types built in
(rewritten in TS for v7+). The API requires at minimum one of `max`, `ttl`, or `maxSize`.

```typescript
import { LRUCache } from 'lru-cache';

// In BindingRouter:
private sessionMap = new LRUCache<string, string>({
  max: BindingRouter.MAX_SESSIONS,   // evict LRU entry when full
  ttl: 1000 * 60 * 60 * 24 * 7,     // 7-day TTL for session mappings
  updateAgeOnGet: true,               // reset TTL on access (active sessions stay warm)
});
```

`lru-cache` v10+ is a pure ESM package with zero runtime dependencies. It is already widely used
in the Node.js ecosystem and compatible with the NodeNext module setup in this project.

Install: `pnpm add lru-cache` (the `@types/lru-cache` package is obsolete — types are bundled).

**I2 — Reverse Lookup Index**: The current pattern in `BindingRouter` does O(n) scans over
`sessionMap` when looking up by session ID (e.g., to clean up orphaned sessions). The fix is a
synchronized inverse map.

The pattern is a **manually synchronized bidirectional map** — two Maps kept in sync on every
write:

```typescript
// Two maps: forward (key → sessionId) and reverse (sessionId → key)
private sessionMap = new LRUCache<string, string>({ max: BindingRouter.MAX_SESSIONS });
private sessionIndex = new Map<string, string>(); // sessionId → key (reverse lookup)

private setSession(key: string, sessionId: string): void {
  // Clean up old reverse entry if key is being reassigned
  const oldSessionId = this.sessionMap.get(key);
  if (oldSessionId) this.sessionIndex.delete(oldSessionId);

  this.sessionMap.set(key, sessionId);
  this.sessionIndex.set(sessionId, key);
}

private deleteSession(key: string): void {
  const sessionId = this.sessionMap.get(key);
  if (sessionId) this.sessionIndex.delete(sessionId);
  this.sessionMap.delete(key);
}

// Reverse lookup: O(1) instead of O(n)
getKeyBySessionId(sessionId: string): string | undefined {
  return this.sessionIndex.get(sessionId);
}
```

Note: When using `lru-cache` with an eviction callback (`dispose`), the reverse index also needs
to be cleaned on eviction:

```typescript
private sessionMap = new LRUCache<string, string>({
  max: BindingRouter.MAX_SESSIONS,
  dispose: (sessionId: string, key: string) => {
    this.sessionIndex.delete(sessionId);
  },
});
```

**Packages to consider**:
- `bidirectional-map` (npm) — provides `.get()`, `.getKey()`, `.has()`, `.hasValue()`. Simple,
  but only supports 1:1 mappings. Fine for this use case.
- Manual two-Map pattern (shown above) — ~15 extra lines, zero dependencies, more transparent.
- **Recommendation**: Manual pattern. The overhead is trivial and the behavior is explicit.

---

### 5. I5 — SSE Connection Limits

**Problem**: `SessionBroadcaster` accepts unlimited SSE connections. Each connection holds an open
HTTP response, a file watcher, and potentially a Relay subscription. Under load or via a
malicious client, this can exhaust memory and file descriptors.

**Where to enforce limits**: In `SessionBroadcaster.registerClient()`, not in middleware. The
reasoning is that SSE connections are semantically different from regular HTTP requests — the
limit is a per-session and global resource budget, not a throughput rate limit. Middleware is
the right place for rate limiting; resource budgets belong in the service.

**Recommended approach — two counters**:

```typescript
// In SessionBroadcaster:
private static readonly MAX_CLIENTS_PER_SESSION = 10;
private static readonly MAX_TOTAL_CLIENTS = 500;
private totalClientCount = 0;

registerClient(sessionId: string, vaultRoot: string, res: Response, clientId?: string): void {
  // Global limit check
  if (this.totalClientCount >= SessionBroadcaster.MAX_TOTAL_CLIENTS) {
    res.status(503).json({ error: 'SSE connection limit reached' });
    return;
  }

  // Per-session limit check
  const sessionClients = this.clients.get(sessionId);
  if (sessionClients && sessionClients.size >= SessionBroadcaster.MAX_CLIENTS_PER_SESSION) {
    res.status(503).json({ error: 'Too many connections for this session' });
    return;
  }

  this.totalClientCount++;
  res.on('close', () => {
    this.totalClientCount--;
    // ... existing cleanup
  });

  // ... rest of existing registration logic
}
```

**Browser SSE context**: Browsers enforce a limit of 6 concurrent SSE connections per origin
when using HTTP/1.1. This means the per-session limit of 10 will rarely be hit by a single
browser user, but it protects against programmatic clients and Claude Code agents that open
multiple connections to the same session.

**Packages to consider**:
- `bottleneck` — for rate limiting async work. Not the right fit here (this is resource
  budgeting, not rate limiting).
- No package needed. The two-counter approach above is ~15 lines.

---

### 6. M6 — API 404 Handler for SPA Catch-all

**Current code** (`apps/server/src/app.ts`):
```typescript
// In production:
app.use(express.static(distPath));
app.get('*', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));  // catches /api/... misses too
});
```

**Problem**: If an API route returns nothing (falls through all handlers), the `app.get('*')`
SPA catch-all returns `index.html` with a 200 status for API misses instead of a JSON 404.

**Recommended approach**: Add an explicit `/api/*` 404 handler _before_ the SPA catch-all.
Route order in Express is the mechanism — no special library needed.

```typescript
// apps/server/src/app.ts — in the production block:
if (env.NODE_ENV === 'production') {
  const distPath = env.CLIENT_DIST_PATH ?? path.join(__dirname, '../../client/dist');
  app.use(express.static(distPath));

  // API miss — must come BEFORE the SPA catch-all
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found', code: 'API_NOT_FOUND' });
  });

  // SPA fallback — handles everything else
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}
```

Note: This same `/api` 404 handler should also be registered in development mode (before
`errorHandler`) so that unknown API routes don't fall through to Express's default HTML 404.
In development, there is no SPA catch-all — Express will return its default HTML 404 for
unmatched routes. Adding the `/api` 404 handler unconditionally (outside the `if (production)`
block) is the cleaner fix:

```typescript
// After all API route registrations, before the static file serving block:
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found', code: 'API_NOT_FOUND' });
});
```

**Trade-offs**:
- Place this handler after all `app.use('/api/...')` registrations, otherwise it will intercept
  legitimate routes.
- Express 404 handling is not an error — `next(err)` is not called for 404s, so the
  `errorHandler` middleware does not catch them. This explicit handler is the canonical solution
  per Express docs.

---

### 7. I7 — Centralized Path Resolution

**Current code** (duplicated in at least 4 files):
```typescript
// routes/sessions.ts, routes/commands.ts, routes/relay.ts, services/core/agent-manager.ts
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vaultRoot = path.resolve(__dirname, '../../../../');
```

**Problem**: The `'../../../../'` traversal is brittle — it is a convention that only holds when
the file lives at exactly `apps/server/src/routes/` depth. Any file reorganization silently
breaks the root resolution.

**Recommended approach**: Centralize into a `lib/` utility that derives the server package root
once, then let callers derive the repo root from that.

```typescript
// apps/server/src/lib/resolve-root.ts
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Absolute path to the server package root (the directory containing package.json).
 * Derived once at module load time from this file's location in `src/lib/`.
 */
export const SERVER_PACKAGE_ROOT: string = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',  // src/lib/ → src/ → apps/server/
);

/**
 * Absolute path to the monorepo root (two levels above the server package).
 * Use this as the default vault root when no CWD is specified.
 */
export const REPO_ROOT: string = path.resolve(SERVER_PACKAGE_ROOT, '../..');
```

Then in every file that previously inlined the resolution:
```typescript
// Before:
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vaultRoot = path.resolve(__dirname, '../../../../');

// After:
import { REPO_ROOT } from '../lib/resolve-root.js';
const vaultRoot = REPO_ROOT;
```

**Node.js 20.11+ option**: `import.meta.dirname` is now available natively, removing the
`fileURLToPath` call:
```typescript
export const SERVER_PACKAGE_ROOT: string = path.resolve(import.meta.dirname, '../..');
```

Since DorkOS targets Node 20+, this is usable. However, keeping `fileURLToPath` is also fine for
maximum compatibility.

**Trade-offs**:
- A `lib/resolve-root.ts` module is a single point of truth. If the server package moves, one
  file changes.
- The alternative is setting `DORKOS_DEFAULT_CWD` in the startup process and reading it
  everywhere via `env.DORKOS_DEFAULT_CWD`. `index.ts` already sets this for the CLI. Routes
  could then import from `env.ts` instead of doing path resolution at all. This is arguably
  cleaner for routes but does not work before the env is initialized.
- **Recommendation**: `lib/resolve-root.ts` for the physical path constants. Routes that need
  a runtime CWD should prefer `env.DORKOS_DEFAULT_CWD` (already set in `index.ts` startup).

---

### 8. M2 — Session ID Validation

**Current pattern** (inferred from route params): Route handlers receive `req.params.id` and use
it directly without format validation. If a malformed `id` reaches the transcript reader or file
system, it can cause unexpected errors or log noise.

**UUID v4 regex vs Zod**:

A UUID v4 regex is:
```
/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
```

This is correct and sufficient for a simple param guard. However, Zod is already a dependency in
this project and provides `z.string().uuid()` (which matches all UUID versions) or `z.uuidv4()`
in Zod v4. The Zod approach is more readable, self-documenting, and consistent with how the rest
of the server validates request bodies.

**Recommended approach — inline Zod parse for params**:

```typescript
// In route handlers that receive :id (sessions, relay, etc.)
const idResult = z.string().uuid().safeParse(req.params.id);
if (!idResult.success) {
  res.status(400).json({ error: 'Invalid session ID format', code: 'INVALID_ID' });
  return;
}
const sessionId = idResult.data;
```

This is 4 lines per route. If many routes share this pattern, extract a helper:

```typescript
// apps/server/src/lib/route-utils.ts (already exists — add to it)
import { z } from 'zod';

/** Parse and validate a UUID route param. Returns null and sends 400 if invalid. */
export function parseUuidParam(
  paramValue: string,
  res: Response,
): string | null {
  const result = z.string().uuid().safeParse(paramValue);
  if (!result.success) {
    res.status(400).json({ error: 'Invalid ID format', code: 'INVALID_ID' });
    return null;
  }
  return result.data;
}
```

Usage:
```typescript
const sessionId = parseUuidParam(req.params.id, res);
if (!sessionId) return;
// ... rest of handler
```

**Packages to consider**:
- `express-validator` — popular, but adds a new API surface and dependency for something Zod
  already handles.
- `express-zod-safe` — wraps params/body/query validation cleanly with TypeScript types, worth
  considering if adopting Zod validation more broadly.
- **Recommendation**: Inline Zod + `parseUuidParam` helper in `route-utils.ts`. Zero new
  dependencies, consistent with existing patterns.

**Trade-offs**:
- UUID validation only prevents malformed IDs from reaching the file system. It does not prevent
  valid-format UUIDs that reference non-existent sessions — the service layer handles that.
- Session IDs from the Claude Agent SDK are always UUID v4, so `z.string().uuid()` (which also
  accepts v1/v5/v6/v7) is slightly more permissive than strictly necessary but fine in practice.

---

## Detailed Analysis

### Dependency Summary

| Finding | New Package Required | Recommendation |
|---------|---------------------|----------------|
| C1 — Error handler | None | `process.env.NODE_ENV !== 'production'` guard |
| C3 — MCP tool server split | None | Domain registration modules pattern |
| C4 — Adapter manager split | None | Responsibility-based module split |
| I4 — Prototype pollution | None (or `deepmerge`) | Key-filter set + optional `deepmerge` |
| I1 — Session map bounding | `lru-cache` | Replace `Map` with `LRUCache` |
| I2 — Reverse lookup | None | Manual bidirectional Map pattern |
| I5 — SSE connection limits | None | Two counters in `SessionBroadcaster` |
| M6 — API 404 / SPA catch-all | None | Route order: `/api` 404 before `*` |
| I7 — Path centralization | None | `lib/resolve-root.ts` singleton |
| M2 — Session ID validation | None | `parseUuidParam` in `route-utils.ts` |

Only `lru-cache` is a net-new dependency. It is already the de facto Node.js standard for bounded
in-memory caches and has zero runtime dependencies.

### Patterns That Interact

- **I7 (path centralization) + M2 (UUID validation)**: Both benefit from expanding `lib/route-utils.ts`,
  which already exists at `apps/server/src/lib/route-utils.ts`. Path constants and the UUID helper
  are both "shared infrastructure" — slightly different concerns, so `resolve-root.ts` as a separate
  file is cleaner.

- **I1 (bounded Map) + I2 (reverse lookup)**: These are solved together in `BindingRouter`. The
  `dispose` callback on `lru-cache` is the hook to keep the reverse index clean on eviction.
  Implement both changes simultaneously — they interact through the same data structure.

- **C3/C4 (file splits)**: The handler factories in `mcp-tool-server.ts` are already well-extracted
  (each handler is its own function). The split is primarily a file organization change. The
  `McpToolDeps` interface should be extracted to a `types.ts` file that all domain modules import,
  to avoid circular imports between domain modules and the composition root.

### Implementation Order

Suggested implementation order based on risk and impact:

1. **C1** — 2-line change, no risk, immediate security improvement.
2. **M6** — 3-line change, fixes a silent bug where `/api/bad-route` returns 200+HTML.
3. **M2** — Add `parseUuidParam` to `route-utils.ts`, apply to session/relay routes.
4. **I4** — Key-filter `deepMerge` if the function exists; verify no usage of lodash merge.
5. **I7** — Create `lib/resolve-root.ts`, migrate the 4+ call sites.
6. **I5** — Add two counters to `SessionBroadcaster`.
7. **I1 + I2** — Together: swap `Map` for `LRUCache` in `BindingRouter`, add reverse index.
8. **C3 + C4** — File splits: highest effort, lowest risk when done carefully.

---

## Sources & Evidence

- [Express error handling — Official Docs](https://expressjs.com/en/guide/error-handling.html)
- [Hide error details from client — Node Best Practices](https://nodejsbestpractices.com/sections/security/hideerrors/)
- [Prototype Pollution Prevention — OWASP Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Prototype_Pollution_Prevention_Cheat_Sheet.html)
- [JavaScript prototype pollution — MDN Security](https://developer.mozilla.org/en-US/docs/Web/Security/Attacks/Prototype_pollution)
- [Preventing prototype pollution — PortSwigger Web Security Academy](https://portswigger.net/web-security/prototype-pollution/preventing)
- [CVE-2024-38986 — @75lb/deep-merge prototype pollution via lodash](https://gist.github.com/mestrtee/b20c3aee8bea16e1863933778da6e4cb)
- [lru-cache — npm (isaacs/node-lru-cache)](https://www.npmjs.com/package/lru-cache)
- [Using LRU Cache in Node.js and TypeScript — DEV Community](https://dev.to/shayy/using-lru-cache-in-nodejs-and-typescript-7d9)
- [bidirectional-map — npm](https://www.npmjs.com/package/bidirectional-map)
- [Express.js route validation with Zod — Medium](https://medium.com/@nik14gos/express-js-route-validation-with-zod-26cafe5f6b3d)
- [__dirname is back in Node.js with ES modules — Sonar](https://www.sonarsource.com/blog/dirname-node-js-es-modules/)
- [import.meta — MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import.meta)

## Research Gaps & Limitations

- The exact line counts for `mcp-tool-server.ts` and `adapter-manager.ts` domain sections were
  estimated from reading the first ~160 lines of each. Actual module boundaries should be confirmed
  by reading the full files before implementing the split.
- `lru-cache` v10 is pure ESM. If any CommonJS consumers exist in the build chain (Obsidian plugin
  uses CJS), verify interoperability. The server uses NodeNext modules so ESM is fine there.
- The `deepMerge` usage in DorkOS was not located during this research. The I4 finding assumes a
  custom implementation exists — verify its location before applying the fix.

## Search Methodology

- Searches performed: 10
- Most productive terms: "prototype pollution prevention deepMerge", "lru-cache v10 TypeScript API",
  "Express API 404 JSON SPA catch-all", "Node.js centralize import.meta.url dirname singleton"
- Primary sources: expressjs.com, OWASP, MDN, npm package pages, node-lru-cache GitHub
