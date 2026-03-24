---
title: 'Plugin/Extension UI Architecture Patterns: VSCode, Obsidian, Grafana, and React SPAs'
date: 2026-03-23
type: external-best-practices
status: active
tags:
  [
    plugin-system,
    extension-architecture,
    vscode,
    obsidian,
    grafana,
    react,
    module-federation,
    sandboxing,
    webview,
    backstage,
    contribution-points,
  ]
searches_performed: 14
sources_count: 38
---

# Plugin/Extension UI Architecture Patterns

**Date**: 2026-03-23
**Research Depth**: Deep Research

---

## Research Summary

This report provides a detailed technical comparison of how VSCode, Obsidian, Grafana, and several React-based systems implement client-side UI extensibility. The key tension every system faces is the same: giving plugins enough UI power to be useful while preventing them from destabilizing the host. The solutions range from VSCode's strict process isolation + declarative manifests (highest safety, most constrained) to Obsidian's zero-sandbox direct DOM access (maximum power, no guardrails). Grafana recently introduced a proxy-based sandbox using near-membrane/detached-iframe techniques (Grafana 11.5, Jan 2025). For React SPAs, Backstage's extension factory pattern and Module Federation are the most mature approaches, with iframe sandboxing remaining the only truly secure option for untrusted code.

---

## Key Findings

### 1. VSCode: Declarative Contribution Points + Process Isolation + Webview Iframes

VSCode has the most sophisticated and layered extension UI model. Three mechanisms work together:

- **Contribution Points** (declarative JSON in `package.json`) declare UI intent without executing code
- **Extension Host** (separate Node.js process) runs all extension logic isolated from the UI thread
- **Webviews** (sandboxed iframes) provide arbitrary HTML rendering with message-passing communication

This layered approach means VSCode can read contribution points at startup without activating extensions, maintaining fast startup. Extensions only load when their activation events fire.

### 2. Obsidian: Full Trust, Direct DOM, No Sandboxing

Obsidian takes the opposite approach: plugins get direct access to the `App` object and full DOM manipulation via `contentEl`. There is zero sandboxing. Plugins can read/write any file, modify any part of the UI, and access all internal state. The trade-off is maximum developer velocity and plugin power at the cost of security. A malicious plugin can execute `rm -rf ~/`.

### 3. Grafana: SystemJS Loading + Recent Proxy-Based Sandbox

Grafana loads plugins at runtime via SystemJS, renders them as React components receiving typed props (`PanelProps`), and shares core packages (`@grafana/ui`, `@grafana/data`). As of Grafana 11.5 (Jan 2025), a new "Frontend Sandbox" isolates plugin code in a separate JavaScript context, preventing DOM manipulation outside designated areas. The implementation likely uses Salesforce's near-membrane library (detached-iframe + proxy membrane), based on Grafana's dependency patterns, though the exact implementation is not publicly documented.

### 4. React SPA Plugin Systems: No Silver Bullet

For React SPAs, the choices are: Module Federation (runtime code sharing, no isolation), iframe sandboxing (strong isolation, communication overhead), or in-process extension points (Backstage pattern: factory functions + typed APIs, no isolation). No single approach gives both full React integration and strong isolation.

---

## Detailed Analysis

### VSCode Extension UI Architecture

#### Contribution Points System

Extensions declare UI contributions entirely in `package.json` under the `contributes` key. VSCode reads these at startup **without executing any extension code**. This is the critical architectural insight: UI registration is data, not code.

The 34+ contribution points include:

| Contribution Point | What It Does                                     | Where It Appears                |
| ------------------ | ------------------------------------------------ | ------------------------------- |
| `viewsContainers`  | Registers new sidebar/panel containers           | Activity Bar or Panel area      |
| `views`            | Populates containers with tree views or webviews | Inside viewsContainers          |
| `menus`            | Adds items to context menus, title bars, etc.    | Specific menu locations via IDs |
| `commands`         | Registers callable commands                      | Command Palette, keybindings    |
| `customEditors`    | Associates file types with custom editors        | Editor area                     |
| `keybindings`      | Binds keyboard shortcuts to commands             | Global key handling             |
| `colors`           | Registers themable color tokens                  | Theme system                    |
| `configuration`    | Declares settings schema                         | Settings UI                     |

