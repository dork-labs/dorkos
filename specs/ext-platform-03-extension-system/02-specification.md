---
slug: ext-platform-03-extension-system
number: 183
created: 2026-03-26
status: specified
---

# Phase 3: Extension System Core — Specification

**Slug:** ext-platform-03-extension-system
**Author:** Claude Code
**Date:** 2026-03-26
**Source:** `specs/ext-platform-03-extension-system/01-ideation.md`
**Depends on:** Phase 1 (Agent UI Control & Canvas), Phase 2 (Extension Point Registry)

---

## 1. Overview

Build the full extension lifecycle for DorkOS — discovery, loading, activation, API surface, and settings UI. Extensions are filesystem-based: users place them in `{dorkHome}/extensions/` (global) or `{cwd}/.dork/extensions/` (project-local). DorkOS discovers them, validates their manifest, compiles TypeScript if needed, and activates them in the client. Extensions receive a typed `ExtensionAPI` wrapping Phase 1 (dispatcher), Phase 2 (registry), state access, and persistent storage.

### Design Principles

1. **File-first, no package manager** — Extensions are directories on disk, not npm packages. Discovery is filesystem scanning.
2. **Obsidian hybrid model** — File-based lifecycle + typed API + automatic resource cleanup.
3. **TypeScript-native** — Extensions can be authored in TypeScript without a build toolchain. esbuild compiles at enable time.
4. **No sandbox for v1** — Extensions run in-process with full React integration. Target audience is developers who trust their own code.
5. **Phase 4-ready API** — UI control methods included for agent-built extensions.

---

## 2. Technical Design

### 2.1 Extension Manifest (`extension.json`)

Every extension directory must contain an `extension.json` manifest. The manifest is readable without executing code — it enables fast startup and safe discovery.

**Schema** (defined in `packages/extension-api/src/manifest-schema.ts`):

```typescript
import { z } from 'zod';

export const ExtensionManifestSchema = z.object({
  /** Unique extension identifier (kebab-case). Used as directory name and registry key. */
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Human-readable display name. */
  name: z.string().min(1),
  /** Semver version string. */
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  /** Short description shown in settings UI. */
  description: z.string().optional(),
  /** Author name or identifier. */
  author: z.string().optional(),
  /** Minimum DorkOS version required (semver). If host is older, extension cannot be enabled. */
  minHostVersion: z.string().optional(),
  /** Declares which slots this extension contributes to. Informational only — not enforced. */
  contributions: z.record(z.boolean()).optional(),
  /** Reserved for future permission model. */
  permissions: z.array(z.string()).optional(),
});

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
```

**Example `extension.json`:**

```json
{
  "id": "github-prs",
  "name": "GitHub PR Dashboard",
  "version": "1.0.0",
  "description": "Shows pending PR reviews in the dashboard",
  "author": "dorkbot",
  "minHostVersion": "0.1.0",
  "contributions": {
    "dashboard.sections": true,
    "command-palette.items": true
  }
}
```

### 2.2 Extension Discovery & Lifecycle (Server)

**New service domain:** `apps/server/src/services/extensions/`

#### 2.2.1 Discovery

The `ExtensionDiscovery` class scans filesystem paths for extension directories containing valid `extension.json` manifests.

**Discovery paths:**

- Global: `{dorkHome}/extensions/` — always scanned
- Local: `{cwd}/.dork/extensions/` — scanned when a CWD is active
- Local overrides global by extension ID (same ID in both → local wins)

**Discovery algorithm:**

```
1. List directories in {dorkHome}/extensions/
2. For each directory:
   a. Read extension.json → parse with ExtensionManifestSchema
   b. If valid → create ExtensionRecord with scope: 'global'
   c. If invalid → create ExtensionRecord with status: 'invalid', error details
3. If CWD is active, repeat for {cwd}/.dork/extensions/
4. Merge: local overrides global by manifest.id
5. For each record, check version compatibility (minHostVersion vs host version)
   → If incompatible: status = 'incompatible'
6. Cross-reference against config.extensions.enabled[] to set enabled/disabled
```

**`ExtensionRecord` type** (defined in `packages/extension-api/src/types.ts`):

```typescript
export type ExtensionStatus =
  | 'discovered' // Manifest valid, not yet processed
  | 'incompatible' // minHostVersion check failed
  | 'invalid' // Manifest parse error
  | 'disabled' // Valid but user-disabled
  | 'enabled' // User-enabled, pending compilation
  | 'compiled' // Compiled successfully, ready for client
  | 'compile_error' // Compilation failed
  | 'active' // Client has loaded and activated
  | 'activate_error'; // activate() threw

export interface ExtensionRecord {
  id: string;
  manifest: ExtensionManifest;
  status: ExtensionStatus;
  scope: 'global' | 'local';
  /** Absolute path to the extension directory. */
  path: string;
  /** Structured error info (compilation failure, manifest parse error, etc.) */
  error?: { code: string; message: string; details?: string };
  /** Content hash of the source file (for cache keying). */
  sourceHash?: string;
  /** Whether the compiled bundle is available on the server. */
  bundleReady: boolean;
}
```

