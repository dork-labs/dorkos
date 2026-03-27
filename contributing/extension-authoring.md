# Extension Authoring

Extensions add UI components, commands, and behavior to DorkOS. This guide covers everything you need to create, install, and debug a custom extension.

## Quick Start

1. Copy `examples/extensions/hello-world/` to `~/.dork/extensions/hello-world/`
2. Open DorkOS Settings > Extensions
3. Enable "Hello World" and reload the page
4. The dashboard shows a new section; the command palette has a "Hello World: Show Greeting" command

## Directory Structure

An extension is a directory with two files:

```
my-extension/
├── extension.json   # Required — manifest
└── index.ts         # Required — entry point (or index.js for pre-compiled)
```

**Global extensions** live in `~/.dork/extensions/{id}/`. **Local extensions** (project-scoped) live in `{projectDir}/.dork/extensions/{id}/`. Local overrides global when IDs match.

## Manifest (`extension.json`)

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "description": "What this extension does",
  "author": "Your Name",
  "minHostVersion": "0.1.0",
  "contributions": {
    "dashboard.sections": true,
    "command-palette.items": true
  },
  "permissions": []
}
```

| Field            | Required | Description                                                           |
| ---------------- | -------- | --------------------------------------------------------------------- |
| `id`             | Yes      | Unique kebab-case identifier. Must match the directory name.          |
| `name`           | Yes      | Display name shown in Settings.                                       |
| `version`        | Yes      | Semver string (e.g. `1.0.0`).                                         |
| `description`    | No       | Short description for the settings UI.                                |
| `author`         | No       | Author name or identifier.                                            |
| `minHostVersion` | No       | Minimum DorkOS version. Extension won't load on older hosts.          |
| `contributions`  | No       | Declares which UI slots the extension contributes to (informational). |
| `permissions`    | No       | Reserved for future use.                                              |

## Entry Point (`activate`)

The entry point must export an `activate` function:

```typescript
import type { ExtensionAPI } from '@dorkos/extension-api';

export function activate(api: ExtensionAPI): void | (() => void) {
  // Register UI components, commands, subscriptions...

  // Optionally return a cleanup function
  return () => {
    // Called when the extension is disabled or the page unloads
  };
}
```

Cleanup is automatic: any registrations made through `api.registerComponent`, `api.registerCommand`, etc. are unregistered when the extension deactivates, whether or not you return a cleanup function.

## API Reference

### UI Registration

```typescript
// Add a React component to a UI slot
api.registerComponent(slot, id, Component, { priority?: number }): () => void

// Add a command palette item
api.registerCommand(id, label, callback, { icon?, shortcut? }): () => void

// Register a dialog
api.registerDialog(id, Component): { open: () => void; close: () => void }

// Add a tab to the settings dialog
api.registerSettingsTab(id, label, Component): () => void
```

### UI Control

```typescript
// Execute a UI command (open panel, show toast, etc.)
api.executeCommand(command: UiCommand): void

// Open the canvas with content
api.openCanvas(content: UiCanvasContent): void

// Navigate to a client-side route
api.navigate(path: string): void
```

### State

```typescript
// Read-only snapshot: { currentCwd, activeSessionId, agentId }
api.getState(): ExtensionReadableState

// Subscribe to state changes (returns unsubscribe function)
api.subscribe(selector, callback): () => void
```

### Storage

```typescript
// Load persistent data (returns null if nothing saved)
const data = await api.loadData<MyData>();

// Save persistent data (scoped to this extension)
await api.saveData({ key: 'value' });
```

Storage is JSON-serialized and persisted at `~/.dork/extensions/{id}/data.json`.

### Notifications

```typescript
api.notify('Something happened', { type: 'info' | 'success' | 'error' });
```

### Introspection

```typescript
// Check if a slot is rendered in the current context
api.isSlotAvailable('dashboard.sections'): boolean

// The extension's own ID
api.id: string
```

## UI Slots

| Slot ID                 | Where it renders            |
| ----------------------- | --------------------------- |
| `sidebar.footer`        | Bottom of the sidebar       |
| `sidebar.tabs`          | Sidebar tab bar             |
| `dashboard.sections`    | Dashboard main content area |
| `header.actions`        | Header action buttons       |
| `command-palette.items` | Command palette entries     |
| `dialog`                | Modal dialog layer          |
| `settings.tabs`         | Settings dialog tabs        |
| `session.canvas`        | Session canvas panel        |

## TypeScript vs JavaScript

**TypeScript** (`index.ts`): Compiled automatically by the host using esbuild. JSX is supported in `.ts` files. Type against `@dorkos/extension-api` for full autocompletion.

**Pre-compiled JavaScript** (`index.js`): Served directly with no compilation step. Use `React.createElement` for components since JSX isn't available without a build step.

If both `index.js` and `index.ts` exist, the pre-compiled JS takes priority.

## React Components

React is provided by the host. Do not bundle your own copy.

In TypeScript extensions, JSX works out of the box:

```typescript
function MySection() {
  return <div style={{ padding: '16px' }}>Hello</div>;
}
```

In JavaScript extensions, use `React.createElement`:

```javascript
function MySection() {
  return React.createElement('div', { style: { padding: '16px' } }, 'Hello');
}
```

Use CSS custom properties (`var(--border)`, `var(--muted-foreground)`) from the host theme for consistent styling.

## Debugging

- **Console**: Extensions run in the browser. Use `console.log` and inspect in browser devtools.
- **Source maps**: TypeScript extensions include inline source maps. Set breakpoints in the original `.ts` file via the Sources panel.
- **Compilation errors**: Check Settings > Extensions for error details if your extension fails to compile.
- **State inspection**: Call `api.getState()` from a command callback to inspect host state.

## Limitations (v1)

- No sandboxing: extensions run in the host process with full DOM access.
- No access to the Transport layer or server APIs.
- No extension marketplace or auto-update mechanism.
- Storage is local-only (no sync across machines).
