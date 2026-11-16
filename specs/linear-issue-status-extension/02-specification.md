---
slug: linear-issue-status-extension
number: 192
created: 2026-03-29
status: draft
---

# Server-Side Extension Hooks + Linear Issue Status Extension

**Status:** Draft
**Authors:** Claude Code, 2026-03-29
**Spec:** #192
**Ideation:** `specs/linear-issue-status-extension/01-ideation.md`

---

## Overview

Enhance the DorkOS extension system with server-side capabilities — enabling extensions to securely call external APIs, store encrypted secrets, run background tasks, and push real-time updates to the browser. Then validate the platform by building a Linear issue status extension as the first consumer.

This delivers the "v2" deferred items from ADR 203 (secrets, permissions) and establishes the three-tier extension capability model: declarative proxy, data provider, and background tasks.

---

## Background / Problem Statement

DorkOS extensions are browser-only. They can register React components, commands, and dialogs, but they cannot:

1. **Call external APIs securely** — No way to hold API keys without exposing them to the browser (CORS issues, credential leakage via devtools)
2. **Run server-side logic** — No data transformation, aggregation, or multi-API orchestration
3. **Store secrets** — `loadData()`/`saveData()` stores plaintext JSON, unsuitable for API keys
4. **Run background tasks** — No periodic fetching, no push updates

This limits extensions to static UI and local-only state. Any extension that needs external data (Linear issues, GitHub PRs, Slack status, metrics dashboards) is impossible to build.

### Why Now

The extension system (Phases 1-4) is implemented and stable. ADR 203 explicitly deferred `secrets` and `transport` to v2. The Linear integration is a concrete, high-value use case that exercises all three capability tiers.

---

## Goals

- Extensions can declare and use server-side data providers (`server.ts`)
- Extensions can store encrypted secrets that never reach the browser
- Extensions can auto-proxy external APIs with zero server code (declarative manifest)
- Extensions can run recurring background tasks and push SSE events
- A reference Linear extension validates all three tiers
- Existing browser-only extensions continue to work unchanged
- Agent-authored extensions (via MCP tools) support server-side capabilities

## Non-Goals

- Worker thread isolation for server-side extension code (v2 — see ADR 204)
- OS keychain integration (v2 — file-based AES-256-GCM is sufficient for single-user)
- OAuth flow handling (personal API tokens only for now)
- Real-time Linear webhooks (polling with SSE push, not inbound webhooks)
- Extension marketplace or distribution system
- Multi-tenancy or per-user secret scoping
- Extension-to-extension communication

---

## Technical Dependencies

- **Node.js crypto** — `createCipheriv`, `createDecipheriv`, `scryptSync`, `randomBytes` (built-in)
- **esbuild** — Already used for client-side extension compilation; add Node.js target
- **Express Router** — Already used for all server routes
- **Linear GraphQL API** — `https://api.linear.app/graphql` (Bearer token auth)
- **TanStack Query** — Client-side data fetching (existing pattern)

No new npm packages required.

---

## Detailed Design

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Extension Directory (~/.dork/extensions/linear-issues/)     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ extension.json│  │  index.ts    │  │   server.ts      │  │
│  │ (manifest)    │  │ (browser)    │  │ (Node.js)        │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────────┘  │
└─────────┼─────────────────┼─────────────────┼───────────────┘
          │                 │                 │
          ▼                 ▼                 ▼
┌─────────────────┐  ┌──────────┐    ┌────────────────────┐
│ Extension       │  │ Browser  │    │ Server Process     │
│ Discovery       │──│ Bundle   │    │ (in-process)       │
│ (parse manifest,│  │ (esbuild │    │                    │
│  detect server) │  │  browser)│    │ ┌────────────────┐ │
└─────────────────┘  └────┬─────┘    │ │ Server Bundle  │ │
                          │          │ │ (esbuild node) │ │
                          ▼          │ └────────┬───────┘ │
                   ┌──────────────┐  │          │         │
                   │ activate(api)│  │          ▼         │
                   │ registers:   │  │ ┌────────────────┐ │
                   │ • components │  │ │register(router, │ │
                   │ • commands   │  │ │   ctx)          │ │
                   │ • settings   │  │ │ mounts:         │ │
                   └──────┬───────┘  │ │ /api/ext/{id}/* │ │
                          │          │ └────────┬───────┘ │
                          │          │          │         │
                   fetch('/api/ext/  │    ┌─────┴──────┐  │
                    {id}/issues')────┼───▶│ ctx.secrets │  │
                                    │    │ ctx.storage │  │
                                    │    │ ctx.schedule│  │
                                    │    │ ctx.emit    │  │
                                    │    └────────────┘  │
                                    └────────────────────┘
```

### Part 1: Manifest Schema Changes

Extend `ExtensionManifestSchema` in `packages/extension-api/src/manifest-schema.ts`:

```typescript
const SecretDeclarationSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().default(false),
});

const DataProxySchema = z.object({
  baseUrl: z.string().url(),
  authHeader: z.string().default('Authorization'),
  authType: z.enum(['Bearer', 'Basic', 'Token', 'Custom']).default('Bearer'),
  authSecret: z.string(), // key name in extension's secret store
  pathRewrite: z.record(z.string(), z.string()).optional(),
});

const ServerCapabilitiesSchema = z.object({
  serverEntry: z.string().default('./server.ts'),
  externalHosts: z.array(z.string().url()).optional(),
  secrets: z.array(SecretDeclarationSchema).optional(),
});

// Add to ExtensionManifestSchema
export const ExtensionManifestSchema = z.object({
  // ... existing fields unchanged ...
  serverCapabilities: ServerCapabilitiesSchema.optional(),
  dataProxy: DataProxySchema.optional(),
});
```

**Export types:**

```typescript
export type SecretDeclaration = z.infer<typeof SecretDeclarationSchema>;
export type DataProxyConfig = z.infer<typeof DataProxySchema>;
export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;
```

### Part 2: Server Extension API Types

New file: `packages/extension-api/src/server-extension-api.ts`

```typescript
import type { Router } from 'express';

/** Encrypted per-extension secret store */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
}