#### 2.2.2 Lifecycle Management

The `ExtensionManager` class manages lifecycle state transitions and persists enable/disable state.

**Enable/disable persistence:** A new `extensions` section in `UserConfigSchema`:

```typescript
// Added to packages/shared/src/config-schema.ts
extensions: z.object({
  /** Extension IDs that the user has explicitly enabled. */
  enabled: z.array(z.string()).default(() => []),
}).default(() => ({ enabled: [] })),
```

Extensions are **disabled by default**. Users explicitly enable them via the settings UI. The enabled list is an allowlist — only IDs in this array are enabled.

**State transitions:**

| From         | To               | Trigger                            |
| ------------ | ---------------- | ---------------------------------- |
| `discovered` | `disabled`       | Default (not in enabled list)      |
| `discovered` | `enabled`        | ID in config.extensions.enabled    |
| `discovered` | `incompatible`   | minHostVersion check fails         |
| `discovered` | `invalid`        | Manifest parse error               |
| `disabled`   | `enabled`        | `POST /api/extensions/:id/enable`  |
| `enabled`    | `disabled`       | `POST /api/extensions/:id/disable` |
| `enabled`    | `compiled`       | esbuild compilation succeeds       |
| `enabled`    | `compile_error`  | esbuild compilation fails          |
| `compiled`   | `active`         | Client reports activation success  |
| `compiled`   | `activate_error` | Client reports activation failure  |
| `active`     | `disabled`       | User disables → page reload        |

#### 2.2.3 Version Compatibility

Uses `semver.gte()` from the `semver` package:

```typescript
import { gte } from 'semver';

function checkCompatibility(manifest: ExtensionManifest, hostVersion: string): boolean {
  if (!manifest.minHostVersion) return true;
  return gte(hostVersion, manifest.minHostVersion);
}
```

Host version sourced from `package.json` version of the root monorepo or a constant in `packages/shared/src/constants.ts`.

Incompatible extensions are listed in settings UI with a warning badge and disabled toggle. They never activate.

### 2.3 TypeScript Compilation Service (Server)

**File:** `apps/server/src/services/extensions/extension-compiler.ts`

The `ExtensionCompiler` class handles TypeScript → JavaScript compilation with content-hash-based caching.

#### 2.3.1 Compilation Logic

```
1. Check for index.js in extension directory → if exists, use directly (pre-compiled)
2. Check for index.ts → if exists, compile with esbuild
3. Neither exists → error: 'no_entry_point'
```

**esbuild configuration:**

```typescript
import { build } from 'esbuild';

const result = await build({
  entryPoints: [entryPath], // index.ts or index.js
  bundle: true, // Bundle all imports
  format: 'esm', // ES modules for dynamic import()
  platform: 'browser', // Browser target
  target: 'es2022', // Modern JS
  external: [
    'react', // Provided by host
    'react-dom', // Provided by host
    '@dorkos/extension-api', // Provided by host
  ],
  write: false, // Return code as string
  minify: false, // Readable for debugging
  sourcemap: 'inline', // Inline sourcemaps for browser devtools
  logLevel: 'silent', // Capture errors programmatically
});
```

#### 2.3.2 Cache Strategy

**Cache location:** `{dorkHome}/cache/extensions/`

**Cache key:** SHA-256 content hash of `index.ts` (first 16 hex chars).

**Filename format:** `{ext-id}.{content-hash}.js`

Example: `github-prs.a3f8c91d2e4b5f67.js`

```typescript
import { createHash } from 'crypto';

function computeSourceHash(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}
```

**Cache flow:**

```
1. Read source file → compute content hash
2. Check for {dorkHome}/cache/extensions/{ext-id}.{hash}.js
   → Cache hit: return cached code
3. Check for {ext-id}.{hash}.error.json
   → Cached error: return structured error without recompiling
4. Cache miss: compile with esbuild
   → Success: write .js file, delete any stale .error.json
   → Failure: write .error.json with structured error
```

**Structured error format** (written to `{ext-id}.{hash}.error.json`):

```typescript
interface CompilationError {
  code: 'compilation_failed';
  message: string;
  errors: Array<{
    text: string;
    location?: { file: string; line: number; column: number };
  }>;
}
```

**Bundle size warning:** Log a warning if compiled output exceeds 500KB uncompressed. Not a hard limit — informational for extension authors.

