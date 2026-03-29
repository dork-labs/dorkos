---
title: 'Extension Server-Side Capabilities: Data Providers, Secrets, and Backend Hooks'
date: 2026-03-29
type: external-best-practices
status: active
tags:
  [
    extension-system,
    server-side,
    data-provider,
    secrets-management,
    backend-plugin,
    vscode,
    grafana,
    raycast,
    obsidian,
    backstage,
    chrome-extensions,
    directus,
    express,
  ]
feature_slug: ext-platform-server-capabilities
searches_performed: 12
sources_count: 38
---

# Extension Server-Side Capabilities: Data Providers, Secrets, and Backend Hooks

**Date**: 2026-03-29
**Research Depth**: Deep Research

---

## Research Summary

This report surveys how seven mature extension/plugin systems — VS Code, Raycast, Obsidian, Grafana, Backstage, Chrome Extensions, and Directus — solve the "extension needs backend data" problem. The central tension is the same across all of them: browser-running extension UI needs credentials and data that cannot safely live in the browser. Each system solves this differently, from VS Code's OS-keychain-backed SecretStorage (secrets in Node.js process, UI accesses via RPC) to Grafana's Go binary proxy (full server process per plugin) to Backstage's YAML-configured proxy (centralized, no plugin code on server) to Directus's `context.env`-injected environment variables. For DorkOS specifically — single-user, local Express server, file-based extensions, simplicity mandate — the cleanest approach is a thin **server-side data provider** pattern: extensions declare a server-side handler file, the Express server runs it, and the browser-side component fetches data via a scoped proxy endpoint. No OS-level keychain required; secrets live in `.dork/extension-secrets.json` encrypted at rest.

---

## Key Findings

### 1. The Core Problem is Credential Isolation, Not Architecture Complexity

Every system studied faces the same root problem: browser code cannot securely hold secrets (API keys, OAuth tokens, credentials), and users should not be required to expose their credentials to the browser layer. The solutions all route around this by making credentials live in a process the user trusts (OS keychain, server process, native app) and the browser requests data through a controlled proxy or RPC.

The architectural sophistication varies enormously — from Grafana's separate Go binary per plugin to Backstage's simple YAML proxy configuration — but the fundamental pattern is constant: **secrets stay server-side, browser gets only derived data**.

### 2. VS Code: Extension Host Holds the Secrets, SecretStorage Delegates to OS Keychain

VS Code extensions run in a separate Node.js process (the Extension Host), giving them full Node.js capabilities including network access. The `SecretStorage` API, accessed via `context.secrets`, stores credentials using Electron's `safeStorage` API which delegates to the OS keychain (macOS Keychain Access, Windows Credential Manager, Linux Keyring). Encrypted secrets are stored in a SQLite database in the VS Code user data directory, with the encryption key held in the OS keychain.

Key property: **each extension gets a namespaced secret store** (`_publisher.extensionId`). In theory this prevents cross-extension secret access, though security researchers have demonstrated that any extension in the same Extension Host can read other extensions' secrets via `SecretStorage` — the isolation is by convention, not by cryptographic boundary.

### 3. Grafana: Full Backend Process per Data Source, secureJsonData Pattern

Grafana's backend plugin system uses HashiCorp's go-plugin to spawn a separate Go binary per data source plugin, communicating via gRPC. This is the heaviest model studied.

The credentials flow is well-designed:

- Frontend config form stores non-sensitive config in `jsonData` (accessible to viewers, sent to browser)
- Frontend config form stores credentials in `secureJsonData` (encrypted on Grafana server on save, **never returned to browser again**)
- Frontend shows only `secureJsonFields` (boolean map — "is this field set?") after initial save
- Backend Go binary receives `DecryptedSecureJSONData` in every query request's instance settings
- The only browser access to external APIs with credentials goes through the data source proxy

The separation is absolute and well-enforced: `secureJsonData` is write-once from the browser's perspective. The backend has the only decryption path.

### 4. Raycast: Node.js Worker Threads, Password Preferences, Encrypted Local DB

Raycast extensions run as Node.js worker threads (v8 isolates) in a child process managed by the Raycast native app. Extensions communicate with Raycast via JSON-RPC over file descriptors.

Credentials are handled via **preference declarations** in the extension's `package.json`. Password-type preferences prompt users for values and store them in Raycast's **local encrypted database** (not the OS keychain directly, though the database encryption key may be keychain-backed). The preferences API returns the decrypted value only to the extension that declared the preference — other extensions cannot read it.

Extensions make HTTP requests directly from their Node.js worker thread — there is no proxy or relay. The isolation comes from the preference scoping, not a network boundary. Since extensions run as Node.js, they have full `fetch()` and `https` capabilities.

### 5. Backstage: YAML-Configured Proxy, No Plugin Code on Server