Each contribution point has a `when` clause system for conditional visibility using context keys (e.g., `"when": "resourceExtname == .md"`). This gives VSCode fine-grained control over when extension UI appears without running extension code.

Example manifest declaring a custom sidebar view:

```json
{
  "contributes": {
    "viewsContainers": {
      "activitybar": [{ "id": "my-explorer", "title": "My Explorer", "icon": "resources/icon.svg" }]
    },
    "views": {
      "my-explorer": [{ "id": "my-tree", "name": "Items", "when": "workspaceFolderCount > 0" }]
    }
  }
}
```

VSCode processes this declaratively at startup — the sidebar icon appears, the view container exists — but the extension's JavaScript hasn't loaded yet.

#### Extension Host Process Isolation

All extension JavaScript runs in a **separate Node.js process** called the Extension Host:

- **One Extension Host per window** (all extensions share it)
- Communication with the main UI process via **JSON-RPC IPC**
- Extensions can spawn child processes freely
- A crashing/hanging extension cannot freeze the UI
- Three variants: local (Node.js), web (WebWorker), remote (container/SSH)

The Extension Host exposes the `vscode` API namespace. Extensions cannot directly access DOM, Electron APIs, or the renderer process. All UI operations go through the API layer which serializes requests back to the main process.

This architecture means:

- The UI thread is **always responsive** regardless of extension behavior
- Extensions are **lazily loaded** — only activated when their activation events fire
- The API surface is the **only contract** — internals can change freely

#### Webview Panels (Arbitrary HTML UI)

For custom UI beyond tree views, extensions create Webview Panels — sandboxed iframes:

**Isolation model:**

- Webview content runs in a **sandboxed iframe** served from a separate origin
- The iframe cannot access the extension host, VS Code APIs, or local filesystem directly
- Communication is **exclusively via `postMessage()`** — async, JSON-serializable messages
- Content Security Policy is enforced; `default-src 'none'` is recommended baseline

**Message passing API:**

```typescript
// Extension side (runs in Extension Host process)
panel.webview.postMessage({ command: 'update', data: items });
panel.webview.onDidReceiveMessage((msg) => {
  /* handle */
});

// Webview side (runs in iframe)
const vscode = acquireVsCodeApi(); // call once
vscode.postMessage({ command: 'save', payload: formData });
window.addEventListener('message', (event) => {
  /* handle */
});
```

**Lifecycle:**

1. `createWebviewPanel()` — extension creates the panel
2. Webview content rendered only when **visible** (background tabs destroyed)
3. `onDidChangeViewState` — fires on visibility/position changes
4. `onDidDispose` — fires on close for cleanup

**State persistence (three strategies):**

1. `getState()/setState()` — webview-side JSON storage, persists across hide/show but not disposal
2. `WebviewPanelSerializer` — enables restoration across VS Code restarts
3. `retainContextWhenHidden` — keeps iframe alive in background (high memory cost)

**Resource loading:**

- Local files loaded via `webview.asWebviewUri()` which converts to a special scheme
- `localResourceRoots` restricts accessible directories
- Service worker intercepts resource requests and delegates to main process

**Key insight:** Webviews are where React/Vue/Svelte apps live inside VS Code extensions. The extension's React app runs in the iframe; state syncs via postMessage. This is why VS Code extensions with rich UI feel slightly different from native UI — they ARE separate web apps communicating over a message bridge.

#### Tree Views vs. Webviews

| Aspect            | Tree View                      | Webview                          |
| ----------------- | ------------------------------ | -------------------------------- |
| Declaration       | Contribution point in manifest | Created in code                  |
| UI flexibility    | Hierarchical list only         | Arbitrary HTML/CSS/JS            |
| Isolation         | Rendered by VS Code (safe)     | Sandboxed iframe (safe)          |
| Performance       | Native rendering               | Full iframe overhead             |
| State             | Managed by TreeDataProvider    | Manual (setState/postMessage)    |
| Theme integration | Automatic                      | Must read CSS variables manually |

