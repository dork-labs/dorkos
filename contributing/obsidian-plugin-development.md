# Obsidian Plugin Development Guide

> Developer reference for building the DorkOS Obsidian plugin — embedding our React chat client as an Obsidian copilot sidebar.

---

## 1. Obsidian Plugin Fundamentals

### Plugin File Structure

Every Obsidian plugin consists of three files installed to `.obsidian/plugins/<plugin-id>/`:

```
my-plugin/
├── manifest.json   # Plugin metadata (required)
├── main.js         # Compiled JavaScript entry (required)
└── styles.css      # Plugin styles (optional)
```

### manifest.json

```json
{
  "id": "dorkos-copilot",
  "name": "DorkOS Copilot",
  "version": "0.1.0",
  "minAppVersion": "1.5.0",
  "description": "AI copilot sidebar powered by DorkOS",
  "author": "DorkOS",
  "authorUrl": "https://github.com/your-repo",
  "isDesktopOnly": true
}
```

Key fields:

- `id`: Unique identifier, must match the plugin folder name
- `minAppVersion`: Minimum Obsidian version required
- `isDesktopOnly`: Set `true` since we depend on Node.js APIs (child_process, fs) via Electron

### Plugin Lifecycle

```typescript
import { Plugin } from 'obsidian';

export default class CopilotPlugin extends Plugin {
  async onload() {
    // Called when plugin is enabled
    // Register views, commands, event listeners, settings
  }

  async onunload() {
    // Called when plugin is disabled
    // Clean up resources, detach views
  }
}
```

---

## 2. Creating a Sidebar View (ItemView)

The plugin renders our React client inside an `ItemView` in Obsidian's right sidebar.

### ItemView Pattern

```typescript
import { ItemView, WorkspaceLeaf } from "obsidian";
import { createRoot, Root } from "react-dom/client";

export const VIEW_TYPE_COPILOT = "dorkos-copilot-view";

export class CopilotView extends ItemView {
  root: Root | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_COPILOT;
  }

  getDisplayText(): string {
    return "DorkOS Copilot";
  }

  getIcon(): string {
    return "bot"; // Lucide icon name
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("copilot-view-content");

    // Mount React app
    this.root = createRoot(container as HTMLElement);
    this.root.render(
      <CopilotApp app={this.app} />
    );
  }

  async onClose(): Promise<void> {
    // CRITICAL: unmount React to prevent memory leaks
    this.root?.unmount();
    this.root = null;
  }
}
```

### Registering the View

```typescript
// In plugin onload()
this.registerView(VIEW_TYPE_COPILOT, (leaf) => new CopilotView(leaf));

// Add ribbon icon to open
this.addRibbonIcon('bot', 'Open Copilot', () => {
  this.activateView();
});

// Add command palette entry
this.addCommand({
  id: 'open-copilot',
  name: 'Open Copilot',
  callback: () => this.activateView(),
});
```

### Opening the View

```typescript
async activateView() {
  const { workspace } = this.app;

  // Close existing instances
  workspace.detachLeavesOfType(VIEW_TYPE_COPILOT);

  // Create in right sidebar
  const leaf = workspace.getRightLeaf(false);
  if (leaf) {
    await leaf.setViewState({
      type: VIEW_TYPE_COPILOT,
      active: true,
    });
    workspace.revealLeaf(leaf);
  }
}
```

---

## 3. Mounting React in Obsidian

### Direct Mount (Recommended Approach)

We mount our React tree directly inside the ItemView container. This gives React components full access to the Obsidian API without iframe serialization overhead.

```typescript
// CopilotView.onOpen()
this.root = createRoot(container as HTMLElement);
this.root.render(
  <ObsidianProvider app={this.app}>
    <QueryClientProvider client={queryClient}>
      <CopilotApp />
    </QueryClientProvider>
  </ObsidianProvider>
);
```

### ObsidianContext Provider

Pass the Obsidian `App` instance through React Context so any component can access vault, workspace, etc.

