---
slug: plugin-extension-system
number: 173
created: 2026-03-24
status: ideation
---

# Plugin / Extension System

**Slug:** plugin-extension-system
**Author:** Claude Code
**Date:** 2026-03-24

---

## 1) Intent & Assumptions

- **Task brief:** DorkOS needs a plugin/extension system that allows third-party (and first-party) plugins to add functionality and update the interface. Plugins should be able to register UI components into designated slots, add commands, contribute settings, and access host application state through a stable API. Because DorkOS is an agentic coding tool, the plugin system should be designed so that DorkOS agents can build plugins directly — writing TypeScript files that the host compiles and loads without requiring a separate build toolchain.
- **Assumptions:**
  - Target audience is developers (Kai, Priya) — trusted code, no untrusted marketplace initially
  - Plugins run in-process with full React integration (no sandboxing for v1)
  - Host-side TypeScript compilation via esbuild (already in dependency tree via Vite) removes build friction for plugin authors and enables agent-built plugins
  - The existing FSD architecture and component composition patterns provide natural extension points
  - The existing external MCP server can expose plugin API types to agents
- **Out of scope (v1):**
  - Runtime sandboxing (iframes, proxy membranes, shadow DOM)
  - Public plugin marketplace or registry
  - Plugin hot module replacement (page reload is acceptable)
  - Module Federation or micro-frontend loading
  - Plugin SDK CLI scaffolding tool (`create-dorkos-plugin`)
  - Plugin dependency resolution (plugins depending on other plugins)

## 2) Pre-reading Log

### Research created during this conversation

- **`research/20260323_plugin_extension_ui_architecture_patterns.md`** — Deep research report (38 sources) covering:
  - VSCode: Contribution points system (34+ declarative UI registration points), Extension Host process isolation, webview iframe sandboxing, postMessage API, state persistence
  - Obsidian: Full-trust model, `ItemView` and workspace leaf system, `Plugin` lifecycle, zero sandboxing, `App` object direct access, automatic resource cleanup via `register*()` methods
  - Grafana: SystemJS runtime loading, `PanelProps` typed interface, Frontend Sandbox (11.5+) using proxy-membrane isolation
  - Backstage (Spotify): `createPlugin()` / `createRoutableExtension()` / `createComponentExtension()` factory pattern, route refs, API refs for DI
  - Module Federation: Runtime code sharing, shared singletons, no isolation
  - Comparison matrix across all approaches
  - "Architectural Patterns Worth Stealing" section

### Existing codebase analyzed

- `apps/client/src/AppShell.tsx` — Top-level layout with dynamic slot pattern (`useSidebarSlot()`, `useHeaderSlot()`) and AnimatePresence transitions. Natural model for plugin slot injection.
- `apps/client/src/App.tsx` — Embedded app shell (Obsidian plugin path). Renders `ChatPanel` directly, no router.
- `apps/client/src/main.tsx` — Provider nesting: `QueryClientProvider` -> `TransportProvider` -> `RouterProvider`
- `apps/client/src/router.tsx` — TanStack Router route definitions
- `apps/client/src/layers/shared/model/app-store.ts` — Global Zustand store. Dialog visibility flags, UI state, application state. Plugin dialogs would add flags here.
- `apps/client/src/layers/widgets/app-layout/ui/DialogHost.tsx` — Root dialog portal. 6 responsive dialogs controlled via Zustand. Plugin dialogs register here.
- `apps/client/src/layers/widgets/dashboard/ui/DashboardPage.tsx` — Orchestrator widget composing feature sections in priority order. Plugin dashboard sections insert here.
- `apps/client/src/layers/features/command-palette/model/use-palette-items.ts` — Static `FEATURES[]` and `QUICK_ACTIONS[]` arrays. Plugin commands append here.
- `apps/client/src/layers/features/session-list/ui/SidebarFooterBar.tsx` — Fixed bottom bar with icon buttons. Plugin actions insert here.
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` — Dynamic tab system (`visibleTabs` memo). Plugin tabs register here.
- `apps/client/src/layers/shared/model/TransportContext.tsx` — Hexagonal Transport interface provider.

### Related prior art within DorkOS

- `apps/obsidian-plugin/` — DorkOS as a plugin consumer. Understanding Obsidian's `Plugin` / `ItemView` lifecycle from the author side informs the host design.
- `apps/server/src/services/` — Service domain pattern. Plugin server-side logic would follow the same `services/plugins/` convention.
- `packages/shared/src/` — Cross-package types and schemas. `@dorkos/plugin-api` types could live here or in a new `packages/plugin-api/`.

## 3) Design Direction

### Recommended approach: Obsidian/Backstage hybrid (full integration, no sandboxing)

The plugin system sits at the "full integration" end of the isolation spectrum:

```
Full Isolation                                              Full Integration
(safe, limited)                                             (powerful, risky)
    |                                                              |
    iframe ── VSCode webview ── Grafana sandbox ── Backstage ── [DorkOS] ── Obsidian
