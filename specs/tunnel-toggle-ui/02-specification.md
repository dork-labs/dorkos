---
slug: tunnel-toggle-ui
number: 39
created: 2026-02-17
status: draft
---

# Specification: Tunnel Toggle UI

**Status:** Draft
**Authors:** Claude Code, 2026-02-17
**Branch:** preflight/tunnel-toggle-ui
**Related:** Spec #12 (ngrok-tunnel)

---

## 1. Overview

Add runtime ngrok tunnel control to the DorkOS web UI. Users can start/stop the tunnel through a shared dialog accessible from both the status bar and settings, view the public URL, copy it, and scan a QR code for mobile access. The tunnel state persists in config for auto-start on next server boot.

## 2. Background / Problem Statement

Currently, the ngrok tunnel can only be enabled at boot time via the `TUNNEL_ENABLED` environment variable or `~/.dork/config.json`. There is no way to start or stop the tunnel at runtime through the UI. The settings screen shows read-only tunnel status but offers no control. Users who want to share their DorkOS instance temporarily must restart the server, which is disruptive.

## 3. Goals

- Allow users to start and stop the ngrok tunnel at runtime from the UI
- Show tunnel connection state in the status bar with semantic visual indicators
- Provide a QR code for quick mobile access when connected
- Allow auth token entry through the UI when the env var is not set
- Persist tunnel enabled/disabled state for auto-start on next boot
- Maintain backward compatibility with existing env var and config-based setup

## 4. Non-Goals

- Custom ngrok domain management UI
- Tunnel authentication credential management beyond token entry
- Multiple simultaneous tunnels
- Tunnel usage analytics or bandwidth monitoring
- Changes to the existing TunnelManager service internals

## 5. Technical Dependencies

| Dependency      | Version  | Purpose                                   |
| --------------- | -------- | ----------------------------------------- |
| `react-qr-code` | latest   | SVG QR code generation (13.8 kB unpacked) |
| `@ngrok/ngrok`  | existing | Already installed, used by TunnelManager  |
| `supertest`     | 7.2.2    | Already installed, for route testing      |

No new server-side dependencies. The `react-qr-code` library is added to `apps/client/package.json` only.

## 6. Detailed Design

### 6.1 Server: Tunnel Route (`apps/server/src/routes/tunnel.ts`)

Two new POST endpoints registered at `/api/tunnel`:

**POST /api/tunnel/start**

1. Resolve auth token: `process.env.NGROK_AUTHTOKEN` first, then `configManager.get('tunnel')?.authtoken` fallback
2. If no token found, return `400 { error: 'No ngrok auth token configured' }`
3. Build `TunnelConfig` from config values (port from `TUNNEL_PORT` or server port, domain from config, auth from config)
4. Call `tunnelManager.start(config)`
5. Persist `tunnel.enabled: true` via `configManager.set('tunnel', { ...current, enabled: true })`
6. Return `200 { url: tunnelManager.status.url }`
7. On error, return `500 { error: message }`

**POST /api/tunnel/stop**

1. Call `tunnelManager.stop()`
2. Persist `tunnel.enabled: false` via `configManager.set('tunnel', { ...current, enabled: false })`
3. Return `200 { ok: true }`
4. On error, return `500 { error: message }`

**Route registration** in `apps/server/src/app.ts`:

```typescript
import tunnelRoutes from './routes/tunnel.js';
app.use('/api/tunnel', tunnelRoutes);
```

### 6.2 Shared: Transport Interface (`packages/shared/src/transport.ts`)

Add two methods to the `Transport` interface:

```typescript
/** Start the ngrok tunnel. Returns the public URL on success. */
startTunnel(): Promise<{ url: string }>;
/** Stop the ngrok tunnel. */
stopTunnel(): Promise<void>;
```

**HttpTransport** (`apps/client/src/layers/shared/lib/http-transport.ts`):

```typescript
async startTunnel(): Promise<{ url: string }> {
  return this.fetchJSON('/tunnel/start', { method: 'POST' });
}

async stopTunnel(): Promise<void> {
  await this.fetchJSON('/tunnel/stop', { method: 'POST' });
}
```

**DirectTransport** (`apps/client/src/layers/shared/lib/direct-transport.ts`):

```typescript
async startTunnel(): Promise<{ url: string }> {
  throw new Error('Tunnel control is not available in embedded mode');
}

async stopTunnel(): Promise<void> {
  throw new Error('Tunnel control is not available in embedded mode');
}
```

**Mock Transport** (`packages/test-utils/`): Add `startTunnel` and `stopTunnel` as `vi.fn()` stubs to `createMockTransport()`.

