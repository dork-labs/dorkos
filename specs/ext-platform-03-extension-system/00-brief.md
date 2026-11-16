---
slug: ext-platform-03-extension-system
number: 183
created: 2026-03-26
status: brief
project: extensibility-platform
phase: 3
---

# Phase 3: Extension System Core

**Project:** Extensibility Platform
**Phase:** 3 of 4
**Depends on:** Phase 2 (Extension Point Registry)
**Enables:** Phase 4 (Agent-built extensions use this infrastructure)

---

## Scope

Build the full extension lifecycle — discovery, loading, activation, API surface, and settings UI. Users can install extensions by placing files in `~/.dork/extensions/` (global) or `.dork/extensions/` (project-local), and DorkOS discovers, compiles (if TypeScript), loads, and activates them. Extensions receive a typed `ExtensionAPI` that wraps the dispatcher, registry, transport, and storage.

## Deliverables

### 1. Extension Manifest (`extension.json`)

**Problem:** DorkOS needs to know what an extension does before executing it — metadata, contributions, compatibility.

**Solution:**

- Define `extension.json` schema (Zod-validated)
- Fields: `id`, `name`, `version`, `description`, `author`, `minHostVersion`, `contributions` (declares which slots the extension contributes to), `permissions` (future)
- Manifest is readable without executing code — enables fast startup and safe discovery

**Example:**

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

### 2. Extension Discovery & Lifecycle

**Problem:** Extensions live on the filesystem. DorkOS needs to find them, validate them, and manage their lifecycle.

**Solution:**

- **Discovery paths:**
  - Global: `{dorkHome}/extensions/` (always scanned)
  - Local: `{cwd}/.dork/extensions/` (scanned when a CWD is active)
  - Local overrides global by extension ID
- **Lifecycle states:** `discovered → installed → enabled → activated → deactivated → disabled`
- **Enable/disable persisted** in DorkOS config (survives restarts)
- **Automatic resource cleanup** — all `register*()` calls tracked per extension; auto-cleaned on deactivate (Obsidian pattern)

**Key source files:**

- `apps/server/src/lib/dork-home.ts` — `resolveDorkHome()` for global extension path
- `apps/server/src/services/` — Service domain pattern for new `services/extensions/` directory

### 3. TypeScript Compilation Service

**Problem:** Extensions should be authorable in TypeScript without requiring the author to set up a build toolchain. This is critical for agent-built extensions (Phase 4).

**Solution:**

- If `index.js` exists in the extension directory → load directly (pre-compiled)
- If `index.ts` exists (and no `index.js`) → compile with esbuild at enable time, cache result
- esbuild is already in the dependency tree via Vite
- Compilation externalizes `react`, `react-dom`, and `@dorkos/extension-api` (provided by host)
- Structured error output for compilation failures (agent can read and fix in Phase 4)

### 4. ExtensionAPI Surface

**Problem:** Extensions need a stable, typed contract for interacting with the host. They should never import internal modules directly.

**Solution:**

- Define `ExtensionAPI` interface in a new `packages/extension-api/` package
- Extensions receive the API object on activation: `activate(api: ExtensionAPI)`
- The API wraps existing primitives with a stability contract:

```typescript
interface ExtensionAPI {
  // UI registration (wraps the Phase 2 registry)
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
  registerSettingsTab(id: string, label: string, component: React.ComponentType): () => void;
  registerDialog(
    id: string,
    component: React.ComponentType
  ): { open: () => void; close: () => void };

  // UI control (wraps the Phase 1 dispatcher)
  executeCommand(command: UiCommand): void;
  openCanvas(content: CanvasContent): void;

  // State access (read-only)
  getState(): ExtensionReadableState;
  subscribe(
    selector: (state: ExtensionReadableState) => unknown,
    callback: (value: unknown) => void
  ): () => void;

  // Server data
  transport: Transport;

  // Navigation
  navigate(path: string): void;

  // Notifications
  notify(message: string, options?: { type?: 'info' | 'success' | 'error' }): void;

  // Persistent storage (scoped to this extension)
  loadData<T>(): Promise<T | null>;
  saveData<T>(data: T): Promise<void>;
}
```

### 5. Server Endpoints

**Problem:** The client needs to discover extensions, and extensions need server-side management.

**Solution:**

- `GET /api/extensions` — List all discovered extensions (global + local for active CWD)
- `POST /api/extensions/:id/enable` — Enable an extension
- `POST /api/extensions/:id/disable` — Disable an extension
- `POST /api/extensions/reload` — Re-scan and reload all extensions
- `GET /api/extensions/:id/bundle` — Serve the compiled JS bundle for a specific extension

### 6. Extension Settings UI

