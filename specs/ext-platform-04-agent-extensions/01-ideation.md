---
slug: ext-platform-04-agent-extensions
number: 184
created: 2026-03-26
status: ideation
---

# Phase 4: Agent-Built Extensions

**Slug:** ext-platform-04-agent-extensions
**Author:** Claude Code
**Date:** 2026-03-26
**Branch:** preflight/ext-platform-04-agent-extensions

---

## Source Brief

`specs/ext-platform-04-agent-extensions/00-brief.md` — Phase 4 of the Extensibility Platform project. All specific details (acceptance criteria, settled decisions, deliverables) preserved from the brief.

---

## 1) Intent & Assumptions

- **Task brief:** Enable DorkOS agents to autonomously build, install, and manage extensions via MCP tools. The agent writes TypeScript files to the extensions directory, triggers a reload, and the user sees the result immediately. This is the core DorkOS differentiator — no other agent platform lets the AI extend its own host application's UI at runtime.
- **Assumptions:**
  - Phase 3 (Extension System Core) is implemented: discovery, esbuild compilation with content-hash caching, extension point registry, activation/deactivation lifecycle
  - Phase 1 (Agent UI Control & Canvas) provides the rendering infrastructure for extension contributions
  - The `packages/extension-api/` package defines the ExtensionAPI surface extensions use
  - The existing MCP server at `/mcp` (Streamable HTTP, stateless) is the integration point for external agents
  - The audience is developers who trust their agents (Kai persona) — no sandboxing needed
- **Out of scope:**
  - Extension marketplace, sharing, or publishing
  - Sandboxed execution environments (wrong risk model for v1)
  - Non-TypeScript extensions
  - Runtime `npm install` of extension dependencies
  - Extension-to-extension dependencies

---

## 2) Pre-reading Log

- `specs/ext-platform-04-agent-extensions/00-brief.md`: Phase 4 brief — settled decisions, open questions, acceptance criteria
- `specs/ext-platform-03-extension-system/02-specification.md`: Complete Phase 3 spec — discovery, compilation, lifecycle, API surface
- `decisions/0201-extension-storage-separate-from-code.md`: Extension data lives at `{dorkHome}/extension-data/{ext-id}/data.json`
- `decisions/0202-esbuild-content-hash-compilation-cache.md`: SHA-256 content hash (first 16 chars) as cache key at `{dorkHome}/cache/extensions/{ext-id}.{hash}.js`
- `decisions/0203-extension-api-includes-ui-control-for-phase-4.md`: v1 ExtensionAPI includes UI control methods for Phase 4 readiness
- `research/20260323_plugin_extension_ui_architecture_patterns.md`: Obsidian full-trust model, VS Code Extension Host isolation
- `research/20260326_extension_system_open_questions.md`: Deep research validating storage, caching, version compatibility, and dependency decisions
- `research/20260326_agent_built_extensions_phase4.md`: Phase 4 research — API context delivery, templates, security, hot reload, file watchers, iteration speed, testing
- `contributing/architecture.md`: Hexagonal architecture, MCP server integration patterns
- `apps/server/src/services/core/mcp-server.ts`: MCP tool registration patterns (handler factory + `McpToolDeps` + `jsonContent` responses)
- `apps/server/src/services/extensions/extension-discovery.ts`: Scans global/local directories, validates manifests, checks version compat
- `apps/server/src/services/extensions/extension-compiler.ts`: esbuild compilation with content-hash caching, structured error capture
- `apps/server/src/services/extensions/extension-manager.ts`: Lifecycle orchestration, enable/disable, public API for routes
- `apps/server/src/routes/extensions.ts`: REST routes — list, enable, disable, reload, bundle serving, data read/write
- `packages/extension-api/src/extension-api.ts`: ExtensionAPI interface — component registration, UI control, state access, storage, notifications
- `packages/extension-api/src/manifest-schema.ts`: Zod schema for `extension.json`
- `apps/client/src/layers/features/extensions/model/extension-api-factory.ts`: Creates ExtensionAPI instances wrapping HTTP calls
- `apps/client/src/layers/features/extensions/model/extension-loader.ts`: Dynamic `import()` of compiled bundles, calls `activate()`
- `apps/client/src/layers/features/extensions/model/extension-context.tsx`: React context managing loaded extensions, cleanup on unmount

---

## 3) Codebase Map

**Primary Components/Modules:**