```typescript
import { createContext, useContext, ReactNode } from "react";
import { App } from "obsidian";

interface ObsidianContextValue {
  app: App;
}

const ObsidianContext = createContext<ObsidianContextValue | null>(null);

export function ObsidianProvider({
  app,
  children,
}: {
  app: App;
  children: ReactNode;
}) {
  return (
    <ObsidianContext.Provider value={{ app }}>
      {children}
    </ObsidianContext.Provider>
  );
}

export function useObsidian(): ObsidianContextValue {
  const ctx = useContext(ObsidianContext);
  if (!ctx) {
    throw new Error("useObsidian must be used within ObsidianProvider");
  }
  return ctx;
}
```

### Why Not Iframe?

| Factor              | Direct Mount                  | Iframe                          |
| ------------------- | ----------------------------- | ------------------------------- |
| Obsidian API access | Direct (React Context)        | Indirect (postMessage)          |
| CSS isolation       | Needs scoping                 | Full isolation                  |
| Drag-and-drop       | Standard React handlers       | Cross-boundary complexity       |
| Performance         | No serialization              | postMessage overhead            |
| Build complexity    | One build (Vite library mode) | Two builds + message protocol   |
| Code sharing        | Import directly               | Duplicate or postMessage bridge |

Direct mount wins for our use case because deep Obsidian integration (active file tracking, file opening, drag-drop) requires frequent API calls that would be painful through postMessage.

---

## 4. Tracking the Active File

### Listening for Active File Changes

Obsidian fires `active-leaf-change` when the user switches tabs/panes.

```typescript
// In plugin or view setup
this.registerEvent(
  this.app.workspace.on('active-leaf-change', (leaf) => {
    const file = this.app.workspace.getActiveFile();
    // file is TFile | null
    if (file) {
      console.log('Active file:', file.path, file.basename);
    }
  })
);
```

### React Hook for Active File

```typescript
import { useState, useEffect } from 'react';
import { TFile } from 'obsidian';
import { useObsidian } from '../contexts/ObsidianContext';

export function useActiveFile(): TFile | null {
  const { app } = useObsidian();
  const [activeFile, setActiveFile] = useState<TFile | null>(app.workspace.getActiveFile());

  useEffect(() => {
    const handler = () => {
      setActiveFile(app.workspace.getActiveFile());
    };

    // Obsidian event registration
    const ref = app.workspace.on('active-leaf-change', handler);

    return () => {
      app.workspace.offref(ref);
    };
  }, [app]);

  return activeFile;
}
```

### Reading File Contents

```typescript
import { TFile } from 'obsidian';

// Read full content
const content = await app.vault.read(file);

// Read cached content (faster, may be stale)
const cached = await app.vault.cachedRead(file);

// Get metadata (frontmatter, tags, etc.)
const metadata = app.metadataCache.getFileCache(file);
```

---

## 5. Opening Files in Obsidian

When the chat client references a file (e.g., in a tool call or response), we need to open it in Obsidian.

### Basic File Opening

```typescript
// Open by path
const file = app.vault.getAbstractFileByPath('path/to/note.md');
if (file instanceof TFile) {
  await app.workspace.getLeaf(false).openFile(file);
}

// Open by link text (handles aliases, headings)
await app.workspace.openLinkText('note-name', '', false);
```

### Open in New Pane vs Existing

```typescript
// false = reuse existing leaf, true = new split
const leaf = app.workspace.getLeaf(false);
await leaf.openFile(file);

// Open in a specific position
const leaf = app.workspace.getLeaf('split', 'vertical');
await leaf.openFile(file);
```

### React Helper

```typescript
export function useFileOpener() {
  const { app } = useObsidian();

  const openFile = async (path: string) => {
    const file = app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(file);
    }
  };

  return { openFile };
}
```

---

## 6. Drag-and-Drop from Obsidian

Obsidian's file explorer emits drag events with file paths in `text/plain` format in the DataTransfer object.

### Drop Zone Implementation

```typescript
interface ContextFile {
  path: string;
  basename: string;
  id: string;
}

function DropZone({ onFilesAdded }: { onFilesAdded: (files: ContextFile[]) => void }) {
  const { app } = useObsidian();
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    // Obsidian puts the file path in text/plain
    const path = e.dataTransfer.getData("text/plain");

    if (path) {
      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        onFilesAdded([{
          path: file.path,
          basename: file.basename,
          id: crypto.randomUUID(),
        }]);
      }
    }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`drop-zone ${isDragOver ? "drag-over" : ""}`}
    >
      {/* children */}
    </div>
  );
}
```

