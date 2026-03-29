# Extension Authoring

Extensions add UI components, commands, and behavior to DorkOS. This guide covers everything you need to create, install, and debug a custom extension.

## Quick Start

1. Copy `examples/extensions/hello-world/` to `~/.dork/extensions/hello-world/`
2. Open DorkOS Settings > Extensions
3. Enable "Hello World" and reload the page
4. The dashboard shows a new section; the command palette has a "Hello World: Show Greeting" command

> **No server restart required.** The extension system discovers new directories on page reload. For extensions with `server.ts`, the server side initializes automatically when the client activates the extension.

## Directory Structure

An extension is a directory with at least two files:

```
my-extension/
├── extension.json   # Required — manifest
├── index.ts         # Required — client entry point (or index.js for pre-compiled)
└── server.ts        # Optional — server-side data provider (see Server-Side Data Providers)
```

**Global extensions** live in `~/.dork/extensions/{id}/`. **Local extensions** (project-scoped) live in `{projectDir}/.dork/extensions/{id}/`. Local overrides global when IDs match.

## Manifest (`extension.json`)

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "description": "What this extension does",
  "author": "Your Name",
  "minHostVersion": "0.1.0",
  "contributions": {
    "dashboard.sections": true,
    "command-palette.items": true
  },
  "permissions": []
}
```

| Field                | Required | Description                                                                              |
| -------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `id`                 | Yes      | Unique kebab-case identifier. Must match the directory name.                             |
| `name`               | Yes      | Display name shown in Settings.                                                          |
| `version`            | Yes      | Semver string (e.g. `1.0.0`).                                                            |
| `description`        | No       | Short description for the settings UI.                                                   |
| `author`             | No       | Author name or identifier.                                                               |
| `minHostVersion`     | No       | Minimum DorkOS version. Extension won't load on older hosts.                             |
| `contributions`      | No       | Declares which UI slots the extension contributes to (informational).                    |
| `permissions`        | No       | Reserved for future use.                                                                 |
| `serverCapabilities` | No       | Server-side declarations: entry point, external hosts, secrets. See [Secrets](#secrets). |
| `dataProxy`          | No       | Declarative API proxy config. See [Declarative Proxy](#declarative-proxy).               |

## Entry Point (`activate`)

The entry point must export an `activate` function:

```typescript
import type { ExtensionAPI } from '@dorkos/extension-api';

export function activate(api: ExtensionAPI): void | (() => void) {
  // Register UI components, commands, subscriptions...

  // Optionally return a cleanup function
  return () => {
    // Called when the extension is disabled or the page unloads
  };
}
```

Cleanup is automatic: any registrations made through `api.registerComponent`, `api.registerCommand`, etc. are unregistered when the extension deactivates, whether or not you return a cleanup function.

## API Reference

### UI Registration

```typescript
// Add a React component to a UI slot
api.registerComponent(slot, id, Component, { priority?: number }): () => void

// Add a command palette item
api.registerCommand(id, label, callback, { icon?, shortcut? }): () => void

// Register a dialog
api.registerDialog(id, Component): { open: () => void; close: () => void }

// Add a tab to the settings dialog
api.registerSettingsTab(id, label, Component): () => void
```

### UI Control

```typescript
// Execute a UI command (open panel, show toast, etc.)
api.executeCommand(command: UiCommand): void

// Open the canvas with content
api.openCanvas(content: UiCanvasContent): void

// Navigate to a client-side route
api.navigate(path: string): void
```

### State

```typescript
// Read-only snapshot: { currentCwd, activeSessionId, agentId }
api.getState(): ExtensionReadableState

// Subscribe to state changes (returns unsubscribe function)
api.subscribe(selector, callback): () => void
```

### Storage

```typescript
// Load persistent data (returns null if nothing saved)
const data = await api.loadData<MyData>();

// Save persistent data (scoped to this extension)
await api.saveData({ key: 'value' });
```

Storage is JSON-serialized and persisted at `~/.dork/extensions/{id}/data.json`.

### Notifications

```typescript
api.notify('Something happened', { type: 'info' | 'success' | 'error' });
```

### Introspection

```typescript
// Check if a slot is rendered in the current context
api.isSlotAvailable('dashboard.sections'): boolean

