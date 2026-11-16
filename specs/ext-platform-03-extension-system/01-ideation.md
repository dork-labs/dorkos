---
slug: ext-platform-03-extension-system
number: 183
created: 2026-03-26
status: ideation
---

# Phase 3: Extension System Core

**Slug:** ext-platform-03-extension-system
**Author:** Claude Code
**Date:** 2026-03-26
**Branch:** preflight/ext-platform-03-extension-system

---

## Source Brief

`specs/ext-platform-03-extension-system/00-brief.md` — detailed brief with 7 deliverables, 7 settled decisions, and 8 open questions resolved through this ideation.

---

## 1) Intent & Assumptions

- **Task brief:** Build the full extension lifecycle for DorkOS — discovery, loading, activation, API surface, and settings UI. Users install extensions by placing files in `~/.dork/extensions/` (global) or `.dork/extensions/` (project-local). DorkOS discovers, compiles (if TypeScript), loads, and activates them. Extensions receive a typed `ExtensionAPI` that wraps the Phase 1 dispatcher, Phase 2 registry, transport, and storage.
- **Assumptions:**
  - Phase 1 (Agent UI Control & Canvas) and Phase 2 (Extension Point Registry) are fully implemented and stable
  - The 8 registry slot IDs (`sidebar.footer`, `sidebar.tabs`, `dashboard.sections`, `header.actions`, `command-palette.items`, `dialog`, `settings.tabs`, `session.canvas`) are the initial contribution points
  - esbuild is available in the dependency tree via Vite
  - Target audience is developers who trust their own code (no sandbox for v1)
  - Phase 4 (Agent-Built Extensions) follows immediately and needs UI control from the API
- **Out of scope:**
  - Extension sandboxing / iframe isolation (v2)
  - Extension marketplace / remote installation
  - Hot module replacement for extensions (page reload is acceptable)
  - Permission enforcement (no sandbox = permissions are meaningless)
  - Extension-to-extension communication

---

## 2) Pre-reading Log

### Specs & ADRs

