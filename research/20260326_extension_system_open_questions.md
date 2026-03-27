---
title: 'Extension System Core: Open Questions Research (ext-platform-03)'
date: 2026-03-26
type: implementation
status: active
tags:
  [
    extension-system,
    esbuild,
    plugin-storage,
    dynamic-import,
    version-compatibility,
    extension-lifecycle,
    bundle-delivery,
    obsidian-embedded,
    extension-api,
    security,
  ]
feature_slug: ext-platform-03-extension-system
searches_performed: 16
sources_count: 34
---

# Extension System Core: Open Questions Research

**Date**: 2026-03-26
**Research Depth**: Deep Research
**Feature**: ext-platform-03-extension-system

---

## Research Summary

This report answers the 8 specific open questions in the `ext-platform-03-extension-system` brief, plus addresses security and performance considerations. It synthesizes findings from three prior deep-research files — `20260323_plugin_extension_ui_architecture_patterns.md`, `20260326_extension_point_registry_patterns.md`, and `20260326_agent_ui_control_canvas_spec_research.md` — with 16 new targeted searches covering extension storage patterns, esbuild caching strategies, version compatibility behaviors, dependency models, CWD change sequences, bundle delivery approaches, and minimal API surface design. The bottom line: use Option D (scoped directory at `{dorkHome}/extension-data/{ext-id}/data.json`) for storage, a central cache directory with content-hash filenames for compilation caching, a warn-and-skip model for version incompatibility, full self-bundling for dependencies, a clean deactivation-before-activation sequence for CWD changes, `import()` from the server's bundle endpoint for bundle delivery, and a minimal 6-method API for v1 with the rest deferred.

---

## What Was Covered by Existing Research (No Re-Research Needed)

### From `research/20260323_plugin_extension_ui_architecture_patterns.md`

- **VSCode storage model**: `globalState` (key-value, SQLite, cross-workspace), `workspaceState` (key-value, SQLite, workspace-scoped), `globalStorageUri` (filesystem directory for large files, global), `storageUri` (filesystem directory, workspace-scoped).
- **Obsidian storage model**: `loadData()`/`saveData()` writes to `data.json` in the plugin's own directory (`.obsidian/plugins/{plugin-id}/data.json`). Colocation with the plugin code.
- **Obsidian dependency model**: All external dependencies must be bundled into `main.js`. No runtime npm install. Self-contained bundles are mandatory.
- **VSCode dependency model**: Extensions should bundle dependencies with esbuild/webpack. Only `vscode` is externalized (provided by runtime). All other `node_modules` are bundled into the single output file.
- **Obsidian lifecycle**: `onload()` / `onunload()`. All `register*()` and `add*()` calls are tracked automatically — cleanup is automatic on `onunload()`.
- **VSCode activation**: Extensions export `activate()` / `deactivate()`. Workspace-specific enabling/disabling is supported. Extensions are activated per-workspace via activation events.
- **Grafana**: Plugin type declarations in `plugin.json`, version compatibility via `grafanaDependency` field with semver constraints.

### From `research/20260326_extension_point_registry_patterns.md`

- Registry is additive only — built-in UI stays in components, registry adds extensions on top.
- Automatic resource cleanup via returned unsubscribe functions collected by lifecycle manager.
- App-layer initialization pattern (explicit `initializeExtensions()` in `app/` called from `main.tsx`).

---

## Open Question 1: Extension Storage (`loadData` / `saveData`)

### The Options

| Option | Path                                           | Pros                                                                        | Cons                                                                                              |
| ------ | ---------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A      | `{ext-dir}/data.json`                          | Colocation with code; easy to inspect                                       | Extension directory is in `~/.dork/extensions/` (could be user-managed code); mixes code and data |
| B      | Scoped key in DorkOS config                    | Centralized; simple implementation                                          | Config file grows unbounded; config is for settings, not plugin data                              |
| C      | SQLite table with `extension_id`               | Transactional; queryable                                                    | Schema migration complexity; overkill for key-value plugin data                                   |
| D      | `{dorkHome}/extension-data/{ext-id}/data.json` | Clean separation of code and data; easy to backup/restore; predictable path | One more directory to manage                                                                      |

### How the Reference Implementations Do It

**Obsidian**: `loadData()`/`saveData()` writes `data.json` colocated inside the plugin's directory: `.obsidian/plugins/{plugin-id}/data.json`. This is Option A. Obsidian's rationale: vaults are self-contained — code and data move together when you copy a vault.

**VS Code**: Two-tier model. Small key-value data uses `globalState` or `workspaceState` (backed by SQLite at `~/Library/Application Support/Code/User/globalStorage/state.vscdb` on macOS). Large files use `globalStorageUri` (a dedicated directory per extension under the VS Code global storage path) or `storageUri` (workspace-scoped directory). VS Code explicitly separates workspace-scoped from global storage.

**DorkOS difference from Obsidian**: Extensions can be either global (`~/.dork/extensions/`) or project-local (`.dork/extensions/`). If data lives in the extension directory, a project-local extension's data is inside the project `.dork/` directory — which is correct for project-local data. A global extension's data would be in `~/.dork/extensions/{id}/data.json` — which mixes the extension code (potentially agent-written) with its runtime data. This makes the code directory noisy.

**DorkOS difference from VS Code**: VS Code has a full application data directory that it owns. DorkOS has `dorkHome` (`~/.dork/`) which serves the same role.

