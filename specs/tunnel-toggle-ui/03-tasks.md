---
slug: tunnel-toggle-ui
number: 39
created: 2026-02-17
status: draft
lastDecompose: 2026-02-17
---

# Tasks: Tunnel Toggle UI

## Phase 1: Server API + Transport Layer

### Task 1.1: Create tunnel route with POST /start and /stop endpoints

Create `apps/server/src/routes/tunnel.ts` with two POST endpoints and register in `apps/server/src/app.ts`.

**Files to create/modify:**

- `apps/server/src/routes/tunnel.ts` (new)
- `apps/server/src/app.ts` (add route registration)

**Implementation:**

```typescript
// apps/server/src/routes/tunnel.ts
import { Router } from 'express';
import { tunnelManager } from '../services/tunnel-manager.js';
import { configManager } from '../services/config-manager.js';

const router = Router();

router.post('/start', async (_req, res) => {
  try {
    // Resolve auth token: env var first, then config fallback
    const authtoken = process.env.NGROK_AUTHTOKEN || configManager.get('tunnel')?.authtoken;
    if (!authtoken) {
      return res.status(400).json({ error: 'No ngrok auth token configured' });
    }

    const port = Number(process.env.TUNNEL_PORT) || Number(process.env.DORKOS_PORT) || 4242;
    const tunnelConfig = configManager.get('tunnel');
    const config = {
      port,
      authtoken,
      domain: tunnelConfig?.domain,
      basicAuth: tunnelConfig?.auth,
    };

    await tunnelManager.start(config);

    // Persist enabled state
    configManager.set('tunnel', { ...tunnelConfig, enabled: true });

    return res.json({ url: tunnelManager.status.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to start tunnel';
    return res.status(500).json({ error: message });
  }
});

router.post('/stop', async (_req, res) => {
  try {
    await tunnelManager.stop();

    // Persist disabled state
    const tunnelConfig = configManager.get('tunnel');
    configManager.set('tunnel', { ...tunnelConfig, enabled: false });

    return res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to stop tunnel';
    return res.status(500).json({ error: message });
  }
});

export default router;
```

**Route registration in `apps/server/src/app.ts`:**
Add after the existing git routes:

```typescript
import tunnelRoutes from './routes/tunnel.js';
// ...
app.use('/api/tunnel', tunnelRoutes);
```

**Acceptance criteria:**

- POST /api/tunnel/start returns 200 with `{ url }` when token is available
- POST /api/tunnel/start returns 400 when no auth token configured
- POST /api/tunnel/start returns 500 when tunnelManager.start() throws
- POST /api/tunnel/stop returns 200 with `{ ok: true }`
- POST /api/tunnel/stop returns 500 when tunnelManager.stop() throws
- Both endpoints persist enabled state via configManager

### Task 1.2: Write server route tests for tunnel endpoints

Create `apps/server/src/routes/__tests__/tunnel.test.ts` following the existing health.test.ts pattern.

**File to create:**

- `apps/server/src/routes/__tests__/tunnel.test.ts`

**Implementation:**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../services/transcript-reader.js', () => ({
  transcriptReader: {
    listSessions: vi.fn(),
    getSession: vi.fn(),
    readTranscript: vi.fn(),
    listTranscripts: vi.fn(),
  },
}));

vi.mock('../../services/agent-manager.js', () => ({
  agentManager: {
    ensureSession: vi.fn(),
    sendMessage: vi.fn(),
    approveTool: vi.fn(),
    hasSession: vi.fn(),
    checkSessionHealth: vi.fn(),
    getSdkSessionId: vi.fn(),
  },
}));