### Key Details

- Obsidian's file explorer drag puts the vault-relative path in `e.dataTransfer.getData("text/plain")`
- Always call `e.preventDefault()` in both `dragOver` and `drop` handlers
- Use `getAbstractFileByPath()` to resolve the path to a `TFile` object
- Check `instanceof TFile` to exclude folders (`TFolder`)

---

## 7. Context Chips UI (Cursor-Style)

The context bar shows the active file and any drag-dropped files as dismissible chips above the chat input.

### Context State

```typescript
interface ContextState {
  activeFile: TFile | null; // Auto-tracked, not dismissible
  contextFiles: ContextFile[]; // Manually added via drag-drop
  addContextFile: (file: ContextFile) => void;
  removeContextFile: (id: string) => void;
  clearContextFiles: () => void;
  getContextForMessage: () => string; // Serialize for API
}
```

### ContextChips Component

```typescript
function ContextChips({
  activeFile,
  contextFiles,
  onRemove,
}: {
  activeFile: TFile | null;
  contextFiles: ContextFile[];
  onRemove: (id: string) => void;
}) {
  const { openFile } = useFileOpener();

  return (
    <div className="context-chips">
      {/* Active file — auto-tracked, no remove button */}
      {activeFile && (
        <div className="chip chip-active" title={activeFile.path}>
          <span className="chip-icon">&#128196;</span>
          <button
            className="chip-label"
            onClick={() => openFile(activeFile.path)}
          >
            {activeFile.basename}
          </button>
          <span className="chip-badge">active</span>
        </div>
      )}

      {/* Dropped files — removable */}
      {contextFiles.map((cf) => (
        <div key={cf.id} className="chip" title={cf.path}>
          <span className="chip-icon">&#128196;</span>
          <button
            className="chip-label"
            onClick={() => openFile(cf.path)}
          >
            {cf.basename}
          </button>
          <button
            className="chip-remove"
            onClick={() => onRemove(cf.id)}
          >
            x
          </button>
        </div>
      ))}
    </div>
  );
}
```

### Cursor-Style Behavior

- The active file chip updates automatically as the user navigates
- Drag-dropped files persist until explicitly removed
- Clicking a chip name opens the file in Obsidian
- When sending a message, context files are included (path + content summary)
- After sending, context files could optionally auto-clear or persist (user preference)

---

## 8. Environment Detection

The client needs to know whether it's running standalone (browser) or embedded in Obsidian.

### Detection Strategy

```typescript
// Option A: Check for Obsidian's global app object
export function isObsidianEnvironment(): boolean {
  return typeof (window as any).app?.vault !== 'undefined';
}

// Option B: Check for injected flag (set by plugin before mounting)
export function isObsidianEnvironment(): boolean {
  return !!(window as any).__LIFEOS_OBSIDIAN__;
}

// Option C: Check for Electron (Obsidian runs in Electron)
export function isElectronEnvironment(): boolean {
  return typeof (window as any).require === 'function' && typeof process !== 'undefined';
}
```

**Recommended: Option B** — The plugin sets a flag before mounting React. This is explicit, testable, and doesn't depend on Obsidian internals.

### Conditional Behavior Map

| Feature             | Standalone (Browser)                  | Obsidian                                |
| ------------------- | ------------------------------------- | --------------------------------------- |
| Transport           | `HttpTransport` (HTTP/SSE to Express) | `DirectTransport` (in-process services) |
| Session ID storage  | URL query param (nuqs)                | Zustand store                           |
| Layout              | Full viewport, responsive             | Fixed sidebar width (~300px)            |
| Active file context | N/A                                   | Tracked via workspace events            |
| File drag-drop      | N/A                                   | From Obsidian file explorer             |
| Open file action    | N/A                                   | `workspace.openFile()`                  |
| Theme               | CSS custom properties                 | Obsidian CSS variables (theme bridge)   |
| Text selection      | Default browser behavior              | Explicit `user-select: text` override   |

