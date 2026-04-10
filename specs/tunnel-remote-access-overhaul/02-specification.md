# Tunnel / Remote Access Overhaul

**Status:** Draft
**Authors:** Claude Code, 2026-03-01
**Spec #:** 80
**Source:** `specs/tunnel-remote-access-overhaul/01-ideation.md`

---

## Overview

Fix all 29 issues from the tunnel/ngrok code review and add multi-tab tunnel status awareness. This includes critical CORS bug fixes, transport abstraction leak repairs, wrong port constants, missing reconnection handling, security hardening (remove 0.0.0.0 binding), and a full UX redesign of TunnelDialog with onboarding flow, custom domain field, connection quality indicator, terminal QR code in CLI, and session sharing URL. Cross-tab status sync uses BroadcastChannel for same-browser tabs and SSE for remote devices.

## Background / Problem Statement

The tunnel/remote access feature has critical bugs that make it non-functional in production:

1. **CORS blocks all tunnel API calls** — `buildCorsOrigin()` in `app.ts` returns a static localhost-only allowlist. The tunnel URL is never added, so every API request from the tunnel origin fails silently.

2. **Transport abstraction leak** — `TunnelDialog.tsx` uses a hardcoded `fetch('/api/config')` instead of `transport.updateConfig()`, which breaks in Obsidian's embedded mode (DirectTransport).

3. **Wrong port constant** — `DEV_CLIENT_PORT = 3000` in `routes/tunnel.ts` should be 4241 (Vite dev server port).

4. **Security: 0.0.0.0 binding** — The server binds to all interfaces when tunnel is enabled, exposing it on the LAN. ngrok reaches localhost without this.

5. **No reconnection handling** — The ngrok SDK's `on_status_change` callback isn't used. If the tunnel disconnects, no one knows.

6. **Three inconsistent status shapes** — TunnelManager, health endpoint, and config endpoint all return different shapes.

7. **No multi-tab awareness** — Opening DorkOS in multiple tabs gives no cross-tab tunnel status sync.

8. **Bare UX** — No onboarding for new users, no custom domain field, no connection quality indicator, no session sharing.

## Goals

- Fix all critical and high-priority tunnel bugs so tunnel works end-to-end
- Unify tunnel status into a single Zod-validated type used everywhere
- Add real-time cross-tab and cross-device tunnel status sync
- Redesign TunnelDialog UX with onboarding, custom domain, quality indicator, and session sharing
- Add CLI improvements: terminal QR code and tunnel URL in startup banner
- Harden security: always bind to localhost, remove 0.0.0.0
- Bring test coverage to cover all new functionality

## Non-Goals

- Credential store / keychain integration for auth tokens
- Rate limiting on tunnel routes
- Migration to alternative tunnel providers (Cloudflare Tunnel, etc.)
- Relay, Mesh, or Pulse subsystem changes
- Core session flow changes

## Technical Dependencies

| Dependency        | Version   | Purpose                                               |
| ----------------- | --------- | ----------------------------------------------------- |
| `@ngrok/ngrok`    | `^1.7.0`  | Tunnel SDK (already installed in server + CLI)        |
| `react-qr-code`   | `^2.0.18` | QR code rendering in TunnelDialog (already installed) |
| `qrcode-terminal` | `^0.12.0` | Terminal QR code rendering (new, CLI package)         |
| `zod`             | `^3.x`    | Schema validation (already installed)                 |
| `sonner`          | existing  | Toast notifications (already installed)               |

**Browser APIs:**

- `BroadcastChannel` — supported in all modern browsers (Chrome 54+, Firefox 38+, Safari 15.4+)
- `EventSource` (SSE) — supported in all modern browsers

## Detailed Design

### Phase 1: Critical Bug Fixes

#### 1.1 Dynamic CORS Origin Callback

**File:** `apps/server/src/app.ts`

Replace the static `buildCorsOrigin()` function with a dynamic CORS callback that checks `tunnelManager.status.url` at request time:

```typescript
import { tunnelManager } from './services/core/tunnel-manager.js';

function buildCorsOrigin(): cors.CorsOptions['origin'] {
  const envOrigin = process.env.DORKOS_CORS_ORIGIN;
  if (envOrigin === '*') return '*';
  if (envOrigin) return envOrigin.split(',').map((o) => o.trim());

  return (origin, callback) => {
    const port = process.env.DORKOS_PORT || '4242';
    const vitePort = process.env.VITE_PORT || '4241';
    const allowed = [
      `http://localhost:${port}`,
      `http://localhost:${vitePort}`,
      `http://127.0.0.1:${port}`,
      `http://127.0.0.1:${vitePort}`,
    ];

    const tunnelUrl = tunnelManager.status.url;
    if (tunnelUrl) allowed.push(tunnelUrl);

    if (!origin || allowed.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  };
}
```

#### 1.2 Transport Leak Fix

**File:** `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx`

Replace the hardcoded `fetch('/api/config')` in `handleSaveToken` with `transport.updateConfig()`:

```typescript
const handleSaveToken = useCallback(async () => {
  await transport.updateConfig({ tunnel: { authtoken: authToken } });
  queryClient.invalidateQueries({ queryKey: ['config'] });
}, [authToken, queryClient, transport]);
```

#### 1.3 Port Fix

**File:** `apps/server/src/routes/tunnel.ts`

Replace `DEV_CLIENT_PORT = 3000` with a value read from the `VITE_PORT` env var, defaulting to 4241:

```typescript
const DEV_CLIENT_PORT = Number(process.env.VITE_PORT) || 4241;
```

#### 1.4 Binding Fix

**File:** `apps/server/src/index.ts`

Remove the `0.0.0.0` conditional. Always bind to `localhost`:

```typescript
// Before:
const host = env.TUNNEL_ENABLED ? '0.0.0.0' : 'localhost';

// After:
const host = 'localhost';
```

### Phase 2: Architecture (TunnelManager + Event System)

#### 2.1 EventEmitter Mixin

**File:** `apps/server/src/services/core/tunnel-manager.ts`

Make `TunnelManager` extend Node's `EventEmitter`. Emit `status_change` events with the full `TunnelStatus` payload on start, stop, disconnect, and reconnect. Keep the dynamic import of `@ngrok/ngrok`.

```typescript
import { EventEmitter } from 'node:events';
import type { TunnelStatus } from '@dorkos/shared/types';

export class TunnelManager extends EventEmitter {
  private _status: TunnelStatus = {
    /* defaults */
  };

  private updateStatus(partial: Partial<TunnelStatus>): void {
    this._status = { ...this._status, ...partial };
    this.emit('status_change', this.status);
  }

  async start(config: TunnelConfig): Promise<string> {
    const ngrok = await import('@ngrok/ngrok');
    this.listener = await ngrok.forward({
      addr: config.port,
      authtoken: config.authtoken,
      domain: config.domain,
      on_status_change: (addr: string, status: string) => {
        if (status === 'connected') {
          this.updateStatus({ connected: true, url: addr });
        } else if (status === 'closed') {
          this.updateStatus({ connected: false, url: null });
        }
      },
      // ...other options
    });
    this.updateStatus({ enabled: true, connected: true, url: this.listener.url() /* ... */ });
    return this.listener.url()!;
  }

  async stop(): Promise<void> {
    await this.listener?.close();
    this.listener = null;
    this.updateStatus({ enabled: false, connected: false, url: null, port: null, startedAt: null });
  }
}
```

#### 2.2 Unified TunnelStatus Type

**File:** `packages/shared/src/schemas.ts`

Create a single Zod schema that is the superset of all three current shapes:

```typescript
export const TunnelStatusSchema = z.object({
  enabled: z.boolean(),
  connected: z.boolean(),
  url: z.string().nullable(),
  port: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  authEnabled: z.boolean(),
  tokenConfigured: z.boolean(),
  domain: z.string().nullable(),
});

export type TunnelStatus = z.infer<typeof TunnelStatusSchema>;
```

Replace the existing `TunnelStatusSchema` (currently only `connected`, `url`, `port`, `startedAt`) and the `ServerConfigSchema.tunnel` inline shape. All consumers (health endpoint, config endpoint, TunnelManager internal, SSE events) use this single type.

#### 2.3 SSE Endpoint

**File:** `apps/server/src/routes/tunnel.ts`

Add `GET /api/tunnel/stream` — a dedicated SSE endpoint for tunnel status events:

```typescript
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const handler = (status: TunnelStatus) => {
    res.write(`event: tunnel_status\ndata: ${JSON.stringify(status)}\n\n`);
  };

  tunnelManager.on('status_change', handler);
  req.on('close', () => tunnelManager.off('status_change', handler));
});
```

#### 2.4 Route Improvements

**File:** `apps/server/src/routes/tunnel.ts`

- Add Zod validation to POST `/start` body (optional `authtoken`, `domain`, `port` fields)
- Return 409 when tunnel is already running (not generic 500)
- Add `GET /api/tunnel/status` for on-demand status check returning the unified `TunnelStatus`

```typescript
const startSchema = z
  .object({
    authtoken: z.string().optional(),
    domain: z.string().optional(),
    port: z.number().optional(),
  })
  .optional();

