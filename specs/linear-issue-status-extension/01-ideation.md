---
slug: linear-issue-status-extension
number: 192
created: 2026-03-29
status: ideation
---

# Server-Side Extension Hooks + Linear Issue Status Extension

**Slug:** linear-issue-status-extension
**Author:** Claude Code
**Date:** 2026-03-29
**Branch:** preflight/linear-issue-status-extension

---

## 1) Intent & Assumptions

- **Task brief:** Build a DorkOS extension that connects to the Linear API and shows issue status. Rather than building a one-off server proxy, enhance the extension system itself to support server-side capabilities — then build the Linear extension as the first consumer of that capability.
- **Assumptions:**
  - The extension system enhancement is the primary deliverable; the Linear extension validates it
  - Server-side extension code runs in the main Node.js process (no worker thread isolation in v1)
  - Secrets are encrypted at rest using AES-256-GCM with a host-managed key (not OS keychain)
  - Extensions declare server capabilities in `extension.json` (manifest-driven)
  - Client-side extension components consume server data via scoped HTTP endpoints
  - The existing extension client-side API (`registerComponent`, `loadData`, etc.) remains unchanged
- **Out of scope:**
  - Worker thread isolation for server-side extension code (v2)
  - OS keychain integration for secrets (v2)
  - Extension marketplace or distribution system
  - OAuth flow handling (extensions use personal API tokens for now)
  - Real-time Linear webhooks (the background task tier uses polling, not push)

---

## 2) Pre-reading Log

- `contributing/extension-authoring.md`: Complete extension dev guide. Extensions are browser-only today (React + JSON storage). MCP tools manage lifecycle. No server-side code support.
- `packages/extension-api/src/extension-api.ts`: Full ExtensionAPI interface — 8 UI slots, `registerComponent()`, `registerCommand()`, `loadData()`/`saveData()`, `subscribe()`, `notify()`, `getState()`.
- `packages/extension-api/src/manifest-schema.ts`: Zod schema for `extension.json`. Current fields: `id`, `name`, `version`, `description`, `author`, `minHostVersion`, `contributions`, `permissions`.
- `apps/server/src/services/extensions/extension-manager.ts`: Server-side lifecycle — discovery, compilation (esbuild), enable/disable, testing. Key injection points identified at `initialize()`, `reload()`, `enable()`/`disable()`.
- `apps/server/src/services/extensions/extension-compiler.ts`: esbuild compilation pipeline. Currently targets browser only. Needs parallel `buildServer()` method for Node.js target.
- `apps/server/src/services/extensions/extension-discovery.ts`: Filesystem scanning of global (`~/.dork/extensions/`) and local (`.dork/extensions/`) directories. Parses manifest, applies version checks. Needs to detect `server.ts` alongside `index.ts`.
- `apps/server/src/routes/extensions.ts`: REST endpoints for extension CRUD, bundle serving, data storage. Route pattern: `/api/extensions/:id/*`.
- `apps/client/src/layers/features/extensions/model/extension-api-factory.ts`: Constructs per-extension API by wrapping host primitives. Automatic cleanup tracking.
- `apps/client/src/layers/features/extensions/model/extension-loader.ts`: Client-side loading — fetches extension list, imports bundles, calls `activate()`.
- `apps/client/src/layers/widgets/dashboard/model/dashboard-contributions.tsx`: 5 built-in dashboard sections with priority ordering. Extensions register via `dashboard.sections` slot.
- `apps/client/src/layers/features/dashboard-status/model/use-subsystem-status.ts`: Pattern for composing health data from entity hooks via TanStack Query.
- `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts`: MCP tools for agent-managed extension lifecycle (create, reload, test, list, errors).
- `research/20260218_linear-domain-model.md`: Linear hierarchy is Workspace → Teams → Issues. Issues are identified by `{TEAM_KEY}-{NUMBER}`, have WorkflowState (per-team), assignee, priority (0-4).
- `research/20260328_linear_mcp_server.md`: Linear operates an official MCP server at `https://mcp.linear.app/mcp` with 21+ tools. Uses OAuth 2.1 or API key auth.
- `research/20260329_extension_server_side_capabilities.md`: Deep research across 7 extension systems (VS Code, Grafana, Raycast, Backstage, Directus, Chrome, Obsidian). Recommends three-tier model with Directus-style `register(router, ctx)` pattern and encrypted per-extension secrets.
- `research/20260329_linear_issue_status_extension_architecture.md`: Linear GraphQL API research. Recommends server-side proxy with `LINEAR_API_KEY` env var. Approach superseded by extension system enhancement decision.