| File                                                                        | Role                                                                                                                             |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/services/extensions/extension-discovery.ts`                | Scans `{dorkHome}/extensions/` and `{cwd}/.dork/extensions/` for `extension.json`, validates manifests, merges local over global |
| `apps/server/src/services/extensions/extension-compiler.ts`                 | esbuild TypeScript compilation with content-hash caching; caches errors as `.error.json`                                         |
| `apps/server/src/services/extensions/extension-manager.ts`                  | Orchestrates discovery + compilation; manages enable/disable lifecycle                                                           |
| `apps/server/src/routes/extensions.ts`                                      | REST routes: list, enable, disable, reload, bundle serving, data CRUD                                                            |
| `apps/server/src/services/core/mcp-server.ts`                               | MCP tool registration hub — all domain tools registered here                                                                     |
| `packages/extension-api/src/extension-api.ts`                               | `ExtensionAPI` interface: `registerComponent`, `registerCommand`, UI control, storage, notifications                             |
| `packages/extension-api/src/manifest-schema.ts`                             | Zod schema for `extension.json` manifest                                                                                         |
| `packages/extension-api/src/types.ts`                                       | `ExtensionRecord`, `ExtensionStatus`, `ExtensionModule` types                                                                    |
| `apps/client/src/layers/features/extensions/model/extension-loader.ts`      | Dynamic `import()` of compiled bundles, invokes `activate(api)`                                                                  |
| `apps/client/src/layers/features/extensions/model/extension-context.tsx`    | React context managing loaded extensions, cleanup functions per extension                                                        |
| `apps/client/src/layers/features/extensions/model/extension-api-factory.ts` | Creates `ExtensionAPI` instances wrapping HTTP calls and dispatcher                                                              |

**Shared Dependencies:**

- `@dorkos/extension-api` — exported types and schemas used by both server and client
- `@dorkos/shared/config-schema` — `extensions.enabled` config section
- `esbuild` — TypeScript compilation
- `semver` — version compatibility checking
- `zod` — manifest validation

**Data Flow:**

```
Agent writes .ts → extensions directory on disk
  → reload_extensions MCP tool called
  → Server: extension-discovery scans → extension-compiler compiles with esbuild (~10ms)
  → Content-hash cached bundle served via GET /api/extensions/:id/bundle
  → SSE event: extension_reloaded pushed to connected clients
  → Client: dynamic import() with hash-busted URL → activate(api) called
  → Extension registers components via api.registerComponent()
  → React re-renders affected extension point slots
  → User sees result (~200-500ms total from reload trigger)
