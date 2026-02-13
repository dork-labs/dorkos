---
slug: settings-screen
---

# Tasks: Settings Screen

**Generated from:** `specs/settings-screen/02-specification.md`
**Date:** 2026-02-12

---

## Phase 1: Foundation

### Task 1.1: Install shadcn/ui components (Switch, Label, Separator, Badge)

**Files created:**
- `apps/client/src/components/ui/switch.tsx`
- `apps/client/src/components/ui/label.tsx`
- `apps/client/src/components/ui/separator.tsx`
- `apps/client/src/components/ui/badge.tsx`

**Steps:**

1. From the `apps/client` directory, run:
   ```bash
   npx shadcn@latest add switch label separator badge
   ```

2. If the CLI does not work with the project's Vite/Tailwind 4 setup, manually create the four components in `apps/client/src/components/ui/` following shadcn patterns. Use `cva` for badge variants, Radix primitives for Switch, and standard HTML for Label/Separator.

3. Verify each component exports correctly and follows the existing `data-slot` pattern used in other UI components (e.g., `button.tsx`).

**Acceptance criteria:**
- All four component files exist in `apps/client/src/components/ui/`
- Each component is importable: `import { Switch } from '@/components/ui/switch'` etc.
- `npx turbo build --filter=@lifeos/client` passes

---

### Task 1.2: Add ServerConfigSchema to shared schemas and types

**Files modified:**
- `packages/shared/src/schemas.ts`
- `packages/shared/src/types.ts`

**Steps:**

1. In `packages/shared/src/schemas.ts`, add the following **after** the `HealthResponseSchema` block (after line ~396):

