---
slug: settings-screen
---

# Settings Screen

**Slug:** settings-screen
**Author:** Claude Code
**Date:** 2026-02-12
**Related:** N/A

---

## 1) Intent & Assumptions

**Task brief:** Add a settings screen accessible via a gear icon in the sidebar footer (left of attribution text). Opens a responsive dialog (Dialog on desktop, Drawer on mobile). Displays sanitized server config and client preferences with shadcn/ui controls (Switch, etc.).

**Assumptions:**
- Settings dialog uses the existing `ResponsiveDialog` component (already built)
- Server config is read-only (display only, no mutation from client)
- Client settings use auto-save to localStorage (toggle switches save on change, no explicit Save button)
- Theme toggle already exists in sidebar footer — settings dialog provides an alternate, more discoverable location but the existing footer toggle remains
- No authentication layer exists; server config endpoint is openly accessible (local-only use case)

**Out of scope:**
- User accounts / multi-user settings
- Server-side setting mutation from the client
- Full keyboard shortcut editor
- Plugin/extension settings

---

## 2) Pre-reading Log

- `apps/client/src/components/sessions/SessionSidebar.tsx`: Sidebar with footer (lines 140-201). Footer has status icons, theme toggle, dev tools toggle, and "CC WebUI by Dorkian" attribution. Gear icon goes before attribution text.
- `apps/client/src/components/ui/responsive-dialog.tsx`: Complete responsive Dialog/Drawer wrapper. Desktop renders Dialog, mobile renders Drawer. Sub-components: `ResponsiveDialog`, `ResponsiveDialogContent`, `ResponsiveDialogHeader`, `ResponsiveDialogTitle`, `ResponsiveDialogDescription`, `ResponsiveDialogFooter`, `ResponsiveDialogClose`.
- `apps/client/src/components/sessions/DirectoryPicker.tsx`: Reference implementation using ResponsiveDialog + TanStack Query for data fetching. Pattern: `open`/`onOpenChange` props, `useQuery` for server data.
- `apps/client/src/components/ui/` directory: Has `dialog.tsx`, `drawer.tsx`, `responsive-dialog.tsx`, `responsive-dropdown-menu.tsx`, `dropdown-menu.tsx`, `hover-card.tsx`, `path-breadcrumb.tsx`. **Missing:** Switch, Label, Separator, Badge.
- `packages/shared/src/transport.ts`: Transport interface with 14 methods. Need to add `getConfig()`.
- `packages/shared/src/schemas.ts`: Zod schemas for all types. `HealthResponseSchema` (status, version, uptime, tunnel) is the pattern for a new `ServerConfigSchema`.
- `apps/server/src/routes/health.ts`: Simple endpoint returning status/version/uptime/tunnel. Pattern for new config route.
- `apps/server/src/index.ts`: Server setup. Env vars: `GATEWAY_PORT`, `TUNNEL_ENABLED`, `NGROK_AUTHTOKEN`, `TUNNEL_PORT`, `TUNNEL_AUTH`, `TUNNEL_DOMAIN`.
- `apps/client/src/stores/app-store.ts`: Zustand store with devtools. Has `sidebarOpen`, `sessionId`, `selectedCwd`, `recentCwds`, `devtoolsOpen`, `contextFiles`.
- `apps/client/src/hooks/use-theme.ts`: Theme state in localStorage (`gateway-theme`). Three modes: light/dark/system. Watches `prefers-color-scheme`.
- `apps/client/src/lib/http-transport.ts`: HttpTransport adapter — implements Transport for standalone web mode.
- `apps/client/src/lib/direct-transport.ts`: DirectTransport adapter — implements Transport for Obsidian plugin mode.

---

## 3) Codebase Map

**Primary Components/Modules:**
- `apps/client/src/components/sessions/SessionSidebar.tsx` — Sidebar container + footer where gear icon trigger lives
- `apps/client/src/components/ui/responsive-dialog.tsx` — Dialog/Drawer wrapper to use for settings
- `apps/client/src/components/sessions/DirectoryPicker.tsx` — Reference pattern for responsive dialog usage
- `packages/shared/src/transport.ts` — Transport interface to extend with `getConfig()`
- `packages/shared/src/schemas.ts` — Zod schemas to add `ServerConfigSchema`
- `apps/server/src/routes/health.ts` — Pattern for new config route