```

**Feature Flags/Config:**

- `extensions.enabled: string[]` in `UserConfigSchema` — allowlist of enabled extension IDs
- Host version `0.1.0` hardcoded in `extension-discovery.ts`

**Potential Blast Radius:**

- **Direct:** MCP server tool registration (new file), extension manager methods (additions), SSE event types (new event)
- **Indirect:** Extension routes (may need new endpoints for scaffolding), client extension context (reload notification handling)
- **Tests:** Extension service tests, MCP tool tests (new), route tests

---

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

---

## 5) Research

### 5.1 Agent API Context Delivery

Three complementary layers address different failure modes:

1. **Scaffolded inline comments** — `create_extension` generates `index.ts` with compact API reference in JSDoc. Survives context truncation. Zero marginal cost.
2. **`get_extension_api` MCP tool** — Returns the raw `ExtensionAPI` type definitions + usage examples as text. Agent calls explicitly when needed. Most reliable cross-agent approach.
3. **System prompt context block** — Lightweight (~200 tokens) block in agent context covering slot names and the creation workflow. References the MCP tool for full API.

**Recommendation:** Implement layers 1 + 2. Layer 1 is part of scaffolding. Layer 2 is one MCP tool (~15 lines). Layer 3 is optional and depends on external agent configuration.

### 5.2 Extension Templates

VS Code's template approach (scoped to contribution type) works better for AI agents than Obsidian's single generic starter. Agents benefit from seeing the full registration pattern for their specific goal.

**Recommendation:** 3 slot-specific templates as a `template` parameter on `create_extension`:

| Template                   | Target Slot             | Demonstrates                                    |
| -------------------------- | ----------------------- | ----------------------------------------------- |
| `dashboard-card` (default) | `dashboard.sections`    | Working section with placeholder fetch + render |
| `command`                  | `command-palette.items` | Registered command that shows a notification    |
| `settings-panel`           | `settings.tabs`         | Settings tab with `loadData`/`saveData` example |

Templates are string constants inlined in the MCP tools file.

### 5.3 Security Model

| Platform | Model                            | Assessment                                     |
| -------- | -------------------------------- | ---------------------------------------------- |
| Obsidian | Full trust, no sandbox           | Identical risk model to DorkOS v1              |
| VS Code  | Extension Host process isolation | For untrusted marketplace — overkill for v1    |
| Figma    | Realms-based sandbox             | 100-300ms rendering overhead — wrong trade-off |
| Grafana  | Proxy-membrane sandbox           | Public preview, measurable overhead            |

**Recommendation:** Full-trust (Obsidian model). The audience is developers running their own agents. No sandbox, no confirmation prompt. Extensions run in the browser context like Phase 3.

### 5.4 Hot Reload vs Full Reload

VS Code does not have per-extension hot reload (it reloads the entire Extension Host). Obsidian's `pjeby/hot-reload` plugin is the direct precedent: watches individual directories, debounces 750ms, calls `disable()` then `enable()` for only the changed plugin.

**Recommendation:** Per-extension hot reload using deactivate → recompile → reactivate. The `extension-context.tsx` already tracks cleanup functions per extension. The `Map<extId, LoadedExtension>` enables surgical targeting. Key advantage: one bad extension doesn't block others, and state in unmodified extensions is preserved.

### 5.5 File Watcher Strategy

chokidar v5 (ESM-only, Node 20+) is the correct choice. Raw `fs.watch()` is unreliable on macOS. Strategy: **per-extension debounce at 750ms** — collect all changes to a specific extension directory, then trigger one compile after writes settle.

Coexistence with `reload_extensions`: both use the same `reloadExtension(extId)` implementation. If the watcher fires after an explicit reload, the content-hash cache returns immediately (harmless double).

**Recommendation:** File watcher is optional for v1. The explicit `reload_extensions` tool is the fast path (~70-280ms vs ~830-1060ms with watcher debounce).

### 5.6 Iteration Speed

| Phase                         | Explicit Reload | Watcher Path    |
| ----------------------------- | --------------- | --------------- |
| Debounce wait                 | 0ms             | 750ms           |
| esbuild compilation           | 5-15ms          | 5-15ms          |
| Client dynamic import         | 5-20ms          | 5-20ms          |
| Extension activation          | 1-10ms          | 1-10ms          |
| SSE delivery + React rerender | 55-230ms        | 55-230ms        |
| **Total**                     | **~70-280ms**   | **~830-1060ms** |

The explicit `reload_extensions` tool gives sub-300ms cycle time. Well within "feels instant."

### 5.7 Extension Testing

**Recommendation:** A `test_extension` MCP tool for headless server-side smoke testing:

1. Compile the extension (catches TypeScript errors)
2. Activate against a `createMockExtensionAPI()` (catches runtime activation errors)
3. Return the contributions map: `{ 'dashboard.sections': 1, 'command-palette.items': 0 }`

Catches ~80% of failures without a browser round-trip. For visual correctness, the reload → SSE → render loop is the fallback.

**Agent iteration loop:** `create_extension` → `test_extension` (smoke) → `reload_extensions` (visual) → iterate.

---

## 6) Decisions

| #   | Decision                          | Choice                                                                                | Rationale                                                                                                                                                    |
| --- | --------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | How agents get ExtensionAPI types | **MCP tool + inline scaffolded comments**                                             | MCP tool (`get_extension_api`) is most reliable cross-agent. Inline comments in scaffolded `index.ts` survive context truncation and are zero marginal cost. |
| 2   | Extension templates               | **3 slot-specific templates** (`dashboard-card` default, `command`, `settings-panel`) | Agents benefit from seeing the full registration pattern for their specific goal. Templates are string constants — no external files.                        |
| 3   | Security model                    | **Full trust (Obsidian model)**                                                       | v1 audience is developers who trust their agents. Sandbox adds 100-300ms overhead for zero security benefit at this stage.                                   |
| 4   | Hot vs full reload                | **Per-extension hot reload**                                                          | Architecture already supports deactivate → recompile → reactivate per extension. Preserves state in unmodified extensions.                                   |
| 5   | File watcher                      | **Optional for v1**                                                                   | Explicit `reload_extensions` gives ~70-280ms cycle. Watcher adds 750ms debounce. Nice DX improvement but not blocking.                                       |
| 6   | Iteration speed target            | **Sub-300ms with explicit reload**                                                    | esbuild ~10ms + content-hash cache + SSE push. Theoretical minimum ~85ms on warm cache.                                                                      |
| 7   | Extension testing                 | **`test_extension` MCP tool (headless smoke test)**                                   | Catches compilation + activation errors without browser. Agent loop: create → test → reload → iterate.                                                       |

### Settled Decisions (from brief)

| #   | Decision                                     | Choice                                        | Rationale                                                         |
| --- | -------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| 8   | MCP tools, not HTTP endpoints                | MCP only                                      | Consistent with other DorkOS agent-facing tools                   |
| 9   | Structured errors mandatory                  | File, line, column, message                   | Vague errors break the agent feedback loop                        |
| 10  | Default to local scope                       | `.dork/extensions/` in active CWD             | Safer, more conservative. Agent can promote to global explicitly. |
| 11  | `create_extension` scaffolds working starter | Minimal extension that compiles and activates | Agent iterates from working code, not empty directory             |
| 12  | File watcher optional for v1                 | `reload_extensions` is sufficient             | Don't block on this                                               |

---

## 7) MCP Tools Summary

### New tools to add to the DorkOS MCP server:

| Tool                   | Parameters                                                                                                       | Returns                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `list_extensions`      | (none)                                                                                                           | All extensions with status, source (global/local), last error              |
| `create_extension`     | `name`, `description`, `template?` (`dashboard-card`\|`command`\|`settings-panel`), `scope?` (`global`\|`local`) | Scaffolded extension path, confirmation of compilation success             |
| `reload_extensions`    | `id?` (optional — reload one or all)                                                                             | Per-extension results with structured errors (file, line, column, message) |
| `get_extension_errors` | `id`                                                                                                             | Compilation or runtime errors for a specific extension                     |
| `get_extension_api`    | (none)                                                                                                           | Full ExtensionAPI type definitions + usage examples as text                |
| `test_extension`       | `id`                                                                                                             | Headless smoke test: compilation + mock activation → contributions map     |

### Implementation pattern

Follow the existing MCP tool pattern from `apps/server/src/services/runtimes/claude-code/mcp-tools/`:

```
extension-tools.ts
├── requireExtensionManager() guard
├── createListExtensionsHandler(deps)
├── createCreateExtensionHandler(deps)
├── createReloadExtensionsHandler(deps)
├── createGetExtensionErrorsHandler(deps)
├── createGetExtensionApiHandler(deps)
├── createTestExtensionHandler(deps)
└── getExtensionTools(deps) → tool[]
```

Register via `getExtensionTools(deps)` in `mcp-server.ts`.

---

## 8) Implementation Priority

1. `list_extensions` + `create_extension` (3 templates) + `reload_extensions` — core loop must work end-to-end
2. Structured errors from `reload_extensions` (file:line:col) — mandatory for agent feedback loop
3. `get_extension_api` MCP tool — ~15 lines, high value
4. `test_extension` headless smoke test — saves a full reload cycle for catchable errors
5. SSE `extension_reloaded` event for client push notification
6. Per-extension hot reload (deactivate → recompile → reactivate)
7. chokidar file watcher (750ms per-extension debounce) — optional DX improvement
8. `get_extension_errors` tool — useful but `reload_extensions` already returns errors

---

## 9) Key File Changes

| File                                                                         | Change                                                                      |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts` | **NEW** — All 6 MCP tool handlers                                           |
| `apps/server/src/services/core/mcp-server.ts`                                | Register `getExtensionTools(deps)`                                          |
| `apps/server/src/services/extensions/extension-manager.ts`                   | Add `createExtension()`, `testExtension()`, `reloadExtension(id)` methods   |
| `apps/server/src/services/extensions/extension-compiler.ts`                  | Expose structured error types for MCP consumption                           |
| `apps/client/src/layers/features/extensions/model/extension-context.tsx`     | Handle `extension_reloaded` SSE event → per-extension deactivate/reactivate |
| `packages/extension-api/src/extension-api.ts`                                | No changes needed — already designed for Phase 4 (ADR-0203)                 |

