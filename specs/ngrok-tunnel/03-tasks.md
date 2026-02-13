---
slug: ngrok-tunnel
spec: specs/ngrok-tunnel/02-specification.md
generated: 2025-02-12
---

# ngrok Tunnel Integration — Task Decomposition

## Task Overview

| # | Task | Phase | Files | Depends On | Est. |
|---|------|-------|-------|------------|------|
| 1 | Add TunnelStatus schema and extend HealthResponse | Phase 1: Schemas | 3 | — | S |
| 2 | Update Transport interface and client adapters | Phase 1: Types | 3 | Task 1 | S |
| 3 | Create TunnelManager service | Phase 2: Core | 1 | — | M |
| 4 | Create TunnelManager unit tests | Phase 2: Tests | 1 | Task 3 | M |
| 5 | Integrate tunnel into health route | Phase 3: Server | 1 | Tasks 1, 3 | S |
| 6 | Integrate tunnel into server entry point | Phase 3: Server | 1 | Task 3 | M |
| 7 | Update OpenAPI registry | Phase 3: Server | 1 | Task 1 | S |
| 8 | Expand health route tests + add indirect test mocks | Phase 4: Tests | 5 | Tasks 3, 5 | M |
| 9 | Add dependency, scripts, env config, and Vite HMR | Phase 5: Config | 5 | — | S |
| 10 | Install, build, typecheck, and run all tests | Phase 5: Verify | — | All | S |

**Sizing:** S = small (< 15 min), M = medium (15-30 min)

---

## Task 1: Add TunnelStatus schema and extend HealthResponse

**Phase:** 1 — Schemas and Types
**Depends on:** None
**Files:**
- `packages/shared/src/schemas.ts` (MODIFY)
- `packages/shared/src/types.ts` (MODIFY)

### What to do

**In `packages/shared/src/schemas.ts`:**

1. After line 370 (`export type BrowseDirectoryResponse = ...`), insert the `TunnelStatusSchema`:

```typescript
// === Tunnel Status ===

export const TunnelStatusSchema = z
  .object({
    connected: z.boolean(),
    url: z.string().nullable(),
    port: z.number().int().nullable(),
    startedAt: z.string().nullable(),
  })
  .openapi('TunnelStatus');

export type TunnelStatus = z.infer<typeof TunnelStatusSchema>;
```

2. Replace lines 374-382 (the existing `HealthResponseSchema` and `HealthResponse` type) with:

```typescript
export const HealthResponseSchema = z
  .object({
    status: z.string(),
    version: z.string(),
    uptime: z.number(),
    tunnel: TunnelStatusSchema.optional(),
  })
  .openapi('HealthResponse');

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
```

**In `packages/shared/src/types.ts`:**

Add `HealthResponse` and `TunnelStatus` to the re-export list (before the closing `} from './schemas.js';`):

```typescript
  HealthResponse,
  TunnelStatus,
```

### Acceptance criteria
- `TunnelStatusSchema` is exported with `.openapi('TunnelStatus')` metadata
- `HealthResponseSchema` has optional `tunnel` field of type `TunnelStatusSchema`
- Both `HealthResponse` and `TunnelStatus` types are re-exported from `types.ts`
- Existing `ErrorResponseSchema` below is untouched

---

## Task 2: Update Transport interface and client adapters

**Phase:** 1 — Types
**Depends on:** Task 1
**Files:**
- `packages/shared/src/transport.ts` (MODIFY)
- `apps/client/src/lib/http-transport.ts` (MODIFY)
- `apps/client/src/lib/direct-transport.ts` (MODIFY)

### What to do

**In `packages/shared/src/transport.ts`:**

1. Add `HealthResponse` to the import block from `'./types.js'`
2. Replace line 42:
```typescript
// Before:
health(): Promise<{ status: string; version: string; uptime: number }>;
// After:
health(): Promise<HealthResponse>;
```

**In `apps/client/src/lib/http-transport.ts`:**