/** Context injected into server-side extension code */
export interface DataProviderContext {
  /** Extension-scoped secret store (encrypted at rest) */
  readonly secrets: SecretStore;

  /** Extension's persistent data store */
  readonly storage: {
    loadData<T = unknown>(): Promise<T | null>;
    saveData<T = unknown>(data: T): Promise<void>;
  };

  /**
   * Schedule a recurring task.
   * @param intervalSeconds - Interval in seconds (minimum 5). Cron strings deferred to v2.
   * @param fn - Async function to execute on each tick
   * @returns Cleanup function to cancel the schedule
   */
  schedule(intervalSeconds: number, fn: () => Promise<void>): () => void;

  /**
   * Emit an SSE event to all connected browser clients for this extension.
   * @param event - Event name (scoped to this extension)
   * @param data - JSON-serializable payload
   */
  emit(event: string, data: unknown): void;

  /** Extension's unique identifier */
  readonly extensionId: string;

  /** Absolute path to the extension's directory */
  readonly extensionDir: string;
}

/**
 * Server-side extension entry point.
 * The extension's `server.ts` must export this as default.
 */
export type ServerExtensionRegister = (
  router: Router,
  ctx: DataProviderContext
) => void | (() => void) | Promise<void | (() => void)>;
```

Update `packages/extension-api/package.json` exports:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./server": "./src/server-extension-api.ts"
  }
}
```

### Part 3: Encrypted Secrets Store

New file: `packages/shared/src/extension-secrets.ts`

**Encryption scheme:** AES-256-GCM with a host-managed key.

- **Host key**: Random 32 bytes generated on first access, stored at `{dorkHome}/host.key` with `0600` permissions.
- **Per-extension file**: `{dorkHome}/extension-secrets/{ext-id}.json` contains `{ [key]: encryptedBase64 }`.
- **Encryption format**: `base64(IV[16] || AuthTag[16] || Ciphertext)`.

```typescript
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT = 'dorkos-ext-secrets'; // static salt; host.key is the entropy

export class ExtensionSecretStore implements SecretStore {
  private cache: Record<string, string> | null = null;

  constructor(
    private readonly extensionId: string,
    private readonly dorkHome: string
  ) {}

  // ... implement get, set, delete, has using encrypt/decrypt helpers
  // ... lazy-load host key and secrets file
  // ... write-through: update file on every set/delete
}
```

**Host key lifecycle:**

1. On first `get()`/`set()` call, check if `{dorkHome}/host.key` exists
2. If not, generate 32 random bytes, write with `mode: 0o600`
3. Derive encryption key: `scryptSync(hostKey, SALT, KEY_LENGTH)`
4. Cache derived key in memory for the process lifetime

### Part 4: Extension Discovery Changes

In `apps/server/src/services/extensions/extension-discovery.ts`:

Add `hasServerEntry: boolean` and `hasDataProxy: boolean` to the `ExtensionRecord` interface:

```typescript
// In readExtension() after parsing manifest:
const serverEntryPath = serverCapabilities?.serverEntry ?? './server.ts';
const resolvedServerEntry = join(extDir, serverEntryPath);
const hasServerEntry = await fileExists(resolvedServerEntry);
const hasDataProxy = !!manifest.dataProxy;

return {
  ...existingFields,
  hasServerEntry,
  hasDataProxy,
  serverEntryPath: hasServerEntry ? resolvedServerEntry : undefined,
};
```

### Part 5: Extension Compiler Changes