Backstage's proxy approach is the simplest backend integration model studied. The `proxy-backend` plugin provides a configurable HTTP proxy in the Backstage Express server. Frontend plugins call `fetchApi.fetch('/api/proxy/my-service/endpoint')`. The backend rewrites the path and adds configured headers (including static auth headers from environment variables via `${ENV_VAR}` interpolation).

There is no plugin-authored server code. All proxy configuration is declarative in `app-config.yaml`. Plugins cannot register custom Express routes — they can only use the centrally-managed proxy. The trade-off is simplicity (no server code to write) at the cost of capability (cannot transform data, apply business logic, or handle OAuth flows in the plugin itself).

A newer pattern is emerging in Backstage where plugins move from the proxy to dedicated backend plugin routes, using the `createBackendPlugin` API to register Express router handlers on the server. This gives plugins full server-side logic while keeping the plugin boundary clean.

### 6. Directus: Express Router Registration, `context.env` for Secrets

Directus endpoint extensions export a `register(router, context)` function where `router` is an Express router instance and `context` provides:

- `context.env` — parsed environment variables (the primary secret delivery mechanism)
- `context.services` — internal Directus service layer
- `context.database` — Knex instance
- `context.logger` — Pino logger

Extensions register their custom API routes as Express sub-routes mounted at `/<extension-name>`. This is the most direct model for "extension adds a server-side endpoint" — the extension literally receives a router and mounts handlers on it. Extensions are isolated using `isolated-vm` to prevent filesystem and network abuse.

The secret model is minimal: secrets live in environment variables, extensions access them via `context.env`. There is no per-extension secret store or encryption — it is fully delegated to the host process's environment.

### 7. Chrome Extensions: Service Worker, chrome.storage, No Server

Chrome extensions (Manifest V3) use a service worker as the background layer. The service worker runs in a browser context — it has `fetch()` access but no Node.js. Secrets are stored in `chrome.storage.local` (unencrypted, persisted per-extension) or `chrome.storage.session` (in-memory). There is no OS keychain integration.

For OAuth flows, the service worker handles the redirect URL and token exchange. A key architectural lesson from Chrome extensions: **the service worker can be shut down at any time** (after ~30 seconds of inactivity in MV3). This makes it unreliable for long-running background tasks. Chrome extensions solve this with the Offscreen Documents API (MV3) or by deferring to a backend service the extension calls.

Chrome's permissions model is instructive: extensions declare `"host_permissions"` for each domain they need to fetch from. The browser enforces these at runtime. This manifest-driven permission declaration is a clean pattern regardless of runtime.

### 8. Obsidian: Direct fetch() from Plugin, Settings UI for Credentials

