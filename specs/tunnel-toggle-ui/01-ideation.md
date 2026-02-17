---
slug: tunnel-toggle-ui
number: 39
created: 2026-02-17
status: ideation
---

# Tunnel Toggle UI

**Slug:** tunnel-toggle-ui
**Author:** Claude Code
**Date:** 2026-02-17
**Related:** Builds on spec #12 (ngrok-tunnel)

---

## 1) Intent & Assumptions

**Task brief:** Add a UI to toggle the ngrok tunnel on/off through the DorkOS interface, with a status bar widget showing connection state and a dialog containing a QR code for easily opening the public URL from a phone.

**Assumptions:**
- The existing `TunnelManager` service with `start()`/`stop()` is stable and correct
- ngrok auth token can come from either `NGROK_AUTHTOKEN` env var or `~/.dork/config.json`
- The tunnel toggle should persist across server restarts (saved to config)
- QR code is the primary mechanism for desktop-to-mobile URL sharing

**Out of scope:**
- Custom ngrok domain management UI
- Tunnel authentication credential management (beyond token)
- Multiple simultaneous tunnels
- Tunnel usage analytics or bandwidth monitoring

## 2) Pre-reading Log

- `apps/server/src/services/tunnel-manager.ts`: TunnelManager singleton with start/stop/status. TunnelStatus tracks enabled, connected, url, port, startedAt
- `apps/server/src/routes/health.ts`: GET /health includes tunnel status when enabled
- `apps/server/src/routes/config.ts`: GET /config returns tunnel state, PATCH /config updates persistent config but doesn't toggle tunnel
- `apps/server/src/index.ts`: Tunnel started at boot if TUNNEL_ENABLED=true, binds to 0.0.0.0 when tunneling
- `packages/shared/src/config-schema.ts`: UserConfig has tunnel.enabled, tunnel.domain, tunnel.authtoken, tunnel.auth
- `packages/shared/src/schemas.ts`: ServerConfigSchema has tunnel.enabled, connected, url, authEnabled, tokenConfigured
- `packages/shared/src/transport.ts`: Transport interface has getConfig() and health() but no tunnel methods
- `apps/client/src/layers/features/settings/ui/ServerTab.tsx`: Read-only tunnel status display with ConfigBadgeRow/ConfigRow
- `apps/client/src/layers/features/status/ui/StatusLine.tsx`: Conditional status items with AnimatePresence, app store boolean flags
- `apps/client/src/layers/shared/model/app-store.ts`: Zustand store with persisted boolean preferences, BOOL_KEYS/BOOL_DEFAULTS pattern
- `apps/client/src/layers/shared/lib/http-transport.ts`: HttpTransport implements Transport with fetchJSON helper

## 3) Codebase Map

**Primary components/modules:**
- `apps/server/src/services/tunnel-manager.ts` — TunnelManager with start/stop lifecycle
- `apps/server/src/routes/config.ts` — Config GET/PATCH endpoints
- `packages/shared/src/transport.ts` — Transport interface (needs startTunnel/stopTunnel)
- `apps/client/src/layers/features/settings/ui/ServerTab.tsx` — Current read-only tunnel display
- `apps/client/src/layers/features/status/ui/StatusLine.tsx` — Status bar container

**Shared dependencies:**
- `packages/shared/src/schemas.ts` — ServerConfigSchema (no changes needed)
- `packages/shared/src/config-schema.ts` — UserConfigSchema (no changes needed)
- `apps/client/src/layers/shared/model/app-store.ts` — Preferences store (add showStatusBarTunnel)
- `apps/client/src/layers/shared/ui/` — shadcn primitives (Dialog, Switch, Button, Popover)

**Data flow:**
User clicks toggle -> useTunnelControl hook -> transport.startTunnel() -> POST /api/tunnel/start -> tunnelManager.start() -> returns URL -> invalidate config query -> UI updates

**Feature flags/config:**
- `showStatusBarTunnel` (localStorage, defaults true) — controls status bar visibility
- `tunnel.enabled` (server config) — persisted tunnel auto-start preference
- `tunnel.authtoken` (server config, sensitive) — fallback when env var absent

**Potential blast radius:**
- Direct: ~10 new/modified files
- Transport interface: 3 files (interface + 2 adapters)
- No existing tests need modification (all new functionality)

## 4) Research

**QR Code Library:** `react-qr-code` (13.8 kB unpacked, SVG-only, actively maintained). 8x smaller than `qrcode.react`. Simple prop-driven API: `<QRCode value={url} size={200} level="M" />`

**Status UX Pattern:** Semantic colored dot + text label. Green=connected, amber+pulse=starting, gray=off, red=error. Follows ngrok's own Mantle design system and Carbon Design System patterns.

**Toggle Pattern:** Three-phase state machine (`off | starting | connected | stopping | error`). Disable switch during transitions. Pessimistic UI for start (wait for server confirmation), optimistic for stop. 15-second timeout for start.

**Full research:** `research/20260217_tunnel_toggle_ux_research.md`

## 5) Clarification

All clarifications resolved during design:

1. **QR code location:** One shared `TunnelDialog` opened from both status bar and settings (resolved: shared dialog)
2. **Status bar click behavior:** Always opens dialog, never direct-toggles (resolved: dialog-first)
3. **Auth token source:** Env var first, config file fallback. UI shows input field only when env var is absent (resolved: both, env wins)
