---
slug: settings-screen
---

# Specification: Settings Screen

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-02-12

---

## 1. Overview

Add a settings screen to the CC WebUI. A gear icon in the sidebar footer opens a responsive dialog (Dialog on desktop, Drawer on mobile) with two sections: editable client preferences (auto-saved to localStorage) and read-only server configuration display (fetched from a new API endpoint).

## 2. Background / Problem Statement

Users currently have no centralized place to view or modify app preferences. Theme switching is buried as an icon in the sidebar footer. There's no way to see server configuration (port, tunnel status, CLI path, etc.) without checking the terminal or `.env` files. A settings screen provides discoverability for existing features and a home for future preferences.

## 3. Goals

- Provide a centralized, discoverable settings interface
- Surface server configuration in the UI (read-only, sanitized)
- Support client preferences with auto-save (theme, font size, timestamps, tool call expansion, dev tools, verbose logging)
- Responsive: Dialog on desktop, Drawer on mobile
- Follow existing architectural patterns (Transport interface, Zustand, TanStack Query)

## 4. Non-Goals

- User accounts or multi-user settings
- Server-side mutation of settings from the client
- Full keyboard shortcut editor
- Plugin/extension settings
- Authentication on the config endpoint (local-only use case)

## 5. Technical Dependencies

| Dependency | Version | Purpose |
|-----------|---------|---------|
| React | ^19.0.0 | UI framework |
| Zustand | ^5.0.0 | Client state management |
| @tanstack/react-query | ^5.62.0 | Server config fetching |
| @radix-ui/react-dialog | ^1.1.15 | Dialog primitive (already installed) |
| vaul | ^1.1.2 | Drawer primitive (already installed) |
| lucide-react | latest | Settings icon |
| zod | ^4.3.6 | Schema definition |
| express | ^4.21.0 | API route |

**New shadcn/ui components to install:**
- Switch (toggle controls)
- Label (form labels)
- Separator (section dividers)
- Badge (status indicators)

## 6. Detailed Design

### 6.1 Gear Icon Trigger

**File:** `apps/client/src/components/sessions/SessionSidebar.tsx`

Add a `Settings` (lucide-react) icon button as the **first icon** in the footer's right-aligned button group (inside the `<div className="ml-auto flex items-center gap-0.5">` container, before the HoverCard relay button).

```tsx
<button
  onClick={() => setSettingsOpen(true)}
  className="p-1 max-md:p-2 rounded-md text-muted-foreground/50 hover:text-muted-foreground transition-colors duration-150"
  aria-label="Settings"
>
  <Settings className="size-(--size-icon-sm)" />
</button>
```

State: `const [settingsOpen, setSettingsOpen] = useState(false);`

Render `<SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />` alongside the existing `<DirectoryPicker>`.

### 6.2 Settings Dialog Component

**New file:** `apps/client/src/components/settings/SettingsDialog.tsx`

Props: `{ open: boolean; onOpenChange: (open: boolean) => void }`

Uses `ResponsiveDialog` from `@/components/ui/responsive-dialog`. Pattern matches `DirectoryPicker.tsx`.

**Layout structure:**
```
ResponsiveDialog
  ResponsiveDialogContent (max-w-lg, p-0 gap-0)
    ResponsiveDialogHeader
      ResponsiveDialogTitle "Settings"
    ScrollableContent (overflow-y-auto flex-1 p-4 space-y-6)
      PreferencesSection
        SectionHeading "Preferences"
        SettingRow: Theme (Select: Light/Dark/System)
        SettingRow: Font size (Select: Small/Medium/Large)
        SettingRow: Show timestamps (Switch)
        SettingRow: Expand tool calls (Switch)
        SettingRow: Show dev tools (Switch)
        SettingRow: Verbose logging (Switch)
      Separator
      ServerSection
        SectionHeading "Server"
        ConfigRow: Version, Port, Uptime, Working dir, Node version
        ConfigRow: Claude CLI path
        ConfigRow: Tunnel status (with Badge)
        ConfigRow: ngrok token (with Badge)
    ResponsiveDialogFooter (optional — may omit if no actions needed)
```