---

### Obsidian Plugin UI Architecture

#### Plugin Discovery and Loading

Plugins are distributed as folders in `.obsidian/plugins/<plugin-id>/` containing:

- `manifest.json` — metadata (id, name, version, minAppVersion)
- `main.js` — bundled JavaScript entry point
- `styles.css` — optional global CSS

**Discovery:** Obsidian scans the plugins directory on startup.
**Loading:** Disabled by default via "Restricted Mode." When enabled, Obsidian loads `main.js` directly — no bundler, no module system, just `eval`-equivalent script execution.

#### Plugin Lifecycle

```typescript
export default class MyPlugin extends Plugin {
  // Called when plugin is enabled
  async onload() {
    // Register commands, views, events, settings
    this.addCommand({ id: 'my-cmd', name: 'Do Thing', callback: () => {} });
    this.registerView(VIEW_TYPE, (leaf) => new MyView(leaf));
    this.registerEvent(this.app.vault.on('modify', (file) => {}));
    this.addSettingTab(new MySettingTab(this.app, this));
  }

  // Called when plugin is disabled
  onunload() {
    // Only for resources NOT registered via register*() methods
    // Registered resources auto-cleanup
  }

  // Called once after first install (v1.7.2+)
  onUserEnable() {}

  // Called when settings modified externally
  onExternalSettingsChange() {}
}
```

**Key design:** All `register*()` and `add*()` methods track registrations. On `onunload()`, Obsidian automatically cleans up registered commands, events, views, DOM listeners, and intervals. Plugins only need manual cleanup for resources they manage outside this system.

#### The `App` Object — Full State Access

Plugins receive `this.app` — the central hub providing unrestricted access to everything:

| Property            | Access                                                    |
| ------------------- | --------------------------------------------------------- |
| `app.vault`         | Low-level file I/O (read, write, delete, rename any file) |
| `app.workspace`     | UI layout, leaves, views, active pane management          |
| `app.metadataCache` | Cached markdown metadata (links, headings, tags)          |
| `app.fileManager`   | High-level file ops respecting user settings              |
| `app.keymap`        | Keyboard shortcut management                              |
| `app.scope`         | Hierarchical hotkey scope control                         |

There are no permission boundaries. A plugin can `app.vault.adapter.read('/etc/passwd')` or modify any file in the vault or anywhere on disk the process has access.

#### ItemView and the Workspace Leaf System

The workspace is a **tree data structure** with three special root splits:

```
Workspace
├── leftSplit (sidebar)
│   └── WorkspaceTabs
│       └── WorkspaceLeaf → View (e.g., file explorer)
├── rootSplit (main editor area)
│   └── WorkspaceSplit (vertical)
│       ├── WorkspaceTabs
│       │   └── WorkspaceLeaf → MarkdownView
│       └── WorkspaceTabs
│           └── WorkspaceLeaf → CustomItemView
└── rightSplit (sidebar)
    └── WorkspaceTabs
        └── WorkspaceLeaf → View
```

**Node types:**

- **Splits** (WorkspaceSplit) — arrange children linearly (vertical/horizontal)
- **Tabs** (WorkspaceTabs) — display one child at a time with tab bar
- **Leaves** (WorkspaceLeaf) — terminal nodes that contain a single View

**View hierarchy:**

```
View (abstract)
└── ItemView (abstract — has contentEl, navigation, toolbar)
    └── FileView
        └── EditableFileView
            └── TextFileView
                └── MarkdownView
```

**Custom view registration:**