1. Add `HealthResponse` to type imports from `@lifeos/shared/types`
2. Replace the inline return type at line 154:
```typescript
// Before:
health(): Promise<{ status: string; version: string; uptime: number }> {
  return fetchJSON<{ status: string; version: string; uptime: number }>(this.baseUrl, '/health');
}
// After:
health(): Promise<HealthResponse> {
  return fetchJSON<HealthResponse>(this.baseUrl, '/health');
}
```

**In `apps/client/src/lib/direct-transport.ts`:**

1. Add `HealthResponse` to type imports from `@lifeos/shared/types`
2. Replace the inline return type at line 212:
```typescript
// Before:
async health(): Promise<{ status: string; version: string; uptime: number }> {
// After:
async health(): Promise<HealthResponse> {
```
The existing return value `{ status: 'ok', version: '0.1.0', uptime: 0 }` still satisfies the type since `tunnel` is optional.

### Acceptance criteria
- `Transport.health()` returns `Promise<HealthResponse>` instead of inline type
- Both `HttpTransport` and `DirectTransport` use `HealthResponse` type
- No behavior change — return values are identical

---

## Task 3: Create TunnelManager service

**Phase:** 2 — Core Service
**Depends on:** None (can be done in parallel with Task 1)
**Files:**
- `apps/server/src/services/tunnel-manager.ts` (CREATE)

### What to do

Create the file with the full implementation from spec section 3.1:

```typescript
export interface TunnelConfig {
  port: number;
  authtoken?: string;
  basicAuth?: string;
  domain?: string;
}

export interface TunnelStatus {
  enabled: boolean;
  connected: boolean;
  url: string | null;
  port: number | null;
  startedAt: string | null;
}

export class TunnelManager {
  private listener: { close(): Promise<void>; url(): string | null } | null = null;
  private _status: TunnelStatus = {
    enabled: false, connected: false, url: null, port: null, startedAt: null,
  };

  get status(): TunnelStatus { return { ...this._status }; }

  async start(config: TunnelConfig): Promise<string> {
    if (this.listener) throw new Error('Tunnel is already running');

    const ngrok = await import('@ngrok/ngrok');

    const forwardOpts: Record<string, unknown> = {
      addr: config.port,
      authtoken_from_env: true,
    };

    if (config.authtoken) {
      forwardOpts.authtoken = config.authtoken;
      delete forwardOpts.authtoken_from_env;
    }
    if (config.basicAuth) forwardOpts.basic_auth = [config.basicAuth];
    if (config.domain) forwardOpts.domain = config.domain;

    this.listener = await ngrok.forward(forwardOpts);
    const url = this.listener.url() ?? '';

    this._status = {
      enabled: true, connected: true, url, port: config.port,
      startedAt: new Date().toISOString(),
    };
    return url;
  }

  async stop(): Promise<void> {
    if (this.listener) {
      await this.listener.close();
      this.listener = null;
    }
    this._status = {
      enabled: this._status.enabled, connected: false, url: null,
      port: this._status.port, startedAt: this._status.startedAt,
    };
  }
}

export const tunnelManager = new TunnelManager();
```

### Design notes
- Listener type is structural (`{ close(), url() }`) to avoid top-level import of `@ngrok/ngrok`
- `authtoken_from_env: true` tells SDK to read `NGROK_AUTHTOKEN` from env; removed when explicit authtoken provided
- `basic_auth` accepts array of `"user:pass"` strings per ngrok SDK Config interface
- `stop()` preserves `enabled`, `port`, `startedAt` to indicate tunnel was active but shut down

### Acceptance criteria
- `TunnelManager` class with `start()`, `stop()`, and `status` getter
- Dynamic `import('@ngrok/ngrok')` — zero cost when disabled
- Singleton pattern: `export const tunnelManager = new TunnelManager()`
- Throws if `start()` called while already running
- `stop()` is idempotent

---

## Task 4: Create TunnelManager unit tests

**Phase:** 2 — Tests
**Depends on:** Task 3
**Files:**
- `apps/server/src/services/__tests__/tunnel-manager.test.ts` (CREATE)

### What to do

