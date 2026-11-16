# Task Breakdown: Server-Side Extension Hooks + Linear Issue Status Extension

**Spec:** `specs/linear-issue-status-extension/02-specification.md`
**Generated:** 2026-03-29
**Mode:** Full decomposition

---

## Summary

| Phase     | Name                                | Tasks  | Size Estimate    |
| --------- | ----------------------------------- | ------ | ---------------- |
| 1         | Foundation                          | 5      | 1L + 3M + 1S     |
| 2         | Server Runtime                      | 4      | 1L + 2M + 1S     |
| 3         | Declarative Proxy                   | 1      | 1L               |
| 4         | Linear Extension + Templates + Docs | 4      | 1L + 3M          |
| **Total** |                                     | **14** | **4L + 8M + 2S** |

---

## Critical Path

```
1.1 (manifest) ──┬──→ 1.3 (discovery) ──→ 2.2 (manager lifecycle) ──→ 2.3 (route delegation) ──→ 4.2 (linear ext)
                  │                                 ↑
1.2 (secrets) ────┼──→ 1.5 (secrets API) ──→ 2.1 (context factory) ──┘
                  │
                  └──→ 1.4 (compiler) ──────────────┘
```

Phases 1 and 2 are strictly sequential (2 depends on 1). Within each phase, some tasks run in parallel.

---

## Phase 1: Foundation

### 1.1 — Add serverCapabilities and dataProxy to extension manifest schema

- **Size:** Medium | **Priority:** High
- **Dependencies:** None | **Parallel with:** 1.2
- **Files:** `packages/extension-api/src/manifest-schema.ts`, `packages/extension-api/src/types.ts`, `packages/extension-api/src/index.ts`
- **Summary:** Add `SecretDeclarationSchema`, `DataProxySchema`, `ServerCapabilitiesSchema` to the manifest Zod schema. Add `hasServerEntry`, `hasDataProxy`, `serverEntryPath` to `ExtensionRecord` and `ExtensionRecordPublic`. Export new types. Fix all construction sites.

### 1.2 — Implement encrypted ExtensionSecretStore with AES-256-GCM

- **Size:** Large | **Priority:** High
- **Dependencies:** None | **Parallel with:** 1.1
- **Files:** `packages/shared/src/extension-secrets.ts` (NEW), `packages/extension-api/src/server-extension-api.ts` (NEW), `packages/extension-api/package.json`
- **Summary:** AES-256-GCM encrypted per-extension secret store. Host key auto-generates at `{dorkHome}/host.key` with 0o600 permissions. Per-extension files at `{dorkHome}/extension-secrets/{ext-id}.json`. Derived key cached per-process. Also creates the `SecretStore`, `DataProviderContext`, and `ServerExtensionRegister` types in the extension-api package.

### 1.3 — Add server.ts detection to extension discovery

- **Size:** Small | **Priority:** High
- **Dependencies:** 1.1 | **Parallel with:** 1.4
- **Files:** `apps/server/src/services/extensions/extension-discovery.ts`
- **Summary:** After manifest parsing, check for `server.ts`/`server.js` at the declared (or default) entry path. Populate `hasServerEntry`, `hasDataProxy`, and `serverEntryPath` on the returned `ExtensionRecord`.

### 1.4 — Add compileServer() method to ExtensionCompiler for Node.js target

- **Size:** Medium | **Priority:** High
- **Dependencies:** 1.1 | **Parallel with:** 1.3
- **Files:** `apps/server/src/services/extensions/extension-compiler.ts`
- **Summary:** New `compileServer()` method using esbuild with `platform: 'node'`, `target: 'node20'`, `format: 'cjs'`. Server bundles cached in `{cacheDir}/server/`. External packages: express, @dorkos/extension-api, @dorkos/extension-api/server. Cache cleanup covers both client and server directories.

### 1.5 — Add secrets API endpoints to extension routes

- **Size:** Medium | **Priority:** High
- **Dependencies:** 1.1, 1.2 | **Parallel with:** None
- **Files:** `apps/server/src/routes/extensions.ts`
- **Summary:** Three new endpoints: `GET /:id/secrets` (list with isSet booleans, never values), `PUT /:id/secrets/:key` (set, validates key is declared in manifest), `DELETE /:id/secrets/:key` (remove). Uses ExtensionSecretStore.