```typescript
// In onload()
this.registerView(VIEW_TYPE_EXAMPLE, (leaf: WorkspaceLeaf) => {
  return new ExampleView(leaf);
});

// Custom view class
class ExampleView extends ItemView {
  getViewType(): string { return VIEW_TYPE_EXAMPLE; }
  getDisplayText(): string { return 'Example View'; }

  async onOpen() {
    // this.contentEl is the DOM container — direct DOM manipulation
    this.contentEl.createEl('h1', { text: 'Hello' });

    // Or mount React/Svelte/etc.
    const root = createRoot(this.contentEl);
    root.render(<MyComponent app={this.app} />);
  }

  async onClose() {
    // Cleanup (React unmount, etc.)
  }
}
```

**Opening a custom view:**

```typescript
// Get or create a leaf in the right sidebar
const leaf = this.app.workspace.getRightLeaf(false);
await leaf.setViewState({ type: VIEW_TYPE_EXAMPLE, active: true });
this.app.workspace.revealLeaf(leaf);
```

**Key constraint:** Plugins are responsible for removing leaves they create. `detach()` removes a single leaf; `detachLeavesOfType(type)` removes all.

#### No Sandboxing — Deliberate Design Choice

Obsidian explicitly chose no sandboxing:

- Plugins run in the same Electron renderer process as the app
- Full access to `window`, `document`, `require('fs')`, Node.js APIs
- Can modify any DOM element, monkey-patch any method, intercept any event
- "Due to technical limitations in the plugin architecture, Obsidian cannot implement granular permission controls"
- Mitigation: "Restricted Mode" (all plugins off) and community code review for published plugins

The community has criticized this: "personal note-taking applications often contain more sensitive information than code repositories, making the security implications more severe."

**DOM manipulation helpers:** Obsidian augments the DOM API with convenience methods:

- `el.createEl('div', { cls: 'my-class', text: 'content' })`
- `el.createDiv()`, `el.createSpan()`
- `el.addClass()`, `el.removeClass()`, `el.toggleClass()`
- `activeWindow`, `activeDocument` for popout window support

---

### Grafana Plugin UI Architecture

#### Plugin Types and Manifest

Three plugin types, all declared in `plugin.json`:

| Type        | What It Provides        | React Interface                             |
| ----------- | ----------------------- | ------------------------------------------- |
| Panel       | Dashboard visualization | `PanelProps` (data, width, height, options) |
| Data Source | Data connectivity       | Config editor + Query editor components     |
| App         | Full pages/navigation   | `PluginPage` component + nested plugins     |

`plugin.json` manifest declares:

```json
{
  "type": "panel",
  "name": "My Panel",
  "id": "myorg-mypanel-panel",
  "dependencies": { "grafanaDependency": { "type": "grafana", "version": ">=10.0.0" } },
  "includes": [{ "type": "page", "name": "Config", "path": "/config", "addToNav": true }]
}
```

`module.ts` is the entry point that exports the plugin class:

```typescript
// Panel plugin
import { PanelPlugin } from '@grafana/data';
export const plugin = new PanelPlugin<MyOptions>(MyPanelComponent).setPanelOptions((builder) => {
  builder.addTextInput({ path: 'text', name: 'Text', defaultValue: 'Hello' });
});
```

#### Runtime Loading via SystemJS

Grafana loads plugins dynamically at runtime using SystemJS:

1. Server discovers plugin directories and reads `plugin.json`
2. Frontend requests plugin `module.js` via SystemJS `import()`
3. Plugin module is evaluated with access to shared packages
4. Shared packages (`@grafana/data`, `@grafana/ui`, `@grafana/runtime`) are pre-loaded as SystemJS modules — plugins import them but don't bundle them

**Shared dependency model:** Plugins declare dependencies on Grafana packages in `plugin.json`. At runtime, these resolve to Grafana's own bundled versions. This is similar to Module Federation's `shared` config — only one copy of React and core libraries exist.

#### Panel Plugin React Interface

Panel plugins are React components receiving typed props:

```typescript
interface PanelProps<T = any> {
  data: PanelData; // Query results
  width: number; // Available width
  height: number; // Available height
  options: T; // User-configured options
  fieldConfig: FieldConfigSource;
  timeRange: TimeRange;
  timeZone: string;
  onOptionsChange: (options: T) => void;
  replaceVariables: (value: string) => string;
  // ... more
}
```