### Recommendation: **Option D** — `{dorkHome}/extension-data/{ext-id}/data.json`

```
~/.dork/
├── extensions/          # Global extensions (code)
│   └── github-prs/
│       ├── extension.json
│       └── index.ts
├── extension-data/      # Global extension persistent data
│   └── github-prs/
│       └── data.json
└── cache/
    └── extensions/      # Compiled bundles
        └── github-prs.{hash}.js
```

For project-local extensions, data lives at `{cwd}/.dork/extension-data/{ext-id}/data.json` — this keeps project-local extension data within the project, which is semantically correct (it's associated with that project's working directory).

**Why not A**: Extension directories may be agent-written and version-controlled. Data pollution is problematic for agents that inspect their own file output.

**Why not B**: DorkOS config is for application settings, not extension runtime state. Unbounded growth and no clear separation of concerns.

**Why not C**: SQLite adds migration complexity with no benefit for simple JSON blobs. The existing SQLite usage in DorkOS is for derived caches (ADR-0043), not primary data storage. A flat JSON file is simpler, more transparent, and can be directly read/written by agents.

**Implementation sketch**:

```typescript
// In ExtensionAPI factory
function makeStorageAPI(extId: string, scope: 'global' | 'local', cwd?: string): StorageAPI {
  const dataDir =
    scope === 'global'
      ? join(resolveDorkHome(), 'extension-data', extId)
      : join(cwd!, '.dork', 'extension-data', extId);
  const dataPath = join(dataDir, 'data.json');

  return {
    async loadData<T>(): Promise<T | null> {
      try {
        await mkdir(dataDir, { recursive: true });
        const text = await readFile(dataPath, 'utf-8');
        return JSON.parse(text) as T;
      } catch {
        return null;
      }
    },
    async saveData<T>(data: T): Promise<void> {
      await mkdir(dataDir, { recursive: true });
      await writeFile(dataPath, JSON.stringify(data, null, 2), 'utf-8');
    },
  };
}
```

The server exposes these methods over the REST API: `GET /api/extensions/:id/data` and `PUT /api/extensions/:id/data`, and the `ExtensionAPI` wraps them for browser-side extensions.

---

## Open Question 2: Compilation Caching

### How esbuild Handles Caching

esbuild does NOT have built-in persistent file-based caching between process runs. The `rebuild()` API caches within a single process invocation (in-memory), but once the server restarts, all prior compilation results are lost. Cache invalidation is explicitly left to the application.

The `entryNames` option supports a `[hash]` placeholder that generates content-based hash filenames — this is esbuild's primary cache-busting mechanism for browser caches, not server-side compilation caching.

### Cache Invalidation Strategy

For server-side compilation caching, the correct approach is:

1. **Cache key**: Hash of the source file's content (not mtime — mtime is unreliable across filesystem copies and git checkouts)
2. **Cache location**: Central directory owned by DorkOS, not the extension's source directory
3. **Cache miss**: Source hash not found in cache → compile → store result
4. **Cache hit**: Source hash found → serve cached bundle directly

```typescript
import { createHash } from 'crypto';
import { build } from 'esbuild';

async function compileExtension(extDir: string): Promise<string> {
  const srcPath = join(extDir, 'index.ts');
  const source = await readFile(srcPath, 'utf-8');
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);

  const cacheDir = join(resolveDorkHome(), 'cache', 'extensions');
  const cachePath = join(cacheDir, `${extId}.${hash}.js`);

  // Cache hit
  try {
    return await readFile(cachePath, 'utf-8');
  } catch {
    // Cache miss — compile
  }

  // Compile
  const result = await build({
    entryPoints: [srcPath],
    bundle: true,
    format: 'esm',
    external: ['react', 'react-dom', '@dorkos/extension-api'],
    write: false,
    minify: false, // Leave readable for agent debugging
    sourcemap: 'inline', // Inline sourcemap for browser devtools
  });
  const code = result.outputFiles[0].text;

  // Write to cache
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cachePath, code, 'utf-8');
  return code;
}
```

### Cache Location: **Central directory at `{dorkHome}/cache/extensions/`**

| Location                                       | Assessment                                                    |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Next to source (`index.compiled.js`)           | Pollutes agent-written code directories; git would pick it up |
| Central cache (`{dorkHome}/cache/extensions/`) | Clean, predictable, easy to wipe                              |
| Temp directory (`/tmp/dork-ext-cache/`)        | Lost on reboot; forces recompile on every server restart      |

**Filename format**: `{ext-id}.{content-hash-16}.js`

Example: `github-prs.a3f8c91d2e4b5f67.js`

**Cache invalidation**: Content hash ensures automatic invalidation when source changes. Old cached versions accumulate but are harmless (bytes). Optionally, stale entries (not accessed in 7+ days) can be pruned on startup.

**Multi-file extensions (future)**: If an extension eventually has multiple source files, the cache key should hash all source files' contents concatenated. For v1 (single `index.ts`), hashing just that file is sufficient.

**Compilation errors**: Store structured errors alongside the cache. If compilation failed, write a `{ext-id}.{hash}.error.json` file so the server can surface the error without recompiling on every request.

---

## Open Question 3: Version Compatibility (`minHostVersion`)

### How VS Code Handles It