---

## 3) Codebase Map

- **Primary components/modules:**
  - `packages/extension-api/src/extension-api.ts` — ExtensionAPI type contract
  - `packages/extension-api/src/manifest-schema.ts` — Manifest Zod schema
  - `apps/server/src/services/extensions/extension-manager.ts` — Server lifecycle orchestrator
  - `apps/server/src/services/extensions/extension-compiler.ts` — esbuild compilation
  - `apps/server/src/services/extensions/extension-discovery.ts` — Filesystem scanning + manifest parsing
  - `apps/server/src/routes/extensions.ts` — REST API for extensions
  - `apps/client/src/layers/features/extensions/model/extension-api-factory.ts` — Per-extension API construction
  - `apps/client/src/layers/features/extensions/model/extension-loader.ts` — Client-side bundle loading
  - `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts` — MCP tools for agents
  - `apps/server/src/services/extensions/extension-templates.ts` — Code generation for scaffolding

- **Shared dependencies:**
  - `packages/extension-api/` — Cross-package type definitions
  - `packages/shared/src/` — Would host `extension-secrets.ts` utilities
  - TanStack Query (client data fetching pattern)
  - esbuild (compilation pipeline)

- **Data flow (proposed):**

  ```
  Extension server.ts → register(router, ctx) → mounts at /api/ext/{id}/*
                                                        ↓
  Extension index.ts → fetch('/api/ext/{id}/issues') → server route handler
                                                        ↓
                                              ctx.secrets.get('linear_api_key')
                                                        ↓
                                              fetch('https://api.linear.app/graphql')
                                                        ↓
                                              JSON response → React component
  ```

- **Feature flags/config:** None currently. New env vars: none required (secrets are per-extension, not env vars).

- **Potential blast radius:**
  - Direct: 8 files (extension-api types, manifest schema, manager, compiler, discovery, routes, loader, templates)
  - New files: ~5 (server API factory, secrets store, server API types, proxy middleware, Linear example extension)
  - Indirect: MCP tools (need server lifecycle tools), extension authoring docs
  - Tests: New test files for server hooks, secrets, proxy, compiler changes

---

## 4) Root Cause Analysis

N/A — this is a feature, not a bug fix.

---

## 5) Research

### Extension System Patterns (38 sources across 7 systems)

**The universal pattern:** Secrets live server-side, browser only sees derived data. Every mature extension system routes around the browser's inability to securely hold credentials by making credentials live in a server process and exposing data through a controlled proxy or RPC.

**Closest model for DorkOS: Directus** — `register(router, context)` pattern where the extension receives an Express router and a context object with secrets, storage, and services. Extensions mount custom routes as sub-routes. Simple, direct, no process isolation overhead.

**Secrets management spectrum:**

```
No encryption         Encrypted local DB        OS Keychain
     |                       |                       |
  plaintext          Raycast preferences      VS Code safeStorage
  data.json          DorkOS (proposed)         Obsidian v1.11.4+
```

**Anti-patterns identified:**

1. Allowing cross-extension secret access (VS Code vulnerability)
2. Storing secrets in `data.json` (Obsidian pre-1.11)
3. Browser-side credential holding
4. Separate process per extension (Grafana — overkill for single-user)
5. Global env vars as only secret mechanism (namespace collisions)

### Linear API Research (22 sources)

- **API:** GraphQL at `https://api.linear.app/graphql`
- **Auth:** Personal API keys (Bearer token) or OAuth 2.0
- **Rate limits:** 1,500 requests/hour for personal keys, complexity-based query limits
- **Key queries:** `issues` (filterable by assignee, team, state), `workflowStates` (per-team), `teams`
- **Polling recommendation:** 60s interval for dashboard use case
- **Data model:** Issue has `identifier`, `title`, `state` (WorkflowState), `priority` (0-4), `assignee`, `team`, `project`