### Platform Adapter Pattern

```typescript
interface PlatformAdapter {
  getApiBaseUrl(): string;
  getSessionId(): string | null;
  setSessionId(id: string): void;
  isEmbedded(): boolean;
}

// Standalone adapter
const webAdapter: PlatformAdapter = {
  getApiBaseUrl: () => '/api',
  getSessionId: () => new URLSearchParams(location.search).get('session'),
  setSessionId: (id) => {
    /* nuqs or pushState */
  },
  isEmbedded: () => false,
};

// Obsidian adapter
const obsidianAdapter: PlatformAdapter = {
  getApiBaseUrl: () => 'http://localhost:4242/api',
  getSessionId: () => store.getState().sessionId,
  setSessionId: (id) => store.setState({ sessionId: id }),
  isEmbedded: () => true,
};
```

---

## 9. Build Configuration

### Vite Config for Plugin Build

The plugin uses its own Vite build (`apps/obsidian-plugin/vite.config.ts`) that outputs a single CJS `main.js` with four custom build plugins (in `apps/obsidian-plugin/build-plugins/`) for Electron compatibility:

```typescript
plugins: [
  react(),
  tailwindcss(),
  copyManifest(),
  safeRequires(),
  fixDirnamePolyfill(),
  patchElectronCompat(),
];
```

Key config:

```typescript
build: {
  lib: {
    entry: path.resolve(__dirname, "src/main.ts"),
    formats: ["cjs"],
    fileName: () => "main.js",
  },
  rollupOptions: {
    external: [
      "obsidian", "electron",
      // CodeMirror + Lezer (provided by Obsidian)
      "@codemirror/*", "@lezer/*",
      // Node.js built-ins (available in Electron)
      ...builtinModules.flatMap((m) => [m, `node:${m}`]),
    ],
    output: {
      inlineDynamicImports: true,
      exports: "default",
      assetFileNames: "styles.[ext]",
    },
  },
  outDir: "dist",
  target: "node18",
}
```

### Build Plugins

| Plugin                  | Phase       | Purpose                                                                   |
| ----------------------- | ----------- | ------------------------------------------------------------------------- |
| `copyManifest()`        | closeBundle | Copies `manifest.json` to `dist/`                                         |
| `safeRequires()`        | renderChunk | Wraps optional `require()` calls in try/catch                             |
| `fixDirnamePolyfill()`  | writeBundle | Replaces Vite's `import.meta.url` polyfill with `__dirname`/`__filename`  |
| `patchElectronCompat()` | writeBundle | Monkey-patches `spawn()` and `setMaxListeners()` for Electron AbortSignal |

See `contributing/architecture.md` > "Electron Compatibility Layer" for details on why each plugin exists.

### Package Scripts

```bash
# From the monorepo root (via Turborepo):
turbo run build --filter=obsidian-plugin

# Or from apps/obsidian-plugin/:
npm run build
```

### Development Workflow

1. Run the build from the monorepo root or from `apps/obsidian-plugin/`
2. The build outputs to `apps/obsidian-plugin/dist/` which is symlinked (or hardlinked) into the vault's `.obsidian/plugins/dorkos-copilot/`
3. Restart Obsidian (or use the Hot Reload plugin)
4. Open dev console (`Cmd+Option+I`) to check for errors

---

## 10. Styling Strategy

### The Problem

Obsidian has its own CSS that can conflict with Tailwind classes. The standalone client uses Tailwind CSS 4 extensively.

### Recommended Approach: CSS Variable Bridge

Map Tailwind's design tokens to Obsidian's CSS variables so the same components look native in both environments.

```css
/* When running in Obsidian, override CSS custom properties */
.copilot-view-content {
  --background: var(--background-primary);
  --foreground: var(--text-normal);
  --card: var(--background-secondary);
  --card-foreground: var(--text-normal);
  --primary: var(--interactive-accent);
  --primary-foreground: var(--text-on-accent);
  --muted: var(--text-muted);
  --border: var(--background-modifier-border);
  --input: var(--background-modifier-form-field);
  --ring: var(--interactive-accent);
}
```