In `apps/server/src/services/extensions/extension-compiler.ts`:

Add a `compileServer()` method alongside the existing `compile()`:

```typescript
async compileServer(record: ExtensionRecord): Promise<CompileResult> {
  if (!record.serverEntryPath) {
    return { error: 'No server entry point found' };
  }

  const source = await readFile(record.serverEntryPath, 'utf-8');
  const sourceHash = contentHash(source);
  const cachePath = join(this.cacheDir, 'server', `${record.id}.${sourceHash}.js`);

  // Check cache
  if (await fileExists(cachePath)) {
    return { code: await readFile(cachePath, 'utf-8'), sourceHash };
  }

  const result = await esbuild.build({
    entryPoints: [record.serverEntryPath],
    bundle: true,
    write: false,
    format: 'cjs', // CommonJS for dynamic require()
    platform: 'node',
    target: 'node20',
    external: ['express', '@dorkos/extension-api', '@dorkos/extension-api/server'],
    sourcemap: 'inline',
  });

  const code = result.outputFiles[0].text;
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, code);
  return { code, sourceHash };
}
```

**Key difference from client compilation:**

- `platform: 'node'` (not browser)
- `target: 'node20'`
- `format: 'cjs'` (for `require()` dynamic loading)
- `external: ['express', ...]` (provided by host)

### Part 6: Extension Manager — Server Lifecycle

In `apps/server/src/services/extensions/extension-manager.ts`:

Add server extension tracking and lifecycle:

```typescript
interface ActiveServerExtension {
  extensionId: string;
  router: Router;
  cleanup: (() => void) | null;
  scheduledTasks: Array<() => void>;
}

class ExtensionManager {
  private serverExtensions = new Map<string, ActiveServerExtension>();

  async initializeServer(id: string): Promise<{ ok: boolean; error?: string }> {
    const record = this.extensions.get(id);
    if (!record?.hasServerEntry || !record.enabled) {
      return { ok: false, error: 'Extension has no server entry or is disabled' };
    }

    // Compile server bundle
    const compiled = await this.compiler.compileServer(record);
    if ('error' in compiled) {
      return { ok: false, error: compiled.error };
    }

    // Load module
    const tempFile = join(this.cacheDir, `_run_${id}.js`);
    await writeFile(tempFile, compiled.code);
    const mod = require(tempFile);
    const registerFn = mod.default ?? mod;

    // Build context
    const router = Router();
    const ctx = createDataProviderContext(id, record.dir, this.dorkHome);

    // Call register
    const cleanup = await registerFn(router, ctx);

    this.serverExtensions.set(id, {
      extensionId: id,
      router,
      cleanup: typeof cleanup === 'function' ? cleanup : null,
      scheduledTasks: ctx._getScheduledCleanups(),
    });

    return { ok: true };
  }

  async shutdownServer(id: string): Promise<void> {
    const active = this.serverExtensions.get(id);
    if (!active) return;

    // Cancel scheduled tasks
    for (const cancel of active.scheduledTasks) cancel();

    // Call extension cleanup
    if (active.cleanup) active.cleanup();

    this.serverExtensions.delete(id);
  }

  getServerRouter(id: string): Router | null {
    return this.serverExtensions.get(id)?.router ?? null;
  }
}
```

**Lifecycle coordination:**

- `enable(id)` → compile client + compile server → `initializeServer(id)`
- `disable(id)` → `shutdownServer(id)` → existing client disable
- `reload(id)` → `shutdownServer(id)` → recompile → `initializeServer(id)` → client reload
- Server startup → for each enabled extension with `hasServerEntry`, call `initializeServer(id)`

### Part 7: DataProviderContext Factory

New file: `apps/server/src/services/extensions/extension-server-api-factory.ts`

```typescript
import { Router } from 'express';
import { EventEmitter } from 'node:events';
import type { DataProviderContext } from '@dorkos/extension-api/server';
import { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';

interface ServerAPIFactoryDeps {
  extensionId: string;
  extensionDir: string;
  dorkHome: string;
  getCwd: () => string | null;
  eventBus: EventEmitter; // shared SSE bus
}

export function createDataProviderContext(
  deps: ServerAPIFactoryDeps
): DataProviderContext & { _getScheduledCleanups(): Array<() => void> } {
  const scheduledCleanups: Array<() => void> = [];

  const secrets = new ExtensionSecretStore(deps.extensionId, deps.dorkHome);

  const storage = {
    async loadData<T>(): Promise<T | null> {
      // Read from {dorkHome}/extension-data/{id}/data.json (ADR 201)
    },
    async saveData<T>(data: T): Promise<void> {
      // Write to {dorkHome}/extension-data/{id}/data.json
    },
  };

  function schedule(intervalSeconds: number, fn: () => Promise<void>): () => void {
    const MIN_INTERVAL = 5;
    const clamped = Math.max(intervalSeconds, MIN_INTERVAL);
    const interval = setInterval(() => {
      fn().catch(console.error);
    }, clamped * 1000);
    const cancel = () => clearInterval(interval);
    scheduledCleanups.push(cancel);
    return cancel;
  }

  function emit(event: string, data: unknown): void {
    deps.eventBus.emit(`ext:${deps.extensionId}:${event}`, data);
  }

  return {
    secrets,
    storage,
    schedule,
    emit,
    extensionId: deps.extensionId,
    extensionDir: deps.extensionDir,
    _getScheduledCleanups: () => scheduledCleanups,
  };
}
```