Obsidian plugins run in the main Electron renderer process and have full `fetch()` access (CORS is not enforced in Electron's renderer for requests to external URLs — Electron disables CORS by default). Credentials are typically stored in `data.json` via `loadData()`/`saveData()`, often in plaintext in the settings object.

As of Obsidian v1.11.4, a `SecretStorage` API was added to allow plugins to store sensitive values in the OS keychain. Prior to this, the community worked around the issue with environment variable access, `.env` files, or simply accepting plaintext storage in `data.json`.

The CORS bypass via Electron is a significant architectural advantage that doesn't exist in true browser contexts. Obsidian plugins can call any external API directly without a proxy. This is only possible because Obsidian is an Electron app.

---

## Detailed Analysis

### The Secrets Management Spectrum

All systems sit on a spectrum from "no special handling" to "hardware-backed encryption":

```
No encryption          Encrypted local DB       OS Keychain (hardware-backed)
     |                        |                            |
  plaintext        Raycast preferences           VS Code safeStorage
  data.json       Directus (delegated)           Obsidian SecretStorage v1.11.4
(Obsidian pre-1.11)
```

For a single-user local application like DorkOS, the OS keychain is the gold standard but introduces complexity (platform differences, no easy programmatic access in browser context). An encrypted local file is a pragmatic middle ground that most single-user tools choose.

### The Backend Capability Models

| System    | Backend Model                    | Code Location    | Secret Access                        |
| --------- | -------------------------------- | ---------------- | ------------------------------------ |
| VS Code   | Node.js Extension Host process   | Extension bundle | `context.secrets` → OS keychain      |
| Grafana   | Separate Go binary per plugin    | Plugin binary    | `DecryptedSecureJSONData` in request |
| Raycast   | Node.js worker thread            | Extension bundle | Password preferences → encrypted DB  |
| Backstage | YAML proxy config                | No code          | `${ENV_VAR}` in config               |
| Directus  | Express router in main process   | Extension file   | `context.env`                        |
| Chrome    | Service worker (browser context) | Extension bundle | `chrome.storage`                     |
| Obsidian  | Renderer process, no separation  | Plugin bundle    | `SecretStorage` API → OS keychain    |

### The Data Provider Pattern

"Data provider" as a concept appears in different forms:

**Pull model (component requests on mount):**

- Grafana: Dashboard component calls the data source query
- Raycast: `useFetch()` hook calls external API on command open
- Backstage: `fetchApi.fetch('/api/proxy/...')` in React component `useEffect`

**Push model (server sends updates):**

- VS Code: Extension Host proactively sends messages to webview via `panel.webview.postMessage()`
- Chrome: Service worker sends messages to popup via `chrome.runtime.sendMessage()`

**Scheduled/background model (periodic refresh):**

- None of the studied systems have a first-class "scheduled background fetch and cache" primitive for UI-facing data. They all either poll on demand or use background workers (Chrome) / long-running processes (Grafana Go binary).

For DorkOS's stated use case ("fetch my Linear issues and expose them to my dashboard component"), the pull model is correct: the dashboard component renders, the data provider endpoint on the server fetches from Linear (with the stored API key), and the component displays the result. Polling and caching can be layered on top via standard TanStack Query patterns.

### How Extensions Register Server-Side Logic

The cleanest model for a local Express server is Directus's: **extension provides a `server.ts` file that exports a router registration function, the Extension Manager mounts it at a scoped path.**

```
/api/extensions/{ext-id}/...
```

This gives the extension a fully scoped namespace on the server. The extension's server code receives the DorkOS server context (config, secrets store). The extension's client code fetches from this scoped path via the existing `HttpTransport`.

### Rate Limiting and Audit Trails

No system studied has per-extension rate limiting as a first-class feature. The approaches are:

- Grafana: Rate limiting at the data source proxy level (not per-plugin)
- Backstage: Rate limiting at the proxy level (configurable)
- Chrome: Browser enforces some rate limiting on fetch per origin
- VS Code: No built-in rate limiting for Extension Host network calls

For DorkOS, rate limiting of extension server endpoints is a v2 concern. If an extension DoS's its own backend endpoint, it only affects that user (single-user system). A simple per-extension request counter in memory is sufficient if needed.

---

## VS Code Extension Host Deep Dive

### Activation Events and Lazy Loading

VS Code's activation events are the most sophisticated lazy-loading mechanism studied. Extensions declare what conditions trigger their load in `package.json`:

```json
{
  "activationEvents": [
    "onCommand:myext.hello",
    "onLanguage:typescript",
    "onView:myext.panel",
    "onStartupFinished"
  ]
}
```

`onStartupFinished` is the safe always-activate event that fires after VS Code has loaded fully. Extensions that need to register background processes use this.

For DorkOS's data provider pattern, the analog is: extension server-side code is loaded when the DorkOS server starts (always, like `onStartupFinished`). There is no need for conditional activation — the server knows which extensions are enabled and loads their server-side files at startup.

### The SecretStorage API Surface

```typescript
// Accessed via ExtensionContext during activation
const secrets = context.secrets;

// Store
await secrets.store('api-key', 'sk-abc123');

// Retrieve
const key = await secrets.get('api-key');

// Delete
await secrets.delete('api-key');

// React to changes (e.g., from another window)
secrets.onDidChange((e) => {
  console.log(`Secret ${e.key} changed`);
});
```

The namespace isolation is implicit: `context.secrets` is pre-scoped to the extension's `publisher.id`. There is no `secrets.get('other-extension:api-key')` — the other extension's namespace is simply not accessible via this API.

**Critical security finding:** Despite the API scoping, security researchers (ControlPlane, Cycode) have demonstrated that a malicious extension can use `vscode.workspace.getConfiguration()` to read other extensions' workspace state, and can traverse the SQLite database directly. The SecretStorage API provides namespace isolation at the API level but not at the storage level — all extensions share the same SQLite file. For a single-user local tool like DorkOS, this is acceptable; for a marketplace scenario, it is a known risk.

---

## Grafana Backend Plugin Deep Dive

### The secureJsonData Flow

This is the most carefully designed secrets model of all systems studied:

1. **Config time (browser):** User fills in API key field marked as `secureJsonData` in the plugin's config editor component
2. **Save (browser → server):** Config is POSTed to Grafana. Server receives `secureJsonData`, encrypts it using AES-256 with a server-managed key, stores the ciphertext. `secureJsonData` is **never returned to the browser again**. Only `secureJsonFields` (boolean: "is this field populated?") is returned
3. **Query time (backend plugin):** Grafana spawns the plugin binary, passes `DecryptedSecureJSONData` in each query request via gRPC
4. **External API call:** The Go binary uses the decrypted credentials to authenticate with the upstream API, returns data frames to Grafana

The browser has **write-only access** to secrets. This is the strongest security model of all the systems studied.

### Why This Matters for DorkOS

DorkOS is a single-user local app. The Grafana model is designed for multi-tenant cloud deployments where viewer-role users must be prevented from seeing data source credentials. For DorkOS, this level of encryption is unnecessary — the person configuring the extension IS the only user. But the **unidirectional secret flow** is still worth emulating: write in settings UI, never display again, server-only access.

---

## Raycast Deep Dive

### The Worker Thread Model

Each Raycast extension runs as a Node.js worker thread — a full v8 isolate with its own event loop, within a single Node.js child process. This provides:

- Memory isolation: Extensions can't directly read each other's heap
- Crash isolation: A crashing worker doesn't crash the parent process
- CPU fairness: Resource limits enforced per worker
- Full Node.js APIs: `fetch()`, `fs`, `crypto`, all available

This model is directly applicable to DorkOS if server-side extension code needs isolation. For DorkOS's single-user, trusted-developer use case, running extension server code in the main process (Directus model) is simpler and adequate for v1.

### Preferences vs. Secrets

Raycast distinguishes:

- **Preferences** — user-configured values, can be marked `type: "password"` for secure storage
- **Storage** — runtime key-value store per extension, uses the same encrypted DB as preferences

Password preferences are stored encrypted in Raycast's local database (not OS keychain). The value is decrypted and returned via `getPreferenceValues<Preferences>()` at extension activation time. Extensions never deal with encryption/decryption — it is fully handled by the host.

---

## Backstage Backend Plugin Deep Dive

### The Proxy vs. Custom Backend Plugin Pattern

**Original proxy pattern:**

- Config declares proxy rules in `app-config.yaml`
- Frontend calls `/api/proxy/my-service/endpoint`
- Backend rewrites path, adds auth headers from environment variables
- No server-side plugin code

**Modern backend plugin pattern (new backend system):**

```typescript
// backend-plugin.ts
export const myPlugin = createBackendPlugin({
  pluginId: 'my-plugin',
  register(env) {
    env.registerInit({
      deps: { httpRouter: coreServices.httpRouter, config: coreServices.rootConfig },
      async init({ httpRouter, config }) {
        const router = Router();
        router.get('/data', async (req, res) => {
          const apiKey = config.getString('my-plugin.apiKey'); // from app-config.yaml
          const data = await fetchFromExternalAPI(apiKey);
          res.json(data);
        });
        httpRouter.use(router);
      },
    });
  },
});
```

The modern pattern gives plugins a proper Express router while keeping secrets in the centralized config/environment system. The `coreServices.rootConfig` injects the plugin's config section from `app-config.yaml`.

### The Secret Provider Service (Emerging)

Backstage has an open issue/feature for a `SecretProviderService` for backend plugins (issue #25885). The proposed model uses entity annotations (`backstage.io/secret-account`) to select which secret account (group of credentials) a plugin uses. This is not yet GA. Currently, plugins access secrets via `config.getString('my-plugin.secretKey')` which reads from environment variables injected into the Backstage config.

---

## Chrome Extension Deep Dive

### Service Worker vs. Background Page

Manifest V3 replaces persistent background pages with ephemeral service workers. Key differences relevant to DorkOS (not directly applicable since DorkOS is a local server, but instructive):

| Aspect        | Background Page (MV2)  | Service Worker (MV3)                   |
| ------------- | ---------------------- | -------------------------------------- |
| Lifetime      | Persistent             | Ephemeral (shuts down after ~30s idle) |
| DOM access    | Yes                    | No                                     |
| Fetch         | Yes                    | Yes                                    |
| State storage | In-memory (persistent) | Must use `chrome.storage`              |
| Wake-up       | Always running         | On events only                         |

The forced ephemerality of MV3 service workers is a useful constraint that led Chrome extensions toward explicit state persistence. For DorkOS, the equivalent insight is: **extension server-side code should be stateless by default, with any persistent state delegated to the extension's data store** (the `loadData`/`saveData` pattern already established).

### Permissions Declaration

Chrome's manifest permission system is the cleanest studied:

```json
{
  "host_permissions": ["https://linear.app/*", "https://api.github.com/*"],
  "permissions": ["storage", "identity"]
}
```

The browser enforces these at the network level — a fetch to a domain not in `host_permissions` fails. This manifest-driven capability declaration is worth emulating in DorkOS's `extension.json` manifest even if the enforcement is less strict.

---

## Synthesis: Cross-Cutting Patterns

### Pattern 1: Server-Side Code Registration (The Universal Answer)

Every system that provides server-side capabilities to extensions uses some form of "extension registers a server-side handler":

| System    | Registration Mechanism                                   |
| --------- | -------------------------------------------------------- |
| VS Code   | Extension Host loads extension's `main.js` (Node.js)     |
| Grafana   | Plugin binary spawned by Go plugin manager               |
| Directus  | `register(router, context)` export in endpoint extension |
| Backstage | `createBackendPlugin` with `registerInit`                |
| Raycast   | Worker thread loaded by Raycast Node process             |

The common thread: **the host process loads and runs extension code, giving it access to the host's server context (config, secrets, services) while preventing the browser from ever seeing credentials**.

For DorkOS: an extension should be allowed to have a `server.ts` file alongside its `index.ts`. The DorkOS Extension Manager loads `server.ts` at server startup, passes it a `DataProviderContext` object (containing the extension's secrets, storage API, and a fetch helper), and mounts its returned router at `/api/extensions/{ext-id}/`.

### Pattern 2: Scoped Secret Store per Extension

Every system with robust secrets management uses extension-scoped namespacing:

| System   | Secret Namespace                                |
| -------- | ----------------------------------------------- |
| VS Code  | `publisher.extensionId`                         |
| Grafana  | Per data source instance (ID-scoped)            |
| Raycast  | Per extension (package name)                    |
| Directus | `context.env` (process-wide, not per-extension) |

For DorkOS: secrets are stored in `{dorkHome}/extension-secrets/{ext-id}.json`, encrypted with a host-managed key. Extensions access their secrets via a `DataProviderContext.secrets` API analogous to VS Code's SecretStorage. No extension can access another extension's secrets.

### Pattern 3: Write-Only Credentials in Settings UI

Grafana's write-only model (type in settings, never shown again in plaintext) is worth adopting:

- Settings UI for an extension shows a password input for API keys
- On save, the value is stored encrypted in `extension-secrets/{ext-id}.json`
- Settings UI subsequently shows "••••••••" with a "clear" button
- The extension's server-side code receives the decrypted value at request time

This prevents credential leakage via the browser network tab and is consistent with how every serious credential management system works.

### Pattern 4: Declarative Capability Manifest

All systems require extensions to declare their external dependencies upfront. Chrome's `host_permissions` is the strictest enforcement, but the declarative pattern is universal:

```json
// Proposed extension.json additions for DorkOS
{
  "id": "linear-issues",
  "name": "Linear Issues",
  "serverCapabilities": {
    "dataProviders": true,
    "externalHosts": ["https://api.linear.app"],
    "secrets": ["linear_api_key"]
  }
}
```

This declaration enables:

- Display in the extension settings UI ("this extension accesses Linear API")
- Future sandboxing (network calls to non-declared hosts blocked)
- Audit log clarity

### Pattern 5: Proxy as the Default Data Access Pattern

For extensions that only need to forward requests to an external API with authentication added, the **proxy pattern** is simpler than a full data provider:

- Backstage proxy: YAML declares `target` URL and adds `Authorization` header from env var
- Grafana data proxy: Frontend calls `datasource.fetch('/resource')`, backend adds credentials and forwards

For DorkOS, a simple proxy capability in the extension manifest could handle 80% of use cases:

```json
{
  "dataProxy": {
    "baseUrl": "https://api.linear.app",
    "authHeader": "Authorization",
    "authSecret": "linear_api_key"
  }
}
```

This would auto-generate a `/api/extensions/{ext-id}/proxy/*` route that adds the authorization header and forwards the request. No server-side code required.

### Anti-Patterns to Avoid

**Anti-pattern 1: Allowing extensions to read other extensions' secrets**
Every system studied (VS Code, Raycast, Grafana, Directus) namespaces secrets per extension. VS Code even demonstrates what happens when you don't enforce this: security researchers trivially read cross-extension secrets.

**Anti-pattern 2: Storing secrets in extension data (data.json)**
Obsidian's early approach of storing API keys in `data.json` is the canonical anti-pattern. `data.json` is often version-controlled, plaintext, and shared. Secrets need a separate store.

**Anti-pattern 3: Browser-side secret holding**
Chrome extensions that store OAuth tokens in `localStorage` or `chrome.storage.local` without encryption are vulnerable to other extensions reading them. For DorkOS, secrets must never traverse the browser API surface.

**Anti-pattern 4: Spawning a separate process per extension**
Grafana's Go binary model is powerful but heavyweight. For a single-user local tool, running extension server code in the main Node.js process is perfectly adequate and much simpler to implement and debug.

**Anti-pattern 5: Global environment variables as the only secret mechanism**
Directus's `context.env` approach works for simple setups but leaks: if two extensions both need an API key named `MY_SERVICE_KEY`, they collide. Per-extension secret stores with explicit naming are cleaner.

---

## Recommended Approach for DorkOS

### Guiding Principles (from the brief)

- Single-user, no multi-tenancy concerns
- Local Express server (not cloud-hosted)
- Extensions are file-based, not marketplace-distributed
- Existing API: React components + JSON storage
- Core value: Simplicity ("Less, but better")

### The Three-Tier Extension Capability Model

**Tier 1 — Proxy (zero server code required)**

For extensions that need to call an external API with a stored credential:

```json
// extension.json
{
  "dataProxy": {
    "baseUrl": "https://api.linear.app",
    "authHeader": "Authorization",
    "authType": "Bearer",
    "authSecret": "linear_api_key"
  }
}
```

The Extension Manager auto-generates `/api/extensions/{ext-id}/proxy/*`. The extension's browser-side component fetches from this proxy. No server-side code. The secret `linear_api_key` is configured in the extension's settings UI.

Covers: simple REST API wrappers, read-only data display.

**Tier 2 — Data Provider (server.ts with context injection)**

For extensions needing custom server-side logic (data transformation, multiple API calls, webhooks):

```typescript
// Extension's server.ts
import type { DataProviderContext } from '@dorkos/extension-api/server';
import { Router } from 'express';

export default function register(router: Router, ctx: DataProviderContext) {
  router.get('/issues', async (req, res) => {
    const apiKey = await ctx.secrets.get('linear_api_key');
    const data = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: '{ issues { nodes { id title } } }' }),
    });
    res.json(await data.json());
  });
}
```

The Extension Manager:

1. Detects `server.ts` alongside `index.ts` in the extension directory
2. Compiles it via esbuild (same pipeline as client bundle, separate output)
3. Loads it in the main Node.js process at server startup
4. Creates a `DataProviderContext` scoped to this extension
5. Mounts the returned router at `/api/extensions/{ext-id}/`

**Tier 3 — Background Task (cron-like or event-triggered)**

For extensions needing scheduled fetches or event-driven server-side work:

```typescript
// server.ts
export default function register(router: Router, ctx: DataProviderContext) {
  // Scheduled task
  ctx.schedule('*/15 * * * *', async () => {
    const data = await fetchLatestIssues(ctx);
    await ctx.storage.saveData({ issues: data, updatedAt: Date.now() });
    ctx.emit('issues.updated', data); // SSE event to connected clients
  });

  // On-demand endpoint still works
  router.get('/issues', async (req, res) => {
    const cached = await ctx.storage.loadData();
    res.json(cached);
  });
}
```

Background tasks use DorkOS's existing Pulse scheduler service (or a lighter inline `setInterval` for simple periodic fetches). The results are stored in the extension's data store and optionally pushed to connected clients via SSE.

### The DataProviderContext API

```typescript
interface DataProviderContext {
  /** Extension-scoped secret store (encrypted at rest) */
  secrets: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };

  /** Extension's persistent data store (same as client-side loadData/saveData) */
  storage: {
    loadData<T>(): Promise<T | null>;
    saveData<T>(data: T): Promise<void>;
  };

  /** Schedule recurring tasks (cron syntax or interval) */
  schedule(cronOrMs: string | number, fn: () => Promise<void>): () => void;

  /** Emit SSE event to connected browser clients */
  emit(event: string, data: unknown): void;

  /** Extension metadata */
  extensionId: string;
  extensionDir: string;
}
```

### Secret Storage Implementation

Secrets are stored in `{dorkHome}/extension-secrets/{ext-id}.json` encrypted using Node.js's built-in `crypto` module with AES-256-GCM. The encryption key is derived from a host secret in `{dorkHome}/host.key` (generated on first run, never leaves the machine).

This is simpler than OS keychain integration and sufficient for a local tool:

```typescript
// packages/shared/src/extension-secrets.ts

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function deriveKey(hostKey: Buffer): Buffer {
  return scryptSync(hostKey, 'dorkos-ext-secrets', KEY_LENGTH);
}

export function encrypt(text: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export function decrypt(ciphertext: string, key: Buffer): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
```

**Why not OS keychain:**

- macOS Keychain, Windows Credential Manager, and Linux Secret Service have different APIs
- `keytar` (the common abstraction) was removed from VS Code in 2022 due to maintenance issues
- For a local single-user tool, file-based encryption with a locally-stored key is equivalent security — if an attacker has access to the filesystem, they also have access to the keychain
- Dramatically simpler to implement and test

**Why not environment variables (Directus model):**

- Environment variables are process-wide; no per-extension namespace
- Users would need to configure them outside the DorkOS UI
- Does not support the settings UI pattern (type in the UI, DorkOS handles storage)

### Security Properties

| Property                                     | DorkOS Implementation                                    |
| -------------------------------------------- | -------------------------------------------------------- |
| Secrets isolated per extension               | `{dorkHome}/extension-secrets/{ext-id}.json`             |
| Secrets never in browser network             | Only the derived data (API responses) crosses to browser |
| Secrets encrypted at rest                    | AES-256-GCM with locally-derived key                     |
| Write-only in settings UI                    | Settings shows "••••••••" after first save               |
| Extension A can't read Extension B's secrets | Separate files, separate namespaces                      |
| Agent-written extension can't read secrets   | Secrets file separate from extension code directory      |

### Client-Side Data Consumption

The browser component fetches data from the scoped extension endpoint using the existing `HttpTransport`:

```typescript
// Extension's index.ts (browser side)
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/contexts/TransportContext';

function LinearIssuesDashboardSection() {
  const transport = useTransport();
  const { data, isLoading } = useQuery({
    queryKey: ['linear-issues', 'my-issues'],
    queryFn: () => transport.request('/api/extensions/linear-issues/issues'),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  // ... render
}
```

This reuses TanStack Query's caching and invalidation, the existing HttpTransport, and the established data-fetching patterns from `contributing/data-fetching.md`. No new client-side infrastructure needed.

### Extension Manifest Changes

```json
// extension.json additions
{
  "id": "linear-issues",
  "name": "Linear Issues",
  "version": "1.0.0",
  "minHostVersion": "0.10.0",

  // NEW: declares server-side capabilities
  "serverCapabilities": {
    // file that exports register(router, ctx) — optional
    "serverEntry": "./server.ts",

    // declared for UI display and future sandboxing
    "externalHosts": ["https://api.linear.app"],

    // secrets this extension requires (shown in settings UI)
    "secrets": [
      {
        "key": "linear_api_key",
        "label": "Linear API Key",
        "description": "Found at Linear → Settings → API → Personal API keys",
        "required": true
      }
    ]
  }
}
```

### The Settings UI Secret Configuration Flow

1. User opens Settings → Extensions → Linear Issues
2. Extension settings panel shows declared secrets with password inputs
3. User types API key → clicks Save
4. Client POSTs `{ key: 'linear_api_key', value: 'lin_api_...' }` to `PUT /api/extensions/linear-issues/secrets/linear_api_key`
5. Server encrypts and writes to `{dorkHome}/extension-secrets/linear-issues.json`
6. Client receives `{ set: true }` — the plaintext value is never stored client-side
7. Settings UI shows "••••••••" with a Clear button

---

## Sources & Evidence

### VS Code

- [VS Code SecretStorage API](https://code.visualstudio.com/api/references/vscode-api#SecretStorage) — Official API reference
- [How to use SecretStorage in VS Code extensions](https://dev.to/kompotkot/how-to-use-secretstorage-in-your-vscode-extensions-2hco) — Practical guide with examples
- [VS Code Extension Storage Explained](https://medium.com/@krithikanithyanandam/vs-code-extension-storage-explained-the-what-where-and-how-3a0846a632ea) — Storage options overview
- [Where VS Code extension secrets are stored](https://github.com/microsoft/vscode-discussions/discussions/748) — GitHub discussion on storage location
- [VS Code Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host) — Extension isolation architecture
- [Activation Events](https://code.visualstudio.com/api/references/activation-events) — Lazy loading system
- [Abusing VSCode: Malicious Extensions and Stolen Credentials](https://control-plane.io/posts/abusing-vscode-from-malicious-extensions-to-stolen-credentials-part-2/) — Cross-extension secret access vulnerability

### Grafana

- [Grafana Backend Plugin Architecture](https://grafana.com/developers/plugin-tools/key-concepts/backend-plugins/) — Go binary, gRPC, HashiCorp plugin system
- [Add Authentication for Data Source Plugins](https://grafana.com/developers/plugin-tools/how-to-guides/data-source-plugins/add-authentication-for-data-source-plugins) — secureJsonData flow, write-only from browser
- [Build a Backend Data Source Plugin](https://grafana.com/developers/plugin-tools/tutorials/build-a-data-source-backend-plugin) — QueryData handler, DecryptedSecureJSONData
- [How to Implement Grafana Backend Plugins (2026)](https://oneuptime.com/blog/post/2026-01-30-grafana-backend-plugins/view) — Current implementation guide
- [Grafana Plugin System (DeepWiki)](https://deepwiki.com/grafana/grafana/11-plugin-system) — SystemJS loading, shared packages

### Raycast

- [How Raycast API and Extensions Work](https://www.raycast.com/blog/how-raycast-api-extensions-work) — Worker thread model, JSON-RPC, React render tree
- [Raycast Security Documentation](https://developers.raycast.com/information/security) — Encrypted DB, extension isolation
- [Raycast Preferences API](https://developers.raycast.com/api-reference/preferences) — Password type preferences
- [Raycast useFetch Hook](https://developers.raycast.com/utilities/react-hooks/usefetch) — stale-while-revalidate data fetching

### Backstage

- [Backstage Proxying Documentation](https://backstage.io/docs/plugins/proxying/) — YAML proxy config, credential modes
- [Using the Backstage Proxy from Within a Plugin](https://backstage.io/docs/tutorials/using-backstage-proxy-within-plugin/) — Frontend usage patterns
- [Secret Provider Service Feature Request](https://github.com/backstage/backstage/issues/25885) — Per-plugin secrets proposal
- [Backstage Authentication](https://backstage.io/docs/auth/) — Authentication model overview

### Directus

- [Directus Endpoints Extension](https://directus.io/docs/guides/extensions/api-extensions/endpoints) — `register(router, context)` API
- [Proxy an External API in Directus](https://directus.io/docs/tutorials/extensions/proxy-an-external-api-in-a-custom-endpoint-extension) — Proxy pattern with credentials
- [Directus Extension System (DeepWiki)](https://deepwiki.com/directus/directus/3.7-asset-processing-and-transformation) — Extension Manager, isolated-vm sandbox

### Chrome Extensions

- [Service Workers in Chrome MV3](https://codimite.ai/blog/service-workers-in-chrome-extensions-mv3-powering-background-functionality/) — Background execution model
- [Chrome Extension OAuth Flow](https://developer.chrome.com/docs/extensions/mv3/tut_oauth) — OAuth in service workers
- [Chrome Extension Permissions Architecture](https://voicewriter.io/blog/the-architecture-of-chrome-extension-permissions-a-deep-dive) — host_permissions, declarative model

### Obsidian

- [Obsidian Secret Storage Forum](https://forum.obsidian.md/t/cross-platform-secure-storage-for-secrets-and-tokens-that-can-be-syncd/100716) — Community discussion on secure storage
- [Obsidian SecretStorage API (v1.11.4+)](https://github.com/logancyang/obsidian-copilot/issues/2162) — New native API
- [Obsidian Network Request Discussion](https://forum.obsidian.md/t/make-http-requests-from-plugins/15461) — CORS bypass via Electron

### Prior DorkOS Research (Cross-Referenced)

- `research/20260323_plugin_extension_ui_architecture_patterns.md` — UI-side architecture for all systems
- `research/20260326_extension_system_open_questions.md` — Storage, caching, lifecycle patterns
- `research/20260326_extension_point_registry_patterns.md` — Registry, typed slots, FSD initialization
- `research/20260326_agent_built_extensions_phase4.md` — Agent-written extensions, security model

---

## Research Gaps & Limitations

- **Figma plugin backend capabilities** — Figma's plugin sandbox (Web Worker + proxy approach) was not researched. Figma plugins have a similar problem (browser context needs external data) and their solution may be instructive.
- **Tauri extension model** — If DorkOS moves toward a desktop app, Tauri's command system (Rust backend with TypeScript frontend) has a well-designed capability declaration system worth studying.
- **keytar alternatives for Node.js** — Since `keytar` is deprecated, the best current approach for OS keychain access from Node.js was not deeply researched. `@napi-rs/keyring` is a candidate but its maintenance status is uncertain.
- **Worker threads for extension isolation** — If DorkOS adds extension sandboxing in v2, Node.js Worker Threads (Raycast model) would be the isolation mechanism. The `vm` module and `isolated-vm` (Directus model) are alternatives worth comparing.
- **TanStack Query integration patterns** — How the client-side extension component should use TanStack Query to poll or subscribe to the extension's server endpoint was not deeply researched; this should be addressed in the spec.

---

## Contradictions & Disputes

- **OS keychain vs encrypted file** — VS Code and Obsidian use OS keychain for secrets. This provides hardware-backed security on modern systems. File-based AES encryption (recommended for DorkOS) is computationally equivalent but lacks the OS access control boundary. For a local tool where the attacker model is "script that reads files," both are equivalent. For a tool where the attacker model is "process injection," OS keychain is stronger. For DorkOS's single-user local context, file-based encryption is the pragmatic choice.
- **In-process vs isolated process for extension server code** — Directus runs extension code in an `isolated-vm` sandbox within the main process. VS Code uses a separate process. For DorkOS, in-process is simpler; if an extension crashes the server, a restart is trivially cheap for a single-user tool. This may need revisiting if extensions grow in complexity.

---

## Search Methodology

- Searches performed: 12
- Most productive search terms: "Grafana backend plugin secureJsonData", "Raycast extension worker thread architecture", "Directus endpoint extension register router context", "VS Code SecretStorage Electron safeStorage SQLite"
- Primary source types: Official documentation (grafana.com, raycast.com, backstage.io, directus.io, code.visualstudio.com), DeepWiki code analysis, security research blogs
- Key supplementary source: Prior cached research (`20260323_plugin_extension_ui_architecture_patterns.md`) provided substantial baseline on UI architecture, allowing this report to focus entirely on server-side and secrets aspects