---

## Phase 2: Server Runtime

### 2.1 — Implement DataProviderContext factory with schedule and emit

- **Size:** Medium | **Priority:** High
- **Dependencies:** 1.2, 1.5 | **Parallel with:** None
- **Files:** `apps/server/src/services/extensions/extension-server-api-factory.ts` (NEW)
- **Summary:** Factory function building per-extension `DataProviderContext`: scoped secrets (ExtensionSecretStore), shared storage (same path as client loadData/saveData), interval-based scheduler (5s floor), SSE emit via EventFanOut. Internal `_getScheduledCleanups()` for lifecycle management.

### 2.2 — Add server extension lifecycle to ExtensionManager

- **Size:** Large | **Priority:** High
- **Dependencies:** 1.3, 1.4, 2.1 | **Parallel with:** None
- **Files:** `apps/server/src/services/extensions/extension-manager.ts`, `apps/server/src/routes/extensions.ts`
- **Summary:** `initializeServer()` compiles server bundle, loads via require(), calls register(router, ctx). `shutdownServer()` cancels scheduled tasks and calls cleanup. `getServerRouter()` returns active router. Wire into enable/disable/reload flows. Add POST `/:id/init-server` endpoint. Initialize all enabled server extensions on startup.

### 2.3 — Add dynamic route delegation middleware for /api/ext/:id/\*

- **Size:** Medium | **Priority:** High
- **Dependencies:** 2.2 | **Parallel with:** 2.4
- **Files:** `apps/server/src/routes/extension-delegation.ts` (NEW), Express app setup
- **Summary:** Mount `/api/ext/:id` middleware that delegates to extension's registered router. Validates extension ID, returns 404 for unknown extensions. SSE extension events use existing unified stream (no new endpoint). Separate namespace from `/api/extensions` (lifecycle).

### 2.4 — Update client-side extension loader for server lifecycle coordination

- **Size:** Small | **Priority:** Medium
- **Dependencies:** 2.2 | **Parallel with:** 2.3
- **Files:** `apps/client/src/layers/features/extensions/model/extension-loader.ts`
- **Summary:** After client-side activation, POST `/api/extensions/:id/init-server` for extensions with `hasServerEntry` or `hasDataProxy`. Non-blocking: server init failure logs warning but does not prevent client activation. Disable/reload handled server-side (no additional client code).

---

## Phase 3: Declarative Proxy

### 3.1 — Implement declarative proxy middleware for dataProxy manifest config

- **Size:** Large | **Priority:** Medium
- **Dependencies:** 1.1, 1.2, 2.2 | **Parallel with:** None
- **Files:** `apps/server/src/services/extensions/extension-proxy.ts` (NEW), `apps/server/src/services/extensions/extension-manager.ts`
- **Summary:** `createProxyRouter()` auto-generates proxy routes from manifest `dataProxy` config. Routes at `/proxy/*` forward to upstream with auth header injection. Supports Bearer/Basic/Token/Custom auth types. 503 for missing secrets, 502 for upstream failure. Path rewriting and query string forwarding. Integrated with initializeServer for proxy-only and hybrid extensions.

---

## Phase 4: Linear Extension + Templates + Docs

### 4.1 — Add data-provider template to extension scaffolding

- **Size:** Medium | **Priority:** Medium
- **Dependencies:** 2.2 | **Parallel with:** 4.2, 4.3
- **Files:** `apps/server/src/services/extensions/extension-templates.ts`, `apps/server/src/services/extensions/extension-manager.ts`
- **Summary:** New `data-provider` template generates `extension.json` (with serverCapabilities), `index.ts` (fetches from server), and `server.ts` (register pattern with sample route). Update `generateManifest()`, `generateTemplate()`, `createExtension()`. New `generateServerTemplate()` function.

### 4.2 — Build Linear Issues reference extension