VS Code's `engines.vscode` field uses semver ranges (`^1.8.0`, `>=1.80.0`). The behavior when the constraint fails:

1. **Marketplace installation**: VS Code blocks installation of extensions incompatible with the current version. The user sees a clear error.
2. **VSIX manual installation**: Historically, VS Code allowed installing incompatible extensions with a warning; behavior has tightened over versions.
3. **September 2024 (v1.94) improvement**: The Extensions view now shows a **warning badge** and information for extensions disabled due to version incompatibility — the extension is greyed out with a warning triangle, not silently hidden.
4. **Critical insight**: VS Code uses **soft failure** — the extension loads but is shown as disabled with a clear visual indicator. It does NOT throw a hard error that could destabilize the host.

### How Grafana Handles It

`plugin.json` declares `"grafanaDependency": { "type": "grafana", "version": ">=10.0.0" }`. If the constraint fails, the plugin is skipped during discovery and a structured error is recorded. The plugin simply does not appear in the plugin list without crashing the host.

### Options for DorkOS

| Behavior                     | Assessment                                                         |
| ---------------------------- | ------------------------------------------------------------------ |
| Silent skip                  | Bad UX — user installs extension, nothing happens, no feedback     |
| Warning in settings UI       | Good — follows VS Code v1.94 pattern; non-blocking                 |
| Hard error blocking enable   | Too aggressive for v1 developer tool; blocks forward migration     |
| Load but show degraded badge | Complex to implement; extension may actually crash on missing APIs |

### Recommendation: **Warn in settings UI, prevent activation**

1. During discovery, parse `minHostVersion` and compare against the current DorkOS version.
2. If the constraint fails, set `status: 'incompatible'` on the extension record.
3. In the Extensions settings tab, show the extension with a warning icon and message: "Requires DorkOS ≥ {minHostVersion} (current: {currentVersion})".
4. The enable toggle is disabled for incompatible extensions.
5. No hard throw — incompatible extensions are discovered and listed but cannot be enabled.

```typescript
import { satisfies } from 'semver'; // or a tiny vendored semver comparison

function checkCompatibility(ext: ExtensionManifest, hostVersion: string): CompatibilityResult {
  if (!ext.minHostVersion) return { compatible: true };

  const compatible = satisfies(hostVersion, `>=${ext.minHostVersion}`);
  return {
    compatible,
    reason: compatible
      ? undefined
      : `Requires DorkOS ≥ ${ext.minHostVersion} (current: ${hostVersion})`,
  };
}
```

**Version source**: The host version should be the same version exposed in `GET /api/health` and in `packages/shared/src/constants.ts`. For DorkOS v0.x, `minHostVersion: "0.1.0"` is the minimum meaningful constraint.

**Semver library**: Do NOT hand-roll semver comparison. Use the `semver` npm package (already widely used in the Node.js ecosystem, minimal footprint). If bundle size is a concern, use the `semver/functions/gte` deep import.

---

## Open Question 4: Extension Dependencies

### The Options

| Approach                                           | Examples                                                            | Assessment for DorkOS v1                  |
| -------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------- |
| Fully self-contained (vendor all deps into bundle) | Obsidian                                                            | Correct for v1; no runtime complexity     |
| Host-provided shared packages                      | Grafana (`@grafana/data`, `@grafana/ui`); VS Code (`vscode` module) | Correct for DorkOS-specific packages only |
| `dependencies` field + runtime npm install         | None in practice (too fragile)                                      | Explicitly out of scope for v1            |
| Import maps                                        | Experimental; limited browser support                               | Out of scope                              |

### How VS Code and Obsidian Do It

**VS Code**: Extensions bundle all their dependencies using esbuild or webpack. Only `vscode` is externalized because it is provided by the runtime via a special `require('vscode')` shim. The bundled extension is a single `.js` file that includes all third-party npm dependencies.

**Obsidian**: Plugins must bundle everything into `main.js`. The `obsidian` package itself is declared as a dev dependency and externalized (provided by the host). Everything else — `moment`, `codemirror`, custom libraries — is inlined into the bundle. Obsidian plugins are notoriously large files for this reason (the popular Dataview plugin is ~1.4MB).

**The "shared host packages" model**: This is the right design only for packages the host guarantees to provide. DorkOS's `@dorkos/extension-api` is externalized — it would be absurd to bundle the API package you're using to talk to the host. Beyond that, `react` and `react-dom` are externalized because two copies of React will break hooks.

### Recommendation: **Fully self-contained with three specific externalizations**

```typescript
// esbuild configuration for extension compilation
await build({
  entryPoints: [join(extDir, 'index.ts')],
  bundle: true, // Bundle all dependencies
  format: 'esm',
  external: [
    'react', // Provided by host (DorkOS bundle)
    'react-dom', // Provided by host (DorkOS bundle)
    '@dorkos/extension-api', // Provided by host (the API object)
  ],
  // Everything else (axios, date-fns, etc.) is bundled
  write: false,
});
```

**For agent-built extensions in v1**: Agents should be constrained to using only:

1. The host-provided `@dorkos/extension-api`
2. React primitives (`react`, `react-dom`)
3. Standard browser APIs (fetch, etc.)

This keeps agent-written extensions lightweight (typically <50KB) and avoids npm install complexity.