#### 2.3.3 Stale Cache Cleanup

On server startup, scan the cache directory and delete files not accessed in 7+ days (`fs.stat().atimeMs`). This prevents unbounded cache growth without risking the deletion of actively-used bundles.

### 2.4 `packages/extension-api/` Package

A new monorepo package defining the public contract for extensions. Extension authors type against this package. The host provides the implementation.

**Package structure:**

```
packages/extension-api/
├── src/
│   ├── index.ts              # Public barrel exports
│   ├── extension-api.ts      # ExtensionAPI interface
│   ├── manifest-schema.ts    # extension.json Zod schema
│   ├── types.ts              # ExtensionRecord, ExtensionStatus, etc.
│   └── __tests__/
│       └── manifest-schema.test.ts
├── package.json
└── tsconfig.json
```

**`package.json`:**

```json
{
  "name": "@dorkos/extension-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "eslint ."
  },
  "dependencies": {
    "@dorkos/shared": "workspace:*",
    "zod": "^3.25.67"
  },
  "devDependencies": {
    "@dorkos/eslint-config": "workspace:*",
    "@dorkos/typescript-config": "workspace:*",
    "vitest": "^4.0.18"
  }
}
```

#### 2.4.1 ExtensionAPI Interface

```typescript
import type { ComponentType } from 'react';
import type { UiCommand, UiCanvasContent } from '@dorkos/shared/types';

/** Slot identifiers matching the Phase 2 registry. */
export type ExtensionPointId =
  | 'sidebar.footer'
  | 'sidebar.tabs'
  | 'dashboard.sections'
  | 'header.actions'
  | 'command-palette.items'
  | 'dialog'
  | 'settings.tabs'
  | 'session.canvas';

/** Read-only projection of host state. */
export interface ExtensionReadableState {
  currentCwd: string | null;
  activeSessionId: string | null;
  agentId: string | null;
}

/** The contract extensions receive on activation. */
export interface ExtensionAPI {
  /** This extension's ID from the manifest. */
  readonly id: string;

  // --- UI Contributions (wraps Phase 2 registry) ---

  /**
   * Register a React component in a UI slot.
   * Returns an unsubscribe function (auto-called on deactivate).
   */
  registerComponent(
    slot: ExtensionPointId,
    id: string,
    component: ComponentType,
    options?: { priority?: number }
  ): () => void;

  /**
   * Register a command palette item.
   * Returns an unsubscribe function.
   */
  registerCommand(
    id: string,
    label: string,
    callback: () => void,
    options?: { icon?: string; shortcut?: string }
  ): () => void;

  /**
   * Register a dialog component.
   * Returns an object with open/close controls.
   */
  registerDialog(id: string, component: ComponentType): { open: () => void; close: () => void };

  /**
   * Register a tab in the settings dialog.
   * Returns an unsubscribe function.
   */
  registerSettingsTab(id: string, label: string, component: ComponentType): () => void;

  // --- UI Control (wraps Phase 1 dispatcher) ---

  /** Execute a UI command (open panel, show toast, etc.). */
  executeCommand(command: UiCommand): void;

  /** Open the canvas with the given content. */
  openCanvas(content: UiCanvasContent): void;

  /** Navigate to a client-side route. */
  navigate(path: string): void;

  // --- State ---

  /** Get a read-only snapshot of host state. */
  getState(): ExtensionReadableState;

  /**
   * Subscribe to state changes. The selector picks a value; the callback
   * fires when that value changes. Returns an unsubscribe function.
   */
  subscribe(
    selector: (state: ExtensionReadableState) => unknown,
    callback: (value: unknown) => void
  ): () => void;

  // --- Storage (scoped to this extension) ---

  /** Load persistent data for this extension. Returns null if no data saved. */
  loadData<T>(): Promise<T | null>;

  /** Save persistent data for this extension. */
  saveData<T>(data: T): Promise<void>;

  // --- Notifications ---

  /** Show a toast notification. */
  notify(message: string, options?: { type?: 'info' | 'success' | 'error' }): void;

  // --- Context ---

  /** Check if a UI slot is rendered in the current host context. */
  isSlotAvailable(slot: ExtensionPointId): boolean;
}

/** The interface an extension module must export. */
export interface ExtensionModule {
  activate(api: ExtensionAPI): void | (() => void);
}
```

The `activate()` function may optionally return a cleanup function. If provided, it's called on deactivation alongside the auto-collected unsubscribe functions.

### 2.5 Server Endpoints

**File:** `apps/server/src/routes/extensions.ts`

All endpoints are registered with the OpenAPI registry for API docs.

