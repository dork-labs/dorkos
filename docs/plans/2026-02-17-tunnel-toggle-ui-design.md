# Tunnel Toggle UI — Design Document

**Date:** 2026-02-17
**Spec:** #39 (tunnel-toggle-ui)
**Status:** Approved

---

## Overview

Add a UI to toggle the ngrok tunnel on/off through the DorkOS interface. A status bar widget shows connection state at a glance. Clicking it opens a shared TunnelDialog with toggle, URL, QR code, and copy functionality. The same dialog is accessible from Settings > Server.

## Architecture

### Server API (2 new endpoints)

**`POST /api/tunnel/start`** in `routes/tunnel.ts`:
- Resolves auth token: `NGROK_AUTHTOKEN` env var first, then `configManager.get('tunnel').authtoken`
- Returns 400 if no token found
- Calls `tunnelManager.start({ authtoken, port, domain, basicAuth })`
- Persists `tunnel.enabled: true` to config
- Returns `{ url: string }` on success

**`POST /api/tunnel/stop`** in `routes/tunnel.ts`:
- Calls `tunnelManager.stop()`
- Persists `tunnel.enabled: false` to config
- Returns `{ ok: true }`

### Transport Interface (2 new methods)

```typescript
startTunnel(): Promise<{ url: string }>;
stopTunnel(): Promise<void>;
```

Implemented in HttpTransport (POST requests) and DirectTransport (direct tunnelManager calls).

### Client State

**App store:** Add `showStatusBarTunnel: boolean` (default: true, key: `dorkos-show-status-bar-tunnel`).

**Hook:** `useTunnelControl` manages transient toggle state as a local state machine: `off | starting | connected | stopping | error`. Not in global store — derived from server config + local async operation state.

### UI Components

**TunnelDialog** (`features/settings/ui/TunnelDialog.tsx`):
- Toggle switch row with status dot + label
- Auth token input (visible only when env var absent and not configured)
- Connected section: URL display (copy-on-click), QR code (200px, white bg), helper text
- Opened from both status bar item and settings server tab

**TunnelItem** (`features/status/ui/TunnelItem.tsx`):
- Semantic dot: gray=off, amber+pulse=starting, green=connected, red=error
- Label: "Tunnel" when off, truncated hostname when connected
- Click opens TunnelDialog
- Rendered when `showStatusBarTunnel && serverConfig` truthy

**ServerTab update**: Replace read-only tunnel rows with a "Manage" button that opens TunnelDialog.

**Settings > Status Bar tab**: Add `showStatusBarTunnel` toggle.

### New dependency

`react-qr-code` (13.8 kB unpacked, SVG-only) installed in `apps/client`.

## State Machine

```
off --[toggle on]--> starting --[server responds]--> connected
                                --[server error]----> error
connected --[toggle off]--> stopping --[server responds]--> off
                                     --[server error]----> error (but show as connected, retry)
error --[toggle on]--> starting
      --[dismiss]----> off
```

Switch is disabled during `starting` and `stopping` phases.

## File Inventory

| File | Action | Layer |
|---|---|---|
| `apps/server/src/routes/tunnel.ts` | Create | Server |
| `apps/server/src/index.ts` | Edit (register route) | Server |
| `packages/shared/src/transport.ts` | Edit (add 2 methods) | Shared |
| `apps/client/src/layers/shared/lib/http-transport.ts` | Edit (implement methods) | Client |
| `apps/client/src/layers/shared/lib/direct-transport.ts` | Edit (implement methods) | Client |
| `apps/client/src/layers/shared/model/app-store.ts` | Edit (add showStatusBarTunnel) | Client |
| `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx` | Create | Client |
| `apps/client/src/layers/features/settings/ui/ServerTab.tsx` | Edit (add Manage button) | Client |
| `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` | Edit (add status bar toggle) | Client |
| `apps/client/src/layers/features/status/ui/TunnelItem.tsx` | Create | Client |
| `apps/client/src/layers/features/status/ui/StatusLine.tsx` | Edit (add TunnelItem) | Client |
| `apps/client/src/layers/features/status/index.ts` | Edit (export TunnelItem) | Client |
| `apps/client/src/layers/features/settings/index.ts` | Edit (export TunnelDialog) | Client |
