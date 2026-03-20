---
slug: tunnel-remote-access-overhaul
number: 80
created: 2026-03-01
status: ideation
---

# Tunnel / Remote Access Overhaul

**Slug:** tunnel-remote-access-overhaul
**Author:** Claude Code
**Date:** 2026-03-01
**Branch:** preflight/tunnel-remote-access-overhaul

---

## 1) Intent & Assumptions

- **Task brief:** Fix all 29 issues identified in the tunnel/ngrok code review — spanning critical CORS bugs, wrong port constants, transport abstraction leaks, missing reconnection handling, security gaps (0.0.0.0 binding), and UX gaps. Additionally, add multi-tab tunnel status awareness so all browser tabs reflect tunnel state changes in real-time. Full UX redesign of the TunnelDialog including onboarding flow, custom domain field, connection quality indicator, terminal QR code in CLI, and session sharing URL.
- **Assumptions:**
  - ngrok SDK can tunnel to localhost-only servers (no need for 0.0.0.0 binding)
  - BroadcastChannel API is available in all target browsers
  - Free ngrok static dev domains are available and stable
  - The existing SSE session sync stream can carry tunnel status events
  - Multi-tab sync only needs to cover same-browser tabs (BroadcastChannel) and remote devices (SSE)
- **Out of scope:**
  - Relay, Mesh, or Pulse subsystem changes
  - Core session flow changes
  - Migration to a different tunnel provider (Cloudflare Tunnel, etc.)
  - Credential store / keychain integration for auth tokens
  - Rate limiting on tunnel routes (tracked separately)

## 2) Pre-reading Log

- `apps/server/src/services/core/tunnel-manager.ts`: TunnelManager class — singleton, dynamic import of @ngrok/ngrok, start/stop lifecycle. Missing `on_status_change` callback for reconnection. Status returns immutable copy (good). No event emission for status changes.
- `apps/server/src/routes/tunnel.ts`: POST /start and /stop endpoints. `DEV_CLIENT_PORT = 3000` is wrong (should be 4241). Uses `resolveTunnelPort()` with env-dependent logic. No input validation with Zod. Persists enabled state in config.
- `apps/server/src/app.ts`: CORS via `buildCorsOrigin()` — static allowlist of localhost origins. Does NOT include tunnel URL. This is the root cause of the critical CORS bug.
- `apps/server/src/index.ts`: Server startup — binds to `0.0.0.0` when `TUNNEL_ENABLED` (security concern). Tunnel starts after Express binds (correct ordering). Graceful shutdown stops tunnel.
- `apps/server/src/env.ts`: Zod-validated env vars. All tunnel vars are optional.
- `apps/server/src/routes/health.ts`: Includes tunnel status in health response when enabled. Shape differs from config endpoint.
- `apps/server/src/routes/config.ts`: Returns tunnel status with `authEnabled` and `tokenConfigured` fields. Different shape from TunnelStatus interface and health endpoint.
- `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx`: Main UI. 5-state machine (off/starting/connected/stopping/error). Has QR code via react-qr-code. Uses hardcoded `fetch('/api/config')` instead of transport (critical bug). Missing state dep in useEffect. Stop optimistically clears URL. Error messages have good friendly mapping.
- `apps/client/src/layers/features/status/ui/TunnelItem.tsx`: Status bar item. Globe icon with connected state. Opens TunnelDialog on click.
- `apps/client/src/layers/features/status/ui/StatusLine.tsx`: Integrates TunnelItem. Conditional on `showStatusBarTunnel` preference.
- `apps/client/src/layers/shared/lib/http-transport.ts`: `startTunnel()` and `stopTunnel()` are simple POST calls.
- `apps/client/src/layers/shared/lib/direct-transport.ts`: Throws "not supported in embedded mode" for tunnel methods. UI doesn't check for this.
- `packages/shared/src/transport.ts`: Transport interface includes `startTunnel()` and `stopTunnel()`.
- `packages/shared/src/config-schema.ts`: Tunnel config schema with `enabled`, `domain`, `authtoken`, `auth`. Authtoken and auth are in SENSITIVE_CONFIG_KEYS.
- `packages/shared/src/schemas.ts`: ServerConfigSchema has tunnel object with `enabled`, `connected`, `url`, `authEnabled`, `tokenConfigured`.
- `packages/cli/src/cli.ts`: CLI with `--tunnel` flag. Prints Local and Network URLs but NOT tunnel URL. Config precedence chain for tunnel vars is correct.
- `packages/cli/src/init-wizard.ts`: Asks "Enable tunnel by default?" — simple boolean.
- `apps/server/src/routes/__tests__/tunnel.test.ts`: 7 tests for route handlers. Good coverage of auth token resolution, port detection, error handling, config persistence.
- `apps/server/src/services/core/__tests__/tunnel-manager.test.ts`: 9 tests for TunnelManager. Tests ngrok.forward options, basic auth, custom domains, status immutability. No reconnection tests.
- `apps/client/src/layers/features/settings/__tests__/TunnelDialog.test.tsx`: 6 tests. Covers toggle, token input, closed state. Missing: connected state, QR code, URL copy, error state.
- `research/20260217_tunnel_toggle_ux_research.md`: Prior UX research — QR code library selection, connection status patterns, toggle patterns.
- `research/20260301_ngrok_integration_best_practices.md`: Fresh research — security architecture, auth patterns, reconnection, rate limiting, DX patterns from Expo/Vercel/VS Code.
- `docs/guides/tunnel-setup.mdx`: User-facing guide. Health endpoint response format in docs doesn't match actual response.