| Method | Path                          | Description                                                       |
| ------ | ----------------------------- | ----------------------------------------------------------------- |
| `GET`  | `/api/extensions`             | List all discovered extensions with status                        |
| `POST` | `/api/extensions/:id/enable`  | Enable an extension (adds to config, triggers compile)            |
| `POST` | `/api/extensions/:id/disable` | Disable an extension (removes from config)                        |
| `POST` | `/api/extensions/reload`      | Re-scan filesystem, revalidate, recompile changed                 |
| `GET`  | `/api/extensions/:id/bundle`  | Serve compiled JS bundle (`Content-Type: application/javascript`) |
| `GET`  | `/api/extensions/:id/data`    | Read extension's persistent data (JSON)                           |
| `PUT`  | `/api/extensions/:id/data`    | Write extension's persistent data (JSON body)                     |

#### 2.5.1 `GET /api/extensions`

**Response:** `ExtensionRecord[]` — all discovered extensions from both global and local paths.

Includes: `id`, `manifest` (full), `status`, `scope`, `error` (if any), `bundleReady`.

Excludes: `path` (server-internal), `sourceHash` (server-internal).

#### 2.5.2 `POST /api/extensions/:id/enable`

1. Validate extension exists and status is `disabled` or `discovered`.
2. Check version compatibility — reject if incompatible.
3. Add `id` to `config.extensions.enabled[]` and persist.
4. Trigger compilation if TypeScript.
5. Return updated `ExtensionRecord`.
6. If compilation fails, record remains `compile_error` but stays in the enabled list (user can fix and reload).

#### 2.5.3 `POST /api/extensions/:id/disable`

1. Remove `id` from `config.extensions.enabled[]` and persist.
2. Return updated `ExtensionRecord` with `status: 'disabled'`.
3. Client observes the change (via refetch or SSE) and triggers page reload.

#### 2.5.4 `POST /api/extensions/reload`

1. Re-run full discovery (both paths).
2. Recompile any enabled extensions whose source hash changed.
3. Return updated `ExtensionRecord[]`.

#### 2.5.5 `GET /api/extensions/:id/bundle`

1. Look up extension by ID.
2. If status is not `compiled` or `active` → 404.
3. Read compiled bundle from cache.
4. Respond with `Content-Type: application/javascript`, `Cache-Control: no-store`.

#### 2.5.6 `GET /api/extensions/:id/data` and `PUT /api/extensions/:id/data`

**Storage path resolution:**

- Global extension: `{dorkHome}/extension-data/{ext-id}/data.json`
- Local extension: `{cwd}/.dork/extension-data/{ext-id}/data.json`

**GET:** Returns JSON contents or `null` (204 No Content) if no data file exists.

**PUT:** Accepts JSON body. Creates directory and file if they don't exist. Writes atomically (write to temp file, rename).

### 2.6 Client-Side Extension Loader

**FSD module:** `apps/client/src/layers/features/extensions/`

```
layers/features/extensions/
├── model/
│   ├── extension-loader.ts       # Core loader: fetch list, import bundles, activate
│   ├── extension-api-factory.ts  # Constructs ExtensionAPI per extension
│   ├── extension-context.ts      # React context + provider
│   └── types.ts                  # Client-side extension types
├── api/
│   └── queries.ts                # TanStack Query hooks for /api/extensions
├── ui/
│   └── ExtensionsSettingsTab.tsx  # Settings dialog tab
├── __tests__/
│   ├── extension-loader.test.ts
│   ├── extension-api-factory.test.ts
│   └── ExtensionsSettingsTab.test.tsx
└── index.ts                      # Barrel exports
```

#### 2.6.1 Extension Loader

The `ExtensionLoader` handles the client-side lifecycle: fetch → import → activate → track.

```typescript
interface LoadedExtension {
  id: string;
  manifest: ExtensionManifest;
  module: ExtensionModule;
  api: ExtensionAPI;
  /** All unsubscribe functions collected from register* calls. */
  cleanups: Array<() => void>;
  /** Optional cleanup function returned from activate(). */
  deactivate?: () => void;
}
```

**Loading sequence (called during app initialization):**

```
1. Fetch GET /api/extensions → ExtensionRecord[]
2. Filter to records where status === 'compiled' and bundleReady === true
3. Load bundles in parallel:
   await Promise.all(records.map(async (rec) => {
     const module = await import(/* @vite-ignore */ `/api/extensions/${rec.id}/bundle`);
     return { rec, module };
   }))
4. For each loaded module:
   a. Construct ExtensionAPI via factory (see 2.6.2)
   b. Call module.activate(api) in a try/catch
   c. If activate() returns a function, store as deactivate
   d. If activate() throws, log error and report status: 'activate_error'
   e. Store in loadedExtensions map
5. Log summary: "[extensions] Activated: ext-a v1.0.0, ext-b v2.1.0"
```