**Problem:** Users need a way to see installed extensions and enable/disable them.

**Solution:**

- New tab in `SettingsDialog` — "Extensions" tab
- Lists all discovered extensions with: name, version, description, source (global/local), enabled/disabled toggle
- Shows compilation errors for extensions that failed to build

**Key source files:**

- `apps/client/src/layers/features/settings/` — Existing settings dialog structure

### 7. Client-Side Loader

**Problem:** The client needs to dynamically load and activate extensions.

**Solution:**

- `ExtensionLoader` service — fetches manifests from server, dynamically imports enabled extension bundles, calls `activate(api)`, tracks registrations
- `ExtensionProvider` — React context wrapping the app tree (in `main.tsx`), initializing the extension system
- Extension bundles loaded via dynamic `import()` from the server's bundle endpoint

## Key Decisions (Settled)

1. **No sandboxing for v1** — Extensions run in-process with full React integration. Target audience is developers who trust their own code. Sandboxing can be added later.
2. **Global + local extension paths** — `~/.dork/extensions/` (global, always loaded) and `.dork/extensions/` (project-local, loaded when CWD is active). Local overrides global by ID.
3. **esbuild compilation** — TypeScript extensions compiled at enable time. No separate build toolchain required.
4. **`packages/extension-api/` as a separate package** — The external contract deserves its own versioning. Not bundled into `packages/shared/`.
5. **Automatic resource cleanup** — All `register*()` calls return unsubscribe functions. The lifecycle manager collects them per extension and calls them all on deactivate.
6. **`extension.json` not `manifest.json`** — Avoids ambiguity with `specs/manifest.json` and npm's `package.json`. The name clearly identifies what it is.
7. **Page reload on extension changes is acceptable for v1** — No hot module replacement.

## Open Questions (For /ideate)

1. **Exact ExtensionAPI surface** — The sketch above is directional. What's the minimal viable API? What should be deferred to v2?
2. **Extension storage** — `loadData`/`saveData` scoped to each extension. Where does the data live? `data.json` in the extension directory? A key in the DorkOS config? SQLite table?
3. **Compilation caching** — Where is the compiled JS cached? Next to the source (`index.compiled.js`)? In a temp directory? How is cache invalidation handled?
4. **Version compatibility** — `minHostVersion` in the manifest. What happens when the check fails — silent skip, warning, or error in settings UI?
5. **Extension dependencies** — Can an extension declare npm dependencies? v1 probably not (extensions must be self-contained or use host-provided packages). But worth considering the path forward.
6. **CWD change behavior** — When the user switches projects, local extensions change. What's the activation/deactivation sequence? Any visible flicker?
7. **How do extension bundles reach the client?** — Served as JS from the server's bundle endpoint? Inlined in the manifest response? Loaded via `<script>` tag or dynamic `import()`?
8. **Obsidian embedded mode** — Extensions in the Obsidian plugin path. `App.tsx` bypasses AppShell. Do extensions work there? Which slots are available?

## Reference Material

### Existing ideation docs

- `specs/plugin-extension-system/01-ideation.md` (spec #173) — Full design direction, API surface sketch, architectural patterns, P0-P3 priority ordering

### Research

- `research/20260323_plugin_extension_ui_architecture_patterns.md` — VSCode (contribution points, extension host), Obsidian (Plugin lifecycle, register/cleanup), Grafana (panel props, frontend sandbox), Backstage (createPlugin factories)

### Architecture docs

- `contributing/architecture.md` — Hexagonal architecture, Transport interface
- `contributing/project-structure.md` — FSD layers, file organization
- `packages/shared/src/transport.ts` — Transport interface the ExtensionAPI wraps

## Acceptance Criteria

- [ ] `extension.json` schema defined and validated with Zod
- [ ] Extensions discovered from both `{dorkHome}/extensions/` and `{cwd}/.dork/extensions/`
- [ ] Local extensions override global by ID
- [ ] Extension lifecycle works: discover → enable → activate → deactivate → disable
- [ ] TypeScript extensions compiled with esbuild at enable time
- [ ] Compilation errors are structured and surfaced in the settings UI
- [ ] `ExtensionAPI` interface defined in `packages/extension-api/`
- [ ] A sample extension (e.g., "hello-world" dashboard card) activates and renders in the correct slot
- [ ] Extension registrations auto-cleaned on deactivate
- [ ] Enable/disable state persists across restarts
- [ ] `GET /api/extensions` returns all discovered extensions with status
- [ ] Settings dialog "Extensions" tab shows installed extensions with enable/disable toggles
- [ ] `POST /api/extensions/reload` re-scans and reloads extensions
- [ ] No regression in existing features — built-in registry registrations (Phase 2) unaffected