This approach lets the existing components work because they already reference CSS custom properties (defined in `index.css`). We just re-map them to Obsidian's variables.

### Key Obsidian CSS Variables

| Variable                           | Purpose                       |
| ---------------------------------- | ----------------------------- |
| `--background-primary`             | Main background               |
| `--background-secondary`           | Sidebar background            |
| `--text-normal`                    | Primary text                  |
| `--text-muted`                     | Secondary text                |
| `--interactive-accent`             | Accent color (links, buttons) |
| `--interactive-accent-hover`       | Accent hover state            |
| `--text-on-accent`                 | Text on accent backgrounds    |
| `--background-modifier-border`     | Borders                       |
| `--background-modifier-form-field` | Input backgrounds             |

---

## 11. Data Flow: Context to Chat Messages

When the user sends a message, context files need to be included. Here's the recommended flow:

### Option A: Client-Side Prepend (Simple, No API Change)

Prepend context to the user's message before sending:

```typescript
function buildMessageWithContext(
  userMessage: string,
  activeFile: TFile | null,
  contextFiles: ContextFile[],
  vault: Vault
): string {
  const parts: string[] = [];

  if (activeFile) {
    const content = await vault.cachedRead(activeFile);
    parts.push(`<context file="${activeFile.path}">\n${content}\n</context>`);
  }

  for (const cf of contextFiles) {
    const file = vault.getAbstractFileByPath(cf.path);
    if (file instanceof TFile) {
      const content = await vault.cachedRead(file);
      parts.push(`<context file="${cf.path}">\n${content}\n</context>`);
    }
  }

  if (parts.length > 0) {
    return parts.join('\n\n') + '\n\n' + userMessage;
  }
  return userMessage;
}
```

### Option B: Structured Context Field (Requires API Change)

Add a `context` field to the message API:

```typescript
POST /api/sessions/:id/messages
{
  "content": "What does this function do?",
  "context": [
    { "path": "src/utils.ts", "content": "..." },
    { "path": "src/types.ts", "content": "..." }
  ]
}
```

**Recommendation:** Start with Option A for speed. Migrate to Option B when the API evolves.

---

## 12. Obsidian API Quick Reference

### Vault Operations

```typescript
// List all markdown files
const files = app.vault.getMarkdownFiles();

// Get file by path
const file = app.vault.getAbstractFileByPath('path/to/file.md');

// Read content
const content = await app.vault.read(file as TFile);

// Get metadata cache
const cache = app.metadataCache.getFileCache(file as TFile);
// cache.frontmatter, cache.tags, cache.headings, cache.links
```

### Workspace Operations

```typescript
// Get active file
const file = app.workspace.getActiveFile();

// Listen for changes
const ref = app.workspace.on('active-leaf-change', callback);
app.workspace.offref(ref); // unsubscribe

// Open file
await app.workspace.getLeaf(false).openFile(file);

// Get right sidebar leaf
const leaf = app.workspace.getRightLeaf(false);
```

### Event Registration (Memory-Safe)

Always use `this.registerEvent()` in plugin/view classes — it auto-cleans on unload:

```typescript
// In Plugin or ItemView
this.registerEvent(
  this.app.workspace.on("active-leaf-change", () => { ... })
);

// Also for DOM events
this.registerDomEvent(document, "keydown", (e) => { ... });
```

---

## 13. Directory Structure