### Potential Solutions

**The Three-Tier Extension Capability Model:**

**Tier 1 — Proxy (zero server code)**

Declare target URL + auth in manifest. Extension Manager auto-generates proxy routes. Covers simple REST wrappers.

```json
{
  "dataProxy": {
    "baseUrl": "https://api.linear.app",
    "authHeader": "Authorization",
    "authType": "Bearer",
    "authSecret": "linear_api_key"
  }
}
```

- **Pros:** Zero server code, instant for simple APIs, declarative
- **Cons:** No data transformation, no multi-call orchestration, no GraphQL
- **Complexity:** Low
- **Maintenance:** Low

**Tier 2 — Data Provider (server.ts with context injection)**

Extension provides `server.ts` exporting `register(router, ctx)`. Full Express router with `DataProviderContext` (secrets, storage, extension metadata).

```typescript
export default function register(router: Router, ctx: DataProviderContext) {
  router.get('/issues', async (req, res) => {
    const apiKey = await ctx.secrets.get('linear_api_key');
    // Custom GraphQL query, data transformation, etc.
  });
}
```

- **Pros:** Full flexibility, custom logic, multiple endpoints, data transformation
- **Cons:** Requires server-side TypeScript, larger surface area
- **Complexity:** Medium
- **Maintenance:** Medium

**Tier 3 — Background Task (scheduled + SSE push)**

Scheduled fetches via `ctx.schedule()` + SSE push via `ctx.emit()`. Results cached in extension storage.

```typescript
export default function register(router: Router, ctx: DataProviderContext) {
  ctx.schedule('*/1 * * * *', async () => {
    const data = await fetchLatestIssues(ctx);
    await ctx.storage.saveData({ issues: data, updatedAt: Date.now() });
    ctx.emit('issues.updated', data);
  });
}
```

- **Pros:** Real-time dashboards, cached responses, event-driven updates
- **Cons:** More complexity, scheduling infrastructure, SSE plumbing
- **Complexity:** Medium-High
- **Maintenance:** Medium

### Recommendation

**Build all three tiers.** Tier 1 (proxy) handles 80% of simple cases with zero code. Tier 2 (data provider) covers the Linear use case and any complex API integration. Tier 3 (background tasks) enables real-time dashboards. The tiers share infrastructure (secrets, route mounting, manifest schema) so building them together is more efficient than revisiting the extension system three times.

---

## 6) Decisions

| #   | Decision                     | Choice                                                               | Rationale                                                                                                                                                                                                                                                            |
| --- | ---------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Architecture approach        | D — Enhance extension system                                         | User chose: building a proper platform capability rather than a one-off proxy. More work upfront, but every future extension benefits from server-side hooks, secrets, and background tasks.                                                                         |
| 2   | MVP scope                    | All three tiers (proxy + data provider + background task)            | User chose: ship the full vision. Tiers share infrastructure (secrets, route mounting, manifest), so incremental builds would revisit the same files repeatedly. One pass is more efficient.                                                                         |
| 3   | Server-side execution model  | In-process (Directus model)                                          | Research consensus: for a single-user local tool, running extension server code in the main Node.js process is adequate. Worker thread isolation (Raycast model) is a v2 concern if extensions grow complex. Crashing the server is trivially cheap to recover from. |
| 4   | Secrets management           | Encrypted per-extension files (AES-256-GCM)                          | Research consensus: file-based encryption with host-managed key. Not OS keychain (platform differences, no `keytar`). Not env vars (no per-extension namespace). Grafana's write-only model for settings UI. Stored at `{dorkHome}/extension-secrets/{ext-id}.json`. |
| 5   | Server-side API pattern      | `register(router, ctx: DataProviderContext)` export from `server.ts` | Directus model mapped directly to DorkOS. Extension receives Express router + context with secrets, storage, scheduler, event emitter. Routes mounted at `/api/ext/{id}/*`.                                                                                          |
| 6   | Client-side data consumption | Native `fetch()` to scoped extension routes                          | Extensions use `fetch('/api/ext/{id}/issues')` from React components. No new client-side API method needed — standard `fetch` + TanStack Query patterns work. Could add `api.serverFetch(path)` helper later for DX.                                                 |
| 7   | Manifest schema additions    | `serverCapabilities` object in `extension.json`                      | Declares `serverEntry`, `externalHosts`, `secrets` (with labels/descriptions for settings UI), and `dataProxy` config. Enables: settings UI generation, future sandboxing, audit clarity.                                                                            |
| 8   | Route namespace              | `/api/ext/{id}/*` for extension routes                               | Separate from `/api/extensions/` (lifecycle management). Short, clean, collision-free. Middleware validates extension is active before routing.                                                                                                                      |
| 9   | Linear extension scope       | Dashboard section + settings tab                                     | Shows "My Issues" (assigned to current user) with status badges, priority dots, team labels. Settings tab for API key entry. Polls every 60s via TanStack Query.                                                                                                     |