**Shared Dependencies:**
- `apps/client/src/stores/app-store.ts` — Zustand store for client settings persistence
- `apps/client/src/hooks/use-theme.ts` — Theme management (may integrate with settings)
- `apps/client/src/contexts/TransportContext.tsx` — Transport injection context
- `apps/client/src/lib/http-transport.ts` — HTTP adapter (needs `getConfig()`)
- `apps/client/src/lib/direct-transport.ts` — Direct adapter (needs `getConfig()`)

**Data Flow:**
1. Server config: Client `getConfig()` → Transport → `GET /api/config` → Server reads env/runtime state → Returns sanitized config
2. Client settings: User toggles → Zustand store → localStorage persistence → Component re-render

**Feature Flags/Config:**
- `import.meta.env.DEV` — Already used for dev tools toggle in sidebar

**Potential Blast Radius:**
- Direct: ~8-10 new/modified files
- Transport interface change affects both adapters
- Sidebar footer layout change (minor)
- No existing tests should break

---

## 4) Root Cause Analysis

N/A — New feature, not a bug fix.

---

## 5) Research

### Server Config: What to Show vs. Hide

**Safe to display (read-only):**
| Field | Source | Format |
|-------|--------|--------|
| Server version | `package.json` | `1.0.0` |
| Server port | `GATEWAY_PORT` env | `6942` |
| Server uptime | `process.uptime()` | Human-readable (e.g., "2h 15m") |
| Working directory | `process.cwd()` | Full path |
| Node.js version | `process.version` | `v22.x.x` |
| Tunnel enabled | `TUNNEL_ENABLED` env | Boolean |
| Tunnel status | TunnelManager | `connected` / `disconnected` / `disabled` |
| Tunnel URL | TunnelManager | Full URL (if connected) |
| Tunnel auth enabled | `TUNNEL_AUTH` env | `true`/`false` (not the credentials) |
| Claude CLI path | Resolved path | Full path |

**NEVER display:**
- `NGROK_AUTHTOKEN` — Show "Configured" / "Not configured" badge only
- `TUNNEL_AUTH` credentials — Show "Enabled" / "Disabled" only
- Any API keys or tokens
- File system paths that reveal sensitive structure outside working dir

**Sanitization pattern:** For secrets, show status badges ("Configured" in green, "Not configured" in gray). Never transmit the actual value to the client.

### Client Settings: What to Include

**Appearance:**
- Theme: Light / Dark / System (already exists as footer toggle, surfaces it here too)

**Chat Behavior:**
- Show timestamps on messages (Switch, default: off)
- Expand tool calls by default (Switch, default: off — currently they're collapsed)

**Developer:**
- Show dev tools (Switch, mirrors existing footer toggle)
- Verbose logging (Switch, default: off)

### UX Decisions

**Auto-save for toggles:** Switches/selects auto-save immediately to localStorage. No Save button needed. This follows UX best practice for imperative controls (toggles, selects).

**Dialog layout:** Single scrollable page with sections separated by headings + thin separators. Not tabbed — the settings list is small enough that tabs add unnecessary complexity.

**Organization:** Two sections:
1. **Preferences** — Client-side settings (toggleable)
2. **Server** — Read-only server configuration display

### shadcn/ui Components Needed

| Component | Purpose | Status |
|-----------|---------|--------|
| Switch | Toggle settings | **Need to install** |
| Label | Setting labels | **Need to install** |
| Separator | Section dividers | **Need to install** |
| Badge | Status indicators (e.g., tunnel "Connected") | **Need to install** |

---

## 6) Clarification (Resolved)

1. **Gear icon placement**: **(a) First icon (leftmost) in the existing icon button row** — consistent with existing pattern.

2. **Theme setting duplication**: **(a) Include theme in settings AND keep the footer toggle** — settings is the "proper" location, footer is a convenience shortcut.

3. **Client settings scope**: Approved list + addition:
   - Theme (light/dark/system)
   - **Font size** (small/medium/large — or slider)
   - Show timestamps on messages
   - Expand tool calls by default
   - Show dev tools
   - Verbose logging

4. **Server config endpoint security**: No guard needed — local-only is fine. Open endpoint.