```
dorkos/                               # Turborepo monorepo root
├── turbo.json                        # Task pipeline configuration
├── package.json                      # Root package.json (workspaces)
├── packages/
│   └── shared/src/
│       ├── transport.ts              # Transport interface (the "port")
│       └── types.ts                  # Shared type definitions (@dorkos/shared)
├── apps/
│   ├── client/src/                   # Shared React components (@dorkos/client)
│   │   ├── components/
│   │   ├── hooks/
│   │   │   ├── use-chat-session.ts   # Chat streaming (uses useTransport)
│   │   │   ├── use-sessions.ts       # Session CRUD (uses useTransport)
│   │   │   └── use-commands.ts       # Command palette (uses useTransport)
│   │   ├── contexts/
│   │   │   └── TransportContext.tsx   # React Context for Transport DI
│   │   ├── lib/
│   │   │   ├── http-transport.ts     # HTTP/SSE transport (standalone web)
│   │   │   ├── direct-transport.ts   # In-process transport (Obsidian plugin)
│   │   │   └── platform.ts           # Platform adapter (embedded detection)
│   │   ├── stores/
│   │   ├── App.tsx
│   │   ├── main.tsx                  # Standalone entry (HttpTransport)
│   │   └── index.css
│   ├── obsidian-plugin/              # Obsidian plugin code
│   │   ├── vite.config.ts            # Plugin build (4 Electron compat plugins)
│   │   ├── build-plugins/            # Vite build plugins for Electron compat
│   │   ├── manifest.json             # Obsidian plugin manifest
│   │   └── src/
│   │       ├── main.ts               # Plugin entry (onload/onunload)
│   │       ├── views/
│   │       │   └── CopilotView.tsx   # ItemView — creates services, mounts React
│   │       ├── contexts/
│   │       │   └── ObsidianContext.tsx # Obsidian API provider
│   │       ├── components/
│   │       │   ├── ContextBar.tsx    # Active file + context chips
│   │       │   └── ObsidianApp.tsx   # Plugin wrapper (auto-session, compact layout)
│   │       ├── lib/
│   │       │   └── obsidian-adapter.ts # Platform adapter for Obsidian
│   │       └── styles/
│   │           └── plugin.css        # Obsidian theme bridge + text selection fix
│   └── server/src/
│       ├── services/
│       │   ├── agent-manager.ts      # SDK wrapper (CLI resolution, cwd)
│       │   ├── transcript-reader.ts  # JSONL session reader
│       │   ├── command-registry.ts   # Slash command discovery
│       │   └── stream-adapter.ts     # SSE helpers
│       ├── routes/
│       └── index.ts                  # Express server entry
```

---

## 14. Testing and Debugging

### Setup (Symlink Approach)

Our plugin is built to `apps/obsidian-plugin/dist/`. The Obsidian vault symlinks to it:

```bash
# Already done for this vault:
ln -s /path/to/dorkos/apps/obsidian-plugin/dist workspace/.obsidian/plugins/dorkos-copilot
```

The Vite build outputs all three required files:

- `main.js` — bundled plugin code
- `styles.css` — extracted CSS (renamed via `assetFileNames` in Vite config)
- `manifest.json` — copied by `copyManifest()` Vite plugin

### Opening the Developer Console

**This is the single most important debugging tool.** Obsidian's UI only shows "Failed to load plugin" — the actual error with stack trace is in the dev console.

**macOS:** `Cmd+Option+I` (NOT Cmd+Shift+I)
**Windows/Linux:** `Ctrl+Shift+I`

> If the shortcut doesn't work, go to **View > Toggle Developer Tools** in the Obsidian menu bar, or press `Cmd+P` and search for "Toggle Developer Tools".

In the Console tab, look for:

- Red error messages with stack traces
- `[DorkOS Copilot]` prefixed log messages (our debug logging)
- `Uncaught` or `TypeError` messages during plugin load

### Debugging "Failed to Load Plugin" Errors

When Obsidian shows "Failed to load plugin", the error occurs in one of two phases:

**Phase 1: Module Evaluation** — When Obsidian `require()`s the `main.js` file. All top-level code runs. If any top-level `require()`, variable initialization, or immediately-invoked code throws, the plugin fails here. You'll see the error in the console **before** any `[DorkOS Copilot]` log messages.

**Phase 2: Plugin Initialization** — When Obsidian calls `onload()` on the plugin instance. If `onload()` throws, you'll see `[DorkOS Copilot] onload() called` but then an error.

**Debugging checklist:**

1. Open dev console (`Cmd+Option+I`)
2. Disable and re-enable the plugin in Settings > Community Plugins
3. Watch the console for the error
4. Look for the `[DorkOS Copilot]` log messages to determine which phase failed

### Debug Logging

The plugin includes debug logging at key points:

```
[DorkOS Copilot] main.js module loaded    ← Phase 1 passed
[DorkOS Copilot] onload() called          ← Phase 2 started
[DorkOS Copilot] onload() complete        ← Phase 2 passed
```