**Deactivation sequence** (for cleanup/page reload):

```
1. For each loaded extension:
   a. Call deactivate() if provided
   b. Call all collected cleanup functions (unsubscribe from registry)
   c. Remove from loadedExtensions map
```

#### 2.6.2 ExtensionAPI Factory

The `createExtensionAPI()` function constructs a per-extension API object. It wraps host primitives with tracking and scoping.

**Dependencies injected into the factory:**

| Dependency          | Source                                           | Purpose                                      |
| ------------------- | ------------------------------------------------ | -------------------------------------------- |
| `registry`          | `useExtensionRegistry.getState()`                | `registerComponent`, `registerCommand`, etc. |
| `dispatcherContext` | Constructed from `useAppStore.getState()` + refs | `executeCommand`, `openCanvas`               |
| `navigate`          | Router instance's `navigate()` method            | `navigate(path)`                             |
| `transport`         | `HttpTransport` instance                         | `loadData`/`saveData` via REST endpoints     |
| `appStore`          | `useAppStore`                                    | `getState()`, `subscribe()`                  |
| `availableSlots`    | Set based on rendering mode                      | `isSlotAvailable()`                          |

**Tracking pattern** (Obsidian model):

Every `register*()` call appends the returned unsubscribe function to a per-extension `cleanups` array. On deactivate, all cleanups are called automatically. Extension authors don't need to manage cleanup manually (though they can via the returned unsubscribe function).

```typescript
function createExtensionAPI(
  extId: string,
  deps: ExtensionAPIDeps
): { api: ExtensionAPI; cleanups: Array<() => void> } {
  const cleanups: Array<() => void> = [];

  const api: ExtensionAPI = {
    id: extId,

    registerComponent(slot, id, component, options) {
      // Adapt to the Phase 2 registry's contribution shape
      const contribution = adaptToContribution(slot, id, component, options);
      const unsub = deps.registry.register(slot, contribution);
      cleanups.push(unsub);
      return unsub;
    },

    registerCommand(id, label, callback, options) {
      const contribution: CommandPaletteContribution = {
        id: `${extId}:${id}`,
        label,
        icon: options?.icon ?? 'puzzle',
        action: `ext:${extId}:${id}`,
        category: 'feature',
        shortcut: options?.shortcut,
      };
      const unsub = deps.registry.register('command-palette.items', contribution);
      cleanups.push(unsub);
      // Register the action handler separately
      deps.registerCommandHandler(`ext:${extId}:${id}`, callback);
      return unsub;
    },

    // ... other methods wrapping host primitives

    executeCommand(command) {
      executeUiCommand(deps.dispatcherContext, command);
    },

    openCanvas(content) {
      executeUiCommand(deps.dispatcherContext, {
        action: 'open_canvas',
        content,
      });
    },

    navigate(path) {
      deps.navigate({ to: path });
    },

    getState() {
      const store = deps.appStore.getState();
      return {
        currentCwd: store.activeCwd ?? null,
        activeSessionId: store.activeSessionId ?? null,
        agentId: store.activeAgentId ?? null,
      };
    },

    subscribe(selector, callback) {
      const unsub = deps.appStore.subscribe((state) => {
        const projected: ExtensionReadableState = {
          currentCwd: state.activeCwd ?? null,
          activeSessionId: state.activeSessionId ?? null,
          agentId: state.activeAgentId ?? null,
        };
        return selector(projected);
      }, callback);
      cleanups.push(unsub);
      return unsub;
    },

    async loadData<T>() {
      const res = await fetch(`/api/extensions/${extId}/data`);
      if (res.status === 204) return null;
      return res.json() as Promise<T>;
    },

    async saveData<T>(data: T) {
      await fetch(`/api/extensions/${extId}/data`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    },

    notify(message, options) {
      const type = options?.type ?? 'info';
      toast[type === 'error' ? 'error' : type === 'success' ? 'success' : 'info'](message);
    },

    isSlotAvailable(slot) {
      return deps.availableSlots.has(slot);
    },
  };

  return { api, cleanups };
}
```

#### 2.6.3 Extension Context & Provider

An `ExtensionProvider` React context wraps the app tree, exposing the extension system state to components that need it (e.g., the Settings tab).

```typescript
interface ExtensionContextValue {
  /** All discovered extensions (from server). */
  extensions: ExtensionRecord[];
  /** Currently loaded & activated extensions. */
  loaded: Map<string, LoadedExtension>;
  /** Whether the initial extension load is complete. */
  ready: boolean;
}
```

**Provider placement in `main.tsx`:**

```
QueryClientProvider
  → TransportProvider
    → ExtensionProvider        ← NEW (wraps the app after transport is available)
      → PasscodeGateWrapper
        → RouterProvider
```

