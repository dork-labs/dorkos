# Tunnel / Remote Access Overhaul — Task Breakdown

**Spec:** `specs/tunnel-remote-access-overhaul/02-specification.md`
**Generated:** 2026-03-01
**Mode:** Full decomposition (8 phases, 27 tasks)

---

## Phase 1: Critical Bug Fixes (4 tasks)

All Phase 1 tasks can run in parallel. They are independent bug fixes with no inter-dependencies.

| ID  | Task                                               | Size  | Priority | Dependencies |
| --- | -------------------------------------------------- | ----- | -------- | ------------ |
| 1.1 | Fix dynamic CORS origin to allow tunnel URL        | small | high     | --           |
| 1.2 | Fix transport abstraction leak in TunnelDialog     | small | high     | --           |
| 1.3 | Fix wrong DEV_CLIENT_PORT constant in tunnel route | small | high     | --           |
| 1.4 | Remove 0.0.0.0 binding when tunnel is enabled      | small | high     | --           |

### 1.1 Fix dynamic CORS origin to allow tunnel URL

**File:** `apps/server/src/app.ts`

Replace the static `buildCorsOrigin()` array with a dynamic callback that checks `tunnelManager.status.url` at request time. Import `tunnelManager` and return a callback function instead of a static array when no explicit `DORKOS_CORS_ORIGIN` is set.

### 1.2 Fix transport abstraction leak in TunnelDialog

**File:** `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx`

Replace `fetch('/api/config', ...)` in `handleSaveToken` with `transport.updateConfig({ tunnel: { authtoken } })`. Add `transport` to the `useCallback` dependency array.

### 1.3 Fix wrong DEV_CLIENT_PORT constant

**File:** `apps/server/src/routes/tunnel.ts`, `apps/server/src/env.ts`

Change `DEV_CLIENT_PORT = 3000` to `Number(process.env.VITE_PORT) || 4241`. Add `VITE_PORT` to the server env Zod schema as an optional coerced number.

### 1.4 Remove 0.0.0.0 binding

**File:** `apps/server/src/index.ts`

Replace `const host = env.TUNNEL_ENABLED ? '0.0.0.0' : 'localhost'` with `const host = 'localhost'`. The ngrok SDK connects to localhost internally.

---

## Phase 2: Architecture (3 tasks)

Phase 2 depends on Phase 1 completion. Tasks 2.1 and 2.2 can run in parallel. Task 2.3 depends on both.

| ID  | Task                                                         | Size   | Priority | Dependencies |
| --- | ------------------------------------------------------------ | ------ | -------- | ------------ |
| 2.1 | Add EventEmitter mixin and on_status_change to TunnelManager | medium | high     | 1.1-1.4      |
| 2.2 | Create unified TunnelStatus Zod schema                       | medium | high     | 1.1-1.4      |
| 2.3 | Add SSE endpoint and route improvements                      | medium | high     | 2.1, 2.2     |

### 2.1 EventEmitter mixin and on_status_change

**File:** `apps/server/src/services/core/tunnel-manager.ts`

Make `TunnelManager` extend `EventEmitter`. Add `updateStatus(partial)` that merges and emits `status_change`. Wire `on_status_change` callback in `ngrok.forward()` to handle `'connected'` and `'closed'` statuses. Type `forwardOpts` properly instead of `Record<string, unknown>`.

### 2.2 Unified TunnelStatus Zod schema

**File:** `packages/shared/src/schemas.ts` + consumers

Replace `TunnelStatusSchema` with 8-field superset: `enabled`, `connected`, `url`, `port`, `startedAt`, `authEnabled`, `tokenConfigured`, `domain`. Update `ServerConfigSchema.tunnel` to use `TunnelStatusSchema`. Update health route, config route, TunnelManager, and DirectTransport to use the unified type.

### 2.3 SSE endpoint and route improvements

**File:** `apps/server/src/routes/tunnel.ts`

Add `GET /api/tunnel/stream` (SSE), `GET /api/tunnel/status` (JSON), Zod validation on `POST /start` body, and 409 response when tunnel is already running.

---

## Phase 3: Multi-Tab Sync (2 tasks)

Phase 3 depends on Phase 2. Tasks 3.1 and 3.2 can run in parallel.

| ID  | Task                                                     | Size   | Priority | Dependencies |
| --- | -------------------------------------------------------- | ------ | -------- | ------------ |
| 3.1 | Create BroadcastChannel wrapper utility                  | small  | medium   | 2.1-2.3      |
| 3.2 | Create entities/tunnel module with status and sync hooks | medium | medium   | 2.1-2.3      |

### 3.1 BroadcastChannel wrapper

**New file:** `apps/client/src/layers/shared/lib/broadcast-channel.ts`