If you don't see "main.js module loaded", the error is in module evaluation (top-level code or a dependency).

### Common Issues

| Issue                                 | Cause                                                   | Solution                                                                 |
| ------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| "Failed to load plugin"               | See dev console for actual error                        | Open `Cmd+Option+I` and check Console tab                                |
| "Cannot find module 'obsidian'"       | Not externalized in Vite config                         | Add to `external` in `apps/obsidian-plugin/vite.config.ts` rollupOptions |
| "Cannot find module 'X'"              | Node built-in not externalized                          | Ensure `builtinModules` are in `external` array                          |
| "The URL must be of scheme file"      | Vite `import.meta.url` polyfill uses `document.baseURI` | `fixDirnamePolyfill()` plugin replaces with `__dirname`                  |
| "must be EventEmitter or EventTarget" | SDK passes browser AbortSignal to Node.js APIs          | `patchElectronCompat()` plugin patches spawn + setMaxListeners           |
| "Claude Code executable not found"    | SDK resolves `cli.js` inside `Obsidian.app`             | `AgentManager.resolveClaudeCliPath()` finds CLI via PATH                 |
| ENOENT for `.claude/commands/`        | Service receives vault path instead of repo root        | Pass `repoRoot = path.resolve(vaultPath, '..')` to services              |
| Optional dep crashes on require       | `@emotion/is-prop-valid`, `ajv-*` etc                   | Add to `safeRequires()` plugin in Vite config                            |
| Text not selectable                   | Obsidian sets `user-select: none` on views              | Override with `user-select: text` in `.copilot-view-content`             |
| Styles not applying                   | Wrong CSS filename or missing file                      | Verify `styles.css` exists in plugin dir                                 |
| React not re-rendering                | Obsidian events not wired to state                      | Use `registerEvent()` + React state updates                              |
| Drag-drop not firing                  | Missing preventDefault                                  | Call `preventDefault()` on both `dragOver` and `drop`                    |
| Memory leaks                          | React root not unmounted                                | Always `root.unmount()` in `onClose()`                                   |
| Hot reload not working                | Missing .hotreload file                                 | Create `.hotreload` file in plugin dir                                   |

### Build Quirks

**Node.js Built-ins:** The plugin bundles the Claude Agent SDK which uses Node.js APIs (fs, path, child_process, etc.). These are externalized via `builtinModules` in the Vite config and available in Obsidian's Electron runtime. The `isDesktopOnly: true` manifest flag is required.

**Optional Dependencies:** Some bundled libraries reference packages that aren't installed (e.g., `@emotion/is-prop-valid` from motion, `ajv-formats` from the Agent SDK). The `safeRequires()` Vite plugin wraps these in try/catch so they return `{}` instead of crashing.

**Single Bundle:** The `inlineDynamicImports: true` setting ensures everything is in one `main.js` file. Obsidian doesn't support multi-file plugins. Current bundle size is ~10.4MB (2.7MB gzipped).

**CJS Export Format:** Obsidian expects `module.exports = YourPlugin` where `YourPlugin extends Plugin`. The `exports: 'default'` setting in Vite ensures `export default class` maps to `module.exports`.

**Electron AbortSignal:** The SDK uses `AbortSignal` with Node.js APIs that reject Chromium's Web API version. The `patchElectronCompat()` plugin patches `child_process.spawn()` and `events.setMaxListeners()` at the top of `main.js`.

**Vite import.meta.url Polyfill:** Vite converts `import.meta.url` to a browser polyfill using `document.baseURI`, which resolves to `app://obsidian.md/...` in Electron. The `fixDirnamePolyfill()` plugin replaces these with native `__dirname`/`__filename`.

**Claude Code CLI Path:** The SDK resolves `cli.js` relative to `import.meta.url`, which breaks in the bundled plugin. `AgentManager.resolveClaudeCliPath()` finds the CLI via `require.resolve` or `which claude` and passes it to the SDK.

### Development Workflow