---

## 10) Acceptance Criteria (from brief, preserved verbatim)

- [ ] `list_extensions` MCP tool returns all extensions with status and source
- [ ] `create_extension` MCP tool scaffolds a working extension that compiles and activates
- [ ] `create_extension` supports `scope: 'global' | 'local'` parameter
- [ ] `reload_extensions` MCP tool recompiles and reloads, returns per-extension structured results
- [ ] Compilation errors include file, line, column, message — enough for the agent to fix
- [ ] Runtime activation errors include error type, message, stack trace
- [ ] ExtensionAPI type definitions accessible to the agent (via MCP tool)
- [ ] End-to-end workflow works: agent writes extension → reload → extension renders in correct slot
- [ ] Agent can iterate: edit extension → reload → see updated rendering
- [ ] Default scope is local (`.dork/extensions/` in active CWD)
- [ ] Agent can create a global extension by passing `scope: 'global'`
- [ ] Scaffolded extension includes ExtensionAPI usage examples in comments
- [ ] No new tools registered outside the MCP server boundary (no direct HTTP endpoints for agent use)

### Additional criteria (from ideation):

- [ ] `create_extension` supports `template` parameter with 3 slot-specific templates
- [ ] `get_extension_api` MCP tool returns full type definitions
- [ ] `test_extension` MCP tool performs headless smoke test and returns contributions map
- [ ] Per-extension hot reload: changing one extension does not affect others
- [ ] SSE `extension_reloaded` event notifies connected clients
- [ ] Agent iteration cycle completes in <500ms (explicit reload path)