vi.mock('../../services/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('../../services/config-manager.js', () => ({
  configManager: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { tunnelManager } from '../../services/tunnel-manager.js';
import { configManager } from '../../services/config-manager.js';

const app = createApp();

describe('Tunnel Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NGROK_AUTHTOKEN;
    delete process.env.TUNNEL_PORT;
  });

  describe('POST /api/tunnel/start', () => {
    it('returns 200 with URL when token available and start succeeds', async () => {
      process.env.NGROK_AUTHTOKEN = 'test-token';
      vi.mocked(tunnelManager.start).mockResolvedValue('https://test.ngrok.io');
      Object.defineProperty(tunnelManager, 'status', {
        get: () => ({
          enabled: true,
          connected: true,
          url: 'https://test.ngrok.io',
          port: 4242,
          startedAt: new Date().toISOString(),
        }),
        configurable: true,
      });

      const res = await request(app).post('/api/tunnel/start');
      expect(res.status).toBe(200);
      expect(res.body.url).toBe('https://test.ngrok.io');
    });

    it('returns 400 when no auth token configured', async () => {
      vi.mocked(configManager.get).mockReturnValue(undefined);

      const res = await request(app).post('/api/tunnel/start');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No ngrok auth token configured');
    });

    it('returns 500 when tunnelManager.start() throws', async () => {
      process.env.NGROK_AUTHTOKEN = 'test-token';
      vi.mocked(tunnelManager.start).mockRejectedValue(new Error('Connection failed'));

      const res = await request(app).post('/api/tunnel/start');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Connection failed');
    });

    it('persists tunnel.enabled: true in config', async () => {
      process.env.NGROK_AUTHTOKEN = 'test-token';
      vi.mocked(tunnelManager.start).mockResolvedValue('https://test.ngrok.io');
      vi.mocked(configManager.get).mockReturnValue({ enabled: false });
      Object.defineProperty(tunnelManager, 'status', {
        get: () => ({
          enabled: true,
          connected: true,
          url: 'https://test.ngrok.io',
          port: 4242,
          startedAt: new Date().toISOString(),
        }),
        configurable: true,
      });

      await request(app).post('/api/tunnel/start');
      expect(configManager.set).toHaveBeenCalledWith(
        'tunnel',
        expect.objectContaining({ enabled: true })
      );
    });
  });

  describe('POST /api/tunnel/stop', () => {
    it('returns 200 when stop succeeds', async () => {
      vi.mocked(tunnelManager.stop).mockResolvedValue(undefined);

      const res = await request(app).post('/api/tunnel/stop');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('persists tunnel.enabled: false in config', async () => {
      vi.mocked(tunnelManager.stop).mockResolvedValue(undefined);
      vi.mocked(configManager.get).mockReturnValue({ enabled: true });

      await request(app).post('/api/tunnel/stop');
      expect(configManager.set).toHaveBeenCalledWith(
        'tunnel',
        expect.objectContaining({ enabled: false })
      );
    });

    it('returns 500 when tunnelManager.stop() throws', async () => {
      vi.mocked(tunnelManager.stop).mockRejectedValue(new Error('Stop failed'));

      const res = await request(app).post('/api/tunnel/stop');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Stop failed');
    });
  });
});
```

**Acceptance criteria:**

- All 7 test cases pass
- Tests follow existing health.test.ts mocking pattern
- Tests mock tunnelManager and configManager

### Task 1.3: Add startTunnel/stopTunnel to Transport interface and all adapters

Extend the Transport interface and implement in HttpTransport, DirectTransport, and mock transport.

**Files to modify:**

- `packages/shared/src/transport.ts`
- `apps/client/src/layers/shared/lib/http-transport.ts`
- `apps/client/src/layers/shared/lib/direct-transport.ts`
- `packages/test-utils/src/mock-factories.ts`
- `packages/test-utils/src/index.ts` (if needed)

**Transport interface additions (`packages/shared/src/transport.ts`):**

Add before the closing `}` of the interface:

```typescript
/** Start the ngrok tunnel. Returns the public URL on success. */
startTunnel(): Promise<{ url: string }>;
/** Stop the ngrok tunnel. */
stopTunnel(): Promise<void>;
```

**HttpTransport implementation (`apps/client/src/layers/shared/lib/http-transport.ts`):**

Add these methods to the class:

```typescript
async startTunnel(): Promise<{ url: string }> {
  return fetchJSON<{ url: string }>(this.baseUrl, '/tunnel/start', { method: 'POST' });
}

async stopTunnel(): Promise<void> {
  await fetchJSON(this.baseUrl, '/tunnel/stop', { method: 'POST' });
}
```

**DirectTransport implementation (`apps/client/src/layers/shared/lib/direct-transport.ts`):**

Add these methods to the class:

```typescript
async startTunnel(): Promise<{ url: string }> {
  throw new Error('Tunnel control is not available in embedded mode');
}