The component renders directly into Grafana's DOM — no iframe, no shadow DOM (without the sandbox).

#### Frontend Sandbox (Grafana 11.5+, Jan 2025)

The new sandbox isolates plugin frontend code:

**What it prevents:**

- Modifying Grafana DOM outside the plugin's designated area
- Interfering with other plugins
- Modifying global browser objects (`window`, `document`, etc.)
- Altering core Grafana features

**Configuration:**

```ini
[security]
# Comma-separated plugin IDs to sandbox
plugin_frontend_sandbox = myorg-mypanel-panel,another-plugin
```

**Implementation (inferred from Grafana's patterns and near-membrane ecosystem):**

- Most likely uses Salesforce's **near-membrane** library or similar proxy-membrane approach
- Creates a detached same-domain iframe for a separate JavaScript realm
- Wraps all host objects (DOM, APIs) in proxy membranes controlling what the sandboxed code can access
- Plugin React components still render, but their DOM access is mediated through proxies

**Limitations:**

- Angular-based plugins not supported
- Grafana Labs-signed plugins cannot be sandboxed
- Performance impact acknowledged but not quantified
- Public preview status (not yet GA)

**Key insight:** Grafana chose proxy-based isolation over iframes because plugins are React components that need to render in the host's React tree. An iframe would break the React rendering model. The membrane approach lets the component render "normally" while intercepting dangerous operations.

---

### React SPA Plugin Approaches

#### Module Federation (Webpack 5 / Rspack)

Module Federation enables runtime code sharing between independently built applications:

**How it works:**

```javascript
// Remote app (plugin) webpack config
new ModuleFederationPlugin({
  name: 'pluginA',
  filename: 'remoteEntry.js',
  exposes: {
    './Panel': './src/components/Panel',
  },
  shared: { react: { singleton: true }, 'react-dom': { singleton: true } },
});

// Host app webpack config
new ModuleFederationPlugin({
  name: 'host',
  remotes: {
    pluginA: 'pluginA@http://localhost:3001/remoteEntry.js',
  },
  shared: { react: { singleton: true }, 'react-dom': { singleton: true } },
});

// Host app usage
const PluginPanel = React.lazy(() => import('pluginA/Panel'));
```

**Critical detail:** A `bootstrap.js` indirection file is required — Webpack needs a chance to negotiate shared modules before the app renders. Without it, shared singletons fail.

**Tradeoffs:**
| Pro | Con |
|---|---|
| True runtime loading, no rebuild needed | No isolation whatsoever |
| Shared React instance (singleton) | Webpack-specific (or Rspack) |
| Lazy loading via React.lazy + Suspense | Version conflicts if singleton mismatch |
| Full React integration, no message passing | Plugin crash = host crash |
| Hot module replacement works | Requires coordinated shared deps |

**Best for:** Trusted first-party plugins, internal teams, micro-frontends within an org.

#### Iframe-Based Sandboxing

The only approach that provides true security isolation for untrusted plugins:

**Pattern:**

```typescript
// Host
function PluginFrame({ pluginUrl, onMessage }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== pluginUrl) return;
      onMessage(event.data);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return <iframe
    ref={iframeRef}
    src={pluginUrl}
    sandbox="allow-scripts"
    style={{ width: '100%', height: '100%', border: 'none' }}
  />;
}
```

**Tradeoffs:**
| Pro | Con |
|---|---|
| Strong security boundary | Plugin cannot share React tree |
| Plugin crash isolated | Communication via postMessage only |
| Independent styling/CSS | Style/theme sync requires manual work |
| Different framework per plugin | Performance overhead (separate DOM) |
| Browser-native security | Accessibility (focus, keyboard) is hard |

**Key challenge:** The plugin React app and the host React app are **separate React roots**. Sharing context, theme, state, or component libraries requires explicit serialization over postMessage. This is fundamentally why VSCode webviews feel "different" from native UI.

#### Backstage Plugin Architecture (Spotify)

Backstage is the most complete example of a React SPA with a plugin system used in production at scale.

**Plugin creation:**

```typescript
import { createPlugin, createRouteRef } from '@backstage/core-plugin-api';

export const myPlugin = createPlugin({
  id: 'my-plugin',
  routes: {
    root: createRouteRef({ id: 'my-plugin' }),
  },
  apis: [
    createApiFactory({
      api: myApiRef,
      deps: { fetchApi: fetchApiRef },
      factory: ({ fetchApi }) => new MyApiClient({ fetchApi }),
    }),
  ],
});

// Routable extension (gets its own page/route)
export const MyPluginPage = myPlugin.provide(
  createRoutableExtension({
    name: 'MyPluginPage',
    component: () => import('./components/MyPage').then((m) => m.MyPage),
    mountPoint: rootRouteRef,
  })
);

// Component extension (embeddable widget)
export const MyPluginCard = myPlugin.provide(
  createComponentExtension({
    name: 'MyPluginCard',
    component: { lazy: () => import('./components/MyCard').then((m) => m.MyCard) },
  })
);
```

**Key patterns:**

1. **Factory functions** (`createPlugin`, `createRoutableExtension`) — typed, IDE-discoverable
2. **Route refs** for cross-plugin navigation without hardcoded paths
3. **API refs** for dependency injection — plugins declare API dependencies, app wires implementations
4. **Lazy loading** built in — all extensions use dynamic `import()`
5. **No isolation** — plugins run in the same React tree, same process
6. **Shared UI kit** (`@backstage/core-components`) ensures visual consistency

**v2 frontend system (newer):**

- Extensions become composable primitives (not just routes/components)
- Explicit dependency declaration between plugins
- Runtime discovery of extension capabilities
- `createExtensionTester` for isolated testing

**Backstage's lesson:** For trusted/first-party plugins, you don't need sandboxing. You need strong typing, clear API contracts, and a shared component library. The "isolation" comes from convention and code review, not runtime boundaries.

#### React-Pluggable

A lightweight library for feature-oriented plugin architecture:

```typescript
class CounterPlugin implements IPlugin {
  getPluginName() { return 'CounterPlugin'; }
  init(pluginStore: PluginStore) {
    pluginStore.executeFunction('Renderer.add', 'counter', <Counter />);
  }
}

// Host app
const pluginStore = createPluginStore();
pluginStore.install(new CounterPlugin());

// In component
function App() {
  const plugins = usePluginStore();
  return plugins.executeFunction('Renderer.getAll').map(([key, Component]) => (
    <Component key={key} />
  ));
}
```

Simple but no isolation, no manifest, no lifecycle management beyond init/destroy.

---

## Comparison Matrix

| Dimension             | VSCode                            | Obsidian                 | Grafana                   | Module Federation  | Backstage                  | Iframe          |
| --------------------- | --------------------------------- | ------------------------ | ------------------------- | ------------------ | -------------------------- | --------------- |
| **UI Declaration**    | JSON manifest (contributes)       | Code in onload()         | plugin.json + module.ts   | Webpack config     | createPlugin factory       | N/A             |
| **UI Injection**      | Contribution slots + webview      | Direct DOM via contentEl | React component props     | React.lazy import  | Route/component extensions | postMessage     |
| **JS Isolation**      | Separate process (ext host)       | None                     | Proxy membrane (11.5+)    | None               | None                       | Separate origin |
| **DOM Isolation**     | Webview iframe                    | None                     | Sandbox proxies (11.5+)   | None               | None                       | Iframe boundary |
| **CSS Isolation**     | Webview (full) / TreeView (theme) | None (global CSS)        | Sandbox (11.5+)           | None               | Shared theme               | Iframe (full)   |
| **State Access**      | API proxy over IPC                | Direct (this.app)        | Props + hooks             | Shared stores      | useApi() DI                | postMessage     |
| **Plugin Crash**      | Extension host may crash          | App crashes              | App crashes (pre-sandbox) | App crashes        | App crashes                | Isolated        |
| **Startup Cost**      | Manifest read (fast)              | Script load              | SystemJS load             | Remote entry fetch | Dynamic import             | iframe load     |
| **React Integration** | Webview only (separate root)      | Mount in contentEl       | Direct (same tree)        | Direct (same tree) | Direct (same tree)         | Separate root   |

---

## The Core Tension: Power vs. Safety

Every system makes a different bet on where to sit on this spectrum:

```
Full Isolation                                              Full Integration
(safe, limited)                                             (powerful, risky)
    |                                                              |
    iframe ---- VSCode webview ---- Grafana sandbox ---- Backstage ---- Obsidian
```

**VSCode** splits the difference: TreeViews for simple declarative UI (safe, limited), Webviews for rich UI (safe, separate world). The cost is that webview-based extensions feel slightly disconnected from native VS Code UI.

**Obsidian** bets on community trust and code review. The payoff is incredible plugin power — plugins like Dataview, Templater, and Excalidraw are essentially separate applications running inside Obsidian. This wouldn't be possible with sandboxing.

**Grafana** is evolving toward sandboxing after years of unsandboxed plugin execution caused stability issues in cloud deployments. Their proxy-membrane approach is a pragmatic middle ground — plugins still render as React components but can't escape their designated DOM area.

**Backstage** provides safety through strong typing and API contracts rather than runtime isolation. Plugins that violate the API contract fail at compile time, not runtime.

---

## Architectural Patterns Worth Stealing

### 1. Declarative Manifest for UI Registration (VSCode)

Separate "what UI do you contribute" from "run your code." Read manifests at startup to build the shell; activate extensions lazily. This enables fast startup and predictable layout even before plugins load.

### 2. Factory Functions with Strong Types (Backstage)

`createPlugin()`, `createRoutableExtension()`, `createComponentExtension()` — typed factories that make the plugin contract IDE-discoverable and compile-time checked. Better DX than raw manifest JSON.

### 3. Props-Based Plugin Rendering (Grafana)

Plugin components receive everything they need via props (`PanelProps`). No global state access, no magic context. The host controls what data flows to the plugin. Easy to test, easy to reason about.

### 4. Automatic Resource Cleanup (Obsidian)

Every `register*()` call tracks the registration. On unload, everything auto-cleans. Plugins don't need to remember to remove event listeners, DOM handlers, or intervals. This prevents resource leaks from poorly-written plugins.

### 5. Message-Passing for Untrusted Content (VSCode Webview)

`postMessage()` is the only safe way to communicate with truly untrusted code. Accept the latency and serialization cost. The API should feel like a typed RPC layer, not raw message passing.

### 6. Shared Singleton Dependencies (Module Federation / Grafana)

Ensure only one copy of React exists. Module Federation's `singleton: true` and Grafana's SystemJS pre-registration both solve the "two React instances" problem that breaks hooks and context.

---

## Sources & Evidence

### VSCode

- [Contribution Points Reference](https://code.visualstudio.com/api/references/contribution-points) — Official docs, full list of 34+ contribution points
- [Extension Anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy) — Manifest structure, activation events, lifecycle
- [Webview API Guide](https://code.visualstudio.com/api/extension-guides/webview) — Iframe isolation, postMessage, state persistence, CSP
- [Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host) — Three host types, process isolation model
- [VS Code Architecture Overview](https://thedeveloperspace.com/vs-code-architecture-guide/) — Extension host IPC, JSON-RPC
- [VS Code Extensions Architecture](https://dev.to/karrade7/vs-code-extensions-basic-concepts-architecture-b17) — TreeView vs WebView comparison
- [Migrating to Process Sandboxing](https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox) — Process model evolution
- [Webview Web Learnings](https://blog.mattbierner.com/vscode-webview-web-learnings/) — Iframe origin isolation details
- [Trail of Bits: VSCode Extension Escape](https://blog.trailofbits.com/2023/02/21/vscode-extension-escape-vulnerability/) — Security analysis of webview isolation

### Obsidian

- [Obsidian API TypeScript Definitions](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts) — Full API surface
- [Plugin Developer Docs: Workspace](https://docs.obsidian.md/Plugins/User+interface/Workspace) — Leaf/split/tab architecture
- [Plugin Developer Docs: Views](https://docs.obsidian.md/Plugins/User+interface/Views) — Custom view registration
- [Plugin Developer Docs: Anatomy](https://docs.obsidian.md/Plugins/Getting+started/Anatomy+of+a+plugin) — Lifecycle, manifest
- [Obsidian Plugin Docs (Community)](https://marcusolsson.github.io/obsidian-plugin-docs/user-interface/workspace) — Workspace tree structure
- [DeepWiki: Obsidian Plugin Development](https://deepwiki.com/obsidianmd/obsidian-api/3-plugin-development) — Full lifecycle and API surface
- [Plugin Security](https://help.obsidian.md/plugin-security) — Restricted Mode, security model
- [Obsidian Forum: ItemView Discussion](https://forum.obsidian.md/t/how-to-correctly-open-an-itemview/60871) — View opening patterns

### Grafana

- [Plugin System Architecture (DeepWiki)](https://deepwiki.com/grafana/grafana/11-plugin-system) — SystemJS loading, shared packages
- [Plugin Frontend Sandbox](https://grafana.com/docs/grafana/latest/administration/plugin-management/plugin-frontend-sandbox/) — Sandbox feature docs
- [Grafana 11.5 Release](https://grafana.com/blog/2025/01/29/grafana-11-5-release/) — Sandbox announcement
- [Plugin Anatomy](https://grafana.com/developers/plugin-tools/key-concepts/anatomy-of-a-plugin) — plugin.json, module.ts structure
- [Build a Panel Plugin](https://grafana.com/developers/plugin-tools/tutorials/build-a-panel-plugin) — PanelProps interface
- [Frontend Sandbox Epic (#68883)](https://github.com/grafana/grafana/issues/68883) — Implementation tracking
- [Salesforce near-membrane](https://github.com/salesforce/near-membrane) — Proxy membrane library for JS sandboxing

### React SPA Approaches

- [Module Federation Docs](https://webpack.js.org/concepts/module-federation/) — Official Webpack docs
- [Module Federation Examples](https://github.com/module-federation/module-federation-examples) — Reference implementations
- [Backstage Frontend Plugins (DeepWiki)](https://deepwiki.com/backstage/backstage/6.1-frontend-plugins) — Full plugin architecture
- [Anatomy of a Backstage Plugin](https://medium.com/dazn-tech/the-anatomy-of-a-backstage-plugin-510015e4fc9f) — Plugin internals
- [React-Pluggable](https://github.com/GeekyAnts/react-pluggable) — Lightweight plugin system
- [Browser Sandbox Architecture](https://dev.to/alexgriss/the-architecture-of-browser-sandboxes-a-deep-dive-into-javascript-code-isolation-1dnj) — JS isolation techniques comparison
- [Shadow DOM vs iframes](https://hackernoon.com/shadow-dom-vs-iframes-which-one-actually-works) — Sandboxing tradeoffs

---

## Research Gaps & Limitations

- **Grafana sandbox implementation details** are not publicly documented. The near-membrane inference is based on ecosystem analysis, not confirmed source code review.
- **Performance benchmarks** for different isolation approaches (iframe vs proxy membrane vs none) were not found in quantified form.
- **Figma's plugin sandbox** (uses a Web Worker + proxy approach) was not deeply researched but is another notable real-world example.
- **Eclipse Theia** (VS Code-compatible IDE framework) has a different extension hosting model worth investigating for comparison.
- **Vite-based Module Federation** (`@originjs/vite-plugin-federation`) was not covered — relevant if the host app uses Vite rather than Webpack.

---

## Search Methodology

- Searches performed: 14
- Most productive search terms: "VSCode contribution points", "VSCode webview API architecture", "Obsidian ItemView workspace leaf", "Grafana plugin sandbox", "Backstage frontend plugins"
- Primary sources: Official documentation sites (code.visualstudio.com, docs.obsidian.md, grafana.com), DeepWiki code analysis, GitHub repositories
- Research mode: Deep Research