// The extension's own ID
api.id: string
```

## UI Slots

| Slot ID                 | Where it renders            |
| ----------------------- | --------------------------- |
| `sidebar.footer`        | Bottom of the sidebar       |
| `sidebar.tabs`          | Sidebar tab bar             |
| `dashboard.sections`    | Dashboard main content area |
| `header.actions`        | Header action buttons       |
| `command-palette.items` | Command palette entries     |
| `dialog`                | Modal dialog layer          |
| `settings.tabs`         | Settings dialog tabs        |
| `session.canvas`        | Session canvas panel        |

## TypeScript vs JavaScript

**TypeScript** (`index.ts`): Compiled automatically by the host using esbuild. JSX is supported in `.ts` files. Type against `@dorkos/extension-api` for full autocompletion.

**Pre-compiled JavaScript** (`index.js`): Served directly with no compilation step. Use `React.createElement` for components since JSX isn't available without a build step.

If both `index.js` and `index.ts` exist, the pre-compiled JS takes priority.

## React Components

React is provided by the host on the global scope (`globalThis.React`). **Do not import React yourself** — the extension is compiled as ESM with `react` externalized, so a bare `import React from 'react'` produces a module specifier the browser cannot resolve and causes a runtime error.

```typescript
// WRONG — causes "Failed to resolve module specifier 'react'" at runtime
import React from 'react';

// CORRECT — type-only imports are erased at compile time (safe)
import type { ExtensionAPI } from '@dorkos/extension-api';

// CORRECT — use React from the global scope
function MySection() {
  const [count, setCount] = React.useState(0);
  return React.createElement('div', null, `Count: ${count}`);
}
```

In TypeScript extensions, JSX works out of the box (the compiler uses the global `React`):

```typescript
function MySection() {
  return <div style={{ padding: '16px' }}>Hello</div>;
}
```

In JavaScript extensions, use `React.createElement`:

```javascript
function MySection() {
  return React.createElement('div', { style: { padding: '16px' } }, 'Hello');
}
```

Use CSS custom properties (`var(--border)`, `var(--muted-foreground)`) from the host theme for consistent styling.

## Debugging

- **Console**: Extensions run in the browser. Use `console.log` and inspect in browser devtools.
- **Source maps**: TypeScript extensions include inline source maps. Set breakpoints in the original `.ts` file via the Sources panel.
- **Compilation errors**: Check Settings > Extensions for error details if your extension fails to compile.
- **State inspection**: Call `api.getState()` from a command callback to inspect host state.

## Limitations (v1)

- No sandboxing: client-side extensions run in the browser with full DOM access; server-side extensions run in the Node.js host process.
- No extension marketplace or auto-update mechanism.
- Storage is local-only (no sync across machines).

---

## Server-Side Data Providers

Extensions can run code on the DorkOS server. A **data provider** extension adds a `server.ts` file alongside `index.ts`, giving it Express routes, encrypted secrets, persistent storage, background scheduling, and SSE event emission — all scoped and isolated per extension.

The three tiers of server-side capability, from simplest to most powerful:

| Tier                  | What it does                                            | Requires code?                        |
| --------------------- | ------------------------------------------------------- | ------------------------------------- |
| **Declarative proxy** | Forward requests to an upstream API with auth injection | No (`dataProxy` in manifest only)     |
| **Data provider**     | Custom Express routes with full `DataProviderContext`   | Yes (`server.ts`)                     |
| **Background tasks**  | Scheduled polling with storage and SSE events           | Yes (`ctx.schedule()` in `server.ts`) |

### Creating `server.ts`

Create a `server.ts` file in your extension directory that default-exports a `register` function:

```typescript
import type { ServerExtensionRegister } from '@dorkos/extension-api/server';