async stopTunnel(): Promise<void> {
  throw new Error('Tunnel control is not available in embedded mode');
}
```

**Mock transport update (`packages/test-utils/src/mock-factories.ts`):**

Add a new factory function:

```typescript
import type { Transport } from '@dorkos/shared/transport';

export function createMockTransport(overrides: Partial<Transport> = {}): Transport {
  return {
    createSession: vi.fn(),
    listSessions: vi.fn(),
    getSession: vi.fn(),
    updateSession: vi.fn(),
    getMessages: vi.fn(),
    sendMessage: vi.fn(),
    approveTool: vi.fn(),
    denyTool: vi.fn(),
    submitAnswers: vi.fn(),
    getTasks: vi.fn(),
    browseDirectory: vi.fn(),
    getDefaultCwd: vi.fn(),
    getCommands: vi.fn(),
    listFiles: vi.fn(),
    getGitStatus: vi.fn(),
    health: vi.fn(),
    getConfig: vi.fn(),
    startTunnel: vi.fn(),
    stopTunnel: vi.fn(),
    ...overrides,
  };
}
```

Note: If `createMockTransport` doesn't already exist in mock-factories.ts, create it. If it exists elsewhere, add the two new methods to it.

**Acceptance criteria:**

- Transport interface has `startTunnel()` and `stopTunnel()` methods
- HttpTransport calls POST /tunnel/start and /tunnel/stop
- DirectTransport throws "not available in embedded mode" errors
- Mock transport has vi.fn() stubs for both methods
- `npm run typecheck` passes with no errors

## Phase 2: Client UI Components

### Task 2.1: Add showStatusBarTunnel preference to app-store

Add the `showStatusBarTunnel` boolean preference to the Zustand store following the existing pattern.

**File to modify:**

- `apps/client/src/layers/shared/model/app-store.ts`

**Changes:**

1. Add to `AppState` interface:

```typescript
showStatusBarTunnel: boolean;
setShowStatusBarTunnel: (v: boolean) => void;
```

2. Add to `BOOL_KEYS`:

```typescript
showStatusBarTunnel: 'dorkos-show-status-bar-tunnel',
```

3. Add to `BOOL_DEFAULTS`:

```typescript
showStatusBarTunnel: true,
```

4. Add the state/setter pair inside `create()`:

```typescript
showStatusBarTunnel: readBool(BOOL_KEYS.showStatusBarTunnel, true),
setShowStatusBarTunnel: (v) => {
  writeBool(BOOL_KEYS.showStatusBarTunnel, v);
  set({ showStatusBarTunnel: v });
},
```

**Acceptance criteria:**

- `showStatusBarTunnel` defaults to `true`
- Persists to localStorage under `dorkos-show-status-bar-tunnel`
- Follows the exact same pattern as `showStatusBarVersion`, `showStatusBarSound`, etc.
- TypeScript compiles without errors

### Task 2.2: Install react-qr-code and create TunnelDialog component

Install the `react-qr-code` dependency and create the TunnelDialog component.

**Dependency:**

- `npm install react-qr-code -w apps/client`

**File to create:**

- `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx`

**Implementation:**

```typescript
import { useState, useEffect, useCallback } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import QRCode from 'react-qr-code';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Switch,
  Input,
  Button,
} from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';
import { cn, TIMING } from '@/layers/shared/lib';

type TunnelState = 'off' | 'starting' | 'connected' | 'stopping' | 'error';

const START_TIMEOUT_MS = 15_000;