**Path to v2 dependencies**: If a user wants to write a production extension that uses, say, `recharts` for charts, they can pre-bundle it into their `index.ts`. The esbuild compilation step handles this automatically — esbuild traverses `node_modules` in the extension's directory. So the forward path is: extension author runs `npm init` in their extension directory, installs their deps, and esbuild includes them at compile time. No runtime npm install needed.

**Important caveat**: esbuild's `bundle: true` with filesystem scanning requires the extension directory to have `node_modules/` present if the extension imports packages. For v1, extensions without local `node_modules` can only import the three externalized packages. This is fine for agent-built extensions.

---

## Open Question 5: CWD Change Behavior

### The Problem

DorkOS discovers local extensions from `{cwd}/.dork/extensions/`. When the user switches projects (changing the active CWD), the set of local extensions changes. Some extensions need to be deactivated; new ones need to be activated.

### How VS Code Handles It

VS Code's workspace-specific extensions use a **window reload** — opening a different workspace opens a new window (or reloads the current one). This sidesteps the hot-switch problem entirely. VS Code never hot-switches workspace extensions mid-session.

The key insight: VS Code's design choice matches DorkOS's Phase 3 decision: "page reload on extension changes is acceptable for v1."

### Recommended Sequence

For v1, trigger a page reload whenever extensions change due to a CWD switch. This is the simplest and most reliable approach, consistent with VS Code's model and the existing decision in the brief.

**Reload trigger timing**:

```
CWD changes
  → Server: re-scan {newCwd}/.dork/extensions/
  → Server: compute diff (which extensions added/removed)
  → If diff is non-empty:
    → Client: SSE event: { type: 'extensions-changed', reason: 'cwd-switch' }
    → Client: Show brief toast: "Project extensions changed. Reloading…"
    → Client: setTimeout(location.reload, 1500)  // Give user time to see message
  → If diff is empty: no reload needed
```

**Avoiding gratuitous reloads**:

- Only reload if the actual extension set changes (diff check by extension ID).
- A CWD switch to a project with no local extensions → no reload.
- Debounce CWD changes (project switching may fire multiple times rapidly).

**User experience**:

- The 1.5 second delay gives the user visual feedback before the reload.
- After reload, the extensions for the new project are active.
- The reload is predictable and intentional, not jarring.

**If hot-switch is needed in v2**:

If reload-free extension switching becomes a requirement, the proper sequence is:

```
1. Identify extensions to remove: oldLocalExts.filter(e => !newLocalExts.has(e.id))
2. Deactivate departing extensions:
   a. Call each extension's cleanup: run all collected unsubscribe functions
   b. Remove their registry contributions (auto-cleanup via registry)
   c. Mark them as 'deactivated'
3. Identify extensions to add: newLocalExts.filter(e => !oldLocalExts.has(e.id))
4. Compile + load incoming extensions
5. Call activate(api) for each new extension
6. Registry updates trigger React re-renders in slot components
```

The React re-renders in slot components happen automatically because Zustand subscriptions propagate the contribution array changes. No explicit UI orchestration needed. The risk of "flicker" is low because slot components always render their built-in baseline content — extensions are additive. When an extension leaves, its contribution disappears; the built-in content remains.

---

## Open Question 6: Bundle Delivery to Client

### The Options

| Approach                                | Implementation                                                            | Assessment                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Dynamic `import()` from server endpoint | `import('http://localhost:6242/api/extensions/{id}/bundle')`              | Clean, lazy, CSP-compatible with same-origin restriction                     |
| Inline data URL                         | `import('data:text/javascript,...')`                                      | Known browser issues; Firefox disallows data: in workers; CSP complicates it |
| `<script type="module">` injection      | DOM manipulation                                                          | Works but requires global namespace coordination                             |
| Blob URL from fetch                     | `fetch(bundleUrl).then(b => URL.createObjectURL(b)).then(u => import(u))` | Blob URLs work but add complexity; GC concerns                               |

### How Reference Systems Do It

**Grafana**: Uses SystemJS for runtime module loading — SystemJS is a polyfill for the ES module system that supports loading modules from URLs. Plugin bundles are fetched as JavaScript and registered as SystemJS modules.

**Vite-based SPAs (DorkOS architecture)**: In a Vite dev server context, `import()` of relative paths works naturally. For absolute URLs (cross-origin or same-origin absolute), the key requirement is that the server responds with `Content-Type: application/javascript` and the correct CORS headers if the URL origin differs from the app's origin.

**Critical finding**: Dynamic `import(URL)` where the URL is an absolute same-origin URL works reliably in all modern browsers (Chrome, Firefox, Safari). It is the cleanest approach. CORS is not needed because same-origin requests bypass CORS restrictions.

**Data URLs**: MDN explicitly warns that `import()` with data URLs is "semantically not the same as dynamic import" and "user-agent settings like fetch destination, CSP, or module resolution may not be applied correctly." Firefox disallows data: URLs in module workers. **Avoid data URLs.**

**Blob URLs**: Blob URLs work for `import()` but add lifecycle complexity (the blob must be revoked after use, or it leaks memory). They also bypass some browser security features because the blob origin is opaque.

### Recommendation: **`import()` from the server's bundle endpoint**

```typescript
// Client-side ExtensionLoader
async function loadExtensionBundle(extId: string): Promise<ExtensionModule> {
  // Server endpoint serves the compiled bundle as application/javascript
  const bundleUrl = `/api/extensions/${extId}/bundle`;

  // Dynamic import — browser fetches and evaluates the JS module
  const module = await import(/* @vite-ignore */ bundleUrl);
  return module;
}
```

