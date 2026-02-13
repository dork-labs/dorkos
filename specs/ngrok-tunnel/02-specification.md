---
slug: ngrok-tunnel
---

# ngrok Tunnel Integration — Implementation Specification

## Table of Contents

1. [Overview](#1-overview)
2. [Environment Variables](#2-environment-variables)
3. [File-by-File Specification](#3-file-by-file-specification)
4. [Data Flow](#4-data-flow)
5. [Build Sequence](#5-build-sequence)
6. [Acceptance Criteria](#6-acceptance-criteria)
7. [Non-Regression Requirements](#7-non-regression-requirements)
8. [Security Considerations](#8-security-considerations)
9. [Error Handling Matrix](#9-error-handling-matrix)

---

## 1. Overview

Add opt-in ngrok tunnel support to the Express server using `@ngrok/ngrok` (official SDK). When enabled via `TUNNEL_ENABLED=true`, the server starts a public ngrok tunnel after Express binds its port. The tunnel URL is printed to the console and exposed via `GET /api/health`. Tunnel failure is non-blocking — the server continues without a tunnel.

**Key design choices:**
- Singleton service pattern (matches `AgentManager`, `TranscriptReader`)
- Dynamic import of `@ngrok/ngrok` (zero cost when disabled)
- Environment-variable-only configuration (no config files)
- Console-only URL display for v1 (no client UI changes)

---

## 2. Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TUNNEL_ENABLED` | No | `undefined` | Set to `true` to enable tunnel on server boot |
| `NGROK_AUTHTOKEN` | When tunnel enabled | — | ngrok auth token (SDK reads from env automatically) |
| `TUNNEL_PORT` | No | `GATEWAY_PORT` (6942) | Port to tunnel (set to 3000 for Vite dev server) |
| `TUNNEL_AUTH` | No | — | HTTP basic auth in `user:pass` format |
| `TUNNEL_DOMAIN` | No | — | Reserved ngrok domain (e.g. `my-app.ngrok-free.app`) |

---

## 3. File-by-File Specification

### 3.1 CREATE: `apps/server/src/services/tunnel-manager.ts`

**Purpose:** Core tunnel lifecycle service. Manages ngrok tunnel start/stop and exposes status.

**Pattern reference:** Follows the singleton class + exported instance pattern from `apps/server/src/services/agent-manager.ts` (line 171: `export class AgentManager`, line 551: `export const agentManager = new AgentManager()`).

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

**Design notes:**
- Listener type is structural (`{ close(), url() }`) to avoid top-level import of `@ngrok/ngrok`
- `authtoken_from_env: true` tells SDK to read `NGROK_AUTHTOKEN` from env; removed when explicit authtoken provided
- `basic_auth` accepts array of `"user:pass"` strings per ngrok SDK Config interface
- `stop()` preserves `enabled`, `port`, `startedAt` to indicate tunnel was active but shut down

---

### 3.2 CREATE: `apps/server/src/services/__tests__/tunnel-manager.test.ts`

**Purpose:** Unit tests for TunnelManager. 9 tests covering all public API.

**Tests:**
1. Initial status is disabled and disconnected
2. Calls `ngrok.forward()` with correct options (port, authtoken_from_env)
3. Passes `basic_auth` array when configured
4. Passes `domain` when configured
5. Uses explicit authtoken over `authtoken_from_env`
6. Throws if already running
7. `stop()` calls `listener.close()`
8. `stop()` is safe when not running
9. Status returns an immutable copy

**Pattern:** Mock `@ngrok/ngrok` at top level with `vi.mock()`. Use `vi.resetModules()` + dynamic re-import in `beforeEach` for fresh instances.

---

### 3.3 MODIFY: `packages/shared/src/schemas.ts`

**Change 1:** After line 370 (end of `BrowseDirectoryResponse` type), insert:

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

**Change 2:** Replace lines 374-382 (existing `HealthResponseSchema` + type) with:

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

---

### 3.4 MODIFY: `packages/shared/src/types.ts`

Add `HealthResponse` and `TunnelStatus` to the re-export list before the closing `} from './schemas.js';`.

---

### 3.5 MODIFY: `packages/shared/src/transport.ts`

**Change 1:** Add `HealthResponse` to import block.

**Change 2:** Replace line 42:
```typescript
// Before:
health(): Promise<{ status: string; version: string; uptime: number }>;
// After:
health(): Promise<HealthResponse>;
```

---

### 3.6 MODIFY: `apps/server/src/routes/health.ts`

**Full replacement:**

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

**Key:** When `enabled` is false, `tunnel` field is omitted entirely (zero behavior change).

**Import impact:** `createApp()` now transitively imports `tunnel-manager.js` via health routes. All test files that call `createApp()` must mock `tunnel-manager.js`.

---

### 3.7 MODIFY: `apps/server/src/index.ts`

**Full replacement:**

```typescript
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createApp } from './app.js';
import { agentManager } from './services/agent-manager.js';
import { tunnelManager } from './services/tunnel-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const PORT = parseInt(process.env.GATEWAY_PORT || '6942', 10);

async function start() {
  const app = createApp();
  app.listen(PORT, 'localhost', () => {
    console.log(`Gateway server running on http://localhost:${PORT}`);
  });

  // Run session health check every 5 minutes
  setInterval(() => {
    agentManager.checkSessionHealth();
  }, 5 * 60 * 1000);

  // Start ngrok tunnel if enabled
  if (process.env.TUNNEL_ENABLED === 'true') {
    const tunnelPort = parseInt(process.env.TUNNEL_PORT || String(PORT), 10);

    try {
      const url = await tunnelManager.start({
        port: tunnelPort,
        authtoken: process.env.NGROK_AUTHTOKEN,
        basicAuth: process.env.TUNNEL_AUTH,
        domain: process.env.TUNNEL_DOMAIN,
      });

      const hasAuth = !!process.env.TUNNEL_AUTH;
      const isDevPort = tunnelPort !== PORT;

      console.log('');
      console.log('\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510');
      console.log('\u2502  ngrok tunnel active                            \u2502');
      console.log('\u2502                                                 \u2502');
      console.log(`\u2502  URL:  ${url.padEnd(40)} \u2502`);
      console.log(`\u2502  Port: ${String(tunnelPort).padEnd(40)} \u2502`);
      console.log(`\u2502  Auth: ${(hasAuth ? 'basic auth enabled' : 'none (open)').padEnd(40)} \u2502`);
      if (isDevPort) {
        console.log(`\u2502  Mode: ${('dev (Vite on :' + tunnelPort + ')').padEnd(40)} \u2502`);
      }
      console.log('\u2502                                                 \u2502');
      console.log('\u2502  Free tier: 1GB/month bandwidth, session limits \u2502');
      console.log('\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518');
      console.log('');
    } catch (err) {
      console.warn('[Tunnel] Failed to start ngrok tunnel:', err instanceof Error ? err.message : err);
      console.warn('[Tunnel] Server continues without tunnel.');
    }
  }
}

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  tunnelManager.stop().finally(() => { process.exit(0); });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
```

**Key behaviors:**
1. Non-blocking failure (try/catch)
2. Graceful shutdown (SIGINT/SIGTERM → tunnelManager.stop())
3. Pretty console box with URL, port, auth status, dev mode indicator, free tier warning
4. `TUNNEL_PORT` defaults to `GATEWAY_PORT`

---

### 3.8 MODIFY: `apps/server/src/services/openapi-registry.ts`

Add `TunnelStatusSchema` to the import list from `@lifeos/shared/schemas`. No other changes needed — the `HealthResponseSchema` already contains the optional tunnel field after the schema change.

---

### 3.9 MODIFY: `apps/client/src/lib/http-transport.ts`

Add `HealthResponse` to the type import block. Replace inline `health()` return type with `Promise<HealthResponse>`.

---

### 3.10 MODIFY: `apps/client/src/lib/direct-transport.ts`

Add `HealthResponse` to the type imports. Replace inline `health()` return type with `Promise<HealthResponse>`. Existing return value (`{ status, version, uptime }`) satisfies the type since `tunnel` is optional.

---

### 3.11 MODIFY: `apps/server/package.json`

**Change 1:** Add `"@ngrok/ngrok": "^1.4.1"` to `dependencies` (after `@lifeos/shared`).

**Change 2:** Add script `"dev:tunnel": "TUNNEL_ENABLED=true TUNNEL_PORT=3000 tsx watch src/index.ts"` (after `dev`).

---

### 3.12 MODIFY: `turbo.json`

Add `"NGROK_*"` and `"TUNNEL_*"` to `build.env` array:
```json
"env": ["NODE_ENV", "VITE_*", "GATEWAY_PORT", "NGROK_*", "TUNNEL_*"]
```

---

### 3.13 MODIFY: `.env`

Append commented-out tunnel configuration block:

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

---

### 3.14 MODIFY: `apps/client/vite.config.ts`

Add `hmr: { clientPort: 443 }` inside the `server` block. This tells Vite's HMR WebSocket client to connect on port 443 (ngrok's HTTPS port). When no tunnel is active, Vite falls back gracefully.

```typescript
server: {
  port: 3000,
  allowedHosts: ['.ngrok-free.app'],
  hmr: {
    clientPort: 443,
  },
  watch: { ignored: ['**/state/**'] },
  proxy: { '/api': { target: `http://localhost:${process.env.GATEWAY_PORT || 6942}`, changeOrigin: true } },
},
```

---

### 3.15 MODIFY: `apps/server/src/routes/__tests__/health.test.ts`

Expand from 1 test to 3 tests. Add `tunnel-manager.js` mock with `vi.fn()` getter for dynamic status control.

**Tests:**
1. Health returns ok without tunnel field when disabled
2. Health includes tunnel status when enabled and connected
3. Health shows disconnected tunnel after stop

---

### 3.16 MODIFY: Indirect test files (4 files)

Add `vi.mock('../../services/tunnel-manager.js')` with static disabled-status object to:
1. `apps/server/src/routes/__tests__/sessions.test.ts`
2. `apps/server/src/routes/__tests__/sessions-interactive.test.ts`
3. `apps/server/src/routes/__tests__/commands.test.ts`
4. `apps/server/src/routes/__tests__/directory.test.ts`

These tests don't test tunnel behavior — the mock only prevents module resolution errors when `createApp()` loads `health.ts`.

---

## 4. Data Flow

### Tunnel Startup
```
Server boots → createApp() → app.listen(PORT)
  → TUNNEL_ENABLED=true?
    → YES: tunnelManager.start(config)
      → Dynamic import('@ngrok/ngrok')
      → ngrok.forward({ addr, authtoken_from_env, basic_auth?, domain? })
      → Print console box with URL
    → NO: Server ready, no tunnel (zero cost)
```

### Health Endpoint
```
GET /api/health
  → Build { status, version, uptime }
  → tunnelManager.status.enabled?
    → YES: Add tunnel: { connected, url, port, startedAt }
    → NO: Return as-is (no tunnel field)
```

### Shutdown
```
SIGINT/SIGTERM → shutdown()
  → tunnelManager.stop() → listener.close()
  → process.exit(0)
```

---

## 5. Build Sequence

### Phase 1: Schemas and Types
- [ ] Add `TunnelStatusSchema` to `packages/shared/src/schemas.ts`
- [ ] Extend `HealthResponseSchema` with optional `tunnel` field
- [ ] Add exports to `packages/shared/src/types.ts`
- [ ] Update `health()` return type in `packages/shared/src/transport.ts`
- [ ] Update `health()` in `apps/client/src/lib/http-transport.ts`
- [ ] Update `health()` in `apps/client/src/lib/direct-transport.ts`

### Phase 2: Core Service
- [ ] Create `apps/server/src/services/tunnel-manager.ts`
- [ ] Create `apps/server/src/services/__tests__/tunnel-manager.test.ts`

### Phase 3: Server Integration
- [ ] Modify `apps/server/src/routes/health.ts`
- [ ] Modify `apps/server/src/index.ts`
- [ ] Add `TunnelStatusSchema` import to `apps/server/src/services/openapi-registry.ts`

### Phase 4: Test Updates
- [ ] Expand `apps/server/src/routes/__tests__/health.test.ts`
- [ ] Add tunnel-manager mock to 4 indirect test files

### Phase 5: Config and DX
- [ ] Add `@ngrok/ngrok` to `apps/server/package.json`
- [ ] Add `dev:tunnel` script
- [ ] Add env vars to `turbo.json`
- [ ] Add tunnel config to `.env`
- [ ] Add `hmr: { clientPort: 443 }` to `apps/client/vite.config.ts`
- [ ] Run `npm install`
- [ ] Run `turbo build && turbo typecheck && turbo test`

---

## 6. Acceptance Criteria

| # | Criterion | Verification |
|---|-----------|-------------|
| 1 | `turbo dev` with `TUNNEL_ENABLED=true` + `NGROK_AUTHTOKEN` starts tunnel and prints URL | Manual: run dev, observe console box |
| 2 | `GET /api/health` includes `tunnel` field when enabled | `curl localhost:6942/api/health` |
| 3 | `GET /api/health` omits `tunnel` field when disabled | `curl localhost:6942/api/health` |
| 4 | `TUNNEL_AUTH=user:pass` requires HTTP basic auth on tunnel | `curl <ngrok-url>` returns 401 |
| 5 | `TUNNEL_PORT=3000` tunnels Vite dev server | Access ngrok URL, see React UI |
| 6 | Tunnel failure does not prevent server startup | Set invalid authtoken, observe warning |
| 7 | Ctrl+C gracefully shuts down tunnel | Press Ctrl+C, observe clean shutdown |
| 8 | `turbo test` passes | All new + existing tests |
| 9 | `turbo typecheck` passes | No type errors |
| 10 | `turbo build` succeeds | Clean build |
| 11 | No behavior change when `TUNNEL_ENABLED` unset | Zero cost, identical behavior |

---

## 7. Non-Regression Requirements

1. **All existing tests pass.** Only modifications: tunnel-manager mock additions + health.test.ts expansion.
2. **Zero cost when disabled.** `@ngrok/ngrok` never imported at startup via `await import()`.
3. **Health endpoint backward compatible.** Response identical when tunnel disabled.
4. **Transport interface backward compatible.** `HealthResponse` is superset of old inline type.
5. **Vite HMR harmless.** `clientPort: 443` is a no-op without a reverse proxy.

---

## 8. Security Considerations

1. **Always recommend basic auth.** `.env` comments and console output highlight `TUNNEL_AUTH` as "strongly recommended."
2. **TLS by default.** All ngrok tunnels use TLS 1.3.
3. **No secrets in console.** Console box shows auth status, never the actual credentials.
4. **Authtoken in env only.** Never logged or exposed via API.
5. **Interstitial warning.** Free tier shows anti-phishing page on first visit — do not bypass programmatically.

---

## 9. Error Handling Matrix

| Scenario | Handling | User Impact |
|----------|----------|-------------|
| `NGROK_AUTHTOKEN` missing | SDK throws auth error | Console warning, server runs without tunnel |
| Invalid authtoken | SDK throws auth error | Console warning, server runs without tunnel |
| Network unreachable | SDK throws connection error | Console warning, server runs without tunnel |
| Port already in use by ngrok | SDK throws bind error | Console warning, server runs without tunnel |
| `start()` called twice | TunnelManager throws "already running" | Developer error; should not happen |
| `stop()` when not running | No-op (idempotent) | None |
| `stop()` after disconnect | `listener.close()` may throw | Caught in shutdown handler, exits regardless |
| Free tier bandwidth exceeded | ngrok closes connection | Tunnel unavailable; health shows `connected: false` |