### Part 8: Extension Routes — Dynamic Delegation + Secrets API

In `apps/server/src/routes/extensions.ts`:

**New secret endpoints:**

```typescript
// PUT /api/extensions/:id/secrets/:key
router.put('/:id/secrets/:key', async (req, res) => {
  const { value } = req.body; // Zod: z.object({ value: z.string() })
  const store = new ExtensionSecretStore(req.params.id, dorkHome);
  await store.set(req.params.key, value);
  res.json({ ok: true });
});

// GET /api/extensions/:id/secrets
router.get('/:id/secrets', async (req, res) => {
  const store = new ExtensionSecretStore(req.params.id, dorkHome);
  // Return only which keys are set, never values
  const manifest = manager.getManifest(req.params.id);
  const declared = manifest?.serverCapabilities?.secrets ?? [];
  const result = await Promise.all(
    declared.map(async (s) => ({ key: s.key, label: s.label, isSet: await store.has(s.key) }))
  );
  res.json(result);
});

// DELETE /api/extensions/:id/secrets/:key
router.delete('/:id/secrets/:key', async (req, res) => {
  const store = new ExtensionSecretStore(req.params.id, dorkHome);
  await store.delete(req.params.key);
  res.json({ ok: true });
});
```

**Dynamic extension route delegation:**

New route file or middleware in the Express app:

```typescript
// /api/ext/:id/* → delegate to extension's registered router
app.use('/api/ext/:id', (req, res, next) => {
  const router = manager.getServerRouter(req.params.id);
  if (!router) {
    return res.status(404).json({ error: `Extension '${req.params.id}' has no server routes` });
  }
  router(req, res, next);
});
```

**SSE endpoint for extension events:**

```typescript
// GET /api/ext/:id/events — SSE stream for extension-specific events
app.get('/api/ext/:id/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const handler = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const eventName = `ext:${req.params.id}:*`;
  // Listen for all events from this extension
  eventBus.on(eventName, handler);

  req.on('close', () => {
    eventBus.off(eventName, handler);
  });
});
```

### Part 9: Declarative Proxy (Tier 1)

New file: `apps/server/src/services/extensions/extension-proxy.ts`

For extensions with a `dataProxy` manifest field, auto-generate proxy routes:

```typescript
import { Router, type Request, type Response } from 'express';
import type { DataProxyConfig } from '@dorkos/extension-api';
import { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';

export function createProxyRouter(
  extensionId: string,
  config: DataProxyConfig,
  dorkHome: string
): Router {
  const router = Router();
  const secrets = new ExtensionSecretStore(extensionId, dorkHome);

  router.all('/proxy/*', async (req: Request, res: Response) => {
    const targetPath = req.params[0]; // everything after /proxy/
    const targetUrl = `${config.baseUrl}/${targetPath}`;

    const secret = await secrets.get(config.authSecret);
    if (!secret) {
      return res.status(503).json({
        error: `Secret '${config.authSecret}' not configured for extension '${extensionId}'`,
      });
    }

    const authValue = config.authType === 'Custom' ? secret : `${config.authType} ${secret}`;

    try {
      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers: {
          ...filterHeaders(req.headers),
          [config.authHeader]: authValue,
          'Content-Type': req.headers['content-type'] ?? 'application/json',
        },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
      });

      res.status(upstream.status);
      const data = await upstream.text();
      res.send(data);
    } catch (err) {
      res.status(502).json({ error: 'Proxy request failed', details: String(err) });
    }
  });

  return router;
}
```

**Integration:** During `initializeServer()`, if the extension has `dataProxy` but no `server.ts`, create a proxy router automatically. If it has both, the proxy is mounted alongside the custom router at `/api/ext/{id}/proxy/*`.

### Part 10: Client-Side Loader Changes

In `apps/client/src/layers/features/extensions/model/extension-loader.ts`:

After client-side activation, trigger server initialization:

```typescript
async function activateExtension(record: ExtensionRecord, bundle: string): Promise<void> {
  // ... existing client-side activation ...

  // If extension has server capabilities, initialize server side
  if (record.hasServerEntry || record.hasDataProxy) {
    try {
      const res = await fetch(`/api/extensions/${record.id}/init-server`, { method: 'POST' });
      if (!res.ok) {
        console.warn(`[extensions] Server init failed for ${record.id}:`, await res.text());
      }
    } catch (err) {
      console.error(`[extensions] Server init error for ${record.id}:`, err);
    }
  }
}
```

Similarly, coordinate server shutdown on disable/reload.

**Note:** Server initialization should also happen during Express server startup (not just client-triggered). The Extension Manager's `initialize()` method should call `initializeServer()` for all enabled extensions with server entries.

### Part 11: Extension Templates

In `apps/server/src/services/extensions/extension-templates.ts`:

Add a `data-provider` template option:

```typescript
function generateServerTemplate(extensionId: string): string {
  return `
// Server-side data provider for ${extensionId}
// This runs in the DorkOS server process (Node.js)

export default function register(router, ctx) {
  router.get('/data', async (req, res) => {
    // Access secrets: const apiKey = await ctx.secrets.get('my_api_key');
    // Access storage: const cached = await ctx.storage.loadData();
    res.json({ message: 'Hello from server', extensionId: ctx.extensionId });
  });

  // Optional: schedule a background task
  // ctx.schedule(60, async () => {
  //   const data = await fetchExternalData();
  //   await ctx.storage.saveData(data);
  //   ctx.emit('data.updated', data);
  // });
}
`;
}
```

Update `createExtension()` to accept a `data-provider` template that generates both `index.ts` and `server.ts`.

### Part 12: MCP Tool Updates

In `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts`:

Update `get_extension_api` to include server-side documentation.

Update `create_extension` to support the `data-provider` template.

Update `list_extensions` to include `hasServerEntry` and `serverStatus` fields.

Add `test_extension` support for server-side testing (compile server bundle, call register with mock context).

### Part 13: Linear Issues Extension

Reference extension at `examples/extensions/linear-issues/`:

**`extension.json`:**

```json
{
  "id": "linear-issues",
  "name": "Linear Issues",
  "version": "1.0.0",
  "description": "Show Linear issue status on the DorkOS dashboard",
  "author": "DorkOS",
  "minHostVersion": "0.10.0",
  "contributions": {
    "dashboard.sections": true,
    "settings.tabs": true
  },
  "serverCapabilities": {
    "serverEntry": "./server.ts",
    "externalHosts": ["https://api.linear.app"],
    "secrets": [
      {
        "key": "linear_api_key",
        "label": "Linear API Key",
        "description": "Settings → API → Personal API keys at linear.app",
        "required": true
      }
    ]
  }
}
```

**`server.ts`:**

```typescript
import type { DataProviderContext, ServerExtensionRegister } from '@dorkos/extension-api/server';
import { Router } from 'express';

const LINEAR_API = 'https://api.linear.app/graphql';

const MY_ISSUES_QUERY = `
  query MyIssues {
    viewer {
      assignedIssues(
        first: 50,
        filter: { state: { type: { nin: ["completed", "canceled"] } } }
      ) {
        nodes {
          id
          identifier
          title
          priority
          state { name type color }
          team { key name }
          project { name }
          updatedAt
        }
      }
    }
  }
`;

async function fetchIssues(apiKey: string): Promise<unknown> {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: MY_ISSUES_QUERY }),
  });
  if (!res.ok) throw new Error(`Linear API error: ${res.status}`);
  return res.json();
}

const register: ServerExtensionRegister = (router, ctx) => {
  // On-demand endpoint
  router.get('/issues', async (req, res) => {
    const apiKey = await ctx.secrets.get('linear_api_key');
    if (!apiKey) {
      return res.status(503).json({ error: 'Linear API key not configured' });
    }
    try {
      const data = await fetchIssues(apiKey);
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  // Background polling (every 60s)
  ctx.schedule(60, async () => {
    const apiKey = await ctx.secrets.get('linear_api_key');
    if (!apiKey) return;
    try {
      const data = await fetchIssues(apiKey);
      const prev = await ctx.storage.loadData<{ hash?: string }>();
      const hash = JSON.stringify(data);
      if (hash !== prev?.hash) {
        await ctx.storage.saveData({ data, hash, updatedAt: Date.now() });
        ctx.emit('issues.updated', data);
      }
    } catch (err) {
      console.error(`[linear-issues] Polling error:`, err);
    }
  });

  router.get('/cached', async (_req, res) => {
    const cached = await ctx.storage.loadData();
    res.json(cached ?? { data: null });
  });
};

export default register;
```

**`index.ts`** (browser-side):