**SettingRow component pattern:**
```tsx
<div className="flex items-center justify-between">
  <div>
    <Label className="text-sm font-medium">{label}</Label>
    <p className="text-xs text-muted-foreground">{description}</p>
  </div>
  {/* Switch or Select */}
</div>
```

**ConfigRow component pattern:**
```tsx
<div className="flex items-center justify-between py-1">
  <span className="text-sm text-muted-foreground">{label}</span>
  <span className="text-sm font-mono">{value}</span>
</div>
```

### 6.3 Client Settings State

**File:** `apps/client/src/stores/app-store.ts`

Extend the existing `AppState` interface and store:

```typescript
// New state fields
showTimestamps: boolean;
setShowTimestamps: (v: boolean) => void;
expandToolCalls: boolean;
setExpandToolCalls: (v: boolean) => void;
verboseLogging: boolean;
setVerboseLogging: (v: boolean) => void;
fontSize: 'small' | 'medium' | 'large';
setFontSize: (v: 'small' | 'medium' | 'large') => void;
```

**Persistence:** Each setting reads initial value from `localStorage` (key prefix: `gateway-`) and writes on change. Follows the same pattern as `recentCwds`.

**Existing state reuse:**
- `devtoolsOpen` / `toggleDevtools` — already in store, reused directly
- Theme — uses existing `useTheme()` hook, NOT stored in app-store

**Font size implementation:** The `fontSize` setting applies a CSS custom property `--user-font-scale` on `document.documentElement`:
- `small` → `0.9`
- `medium` → `1` (default)
- `large` → `1.15`

This multiplier is consumed in `index.css` alongside the existing mobile scale system. The `--text-*` theme tokens already use `calc(base * var(--_st))` — we add `var(--user-font-scale, 1)` as an additional multiplier.

### 6.4 Server Config API

#### Schema

**File:** `packages/shared/src/schemas.ts` — Add after `HealthResponseSchema`:

```typescript
export const ServerConfigSchema = z
  .object({
    version: z.string(),
    port: z.number().int(),
    uptime: z.number(),
    workingDirectory: z.string(),
    nodeVersion: z.string(),
    claudeCliPath: z.string().nullable(),
    tunnel: z.object({
      enabled: z.boolean(),
      connected: z.boolean(),
      url: z.string().nullable(),
      authEnabled: z.boolean(),
      tokenConfigured: z.boolean(),
    }),
  })
  .openapi('ServerConfig');

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
```

**File:** `packages/shared/src/types.ts` — Add `ServerConfig` to the re-export list.

#### Transport Interface

**File:** `packages/shared/src/transport.ts` — Add method:

```typescript
getConfig(): Promise<ServerConfig>;
```

Add `ServerConfig` to the import from `./types.js`.

#### HTTP Transport

**File:** `apps/client/src/lib/http-transport.ts` — Add method:

```typescript
getConfig(): Promise<ServerConfig> {
  return fetchJSON<ServerConfig>(this.baseUrl, '/config');
}
```

#### Direct Transport

**File:** `apps/client/src/lib/direct-transport.ts` — Add method returning static/mock values (Obsidian plugin context):

```typescript
async getConfig(): Promise<ServerConfig> {
  return {
    version: '0.1.0',
    port: 0,
    uptime: 0,
    workingDirectory: this.services.vaultRoot,
    nodeVersion: process.version,
    claudeCliPath: null,
    tunnel: {
      enabled: false,
      connected: false,
      url: null,
      authEnabled: false,
      tokenConfigured: false,
    },
  };
}
```

#### Server Route

**New file:** `apps/server/src/routes/config.ts`