router.post('/start', async (req, res) => {
  if (tunnelManager.status.connected) {
    return res.status(409).json({ error: 'Tunnel already running', url: tunnelManager.status.url });
  }
  // ...existing start logic with validation
});

router.get('/status', (_req, res) => {
  res.json(tunnelManager.status);
});
```

### Phase 3: Multi-Tab Sync (Client)

#### 3.1 BroadcastChannel Wrapper

**File:** `apps/client/src/layers/shared/lib/broadcast-channel.ts`

Generic BroadcastChannel wrapper, reusable for future cross-tab needs:

```typescript
export function createChannel<T = unknown>(name: string) {
  const channel = new BroadcastChannel(name);

  return {
    postMessage(data: T): void {
      channel.postMessage(data);
    },
    onMessage(handler: (data: T) => void): () => void {
      const listener = (event: MessageEvent<T>) => handler(event.data);
      channel.addEventListener('message', listener);
      return () => channel.removeEventListener('message', listener);
    },
    close(): void {
      channel.close();
    },
  };
}
```

#### 3.2 entities/tunnel Module

**New directory:** `apps/client/src/layers/entities/tunnel/`

**`model/use-tunnel-status.ts`** — TanStack Query hook:

```typescript
import { useTransport } from '@/layers/shared/model';
import { useQuery } from '@tanstack/react-query';

export function useTunnelStatus() {
  const transport = useTransport();
  return useQuery({
    queryKey: ['tunnel-status'],
    queryFn: async () => {
      const config = await transport.getConfig();
      return config.tunnel;
    },
    refetchInterval: false,
    staleTime: 30_000,
  });
}
```

**`model/use-tunnel-sync.ts`** — Cross-tab and cross-device sync:

```typescript
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createChannel } from '@/layers/shared/lib/broadcast-channel';