```typescript
function activate(api) {
  // Dashboard section
  api.registerComponent('dashboard.sections', 'linear-issues-section', LinearIssuesSection, {
    priority: 6, // After built-in sections
  });

  // Settings tab for API key
  api.registerSettingsTab('linear-issues-settings', 'Linear Issues', LinearIssuesSettings);
}

function LinearIssuesSection() {
  const [issues, setIssues] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    const fetchIssues = async () => {
      try {
        const res = await fetch('/api/ext/linear-issues/cached');
        const data = await res.json();
        setIssues(data?.data?.data?.viewer?.assignedIssues?.nodes ?? []);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    };
    fetchIssues();
    const interval = setInterval(fetchIssues, 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return React.createElement('div', { style: styles.card }, 'Loading issues...');
  if (error) return React.createElement('div', { style: styles.card }, `Error: ${error}`);
  if (!issues?.length)
    return React.createElement('div', { style: styles.card }, 'No active issues');

  return React.createElement(
    'div',
    { style: styles.card },
    React.createElement('h3', { style: styles.heading }, 'Linear Issues'),
    React.createElement(
      'div',
      { style: styles.list },
      issues.map((issue) => React.createElement(IssueRow, { key: issue.id, issue }))
    )
  );
}

function IssueRow({ issue }) {
  const priorityColors = ['', '#f76', '#fa5', '#fc6', '#6bf', '#999'];
  return React.createElement(
    'div',
    { style: styles.issueRow },
    React.createElement('span', {
      style: { ...styles.statusDot, backgroundColor: issue.state?.color ?? '#888' },
    }),
    React.createElement('span', { style: styles.identifier }, issue.identifier),
    React.createElement('span', { style: styles.title }, issue.title),
    React.createElement('span', { style: styles.team }, issue.team?.key)
  );
}

function LinearIssuesSettings() {
  // Auto-generated from manifest secrets — but for the example, show manual version
  const [apiKey, setApiKey] = React.useState('');
  const [isSet, setIsSet] = React.useState(false);

  React.useEffect(() => {
    fetch('/api/extensions/linear-issues/secrets')
      .then((r) => r.json())
      .then((secrets) => {
        const s = secrets.find((s) => s.key === 'linear_api_key');
        if (s) setIsSet(s.isSet);
      });
  }, []);

  const handleSave = async () => {
    await fetch('/api/extensions/linear-issues/secrets/linear_api_key', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: apiKey }),
    });
    setIsSet(true);
    setApiKey('');
  };

  return React.createElement(
    'div',
    { style: { padding: '16px' } },
    React.createElement('h3', null, 'Linear API Key'),
    React.createElement(
      'p',
      { style: { color: 'var(--muted-foreground)', marginBottom: '8px' } },
      'Get your key at Settings → API → Personal API keys on linear.app'
    ),
    isSet
      ? React.createElement(
          'div',
          null,
          React.createElement('span', null, '••••••••'),
          React.createElement(
            'button',
            { onClick: () => setIsSet(false), style: styles.clearBtn },
            'Clear'
          )
        )
      : React.createElement(
          'div',
          null,
          React.createElement('input', {
            type: 'password',
            value: apiKey,
            onInput: (e) => setApiKey(e.target.value),
            placeholder: 'lin_api_...',
            style: styles.input,
          }),
          React.createElement('button', { onClick: handleSave, style: styles.saveBtn }, 'Save')
        )
  );
}

const styles = {
  card: {
    padding: '16px',
    borderRadius: '8px',
    border: '1px solid var(--border)',
    marginBottom: '12px',
  },
  heading: { margin: '0 0 12px', fontSize: '14px', fontWeight: 600 },
  list: { display: 'flex', flexDirection: 'column', gap: '6px' },
  issueRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' },
  statusDot: { width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0 },
  identifier: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--muted-foreground)',
    fontSize: '12px',
    flexShrink: 0,
  },
  title: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  team: { marginLeft: 'auto', fontSize: '11px', color: 'var(--muted-foreground)', flexShrink: 0 },
  input: {
    padding: '6px 10px',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    background: 'transparent',
    color: 'inherit',
    marginRight: '8px',
  },
  saveBtn: {
    padding: '6px 12px',
    borderRadius: '4px',
    background: 'var(--primary)',
    color: 'var(--primary-foreground)',
    border: 'none',
    cursor: 'pointer',
  },
  clearBtn: {
    marginLeft: '8px',
    color: 'var(--destructive)',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    textDecoration: 'underline',
  },
};

module.exports = { activate };
```

---

## User Experience

### Extension Author Flow

1. Create extension directory with `extension.json`, `index.ts`, and `server.ts`
2. Declare `serverCapabilities.secrets` in manifest for any API keys needed
3. Write `server.ts` with `register(router, ctx)` — use `ctx.secrets.get()` for API keys
4. Write `index.ts` with `activate(api)` — use `fetch('/api/ext/{id}/...')` for data
5. Enable extension in Settings; enter API key in the auto-generated settings tab
6. Dashboard shows the extension's data