```typescript
import { Router } from 'express';
import { tunnelManager } from '../services/tunnel-manager.js';
import { resolveClaudeCliPath } from '../services/agent-manager.js';

const router = Router();

router.get('/', async (_req, res) => {
  let claudeCliPath: string | null = null;
  try {
    claudeCliPath = await resolveClaudeCliPath();
  } catch {}

  const tunnel = tunnelManager.status;

  res.json({
    version: '1.0.0',
    port: parseInt(process.env.GATEWAY_PORT || '6942', 10),
    uptime: process.uptime(),
    workingDirectory: process.cwd(),
    nodeVersion: process.version,
    claudeCliPath,
    tunnel: {
      enabled: tunnel.enabled,
      connected: tunnel.connected,
      url: tunnel.url,
      authEnabled: !!process.env.TUNNEL_AUTH,
      tokenConfigured: !!process.env.NGROK_AUTHTOKEN,
    },
  });
});

export default router;
```

**File:** `apps/server/src/app.ts` — Register route:

```typescript
import configRoutes from './routes/config.js';
// ...
app.use('/api/config', configRoutes);
```

### 6.5 Server Config Display

The server section in the dialog fetches config on open:

```typescript
const transport = useTransport();
const { data: config, isLoading } = useQuery({
  queryKey: ['config'],
  queryFn: () => transport.getConfig(),
  staleTime: 30_000,
});
```

**Display mapping:**

| Field | Label | Format |
|-------|-------|--------|
| `config.version` | Version | Plain text |
| `config.port` | Port | Plain text |
| `config.uptime` | Uptime | Formatted: "2h 15m 30s" |
| `config.workingDirectory` | Working Directory | Monospace, truncated with tooltip |
| `config.nodeVersion` | Node.js | Plain text |
| `config.claudeCliPath` | Claude CLI | Monospace, or "Not found" in muted |
| `config.tunnel.enabled` | Tunnel | Badge: "Enabled"/"Disabled" |
| `config.tunnel.connected` | Tunnel Status | Badge: green "Connected" / gray "Disconnected" |
| `config.tunnel.url` | Tunnel URL | Monospace link, or "—" |
| `config.tunnel.authEnabled` | Tunnel Auth | "Enabled"/"Disabled" |
| `config.tunnel.tokenConfigured` | ngrok Token | Badge: green "Configured" / gray "Not configured" |

**Loading state:** Skeleton-like placeholder (pulsing muted text) while fetching.

### 6.6 shadcn/ui Component Installation

Install via the shadcn CLI from the `apps/client` directory:

```bash
npx shadcn@latest add switch label separator badge
```

If the CLI doesn't work with the project's Vite/Tailwind 4 setup, manually create the components in `apps/client/src/components/ui/` following shadcn patterns.

## 7. User Experience

1. User sees gear icon as first icon in sidebar footer button row
2. Click opens responsive dialog (Dialog on desktop ≥768px, Drawer on mobile)
3. **Preferences section**: Toggle switches auto-save immediately. Select dropdowns auto-save on change. No Save button.
4. **Server section**: Read-only display loads on dialog open. Shows loading state briefly.
5. Close via X button, clicking outside (desktop), or swiping down (mobile drawer)

## 8. Testing Strategy

### Unit Tests

**`apps/client/src/components/settings/__tests__/SettingsDialog.test.tsx`**

- Renders without error
- Shows "Settings" title
- Displays all preference controls (theme select, font size select, 4 switches)
- Toggles update store state
- Server config section shows loading state
- Server config section displays fetched data
- Sensitive values show badges, not raw values

**Purpose comments:** Each test includes a comment explaining what user behavior it validates.

### Mocking Strategy

- Mock `useTransport()` to return a mock Transport with `getConfig()` returning test data
- Mock `useIsMobile()` to test responsive behavior
- Mock `motion/react` to render plain elements (existing pattern from `MessageList.test.tsx`)

## 9. Performance Considerations

- Server config fetched lazily (only when dialog opens) with 30s stale time
- Client settings read from localStorage on mount (synchronous, fast)
- No bundle size concern — Switch/Label/Separator/Badge are tiny components
- Dialog content is not rendered when closed (ResponsiveDialog handles this)

## 10. Security Considerations