---

## 7) Integration Seam Map

Files that need modification (from codebase deep-dive):

| Component           | File                                                                         | Change                                                  |
| ------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| Manifest schema     | `packages/extension-api/src/manifest-schema.ts`                              | Add `serverCapabilities`, `dataProxy` fields            |
| Server API types    | `packages/extension-api/src/server-extension-api.ts` (NEW)                   | `DataProviderContext` interface                         |
| Secrets utility     | `packages/shared/src/extension-secrets.ts` (NEW)                             | AES-256-GCM encrypt/decrypt                             |
| Extension discovery | `apps/server/src/services/extensions/extension-discovery.ts`                 | Detect `server.ts`, add `hasServerEntry` flag           |
| Extension compiler  | `apps/server/src/services/extensions/extension-compiler.ts`                  | Add `buildServer()` for Node.js target                  |
| Extension manager   | `apps/server/src/services/extensions/extension-manager.ts`                   | Server lifecycle: init/shutdown, `serverExtensions` map |
| Server API factory  | `apps/server/src/services/extensions/extension-server-api-factory.ts` (NEW)  | Build `DataProviderContext` per extension               |
| Extension routes    | `apps/server/src/routes/extensions.ts`                                       | Dynamic `/api/ext/:id/*` delegation middleware          |
| Proxy middleware    | `apps/server/src/services/extensions/extension-proxy.ts` (NEW)               | Auto-generated proxy from `dataProxy` manifest          |
| Extension loader    | `apps/client/src/layers/features/extensions/model/extension-loader.ts`       | Coordinate server init/shutdown with client activation  |
| Extension templates | `apps/server/src/services/extensions/extension-templates.ts`                 | Server template generation                              |
| MCP tools           | `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts` | Server lifecycle tools                                  |
| Documentation       | `contributing/extension-authoring.md`                                        | Server-side hooks section                               |

---

## 8) DataProviderContext API (Proposed)

```typescript
interface DataProviderContext {
  /** Extension-scoped secret store (encrypted at rest) */
  secrets: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };

  /** Extension's persistent data store (same backing as client loadData/saveData) */
  storage: {
    loadData<T>(): Promise<T | null>;
    saveData<T>(data: T): Promise<void>;
  };

  /** Schedule recurring tasks (cron syntax or interval in ms) */
  schedule(cronOrMs: string | number, fn: () => Promise<void>): () => void;

  /** Emit SSE event to connected browser clients */
  emit(event: string, data: unknown): void;

  /** Extension metadata */
  extensionId: string;
  extensionDir: string;
}
```

---

## 9) Manifest Schema (Proposed)

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

---

## 10) Security Properties

| Property                       | Implementation                                                         |
| ------------------------------ | ---------------------------------------------------------------------- |
| Secrets isolated per extension | `{dorkHome}/extension-secrets/{ext-id}.json`                           |
| Secrets never in browser       | Only derived data (API responses) crosses to browser                   |
| Secrets encrypted at rest      | AES-256-GCM with host key at `{dorkHome}/host.key`                     |
| Write-only in settings UI      | Shows `••••••••` after first save, clear button to reset               |
| Cross-extension isolation      | Separate files, separate namespaces, API-level enforcement             |
| Server code in-process         | No isolation boundary (acceptable for single-user, trusted extensions) |