const register: ServerExtensionRegister = (router, ctx) => {
  // Register routes on the scoped Express router
  router.get('/data', async (_req, res) => {
    const items = await ctx.storage.loadData();
    res.json({ data: items ?? [] });
  });

  // Optionally return a cleanup function
  return () => {
    // Called when the extension is disabled or reloaded
  };
};

export default register;
```

The `register` function receives two arguments:

- **`router`** — A scoped Express `Router` mounted at `/api/ext/{id}/`. A route registered as `router.get('/data', ...)` is reachable at `GET /api/ext/my-extension/data`.
- **`ctx`** — A `DataProviderContext` with secrets, storage, scheduling, and event emission (see below).

Server-side code is compiled to CommonJS (Node.js target) by the host using esbuild. TypeScript is supported out of the box.

### `DataProviderContext` API Reference

The `ctx` object passed to `register` provides isolated, per-extension capabilities:

#### `ctx.secrets`

Encrypted per-extension secret store. Secrets are encrypted with AES-256-GCM and stored at `{dorkHome}/extension-secrets/{id}.json`.

```typescript
// Read a secret (returns null if not set)
const apiKey = await ctx.secrets.get('api_key');

// Store a secret (encrypted, written to disk immediately)
await ctx.secrets.set('api_key', 'sk-...');

// Delete a secret
await ctx.secrets.delete('api_key');

// Check if set without decrypting
const exists = await ctx.secrets.has('api_key');
```

#### `ctx.storage`

Persistent JSON storage scoped to this extension. Data is stored at `{dorkHome}/extension-data/{id}/data.json` with atomic writes (tmp file + rename).

```typescript
// Load previously saved data (returns null if nothing stored)
const data = await ctx.storage.loadData<MyData>();

// Save data (overwrites previous)
await ctx.storage.saveData({ items, updatedAt: Date.now() });
```

Storage is shared between server-side `ctx.storage` and client-side `api.loadData()`/`api.saveData()` — they read and write the same file.

#### `ctx.schedule(intervalSeconds, fn)`

Schedule a recurring background function. Returns a cancel function.

```typescript
const cancel = ctx.schedule(60, async () => {
  const data = await fetchExternalApi();
  await ctx.storage.saveData(data);
  ctx.emit('data-updated', data);
});

// To stop the scheduled task:
cancel();
```

- **Minimum interval**: 5 seconds. Values below 5 are clamped to 5.
- **Error handling**: Errors thrown by `fn` are caught and logged, never propagated. The schedule continues running.
- **Cleanup**: All scheduled tasks are automatically cancelled when the extension is disabled or reloaded.

#### `ctx.emit(event, data)`

Broadcast an SSE event to all connected clients. Events are namespaced as `ext:{id}:{event}` on the unified SSE stream.

```typescript
ctx.emit('issues.updated', { count: 42 });
// Client receives event type: "ext:my-extension:issues.updated"
```

#### `ctx.extensionId` / `ctx.extensionDir`

```typescript
ctx.extensionId; // "my-extension" — from the manifest
ctx.extensionDir; // "/Users/kai/.dork/extensions/my-extension" — absolute path
```

### Route Conventions

Routes registered on the `router` are mounted at `/api/ext/{id}/`:

```typescript
router.get('/status', handler); // GET  /api/ext/my-ext/status
router.post('/action', handler); // POST /api/ext/my-ext/action
router.get('/deep/path', handler); // GET  /api/ext/my-ext/deep/path
```

From the client-side `index.ts`, call your server routes via `fetch`:

```typescript
const res = await fetch('/api/ext/my-extension/status');
const data = await res.json();
```

---

## Secrets

Extensions that contact external APIs need credentials. DorkOS provides an encrypted per-extension secret store with automatic settings UI generation.

### Declaring Secrets

Add a `serverCapabilities` block to `extension.json`:

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "serverCapabilities": {
    "serverEntry": "./server.ts",
    "secrets": [
      {
        "key": "api_key",
        "label": "API Key",
        "description": "Get your key at https://example.com/settings",
        "required": true
      }
    ]
  }
}
```