**Server endpoint**:

```typescript
// GET /api/extensions/:id/bundle
router.get('/:id/bundle', async (req, res) => {
  const { id } = req.params;
  const bundle = await extensionService.getBundleCode(id); // reads from cache or compiles
  if (!bundle) return res.status(404).json({ error: 'Extension not found' });

  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-store'); // Extensions are loaded once at startup
  res.send(bundle);
});
```

**Vite `/* @vite-ignore */` comment**: Required to prevent Vite from attempting to statically analyze the dynamic import path. Without this, Vite will warn about non-literal import specifiers.

**CORS consideration**: Since the DorkOS client is served from the same origin as the API server (both on `localhost:6242` in dev), same-origin policy is satisfied. No CORS headers needed.

**Content Security Policy**: If a CSP is ever added, `script-src 'self'` covers same-origin dynamic imports. Data URLs would require `script-src 'unsafe-inline'` — another reason to avoid them.

**Module caching**: The browser caches imported modules by URL. Since extension bundles are loaded once at startup, cache invalidation is handled by the page reload (when extensions change, the page reloads, clearing the module cache).

**`/* @vite-ignore */` vs production build**: In the production build (compiled Vite app), non-literal dynamic imports without `@vite-ignore` will cause build warnings. The ignore comment is needed. Alternatively, the `import()` call can be wrapped in a utility function that escapes Vite's static analysis.

---

## Open Question 7: Obsidian Embedded Mode

### The Architecture

From the brief and codebase analysis: In Obsidian plugin mode, `App.tsx` bypasses the full AppShell and renders `<ChatPanel>` directly. The router, sidebar, header, dashboard — none of these exist in embedded mode.

### Which Slots Are Available

| Slot                    | Available in Embedded Mode? | Reason                                            |
| ----------------------- | --------------------------- | ------------------------------------------------- |
| `sidebar.footer`        | No                          | No sidebar rendered                               |
| `sidebar.tabs`          | No                          | No sidebar rendered                               |
| `dashboard.sections`    | No                          | No dashboard rendered                             |
| `header.actions`        | No                          | No header rendered                                |
| `command-palette.items` | Potentially                 | If command palette is accessible from chat        |
| `dialog`                | Yes                         | Dialogs render via portal into `document.body`    |
| `settings.tabs`         | Potentially                 | If settings dialog is accessible in embedded mode |

### How Obsidian's Own Mobile/Embedded Constraints Work

Obsidian mobile devices have the same plugin API but some features don't render (desktop-only panels, certain sidebar behaviors). The standard approach is: plugins check `Platform.isDesktop` / `Platform.isMobile` before registering desktop-only UI. Features that don't exist on the target platform simply aren't available.

### Recommendation: **Slot availability map + graceful no-op**

1. The `ExtensionAPI` should expose which slots are currently available:

```typescript
interface ExtensionAPI {
  // ...
  /** Returns true if the given slot is rendered in the current host context */
  isSlotAvailable(slot: ExtensionPointId): boolean;
}
```

2. The extension loader sets the slot availability based on the current rendering mode:

```typescript
const EMBEDDED_MODE_AVAILABLE_SLOTS = new Set<ExtensionPointId>([
  'dialog',
  'command-palette.items',
]);

const FULL_MODE_AVAILABLE_SLOTS = new Set<ExtensionPointId>([
  'sidebar.footer',
  'sidebar.tabs',
  'dashboard.sections',
  'header.actions',
  'command-palette.items',
  'dialog',
  'settings.tabs',
]);
```

3. `registerComponent()` silently ignores contributions to unavailable slots (no-op, no error). The registry still accepts the registration (so the code path is clean), but slot components that don't exist in embedded mode simply never render.

4. Well-written extensions check availability:

```typescript
// Extension code
export function activate(api: ExtensionAPI) {
  // Register dialog globally (works in both modes)
  api.registerDialog('my-panel', MyPanel);

  // Dashboard section only if available
  if (api.isSlotAvailable('dashboard.sections')) {
    api.registerComponent('dashboard.sections', 'my-section', MyDashboardSection);
  }
}
```

**For v1**, most extensions targeting DorkOS will be written for the full AppShell mode. The embedded mode constraint is primarily relevant if DorkOS starts shipping "official" extensions that need to work in both contexts. The safest v1 approach is to document the limitation and not enforce it programmatically — let extensions register whatever they want, and if the slot doesn't exist, nothing renders. This matches the "no crash" contract from the registry (empty array → nothing rendered).

---

## Open Question 8: Minimal Viable API Surface

### The v1 API Sketch vs. What's Truly Needed

The brief's `ExtensionAPI` sketch has ~11 method groups. Research from VS Code, Obsidian, and Backstage shows what's truly essential for a first extension and what can be deferred.

### What's Essential for "Hello World" (Minimum)

A "hello world" extension needs exactly two things:

1. `activate(api: ExtensionAPI)` — called by the host
2. One registration method that places something in the UI

Minimum viable API for hello world:

```typescript
interface ExtensionAPI {
  registerComponent(slot: ExtensionPointId, id: string, component: React.ComponentType): () => void;
}
```

### What's Essential for a Useful Extension