## 3) Codebase Map

**Primary Components/Modules:**

| File                                                           | Role                                         |
| -------------------------------------------------------------- | -------------------------------------------- |
| `apps/server/src/services/core/tunnel-manager.ts`              | ngrok SDK lifecycle (start/stop/status)      |
| `apps/server/src/routes/tunnel.ts`                             | HTTP API for tunnel control                  |
| `apps/server/src/routes/health.ts`                             | Health endpoint with tunnel status           |
| `apps/server/src/routes/config.ts`                             | Config endpoint with tunnel status           |
| `apps/server/src/app.ts`                                       | CORS configuration                           |
| `apps/server/src/index.ts`                                     | Server startup, tunnel init, 0.0.0.0 binding |
| `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx` | Main tunnel control UI                       |
| `apps/client/src/layers/features/status/ui/TunnelItem.tsx`     | Status bar tunnel indicator                  |
| `apps/client/src/layers/features/status/ui/StatusLine.tsx`     | Status bar container                         |
| `packages/shared/src/transport.ts`                             | Transport interface (startTunnel/stopTunnel) |
| `packages/shared/src/schemas.ts`                               | Zod schemas for tunnel status                |
| `packages/shared/src/config-schema.ts`                         | Persistent tunnel config schema              |
| `packages/cli/src/cli.ts`                                      | CLI --tunnel flag and startup banner         |

**Shared Dependencies:**

- `@ngrok/ngrok` SDK (server + CLI)
- `react-qr-code` (client)
- TanStack Query `['config']` query key (multiple consumers)
- `configManager` singleton (tunnel persistence)
- `tunnelManager` singleton (tunnel lifecycle)
- Transport interface (hexagonal architecture boundary)

**Data Flow:**

```
CLI --tunnel flag → env vars → server startup → tunnelManager.start()
                                                     ↓
UI toggle → transport.startTunnel() → POST /api/tunnel/start → tunnelManager.start()
                                                     ↓
                                              ngrok.forward() → tunnel URL
                                                     ↓
                                         configManager.set(enabled: true)
                                                     ↓
                              queryClient.invalidateQueries(['config']) → TunnelDialog re-renders
```

**Feature Flags/Config:**

- `TUNNEL_ENABLED` env var (server startup)
- `tunnel.enabled` in `~/.dork/config.json` (persistent state)
- `showStatusBarTunnel` in Zustand app-store (UI visibility)

**Potential Blast Radius:**

- Direct: 13 files (listed above)
- Indirect: `apps/server/src/app.ts` (CORS affects all routes), `apps/client/src/layers/shared/model/app-store.ts` (new store fields)
- Tests: 3 test files need updates, 4 test files with tunnel mocks may need adjustment
- New files: ~3-5 (cross-tab hook, SSE tunnel events, CLI QR code util)
- Docs: `docs/guides/tunnel-setup.mdx` needs updates

## 4) Root Cause Analysis

This is a bug fix + enhancement. Root causes for critical bugs:

**CORS blocks tunnel requests (Critical #1 & #2):**

- Root cause: `buildCorsOrigin()` in `app.ts` returns a static array at app creation time. The tunnel URL is not known until after ngrok connects, and there's no mechanism to add it retroactively.
- Evidence: Lines 24-44 of `app.ts` — only `localhost` origins are allowed.
- Fix: Replace static allowlist with a dynamic CORS origin callback that checks `tunnelManager.status.url` at request time.

**handleSaveToken bypasses Transport (Critical #3):**

- Root cause: Direct `fetch('/api/config')` call in TunnelDialog.tsx line 110 instead of `transport.updateConfig()`.
- Evidence: Line 110 — hardcoded fetch call.
- Fix: Replace with `transport.updateConfig({ tunnel: { authtoken } })`.

**DEV_CLIENT_PORT is wrong (High #6):**

- Root cause: `DEV_CLIENT_PORT = 3000` in `routes/tunnel.ts` line 12. Vite dev server actually runs on port 4241 (per CLAUDE.md and CORS config).
- Evidence: CORS config uses `VITE_PORT || '4241'`, but tunnel route uses hardcoded 3000.
- Fix: Read from `VITE_PORT` env var or use 4241 as default.

**0.0.0.0 binding bypasses auth (High #29):**

- Root cause: `index.ts` line 232 binds to `0.0.0.0` when tunnel is enabled, exposing the server on all network interfaces. ngrok basic auth only protects the tunnel URL, not direct network access.
- Evidence: Research confirms ngrok SDK can reach `localhost` servers — binding to `0.0.0.0` is unnecessary.
- Fix: Always bind to `localhost`. Remove the `0.0.0.0` conditional.

## 5) Research

### Potential Solutions

**1. Dynamic CORS Origin Callback**

- Description: Replace static `buildCorsOrigin()` with a function callback that checks `tunnelManager.status.url` at each request.
- Pros: Secure (only allows known origins), automatic (no user config needed), works with changing tunnel URLs
- Cons: Tiny per-request overhead (negligible)
- Complexity: Low
- Maintenance: Low

**2. BroadcastChannel + SSE for Cross-Tab Sync**

- Description: Use `BroadcastChannel('dorkos-tunnel')` for same-browser tab communication. When Tab A toggles tunnel, it broadcasts a `tunnel_status_changed` message. Other tabs receive it and invalidate their `['config']` query. For cross-device (remote clients via tunnel), add `tunnel_status` SSE event type to the existing sync stream.
- Pros: Zero-latency same-browser sync, works cross-device via SSE, no polling overhead, clean separation
- Cons: BroadcastChannel not available in Web Workers (not an issue here), SSE requires active connection
- Complexity: Medium
- Maintenance: Low

**3. ngrok `on_status_change` for Reconnection**

- Description: Pass `on_status_change` callback to `ngrok.forward()`. When tunnel disconnects/reconnects, update TunnelManager status and emit events to connected clients.
- Pros: Instant disconnect detection, no polling, uses built-in SDK feature
- Cons: Requires event emission mechanism (SSE integration)
- Complexity: Low
- Maintenance: Low

**4. Terminal QR Code for CLI**

- Description: Use a terminal QR code library (e.g., `qrcode-terminal` or inline ANSI art) to print a scannable QR code in the terminal when tunnel starts.
- Pros: Follows Expo pattern, great mobile DX, zero-click sharing
- Cons: Adds a dependency, may not render in all terminal emulators
- Complexity: Low
- Maintenance: Low

**5. Custom Domain Field in TunnelDialog**

- Description: Add a "Custom domain" input to the TunnelDialog (collapsible under "Advanced"). Saves to `tunnel.domain` in config. ngrok free tier now offers static dev domains — consistent URL across restarts.
- Pros: Eliminates changing URLs, ngrok free static domains are free, better DX
- Cons: Requires ngrok account setup for static domains
- Complexity: Low
- Maintenance: Low

### Security Considerations

- Always bind to `localhost` — ngrok SDK reaches localhost without 0.0.0.0
- Dynamic CORS prevents unauthorized cross-origin requests
- Auth token stored in plaintext JSON (acknowledged — keychain integration out of scope)
- Basic auth credentials in config (acknowledged — env vars preferred)

### Performance Considerations

- Dynamic CORS callback: negligible per-request cost
- BroadcastChannel: zero network overhead, in-memory only
- `on_status_change`: no polling, event-driven
- SSE tunnel events: piggyback on existing connection

### Recommendation

**Approach:** Implement all five solutions as they address orthogonal concerns:

1. Dynamic CORS (fixes critical bug)
2. BroadcastChannel + SSE (multi-tab sync)
3. on_status_change (reconnection)
4. Terminal QR (CLI DX)
5. Custom domain field (UX polish)

**Rationale:** Each solution is low-complexity and addresses a distinct category of issues. Combined, they transform the tunnel feature from "broken in production" to "world-class remote access experience."

## 6) Decisions

| #   | Decision                       | Choice                                    | Rationale                                                                                                                                                                                                                                |
| --- | ------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Cross-tab tunnel status sync   | BroadcastChannel + SSE                    | Instant same-browser sync via BroadcastChannel, cross-device sync via SSE tunnel_status events. No polling overhead.                                                                                                                     |
| 2   | CORS handling for tunnel       | Dynamic origin callback                   | Replace static allowlist with function callback checking `tunnelManager.status.url` at request time. Secure and automatic.                                                                                                               |
| 3   | Network binding with tunnel    | Always bind to localhost                  | ngrok SDK reaches localhost servers. Removing 0.0.0.0 prevents LAN access bypassing tunnel auth.                                                                                                                                         |
| 4   | UX scope                       | Full redesign with onboarding             | Fix all bugs + add custom domain field + first-run onboarding + connection quality indicator + terminal QR code + session sharing URL.                                                                                                   |
| 5   | TunnelManager event emission   | EventEmitter mixin                        | TunnelManager extends EventEmitter. Emits `status_change` events. Routes/SSE handlers subscribe. Matches existing SessionBroadcaster pattern.                                                                                            |
| 6   | SSE tunnel status delivery     | New `GET /api/tunnel/stream` endpoint     | Dedicated SSE endpoint for tunnel events (tunnel_connected, tunnel_disconnected, tunnel_error). Works independently of session selection. ~30 lines.                                                                                     |
| 7   | Unified TunnelStatus type      | Superset with all fields                  | Single Zod schema: `{ enabled, connected, url, port, startedAt, authEnabled, tokenConfigured, domain }`. Replaces three inconsistent shapes. Config route enriches core fields at response time.                                         |
| 8   | First-run onboarding UX        | Illustrated hero + 3-step guide           | Inline SVG illustration (laptop + phone via dotted lines, dark mode aware), one-line value prop, 3-step numbered guide. Collapses after token saved. Follows Expo/Vercel pattern.                                                        |
| 9   | Custom domain field placement  | Always visible below toggle               | Show domain input whenever token is configured. Pre-populate from config. Hint about free static domains at dashboard.ngrok.com/domains. Saves on blur/enter. Benefits: same URL every restart, reusable QR codes, persistent bookmarks. |
| 10  | Connection quality indicator   | Latency dot with tooltip                  | Colored dot next to URL: green (<200ms), yellow (200-500ms), red (>500ms). Health ping through tunnel every 30s when connected. Tooltip shows ms. Stops when dialog closed. VS Code pattern.                                             |
| 11  | Terminal QR code library       | qrcode-terminal                           | 8M+ weekly downloads, Unicode block characters, ~15KB gzip. Same approach as Expo. Tree-shaken into esbuild CLI bundle.                                                                                                                  |
| 12  | Session sharing via tunnel     | Copy buttons in TunnelDialog              | Two copy buttons when connected: "Copy URL" (root) and "Copy session link" (tunnel URL + ?session=id). Session link only shows when a session is selected.                                                                               |
| 13  | BroadcastChannel FSD placement | shared/lib utility + entities/tunnel hook | Raw BroadcastChannel wrapper in shared/lib/broadcast-channel.ts (reusable). Domain hook useTunnelSync() in entities/tunnel/ subscribes to both BroadcastChannel and SSE, invalidates ['config'] query.                                   |
| 14  | Unexpected disconnect UX       | Toast notification + status bar update    | Non-blocking toast ("Remote access disconnected — reconnecting...") + TunnelItem status bar turns red. On auto-reconnect: success toast + green. On permanent failure: error toast with "Reconnect" action button.                       |

## 7) Full Issue Inventory

### Critical (Must Fix)

| #   | Issue                                               | File(s)                | Fix                                    |
| --- | --------------------------------------------------- | ---------------------- | -------------------------------------- |
| 1   | CORS blocks tunnel requests                         | `app.ts`               | Dynamic CORS origin callback           |
| 2   | CORS race condition (tunnel URL unknown at startup) | `app.ts`               | Same — callback checks at request time |
| 3   | `handleSaveToken` bypasses Transport                | `TunnelDialog.tsx:110` | Use `transport.updateConfig()`         |

### High Priority

| #   | Issue                                         | File(s)                  | Fix                                         |
| --- | --------------------------------------------- | ------------------------ | ------------------------------------------- |
| 4   | No `on_status_change` — silent disconnections | `tunnel-manager.ts`      | Add callback, emit status events            |
| 5   | UI state machine stuck states + stale closure | `TunnelDialog.tsx:60-68` | Add `state` to deps, add recovery logic     |
| 6   | `DEV_CLIENT_PORT = 3000` (should be 4241)     | `routes/tunnel.ts:12`    | Read from `VITE_PORT` env var, default 4241 |
| 7   | Tunnel URL not printed in CLI                 | `cli.ts`                 | Listen for tunnel URL, print with QR        |
| 29  | `0.0.0.0` binding bypasses auth               | `index.ts:232`           | Always bind to `localhost`                  |

### Medium Priority

| #   | Issue                                       | File(s)                                   | Fix                                      |
| --- | ------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| 8   | No input validation on tunnel routes        | `routes/tunnel.ts`                        | Add Zod validation, semantic error codes |
| 9   | Stop clears URL optimistically before await | `TunnelDialog.tsx:91`                     | Keep URL visible during stopping         |
| 10  | Health response format doesn't match docs   | `health.ts`, `tunnel-setup.mdx`           | Align docs with actual response          |
| 11  | Three different tunnel status shapes        | Multiple                                  | Unify to single TunnelStatus type        |
| 25  | DirectTransport throws but UI doesn't check | `TunnelDialog.tsx`, `direct-transport.ts` | Check embedded mode, hide toggle         |

### Product/UX

| #   | Issue                             | File(s)            | Fix                                        |
| --- | --------------------------------- | ------------------ | ------------------------------------------ |
| 14  | No first-run onboarding           | `TunnelDialog.tsx` | Add explanation/illustration for new users |
| 15  | No custom domain UX               | `TunnelDialog.tsx` | Add custom domain input field              |
| 16  | No session sharing via tunnel     | `TunnelDialog.tsx` | Add "Share session" with tunnel URL        |
| 17  | Terminal QR code missing from CLI | `cli.ts`           | Add terminal QR code library               |
| 18  | No connection quality indicator   | `TunnelDialog.tsx` | Add latency ping indicator                 |
| NEW | Multi-tab tunnel status sync      | New files          | BroadcastChannel + SSE                     |

### Testing

| #   | Issue                                          | File(s)                 | Fix                                   |
| --- | ---------------------------------------------- | ----------------------- | ------------------------------------- |
| 19  | No CORS test with tunnel                       | New test                | Integration test for CORS + tunnel    |
| 20  | No full lifecycle integration test             | New test                | Start → CORS → API → Stop flow        |
| 21  | TunnelDialog tests miss connected/error states | `TunnelDialog.test.tsx` | Add QR code, URL copy, error tests    |
| 22  | DEV_CLIENT_PORT test cleanup                   | `tunnel.test.ts`        | Use beforeEach/afterEach for NODE_ENV |

### Code Quality

| #   | Issue                                            | File(s)             | Fix                            |
| --- | ------------------------------------------------ | ------------------- | ------------------------------ |
| 23  | `forwardOpts` typed as `Record<string, unknown>` | `tunnel-manager.ts` | Use ngrok SDK Config type      |
| 24  | Singleton vs DI                                  | `tunnel-manager.ts` | Consider constructor injection |

### Security (Acknowledged, Deferred)

| #   | Issue                             | Status                                                  |
| --- | --------------------------------- | ------------------------------------------------------- |
| 26  | Auth token in plaintext JSON      | Acknowledged — env var preferred, keychain out of scope |
| 27  | Basic auth creds in config        | Acknowledged — same as above                            |
| 28  | No rate limiting on tunnel routes | Tracked separately                                      |