1. Run the build from the monorepo root (`turbo run build --filter=obsidian-plugin`) or from `apps/obsidian-plugin/` (`npm run build`)
2. Restart Obsidian or use the Hot Reload plugin
3. Open dev console (`Cmd+Option+I`) before enabling the plugin
4. Check console for errors

---

## 15. Architecture (Hexagonal / Transport Layer)

The plugin uses a **hexagonal architecture** with a `Transport` interface that decouples the React client from its backend.

### Transport Adapters

| Adapter           | Used By               | How It Works                       |
| ----------------- | --------------------- | ---------------------------------- |
| `HttpTransport`   | Standalone web client | HTTP fetch + SSE to Express server |
| `DirectTransport` | Obsidian plugin       | In-process service calls, no HTTP  |

### Plugin Data Flow

```
User input → ObsidianApp → useChatSession.handleSubmit()
  → transport.sendMessage(sessionId, content, onEvent, signal)
    → DirectTransport → AgentManager.sendMessage() → Claude SDK query()
      → AsyncGenerator<StreamEvent>
        → onEvent(event) → React state updates
```

### Key Files

| File                                                  | Purpose                                            |
| ----------------------------------------------------- | -------------------------------------------------- |
| `apps/obsidian-plugin/src/main.ts`                    | Plugin entry (onload/onunload)                     |
| `apps/obsidian-plugin/src/views/CopilotView.tsx`      | ItemView — creates services, mounts React          |
| `apps/obsidian-plugin/src/components/ObsidianApp.tsx` | Plugin-specific App (auto-session, compact layout) |
| `packages/shared/src/transport.ts`                    | Transport interface definition                     |
| `apps/client/src/lib/direct-transport.ts`             | In-process transport wrapping services             |
| `apps/client/src/contexts/TransportContext.tsx`       | React Context for DI                               |
| `apps/obsidian-plugin/vite.config.ts`                 | Plugin build config                                |

### Path Resolution

The Obsidian vault directory is `workspace/`, but services need the **repo root** (parent directory) where `.claude/commands/` and SDK transcripts live:

```typescript
const vaultPath = (this.app.vault.adapter as any).basePath as string;
const repoRoot = path.resolve(vaultPath, '..'); // workspace/ -> repo root
```

### Service Initialization

Services are created in `CopilotView.onOpen()` with the repo root path:

```typescript
const agentManager = new AgentManager(repoRoot); // cwd for SDK, resolves Claude CLI
const transcriptReader = new TranscriptReader(); // reads ~/.claude/projects/{slug}/
const commandRegistry = new CommandRegistryService(repoRoot); // scans repoRoot/.claude/commands/
const transport = new DirectTransport({
  agentManager,
  transcriptReader,
  commandRegistry,
  vaultRoot: repoRoot,
});
```

These are injected via `<TransportProvider transport={transport}>`.

### Claude Code CLI Resolution

The SDK spawns Claude Code as a child process. In the bundled plugin, the SDK's default path resolution breaks (resolves inside `Obsidian.app`). `AgentManager` handles this via `resolveClaudeCliPath()`:

1. Try `require.resolve('@anthropic-ai/claude-agent-sdk/cli.js')` (works in dev)
2. Fall back to `which claude` on PATH (finds globally installed CLI)
3. Pass to SDK via `pathToClaudeCodeExecutable` option

**Prerequisite:** Users must have Claude Code CLI installed globally (`npm install -g @anthropic-ai/claude-code`).

---

## 16. Reference Links

- [Obsidian Developer Docs](https://docs.obsidian.md/Home)
- [Obsidian API (TypeScript Definitions)](https://github.com/obsidianmd/obsidian-api)
- [Obsidian Sample Plugin](https://github.com/obsidianmd/obsidian-sample-plugin)
- [React in Obsidian Plugins](https://docs.obsidian.md/Plugins/Getting+started/Use+React+in+your+plugin)
- [Obsidian Vite Template](https://github.com/unxok/obsidian-vite)
- [Obsidian React Starter](https://github.com/obsidian-community/obsidian-react-starter)
- [Marcus Olsson's Plugin Docs](https://marcusolsson.github.io/obsidian-plugin-docs/)
- [Hot Reload Plugin](https://github.com/pjeby/hot-reload)
