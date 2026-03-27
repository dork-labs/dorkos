# Phase 3: Extension System Core — Task Breakdown

**Spec:** `specs/ext-platform-03-extension-system/02-specification.md`
**Generated:** 2026-03-26
**Mode:** Full decomposition

---

## Summary

| Phase     | Name                             | Tasks  | Size    |
| --------- | -------------------------------- | ------ | ------- |
| 1         | Foundation                       | 3      | 1M + 2S |
| 2         | Server Discovery & Compilation   | 4      | 4L      |
| 3         | Client Loader & API Factory      | 3      | 3L      |
| 4         | Settings UI & Polish             | 2      | 1L + 1M |
| 5         | Sample Extension & Documentation | 1      | 1M      |
| **Total** |                                  | **13** |         |

## Parallel Opportunities

- **Phase 1**: All three tasks (1.1, 1.2, 1.3) can run in parallel
- **Phase 2**: Tasks 2.1 and 2.2 can run in parallel (both depend only on Phase 1). Task 2.3 depends on both. Task 2.4 depends on 2.3.
- **Phase 3**: Sequential (3.1 → 3.2 → 3.3)
- **Phase 4**: Tasks 4.1 and 4.2 can run in parallel (both depend on 3.3 and 2.4)
- **Phase 5**: Sequential, depends on Phase 4

**Maximum parallelism**: 3 tasks at once (Phase 1), then 2 at once (Phase 2 start, Phase 4).

---

## Phase 1: Foundation

### Task 1.1 — Create packages/extension-api with types, interfaces, and manifest schema

**Size:** Medium | **Priority:** High | **Parallel with:** 1.2, 1.3

Create the `packages/extension-api/` package that defines the public contract for extensions. Contains:

- `ExtensionManifestSchema` — Zod schema for `extension.json`
- `ExtensionAPI` interface — 13 methods + 1 field
- `ExtensionRecord`, `ExtensionRecordPublic`, `ExtensionStatus`, `ExtensionModule` types
- Barrel `index.ts` re-exporting all public types
- Manifest schema tests (valid, invalid, edge cases)

**Files created:**

- `packages/extension-api/package.json`
- `packages/extension-api/tsconfig.json`
- `packages/extension-api/src/index.ts`
- `packages/extension-api/src/extension-api.ts`
- `packages/extension-api/src/manifest-schema.ts`
- `packages/extension-api/src/types.ts`
- `packages/extension-api/src/__tests__/manifest-schema.test.ts`

**Verification:** `pnpm typecheck` passes, manifest schema tests pass.

---

### Task 1.2 — Add extensions config section to UserConfigSchema

**Size:** Small | **Priority:** High | **Parallel with:** 1.1, 1.3

Add `extensions: { enabled: string[] }` section to `UserConfigSchema` in `packages/shared/src/config-schema.ts`. Extensions are disabled by default — the `enabled` array is an allowlist.

**Files modified:**

- `packages/shared/src/config-schema.ts`

**Verification:** `pnpm typecheck` passes, `USER_CONFIG_DEFAULTS` includes `extensions: { enabled: [] }`.

---

### Task 1.3 — Wire extension-api package into turbo.json and add semver dependency

**Size:** Small | **Priority:** High | **Parallel with:** 1.1, 1.2

- Verify `packages/extension-api/` is picked up by workspace glob
- Add `semver` + `@types/semver` to server
- Add `@dorkos/extension-api` as dependency to server and client
- Verify esbuild availability in server

**Files modified:**

- `apps/server/package.json`
- `apps/client/package.json`

**Verification:** `turbo run build --filter=@dorkos/extension-api` succeeds, `pnpm typecheck` passes.

---

## Phase 2: Server Discovery & Compilation

### Task 2.1 — Implement ExtensionDiscovery service

**Size:** Large | **Priority:** High | **Depends on:** 1.1, 1.2, 1.3 | **Parallel with:** 2.2

Filesystem scanning service. Scans `{dorkHome}/extensions/` (global) and `{cwd}/.dork/extensions/` (local). Parses manifests with `ExtensionManifestSchema`, checks version compatibility with `semver.gte()`, applies enabled/disabled status from config.

**Files created:**