### 6.3 Client: App Store Preference (`apps/client/src/layers/shared/model/app-store.ts`)

Add to `BOOL_KEYS`:

```typescript
showStatusBarTunnel: 'dorkos-show-status-bar-tunnel',
```

Add to `BOOL_DEFAULTS`:

```typescript
showStatusBarTunnel: true,
```

This follows the existing pattern used by `showStatusBarGit`, `showStatusBarModel`, `showStatusBarNotificationSound`, etc.

### 6.4 Client: TunnelDialog (`apps/client/src/layers/features/settings/ui/TunnelDialog.tsx`)

A shared dialog opened from both the status bar widget and the settings "Manage" button.

**Props:**

```typescript
interface TunnelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

**State machine** (local React state):

```
off → starting → connected
                ↘ error
connected → stopping → off
                     ↘ error
```

States: `'off' | 'starting' | 'connected' | 'stopping' | 'error'`

- Switch is disabled during `starting` and `stopping` transitions
- Start uses pessimistic UI: switch stays off until server confirms connection
- Stop uses optimistic UI: switch flips immediately, reverts on error
- 15-second timeout for start, auto-transitions to `error` state

**Layout:**

1. **Header row**: Semantic status dot + "Tunnel" label + Switch toggle
   - Dot colors: gray (`off`), amber with pulse animation (`starting`), green (`connected`), red (`error`)
2. **Auth token section** (visible only when `!serverConfig.tunnel.tokenConfigured`):
   - Text input for ngrok auth token
   - "Save" button that PATCHes `/api/config` with `{ tunnel: { authtoken: value } }`
3. **Connected section** (visible only when `connected`):
   - Public URL with copy-on-click (reuse `useCopy` pattern from ServerTab)
   - QR code via `react-qr-code`: `<QRCode value={url} size={200} level="M" />` on white background
   - Helper text: "Scan to open on mobile"
4. **Error section** (visible only when `error`):
   - Error message with "Try again" action

**Data fetching**: Reads tunnel state from the existing `useConfig()` TanStack Query hook (already used by ServerTab). Invalidates config query after start/stop to refresh state.

### 6.5 Client: TunnelItem (`apps/client/src/layers/features/status/ui/TunnelItem.tsx`)

Status bar widget following the `NotificationSoundItem` / `VersionItem` pattern.

**Display:**

- Semantic colored dot (same colors as dialog)
- Globe icon (`lucide-react`)
- Truncated hostname when connected (e.g., `abc123.ngrok-free.app`)
- When not connected: just the dot + "Tunnel" text

**Behavior:**

- Click opens TunnelDialog
- Manages its own TunnelDialog open state

**Rendering in StatusLine:**

```typescript
// In StatusLine.tsx, add entry when showStatusBarTunnel is true
{showStatusBarTunnel && serverConfig?.tunnel && (
  <TunnelItem tunnel={serverConfig.tunnel} />
)}
```

### 6.6 Client: Settings Integration

**ServerTab.tsx changes:**

- Replace the read-only tunnel `ConfigBadgeRow` block (lines ~64-93) with a "Manage" button
- Add `onOpenTunnelDialog?: () => void` prop
- Button triggers `onOpenTunnelDialog()` to open the shared TunnelDialog

**SettingsDialog.tsx changes:**

- Add `tunnelDialogOpen` state
- Pass `onOpenTunnelDialog={() => setTunnelDialogOpen(true)}` to ServerTab
- Render `<TunnelDialog open={tunnelDialogOpen} onOpenChange={setTunnelDialogOpen} />`
- Add `showStatusBarTunnel` toggle in Status Bar tab using existing `SettingRow` + `Switch` pattern

### 6.7 Barrel Exports

- `apps/client/src/layers/features/settings/index.ts`: Export `TunnelDialog`
- `apps/client/src/layers/features/status/index.ts`: Export `TunnelItem`

## 7. User Experience

### Discovery

- **Status bar**: When tunnel is configured, a tunnel widget appears in the status bar (visibility toggleable in Settings > Status Bar)
- **Settings**: Server tab shows a "Manage" button in the tunnel section

### Start Flow

1. User clicks status bar tunnel widget (or Settings > Server > Manage)
2. TunnelDialog opens showing current state (off)
3. User flips the toggle switch
4. Dot turns amber with pulse animation, switch is disabled
5. After 2-5 seconds, dot turns green, URL appears with QR code
6. User scans QR code from phone or clicks URL to copy

### Stop Flow

1. User opens TunnelDialog, flips toggle off
2. Switch flips immediately (optimistic), dot turns gray
3. If stop fails, switch reverts to on with error state

### Error Recovery

- If start fails or times out (15s), dot turns red with error message
- "Try again" button resets to off state for retry
- If no auth token configured, the dialog shows a token input field

## 8. Testing Strategy

### Server Route Tests (`apps/server/src/routes/__tests__/tunnel.test.ts`)

Using supertest against the Express app:

- **POST /api/tunnel/start**: Returns 200 with URL when token available and start succeeds
- **POST /api/tunnel/start**: Returns 400 when no auth token configured
- **POST /api/tunnel/start**: Returns 500 when tunnelManager.start() throws
- **POST /api/tunnel/start**: Persists `tunnel.enabled: true` in config
- **POST /api/tunnel/stop**: Returns 200 when stop succeeds
- **POST /api/tunnel/stop**: Persists `tunnel.enabled: false` in config
- **POST /api/tunnel/stop**: Returns 500 when tunnelManager.stop() throws

Mocking: Mock `tunnelManager` (start/stop/status) and `configManager` (get/set).

### Client Component Tests

**TunnelDialog**:

- Renders toggle switch reflecting current tunnel state
- Shows auth token input when `tokenConfigured` is false
- Shows QR code and URL when connected
- Disables switch during `starting` state
- Displays error message on failure

**TunnelItem**:

- Renders green dot and hostname when connected
- Renders gray dot when disconnected
- Opens dialog on click

### Mock Transport Updates

Add `startTunnel: vi.fn()` and `stopTunnel: vi.fn()` to `createMockTransport()` in `packages/test-utils/`.

## 9. Performance Considerations

- **QR code rendering**: `react-qr-code` generates SVG inline (no canvas), minimal overhead. Only renders when dialog is open and tunnel is connected.
- **Polling**: No polling needed. UI reads from existing config query which is already fetched. After start/stop, a single query invalidation refreshes state.
- **Bundle size**: `react-qr-code` adds ~13.8 kB to the client bundle (SVG-only, no canvas dependency).
- **ngrok import**: Already dynamically imported in TunnelManager (zero cost when disabled).

## 10. Security Considerations

- **Auth token handling**: Token is stored in `~/.dork/config.json` (listed as sensitive key, excluded from GET /config responses when reading). The PATCH endpoint accepts token writes but never returns the raw token.
- **Tunnel endpoints**: No authentication on `/api/tunnel/start` and `/api/tunnel/stop`. These are local-network-only endpoints, consistent with all other DorkOS API endpoints. The ngrok tunnel itself can optionally enforce HTTP basic auth via the `tunnel.auth` config field.
- **Directory boundary**: Tunnel routes do not accept path parameters, so directory boundary enforcement is not applicable.

## 11. Documentation

- Update `contributing/configuration.md` to document the new tunnel control endpoints
- No changes to external docs needed (tunnel feature is already documented)

## 12. Implementation Phases

### Phase 1: Server API + Transport

- Create `routes/tunnel.ts` with POST /start and /stop
- Register route in `app.ts`
- Add `startTunnel()` / `stopTunnel()` to Transport interface
- Implement in HttpTransport, DirectTransport
- Update mock transport in test-utils
- Write route tests

### Phase 2: Client UI Components

- Add `showStatusBarTunnel` to app-store.ts
- Create TunnelDialog component
- Create TunnelItem status bar widget
- Integrate into StatusLine
- Update ServerTab with "Manage" button
- Wire TunnelDialog into SettingsDialog
- Add status bar toggle to Settings
- Update barrel exports
- Install `react-qr-code` dependency

### Phase 3: Polish

- Verify QR code renders correctly at various sizes
- Test error states and timeout behavior
- Verify status bar dot animations
- Test with actual ngrok tunnel (manual verification)

## 13. Open Questions

None. All design decisions were resolved during ideation:

1. ~~**QR code location**~~ (RESOLVED) — One shared TunnelDialog opened from both status bar and settings
2. ~~**Status bar click behavior**~~ (RESOLVED) — Always opens dialog, never direct-toggles
3. ~~**Auth token source**~~ (RESOLVED) — Env var first (NGROK_AUTHTOKEN), config file fallback. UI shows input only when env var absent.

## 14. Related ADRs

No existing ADRs are directly related to this feature.

## 15. References

- Spec #12: ngrok Tunnel Integration (original tunnel implementation)
- `react-qr-code` npm package: SVG-only QR code generation
- Research: `research/20260217_tunnel_toggle_ux_research.md`
- ngrok Mantle Design System (semantic status dot pattern inspiration)