- **NGROK_AUTHTOKEN**: Server transmits only `tokenConfigured: boolean`. Token value never leaves the server process.
- **TUNNEL_AUTH**: Server transmits only `authEnabled: boolean`. Credentials never leave the server process.
- **No auth on `/api/config`**: Acceptable for local-only usage. The endpoint exposes no secrets — only operational metadata (port, version, paths, boolean flags).

## 11. Documentation

- No documentation changes required
- Settings are self-documenting via labels and descriptions in the UI

## 12. Implementation Phases

### Phase 1: Foundation (Core)

1. Install shadcn/ui components (Switch, Label, Separator, Badge)
2. Add `ServerConfigSchema` to shared schemas, update types and transport interface
3. Create server config route (`apps/server/src/routes/config.ts`)
4. Register route in `app.ts`
5. Implement `getConfig()` in both transport adapters

### Phase 2: UI

6. Add client settings state to `app-store.ts` (showTimestamps, expandToolCalls, verboseLogging, fontSize)
7. Create `SettingsDialog.tsx` with preferences and server sections
8. Add gear icon to `SessionSidebar.tsx` footer
9. Wire font size CSS custom property

### Phase 3: Polish

10. Add loading state for server config
11. Add uptime formatter utility
12. Write tests

## 13. Files Modified/Created

| File | Action | Phase |
|------|--------|-------|
| `apps/client/src/components/ui/switch.tsx` | Create (shadcn install) | 1 |
| `apps/client/src/components/ui/label.tsx` | Create (shadcn install) | 1 |
| `apps/client/src/components/ui/separator.tsx` | Create (shadcn install) | 1 |
| `apps/client/src/components/ui/badge.tsx` | Create (shadcn install) | 1 |
| `packages/shared/src/schemas.ts` | Modify — add ServerConfigSchema | 1 |
| `packages/shared/src/types.ts` | Modify — re-export ServerConfig | 1 |
| `packages/shared/src/transport.ts` | Modify — add getConfig() | 1 |
| `apps/server/src/routes/config.ts` | Create — GET /api/config | 1 |
| `apps/server/src/app.ts` | Modify — register config route | 1 |
| `apps/client/src/lib/http-transport.ts` | Modify — implement getConfig() | 1 |
| `apps/client/src/lib/direct-transport.ts` | Modify — implement getConfig() | 1 |
| `apps/client/src/stores/app-store.ts` | Modify — add settings state | 2 |
| `apps/client/src/components/settings/SettingsDialog.tsx` | Create — main dialog | 2 |
| `apps/client/src/components/sessions/SessionSidebar.tsx` | Modify — add gear icon | 2 |
| `apps/client/src/index.css` | Modify — font scale CSS property | 2 |
| `apps/client/src/components/settings/__tests__/SettingsDialog.test.tsx` | Create — tests | 3 |

## 14. Acceptance Criteria

1. Gear icon appears as first icon in sidebar footer right-aligned group
2. Clicking gear opens settings dialog (Dialog ≥768px, Drawer <768px)
3. All 6 client preference controls render and function (theme, font size, timestamps, tool calls, dev tools, verbose logging)
4. Client preferences auto-save to localStorage on change
5. Theme setting in dialog syncs bidirectionally with existing footer theme toggle
6. Font size setting applies visible change to text sizes
7. Server config section fetches and displays all fields
8. Sensitive values (ngrok token, tunnel auth) show only boolean badges
9. Server config shows loading state while fetching
10. Build passes: `npx turbo build`
11. Existing tests pass: `npx turbo test`

## 15. Open Questions

None — all clarifications resolved during ideation.

## 16. References

- Ideation document: `specs/settings-screen/01-ideation.md`
- ResponsiveDialog component: `apps/client/src/components/ui/responsive-dialog.tsx`
- DirectoryPicker (pattern reference): `apps/client/src/components/sessions/DirectoryPicker.tsx`
- Health route (pattern reference): `apps/server/src/routes/health.ts`
- Transport interface: `packages/shared/src/transport.ts`
- Design system: `guides/design-system.md`