| Secret field  | Required | Description                                                                     |
| ------------- | -------- | ------------------------------------------------------------------------------- |
| `key`         | Yes      | Lowercase alphanumeric with underscores. Must match `^[a-z][a-z0-9_]*$`.        |
| `label`       | Yes      | Human-readable name for the settings UI.                                        |
| `description` | No       | Help text shown below the input field.                                          |
| `required`    | No       | Whether the extension cannot function without this secret. Defaults to `false`. |

### Security Properties

- **Encrypted at rest**: AES-256-GCM with a per-host derived key (scrypt). Stored at `{dorkHome}/extension-secrets/{id}.json`.
- **Per-extension isolation**: Each extension has its own encrypted file. Extensions cannot read other extensions' secrets.
- **Write-only settings UI**: The settings panel shows a masked placeholder when a secret is set. Secret values are never sent to the browser.
- **Server-only access**: Secrets are only accessible via `ctx.secrets` in `server.ts`. Client-side `index.ts` cannot read secrets.

### Settings UI Auto-Generation

When an extension declares secrets in `serverCapabilities.secrets`, DorkOS automatically generates a settings tab. Each secret gets:

- A label and optional description from the manifest
- A password input field (never displays the stored value)
- A masked indicator when a secret is set
- A clear button to remove the secret

You can also build a custom settings tab using `api.registerSettingsTab` in `index.ts` and manage secrets via the REST API:

```typescript
// List secrets (returns isSet status, never values)
GET /api/extensions/{id}/secrets

// Set a secret
PUT /api/extensions/{id}/secrets/{key}
Body: { "value": "sk-..." }

// Delete a secret
DELETE /api/extensions/{id}/secrets/{key}
```

---

## Declarative Proxy

For extensions that only need to forward requests to an external API with authentication, the **declarative proxy** avoids writing any server code. Add a `dataProxy` field to `extension.json`:

```json
{
  "id": "github-proxy",
  "name": "GitHub API Proxy",
  "version": "1.0.0",
  "serverCapabilities": {
    "secrets": [
      {
        "key": "github_token",
        "label": "GitHub Token",
        "required": true
      }
    ]
  },
  "dataProxy": {
    "baseUrl": "https://api.github.com",
    "authHeader": "Authorization",
    "authType": "Bearer",
    "authSecret": "github_token"
  }
}
```

### Configuration

| Field         | Required | Default         | Description                                                           |
| ------------- | -------- | --------------- | --------------------------------------------------------------------- |
| `baseUrl`     | Yes      | —               | Upstream API base URL.                                                |
| `authHeader`  | No       | `Authorization` | HTTP header name for the credential.                                  |
| `authType`    | No       | `Bearer`        | How the secret is formatted: `Bearer`, `Basic`, `Token`, or `Custom`. |
| `authSecret`  | Yes      | —               | Key name in the extension's secret store.                             |
| `pathRewrite` | No       | —               | Object mapping regex patterns to replacements.                        |

**Auth type formatting:**

| `authType` | Header value           |
| ---------- | ---------------------- |
| `Bearer`   | `Bearer {secret}`      |
| `Basic`    | `Basic {secret}`       |
| `Token`    | `Token {secret}`       |
| `Custom`   | `{secret}` (raw value) |

### How It Works

Proxy routes are auto-mounted at `/api/ext/{id}/proxy/*`. The proxy:

1. Strips hop-by-hop headers from the incoming request
2. Retrieves the auth secret from the encrypted store
3. Injects the formatted auth header
4. Forwards the request to `{baseUrl}/{remaining-path}`
5. Applies `pathRewrite` rules if configured
6. Returns the upstream response with its status code and content type

From the client:

```typescript
// This becomes GET https://api.github.com/user/repos
const res = await fetch('/api/ext/github-proxy/proxy/user/repos');
```

### Error Responses

| Status | Condition                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------- |
| `503`  | Required secret is not configured. Response includes a `hint` with the PUT endpoint to set it. |
| `502`  | Upstream network failure.                                                                      |

### When to Use Proxy vs Data Provider

Use **declarative proxy** when:

- You need simple API passthrough with auth injection
- No server-side data transformation is needed
- No caching, polling, or background tasks are needed