```typescript
// === Server Config ===

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

2. In `packages/shared/src/types.ts`, add `ServerConfig` to the re-export list:

```typescript
export type {
  // ... existing exports ...
  HealthResponse,
  TunnelStatus,
  ServerConfig,  // <-- add this
} from './schemas.js';
```

**Acceptance criteria:**
- `ServerConfigSchema` is exported from `packages/shared/src/schemas.ts`
- `ServerConfig` type is exported from `packages/shared/src/types.ts`
- `npx turbo typecheck` passes

---

### Task 1.3: Add getConfig() to Transport interface

**Files modified:**
- `packages/shared/src/transport.ts`

**Steps:**

1. Add `ServerConfig` to the import from `./types.js`:

```typescript
import type {
  Session,
  CreateSessionRequest,
  UpdateSessionRequest,
  BrowseDirectoryResponse,
  CommandRegistry,
  HealthResponse,
  HistoryMessage,
  StreamEvent,
  TaskItem,
  ServerConfig,  // <-- add this
} from './types.js';
```

2. Add the method to the `Transport` interface, after the `health()` method:

```typescript
getConfig(): Promise<ServerConfig>;
```

**Acceptance criteria:**
- `Transport` interface includes `getConfig(): Promise<ServerConfig>`
- `npx turbo typecheck` will show errors in `HttpTransport` and `DirectTransport` (expected, fixed in Tasks 1.5 and 1.6)

---

### Task 1.4: Create server config route

**Files created:**
- `apps/server/src/routes/config.ts`

**Steps:**

1. Create `apps/server/src/routes/config.ts` with the following content:

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

2. **Important:** The `resolveClaudeCliPath` function in `apps/server/src/services/agent-manager.ts` is currently a private (non-exported) function. You must export it. Change line 13 from:

```typescript
function resolveClaudeCliPath(): string | undefined {
```

to:

```typescript
export function resolveClaudeCliPath(): string | undefined {
```

**Acceptance criteria:**
- `apps/server/src/routes/config.ts` exists with GET `/` handler
- `resolveClaudeCliPath` is exported from `agent-manager.ts`
- Route returns JSON matching `ServerConfigSchema` shape

---

### Task 1.5: Register config route in app.ts

**Files modified:**
- `apps/server/src/app.ts`

**Steps:**

1. Add the import at the top of `apps/server/src/app.ts`, after the existing route imports:

```typescript
import configRoutes from './routes/config.js';
```

2. Add the route registration after the existing `/api/directory` line:

```typescript
app.use('/api/config', configRoutes);
```

The result should look like:

```typescript
// API routes
app.use('/api/sessions', sessionRoutes);
app.use('/api/commands', commandRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/directory', directoryRoutes);
app.use('/api/config', configRoutes);
```

**Acceptance criteria:**
- `GET /api/config` is accessible when the server runs
- `npx turbo build --filter=@lifeos/server` passes

---

### Task 1.6: Implement getConfig() in HttpTransport

**Files modified:**
- `apps/client/src/lib/http-transport.ts`

**Steps:**

1. Add `ServerConfig` to the type import at the top:

```typescript
import type {
  Session,
  CreateSessionRequest,
  UpdateSessionRequest,
  BrowseDirectoryResponse,
  CommandRegistry,
  HealthResponse,
  HistoryMessage,
  StreamEvent,
  TaskItem,
  ServerConfig,  // <-- add this
} from '@lifeos/shared/types';
```

2. Add the method to the `HttpTransport` class, after the `health()` method:

```typescript
getConfig(): Promise<ServerConfig> {
  return fetchJSON<ServerConfig>(this.baseUrl, '/config');
}
```

**Acceptance criteria:**
- `HttpTransport` implements `getConfig()` that calls `GET /api/config`
- `npx turbo typecheck` passes for `@lifeos/client`

---

### Task 1.7: Implement getConfig() in DirectTransport

**Files modified:**
- `apps/client/src/lib/direct-transport.ts`

**Steps:**

1. Add `ServerConfig` to the type import at the top:

```typescript
import type {
  StreamEvent,
  Session,
  CreateSessionRequest,
  UpdateSessionRequest,
  BrowseDirectoryResponse,
  HealthResponse,
  PermissionMode,
  HistoryMessage,
  CommandRegistry,
  TaskItem,
  ServerConfig,  // <-- add this
} from '@lifeos/shared/types';
```

2. Add the method to the `DirectTransport` class, after the `health()` method:

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

**Acceptance criteria:**
- `DirectTransport` implements `getConfig()` returning static mock values
- `npx turbo typecheck` passes for all packages
- `npx turbo build` passes

---

## Phase 2: UI

### Task 2.1: Add client settings state to app-store.ts

**Files modified:**
- `apps/client/src/stores/app-store.ts`

**Steps:**

1. Extend the `AppState` interface with new fields (add after the `toggleDevtools` line):

```typescript
showTimestamps: boolean;
setShowTimestamps: (v: boolean) => void;
expandToolCalls: boolean;
setExpandToolCalls: (v: boolean) => void;
verboseLogging: boolean;
setVerboseLogging: (v: boolean) => void;
fontSize: 'small' | 'medium' | 'large';
setFontSize: (v: 'small' | 'medium' | 'large') => void;
```

2. Add the implementations in the `create` callback, after the `toggleDevtools` implementation. Each setting reads its initial value from `localStorage` with `gateway-` prefix and writes on change:

```typescript
showTimestamps: (() => {
  try { return localStorage.getItem('gateway-show-timestamps') === 'true'; }
  catch { return false; }
})(),
setShowTimestamps: (v) => {
  try { localStorage.setItem('gateway-show-timestamps', String(v)); } catch {}
  set({ showTimestamps: v });
},

expandToolCalls: (() => {
  try { return localStorage.getItem('gateway-expand-tool-calls') === 'true'; }
  catch { return false; }
})(),
setExpandToolCalls: (v) => {
  try { localStorage.setItem('gateway-expand-tool-calls', String(v)); } catch {}
  set({ expandToolCalls: v });
},

verboseLogging: (() => {
  try { return localStorage.getItem('gateway-verbose-logging') === 'true'; }
  catch { return false; }
})(),
setVerboseLogging: (v) => {
  try { localStorage.setItem('gateway-verbose-logging', String(v)); } catch {}
  set({ verboseLogging: v });
},

fontSize: (() => {
  try {
    const stored = localStorage.getItem('gateway-font-size');
    if (stored === 'small' || stored === 'medium' || stored === 'large') return stored;
  } catch {}
  return 'medium';
})() as 'small' | 'medium' | 'large',
setFontSize: (v) => {
  try { localStorage.setItem('gateway-font-size', v); } catch {}
  const scaleMap = { small: '0.9', medium: '1', large: '1.15' };
  document.documentElement.style.setProperty('--user-font-scale', scaleMap[v]);
  set({ fontSize: v });
},
```

3. **Note:** The existing `devtoolsOpen` / `toggleDevtools` are reused directly in the settings dialog. The theme uses `useTheme()` hook, not app-store.

**Acceptance criteria:**
- All four new state fields (`showTimestamps`, `expandToolCalls`, `verboseLogging`, `fontSize`) are in the store
- Each field persists to/from `localStorage` with `gateway-` prefix
- `setFontSize` sets `--user-font-scale` CSS custom property on `document.documentElement`
- `npx turbo typecheck` passes

---

### Task 2.2: Wire font size CSS custom property in index.css

**Files modified:**
- `apps/client/src/index.css`

**Steps:**

1. In the `:root` block in `apps/client/src/index.css`, add the `--user-font-scale` custom property with default value `1`:

```css
:root {
  --mobile-scale: 1.25;
  --user-font-scale: 1;  /* <-- add this line */
  /* ... rest of existing properties ... */
}
```

2. Update the `--text-*` theme tokens in the `@theme inline` block to include the user font scale multiplier. Each `calc(...)` expression needs `* var(--user-font-scale, 1)` appended. For example:

```css
@theme inline {
  --text-3xs: calc(0.625rem * var(--_st) * var(--user-font-scale, 1));
  --text-2xs: calc(0.6875rem * var(--_st) * var(--user-font-scale, 1));
  --text-xs: calc(0.75rem * var(--_st) * var(--user-font-scale, 1));
  --text-sm: calc(0.875rem * var(--_st) * var(--user-font-scale, 1));
  --text-base: calc(1rem * var(--_st) * var(--user-font-scale, 1));
  --text-lg: calc(1.125rem * var(--_st) * var(--user-font-scale, 1));
  --text-xl: calc(1.25rem * var(--_st) * var(--user-font-scale, 1));
}
```

**Acceptance criteria:**
- `--user-font-scale` defaults to `1` in `:root`
- All `--text-*` tokens include `* var(--user-font-scale, 1)` in their `calc()` expressions
- Changing `--user-font-scale` via JS visibly changes text sizes

---

### Task 2.3: Create SettingsDialog.tsx

**Files created:**
- `apps/client/src/components/settings/SettingsDialog.tsx`

**Steps:**

1. Create directory `apps/client/src/components/settings/` if it does not exist.

2. Create `apps/client/src/components/settings/SettingsDialog.tsx` with the following structure:

```tsx
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/contexts/TransportContext';
import { useAppStore } from '@/stores/app-store';
import { useTheme } from '@/components/theme-provider';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { theme, setTheme } = useTheme();
  const {
    showTimestamps, setShowTimestamps,
    expandToolCalls, setExpandToolCalls,
    devtoolsOpen, toggleDevtools,
    verboseLogging, setVerboseLogging,
    fontSize, setFontSize,
  } = useAppStore();

  const transport = useTransport();
  const { data: config, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
    enabled: open,
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-w-lg p-0 gap-0">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Settings</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>

        <div className="overflow-y-auto flex-1 p-4 space-y-6">
          {/* Preferences Section */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground">Preferences</h3>

            {/* Theme */}
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Theme</Label>
                <p className="text-xs text-muted-foreground">Choose your preferred color scheme</p>
              </div>
              <Select value={theme} onValueChange={setTheme}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                  <SelectItem value="system">System</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Font Size */}
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Font size</Label>
                <p className="text-xs text-muted-foreground">Adjust the text size across the interface</p>
              </div>
              <Select value={fontSize} onValueChange={(v) => setFontSize(v as 'small' | 'medium' | 'large')}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="small">Small</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="large">Large</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Show timestamps */}
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Show timestamps</Label>
                <p className="text-xs text-muted-foreground">Display message timestamps in chat</p>
              </div>
              <Switch checked={showTimestamps} onCheckedChange={setShowTimestamps} />
            </div>

            {/* Expand tool calls */}
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Expand tool calls</Label>
                <p className="text-xs text-muted-foreground">Auto-expand tool call details in messages</p>
              </div>
              <Switch checked={expandToolCalls} onCheckedChange={setExpandToolCalls} />
            </div>

            {/* Show dev tools */}
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Show dev tools</Label>
                <p className="text-xs text-muted-foreground">Enable developer tools panel</p>
              </div>
              <Switch checked={devtoolsOpen} onCheckedChange={() => toggleDevtools()} />
            </div>

            {/* Verbose logging */}
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Verbose logging</Label>
                <p className="text-xs text-muted-foreground">Show detailed logs in the console</p>
              </div>
              <Switch checked={verboseLogging} onCheckedChange={setVerboseLogging} />
            </div>
          </div>

          <Separator />

          {/* Server Section */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Server</h3>

            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between py-1">
                    <span className="text-sm text-muted-foreground/50 animate-pulse">Loading...</span>
                  </div>
                ))}
              </div>
            ) : config ? (
              <div className="space-y-1">
                <ConfigRow label="Version" value={config.version} />
                <ConfigRow label="Port" value={String(config.port)} />
                <ConfigRow label="Uptime" value={formatUptime(config.uptime)} />
                <ConfigRow label="Working Directory" value={config.workingDirectory} mono truncate />
                <ConfigRow label="Node.js" value={config.nodeVersion} />
                <ConfigRow label="Claude CLI" value={config.claudeCliPath || 'Not found'} mono muted={!config.claudeCliPath} />

                <div className="flex items-center justify-between py-1">
                  <span className="text-sm text-muted-foreground">Tunnel</span>
                  <Badge variant={config.tunnel.enabled ? 'default' : 'secondary'}>
                    {config.tunnel.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                </div>

                {config.tunnel.enabled && (
                  <>
                    <div className="flex items-center justify-between py-1">
                      <span className="text-sm text-muted-foreground">Tunnel Status</span>
                      <Badge variant={config.tunnel.connected ? 'default' : 'secondary'}>
                        {config.tunnel.connected ? 'Connected' : 'Disconnected'}
                      </Badge>
                    </div>

                    {config.tunnel.url && (
                      <ConfigRow label="Tunnel URL" value={config.tunnel.url} mono />
                    )}

                    <ConfigRow label="Tunnel Auth" value={config.tunnel.authEnabled ? 'Enabled' : 'Disabled'} />

                    <div className="flex items-center justify-between py-1">
                      <span className="text-sm text-muted-foreground">ngrok Token</span>
                      <Badge variant={config.tunnel.tokenConfigured ? 'default' : 'secondary'}>
                        {config.tunnel.tokenConfigured ? 'Configured' : 'Not configured'}
                      </Badge>
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function ConfigRow({
  label,
  value,
  mono,
  truncate,
  muted,
}: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={`text-sm ${mono ? 'font-mono' : ''} ${truncate ? 'max-w-48 truncate' : ''} ${muted ? 'text-muted-foreground' : ''}`}
        title={truncate ? value : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}
```

3. This component depends on:
   - `ResponsiveDialog` from `@/components/ui/responsive-dialog` (existing)
   - `Switch`, `Label`, `Separator`, `Badge` (installed in Task 1.1)
   - `Select` (should already exist, verify)
   - `useTransport` from `@/contexts/TransportContext` (existing)
   - `useAppStore` (modified in Task 2.1)
   - `useTheme` (existing)

**Acceptance criteria:**
- Component renders a responsive dialog with "Settings" title
- Preferences section has 6 controls: Theme (select), Font size (select), 4 switches
- Server section fetches config via `useQuery` with 30s stale time, only when `open=true`
- Server section displays all fields per the display mapping table
- Sensitive values (ngrok token, tunnel auth) show badges, not raw values
- Loading state shows pulsing placeholder text
- Uptime formats as "2h 15m 30s"

---

### Task 2.4: Add gear icon to SessionSidebar.tsx footer

**Files modified:**
- `apps/client/src/components/sessions/SessionSidebar.tsx`

**Steps:**

1. Add imports at the top of the file:

```tsx
import { useState } from 'react';
import { Settings } from 'lucide-react';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
```

2. Add state inside the component function:

```tsx
const [settingsOpen, setSettingsOpen] = useState(false);
```

3. In the footer section, inside the `<div className="ml-auto flex items-center gap-0.5">` container, add the gear icon button as the **first child** (before the existing HoverCard relay button):

```tsx
<button
  onClick={() => setSettingsOpen(true)}
  className="p-1 max-md:p-2 rounded-md text-muted-foreground/50 hover:text-muted-foreground transition-colors duration-150"
  aria-label="Settings"
>
  <Settings className="size-(--size-icon-sm)" />
</button>
```

4. Render the `SettingsDialog` alongside the existing `<DirectoryPicker>` (at the end of the component return, inside the outermost fragment or div):

```tsx
<SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
```

**Acceptance criteria:**
- Gear icon appears as the first icon in the sidebar footer right-aligned button group
- Clicking the gear icon opens the SettingsDialog
- Closing the dialog resets the open state
- Icon uses `size-(--size-icon-sm)` for consistent scaling
- Button has `aria-label="Settings"` for accessibility

---

## Phase 3: Polish

### Task 3.1: Write SettingsDialog tests

**Files created:**
- `apps/client/src/components/settings/__tests__/SettingsDialog.test.tsx`

**Steps:**

1. Create `apps/client/src/components/settings/__tests__/SettingsDialog.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@lifeos/shared/transport';
import { TransportProvider } from '../../../contexts/TransportContext';
import { SettingsDialog } from '../SettingsDialog';

// Mock motion/react to render plain elements (existing pattern)
vi.mock('motion/react', () => ({
  motion: new Proxy({}, {
    get: (_target, prop) => {
      if (typeof prop === 'string') {
        return ({ children, ...props }: Record<string, unknown>) => {
          const Tag = prop as keyof JSX.IntrinsicElements;
          return <Tag {...props}>{children}</Tag>;
        };
      }
    },
  }),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MotionConfig: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(() => {
  cleanup();
});

const mockConfig = {
  version: '1.0.0',
  port: 6942,
  uptime: 8130, // 2h 15m 30s
  workingDirectory: '/home/user/project',
  nodeVersion: 'v20.11.0',
  claudeCliPath: '/usr/local/bin/claude',
  tunnel: {
    enabled: true,
    connected: true,
    url: 'https://abc123.ngrok.io',
    authEnabled: false,
    tokenConfigured: true,
  },
};

function createMockTransport(configOverrides?: Partial<typeof mockConfig>): Transport {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    getSession: vi.fn(),
    getMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    sendMessage: vi.fn(),
    approveTool: vi.fn(),
    denyTool: vi.fn(),
    submitAnswers: vi.fn().mockResolvedValue({ ok: true }),
    getCommands: vi.fn(),
    health: vi.fn(),
    updateSession: vi.fn(),
    browseDirectory: vi.fn().mockResolvedValue({ path: '/test', entries: [], parent: null }),
    getDefaultCwd: vi.fn().mockResolvedValue({ path: '/test/cwd' }),
    getConfig: vi.fn().mockResolvedValue({ ...mockConfig, ...configOverrides }),
  };
}

function createWrapper(transport?: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const t = transport || createMockTransport();
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={t}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('SettingsDialog', () => {
  // Verifies the dialog renders without crashing
  it('renders without error', () => {
    render(
      <SettingsDialog open={true} onOpenChange={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText('Settings')).toBeDefined();
  });

  // Verifies the dialog title is visible to users
  it('shows "Settings" title', () => {
    render(
      <SettingsDialog open={true} onOpenChange={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText('Settings')).toBeDefined();
  });

  // Verifies all six preference controls are present
  it('displays all preference controls', () => {
    render(
      <SettingsDialog open={true} onOpenChange={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText('Theme')).toBeDefined();
    expect(screen.getByText('Font size')).toBeDefined();
    expect(screen.getByText('Show timestamps')).toBeDefined();
    expect(screen.getByText('Expand tool calls')).toBeDefined();
    expect(screen.getByText('Show dev tools')).toBeDefined();
    expect(screen.getByText('Verbose logging')).toBeDefined();
  });

  // Verifies sensitive values show badges, not raw token values
  it('shows badges for sensitive values', async () => {
    const transport = createMockTransport();
    render(
      <SettingsDialog open={true} onOpenChange={vi.fn()} />,
      { wrapper: createWrapper(transport) },
    );
    // Wait for config to load
    const badge = await screen.findByText('Configured');
    expect(badge).toBeDefined();
  });

  // Verifies the dialog is not rendered when closed
  it('does not render content when closed', () => {
    render(
      <SettingsDialog open={false} onOpenChange={vi.fn()} />,
      { wrapper: createWrapper() },
    );
    expect(screen.queryByText('Settings')).toBeNull();
  });
});
```

2. The test file follows existing patterns from `PermissionBanner.test.tsx`:
   - Uses `@vitest-environment jsdom` directive
   - Creates `createMockTransport()` with all Transport methods mocked
   - Wraps components in `QueryClientProvider` and `TransportProvider`
   - Mocks `motion/react` for plain rendering

3. The `createMockTransport` must include `getConfig` in its return (in addition to all existing Transport methods).

**Acceptance criteria:**
- All tests pass: `npx vitest run apps/client/src/components/settings/__tests__/SettingsDialog.test.tsx`
- Tests cover: render, title display, all 6 preference controls, sensitive value badges, closed state
- `npx turbo test` passes with no regressions

---

## Dependency Graph

```
Task 1.1 (shadcn components)     ─┐
Task 1.2 (schema + types)        ─┤
Task 1.3 (transport interface)   ─┤─── Task 1.4 (server route)
                                   ├── Task 1.5 (register route) ← depends on 1.4
                                   ├── Task 1.6 (http transport) ← depends on 1.3
                                   └── Task 1.7 (direct transport) ← depends on 1.3

Task 2.1 (app store)             ← depends on none (P2 start)
Task 2.2 (CSS font scale)        ← depends on 2.1
Task 2.3 (SettingsDialog)        ← depends on 1.1, 1.2, 1.3, 1.6, 1.7, 2.1, 2.2
Task 2.4 (gear icon)             ← depends on 2.3

Task 3.1 (tests)                 ← depends on 2.3, 2.4
```

## Summary

| Task | Phase | Description |
|------|-------|-------------|
| 1.1 | P1 | Install shadcn/ui Switch, Label, Separator, Badge |
| 1.2 | P1 | Add ServerConfigSchema to schemas.ts and types.ts |
| 1.3 | P1 | Add getConfig() to Transport interface |
| 1.4 | P1 | Create server config route (config.ts) + export resolveClaudeCliPath |
| 1.5 | P1 | Register config route in app.ts |
| 1.6 | P1 | Implement getConfig() in HttpTransport |
| 1.7 | P1 | Implement getConfig() in DirectTransport |
| 2.1 | P2 | Add client settings state to app-store.ts |
| 2.2 | P2 | Wire --user-font-scale CSS custom property |
| 2.3 | P2 | Create SettingsDialog.tsx |
| 2.4 | P2 | Add gear icon to SessionSidebar.tsx |
| 3.1 | P3 | Write SettingsDialog tests |