```

**Rationale:**

1. Target audience is developers who trust their own code
2. React context/theming/state integration requires in-process execution
3. Sandboxing can be added later; removing it is harder
4. Agent-built plugins benefit from minimal friction between writing code and seeing results

### Architecture overview

```
~/.dork/plugins/
├── my-plugin/
│   ├── manifest.json          # Static metadata + contribution declarations
│   ├── index.ts (or index.js) # Plugin entry point
│   └── data.json              # Plugin-scoped persistent storage (auto-created)
```

**Four layers:**

1. **Plugin Manifest** — Static JSON declaring metadata and contribution points (what slots the plugin contributes to). Readable without executing code. Enables fast startup and predictable layout.

2. **Plugin Lifecycle** — `discovered -> installed -> enabled/disabled -> activated -> deactivated`. Automatic resource cleanup for all `register*()` calls (learned from Obsidian). Persistent enable/disable state in DorkOS settings.

3. **Plugin API Surface** — Typed TypeScript interface (`PluginAPI`) that plugins receive on activation. Wraps existing primitives (Transport, Zustand state, TanStack Query, Router, Toaster) with a stable, versioned contract. Plugins never import internal modules directly.

4. **Extension Point Registry** — A client-side registry (Zustand store or module) mapping slot IDs to registered React components. Existing layout components query the registry to render plugin contributions alongside built-in content.

### Extension points (v1)

| Slot ID                 | Location               | What plugins contribute    |
| ----------------------- | ---------------------- | -------------------------- |
| `sidebar.footer`        | `SidebarFooterBar`     | Icon buttons               |
| `sidebar.tabs`          | `SessionSidebar`       | Additional sidebar tabs    |
| `dashboard.sections`    | `DashboardPage`        | Dashboard cards/widgets    |
| `header.actions`        | Header components      | Action buttons             |
| `command-palette.items` | `use-palette-items.ts` | Commands and quick actions |
| `dialog`                | `DialogHost`           | Modal panels               |
| `settings.tabs`         | `SettingsDialog`       | Settings sections          |

### Plugin API surface (v1)

```typescript
interface PluginAPI {
  // UI registration
  registerComponent(
    slot: ExtensionPointId,
    id: string,
    component: React.ComponentType<any>,
    options?: { priority?: number }
  ): void;
  registerCommand(
    id: string,
    label: string,
    callback: () => void,
    options?: { icon?: string; shortcut?: string }
  ): void;
  registerSettingsTab(id: string, label: string, component: React.ComponentType): void;
  registerDialog(
    id: string,
    component: React.ComponentType
  ): { open: () => void; close: () => void };

  // State access (read-only view of relevant host state)
  getState(): PluginReadableState;
  subscribe(
    selector: (state: PluginReadableState) => any,
    callback: (value: any) => void
  ): () => void;

  // Server data (pre-configured TanStack Query hooks)
  useQuery<T>(key: string): UseQueryResult<T>;

  // Transport (hexagonal architecture access)
  transport: Transport;

  // Navigation
  navigate(path: string): void;

  // Notifications
  notify(message: string, options?: { type?: 'info' | 'success' | 'error' }): void;

  // Persistent storage (scoped to this plugin)
  loadData<T>(): Promise<T | null>;
  saveData<T>(data: T): Promise<void>;
}
```

### TypeScript plugin authoring

Plugins can be authored in TypeScript or JavaScript. The host handles both:

- **If `index.js` exists** — load directly (pre-compiled by plugin author)
- **If `index.ts` exists (and no `index.js`)** — compile with esbuild at install/enable time, then load

Server-side compilation (~20 lines with esbuild's `build()` API):

```typescript
import { build } from 'esbuild';