Create 9 unit tests covering all public API of `TunnelManager`:

1. **Initial status is disabled and disconnected** — Fresh instance has `{ enabled: false, connected: false, url: null, port: null, startedAt: null }`
2. **Calls `ngrok.forward()` with correct options** — Port and `authtoken_from_env: true`
3. **Passes `basic_auth` array when configured** — `basicAuth: 'user:pass'` → `basic_auth: ['user:pass']`
4. **Passes `domain` when configured** — `domain: 'my.ngrok.app'` → `domain: 'my.ngrok.app'`
5. **Uses explicit authtoken over `authtoken_from_env`** — When `authtoken` set, `authtoken_from_env` is removed
6. **Throws if already running** — Second `start()` throws `'Tunnel is already running'`
7. **`stop()` calls `listener.close()`** — Close is called, status updated
8. **`stop()` is safe when not running** — No error
9. **Status returns an immutable copy** — Modifying returned object doesn't affect internal state

### Pattern
- Mock `@ngrok/ngrok` at top level with `vi.mock()`
- Create mock listener with `url: vi.fn(() => 'https://test.ngrok.io')` and `close: vi.fn()`
- Mock `forward` to return mock listener
- Use `vi.resetModules()` + dynamic re-import in `beforeEach` for fresh TunnelManager instances (since it's a singleton)

### Acceptance criteria
- All 9 tests pass
- `@ngrok/ngrok` is fully mocked (no real network calls)
- Tests verify both options passed to `ngrok.forward()` and resulting status

---

## Task 5: Integrate tunnel into health route

**Phase:** 3 — Server Integration
**Depends on:** Tasks 1, 3
**Files:**
- `apps/server/src/routes/health.ts` (MODIFY)

### What to do

Replace the full content of `health.ts` with:

```typescript
import { Router } from 'express';
import { tunnelManager } from '../services/tunnel-manager.js';

const router = Router();

router.get('/', (_req, res) => {
  const response: Record<string, unknown> = {
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
  };

  const tunnelStatus = tunnelManager.status;
  if (tunnelStatus.enabled) {
    response.tunnel = {
      connected: tunnelStatus.connected,
      url: tunnelStatus.url,
      port: tunnelStatus.port,
      startedAt: tunnelStatus.startedAt,
    };
  }

  res.json(response);
});

export default router;
```

### Key behaviors
- When `enabled` is false, `tunnel` field is omitted entirely (zero behavior change from current)
- When `enabled` is true, includes `{ connected, url, port, startedAt }`
- **Import impact:** `createApp()` now transitively imports `tunnel-manager.js` via health routes — all test files that call `createApp()` must mock it (handled in Task 8)

### Acceptance criteria
- Health endpoint includes tunnel status when tunnel is enabled
- Health endpoint response is unchanged when tunnel is disabled
- No tunnel field present when `tunnelManager.status.enabled` is false

---

## Task 6: Integrate tunnel into server entry point

**Phase:** 3 — Server Integration
**Depends on:** Task 3
**Files:**
- `apps/server/src/index.ts` (MODIFY)

### What to do

Replace the full content of `index.ts` with the code from spec section 3.7. Key changes:

1. Add import: `import { tunnelManager } from './services/tunnel-manager.js';`
2. After `app.listen()` and the health check interval, add tunnel startup block:
   - Check `process.env.TUNNEL_ENABLED === 'true'`
   - Parse `TUNNEL_PORT` (default to `GATEWAY_PORT`)
   - Call `tunnelManager.start()` with config from env vars
   - Print pretty console box with URL, port, auth status, dev mode indicator, free tier warning
   - Wrap in try/catch — failure logs warning but doesn't kill server
3. Add graceful shutdown:
   - `shutdown()` function calls `tunnelManager.stop().finally(() => process.exit(0))`
   - Register on `SIGINT` and `SIGTERM`

### Key behaviors
- Non-blocking: tunnel failure → console warning, server continues
- Console box includes: URL, port, auth status, dev mode indicator (`TUNNEL_PORT !== GATEWAY_PORT`), free tier bandwidth warning
- Graceful shutdown ensures tunnel closes before process exits

### Acceptance criteria
- Server starts tunnel when `TUNNEL_ENABLED=true`
- Tunnel failure does not prevent server startup
- `Ctrl+C` triggers graceful tunnel shutdown
- Console output includes URL and configuration details

---

## Task 7: Update OpenAPI registry

**Phase:** 3 — Server Integration
**Depends on:** Task 1
**Files:**
- `apps/server/src/services/openapi-registry.ts` (MODIFY)

### What to do

Add `TunnelStatusSchema` to the import list from `@lifeos/shared/schemas`:

```typescript
import {
  // ... existing imports ...
  TunnelStatusSchema,
} from '@lifeos/shared/schemas';
```

No other changes needed — the `HealthResponseSchema` already references `TunnelStatusSchema` via the optional `tunnel` field after Task 1. The import is needed so the registry can resolve the schema reference during OpenAPI generation.

### Acceptance criteria
- `TunnelStatusSchema` is imported in openapi-registry.ts
- `/api/docs` and `/api/openapi.json` correctly show the optional tunnel field in health response

---

## Task 8: Expand health tests and add indirect test mocks

**Phase:** 4 — Test Updates
**Depends on:** Tasks 3, 5
**Files:**
- `apps/server/src/routes/__tests__/health.test.ts` (MODIFY)
- `apps/server/src/routes/__tests__/sessions.test.ts` (MODIFY)
- `apps/server/src/routes/__tests__/sessions-interactive.test.ts` (MODIFY)
- `apps/server/src/routes/__tests__/commands.test.ts` (MODIFY)
- `apps/server/src/routes/__tests__/directory.test.ts` (MODIFY)

### What to do

**In `health.test.ts`:**

Expand from 1 test to 3 tests. Add a `tunnel-manager.js` mock with `vi.fn()` getter for dynamic status control:

```typescript
vi.mock('../../services/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));
```

Add import to get the mock for dynamic control:

```typescript
import { tunnelManager } from '../../services/tunnel-manager.js';
```

Three tests:
1. **Health returns ok without tunnel field when disabled** (existing test, slightly updated)
2. **Health includes tunnel status when enabled and connected** — Set `tunnelManager.status` to `{ enabled: true, connected: true, url: 'https://test.ngrok.io', port: 6942, startedAt: '2025-01-01T00:00:00.000Z' }`, assert `res.body.tunnel` matches
3. **Health shows disconnected tunnel after stop** — Set `tunnelManager.status` to `{ enabled: true, connected: false, url: null, port: 6942, startedAt: '2025-01-01T00:00:00.000Z' }`, assert `res.body.tunnel.connected` is false

**In 4 indirect test files** (`sessions.test.ts`, `sessions-interactive.test.ts`, `commands.test.ts`, `directory.test.ts`):

Add the following mock near the other `vi.mock()` calls (before any imports):

```typescript
vi.mock('../../services/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));
```

These tests don't test tunnel behavior — the mock only prevents module resolution errors when `createApp()` loads `health.ts` which now imports `tunnel-manager.js`.

### Acceptance criteria
- Health test file has 3 passing tests
- All 4 indirect test files have tunnel-manager mock
- `turbo test` passes with no failures

---

## Task 9: Add dependency, scripts, env config, and Vite HMR

**Phase:** 5 — Config and DX
**Depends on:** None (can be done in parallel with earlier tasks)
**Files:**
- `apps/server/package.json` (MODIFY)
- `turbo.json` (MODIFY)
- `.env` (MODIFY)
- `apps/client/vite.config.ts` (MODIFY)

### What to do

**In `apps/server/package.json`:**

1. Add to `dependencies` (after `@lifeos/shared`):
```json
"@ngrok/ngrok": "^1.4.1",
```

2. Add to `scripts` (after `dev`):
```json
"dev:tunnel": "TUNNEL_ENABLED=true TUNNEL_PORT=3000 tsx watch src/index.ts",
```

**In `turbo.json`:**

Replace the `build.env` array:
```json
"env": ["NODE_ENV", "VITE_*", "GATEWAY_PORT", "NGROK_*", "TUNNEL_*"]
```

**In `.env`:**

Append the commented-out tunnel config block after existing content:

```env

# ── ngrok Tunnel ─────────────────────────────────────────────────────
# Opt-in external tunnel via ngrok. Requires a free ngrok account.
# Sign up at https://dashboard.ngrok.com/signup and copy your authtoken.
#
# WARNING: Free tier limits — 1GB/month bandwidth, session time limits,
# interstitial warning page on first visit.
#
# TUNNEL_ENABLED=true
# NGROK_AUTHTOKEN=your_authtoken_here
# TUNNEL_PORT=3000            # Port to tunnel (default: GATEWAY_PORT)
# TUNNEL_AUTH=user:pass        # HTTP basic auth (strongly recommended)
# TUNNEL_DOMAIN=              # Reserved domain (e.g. my-app.ngrok-free.app)
```

**In `apps/client/vite.config.ts`:**

Add `hmr: { clientPort: 443 }` inside the `server` block, after `allowedHosts`:

```typescript
server: {
  port: 3000,
  allowedHosts: ['.ngrok-free.app'],
  hmr: {
    clientPort: 443,
  },
  watch: {
    ignored: ['**/state/**'],
  },
  proxy: {
    '/api': {
      target: `http://localhost:${process.env.GATEWAY_PORT || 6942}`,
      changeOrigin: true,
    },
  },
},
```

This tells Vite's HMR WebSocket client to connect on port 443 (ngrok's HTTPS port). When no tunnel is active, Vite falls back gracefully.

### Acceptance criteria
- `@ngrok/ngrok` listed in server dependencies
- `dev:tunnel` script available
- Turborepo tracks `NGROK_*` and `TUNNEL_*` env vars for cache invalidation
- `.env` has documented tunnel config block (all commented out)
- Vite HMR configured for port 443

---

## Task 10: Install, build, typecheck, and run all tests

**Phase:** 5 — Verification
**Depends on:** All previous tasks
**Files:** None (verification only)

### What to do

1. Run `npm install` from root — `@ngrok/ngrok` installs
2. Run `turbo build` — all 3 apps build successfully
3. Run `turbo typecheck` — no type errors across all packages
4. Run `turbo test` — all existing + new tests pass

### Verification checklist
- [ ] `npm install` succeeds, `@ngrok/ngrok` in node_modules
- [ ] `turbo build` succeeds (client Vite + server tsc + obsidian plugin)
- [ ] `turbo typecheck` succeeds (all packages)
- [ ] `turbo test` succeeds (all new + existing tests pass)
- [ ] No behavior change when `TUNNEL_ENABLED` is unset (zero cost)

### Acceptance criteria
- All 3 build targets pass
- All tests pass (existing + 9 new TunnelManager tests + 2 new health tests)
- No type errors

---

## Dependency Graph

```
Task 1 (Schemas) ─────┬──→ Task 2 (Transport) ──→ ┐
                       ├──→ Task 5 (Health Route) → │
                       └──→ Task 7 (OpenAPI) ─────→ │
                                                     │
Task 3 (TunnelManager) ┬──→ Task 4 (TM Tests) ───→ │
                        ├──→ Task 5 (Health Route) → ├──→ Task 10 (Verify)
                        └──→ Task 6 (Entry Point) ─→ │
                                                     │
Task 5 (Health Route) ──→ Task 8 (Test Updates) ──→ │
                                                     │
Task 9 (Config/DX) ─────────────────────────────────┘
```

## Parallelization Strategy

**Batch 1** (parallel): Tasks 1, 3, 9
- Schemas/types, core service, and config are all independent

**Batch 2** (parallel, after Batch 1): Tasks 2, 4, 5, 6, 7
- All depend on Batch 1 outputs but are independent of each other

**Batch 3** (after Batch 2): Task 8
- Test updates need health route changes in place

**Batch 4** (after all): Task 10
- Final verification