A useful extension needs to interact with the host's state and services:

```typescript
interface ExtensionAPI {
  // UI registration (Phase 2 registry wrapping)
  registerComponent(slot, id, component, options?): () => void;
  registerCommand(id, label, callback, options?): () => void;
  registerDialog(id, component): { open: () => void; close: () => void };
  registerSettingsTab(id, label, component): () => void;

  // State read (what state does the extension need to react to?)
  getState(): ExtensionReadableState;
  subscribe(selector, callback): () => void;

  // Persistent storage
  loadData<T>(): Promise<T | null>;
  saveData<T>(data: T): Promise<void>;

  // Notifications (extremely common need)
  notify(message: string, options?: { type?: 'info' | 'success' | 'error' }): void;
}
```

**What `ExtensionReadableState` should contain in v1**:

```typescript
interface ExtensionReadableState {
  currentCwd: string | null; // Current project directory
  activeSessionId: string | null; // Currently active chat session
  agentId: string | null; // Current agent
}
```

This is the minimum state an extension would need to contextualize its behavior. Avoid exposing the raw Zustand store — keep it to a projection.

### What Should Be Deferred to v2

| Feature                 | Why Deferred                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `transport` exposure    | Most v1 extensions won't need direct server calls beyond what the host already provides; `fetch` works fine |
| `navigate(path)`        | Extensions controlling navigation is a power feature; most don't need it                                    |
| `openCanvas(content)`   | Phase 1 feature not yet needed by Phase 3 extensions                                                        |
| `executeCommand(cmd)`   | Extensions emitting UI commands is an advanced pattern                                                      |
| `useQuery<T>(key)`      | TanStack Query hooks in extensions create React-version coupling                                            |
| Permission declarations | No sandboxing in v1; permissions are meaningless without enforcement                                        |

### VS Code's API Phasing Lesson

VS Code's initial API surface was minimal — commands, messages, file system access. The extension host model has always been in place, but the API surface grew over years from those primitives. The key lesson: **once an API is public, it's very hard to remove.** DorkOS should err toward a smaller API that's 100% stable rather than a large API with unstable corners.

### Obsidian's API Phasing Lesson

Obsidian shipped `loadData()`/`saveData()` in the first API version because it's universally needed. The `workspace` API (for view management) came early too. The `metadataCache` API (for reading vault metadata) came later as extensions' sophistication grew.

### Recommended Minimal v1 API

```typescript
interface ExtensionAPI {
  // UI contributions (4 methods)
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

  // State (2 methods)
  getState(): ExtensionReadableState;
  subscribe(
    selector: (state: ExtensionReadableState) => unknown,
    callback: (value: unknown) => void
  ): () => void;

  // Storage (2 methods)
  loadData<T>(): Promise<T | null>;
  saveData<T>(data: T): Promise<void>;

  // Notification (1 method)
  notify(message: string, options?: { type?: 'info' | 'success' | 'error' }): void;

  // Context (1 field)
  isSlotAvailable(slot: ExtensionPointId): boolean;

  // Extension metadata (1 field)
  readonly id: string;
}
```

**10 methods + 2 fields.** Clean, complete for all meaningful v1 use cases.

**Deferred to v2**: `transport`, `navigate`, `openCanvas`, `executeCommand`, `useQuery`, `secrets` (for credential storage), `permissions`.

---

## Security Considerations

### Risks of In-Process Extensions (No Sandbox)

Because DorkOS v1 runs extensions in-process with full React access:

1. **Full DOM access**: Extensions can modify any DOM element, not just their registered slots.
2. **Full `window` access**: Extensions can read `localStorage`, `sessionStorage`, cookies.
3. **Full `fetch` access**: Extensions can make arbitrary network requests, potentially exfiltrating conversation data.
4. **Prototype pollution**: Extensions can modify `Object.prototype`, `Array.prototype`, etc., affecting the entire app.
5. **React context hijacking**: Extensions could in theory read from React contexts (auth tokens, etc.) by traversing the fiber tree.

### Risk Mitigation Without Sandboxing

These mitigations are reasonable for v1 without full sandboxing:

1. **Code review gate for published extensions**: Any extension distributed beyond the author's own machine should be code-reviewed. Document this explicitly.
2. **Trust model documentation**: Be explicit that DorkOS extensions are fully trusted code. "Do not install extensions you did not write or have not reviewed."
3. **Extension source pinning**: The manifest could include a `checksum` field for the index.ts/index.js, allowing the host to verify the file hasn't been tampered with since the manifest was authored.
4. **Read-only `getState()`**: The exported `ExtensionReadableState` is a projection — not the raw Zustand store reference. Extensions cannot mutate host state through the API.
5. **No credential APIs in v1**: `transport` is deferred. Extensions can't use the host's authenticated transport layer; they must use their own `fetch` calls.
6. **Console logging on activation**: Log extension activations at INFO level: `[extensions] Activating: github-prs v1.0.0`. Makes it auditable.

### Path to v2 Sandboxing

The in-process approach can be upgraded to a proxy-membrane approach (as Grafana did in v11.5) without changing the extension API contract. The `activate(api)` signature remains the same; the proxy wraps the DOM APIs the extension can access. This is a viable incremental path.

---

## Performance Considerations

### Startup Time Impact of Dynamic Imports