async function compilePlugin(pluginDir: string): Promise<string> {
  const result = await build({
    entryPoints: [join(pluginDir, 'index.ts')],
    bundle: true,
    format: 'esm',
    external: ['@dorkos/plugin-api', 'react', 'react-dom'],
    write: false,
  });
  return result.outputFiles[0].text;
}
```

This enables **agent-built plugins** — the DorkOS agent writes `.ts` files directly to `~/.dork/plugins/`, the host compiles and loads them, and the user sees the result immediately without any build toolchain setup.

### Agent-built plugin workflow

```
1. User: "Build me a plugin that shows my GitHub PR review queue in the dashboard"
2. Agent: writes manifest.json + index.ts to ~/.dork/plugins/github-prs/
3. Agent: calls POST /api/plugins/reload (or MCP tool)
4. Host: compiles TS, loads plugin, registers dashboard section
5. User: sees new dashboard card with PR data
6. User: "Make the card show review status badges too"
7. Agent: edits index.ts, triggers reload
8. Host: recompiles, hot-swaps the component
```

Key enablers:

- Plugin API type definitions accessible to the agent (via MCP resource, AGENTS.md context, or `@dorkos/plugin-api` package)
- `POST /api/plugins/reload` endpoint for programmatic reload
- Structured error feedback from compilation failures (agent can read and fix)
- File watcher on `~/.dork/plugins/` as optional alternative to manual reload

## 4) Client changes required

Priority-ordered list of concrete changes:

### P0: Core infrastructure

1. **Plugin Registry** (`layers/shared/model/plugin-registry.ts`) — Zustand store holding all registered extensions keyed by slot ID. Components query this to render plugin contributions.

2. **PluginAPI class** (`layers/shared/lib/plugin-api.ts`) — The typed API surface wrapping existing primitives. This is the stability contract — internal refactors don't break plugins as long as the API holds.

3. **Plugin loader** (`layers/shared/model/plugin-loader.ts`) — Fetches plugin manifests from server, dynamically imports enabled plugins, calls lifecycle methods, tracks registrations for automatic cleanup.

4. **PluginProvider** — React context provider wrapping the app tree (in `main.tsx`), initializing the plugin system and making the registry available to slot components.

### P1: Extension point integration

5. **Slot components** — Update `DashboardPage`, `DialogHost`, `SidebarFooterBar`, `SessionSidebar`, `use-palette-items.ts`, and header components to query the plugin registry and render contributions alongside built-in content.

6. **Plugin settings UI** — Section in `SettingsDialog` for listing installed plugins with enable/disable toggles.

### P2: Server support

7. **`/api/plugins` endpoints** — List plugins, enable/disable, serve compiled bundles, trigger reload.

8. **esbuild compilation service** — Compile `.ts` plugins at enable time, cache compiled output, return structured errors.

9. **Plugin file watcher** (optional) — Watch `~/.dork/plugins/` for changes, notify connected clients via SSE.

### P3: Agent integration

10. **MCP tools** — `list_plugins`, `install_plugin`, `reload_plugins` exposed via the external MCP server.

11. **Plugin API types as MCP resource** — Expose `@dorkos/plugin-api` type definitions so agents have them in context when building plugins.

## 5) Architectural patterns adopted

| Pattern                                  | Source                      | How it applies                                                         |
| ---------------------------------------- | --------------------------- | ---------------------------------------------------------------------- |
| Declarative manifest for UI registration | VSCode                      | `manifest.json` declares contributions without executing code          |
| Automatic resource cleanup               | Obsidian                    | All `register*()` calls tracked; auto-cleaned on deactivate            |
| Props-based plugin rendering             | Grafana                     | Plugin components receive data via props, not global state reach       |
| Factory functions with strong types      | Backstage                   | `PluginAPI` interface is typed, IDE-discoverable, compile-time checked |
| Shared singleton dependencies            | Module Federation / Grafana | React, ReactDOM provided by host; plugins don't bundle them            |
| Full trust / no sandboxing               | Obsidian                    | In-process execution, developer audience, sandboxing deferred          |

## 6) Open questions

1. **Where do plugin API types live?** Options: `packages/plugin-api/` (new package), `packages/shared/src/plugin/` (extend shared), or standalone npm package.
2. **Should plugins be able to register new routes?** Would require TanStack Router dynamic route injection. Powerful but complex.
3. **Server-side plugins?** Some plugins may want to add API endpoints or background tasks. Out of scope for v1 but worth considering the path forward.
4. **Plugin update mechanism?** v1 is manual (copy files). Future could be git-based, npm-based, or custom registry.
5. **How does the Obsidian embedded mode handle plugins?** The `App.tsx` path bypasses AppShell. Should plugins work there too?
6. **Version compatibility contract?** `manifest.json` declares `minHostVersion`. What happens when the API changes — semver? Migration guides?

## 7) References

### Research

- [`research/20260323_plugin_extension_ui_architecture_patterns.md`](../../research/20260323_plugin_extension_ui_architecture_patterns.md) — Deep research on VSCode, Obsidian, Grafana, Backstage, Module Federation (38 sources)

### External references (from research)

- [VSCode Contribution Points](https://code.visualstudio.com/api/references/contribution-points) — 34+ declarative UI registration points
- [VSCode Webview API](https://code.visualstudio.com/api/extension-guides/webview) — Iframe isolation, postMessage, state persistence
- [VSCode Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host) — Process isolation model
- [Obsidian Plugin API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts) — Full API surface
- [Obsidian Views Docs](https://docs.obsidian.md/Plugins/User+interface/Views) — ItemView, workspace leaf system
- [Grafana Plugin Frontend Sandbox](https://grafana.com/docs/grafana/latest/administration/plugin-management/plugin-frontend-sandbox/) — Proxy-membrane isolation (11.5+)
- [Backstage Frontend Plugins](https://deepwiki.com/backstage/backstage/6.1-frontend-plugins) — Extension factory pattern

### Internal references

- `apps/client/src/AppShell.tsx` — Current layout and dynamic slot pattern
- `apps/client/src/layers/shared/model/app-store.ts` — Zustand state model
- `apps/client/src/layers/widgets/app-layout/ui/DialogHost.tsx` — Dialog registration pattern
- `apps/client/src/layers/widgets/dashboard/ui/DashboardPage.tsx` — Section composition pattern
- `apps/client/src/layers/features/command-palette/model/use-palette-items.ts` — Command registry
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` — Tab system
- `apps/client/src/layers/features/session-list/ui/SidebarFooterBar.tsx` — Footer action zone
- `contributing/architecture.md` — Hexagonal architecture, Transport interface