Generic `createChannel<T>(name)` wrapper with `postMessage`, `onMessage` (returns unsubscribe), and `close`. Graceful fallback for environments without BroadcastChannel.

### 3.2 entities/tunnel module

**New directory:** `apps/client/src/layers/entities/tunnel/`

- `model/use-tunnel-status.ts` — TanStack Query hook fetching tunnel status from config
- `model/use-tunnel-sync.ts` — Cross-tab (BroadcastChannel) and cross-device (SSE) sync, plus `broadcastTunnelChange()` utility
- `index.ts` — Barrel exports

---

## Phase 4: TunnelDialog UX Redesign (7 tasks)

Phase 4 depends on Phases 2-3. Tasks 4.2-4.6 can run in parallel after 4.1. Task 4.7 can run in parallel with 4.1.

| ID  | Task                                                 | Size   | Priority | Dependencies |
| --- | ---------------------------------------------------- | ------ | -------- | ------------ |
| 4.1 | Fix TunnelDialog state machine and stale closure bug | medium | medium   | 2.1-3.2      |
| 4.2 | Add onboarding flow component                        | medium | medium   | 4.1          |
| 4.3 | Add custom domain field                              | small  | medium   | 4.1          |
| 4.4 | Add connection quality indicator                     | small  | low      | 4.1          |
| 4.5 | Add session sharing copy button                      | small  | low      | 4.1          |
| 4.6 | Expand error states and disconnect/reconnect toasts  | medium | medium   | 4.1          |
| 4.7 | Add embedded mode guard for tunnel UI                | small  | medium   | 2.1-3.2      |

### 4.1 State machine fix

Fix stale closure by adding `state` to useEffect dependency array. Keep URL visible during `stopping` state. Add 30-second recovery timeout for stuck `starting`/`stopping` states.

### 4.2 Onboarding flow

**New file:** `apps/client/src/layers/features/settings/ui/TunnelOnboarding.tsx`

SVG illustration (laptop + phone + tablet with dotted lines), "Access DorkOS from any device" value prop, 3-step numbered guide. Collapses with `AnimatePresence` after token is saved.

### 4.3 Custom domain field

Always visible when token is configured. Pre-populated from config. Saves on blur/Enter via `transport.updateConfig()`. Hint text links to ngrok free domain dashboard. Benefits list: same URL, reusable QR codes, persistent bookmarks.

### 4.4 Connection quality indicator

Colored dot next to URL: green (<200ms), amber (200-500ms), red (>500ms). Measured by pinging `{tunnelUrl}/api/health` every 30 seconds. Stops when dialog closes.

### 4.5 Session sharing

Second copy button "Copy session link" that copies `{tunnelUrl}?session={sessionId}`. Only visible when both tunnel is connected and a session is selected.

### 4.6 Error states and toasts

Expand `friendlyErrorMessage()` with 7+ patterns. Add sonner toasts for disconnect ("Remote access disconnected") and reconnect ("Remote access reconnected"). Toast logic mounted globally (not just in dialog).

### 4.7 Embedded mode guard

Hide TunnelDialog and TunnelItem when in DirectTransport (Obsidian) mode. Check `serverConfig?.port === 0` heuristic. Return null instead of throwing.

---

## Phase 5: Status Bar (1 task)

| ID  | Task                                                    | Size  | Priority | Dependencies |
| --- | ------------------------------------------------------- | ----- | -------- | ------------ |
| 5.1 | Improve TunnelItem with quality dot and useTunnelStatus | small | low      | 3.2, 4.1     |

### 5.1 TunnelItem improvements

Replace props-based approach with `useTunnelStatus()` hook. Add small colored dot on Globe icon for connection status. Remove `animate-pulse`. Update parent component to render `<TunnelItem />` without props.

---

## Phase 6: CLI Improvements (2 tasks)

Phase 6 depends on Phase 2 (EventEmitter). Tasks 6.1 and 6.2 can run in parallel.

| ID  | Task                                           | Size   | Priority | Dependencies |
| --- | ---------------------------------------------- | ------ | -------- | ------------ |
| 6.1 | Add terminal QR code when tunnel starts in CLI | medium | low      | 2.1          |
| 6.2 | Add tunnel URL to CLI startup banner           | small  | low      | 2.1          |

### 6.1 Terminal QR code

Add `qrcode-terminal` dependency to `packages/cli`. Listen for `status_change` event from TunnelManager. Print styled box with URL and QR code when tunnel connects.

### 6.2 Tunnel URL in startup banner

Print `  Tunnel:  {url}` in the CLI startup banner after Local/Network URLs. Handle both synchronous (already connected) and asynchronous (connects later) cases.