- `apps/server/src/services/extensions/extension-discovery.ts`
- `apps/server/src/services/extensions/index.ts`
- `apps/server/src/services/extensions/__tests__/extension-discovery.test.ts`

**Key behaviors:**

- Local overrides global by extension ID
- Invalid manifests get `status: 'invalid'` with structured error
- Incompatible versions get `status: 'incompatible'`
- Non-existent directories return empty array (no throw)

---

### Task 2.2 — Implement ExtensionCompiler service

**Size:** Large | **Priority:** High | **Depends on:** 1.1, 1.2, 1.3 | **Parallel with:** 2.1

TypeScript compilation with esbuild and content-hash-based caching.

**Files created:**

- `apps/server/src/services/extensions/extension-compiler.ts`
- `apps/server/src/services/extensions/__tests__/extension-compiler.test.ts`

**Key behaviors:**

- Entry point resolution: `index.js` (pre-compiled) > `index.ts` (compile)
- Cache key: SHA-256 content hash (first 16 hex chars)
- Cache location: `{dorkHome}/cache/extensions/{ext-id}.{hash}.js`
- Compilation errors cached as `.error.json`
- Stale cache cleanup on startup (7+ days old)
- Bundle size warning at 500KB
- Externals: `react`, `react-dom`, `@dorkos/extension-api`

---

### Task 2.3 — Implement ExtensionManager service

**Size:** Large | **Priority:** High | **Depends on:** 2.1, 2.2

Lifecycle orchestrator combining Discovery + Compiler + ConfigManager.

**Files created:**

- `apps/server/src/services/extensions/extension-manager.ts`
- `apps/server/src/services/extensions/__tests__/extension-manager.test.ts`

**Key behaviors:**

- State machine: discovered → disabled/enabled → compiled/compile_error → active/activate_error
- Enable/disable persists to `config.extensions.enabled` via ConfigManager
- `updateCwd()` returns diff of added/removed extension IDs
- `listPublic()` strips server-internal fields (`path`, `sourceHash`)
- `readBundle()` serves compiled code for compiled/active extensions

---

### Task 2.4 — Add routes/extensions.ts with all 7 REST endpoints

**Size:** Large | **Priority:** High | **Depends on:** 2.3

All 7 endpoints + server initialization wiring.

**Files created:**

- `apps/server/src/routes/extensions.ts`
- `apps/server/src/routes/__tests__/extensions.test.ts`

**Files modified:**

- `apps/server/src/index.ts` (import, initialize, mount)

**Endpoints:**

| Method | Path                          | Description          |
| ------ | ----------------------------- | -------------------- |
| GET    | `/api/extensions`             | List all extensions  |
| POST   | `/api/extensions/:id/enable`  | Enable extension     |
| POST   | `/api/extensions/:id/disable` | Disable extension    |
| POST   | `/api/extensions/reload`      | Re-scan filesystem   |
| GET    | `/api/extensions/:id/bundle`  | Serve compiled JS    |
| GET    | `/api/extensions/:id/data`    | Read extension data  |
| PUT    | `/api/extensions/:id/data`    | Write extension data |

---

## Phase 3: Client Loader & API Factory

### Task 3.1 — Implement extension-api-factory.ts

**Size:** Large | **Priority:** High | **Depends on:** 1.1, 2.4

Factory function constructing per-extension API objects wrapping host primitives.

**Files created:**

- `apps/client/src/layers/features/extensions/model/extension-api-factory.ts`
- `apps/client/src/layers/features/extensions/model/types.ts`
- `apps/client/src/layers/features/extensions/__tests__/extension-api-factory.test.ts`

**Key behaviors:**

- All `register*` calls tracked in cleanups array (Obsidian cleanup model)
- Component contributions adapted to Phase 2 registry's per-slot shapes
- Command IDs namespaced: `ext:{extId}:{commandId}`
- State projected from `activeCwd`, `activeSessionId`, `activeAgentId`
- Storage via `fetch` to `/api/extensions/{id}/data`

---

### Task 3.2 — Implement extension-loader.ts

**Size:** Large | **Priority:** High | **Depends on:** 3.1

Client-side loader: fetch list, dynamic import, activate, track.

**Files created:**