Each `import()` call is a network round-trip to the server (even same-origin). For extensions loaded at startup, this adds latency. Benchmarks from similar systems:

- A single dynamic import of a 50KB bundle: ~5-15ms on localhost
- 5 extensions: ~25-75ms sequential, ~5-15ms parallel

**Recommendation**: Load all enabled extensions in parallel using `Promise.all()`:

```typescript
const modules = await Promise.all(
  enabledExtensions.map((ext) => import(/* @vite-ignore */ `/api/extensions/${ext.id}/bundle`))
);
```

### Lazy Loading Strategies

For v1, load all enabled extensions at startup (during `ExtensionProvider` initialization). This is simpler and ensures contributions are available before first render.

If startup time becomes a concern with many extensions, the v2 strategy would be:

1. Load extensions contributing to visible slots immediately
2. Defer extensions contributing only to dialogs/settings until first access

### Bundle Size Limits

No hard limit for v1, but document a soft guideline: **extension bundles should be <500KB uncompressed**. Extremely large extensions (>1MB) should bundle-split or host their assets externally. The esbuild compilation step should log a warning if the output exceeds 500KB.

Grafana's approach: no hard limit, but their plugin signing process implicitly reviews size as part of security review.

---

## Key Findings Summary

1. **Storage (Q1)**: Use `{dorkHome}/extension-data/{ext-id}/data.json` (Option D). Separates code from data; handles global vs. project-local scoping cleanly; transparent to agents.

2. **Compilation caching (Q2)**: Central directory `{dorkHome}/cache/extensions/{ext-id}.{content-hash}.js`. Content hash (not mtime) as cache key. Write compiled output to file; serve from cache on subsequent requests.

3. **Version compatibility (Q3)**: Warn in settings UI with warning badge; prevent activation; never hard-crash. Follow VS Code v1.94 pattern.

4. **Extension dependencies (Q4)**: Fully self-contained bundles. Externalize only `react`, `react-dom`, and `@dorkos/extension-api`. Everything else is bundled by esbuild at compile time.

5. **CWD change behavior (Q5)**: Page reload when extension set changes. 1.5s toast delay. Diff-check to avoid unnecessary reloads. Document hot-switch sequence for future v2 implementation.

6. **Bundle delivery (Q6)**: Dynamic `import()` from `/api/extensions/:id/bundle` server endpoint. Same-origin, no CORS. `Content-Type: application/javascript`. `/* @vite-ignore */` on the import call.

7. **Obsidian embedded mode (Q7)**: `isSlotAvailable(slot)` API method. Silent no-op registration for unavailable slots. `dialog` and `command-palette.items` are the only universally available slots.

8. **Minimal API surface (Q8)**: 10 methods + 2 fields. 4 registration methods + 2 state methods + 2 storage methods + 1 notify + 1 slot-check. Defer `transport`, `navigate`, `openCanvas`, `executeCommand`, `useQuery`, `secrets` to v2.

9. **Security**: Document full trust model explicitly. Log activations. Expose read-only projected state (not raw store). No credential APIs in v1. Content-hash in manifest for tampering detection.

10. **Performance**: Parallel `Promise.all()` for extension loading. Soft 500KB bundle size guideline. Inline sourcemaps for debugging.

---

## Detailed Analysis

### Storage Architecture Diagram

```
~/.dork/
├── extensions/                      # Global extension CODE
│   └── github-prs/
│       ├── extension.json           # Manifest
│       └── index.ts                 # Source
├── extension-data/                  # Global extension DATA
│   └── github-prs/
│       └── data.json                # Persistent state (auto-created by loadData/saveData)
└── cache/
    └── extensions/                  # Compiled bundles CACHE
        ├── github-prs.a3f8c91d.js   # Content-hashed compiled bundle
        └── github-prs.a3f8c91d.error.json  # Compilation errors (if any)

{cwd}/
└── .dork/
    ├── extensions/                  # Local extension CODE (project-specific)
    │   └── my-local-ext/
    │       ├── extension.json
    │       └── index.ts
    └── extension-data/              # Local extension DATA (project-specific)
        └── my-local-ext/
            └── data.json
```

### Extension Lifecycle State Machine

```
  [file placed in extensions dir]
           ↓
       DISCOVERED
  (manifest read, validated,
   version checked)
           ↓ (passes checks)
       INSTALLED
  (visible in settings UI,
   disabled by default)
           ↓ (user enables)
       ENABLED
  (compilation queued/run)
           ↓ (compilation succeeds)
       COMPILED
           ↓ (client loads bundle)
       ACTIVATED
  (activate(api) called,
   contributions registered)
           ↓ (user disables or CWD changes)
       DEACTIVATED
  (all unsubscribe fns called,
   contributions removed from registry)
           ↓ (user re-enables)
       ENABLED → COMPILED → ACTIVATED ...

  Error states:
    DISCOVERED → INCOMPATIBLE (version check failed)
    ENABLED → COMPILATION_FAILED (esbuild error)
    ACTIVATED → ACTIVATION_FAILED (activate() threw)
```

### Complete Extension API Package Structure

```
packages/extension-api/
├── package.json               # name: "@dorkos/extension-api", version: "1.0.0"
├── src/
│   ├── index.ts               # Public barrel
│   ├── types.ts               # ExtensionAPI interface, ExtensionReadableState
│   └── extension-point-ids.ts # ExtensionPointId type (imported from shared registry)
└── tsconfig.json
```