- **Size:** Large | **Priority:** Medium
- **Dependencies:** 2.2, 2.3 | **Parallel with:** 4.1, 4.3
- **Files:** `examples/extensions/linear-issues/extension.json` (NEW), `examples/extensions/linear-issues/server.ts` (NEW), `examples/extensions/linear-issues/index.ts` (NEW)
- **Summary:** Reference extension with manifest declaring Linear API secret, server.ts with /issues and /cached routes plus 60s background polling, and index.ts with dashboard section (issue list with status dots) and settings tab (write-only API key entry). Validates all three tiers.

### 4.3 — Update MCP extension tools for server-side capabilities

- **Size:** Medium | **Priority:** Medium
- **Dependencies:** 2.2, 4.1 | **Parallel with:** 4.2
- **Files:** `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts`
- **Summary:** Update `EXTENSION_API_REFERENCE` with server-side docs (DataProviderContext, serverCapabilities, dataProxy). Add `data-provider` to create_extension template enum. Add `hasServerEntry`/`hasDataProxy` to list_extensions output. Add server compilation check to test_extension.

### 4.4 — Update extension authoring documentation

- **Size:** Medium | **Priority:** Low
- **Dependencies:** 4.1, 4.2 | **Parallel with:** None
- **Files:** `contributing/extension-authoring.md`
- **Summary:** Add sections for: Server-Side Hooks (register pattern, DataProviderContext), Secrets (declaration, encryption, write-only UI), Declarative Proxy (config, auth types, path rewriting), Background Tasks (schedule, error handling, cleanup), Reference Extension walkthrough.

---

## Dependency Graph

```
Phase 1:
  1.1 ──┬──→ 1.3 ──┐
        └──→ 1.4 ──┤
  1.2 ──┬──→ 1.5 ──┤
        └──────────┘
                    │
Phase 2:            ▼
  2.1 (needs 1.2, 1.5)
  2.2 (needs 1.3, 1.4, 2.1)
  2.3 (needs 2.2) ──┐
  2.4 (needs 2.2)   │
                     │
Phase 3:             │
  3.1 (needs 1.1, 1.2, 2.2)
                     │
Phase 4:             ▼
  4.1 (needs 2.2) ──┬──→ 4.4
  4.2 (needs 2.2, 2.3)──┘
  4.3 (needs 2.2, 4.1)
```

## New Files Created

| File                                                                  | Phase |
| --------------------------------------------------------------------- | ----- |
| `packages/shared/src/extension-secrets.ts`                            | 1.2   |
| `packages/extension-api/src/server-extension-api.ts`                  | 1.2   |
| `apps/server/src/services/extensions/extension-server-api-factory.ts` | 2.1   |
| `apps/server/src/routes/extension-delegation.ts`                      | 2.3   |
| `apps/server/src/services/extensions/extension-proxy.ts`              | 3.1   |
| `examples/extensions/linear-issues/extension.json`                    | 4.2   |
| `examples/extensions/linear-issues/server.ts`                         | 4.2   |
| `examples/extensions/linear-issues/index.ts`                          | 4.2   |

## Modified Files

| File                                                                         | Tasks    |
| ---------------------------------------------------------------------------- | -------- |
| `packages/extension-api/src/manifest-schema.ts`                              | 1.1      |
| `packages/extension-api/src/types.ts`                                        | 1.1      |
| `packages/extension-api/src/index.ts`                                        | 1.1      |
| `packages/extension-api/package.json`                                        | 1.2      |
| `packages/shared/package.json`                                               | 1.2      |
| `apps/server/src/services/extensions/extension-discovery.ts`                 | 1.3      |
| `apps/server/src/services/extensions/extension-compiler.ts`                  | 1.4      |
| `apps/server/src/routes/extensions.ts`                                       | 1.5, 2.2 |
| `apps/server/src/services/extensions/extension-manager.ts`                   | 2.2, 3.1 |
| `apps/client/src/layers/features/extensions/model/extension-loader.ts`       | 2.4      |
| `apps/server/src/services/extensions/extension-templates.ts`                 | 4.1      |
| `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts` | 4.3      |
| `contributing/extension-authoring.md`                                        | 4.4      |
