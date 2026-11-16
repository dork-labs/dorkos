# Task Breakdown: Phase 4 — Agent-Built Extensions

Generated: 2026-03-27
Source: specs/ext-platform-04-agent-extensions/02-specification.md

## Overview

Phase 4 enables DorkOS agents to autonomously build, install, and manage extensions via MCP tools. Six MCP tools provide the complete lifecycle: listing, scaffolding with slot-specific templates, compilation with structured error feedback, headless smoke testing, and live hot reload via SSE. The implementation is decomposed into 3 phases with 14 tasks.

**Phase 1 (Core MCP Tools)**: Wire the extension manager into MCP deps, implement the 4 core tools (`list_extensions`, `create_extension`, `reload_extensions`, `get_extension_errors`), add `createExtension()` and `reloadExtension()` methods to ExtensionManager, and write unit tests.

**Phase 2 (Agent DX Improvements)**: Add `get_extension_api` and `test_extension` tools, implement `testExtension()` with MockExtensionAPI, add SSE `extension_reloaded` event broadcasting, implement client-side per-extension hot reload, and write tests.

**Phase 3 (Integration & Documentation)**: End-to-end integration test and contributing guide updates.

---

## Phase 1: Core MCP Tools

### Task 1.1: Add extensionManager to McpToolDeps and wire it in mcp-server.ts

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: None

Add `extensionManager?: ExtensionManager` to the `McpToolDeps` interface in `apps/server/src/services/runtimes/claude-code/mcp-tools/types.ts`. Wire the actual `ExtensionManager` instance into the `mcpToolDeps` object in `apps/server/src/index.ts` using the same `...(extensionManager && { extensionManager })` spread pattern used for other optional services.

**Files changed**:

- `apps/server/src/services/runtimes/claude-code/mcp-tools/types.ts` — add optional field + import type
- `apps/server/src/index.ts` — add spread to mcpToolDeps assembly

---

### Task 1.2: Implement list_extensions MCP tool handler

**Size**: Small | **Priority**: High | **Dependencies**: 1.1 | **Parallel with**: None

Create `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts` with the `createListExtensionsHandler` factory and register `list_extensions` in `mcp-server.ts`. Returns formatted extension list with id, name, version, status, scope, bundleReady, optional description and error.

**Files changed**:

- `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts` — **NEW**
- `apps/server/src/services/core/mcp-server.ts` — import and register tool

---

### Task 1.3: Implement createExtension() method on ExtensionManager

**Size**: Large | **Priority**: High | **Dependencies**: 1.1 | **Parallel with**: None

Add `createExtension()` to `ExtensionManager` that scaffolds a new extension directory with `extension.json` manifest and `index.ts` from one of 3 slot-specific templates (`dashboard-card`, `command`, `settings-panel`), then triggers discovery, compilation, and auto-enable. Includes the `CreateExtensionResult` type, manifest generator, 3 template generators, and `toPascalCase`/`toTitleCase` helpers.

**Files changed**:

- `apps/server/src/services/extensions/extension-manager.ts` — add method, types, templates

---

### Task 1.4: Implement create_extension MCP tool handler

**Size**: Medium | **Priority**: High | **Dependencies**: 1.2, 1.3 | **Parallel with**: None

Add `createCreateExtensionHandler` to `extension-tools.ts` and register `create_extension` in `mcp-server.ts`. Parameters: `name` (required, kebab-case regex), `description` (optional), `template` (optional, default `dashboard-card`), `scope` (optional, default `local`). Returns `created: true` with path, status, and helpful message.

**Files changed**:

- `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts` — add handler
- `apps/server/src/services/core/mcp-server.ts` — register tool with Zod schema

---

### Task 1.5: Implement reloadExtension(id) method on ExtensionManager

**Size**: Medium | **Priority**: High | **Dependencies**: 1.1 | **Parallel with**: 1.3

Add `reloadExtension(id)` to `ExtensionManager` for per-extension targeted recompilation. Skips discovery, only recompiles the specified extension. Returns `ReloadExtensionResult` with status, bundleReady, sourceHash, and structured error array.