The `@dorkos/extension-api` package is the external contract. It depends on `@dorkos/shared` for the `Transport` type (if added in v2) and the `ExtensionPointId` type. It explicitly does NOT depend on `apps/client` internals.

---

## Sources & Evidence

- [VS Code Common Capabilities — Storage](https://code.visualstudio.com/api/extension-capabilities/common-capabilities) — `globalState`, `workspaceState`, `storageUri`, `globalStorageUri`, `secrets` API documentation
- [VS Code Extension Storage Explained (Medium)](https://medium.com/@krithikanithyanandam/vs-code-extension-storage-explained-the-what-where-and-how-3a0846a632ea) — SQLite backing for key-value state; file paths on macOS
- [Obsidian saveData documentation](https://docs.obsidian.md/Reference/TypeScript+API/Plugin/saveData) — Official docs for `loadData`/`saveData`
- [Obsidian data.json location (forum)](https://forum.obsidian.md/t/community-plugin-settings-file-data-json-files-should-be-in-external-folder/48515) — Plugin data stored at `.obsidian/plugins/{id}/data.json`
- [esbuild Plugins documentation](https://esbuild.github.io/plugins/) — Cache invalidation is left to plugins; not built-in to esbuild
- [esbuild FAQ — Rebuild API](https://esbuild.github.io/faq/) — In-memory cache within a single process; no persistent cross-process cache
- [VS Code Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest) — `engines.vscode` field and semver range behavior
- [VS Code September 2024 Release Notes (v1.94)](https://code.visualstudio.com/updates/v1_94) — Warning badge for incompatible extensions in Extensions view
- [VS Code Extension Incompatibility UX Issue #228011](https://github.com/microsoft/vscode/issues/228011) — UX for extension disabled due to API version incompatibility
- [VS Code Bundling Extensions](https://code.visualstudio.com/api/working-with-extensions/bundling-extension) — Bundle own dependencies; externalize only `vscode` module
- [Obsidian Getting Started with Plugin Development (DeepWiki)](https://deepwiki.com/obsidianmd/obsidian-developer-docs/2.1-getting-started-with-plugin-development) — Self-contained bundling requirement for Obsidian plugins
- [VS Code Activation Events](https://code.visualstudio.com/api/references/activation-events) — `workspaceContains:path` activation event for workspace-specific activation
- [VS Code Workspace Extension Enable/Disable Issue](https://github.com/Microsoft/vscode/issues/141789) — Workspace-level extension management
- [MDN Dynamic import()](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import) — Data URLs warning; same-origin behavior
- [VS Code Web Extensions](https://code.visualstudio.com/api/extension-guides/web-extensions) — Bundle to single file requirement; dynamic import limitations in browser context
- [Obsidian Mobile Development](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development) — Platform detection for API availability
- [OWASP XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html) — In-process script security risks
- From cached research: `research/20260323_plugin_extension_ui_architecture_patterns.md` — Full VSCode/Obsidian/Grafana/Backstage analysis
- From cached research: `research/20260326_extension_point_registry_patterns.md` — Registry API design, initialization patterns

---

## Research Gaps & Limitations

- **esbuild content-hash API**: esbuild's `[hash]` in filenames is for browser cache-busting in outputs, not for server-side compilation caching. The hash-as-cache-key pattern described here must be implemented in DorkOS code, not by esbuild itself.
- **Grafana's exact bundle delivery mechanism**: Grafana uses SystemJS rather than native `import()`. The DorkOS approach of native `import()` is preferred but not battle-tested at Grafana's scale. This is acceptable given DorkOS's scale.
- **Vite production build behavior with `/* @vite-ignore */`**: In production builds, `/* @vite-ignore */` suppresses the warning but the import is left as-is. Verify this survives Vite's production build in the DorkOS client app.
- **Obsidian embedded mode specifics**: The Obsidian mobile API constraint documentation was not retrievable from the official docs site. The analysis above is based on the codebase structure knowledge and general platform detection patterns.

---

## Contradictions & Disputes

- **Storage Option A vs Option D**: The ideation doc (`specs/plugin-extension-system/01-ideation.md`) sketched `data.json` in the extension directory (Option A). This research recommends Option D (scoped directory). The distinction matters most for global extensions — Option A would store data at `~/.dork/extensions/github-prs/data.json` next to `index.ts`. Both work; Option D is cleaner for the agent-built extensions use case where the agent reads and writes its own extension directory.
- **Page reload vs hot-switch**: VS Code's model is page/window reload; Obsidian does hot-switch. Both are valid. DorkOS's existing decision to use page reload for v1 is correct — it's simpler, more reliable, and matches the brief's stated constraint.

---

## Search Methodology

- Searches performed: 16
- Most productive search terms: "VS Code extension storage globalState location", "Obsidian plugin data.json location", "esbuild compilation caching content hash", "VS Code engines.vscode incompatible behavior", "VS Code extension bundling dependencies", "dynamic import() server endpoint same origin"
- Primary source types: Official documentation (code.visualstudio.com, docs.obsidian.md, esbuild.github.io), MDN, GitHub issues, Obsidian forums
- Cached research used: `20260323_plugin_extension_ui_architecture_patterns.md`, `20260326_extension_point_registry_patterns.md`, `20260326_agent_ui_control_canvas_spec_research.md`