interface TunnelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TunnelDialog({ open, onOpenChange }: TunnelDialogProps) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { data: serverConfig } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 5 * 60 * 1000,
  });

  const tunnel = serverConfig?.tunnel;
  const [state, setState] = useState<TunnelState>('off');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState('');
  const [copied, setCopied] = useState(false);

  // Sync state from server config
  useEffect(() => {
    if (tunnel?.connected && tunnel?.url) {
      setState('connected');
      setUrl(tunnel.url);
    } else if (state !== 'starting' && state !== 'stopping') {
      setState('off');
      setUrl(null);
    }
  }, [tunnel?.connected, tunnel?.url]);

  const handleToggle = useCallback(async (checked: boolean) => {
    if (checked) {
      // Start — pessimistic UI
      setState('starting');
      setError(null);
      const timeout = setTimeout(() => {
        setState('error');
        setError('Connection timed out after 15 seconds');
      }, START_TIMEOUT_MS);

      try {
        const result = await transport.startTunnel();
        clearTimeout(timeout);
        setState('connected');
        setUrl(result.url);
        queryClient.invalidateQueries({ queryKey: ['config'] });
      } catch (err) {
        clearTimeout(timeout);
        setState('error');
        setError(err instanceof Error ? err.message : 'Failed to start tunnel');
      }
    } else {
      // Stop — optimistic UI
      setState('off');
      setUrl(null);
      setError(null);
      try {
        await transport.stopTunnel();
        queryClient.invalidateQueries({ queryKey: ['config'] });
      } catch (err) {
        setState('error');
        setError(err instanceof Error ? err.message : 'Failed to stop tunnel');
      }
    }
  }, [transport, queryClient]);

  const handleSaveToken = useCallback(async () => {
    // PATCH /api/config with tunnel authtoken
    try {
      await fetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tunnel: { authtoken: authToken } }),
      });
      setAuthToken('');
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch {}
  }, [authToken, queryClient]);

  const handleCopyUrl = useCallback(() => {
    if (url) {
      navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), TIMING.COPY_FEEDBACK_MS);
    }
  }, [url]);

  const isTransitioning = state === 'starting' || state === 'stopping';
  const isChecked = state === 'connected' || state === 'starting';

  // Status dot color
  const dotColor = {
    off: 'bg-gray-400',
    starting: 'bg-amber-400',
    connected: 'bg-green-500',
    stopping: 'bg-gray-400',
    error: 'bg-red-500',
  }[state];

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-w-sm">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2 text-sm font-medium">
            <span className={cn('inline-block size-2 rounded-full', dotColor, state === 'starting' && 'animate-pulse')} />
            Tunnel
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>

        <div className="space-y-4 px-4 pb-4">
          {/* Toggle row */}
          <div className="flex items-center justify-between">
            <span className="text-sm">Enable tunnel</span>
            <Switch
              checked={isChecked}
              onCheckedChange={handleToggle}
              disabled={isTransitioning}
            />
          </div>

          {/* Auth token section */}
          {tunnel && !tunnel.tokenConfigured && state !== 'connected' && (
            <div className="space-y-2">
              <p className="text-muted-foreground text-xs">Enter your ngrok auth token to connect.</p>
              <div className="flex gap-2">
                <Input
                  type="password"
                  placeholder="ngrok auth token"
                  value={authToken}
                  onChange={(e) => setAuthToken(e.target.value)}
                  className="text-sm"
                />
                <Button size="sm" onClick={handleSaveToken} disabled={!authToken.trim()}>
                  Save
                </Button>
              </div>
            </div>
          )}

          {/* Connected section with URL + QR */}
          {state === 'connected' && url && (
            <div className="space-y-3">
              <button
                onClick={handleCopyUrl}
                className="text-muted-foreground hover:text-foreground w-full truncate text-left font-mono text-xs transition-colors"
                title="Click to copy"
              >
                {copied ? 'Copied!' : url}
              </button>
              <div className="flex justify-center rounded-lg bg-white p-3">
                <QRCode value={url} size={200} level="M" />
              </div>
              <p className="text-muted-foreground text-center text-xs">Scan to open on mobile</p>
            </div>
          )}

          {/* Error section */}
          {state === 'error' && error && (
            <div className="space-y-2">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setState('off'); setError(null); }}
              >
                Try again
              </Button>
            </div>
          )}
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
```

**Acceptance criteria:**

- Dialog shows toggle switch reflecting current tunnel state
- Shows auth token input when `tokenConfigured` is false
- Shows QR code and URL when connected
- Switch is disabled during starting/stopping transitions
- Error state shows message with "Try again" button
- Start uses pessimistic UI with 15s timeout
- Stop uses optimistic UI

### Task 2.3: Create TunnelItem status bar widget

Create the status bar widget following the NotificationSoundItem pattern.

**File to create:**

- `apps/client/src/layers/features/status/ui/TunnelItem.tsx`

**Implementation:**

```typescript
import { useState } from 'react';
import { Globe } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { TunnelDialog } from '@/layers/features/settings';
import type { ServerConfig } from '@dorkos/shared/types';