**Files changed**:

- `apps/server/src/services/extensions/extension-manager.ts` — add method and `ReloadExtensionResult` type

---

### Task 1.6: Implement reload_extensions MCP tool handler

**Size**: Medium | **Priority**: High | **Dependencies**: 1.2, 1.5 | **Parallel with**: None

Add `createReloadExtensionsHandler` to `extension-tools.ts` and register `reload_extensions` in `mcp-server.ts`. Supports full reload (no args) and single-extension reload (with `id`). Returns `{ results: {...}, summary: { total, compiled, errors } }`.

**Files changed**:

- `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts` — add handler
- `apps/server/src/services/core/mcp-server.ts` — register tool

---

### Task 1.7: Implement get_extension_errors MCP tool handler

**Size**: Small | **Priority**: Medium | **Dependencies**: 1.2 | **Parallel with**: 1.4, 1.5, 1.6

Add `createGetExtensionErrorsHandler` to `extension-tools.ts` and register `get_extension_errors` in `mcp-server.ts`. Returns `{ id, status, error }` where error is the structured error object or `null`.

**Files changed**:

- `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts` — add handler
- `apps/server/src/services/core/mcp-server.ts` — register tool

---

### Task 1.8: Unit tests for Phase 1 tools and ExtensionManager methods

**Size**: Large | **Priority**: High | **Dependencies**: 1.4, 1.5, 1.6, 1.7 | **Parallel with**: None

Write unit tests for all 4 Phase 1 MCP tool handlers and the `createExtension()` and `reloadExtension()` methods.

**Files created**:

- `apps/server/src/services/runtimes/claude-code/mcp-tools/__tests__/extension-tools.test.ts` — handler tests (20+ scenarios)
- `apps/server/src/services/extensions/__tests__/extension-manager-create.test.ts` — createExtension() tests (10 scenarios)
- `apps/server/src/services/extensions/__tests__/extension-manager-reload.test.ts` — reloadExtension() tests (5 scenarios)

---

## Phase 2: Agent DX Improvements

### Task 2.1: Implement get_extension_api MCP tool handler

**Size**: Medium | **Priority**: Medium | **Dependencies**: 1.2 | **Parallel with**: 2.2

Add `createGetExtensionApiHandler` with a hardcoded `EXTENSION_API_REFERENCE` string constant containing the full ExtensionAPI type definitions and usage examples as markdown. Does NOT require `extensionManager` to be initialized.

**Files changed**:

- `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts` — add constant + handler
- `apps/server/src/services/core/mcp-server.ts` — register tool

---

### Task 2.2: Implement testExtension() method on ExtensionManager with MockExtensionAPI

**Size**: Large | **Priority**: Medium | **Dependencies**: 1.5 | **Parallel with**: 2.1

Add `testExtension(id)` to `ExtensionManager` that compiles an extension and activates it against a `MockExtensionAPI` stub. The mock counts registrations per slot without connecting to any real UI. Returns `TestExtensionResult` with contribution counts or error details.

**Files changed**:

- `apps/server/src/services/extensions/extension-manager.ts` — add `MockExtensionAPI` class, `testExtension()` method, `TestExtensionResult` type

---

### Task 2.3: Implement test_extension MCP tool handler

**Size**: Small | **Priority**: Medium | **Dependencies**: 2.2 | **Parallel with**: None

Add `createTestExtensionHandler` to `extension-tools.ts` and register `test_extension` in `mcp-server.ts`. Returns `testExtension()` result directly as JSON.

**Files changed**:

- `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts` — add handler
- `apps/server/src/services/core/mcp-server.ts` — register tool

---

### Task 2.4: Add SSE extension_reloaded event broadcast from server

**Size**: Medium | **Priority**: Medium | **Dependencies**: 1.6 | **Parallel with**: 2.1, 2.2

Add `GET /api/extensions/events` SSE endpoint and a `broadcastExtensionReloaded()` function in `routes/extensions.ts`. Update reload and create handlers to call the broadcast after successful compilation.

**Files changed**:

- `apps/server/src/routes/extensions.ts` — add SSE endpoint + broadcast function
- `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts` — call broadcast after reload/create

---

### Task 2.5: Client-side per-extension hot reload via SSE event

**Size**: Large | **Priority**: Medium | **Dependencies**: 2.4 | **Parallel with**: None

Add `reloadExtensions(ids)` method to `ExtensionLoader` for targeted hot reload (deactivate, re-import with cache-bust URL, reactivate). Update `ExtensionProvider` to subscribe to `extension_reloaded` SSE events via `EventSource` and trigger hot reload.

**Files changed**:

- `apps/client/src/layers/features/extensions/model/extension-loader.ts` — add `reloadExtensions()` method
- `apps/client/src/layers/features/extensions/model/extension-context.tsx` — add `useRef` for loader, SSE subscription effect

---

### Task 2.6: Unit tests for Phase 2 tools and client hot reload

**Size**: Large | **Priority**: Medium | **Dependencies**: 2.1, 2.2, 2.3, 2.5 | **Parallel with**: None

Write tests for `get_extension_api`, `test_extension` handlers, `MockExtensionAPI`, `testExtension()`, and client-side `reloadExtensions()`.

**Files changed/created**:

- `apps/server/src/services/runtimes/claude-code/mcp-tools/__tests__/extension-tools.test.ts` — add Phase 2 handler tests
- `apps/server/src/services/extensions/__tests__/extension-manager-test.test.ts` — **NEW** (MockExtensionAPI + testExtension tests)
- `apps/client/src/layers/features/extensions/model/__tests__/extension-loader-reload.test.ts` — **NEW** (hot reload tests)

---

## Phase 3: Integration & Documentation

### Task 3.1: End-to-end integration test for extension lifecycle

**Size**: Large | **Priority**: Medium | **Dependencies**: 1.8, 2.6 | **Parallel with**: 3.2

Integration test using a real temp filesystem, real `ExtensionManager` and `ExtensionCompiler`. Tests: create all 3 template types, list after create, reload after edit, structured errors for broken code, get_extension_api content, test_extension contributions, duplicate rejection. 11 test scenarios.

**Files created**:

- `apps/server/src/services/core/__tests__/mcp-extension-tools.test.ts` — **NEW**

---

### Task 3.2: Update contributing docs with agent extension workflow

**Size**: Small | **Priority**: Low | **Dependencies**: 2.6 | **Parallel with**: 3.1

Update `contributing/architecture.md` with Extension MCP Tools section (tool table + iteration loop). Update `contributing/api-reference.md` with all 6 MCP tool parameter schemas, return types, and SSE event documentation.

**Files changed**:

- `contributing/architecture.md` — add Extension MCP Tools subsection
- `contributing/api-reference.md` — add Extension MCP Tools + SSE Events sections

---

## Summary

| Phase                                | Tasks        | Size Breakdown                                                                                             |
| ------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------- |
| Phase 1: Core MCP Tools              | 8 tasks      | 2 small, 3 medium, 3 large                                                                                 |
| Phase 2: Agent DX Improvements       | 6 tasks      | 2 small, 3 medium, 1 large → wait, recounting: 1 small (2.3), 2 medium (2.1, 2.4), 3 large (2.2, 2.5, 2.6) |
| Phase 3: Integration & Documentation | 2 tasks      | 1 small, 1 large                                                                                           |
| **Total**                            | **16 tasks** |                                                                                                            |

## Dependency Graph

```
1.1 ─→ 1.2 ─→ 1.4 ─→ 1.8
  │      │              ↑
  │      ├→ 1.7 ────────┤
  │      ├→ 2.1 ─→ 2.6 ─→ 3.1
  │      │              ↑   ↑
  ├→ 1.3 → 1.4          │   │
  │                      │   │
  ├→ 1.5 ─→ 1.6 ─→ 1.8 │   │
  │    │              │   │  │
  │    └→ 2.2 → 2.3 → 2.6  │
  │                         │
  └→ 1.6 → 2.4 → 2.5 → 2.6 → 3.2
```