### Agent Author Flow

1. `get_extension_api` — see server-side API documentation
2. `create_extension` with `data-provider` template — scaffolds both files
3. Edit `server.ts` and `index.ts`
4. `test_extension` — headless compilation + activation test
5. `reload_extensions` — hot-reload into running client

### End User Flow (Linear Extension)

1. Enable "Linear Issues" in Settings → Extensions
2. Navigate to Settings → Linear Issues tab
3. Paste Linear API key (obtained from linear.app settings)
4. Return to dashboard — "Linear Issues" section appears
5. Issues auto-refresh every 60 seconds

---

## Testing Strategy

### Unit Tests

**Secrets store** (`packages/shared/src/__tests__/extension-secrets.test.ts`):

- Encrypts and decrypts roundtrip correctly
- Returns null for missing keys
- Isolation: store A cannot read store B
- Host key is generated on first access
- Host key file has 0600 permissions
- Handles corrupted encrypted data gracefully

**Server API factory** (`apps/server/src/services/extensions/__tests__/extension-server-api-factory.test.ts`):

- `ctx.secrets` delegates to ExtensionSecretStore
- `ctx.storage` reads/writes to correct path
- `ctx.schedule(ms, fn)` sets interval and returns cancel function
- `ctx.emit(event, data)` emits on event bus with correct prefix
- Cleanup cancels all scheduled tasks

**Extension compiler — server** (`apps/server/src/services/extensions/__tests__/extension-compiler.test.ts`):

- Compiles valid `server.ts` for Node.js target
- Returns error for invalid TypeScript
- Caches compiled output by content hash
- Cache hit skips recompilation

**Proxy middleware** (`apps/server/src/services/extensions/__tests__/extension-proxy.test.ts`):

- Forwards requests with auth header injected
- Returns 503 when secret not configured
- Returns 502 on upstream failure
- Passes through request body for POST/PUT

### Integration Tests

**Extension lifecycle** (`apps/server/src/routes/__tests__/extensions-server.test.ts`):

- Enable extension with server.ts → server routes become available
- Disable extension → server routes return 404
- Reload extension → server routes update
- Secrets: PUT → GET confirms isSet → DELETE → GET confirms not set

**Linear extension** (manual or E2E):

- With valid API key: dashboard shows issues
- Without API key: settings prompt shown
- With invalid API key: error state displayed
- Background poll updates cached data

### Non-Regression

- All existing extension tests continue to pass
- Browser-only extensions work identically (no manifest changes needed)
- MCP extension tools work for both types

---

## Performance Considerations

- **Server bundle loading**: Dynamic `require()` adds ~10-50ms per extension at startup. Acceptable for <20 extensions.
- **Background polling**: Each extension with `ctx.schedule()` runs a `setInterval`. Memory impact is negligible.
- **SSE connections**: One per extension per browser tab. Uses existing Express SSE patterns.
- **Secrets decryption**: `scryptSync` is CPU-bound (~50ms for key derivation). Called once per process, then cached.
- **Proxy latency**: Adds ~1-5ms for header injection and routing. Network latency to the external API dominates.

---

## Security Considerations

| Property                       | Implementation                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Secrets isolated per extension | `{dorkHome}/extension-secrets/{ext-id}.json` — separate files                   |
| Secrets never in browser       | Only derived data crosses to browser; secrets endpoints return `isSet` booleans |
| Secrets encrypted at rest      | AES-256-GCM with per-host key derived via scrypt                                |
| Write-only in settings UI      | UI shows `••••••••` after save; clear button to reset                           |
| Host key security              | `host.key` created with `mode: 0o600`; never leaves machine                     |
| Server code trust              | In-process, no sandbox (consistent with ADR 204: full-trust model)              |
| Route namespace isolation      | `/api/ext/{id}/*` prevents collision between extensions                         |

**Threat model:** Same as ADR 204 — extensions run with the same trust as any code the user installs. The secrets store prevents accidental exposure (plaintext in devtools, `data.json`), not targeted attacks by malicious extensions with same-process access.

---

## Documentation

Update `contributing/extension-authoring.md` with:

1. **Server-Side Hooks** section covering:
   - Creating `server.ts` alongside `index.ts`
   - `DataProviderContext` API reference
   - Route registration and naming conventions
   - Background tasks with `ctx.schedule()`
   - SSE events with `ctx.emit()`

2. **Secrets** section covering:
   - Declaring secrets in manifest
   - Storing and retrieving secrets
   - Settings UI auto-generation
   - Security properties

3. **Declarative Proxy** section covering:
   - `dataProxy` manifest configuration
   - Supported auth types
   - Path rewriting

4. **Reference Extension** walkthrough of the Linear Issues extension

---

## Implementation Phases

### Phase 1: Foundation (Secrets + Compiler + Discovery)