interface TunnelItemProps {
  tunnel: ServerConfig['tunnel'];
}

export function TunnelItem({ tunnel }: TunnelItemProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const dotColor = tunnel.connected ? 'bg-green-500' : 'bg-gray-400';
  const hostname = tunnel.url ? new URL(tunnel.url).hostname : null;

  return (
    <>
      <button
        onClick={() => setDialogOpen(true)}
        className="hover:text-foreground inline-flex items-center gap-1 transition-colors duration-150"
        aria-label={tunnel.connected ? `Tunnel connected: ${hostname}` : 'Tunnel disconnected'}
        title={tunnel.connected ? `Tunnel: ${tunnel.url}` : 'Tunnel: disconnected'}
      >
        <span className={cn('inline-block size-1.5 rounded-full', dotColor)} />
        <Globe className="size-(--size-icon-xs)" />
        {tunnel.connected && hostname && (
          <span className="max-w-24 truncate">{hostname}</span>
        )}
        {!tunnel.connected && <span>Tunnel</span>}
      </button>
      <TunnelDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
```

**Acceptance criteria:**

- Renders green dot and hostname when connected
- Renders gray dot and "Tunnel" text when disconnected
- Opens TunnelDialog on click
- Uses Globe icon from lucide-react
- Follows NotificationSoundItem styling pattern

### Task 2.4: Integrate TunnelItem into StatusLine and update settings

Wire up the TunnelItem in StatusLine, update ServerTab with "Manage" button, add tunnel toggle to Settings Status Bar tab, and update barrel exports.

**Files to modify:**

- `apps/client/src/layers/features/status/ui/StatusLine.tsx`
- `apps/client/src/layers/features/status/index.ts`
- `apps/client/src/layers/features/settings/ui/ServerTab.tsx`
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx`
- `apps/client/src/layers/features/settings/index.ts`

**StatusLine.tsx changes:**

Import and add TunnelItem:

```typescript
import { TunnelItem } from './TunnelItem';
```

In the `useAppStore()` destructure, add `showStatusBarTunnel`.

Add this entry in the entries array (before the version entry):

```typescript
if (showStatusBarTunnel && serverConfig?.tunnel) {
  entries.push({
    key: 'tunnel',
    node: <TunnelItem tunnel={serverConfig.tunnel} />,
  });
}
```

**Status barrel export (`apps/client/src/layers/features/status/index.ts`):**

```typescript
export { TunnelItem } from './ui/TunnelItem';
```

**ServerTab.tsx changes:**

Add `onOpenTunnelDialog` prop and replace the read-only tunnel ConfigBadgeRow block (lines ~64-93) with a single "Manage" button row:

```typescript
interface ServerTabProps {
  config: ServerConfig | undefined;
  isLoading: boolean;
  onOpenTunnelDialog?: () => void;
}

// Replace the tunnel ConfigBadgeRow block with:
<div className="flex items-center justify-between py-1 -mx-1 px-1">
  <span className="text-muted-foreground text-sm">Tunnel</span>
  <Button variant="outline" size="sm" onClick={onOpenTunnelDialog}>
    Manage
  </Button>
</div>
```

**SettingsDialog.tsx changes:**

1. Add state: `const [tunnelDialogOpen, setTunnelDialogOpen] = useState(false);`
2. Add to useAppStore destructure: `showStatusBarTunnel, setShowStatusBarTunnel`
3. Pass to ServerTab: `onOpenTunnelDialog={() => setTunnelDialogOpen(true)}`
4. Render TunnelDialog: `<TunnelDialog open={tunnelDialogOpen} onOpenChange={setTunnelDialogOpen} />`
5. Add to Status Bar tab content:

```typescript
<SettingRow label="Show tunnel" description="Display tunnel status and control">
  <Switch checked={showStatusBarTunnel} onCheckedChange={setShowStatusBarTunnel} />
</SettingRow>
```

**Settings barrel export (`apps/client/src/layers/features/settings/index.ts`):**

```typescript
export { TunnelDialog } from './ui/TunnelDialog';
```

**Acceptance criteria:**

- TunnelItem appears in status bar when `showStatusBarTunnel` is true and tunnel config exists
- ServerTab shows "Manage" button that opens TunnelDialog
- Settings Status Bar tab has toggle for tunnel visibility
- TunnelDialog is accessible from both status bar and settings
- All barrel exports are updated
- TypeScript compiles, ESLint passes

## Phase 3: Testing + Polish

### Task 3.1: Write client component tests for TunnelDialog and TunnelItem

Create tests for both new UI components.

**Files to create:**

- `apps/client/src/layers/features/settings/__tests__/TunnelDialog.test.tsx`
- `apps/client/src/layers/features/status/__tests__/TunnelItem.test.tsx`

**TunnelDialog tests:**

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { TunnelDialog } from '../ui/TunnelDialog';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function createWrapper(transport = createMockTransport()) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          {children}
        </TransportProvider>
      </QueryClientProvider>
    );
  };
}