- `apps/client/src/layers/features/extensions/model/extension-loader.ts`
- `apps/client/src/layers/features/extensions/__tests__/extension-loader.test.ts`

**Key behaviors:**

- Filters to `status === 'compiled' && bundleReady === true`
- Parallel loading via `Promise.all`
- Dynamic import with `/* @vite-ignore */` comment
- `activate()` return value stored as `deactivate` if function
- `deactivateAll()` calls all deactivate + cleanup functions

---

### Task 3.3 — Implement ExtensionProvider and integrate into main.tsx

**Size:** Large | **Priority:** High | **Depends on:** 3.2

React context provider + app tree integration.

**Files created:**

- `apps/client/src/layers/features/extensions/model/extension-context.ts`
- `apps/client/src/layers/features/extensions/index.ts`

**Files modified:**

- `apps/client/src/main.tsx` (add ExtensionProvider to provider tree)
- `apps/client/src/app/init-extensions.ts` (register Extensions settings tab)

**Provider placement:**

```
QueryClientProvider → TransportProvider → ExtensionProvider → PasscodeGateWrapper → RouterProvider
```

---

## Phase 4: Settings UI & Polish

### Task 4.1 — Implement ExtensionsSettingsTab and ExtensionCard

**Size:** Large | **Priority:** Medium | **Depends on:** 3.3 | **Parallel with:** 4.2

Settings dialog tab showing all extensions with status, toggles, reload.

**Files created:**

- `apps/client/src/layers/features/extensions/ui/ExtensionsSettingsTab.tsx`
- `apps/client/src/layers/features/extensions/ui/ExtensionCard.tsx`
- `apps/client/src/layers/features/extensions/__tests__/ExtensionsSettingsTab.test.tsx`

**Card displays:** name, version, description, scope badge, author, status indicator, enable/disable toggle.

**Status handling:**

- Normal: no indicator
- `compile_error`: warning icon + error message
- `incompatible`: warning icon + version message, toggle disabled
- `activate_error`: error icon + "Activation failed"

---

### Task 4.2 — Implement CWD change handling

**Size:** Medium | **Priority:** Medium | **Depends on:** 2.4, 3.3 | **Parallel with:** 4.1

Detect extension set changes on CWD switch, emit SSE event, show toast, reload page.

**Files modified:**

- Server CWD change handler (route or event handler)
- `ExtensionProvider` or dedicated hook (SSE listener)

**Flow:**

1. Server re-scans on CWD change
2. If extension IDs changed: emit `extensions-changed` SSE event
3. Client shows toast "Project extensions changed. Reloading..." (1.5s)
4. Client calls `location.reload()`
5. If no change: do nothing

---

## Phase 5: Sample Extension & Documentation

### Task 5.1 — Create hello-world sample extension and authoring guide

**Size:** Medium | **Priority:** Low | **Depends on:** 4.1

Working sample extension + brief authoring guide.

**Files created:**

- `examples/extensions/hello-world/extension.json`
- `examples/extensions/hello-world/index.ts`
- `examples/extensions/hello-world-js/extension.json`
- `examples/extensions/hello-world-js/index.js`
- `contributing/extension-authoring.md`

**hello-world demonstrates:**

- `registerComponent` (dashboard section)
- `registerCommand` (command palette item)
- `subscribe` (state change listener)
- `loadData`/`saveData` (persistent storage)
- `notify` (toast notification)
- Cleanup via returned function

**hello-world-js demonstrates:** pre-compiled JavaScript path (no TypeScript).

---

## Dependency Graph

```
Phase 1 (parallel):
  1.1 ─┐
  1.2 ─┼─→ Phase 2
  1.3 ─┘

Phase 2:
  2.1 ─┐
       ├─→ 2.3 ─→ 2.4
  2.2 ─┘

Phase 3 (sequential):
  1.1 + 2.4 → 3.1 → 3.2 → 3.3

Phase 4 (parallel):
  3.3 + 2.4 → 4.1
  3.3 + 2.4 → 4.2

Phase 5:
  4.1 → 5.1
```

**Critical path:** 1.1 → 2.1 → 2.3 → 2.4 → 3.1 → 3.2 → 3.3 → 4.1 → 5.1 (9 tasks)