- Manifest schema changes (`serverCapabilities`, `dataProxy`)
- `ExtensionSecretStore` with AES-256-GCM encryption
- Secrets API endpoints (PUT/GET/DELETE)
- Server-side compiler (`compileServer()` with Node.js target)
- Discovery changes (detect `server.ts`, `hasServerEntry` flag)

### Phase 2: Server Runtime (Manager + Routes + Context)

- `DataProviderContext` factory
- Extension Manager server lifecycle (`initializeServer`, `shutdownServer`)
- Dynamic route delegation middleware (`/api/ext/:id/*`)
- Lifecycle coordination (enable/disable/reload triggers server init/shutdown)
- `ctx.schedule()` implementation (numeric intervals)
- `ctx.emit()` + SSE endpoint for extension events

### Phase 3: Declarative Proxy (Tier 1)

- `extension-proxy.ts` auto-proxy from manifest
- Integration with initializeServer for proxy-only extensions
- Proxy error handling (503 for missing secrets, 502 for upstream failures)

### Phase 4: Linear Extension + Templates + Docs

- Linear Issues reference extension (`server.ts` + `index.ts`)
- `data-provider` template for `create_extension`
- MCP tool updates (server lifecycle, template)
- Extension authoring documentation update

---

## Open Questions (All Resolved)

1. ~~**Cron expression support**~~ (RESOLVED)
   **Answer:** Numeric-only (seconds, not milliseconds) with a 5-second floor. `ctx.schedule(60, fn)` for 60-second intervals. Cron strings deferred to v2.
   **Rationale:** Seconds are more readable than milliseconds. 5-second minimum prevents accidental tight loops.

2. ~~**SSE event delivery**~~ (RESOLVED)
   **Answer:** Piggyback on the existing unified SSE stream (`EventFanOut` → `/api/events`). Events namespaced as `ext:{id}:{event}`. No new SSE connections.
   **Rationale:** HTTP/1.1 browsers cap at 6 concurrent connections per origin. Each SSE connection holds one open. Per-extension SSE endpoints would exhaust the connection pool.

3. ~~**Auto-generated settings UI for secrets**~~ (RESOLVED)
   **Answer:** Auto-generate from manifest `serverCapabilities.secrets` declarations. If the extension also registers its own `settings.tabs` component, it renders alongside (not replaces) the auto-generated secrets panel.
   **Rationale:** Reduces boilerplate for the common case. Extensions can still add custom settings alongside.

4. ~~**Server-side storage sharing**~~ (RESOLVED)
   **Answer:** Shared file. Same `extension-data/{id}/data.json` for both server `ctx.storage` and client `api.loadData()`/`api.saveData()`. Atomic writes (tmp + rename) prevent corruption.
   **Rationale:** Enables server-writes-client-reads pattern without HTTP roundtrip. Atomic writes prevent race conditions.

5. ~~**Extension route authentication**~~ (RESOLVED)
   **Answer:** No auth, open to local requests. Consistent with all other `/api/*` routes in DorkOS.
   **Rationale:** Single-user local tool. Adding auth to extension routes but not elsewhere would be inconsistent.

---

## Related ADRs

| ADR | Title                                              | Relevance                                                   |
| --- | -------------------------------------------------- | ----------------------------------------------------------- |
| 199 | Generic register<K>() API with SlotContributionMap | Extension API pattern this builds on                        |
| 200 | App-Layer Synchronous Extension Initialization     | Client-side extension loading sequence                      |
| 201 | Separate Extension Data from Code Directories      | Storage path convention (`extension-data/{id}/`)            |
| 202 | Content-Hash esbuild Compilation Cache             | Caching strategy to extend for server bundles               |
| 203 | UI Control Methods in v1 ExtensionAPI              | Explicitly deferred `secrets` to v2 — this spec delivers it |
| 204 | Full-Trust Security for Agent Extensions           | Trust model for server-side code (no sandbox)               |
| 205 | MCP-Only Interface for Agent Extension Management  | MCP tools to update                                         |
| 206 | Per-Extension Hot Reload                           | Reload pattern to extend for server-side                    |

---

## References

- **Ideation:** `specs/linear-issue-status-extension/01-ideation.md`
- **Research (extension systems):** `research/20260329_extension_server_side_capabilities.md`
- **Research (Linear API):** `research/20260329_linear_issue_status_extension_architecture.md`
- **Research (Linear data model):** `research/20260218_linear-domain-model.md`
- **Directus extension API:** https://directus.io/docs/guides/extensions/api-extensions/endpoints
- **Grafana secureJsonData:** https://grafana.com/developers/plugin-tools/how-to-guides/data-source-plugins/add-authentication-for-data-source-plugins
- **Linear GraphQL API:** https://linear.app/developers/graphql
- **Extension authoring guide:** `contributing/extension-authoring.md`