The provider calls `extensionLoader.initialize()` on mount. Until `ready` is `true`, extensions are not active. Built-in registrations (from `initializeExtensions()`) are still synchronous and unaffected.

#### 2.6.4 Integration with `init-extensions.ts`

The existing `initializeExtensions()` function continues to register built-in contributions synchronously. Third-party extensions are loaded asynchronously by the `ExtensionProvider`. The two systems coexist:

- **Built-in:** Synchronous, imported at build time, registered before render
- **Third-party:** Asynchronous, fetched from server, activated after initial render

This means the first paint shows built-in UI immediately. Extension contributions appear after the async load completes (typically <50ms on localhost).

### 2.7 Extension Settings UI

**File:** `apps/client/src/layers/features/extensions/ui/ExtensionsSettingsTab.tsx`

A new tab in `SettingsDialog` — "Extensions" — showing all discovered extensions.

#### 2.7.1 Tab Registration

Register via Phase 2 registry in `initializeExtensions()`:

```typescript
register('settings.tabs', {
  id: 'extensions',
  label: 'Extensions',
  icon: PuzzleIcon,
  component: lazy(() =>
    import('@/layers/features/extensions').then((m) => ({ default: m.ExtensionsSettingsTab }))
  ),
  priority: 70, // After built-in tabs
});
```

#### 2.7.2 UI Layout

```
┌─────────────────────────────────────────────────┐
│ Extensions                                       │
│                                                  │
│ ┌──────────────────────────────────────────────┐ │
│ │ 🧩 GitHub PR Dashboard          v1.0.0      │ │
│ │ Shows pending PR reviews in the dashboard    │ │
│ │ Source: global · Author: dorkbot             │ │
│ │                                    [Toggle] ◯│ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ ┌──────────────────────────────────────────────┐ │
│ │ ⚠ My Local Plugin               v0.1.0      │ │
│ │ Compilation error: Unexpected token...       │ │
│ │ Source: local                                │ │
│ │                                    [Toggle] ●│ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ ┌──────────────────────────────────────────────┐ │
│ │ 🚫 Legacy Extension              v0.5.0     │ │
│ │ Requires DorkOS ≥ 0.3.0 (current: 0.1.0)   │ │
│ │ Source: global                               │ │
│ │                                    [Toggle] ─│ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ [↻ Reload Extensions]                            │
└─────────────────────────────────────────────────┘
```

**Per-extension card shows:**

- Name + version
- Description
- Source badge (global / local)
- Author (if present)
- Status indicator:
  - Normal: no extra indicator
  - `compile_error`: warning icon + truncated error message (expandable)
  - `incompatible`: warning icon + version requirement message
  - `activate_error`: error icon + "Activation failed"
- Enable/disable toggle:
  - Normal: functional toggle
  - `incompatible`: disabled toggle with tooltip explaining why

**Reload button:** Calls `POST /api/extensions/reload`, then refetches the extension list. Shows a toast on completion.