---

## Phase 7: Testing (5 tasks)

All Phase 7 tasks can run in parallel, provided their feature dependencies are met.

| ID  | Task                                        | Size   | Priority | Dependencies |
| --- | ------------------------------------------- | ------ | -------- | ------------ |
| 7.1 | Add CORS integration test                   | medium | medium   | 1.1          |
| 7.2 | Add EventEmitter and on_status_change tests | medium | medium   | 2.1          |
| 7.3 | Add comprehensive TunnelDialog tests        | medium | medium   | 4.1-4.3      |
| 7.4 | Update tunnel route tests                   | medium | medium   | 1.3, 2.3     |
| 7.5 | Add cross-tab sync tests                    | medium | medium   | 3.1, 3.2     |

### 7.1 CORS integration test

**New file:** `apps/server/src/routes/__tests__/tunnel-cors.test.ts`

Test tunnel origin accepted when connected, rejected when not, localhost always works, no-origin works, dynamic URL updates reflected.

### 7.2 TunnelManager EventEmitter tests

**File:** `apps/server/src/services/core/__tests__/tunnel-manager.test.ts`

Add tests for `status_change` events on start/stop, `on_status_change` callback, disconnect/reconnect cycle.

### 7.3 TunnelDialog comprehensive tests

**File:** `apps/client/src/layers/features/settings/__tests__/TunnelDialog.test.tsx`

Add tests for connected state (QR, URL, copy), error state (retry), onboarding (illustration text), custom domain (input visibility). Mock clipboard API.

### 7.4 Tunnel route tests update

**File:** `apps/server/src/routes/__tests__/tunnel.test.ts`

Fix NODE_ENV cleanup with `vi.stubEnv`. Add 409 test. Add GET /status test. Add SSE /stream test. Update dev port assertion from 3000 to 4241.

### 7.5 Cross-tab sync tests

**New files:**

- `apps/client/src/layers/shared/lib/__tests__/broadcast-channel.test.ts`
- `apps/client/src/layers/entities/tunnel/__tests__/use-tunnel-sync.test.ts`

Test BroadcastChannel wrapper (create, post/receive, unsubscribe, close, fallback). Test useTunnelSync hook (query invalidation on BroadcastChannel message and SSE event, cleanup on unmount).

---

## Phase 8: Documentation & Cleanup (3 tasks)

All Phase 8 tasks can run in parallel.

| ID  | Task                                                   | Size   | Priority | Dependencies  |
| --- | ------------------------------------------------------ | ------ | -------- | ------------- |
| 8.1 | Update tunnel-setup.mdx documentation                  | medium | low      | 2.2, 2.3, 6.1 |
| 8.2 | Replace Record<string, unknown> with typed forwardOpts | small  | low      | 2.1           |
| 8.3 | Fix DirectTransport tunnel methods                     | small  | low      | 2.2           |

### 8.1 Docs update

**File:** `docs/guides/tunnel-setup.mdx`

Fix health response format, add custom domain section, add multi-tab awareness info, add CLI QR code section, document new API endpoints.

### 8.2 Type safety

**File:** `apps/server/src/services/core/tunnel-manager.ts`

Replace `Record<string, unknown>` with typed `NgrokForwardOptions` interface. May already be done in task 2.1.

### 8.3 DirectTransport fix

**File:** `apps/client/src/layers/shared/lib/direct-transport.ts`

Change `startTunnel()` to return `{ url: '' }` instead of throwing. Change `stopTunnel()` to no-op instead of throwing. Update `getConfig()` tunnel object to include all unified fields.

---

## Summary

| Phase                       | Tasks  | Parallel Opportunities                               |
| --------------------------- | ------ | ---------------------------------------------------- |
| P1: Critical Bug Fixes      | 4      | All 4 in parallel                                    |
| P2: Architecture            | 3      | 2.1 + 2.2 in parallel, then 2.3                      |
| P3: Multi-Tab Sync          | 2      | Both in parallel                                     |
| P4: TunnelDialog UX         | 7      | 4.2-4.6 in parallel after 4.1; 4.7 parallel with 4.1 |
| P5: Status Bar              | 1      | --                                                   |
| P6: CLI Improvements        | 2      | Both in parallel                                     |
| P7: Testing                 | 5      | All 5 in parallel (per dependency)                   |
| P8: Documentation & Cleanup | 3      | All 3 in parallel                                    |
| **Total**                   | **27** |                                                      |

**Critical path:** P1 (parallel) -> P2.1+P2.2 (parallel) -> P2.3 -> P3 (parallel) -> P4.1 -> P4.2-4.6 (parallel)

**Estimated effort:** ~3-4 days with parallel execution, ~6-7 days sequential.