Use **data provider** (`server.ts`) when:

- You need to transform, aggregate, or cache API responses
- You need background polling with `ctx.schedule()`
- You need to emit SSE events to connected clients
- You need custom business logic beyond request forwarding

Both can coexist in the same extension — use the proxy for simple endpoints and `server.ts` routes for complex ones.

---

## Background Tasks

Background tasks use `ctx.schedule()` to poll external APIs, detect changes, and notify clients. The canonical pattern is **poll, compare, store, emit**:

```typescript
const register: ServerExtensionRegister = (router, ctx) => {
  ctx.schedule(60, async () => {
    // 1. Poll — fetch fresh data from the external API
    const apiKey = await ctx.secrets.get('api_key');
    if (!apiKey) return; // Skip if not configured
    const fresh = await fetchExternalData(apiKey);

    // 2. Compare — check if anything changed
    const prev = await ctx.storage.loadData<{ hash?: string }>();
    const hash = JSON.stringify(fresh);
    if (hash === prev?.hash) return; // No change

    // 3. Store — persist the new data
    await ctx.storage.saveData({ data: fresh, hash, updatedAt: Date.now() });

    // 4. Emit — notify connected clients
    ctx.emit('data-updated', fresh);
  });
};

export default register;
```

### Lifecycle

- **Startup**: Scheduled tasks begin running when the extension's server side is initialized (triggered by `POST /api/extensions/{id}/init-server` during client-side activation).
- **Error isolation**: If `fn` throws, the error is logged and the schedule continues. One bad tick does not stop future ticks.
- **Cleanup**: All scheduled intervals are cleared automatically when the extension is disabled, reloaded, or the server shuts down. You can also cancel manually via the returned function.
- **No overlap protection**: If a tick takes longer than the interval, the next tick fires independently. Use a flag or mutex if your task is expensive.

---

## Reference Extension: Linear Issues

The `examples/extensions/linear-issues/` directory contains a complete, production-quality extension demonstrating all three server-side tiers. It shows the authenticated user's active Linear issues on the DorkOS dashboard.

### Files

```
examples/extensions/linear-issues/
├── extension.json   # Manifest with serverCapabilities and secret declaration
├── server.ts        # Data provider: on-demand endpoint, cached endpoint, 60s polling
└── index.ts         # Client: dashboard section, settings tab for API key
```

### What It Demonstrates

**Manifest** (`extension.json`):

- `serverCapabilities.secrets` declaring a `linear_api_key` with label and description
- `serverCapabilities.serverEntry` pointing to `./server.ts`
- `contributions` for both `dashboard.sections` and `settings.tabs`

**Server** (`server.ts`):

- On-demand route (`GET /issues`) that fetches live data from the Linear GraphQL API
- Cached route (`GET /cached`) that returns the last polled result from storage
- Background polling via `ctx.schedule(60, ...)` with the poll-compare-store-emit pattern
- Secret retrieval via `ctx.secrets.get('linear_api_key')`
- SSE emission via `ctx.emit('issues.updated', data)` on change detection

**Client** (`index.ts`):

- Dashboard section fetching from the `/cached` server route
- Settings tab with write-only API key management via the secrets REST API
- Host theme integration via CSS custom properties

To install: copy the directory to `~/.dork/extensions/linear-issues/`, enable it in Settings > Extensions, then set your Linear API key in the extension's settings tab.

---

## Agent-Built Extensions

DorkOS agents (Claude Code, Cursor, Windsurf) can create and manage extensions autonomously via MCP tools. The agent writes files to disk, compiles, tests, and reloads — the user sees the result in the DorkOS client immediately. No manual file creation or settings toggling required.

### MCP Tools Reference

Six MCP tools provide the complete extension lifecycle:

| Tool                   | Parameters                                    | Description                                                        |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `get_extension_api`    | None                                          | Full ExtensionAPI type definitions and usage examples as markdown  |
| `list_extensions`      | None                                          | List all extensions with status, scope, and errors                 |
| `create_extension`     | `name`, `description?`, `template?`, `scope?` | Scaffold, compile, and enable a new extension in one step          |
| `reload_extensions`    | `id?`                                         | Recompile all extensions, or a single extension by ID (hot reload) |
| `get_extension_errors` | None                                          | Get only extensions in an error state with diagnostic details      |
| `test_extension`       | `id`                                          | Headless smoke test: compile + activate against mock API           |

### Agent Workflow

The recommended iteration loop:

```
1. get_extension_api         # Understand the API surface
2. create_extension          # Scaffold with a starter template
3. Edit index.ts             # Write the extension logic
4. test_extension            # Verify compilation and activation (headless)
5. reload_extensions --id    # Hot-reload into the running client
6. Iterate from step 3       # Fix errors, add features
```

The `create_extension` tool handles scaffolding, compilation, and enabling in a single call. After that, the edit-test-reload cycle is the core loop. Use `test_extension` for fast headless validation before triggering a visual reload.

### Template Types

The `create_extension` tool accepts a `template` parameter:

**`dashboard-card`** (default) — Registers a React component in the `dashboard.sections` slot. Produces a styled card with heading and description. Good starting point for data display extensions.

**`command`** — Registers a command palette item (`Cmd+K`). The starter template fires a toast notification on execution. Use for action-oriented extensions that do not need a persistent UI.

**`settings-panel`** — Registers a tab in the settings dialog. The starter template includes a settings panel skeleton with `loadData`/`saveData` hooks for persistence. Use for extensions that need user configuration.

**`data-provider`** — Full-stack extension with both `index.ts` (dashboard card + settings tab) and `server.ts` (Express routes + background polling). The manifest includes `serverCapabilities` with a sample secret declaration. Use for extensions that fetch from external APIs. See [Server-Side Data Providers](#server-side-data-providers) for details.

All templates include an inline API Quick Reference comment at the top of their entry files listing the most common methods and all available slot names. Templates compile and activate out of the box — the agent can modify from a known-working baseline.

### Scope: Global vs Local

The `scope` parameter controls where the extension is installed:

- **`global`** (`~/.dork/extensions/{id}/`) — Available in all projects. Use for general-purpose utilities.
- **`local`** (`.dork/extensions/{id}/` in the active CWD) — Scoped to the current project. Use for project-specific dashboards or tools.

When the same extension ID exists in both scopes, local overrides global. When the user switches projects (CWD change), local extensions are re-scanned and the client reloads automatically.

Default scope for `create_extension` is `global`.

### Error Handling

Agents can diagnose and fix errors autonomously using structured error feedback:

**Compilation errors** — Returned by `test_extension` and `reload_extensions` with file, line, and column information:

```json
{
  "status": "error",
  "phase": "compilation",
  "errors": [
    { "text": "Expected ';'", "location": { "file": "index.ts", "line": 12, "column": 5 } }
  ]
}
```

**Activation errors** — Returned by `test_extension` when the extension compiles but throws during `activate()`:

```json
{
  "status": "error",
  "phase": "activation",
  "error": "Cannot read property 'registerComponent' of undefined",
  "stack": "TypeError: ..."
}
```

**Diagnostic workflow:**

1. Call `get_extension_errors` to see all extensions with problems
2. Read the structured error (phase, message, location)
3. Edit the source file to fix the issue
4. Call `test_extension` to verify the fix (headless, sub-300ms)
5. Call `reload_extensions --id` to push the fix to the client

### What Agents Should Not Do

- **Do not `import React from 'react'`.** React is on the global scope. Bare imports produce unresolvable module specifiers at runtime. Use `import type` for type-only imports (erased at compile time).
- **Do not create `node_modules` or install npm packages.** Extensions cannot have external dependencies beyond `react`, `react-dom`, and `@dorkos/extension-api` (provided by the host).
- **Do not modify `extension.json` after creation** unless changing metadata. The `id` field must remain stable.
- **Do not write to extension directories owned by other extensions.** Each extension has an isolated directory.
- **Do not create extensions that import from `@dorkos/shared` or server internals.** Only `@dorkos/extension-api` is available at runtime.