- `specs/plugin-extension-system/01-ideation.md` (spec #173): Prior ideation covering design rationale, adopted Obsidian hybrid model (file-based lifecycle + typed API), P0-P3 prioritization
- `specs/ext-platform-03-extension-system/00-brief.md`: Phase 3 brief with 7 deliverables, 7 settled decisions, 8 open questions
- `decisions/0200-app-layer-synchronous-extension-initialization.md`: ADR explaining the app-layer initialization pattern — `initializeExtensions()` called synchronously from `main.tsx` before `createRoot().render()`

### Research

- `research/20260323_plugin_extension_ui_architecture_patterns.md`: 38-source deep research on VS Code (contribution points, extension host), Obsidian (plugin lifecycle, register/cleanup), Grafana (panel props, frontend sandbox), Backstage (createPlugin factories). Comparison matrix and "Architectural Patterns Worth Stealing" section
- `research/20260326_extension_point_registry_patterns.md`: Registry patterns research from Phase 2 — additive-only registry, automatic cleanup via unsubscribe functions, declaration-merging-friendly interface
- `research/20260326_extension_system_open_questions.md`: Deep research resolving all 8 open questions — 16 searches, 19 sources, recommendations grounded in VS Code/Obsidian/Grafana precedent

### Architecture

- `contributing/architecture.md`: Hexagonal architecture, Transport interface, DI patterns
- `contributing/project-structure.md`: FSD layers, file organization rules
- `packages/shared/src/transport.ts`: Transport interface (100+ methods) that ExtensionAPI wraps

### Phase 1 & 2 Implementations

- `apps/client/src/layers/shared/model/extension-registry.ts`: Phase 2 registry — Zustand store with 8 slot IDs, typed `SlotContributionMap` interface (supports declaration merging), `register()` returns unsubscribe function, `useSlotContributions()` hook with priority sorting
- `apps/client/src/app/init-extensions.ts`: Phase 2 initialization — called synchronously from `main.tsx`, registers built-in contributions from feature barrels
- `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts`: Phase 1 dispatcher — `executeUiCommand(ctx, command)`, pure sync function, 14 command variants, no React dependencies
- `packages/shared/src/schemas.ts`: `UiCommand` (14 variants), `UiCanvasContent` (url/markdown/json), `UiState` — all Zod-validated

### Server Patterns

- `apps/server/src/lib/dork-home.ts`: `resolveDorkHome()` — checks `DORK_HOME` env, falls back to `.temp/.dork/` in dev, `~/.dork/` in production
- `apps/server/src/services/core/config-manager.ts`: `ConfigManager` loads/saves `~/.dork/config.json` — extension enable/disable state persists here
- `apps/server/src/services/`: Service domain pattern — `core/`, `runtimes/`, `relay/`, `mesh/`, `pulse/`, `discovery/`, `session/`. New `services/extensions/` follows this pattern
- `apps/server/src/routes/`: Route files — `agents.ts`, `sessions.ts`, `mesh.ts`, etc. One endpoint group per file

### Client Patterns

- `apps/client/src/main.tsx`: Provider nesting — `QueryClientProvider` → `TransportProvider` → `PasscodeGateWrapper` → `RouterProvider`. `ExtensionProvider` slots in after `TransportProvider`
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx`: Tabbed dialog with 7 tabs — Extensions tab will be added here
- `apps/client/src/App.tsx`: Embedded mode (Obsidian) renders `<ChatPanel>` directly, bypassing AppShell and router

---

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/client/src/layers/shared/model/extension-registry.ts` — Phase 2 registry store (foundation for Phase 3)
  - `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts` — Phase 1 dispatcher (wrapped by ExtensionAPI)
  - `apps/client/src/app/init-extensions.ts` — Built-in registration initialization
  - `apps/client/src/main.tsx` — App entry point, provider tree
  - `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` — Settings dialog (new Extensions tab)
  - `apps/server/src/lib/dork-home.ts` — Data directory resolver
  - `apps/server/src/services/core/config-manager.ts` — Config persistence
  - `packages/shared/src/schemas.ts` — UiCommand/UiCanvasContent Zod schemas

- **Shared dependencies:**
  - `packages/shared/src/transport.ts` — Transport interface (ExtensionAPI wraps this)
  - `packages/shared/src/constants.ts` — Host version for compatibility checking
  - Zustand (state management), TanStack Query (server state), Zod (validation), sonner (toasts)
  - esbuild (via Vite dependency tree — used for TypeScript compilation)

- **Data flow:**
  - Discovery: filesystem scan → manifest parse → Zod validate → extension record
  - Compilation: `index.ts` → esbuild → content-hashed `.js` in cache directory
  - Loading: client fetches manifest list → dynamic `import()` of enabled bundles → `activate(api)` called
  - Registration: `activate()` calls `api.registerComponent()` etc. → writes to Phase 2 registry → React re-renders slot components

- **Feature flags/config:**
  - Enable/disable state persisted in `~/.dork/config.json` via ConfigManager
  - No feature flags needed — extension system is always available once Phase 3 ships

- **Potential blast radius:**
  - Direct: New `services/extensions/` directory, new `routes/extensions.ts`, new `packages/extension-api/`, new Extensions settings tab, modified `main.tsx` (provider), modified `init-extensions.ts` (async extension loading)
  - Indirect: `extension-registry.ts` (Phase 2) may need minor additions if new slot contribution types are needed
  - Tests: New test files for all new modules; existing registry tests unaffected
  - Config: `config-manager.ts` gains extension enable/disable state shape

---

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

---

## 5) Research

### Potential Solutions

Research was focused on 8 specific open questions rather than alternative overall approaches — the Obsidian hybrid model (file-based lifecycle + typed API + automatic cleanup) was already settled in the brief based on spec #173 and the plugin architecture research.

**1. Extension Storage — Option D: `{dorkHome}/extension-data/{ext-id}/data.json`**

- Separates agent-written code from runtime data
- Symmetric for global (`~/.dork/extension-data/`) and local (`{cwd}/.dork/extension-data/`)
- Transparent to agents (can inspect data without code directory pollution)
- VS Code uses a similar separation (globalStorageUri vs extension directory)

**2. Compilation Caching — Central cache with content hash**

- Location: `{dorkHome}/cache/extensions/{ext-id}.{content-hash-16}.js`
- Content hash (SHA-256, first 16 chars) as cache key — robust against filesystem copies and git operations
- Cache miss: compile with esbuild, write to cache
- Cache hit: serve from cache directly
- Compilation errors stored as `{ext-id}.{hash}.error.json` for structured error surfacing
- esbuild has no built-in persistent cache — application-level caching is required

**3. Version Compatibility — Warn and prevent (VS Code v1.94 pattern)**

- Parse `minHostVersion`, compare with `semver.gte()`
- Incompatible extensions get `status: 'incompatible'` — visible in settings UI with warning badge
- Enable toggle disabled for incompatible extensions
- Never hard-crash — extension is discovered and listed but cannot be activated

**4. Extension Dependencies — Fully self-contained bundles**

- esbuild bundles everything from the extension's `node_modules/` into the output
- Externalize only: `react`, `react-dom`, `@dorkos/extension-api` (provided by host)
- No runtime `npm install` — extensions that need third-party packages pre-install locally
- Agent-built extensions (Phase 4) use only host-provided packages + browser APIs

**5. CWD Change — Page reload when extension set changes**

- Server re-scans on CWD change, computes diff by extension ID
- If diff is non-empty: SSE event → 1.5s toast ("Project extensions changed. Reloading...") → `location.reload()`
- If diff is empty: no reload needed
- Matches VS Code's workspace-switch model and brief's existing "page reload acceptable" decision
- Hot-switch sequence documented for v2 if needed

**6. Bundle Delivery — Dynamic `import()` from server endpoint**

- `import(/* @vite-ignore */ '/api/extensions/${ext.id}/bundle')`
- Server responds with `Content-Type: application/javascript`
- Same-origin — no CORS needed
- `/* @vite-ignore */` prevents Vite from statically analyzing the dynamic path
- Data URLs explicitly avoided (MDN warns against them for module loading)

**7. Obsidian Embedded Mode — `isSlotAvailable()` + graceful no-op**

- `isSlotAvailable(slot: ExtensionPointId): boolean` on the API
- Registration for unavailable slots is a silent no-op (registry accepts but nothing renders)
- Embedded mode available slots: `dialog`, `command-palette.items` (maybe `settings.tabs`)
- Full mode: all 8 slots available

**8. API Surface — 13 methods + 1 field (Phase 4-ready)**

- 4 registration methods + 3 UI control methods + 2 state methods + 2 storage methods + 1 notification + 1 slot check + 1 metadata field
- UI control methods (`executeCommand`, `openCanvas`, `navigate`) included in v1 for Phase 4 readiness
- Deferred to v2: `transport`, `useQuery`, `secrets`, `permissions`

### Security Considerations

- Extensions run in-process with full DOM/fetch/window access — full trust model, documented explicitly
- Read-only `getState()` returns a projection, not the raw Zustand store
- `transport` deferred to v2 — extensions can't use authenticated transport, must use their own `fetch`
- Extension activations logged at INFO level for auditability
- Path to v2 sandboxing: proxy-membrane approach (Grafana v11.5 model) without API contract changes

### Performance Considerations

- Parallel loading via `Promise.all()` — 5 extensions load in ~5-15ms on localhost
- All enabled extensions loaded at startup (lazy loading deferred to v2)
- Soft 500KB bundle size guideline; esbuild warns if output exceeds 500KB
- Inline sourcemaps for agent debugging

### Recommendation

All 8 open questions have clear recommendations grounded in VS Code, Obsidian, and Grafana precedent. No alternative overall architecture was considered — the Obsidian hybrid model is the right fit for DorkOS's developer-centric, file-based, agent-friendly design.

---

## 6) Decisions

| #   | Decision                   | Choice                                                                                 | Rationale                                                                                                                                                                                                   |
| --- | -------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ExtensionAPI v1 scope      | Include UI control methods (`executeCommand`, `openCanvas`, `navigate`)                | Phase 4 (agent-built extensions) follows immediately; agents need UI control from day one. The Phase 1 dispatcher and canvas are already implemented. Avoiding a breaking API change between Phase 3 and 4. |
| 2   | Extension storage location | `{dorkHome}/extension-data/{ext-id}/data.json` (Option D)                              | Separates agent-written code from runtime data. Symmetric for global + local scoping. VS Code uses similar separation. Agent-friendly — no data pollution in code directories.                              |
| 3   | Compilation caching        | Central `{dorkHome}/cache/extensions/{ext-id}.{hash}.js` with content hash             | Content hash is robust across filesystem copies and git operations. Central cache is easy to wipe. Compilation errors stored alongside as `.error.json`.                                                    |
| 4   | Version compatibility      | Warn in settings UI, prevent activation                                                | VS Code v1.94 pattern. Warning badge + disabled toggle. Never hard-crash. Extension remains visible but cannot be enabled.                                                                                  |
| 5   | Extension dependencies     | Self-contained bundles; externalize only `react`, `react-dom`, `@dorkos/extension-api` | Matches VS Code + Obsidian model. No runtime `npm install`. esbuild handles bundling from local `node_modules/`.                                                                                            |
| 6   | CWD change behavior        | Page reload when extension set changes (with diff-check)                               | Already settled in brief. Matches VS Code workspace-switch. 1.5s toast before reload. Only reload if extension IDs actually changed.                                                                        |
| 7   | Bundle delivery to client  | Dynamic `import()` from `/api/extensions/:id/bundle`                                   | Same-origin, no CORS. `Content-Type: application/javascript`. `/* @vite-ignore */` for Vite compatibility. Data URLs explicitly avoided.                                                                    |
| 8   | Obsidian embedded mode     | `isSlotAvailable(slot)` API + silent no-op for unavailable slots                       | Graceful degradation. Only `dialog` and `command-palette.items` universally available. Extensions register freely; unavailable slots simply don't render.                                                   |

### Settled API Surface (v1)

```typescript
interface ExtensionAPI {
  // UI contributions (4 methods — wraps Phase 2 registry)
  registerComponent(
    slot: ExtensionPointId,
    id: string,
    component: React.ComponentType,
    options?: { priority?: number }
  ): () => void;
  registerCommand(
    id: string,
    label: string,
    callback: () => void,
    options?: { icon?: string; shortcut?: string }
  ): () => void;
  registerDialog(
    id: string,
    component: React.ComponentType
  ): { open: () => void; close: () => void };
  registerSettingsTab(id: string, label: string, component: React.ComponentType): () => void;

  // UI control (3 methods — wraps Phase 1 dispatcher)
  executeCommand(command: UiCommand): void;
  openCanvas(content: CanvasContent): void;
  navigate(path: string): void;

  // State (2 methods — read-only projection)
  getState(): ExtensionReadableState;
  subscribe(
    selector: (state: ExtensionReadableState) => unknown,
    callback: (value: unknown) => void
  ): () => void;

  // Storage (2 methods — scoped to this extension)
  loadData<T>(): Promise<T | null>;
  saveData<T>(data: T): Promise<void>;

  // Notification (1 method)
  notify(message: string, options?: { type?: 'info' | 'success' | 'error' }): void;

  // Context (1 method)
  isSlotAvailable(slot: ExtensionPointId): boolean;

  // Metadata (1 field)
  readonly id: string;
}

interface ExtensionReadableState {
  currentCwd: string | null;
  activeSessionId: string | null;
  agentId: string | null;
}
```

**13 methods + 1 field.** Deferred to v2: `transport`, `useQuery`, `secrets`, `permissions`.

### Settled Filesystem Layout

```
~/.dork/
├── extensions/              # Global extension CODE
│   └── github-prs/
│       ├── extension.json
│       └── index.ts
├── extension-data/          # Global extension DATA
│   └── github-prs/
│       └── data.json
└── cache/
    └── extensions/          # Compiled bundles
        ├── github-prs.a3f8c91d.js
        └── github-prs.a3f8c91d.error.json  (if compilation failed)

{cwd}/
└── .dork/
    ├── extensions/          # Local extension CODE
    │   └── my-local-ext/
    │       ├── extension.json
    │       └── index.ts
    └── extension-data/      # Local extension DATA
        └── my-local-ext/
            └── data.json
```

### Settled Lifecycle State Machine

```
  [file placed in extensions dir]
           ↓
       DISCOVERED  (manifest read, Zod-validated)
           ↓ (version check)
       INSTALLED   (visible in settings UI, disabled by default)
           ↓ (user enables)
       ENABLED     (compilation triggered)
           ↓ (compilation succeeds)
       COMPILED    (bundle cached)
           ↓ (client loads bundle)
       ACTIVATED   (activate(api) called, contributions registered)
           ↓ (user disables or CWD changes)
       DEACTIVATED (all unsubscribe fns called, contributions removed)

  Error states:
    DISCOVERED → INCOMPATIBLE  (minHostVersion check failed)
    ENABLED    → COMPILE_ERROR (esbuild failure, structured error stored)
    COMPILED   → ACTIVATE_ERROR (activate() threw)
```