describe('TunnelDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
  });

  it('renders toggle switch', () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({
      version: '1.0.0', latestVersion: null, port: 4242, uptime: 0,
      workingDirectory: '/tmp', nodeVersion: 'v20.0.0', claudeCliPath: null,
      tunnel: { enabled: false, connected: false, url: null, authEnabled: false, tokenConfigured: true },
    });

    render(<TunnelDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper(transport) });
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });

  it('shows auth token input when tokenConfigured is false', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({
      version: '1.0.0', latestVersion: null, port: 4242, uptime: 0,
      workingDirectory: '/tmp', nodeVersion: 'v20.0.0', claudeCliPath: null,
      tunnel: { enabled: false, connected: false, url: null, authEnabled: false, tokenConfigured: false },
    });

    render(<TunnelDialog open={true} onOpenChange={vi.fn()} />, { wrapper: createWrapper(transport) });
    // Wait for query to resolve, then check for token input
  });

  it('disables switch during starting state', () => {
    // Verify switch is disabled when state is transitioning
  });
});
```

**TunnelItem tests:**

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { TunnelItem } from '../ui/TunnelItem';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={createMockTransport()}>
        {children}
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('TunnelItem', () => {
  it('renders green dot and hostname when connected', () => {
    render(
      <TunnelItem tunnel={{ enabled: true, connected: true, url: 'https://abc123.ngrok-free.app', authEnabled: false, tokenConfigured: true }} />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText('abc123.ngrok-free.app')).toBeInTheDocument();
  });

  it('renders gray dot when disconnected', () => {
    render(
      <TunnelItem tunnel={{ enabled: false, connected: false, url: null, authEnabled: false, tokenConfigured: true }} />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText('Tunnel')).toBeInTheDocument();
  });

  it('opens dialog on click', async () => {
    const user = userEvent.setup();
    render(
      <TunnelItem tunnel={{ enabled: false, connected: false, url: null, authEnabled: false, tokenConfigured: true }} />,
      { wrapper: Wrapper }
    );
    await user.click(screen.getByRole('button'));
    // Dialog should be open — check for "Enable tunnel" text
    expect(screen.getByText('Enable tunnel')).toBeInTheDocument();
  });
});
```

**Acceptance criteria:**

- TunnelDialog tests verify: toggle renders, auth input appears when needed, switch disables during transition
- TunnelItem tests verify: connected state, disconnected state, dialog opens on click
- All tests pass with `npx vitest run`

### Task 3.2: Verify typecheck, lint, and build pass

Run full verification suite to ensure everything integrates cleanly.

**Commands to run:**

```bash
npm run typecheck
npm run lint
npm run build
npm test -- --run
```

**Acceptance criteria:**

- `npm run typecheck` passes with zero errors
- `npm run lint` passes (warnings ok, no errors)
- `npm run build` succeeds for all apps
- `npm test -- --run` passes all existing + new tests