**Page reload notice:** When an extension is enabled or disabled, show a toast: "Extension changes require a page reload" with a "Reload now" action button. (For v1, don't auto-reload — let the user choose when.)

### 2.8 CWD Change Handling

When the active CWD changes (user switches projects):

1. Server re-scans `{newCwd}/.dork/extensions/` and merges with global extensions.
2. Server computes diff: which extension IDs were added or removed.
3. If diff is non-empty:
   - Server emits SSE event: `{ type: 'extensions-changed', reason: 'cwd-switch' }`
   - Client shows toast: "Project extensions changed. Reloading..." (1.5s delay)
   - Client calls `location.reload()`
4. If diff is empty: no action needed.

The diff check prevents unnecessary reloads when switching between projects that have no local extensions.

---

## 3. Data Models

### 3.1 Config Schema Addition

```typescript
// In packages/shared/src/config-schema.ts, add to UserConfigSchema:
extensions: z.object({
  enabled: z.array(z.string()).default(() => []),
}).default(() => ({ enabled: [] })),
```

### 3.2 API Response Schemas

```typescript
// GET /api/extensions response
const ExtensionListResponseSchema = z.array(
  z.object({
    id: z.string(),
    manifest: ExtensionManifestSchema,
    status: z.enum([
      'discovered',
      'incompatible',
      'invalid',
      'disabled',
      'enabled',
      'compiled',
      'compile_error',
      'active',
      'activate_error',
    ]),
    scope: z.enum(['global', 'local']),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.string().optional(),
      })
      .optional(),
    bundleReady: z.boolean(),
  })
);

// POST /api/extensions/:id/enable and disable response
const ExtensionActionResponseSchema = z.object({
  extension: ExtensionListResponseSchema.element,
  reloadRequired: z.boolean(),
});
```

---

## 4. Filesystem Layout

### 4.1 New Files to Create

**Package: `packages/extension-api/`**

| File                                    | Purpose                                                       |
| --------------------------------------- | ------------------------------------------------------------- |
| `package.json`                          | Package manifest                                              |
| `tsconfig.json`                         | TypeScript config (extends shared)                            |
| `src/index.ts`                          | Barrel exports                                                |
| `src/extension-api.ts`                  | `ExtensionAPI` interface                                      |
| `src/manifest-schema.ts`                | `ExtensionManifestSchema` Zod schema                          |
| `src/types.ts`                          | `ExtensionRecord`, `ExtensionStatus`, `ExtensionModule` types |
| `src/__tests__/manifest-schema.test.ts` | Schema validation tests                                       |

**Server: `apps/server/src/services/extensions/`**

| File                                    | Purpose                                 |
| --------------------------------------- | --------------------------------------- |
| `index.ts`                              | Service barrel exports                  |
| `extension-discovery.ts`                | Filesystem scanning, manifest parsing   |
| `extension-compiler.ts`                 | esbuild compilation, cache management   |
| `extension-manager.ts`                  | Lifecycle state machine, enable/disable |
| `__tests__/extension-discovery.test.ts` | Discovery tests                         |
| `__tests__/extension-compiler.test.ts`  | Compilation + caching tests             |
| `__tests__/extension-manager.test.ts`   | Lifecycle tests                         |

**Server routes: `apps/server/src/routes/`**

| File                           | Purpose                                 |
| ------------------------------ | --------------------------------------- |
| `extensions.ts`                | REST endpoints for extension management |
| `__tests__/extensions.test.ts` | Route integration tests                 |

**Client: `apps/client/src/layers/features/extensions/`**

| File                                       | Purpose                                     |
| ------------------------------------------ | ------------------------------------------- |
| `index.ts`                                 | Barrel exports                              |
| `model/extension-loader.ts`                | Fetch, import, activate extensions          |
| `model/extension-api-factory.ts`           | Construct per-extension API objects         |
| `model/extension-context.ts`               | React context + `ExtensionProvider`         |
| `model/types.ts`                           | Client-side types (`LoadedExtension`, etc.) |
| `api/queries.ts`                           | TanStack Query hooks                        |
| `ui/ExtensionsSettingsTab.tsx`             | Settings tab component                      |
| `ui/ExtensionCard.tsx`                     | Per-extension card in settings              |
| `__tests__/extension-loader.test.ts`       | Loader unit tests                           |
| `__tests__/extension-api-factory.test.ts`  | API factory tests                           |
| `__tests__/ExtensionsSettingsTab.test.tsx` | Settings UI tests                           |

### 4.2 Modified Files

| File                                     | Change                                        |
| ---------------------------------------- | --------------------------------------------- |
| `packages/shared/src/config-schema.ts`   | Add `extensions` config section               |
| `apps/client/src/main.tsx`               | Add `ExtensionProvider` to provider tree      |
| `apps/client/src/app/init-extensions.ts` | Register Extensions settings tab              |
| `apps/server/src/index.ts`               | Initialize extension service                  |
| `turbo.json`                             | Add `@dorkos/extension-api` to build pipeline |
| Root `package.json`                      | Add workspace reference                       |

---

## 5. Implementation Phases

### Phase A: Foundation (Package + Manifest + Config)

1. Create `packages/extension-api/` with types, interfaces, and manifest schema
2. Add `extensions` config section to `UserConfigSchema`
3. Add `semver` dependency to server
4. Wire package into turbo.json build pipeline

**Verification:** `pnpm typecheck` passes, manifest schema tests pass.

### Phase B: Server Discovery & Compilation

5. Implement `ExtensionDiscovery` — filesystem scanning, manifest parsing, version checking
6. Implement `ExtensionCompiler` — esbuild compilation, content-hash caching, error capture
7. Implement `ExtensionManager` — lifecycle state machine, enable/disable persistence
8. Add `routes/extensions.ts` — all 7 REST endpoints
9. Register routes in server index, initialize extension service

**Verification:** `GET /api/extensions` returns empty list. Create a test extension in `{dorkHome}/extensions/hello-world/` with manifest + `index.ts`. Verify discovery, compilation, and bundle serving.

### Phase C: Client Loader & API Factory

10. Implement `extension-api-factory.ts` — construct per-extension API from host primitives
11. Implement `extension-loader.ts` — fetch list, dynamic import, activate, track cleanups
12. Implement `extension-context.ts` — `ExtensionProvider` wrapping the app
13. Integrate into `main.tsx` (add provider) and `init-extensions.ts` (register settings tab)

**Verification:** Hello-world extension activates and renders a dashboard section. Enable/disable cycle works with page reload.

### Phase D: Settings UI & Polish

14. Implement `ExtensionsSettingsTab.tsx` — extension list with status, toggles, reload
15. Implement `ExtensionCard.tsx` — per-extension status display
16. Implement CWD change handling (SSE event → toast → reload)
17. Add extension data endpoints (`GET/PUT /api/extensions/:id/data`)
18. Write comprehensive tests for all modules

**Verification:** Full end-to-end flow: place extension on disk → discover → enable in settings → activate → renders in UI → disable → contributions removed.

### Phase E: Sample Extension & Documentation

19. Create a `hello-world` sample extension in `examples/extensions/hello-world/`
20. Verify it works for both TypeScript (`index.ts`) and pre-compiled (`index.js`) paths
21. Add brief extension authoring guide in `docs/` or `contributing/`

**Verification:** A developer can copy the hello-world extension to `{dorkHome}/extensions/`, enable it, and see it render.

---

## 6. Testing Strategy

### 6.1 Unit Tests

| Module                     | Test Focus                                                              |
| -------------------------- | ----------------------------------------------------------------------- |
| `manifest-schema.ts`       | Valid/invalid manifests, edge cases (missing fields, bad semver)        |
| `extension-discovery.ts`   | Scan global/local paths, merge with local override, handle missing dirs |
| `extension-compiler.ts`    | Compile TS, cache hit/miss, error capture, stale cache cleanup          |
| `extension-manager.ts`     | State transitions, enable/disable persistence, version compat           |
| `extension-api-factory.ts` | All 13 API methods produce correct calls to underlying primitives       |
| `extension-loader.ts`      | Fetch → load → activate flow, error handling, cleanup on deactivate     |

### 6.2 Integration Tests

| Test                 | Scope                                                                            |
| -------------------- | -------------------------------------------------------------------------------- |
| Route tests          | Supertest against Express app — all 7 endpoints                                  |
| End-to-end discovery | Place test extension on filesystem, verify full discovery → compile → serve flow |
| Client activation    | Mock server responses, verify dynamic import and activate() call                 |

### 6.3 Component Tests

| Component               | Test Focus                                                    |
| ----------------------- | ------------------------------------------------------------- |
| `ExtensionsSettingsTab` | Renders extension list, enable/disable toggles, reload button |
| `ExtensionCard`         | Status badges, error display, toggle behavior per status      |

### 6.4 Manual Verification

A `hello-world` sample extension that registers a dashboard section with a simple React component. Verifies the complete pipeline from filesystem to rendered UI.

---

## 7. Acceptance Criteria

- [ ] `extension.json` schema defined and validated with Zod
- [ ] Extensions discovered from both `{dorkHome}/extensions/` and `{cwd}/.dork/extensions/`
- [ ] Local extensions override global by ID
- [ ] Extension lifecycle works: discover → enable → compile → activate → deactivate → disable
- [ ] TypeScript extensions compiled with esbuild at enable time
- [ ] Compilation errors are structured and surfaced in the settings UI
- [ ] `ExtensionAPI` interface defined in `packages/extension-api/`
- [ ] A sample extension (hello-world dashboard card) activates and renders in the correct slot
- [ ] Extension registrations auto-cleaned on deactivate
- [ ] Enable/disable state persists across restarts (in config.json)
- [ ] `GET /api/extensions` returns all discovered extensions with status
- [ ] Settings dialog "Extensions" tab shows installed extensions with enable/disable toggles
- [ ] `POST /api/extensions/reload` re-scans and reloads extensions
- [ ] Extension persistent storage (`loadData`/`saveData`) works via REST endpoints
- [ ] Version-incompatible extensions shown with warning, toggle disabled
- [ ] CWD change triggers page reload only when extension set changes
- [ ] No regression in existing features — built-in registry registrations (Phase 2) unaffected
- [ ] All new modules have comprehensive test coverage

---

## 8. Non-Goals (Deferred to Later Phases)

| Feature                              | Rationale                                                               |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `transport` on ExtensionAPI          | Most v1 extensions don't need authenticated server calls; `fetch` works |
| `useQuery` hook exposure             | Creates React-version coupling; defer until needed                      |
| `secrets` API                        | No sandbox = no secure credential storage                               |
| Permission enforcement               | Meaningless without sandboxing                                          |
| Extension marketplace                | v1 is filesystem-based only                                             |
| Hot module replacement               | Page reload is acceptable for v1                                        |
| Extension-to-extension communication | Build demand signal first                                               |
| Sandboxing / iframe isolation        | v2 can add proxy-membrane approach without API changes                  |