export function useTunnelSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const channel = createChannel('dorkos-tunnel');
    const unsubscribe = channel.onMessage(() => {
      queryClient.invalidateQueries({ queryKey: ['tunnel-status'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    });

    // SSE connection for cross-device sync
    const eventSource = new EventSource('/api/tunnel/stream');
    eventSource.addEventListener('tunnel_status', () => {
      queryClient.invalidateQueries({ queryKey: ['tunnel-status'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    });

    return () => {
      unsubscribe();
      channel.close();
      eventSource.close();
    };
  }, [queryClient]);
}
```

**`index.ts`** — Barrel exports:

```typescript
export { useTunnelStatus } from './model/use-tunnel-status';
export { useTunnelSync } from './model/use-tunnel-sync';
```

### Phase 4: TunnelDialog UX Redesign

#### 4.1 State Machine Fix

**File:** `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx`

Fix the stale closure bug by adding `state` to the `useEffect` dependency array. Keep the URL visible during the `stopping` state. Add a recovery path from stuck states (e.g., if state is `starting` for more than 30 seconds, transition to `error`).

#### 4.2 Onboarding Flow

**New file:** `apps/client/src/layers/features/settings/ui/TunnelOnboarding.tsx`

When no token is configured, show:

1. An inline SVG illustration (laptop with phone/tablet connecting via dotted lines, dark-mode aware using `currentColor`)
2. A one-line value prop: "Access DorkOS from any device"
3. A 3-step numbered guide:
   - Create a free ngrok account at dashboard.ngrok.com
   - Copy your auth token
   - Paste it below and toggle on

The onboarding collapses after the token is saved. Uses `AnimatePresence` from `motion/react` for smooth collapse.

#### 4.3 Custom Domain Field

Always visible when token is configured, positioned between the toggle and QR code area. Pre-populated from config via `useTunnelStatus()`. Saves on blur or Enter via `transport.updateConfig({ tunnel: { domain } })`.

Hint text: "Get a free static domain at dashboard.ngrok.com/domains"

Benefits callout (shown as muted text below the input):

- Same URL every restart
- Reusable QR codes
- Persistent bookmarks

#### 4.4 Connection Quality Indicator

When connected, display a small colored dot next to the URL:

- Green: latency < 200ms
- Yellow: latency 200-500ms
- Red: latency > 500ms

Measured by pinging the health endpoint through the tunnel URL every 30 seconds. Tooltip shows actual milliseconds. Pinging stops when the dialog closes (cleanup in `useEffect`).

#### 4.5 Session Sharing

When connected AND a session is selected, show a second copy button: "Copy session link" that copies `{tunnelUrl}?session={sessionId}`. Only shows when both conditions are met.

#### 4.6 Error States

Expand `friendlyErrorMessage()` to handle more ngrok error codes. Show a structured error card with a "Retry" action button. On unexpected disconnect, show a toast via sonner: "Remote access disconnected -- reconnecting..." and update the TunnelItem status bar indicator to a red dot. On successful reconnect, show a success toast and restore the green dot.

#### 4.7 Embedded Mode Guard

Check if running in `DirectTransport` (Obsidian). If so, hide the tunnel toggle and status bar item entirely. Don't throw; just don't render. Use the Transport type check pattern already established in the codebase.

### Phase 5: Status Bar

#### 5.1 TunnelItem Improvements

**File:** `apps/client/src/layers/features/status/ui/TunnelItem.tsx`

Show a connection quality dot (green/yellow/red) inline with the Globe icon. On disconnect, animate the dot to red. On reconnect, animate back to green. Use the `useTunnelStatus()` hook from `entities/tunnel`.

### Phase 6: CLI Improvements

#### 6.1 Terminal QR Code

**Package:** `packages/cli`

Add `qrcode-terminal` as a dependency. After the tunnel starts, print the QR code and URL in a styled box:

```
  ┌──────────────────────────────────────┐
  │  Remote Access                       │
  │  https://abc123.ngrok-free.app       │
  │                                      │
  │  ████████████████████████████████    │
  │  ██ ▄▄▄▄▄ █▀ █▀▄█ ▄▀▄█ ▄▄▄▄▄ ██    │
  │  ██ █   █ █▀▄▀▀▄█▄ ▄██ █   █ ██    │
  │  ██ █▄▄▄█ █▀ █ ▀▀█▄▄▀█ █▄▄▄█ ██    │
  │  ████████████████████████████████    │
  │                                      │
  │  Scan to open on mobile              │
  └──────────────────────────────────────┘
```

#### 6.2 Tunnel URL in Startup Banner

Print the tunnel URL alongside Local and Network URLs in the CLI startup banner. Listen for the tunnel `status_change` event from TunnelManager and print when connected.

### Phase 7: Testing

#### 7.1 CORS Integration Test

**New file:** `apps/server/src/routes/__tests__/tunnel-cors.test.ts`

Test that:

- Requests with the tunnel origin are accepted when tunnel is connected
- Requests with the tunnel origin are rejected when tunnel is not connected
- Requests with localhost origin always work
- Dynamic origin updates when tunnel URL changes

#### 7.2 TunnelManager Tests

**File:** `apps/server/src/services/core/__tests__/tunnel-manager.test.ts`

Add tests for:

- `on_status_change` callback invocation
- EventEmitter `status_change` events fire on start, stop, disconnect, reconnect
- Status transitions (connected -> disconnected -> reconnected)

#### 7.3 TunnelDialog Tests

**File:** `apps/client/src/layers/features/settings/__tests__/TunnelDialog.test.tsx`

Add tests for:

- Connected state: QR code visible, URL displayed, copy button works
- Error state: error card visible, retry button present
- Copy URL button copies to clipboard
- Session link button (shown when session is selected and tunnel is connected)
- Onboarding state (no token configured)
- Custom domain field saves on blur

#### 7.4 Route Tests

**File:** `apps/server/src/routes/__tests__/tunnel.test.ts`

- Fix NODE_ENV cleanup (use `beforeEach`/`afterEach` with `vi.stubEnv`)
- Test 409 for already-running tunnel
- Test new `GET /status` endpoint
- Test SSE `/stream` endpoint connection and event delivery

#### 7.5 Cross-Tab Sync Tests

**New file:** `apps/client/src/layers/shared/lib/__tests__/broadcast-channel.test.ts`

Test BroadcastChannel wrapper: `createChannel`, `postMessage`, `onMessage`, `close`.

**New file:** `apps/client/src/layers/entities/tunnel/__tests__/use-tunnel-sync.test.ts`

Test that `useTunnelSync` hook invalidates `['tunnel-status']` and `['config']` queries on BroadcastChannel message and SSE event.

### Phase 8: Documentation & Cleanup

#### 8.1 Docs Update

**File:** `docs/guides/tunnel-setup.mdx`

- Fix health response format to match actual response
- Add custom domain section with instructions for getting a free ngrok static domain
- Add multi-tab awareness info
- Add CLI QR code section

#### 8.2 Type Safety

**File:** `apps/server/src/services/core/tunnel-manager.ts`

Replace `Record<string, unknown>` in `forwardOpts` with the ngrok SDK's `Config` type for type-safe tunnel configuration.

#### 8.3 DirectTransport Fix

**File:** `apps/client/src/layers/shared/lib/direct-transport.ts`

Update `startTunnel()` and `stopTunnel()` to return `{ enabled: false, connected: false, ... }` instead of throwing. The embedded mode guard in the UI prevents these from being called, but the fallback makes the system more robust.

## User Experience

### First-Time User Flow

1. User opens Settings > Remote Access
2. Sees onboarding illustration with "Access DorkOS from any device"
3. Follows 3-step guide to get ngrok token
4. Pastes token, onboarding collapses
5. Toggles tunnel on, sees connected URL + QR code
6. Can optionally set a custom domain for persistent URL

### Returning User Flow

1. Toggles tunnel on
2. Sees URL, QR code, connection quality indicator
3. Can copy URL or session-specific link
4. Status bar shows green dot when connected
5. All other tabs update within ~1 second

### Disconnect/Reconnect Flow

1. Tunnel unexpectedly disconnects
2. Toast: "Remote access disconnected -- reconnecting..."
3. Status bar dot turns red
4. ngrok auto-reconnects
5. Toast: "Remote access reconnected"
6. Status bar dot turns green
7. All tabs sync via BroadcastChannel + SSE

### CLI Flow

1. User starts DorkOS with `--tunnel` flag
2. CLI prints Local, Network, and Tunnel URLs
3. QR code printed in terminal
4. User scans QR code on phone

## Testing Strategy

### Unit Tests

| Test File                   | What It Tests                                                                     |
| --------------------------- | --------------------------------------------------------------------------------- |
| `tunnel-manager.test.ts`    | EventEmitter events, `on_status_change`, status transitions, start/stop lifecycle |
| `broadcast-channel.test.ts` | `createChannel` wrapper: post, receive, close, cleanup                            |
| `use-tunnel-status.test.ts` | TanStack Query hook returns tunnel status from config                             |
| `use-tunnel-sync.test.ts`   | Invalidates queries on BroadcastChannel message and SSE event                     |

### Integration Tests

| Test File             | What It Tests                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `tunnel-cors.test.ts` | CORS accepts tunnel origin when connected, rejects when not                                |
| `tunnel.test.ts`      | Route handlers: 409 for already-running, `/status` endpoint, SSE `/stream`, Zod validation |

### Component Tests

| Test File               | What It Tests                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `TunnelDialog.test.tsx` | Connected state (QR, URL, copy), error state, onboarding, custom domain, session link, embedded mode |

### Mocking Strategy

- **ngrok SDK**: Mock `ngrok.forward()` and `ngrok.listener` for TunnelManager tests
- **Transport**: Use `createMockTransport()` from `@dorkos/test-utils` for client component tests
- **BroadcastChannel**: Mock globally in test setup for cross-tab tests
- **EventSource**: Mock globally for SSE tests
- **Clipboard API**: Mock `navigator.clipboard.writeText` for copy button tests

## Performance Considerations

| Area                              | Impact                                    | Mitigation                                     |
| --------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| Dynamic CORS callback             | Negligible per-request overhead (~0.01ms) | Origin check is a simple array lookup          |
| BroadcastChannel                  | Zero network overhead                     | In-memory postMessage between tabs             |
| SSE `/tunnel/stream`              | One persistent connection per client      | Lightweight; only sends on status changes      |
| Health ping for quality indicator | One request every 30s per open dialog     | Only pings when dialog is open; stops on close |
| EventEmitter                      | Negligible                                | Only fires on tunnel state transitions         |

## Security Considerations

| Concern                                | Mitigation                                                          |
| -------------------------------------- | ------------------------------------------------------------------- |
| 0.0.0.0 binding exposes server on LAN  | Always bind to `localhost`                                          |
| CORS blocks legitimate tunnel requests | Dynamic origin callback checks `tunnelManager.status.url`           |
| Auth token in plaintext JSON           | Acknowledged; env var preferred, keychain integration deferred      |
| Tunnel URL visible in UI               | QR code and URL are inherently shareable; matches intended use case |
| SSE endpoint accessible without auth   | Same auth boundary as other API endpoints                           |

## Documentation

| Document                       | Updates Needed                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `docs/guides/tunnel-setup.mdx` | Fix health response format, add custom domain section, add multi-tab info, add QR code section |
| `contributing/architecture.md` | Add tunnel event system to server architecture section                                         |
| `AGENTS.md`                    | Update server services count, add entities/tunnel to FSD layers table                          |

## Implementation Phases

### Phase 1: Critical Bug Fixes

Items 1-4. Fix CORS, transport leak, port constant, 0.0.0.0 binding. These are prerequisite for everything else.

### Phase 2: Architecture

Items 5-9. EventEmitter on TunnelManager, `on_status_change` callback, unified TunnelStatus type, SSE endpoint, route improvements with Zod validation.

### Phase 3: Multi-Tab Sync

Items 10-11. BroadcastChannel wrapper, entities/tunnel module with `useTunnelStatus` and `useTunnelSync` hooks.

### Phase 4: TunnelDialog UX Redesign

Items 12-18. State machine fix, onboarding flow, custom domain field, connection quality indicator, session sharing, error states, embedded mode guard.

### Phase 5: Status Bar

Item 19. TunnelItem improvements with quality dot and `useTunnelStatus` hook.

### Phase 6: CLI Improvements

Items 20-21. Terminal QR code, tunnel URL in startup banner.

### Phase 7: Testing

Items 22-26. CORS integration test, TunnelManager tests, TunnelDialog tests, route tests, cross-tab sync tests.

### Phase 8: Documentation & Cleanup

Items 27-29. Docs update, type safety, DirectTransport fix.

## Files Modified

### Existing Files

| File                                                           | Changes                                                                                                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/services/core/tunnel-manager.ts`              | EventEmitter extension, `on_status_change`, unified type, typed forwardOpts                                                            |
| `apps/server/src/routes/tunnel.ts`                             | SSE `/stream` endpoint, `GET /status`, Zod validation, port fix, 409 response                                                          |
| `apps/server/src/app.ts`                                       | Dynamic CORS origin callback                                                                                                           |
| `apps/server/src/index.ts`                                     | Remove 0.0.0.0 conditional                                                                                                             |
| `apps/server/src/routes/health.ts`                             | Use unified TunnelStatus                                                                                                               |
| `apps/server/src/routes/config.ts`                             | Use unified TunnelStatus                                                                                                               |
| `apps/server/src/env.ts`                                       | Add VITE_PORT to Zod schema                                                                                                            |
| `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx` | Full redesign: fix state machine, add onboarding, custom domain, quality indicator, session sharing, error states, embedded mode guard |
| `apps/client/src/layers/features/status/ui/TunnelItem.tsx`     | Quality dot, `useTunnelStatus` hook                                                                                                    |
| `apps/client/src/layers/shared/lib/http-transport.ts`          | Add tunnel SSE subscription method                                                                                                     |
| `apps/client/src/layers/shared/lib/direct-transport.ts`        | Return status object instead of throwing                                                                                               |
| `packages/shared/src/schemas.ts`                               | Unified TunnelStatusSchema                                                                                                             |
| `packages/shared/src/transport.ts`                             | Add `subscribeTunnelStatus` method                                                                                                     |
| `packages/cli/src/cli.ts`                                      | QR code, tunnel URL in startup banner                                                                                                  |
| `docs/guides/tunnel-setup.mdx`                                 | Fix health format, add custom domain, multi-tab, QR sections                                                                           |

### New Files

| File                                                                | Purpose                                    |
| ------------------------------------------------------------------- | ------------------------------------------ |
| `apps/client/src/layers/shared/lib/broadcast-channel.ts`            | Generic BroadcastChannel wrapper           |
| `apps/client/src/layers/entities/tunnel/model/use-tunnel-status.ts` | TanStack Query hook for tunnel status      |
| `apps/client/src/layers/entities/tunnel/model/use-tunnel-sync.ts`   | Cross-tab and cross-device sync            |
| `apps/client/src/layers/entities/tunnel/index.ts`                   | Barrel exports                             |
| `apps/client/src/layers/features/settings/ui/TunnelOnboarding.tsx`  | SVG illustration + 3-step onboarding guide |

### Test Files

| File                                                                       | Status                                                                        |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/server/src/routes/__tests__/tunnel.test.ts`                          | Updated (fix NODE_ENV cleanup, add 409 + /status + /stream tests)             |
| `apps/server/src/services/core/__tests__/tunnel-manager.test.ts`           | Updated (add EventEmitter, on_status_change, reconnection tests)              |
| `apps/client/src/layers/features/settings/__tests__/TunnelDialog.test.tsx` | Updated (add connected, error, onboarding, custom domain, session link tests) |
| `apps/server/src/routes/__tests__/tunnel-cors.test.ts`                     | New                                                                           |
| `apps/client/src/layers/entities/tunnel/__tests__/use-tunnel-sync.test.ts` | New                                                                           |
| `apps/client/src/layers/shared/lib/__tests__/broadcast-channel.test.ts`    | New                                                                           |

## Open Questions

All questions have been resolved during ideation. See decisions 1-14 in the ideation document.

## Decisions

All 14 decisions were resolved during ideation:

1. **Cross-tab sync**: BroadcastChannel + SSE
2. **CORS**: Dynamic origin callback checking `tunnelManager.status.url` per request
3. **Network bind**: Always `localhost` (remove 0.0.0.0 conditional)
4. **UX scope**: Full redesign with onboarding flow
5. **Event architecture**: TunnelManager extends EventEmitter, emits `status_change`
6. **SSE delivery**: New dedicated `GET /api/tunnel/stream` endpoint
7. **Unified type**: Superset TunnelStatus with all fields in one Zod schema
8. **Onboarding**: Illustrated SVG hero + 3-step numbered guide
9. **Custom domain**: Always visible when token configured, with free domain hint
10. **Quality indicator**: Colored latency dot (green/yellow/red) with tooltip
11. **CLI QR**: `qrcode-terminal` package
12. **Session sharing**: Two copy buttons (root URL + session link)
13. **FSD placement**: `shared/lib` wrapper + `entities/tunnel` hook
14. **Disconnect UX**: Toast notification + status bar color change

## Acceptance Criteria

- [ ] Tunnel works end-to-end: toggle on in UI -> tunnel connects -> access DorkOS from tunnel URL -> all API calls succeed (CORS fixed)
- [ ] Multiple tabs in the same browser reflect tunnel status changes within 1 second
- [ ] Remote devices connected via tunnel receive status updates via SSE
- [ ] Unexpected disconnect shows toast, status bar turns red, auto-reconnect restores green
- [ ] First-time users see onboarding with clear steps to get started
- [ ] Custom domain field saves and persists across restarts
- [ ] CLI prints terminal QR code when tunnel starts
- [ ] CLI prints tunnel URL in startup banner
- [ ] Embedded mode (Obsidian) hides tunnel UI entirely without errors
- [ ] All existing tunnel tests pass + new tests for CORS, SSE, BroadcastChannel, dialog states

## Related ADRs

- **ADR 0001**: Use Hexagonal Architecture with Transport Interface — the tunnel feature relies on the Transport abstraction
- **ADR 0021**: Restructure Server Services into Domain Folders — TunnelManager lives in `services/core/`
- **ADR 0005**: Zustand for UI State, TanStack Query for Server State — tunnel status uses TanStack Query

## Deferred Work

- Credential store / keychain integration for auth tokens
- Rate limiting on tunnel routes
- Migration to alternative tunnel providers
- DI refactor for TunnelManager (currently singleton)

## References

- Ideation document: `specs/tunnel-remote-access-overhaul/01-ideation.md`
- Research: `research/20260301_ngrok_integration_best_practices.md`
- Prior UX research: `research/20260217_tunnel_toggle_ux_research.md`
- ngrok Node.js SDK: https://github.com/ngrok/ngrok-javascript
- BroadcastChannel API: https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel
