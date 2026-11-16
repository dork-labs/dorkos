---
slug: ext-platform-04-agent-extensions
number: 184
created: 2026-03-26
status: specified
project: extensibility-platform
phase: 4
depends-on: [ext-platform-03-extension-system, ext-platform-01-agent-ui-control]
---

# Phase 4: Agent-Built Extensions -- Specification

## Status

Specified

## Authors

Claude Code -- 2026-03-26

## Overview

Phase 4 enables DorkOS agents to autonomously build, install, and manage extensions via MCP tools. The agent writes TypeScript files to an extensions directory, triggers a reload, and the user sees the result immediately in the DorkOS client. Six MCP tools provide the complete lifecycle: scaffolding with slot-specific templates, compilation with structured error feedback, headless smoke testing, and live hot reload via SSE. This is the core DorkOS differentiator -- no other agent platform lets the AI extend its own host application's UI at runtime.

The design prioritizes agent iteration speed. The write-compile-reload cycle completes in under 300ms on the explicit reload path. Structured errors with file, line, and column information allow the agent to autonomously fix compilation and activation failures without human intervention.

## Background / Problem Statement

DorkOS has a working extension system (Phase 3): filesystem-based discovery, esbuild TypeScript compilation with content-hash caching, a typed ExtensionAPI surface, and client-side dynamic loading. Users can manually place extension directories on disk and enable them through the settings UI.

What's missing is the agent-facing interface. External agents (Claude Code, Cursor, Windsurf) connected via the DorkOS MCP server have no way to:

1. Discover what extensions exist and their status
2. Scaffold a new extension with correct structure and working starter code
3. Trigger recompilation after editing extension source files
4. Read structured error information to fix compilation or activation failures
5. Understand the ExtensionAPI surface to write correct extension code
6. Smoke-test an extension without requiring a browser round-trip

Without these capabilities, the agent cannot participate in the extension lifecycle. Phase 4 closes this gap by exposing extension management as MCP tools, completing the autonomous extension-building workflow that is DorkOS's primary differentiator.

## Goals

- Enable agents to create, edit, test, and reload extensions entirely through MCP tools
- Provide structured error feedback (file, line, column, message) that agents can act on autonomously
- Deliver sub-300ms iteration cycles on the explicit reload path
- Support per-extension hot reload so one bad extension does not affect others
- Scaffold working starter code with slot-specific templates that compile and activate out of the box
- Make the ExtensionAPI surface discoverable by agents via an on-demand reference tool

## Non-Goals

- Extension marketplace, sharing, or publishing
- Sandboxed execution environments (wrong risk model for v1; see Finding 3 in research)
- Non-TypeScript extensions
- Runtime `npm install` of extension dependencies
- Extension-to-extension dependencies
- File watcher for automatic reload (optional DX improvement, not blocking for v1)
- New REST endpoints for agent use (MCP tools only)

## Technical Dependencies

| Dependency                       | Role                                           |
| -------------------------------- | ---------------------------------------------- |
| `@modelcontextprotocol/sdk`      | MCP server tool registration                   |
| `esbuild`                        | TypeScript compilation (already in use)        |
| `zod`                            | Parameter validation for MCP tools             |
| `@dorkos/extension-api`          | ExtensionAPI interface, manifest schema, types |
| Phase 3 extension system         | Discovery, compilation, lifecycle management   |
| Phase 1 agent UI control         | Dispatcher, canvas, UI command infrastructure  |
| Phase 2 extension point registry | Slot registration for UI contributions         |

---

## Detailed Design

### 1. MCP Tool Architecture

#### Tool Registration Pattern

Extension tools follow the established MCP tool pattern used throughout DorkOS. Each tool is defined as a handler factory function that receives `McpToolDeps` and returns an async handler. Tools are registered in `createExternalMcpServer()` in `apps/server/src/services/core/mcp-server.ts` using the `server.tool(name, description, schema, handler)` API.

All six tools live in a single file: `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts`. The file exports individual handler factories and a top-level `getExtensionTools(deps)` function for registration with the internal tool server.

The `McpToolDeps` interface (`apps/server/src/services/runtimes/claude-code/mcp-tools/types.ts`) gains a new optional field:

```typescript
export interface McpToolDeps {
  // ... existing fields ...
  /** Optional ExtensionManager -- undefined when extensions are disabled */
  extensionManager?: ExtensionManager;
}
```

All extension tool handlers guard on `deps.extensionManager` and return a descriptive error if the extension system is not available, consistent with how `pulseStore`, `relayCore`, and `meshCore` are handled.

#### Tool Response Convention

All tool responses use the existing `jsonContent()` helper from `types.ts`:

```typescript
export function jsonContent(data: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    ...(isError && { isError: true }),
  };
}
```

#### Tool Definitions

##### 1.1 `list_extensions`

**Name:** `list_extensions`

**Description:** List all discovered DorkOS extensions with their status, scope, and errors. Returns both global (`~/.dork/extensions/`) and local (`.dork/extensions/` in active CWD) extensions.

**Parameters:** None.

**Return (success):**

```json
{
  "extensions": [
    {
      "id": "github-prs",
      "name": "GitHub PR Dashboard",
      "version": "1.0.0",
      "status": "active",
      "scope": "local",
      "bundleReady": true,
      "description": "Shows pending PR reviews in the dashboard"
    },
    {
      "id": "broken-ext",
      "name": "Broken Extension",
      "version": "0.1.0",
      "status": "compile_error",
      "scope": "global",
      "bundleReady": false,
      "error": {
        "code": "compilation_failed",
        "message": "Compilation failed for broken-ext",
        "details": "index.ts(15,8): Property 'registerWidget' does not exist on type 'ExtensionAPI'"
      }
    }
  ],
  "count": 2
}
```

Each extension entry includes: `id`, `name` (from manifest), `version` (from manifest), `status` (ExtensionStatus), `scope` (`'global'` | `'local'`), `bundleReady` (boolean), and optionally `description` (from manifest) and `error` (structured error object). The `path` field from `ExtensionRecord` is intentionally excluded from the MCP response to avoid exposing server-internal filesystem details.

**Return (error):**

```json
{ "error": "Extension system is not available" }
```

**Error cases:**

- Extension system not initialized: returns `isError: true` with descriptive message

**Handler factory:**

```typescript
export function createListExtensionsHandler(deps: McpToolDeps) {
  return async () => {
    if (!deps.extensionManager) {
      return jsonContent({ error: 'Extension system is not available' }, true);
    }
    const extensions = deps.extensionManager.listPublic().map((ext) => ({
      id: ext.id,
      name: ext.manifest.name,
      version: ext.manifest.version,
      status: ext.status,
      scope: ext.scope,
      bundleReady: ext.bundleReady,
      ...(ext.manifest.description && { description: ext.manifest.description }),
      ...(ext.error && { error: ext.error }),
    }));
    return jsonContent({ extensions, count: extensions.length });
  };
}
```

##### 1.2 `create_extension`

**Name:** `create_extension`

**Description:** Scaffold a new DorkOS extension with a working starter that compiles and activates. Creates an `extension.json` manifest and an `index.ts` entry point in the extensions directory. The extension is automatically enabled and compiled.

**Parameters:**

```typescript
{
  name: z.string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .describe('Extension ID (kebab-case, e.g. "github-prs")'),
  description: z.string()
    .optional()
    .describe('Short description of what the extension does'),
  template: z.enum(['dashboard-card', 'command', 'settings-panel'])
    .optional()
    .default('dashboard-card')
    .describe('Starter template: dashboard-card (default), command, or settings-panel'),
  scope: z.enum(['global', 'local'])
    .optional()
    .default('local')
    .describe('Where to create: local (.dork/extensions/ in CWD) or global (~/.dork/extensions/)'),
}
```

**Return (success):**

```json
{
  "created": true,
  "id": "github-prs",
  "path": "/Users/kai/projects/myapp/.dork/extensions/github-prs",
  "scope": "local",
  "template": "dashboard-card",
  "status": "compiled",
  "bundleReady": true,
  "files": ["extension.json", "index.ts"],
  "message": "Extension 'github-prs' created and compiled successfully. Edit index.ts and call reload_extensions to see changes."
}
```

**Return (compilation error after scaffold):**

```json
{
  "created": true,
  "id": "github-prs",
  "path": "/Users/kai/projects/myapp/.dork/extensions/github-prs",
  "scope": "local",
  "template": "dashboard-card",
  "status": "compile_error",
  "bundleReady": false,
  "files": ["extension.json", "index.ts"],
  "error": {
    "code": "compilation_failed",
    "message": "Compilation failed for github-prs",
    "errors": [
      {
        "text": "Cannot find module 'react'",
        "location": { "file": "index.ts", "line": 1, "column": 0 }
      }
    ]
  }
}
```

**Return (error):**

```json
{
  "error": "Extension 'github-prs' already exists at /Users/kai/projects/myapp/.dork/extensions/github-prs"
}
```

**Error cases:**

- Extension system not available: `isError: true`
- Extension directory already exists: `isError: true` with path
- Invalid scope (local requested but no CWD active): `isError: true`
- Filesystem write failure: `isError: true` with OS error message

**Implementation notes:**

1. Resolve the target directory based on scope:
   - `local`: `{currentCwd}/.dork/extensions/{name}/`
   - `global`: `{dorkHome}/extensions/{name}/`
2. Check that the directory does not already exist. If it does, return an error.
3. Create the directory with `fs.mkdir({ recursive: true })`.
4. Write `extension.json` using the generated manifest template (see Section 5.5).
5. Write `index.ts` using the selected template (see Section 5).
6. Trigger a full reload to discover and compile the new extension.
7. Add the extension ID to `config.extensions.enabled` so it activates immediately.
8. Return the result including compilation status.

##### 1.3 `reload_extensions`

**Name:** `reload_extensions`

**Description:** Recompile and reload extensions. With no arguments, reloads all extensions. With an `id`, reloads only that extension (per-extension hot reload). Returns per-extension structured results including any compilation or activation errors.

**Parameters:**

```typescript
{
  id: z.string()
    .optional()
    .describe('Extension ID to reload. Omit to reload all extensions.'),
}
```

**Return (success, all):**

```json
{
  "results": {
    "github-prs": {
      "status": "compiled",
      "bundleReady": true
    },
    "my-commands": {
      "status": "compiled",
      "bundleReady": true
    }
  },
  "summary": {
    "total": 2,
    "compiled": 2,
    "errors": 0
  }
}
```

**Return (with errors):**

```json
{
  "results": {
    "github-prs": {
      "status": "compile_error",
      "bundleReady": false,
      "error": {
        "code": "compilation_failed",
        "message": "Compilation failed for github-prs",
        "errors": [
          {
            "text": "Property 'registerWidget' does not exist on type 'ExtensionAPI'",
            "location": {
              "file": "index.ts",
              "line": 15,
              "column": 8
            }
          }
        ]
      }
    },
    "my-commands": {
      "status": "compiled",
      "bundleReady": true
    }
  },
  "summary": {
    "total": 2,
    "compiled": 1,
    "errors": 1
  }
}
```

**Return (single extension, success):**

```json
{
  "results": {
    "github-prs": {
      "status": "compiled",
      "bundleReady": true,
      "sourceHash": "a3f8c91d2e4b5f67"
    }
  },
  "summary": {
    "total": 1,
    "compiled": 1,
    "errors": 0
  }
}
```

**Return (single extension, not found):**

```json
{ "error": "Extension 'nonexistent' not found" }
```

**Error cases:**

- Extension system not available: `isError: true`
- Single-extension reload with unknown ID: `isError: true`
- Filesystem errors during discovery: included in per-extension error results

**Implementation notes:**

When `id` is provided, the handler calls `extensionManager.reloadExtension(id)` (new method, see Section 2.3). When `id` is omitted, it calls the existing `extensionManager.reload()` and transforms the results into the per-extension result format.

After a successful reload (either single or all), the handler broadcasts an `extension_reloaded` SSE event to all connected clients (see Section 4).

##### 1.4 `get_extension_errors`

**Name:** `get_extension_errors`

**Description:** Get detailed compilation or runtime errors for a specific extension. Use this after `reload_extensions` reports errors to get the full error context including source locations.

**Parameters:**

```typescript
{
  id: z.string().describe('Extension ID to get errors for'),
}
```

**Return (has errors):**

```json
{
  "id": "github-prs",
  "status": "compile_error",
  "error": {
    "code": "compilation_failed",
    "message": "Compilation failed for github-prs",
    "errors": [
      {
        "text": "Property 'registerWidget' does not exist on type 'ExtensionAPI'",
        "location": {
          "file": "index.ts",
          "line": 15,
          "column": 8
        }
      },
      {
        "text": "Cannot find name 'fetchData'",
        "location": {
          "file": "index.ts",
          "line": 23,
          "column": 14
        }
      }
    ]
  }
}
```

**Return (no errors):**

```json
{
  "id": "github-prs",
  "status": "compiled",
  "error": null
}
```

**Return (not found):**

```json
{ "error": "Extension 'nonexistent' not found" }
```

**Error cases:**

- Extension system not available: `isError: true`
- Unknown extension ID: `isError: true`

**Implementation notes:**

Reads the error field from the `ExtensionRecord` via `extensionManager.get(id)`. The error structure mirrors what esbuild produces, with the `details` field split into individual error entries with location information. For `activate_error` status, the error object contains the runtime error message and stack trace.

##### 1.5 `get_extension_api`

**Name:** `get_extension_api`

**Description:** Get the full ExtensionAPI type definitions and usage examples. Call this when writing or debugging an extension to understand the available API surface. Returns TypeScript interface definitions for ExtensionAPI, ExtensionPointId, ExtensionReadableState, and ExtensionModule.

**Parameters:** None.

**Return (success):**

The response is a single text block containing the concatenated type definitions from `packages/extension-api/src/` plus usage examples. The content is structured for agent consumption:

````json
{
  "content": [
    {
      "type": "text",
      "text": "# DorkOS Extension API Reference\n\n## ExtensionModule Interface\n\nYour extension must export an `activate` function:\n\n```typescript\nimport type { ExtensionAPI } from '@dorkos/extension-api';\n\nexport function activate(api: ExtensionAPI): void | (() => void) {\n  // Register contributions, return optional cleanup function\n}\n```\n\n## ExtensionAPI Interface\n\n```typescript\ninterface ExtensionAPI {\n  readonly id: string;\n\n  // --- UI Contributions ---\n  registerComponent(slot: ExtensionPointId, id: string, component: ComponentType, options?: { priority?: number }): () => void;\n  registerCommand(id: string, label: string, callback: () => void, options?: { icon?: string; shortcut?: string }): () => void;\n  registerDialog(id: string, component: ComponentType): { open: () => void; close: () => void };\n  registerSettingsTab(id: string, label: string, component: ComponentType): () => void;\n\n  // --- UI Control ---\n  executeCommand(command: UiCommand): void;\n  openCanvas(content: UiCanvasContent): void;\n  navigate(path: string): void;\n\n  // --- State ---\n  getState(): ExtensionReadableState;\n  subscribe(selector: (state: ExtensionReadableState) => unknown, callback: (value: unknown) => void): () => void;\n\n  // --- Storage ---\n  loadData<T>(): Promise<T | null>;\n  saveData<T>(data: T): Promise<void>;\n\n  // --- Notifications ---\n  notify(message: string, options?: { type?: 'info' | 'success' | 'error' }): void;\n\n  // --- Context ---\n  isSlotAvailable(slot: ExtensionPointId): boolean;\n}\n```\n\n## ExtensionPointId (Available Slots)\n\n```typescript\ntype ExtensionPointId =\n  | 'sidebar.footer'\n  | 'sidebar.tabs'\n  | 'dashboard.sections'\n  | 'header.actions'\n  | 'command-palette.items'\n  | 'dialog'\n  | 'settings.tabs'\n  | 'session.canvas';\n```\n\n## ExtensionReadableState\n\n```typescript\ninterface ExtensionReadableState {\n  currentCwd: string | null;\n  activeSessionId: string | null;\n  agentId: string | null;\n}\n```\n\n## Usage Examples\n\n### Dashboard Section\n```typescript\nexport function activate(api: ExtensionAPI) {\n  api.registerComponent('dashboard.sections', 'my-section', MyComponent, { priority: 50 });\n}\n```\n\n### Command Palette Item\n```typescript\nexport function activate(api: ExtensionAPI) {\n  api.registerCommand('greet', 'Say Hello', () => {\n    api.notify('Hello from my extension!', { type: 'success' });\n  });\n}\n```\n\n### Settings Tab with Persistence\n```typescript\nexport function activate(api: ExtensionAPI) {\n  api.registerSettingsTab('config', 'My Settings', MySettingsPanel);\n}\n```\n\n### Storage\n```typescript\nconst data = await api.loadData<{ count: number }>();\nawait api.saveData({ count: (data?.count ?? 0) + 1 });\n```"
    }
  ]
}
````

**Implementation notes:**

The response text is a hardcoded string constant in the tool handler (not dynamically read from disk). This ensures the reference is always available even if the source files change between versions. The content is structured as markdown with TypeScript code blocks for easy agent parsing. It includes all methods from the `ExtensionAPI` interface, all slot IDs, the `ExtensionModule` contract, and common usage patterns.

When the `ExtensionAPI` interface changes, this constant must be updated to match. A test should verify that the hardcoded reference mentions all methods in the actual interface.

##### 1.6 `test_extension`

**Name:** `test_extension`

**Description:** Run a headless smoke test on an extension. Compiles the extension (catching TypeScript errors) and activates it against a mock ExtensionAPI (catching runtime errors). Returns the contributions map showing what the extension registered in each slot. Does not render UI -- use `reload_extensions` for visual verification.

**Parameters:**

```typescript
{
  id: z.string().describe('Extension ID to test'),
}
```

**Return (success):**

```json
{
  "status": "ok",
  "id": "github-prs",
  "contributions": {
    "dashboard.sections": 1,
    "command-palette.items": 0,
    "settings.tabs": 0,
    "sidebar.footer": 0,
    "sidebar.tabs": 0,
    "header.actions": 0,
    "dialog": 0,
    "session.canvas": 0
  },
  "message": "Extension activated successfully. Registered 1 contribution(s)."
}
```

**Return (compilation error):**

```json
{
  "status": "error",
  "id": "github-prs",
  "phase": "compilation",
  "errors": [
    {
      "text": "Property 'registerWidget' does not exist on type 'ExtensionAPI'",
      "location": { "file": "index.ts", "line": 15, "column": 8 }
    }
  ]
}
```

**Return (activation error):**

```json
{
  "status": "error",
  "id": "github-prs",
  "phase": "activation",
  "error": "TypeError: Cannot read properties of undefined (reading 'map')",
  "stack": "TypeError: Cannot read properties of undefined...\n    at activate (index.ts:12:5)"
}
```

**Return (not found):**

```json
{ "error": "Extension 'nonexistent' not found" }
```

**Error cases:**

- Extension system not available: `isError: true`
- Unknown extension ID: `isError: true`
- Compilation failure: returned as `status: 'error'` with `phase: 'compilation'`
- Activation failure: returned as `status: 'error'` with `phase: 'activation'`

**Implementation notes:**

The handler calls `extensionManager.testExtension(id)` (new method, see Section 2.2). The test is performed server-side: compile the extension, then call its `activate()` function with a mock ExtensionAPI that counts registrations per slot. The mock does not connect to any real UI -- it is a counting stub. The contributions map always lists all slot IDs with their registration counts so the agent can verify expected registrations.

### 2. Extension Manager Additions

Three new methods are added to `ExtensionManager` (`apps/server/src/services/extensions/extension-manager.ts`).

#### 2.1 `createExtension()` Method

```typescript
/**
 * Scaffold a new extension directory with manifest and starter code.
 *
 * @param options - Creation parameters
 * @returns Created extension info including compilation result
 */
async createExtension(options: {
  name: string;
  description?: string;
  template: 'dashboard-card' | 'command' | 'settings-panel';
  scope: 'global' | 'local';
}): Promise<CreateExtensionResult>
```

**`CreateExtensionResult` type:**

```typescript
interface CreateExtensionResult {
  id: string;
  path: string;
  scope: 'global' | 'local';
  template: string;
  status: ExtensionStatus;
  bundleReady: boolean;
  files: string[];
  error?: {
    code: string;
    message: string;
    errors?: Array<{
      text: string;
      location?: { file: string; line: number; column: number };
    }>;
  };
}
```

**Behavior:**

1. Resolve the target directory:
   - `scope: 'local'`: requires `this.currentCwd` to be set. Path: `{currentCwd}/.dork/extensions/{name}/`
   - `scope: 'global'`: uses `this.dorkHome`. Path: `{dorkHome}/extensions/{name}/`
2. Throw if `scope === 'local'` and `this.currentCwd === null`.
3. Check `fs.access(targetDir)` -- throw if directory already exists.
4. `fs.mkdir(targetDir, { recursive: true })` -- creates intermediate directories.
5. Write `extension.json` from the manifest template (see Section 5.5).
6. Write `index.ts` from the selected template (see Section 5).
7. Call `this.reload()` to discover the new extension.
8. Call `this.enable(name)` to compile and add to the enabled list.
9. Return the result with compilation status from the `enable()` call.

**Error handling:**

- If directory exists: throw `new Error(\`Extension '${name}' already exists at ${targetDir}\`)`
- If scope is local with no CWD: throw `new Error('Cannot create local extension: no working directory is active')`
- If filesystem write fails: propagate the OS error
- If compilation fails: return the result with `status: 'compile_error'` and the error details (the extension files are still on disk for the agent to fix)

#### 2.2 `testExtension()` Method

```typescript
/**
 * Compile an extension and activate it against a mock API to verify
 * it loads without errors. Returns the contribution counts per slot.
 *
 * @param id - Extension identifier
 * @returns Test result with contribution counts or error details
 */
async testExtension(id: string): Promise<TestExtensionResult>
```

**`TestExtensionResult` type:**

```typescript
interface TestExtensionResult {
  status: 'ok' | 'error';
  id: string;
  phase?: 'compilation' | 'activation';
  contributions?: Record<ExtensionPointId, number>;
  errors?: Array<{
    text: string;
    location?: { file: string; line: number; column: number };
  }>;
  error?: string;
  stack?: string;
  message?: string;
}
```

**Behavior:**

1. Look up the extension record via `this.extensions.get(id)`. Return error if not found.
2. Call `this.compiler.compile(record)`. If compilation fails, return `{ status: 'error', phase: 'compilation', errors }`.
3. Read the compiled bundle via `this.compiler.readBundle(id, sourceHash)`.
4. Create a `MockExtensionAPI` instance (see below).
5. Evaluate the bundle in a `new Function()` wrapper or dynamic `import()` of a data URI, extracting the `activate` export.
6. Call `activate(mockApi)` in a try/catch. If it throws, return `{ status: 'error', phase: 'activation', error, stack }`.
7. Return `{ status: 'ok', contributions: mockApi.getContributions() }`.

**`MockExtensionAPI`:**

A lightweight stub that implements all `ExtensionAPI` methods as no-ops while counting registrations per slot:

```typescript
class MockExtensionAPI implements ExtensionAPI {
  readonly id: string;
  private counts: Record<string, number> = {};

  registerComponent(slot: ExtensionPointId, _id: string, _component: unknown): () => void {
    this.counts[slot] = (this.counts[slot] ?? 0) + 1;
    return () => {};
  }

  registerCommand(_id: string, _label: string, _callback: () => void): () => void {
    this.counts['command-palette.items'] = (this.counts['command-palette.items'] ?? 0) + 1;
    return () => {};
  }

  registerDialog(_id: string, _component: unknown): { open: () => void; close: () => void } {
    this.counts['dialog'] = (this.counts['dialog'] ?? 0) + 1;
    return { open: () => {}, close: () => {} };
  }

  registerSettingsTab(_id: string, _label: string, _component: unknown): () => void {
    this.counts['settings.tabs'] = (this.counts['settings.tabs'] ?? 0) + 1;
    return () => {};
  }

  // UI control, state, storage, notification methods are all no-ops
  executeCommand(): void {}
  openCanvas(): void {}
  navigate(): void {}
  getState(): ExtensionReadableState {
    return { currentCwd: null, activeSessionId: null, agentId: null };
  }
  subscribe(): () => void {
    return () => {};
  }
  async loadData(): Promise<null> {
    return null;
  }
  async saveData(): Promise<void> {}
  notify(): void {}
  isSlotAvailable(): boolean {
    return true;
  }

  /** Return registration counts for all known slots. */
  getContributions(): Record<ExtensionPointId, number> {
    const allSlots: ExtensionPointId[] = [
      'dashboard.sections',
      'command-palette.items',
      'settings.tabs',
      'sidebar.footer',
      'sidebar.tabs',
      'header.actions',
      'dialog',
      'session.canvas',
    ];
    return Object.fromEntries(allSlots.map((slot) => [slot, this.counts[slot] ?? 0])) as Record<
      ExtensionPointId,
      number
    >;
  }
}
```

**Note on server-side activation:** Since extensions are compiled as ESM browser bundles (with `react` and `react-dom` externalized), the server-side `testExtension()` evaluates the bundle in a limited context. React component constructors will not be called -- only the `activate()` function runs. This means `registerComponent` receives an opaque value (the component function) but does not attempt to render it. This is sufficient for verifying that the extension's activation logic runs without errors and calls the expected registration methods.

#### 2.3 `reloadExtension(id)` Method

```typescript
/**
 * Reload a single extension: recompile and update its record.
 * Used for per-extension hot reload when the agent edits one extension.
 *
 * @param id - Extension identifier
 * @returns Structured reload result for the single extension
 */
async reloadExtension(id: string): Promise<ReloadExtensionResult>
```

**`ReloadExtensionResult` type:**

```typescript
interface ReloadExtensionResult {
  id: string;
  status: ExtensionStatus;
  bundleReady: boolean;
  sourceHash?: string;
  error?: {
    code: string;
    message: string;
    errors?: Array<{
      text: string;
      location?: { file: string; line: number; column: number };
    }>;
  };
}
```

**Behavior:**

1. Look up the extension record via `this.extensions.get(id)`. Throw if not found.
2. Re-read the extension directory to pick up any file changes (re-discover just this extension).
3. Call `this.compiler.compile(record)` to recompile.
4. Update the record's status, sourceHash, bundleReady, and error fields based on the compile result.
5. If compilation succeeds, clear any cached error from a previous failed compilation.
6. Return the structured result.

The caller (MCP tool handler) is responsible for broadcasting the SSE event after this method completes.

### 3. Structured Error Types

Error types are critical for the agent feedback loop. The following interfaces define the exact shapes used in MCP tool responses.

#### 3.1 Compilation Error Format

This matches the existing `CompilationError` interface in `extension-compiler.ts`:

```typescript
interface CompilationError {
  code: 'compilation_failed';
  message: string;
  errors: Array<{
    text: string;
    location?: {
      file: string;
      line: number;
      column: number;
    };
  }>;
}
```

The `errors` array contains individual error entries from esbuild. Each entry has a `text` field with the human-readable error message and an optional `location` with file path (relative to extension directory), line number (1-based), and column number (0-based). The `location` is omitted for errors that do not correspond to a source location (e.g., missing entry point).

#### 3.2 Runtime Error Format

For errors that occur during `activate()` execution:

```typescript
interface ActivationError {
  code: 'activate_error';
  message: string;
  stack?: string;
}
```

The `message` is the error's `message` property (or stringified error). The `stack` is the full stack trace when available, which includes source-mapped locations from the inline sourcemap generated by esbuild.

#### 3.3 Reload Result Format

The per-extension result returned by `reload_extensions`:

```typescript
interface ExtensionReloadResult {
  status: ExtensionStatus;
  bundleReady: boolean;
  sourceHash?: string;
  error?: {
    code: string;
    message: string;
    details?: string;
    errors?: Array<{
      text: string;
      location?: { file: string; line: number; column: number };
    }>;
  };
}
```

The full reload response wraps these in a `results` map keyed by extension ID, plus a `summary` object with aggregate counts.

### 4. Client-Side Hot Reload

#### 4.1 SSE Event: `extension_reloaded`

The server broadcasts an SSE event when extensions are reloaded. Since the existing SSE infrastructure is session-scoped (`GET /api/sessions/:id/stream`), extension reload events use a different delivery mechanism: a dedicated global SSE endpoint or the existing CWD-change notification pattern.

**Approach:** Add a lightweight global SSE endpoint at `GET /api/extensions/events` that connected clients subscribe to for extension lifecycle events. Alternatively, deliver the event via the existing session-scoped SSE connection as a non-session event (similar to how `presence_update` is broadcast).

**Event format:**

```
event: extension_reloaded
data: {"extensions":["github-prs"],"timestamp":"2026-03-26T14:30:00.000Z"}
```

**Payload:**

```typescript
interface ExtensionReloadedEvent {
  /** Extension IDs that were reloaded. */
  extensions: string[];
  /** ISO timestamp of the reload. */
  timestamp: string;
}
```

When the `reload_extensions` MCP tool completes (either single or all), the handler calls a broadcast function that writes the SSE event to all connected clients.

#### 4.2 Per-Extension Deactivate/Reactivate

When the client receives an `extension_reloaded` SSE event, the `ExtensionProvider` (in `extension-context.tsx`) performs per-extension hot reload:

1. For each extension ID in the event payload:
   a. Look up the extension in the `loaded` map.
   b. If found and currently active:
   - Call `ext.deactivate?.()` (the optional cleanup returned by `activate()`)
   - Run all `ext.cleanups` (unsubscribe functions from `register*` calls)
   - Remove from the `loaded` map
     c. Fetch the updated extension list from `GET /api/extensions`
     d. For extensions that are now `compiled` and `bundleReady`:
   - Dynamic `import()` the bundle with a cache-bust query string
   - Create a new `ExtensionAPI` instance via `createExtensionAPI()`
   - Call `module.activate(api)`
   - Add to the `loaded` map
2. Update the React state to trigger a rerender of affected slots.

Extensions not listed in the event payload are untouched -- their state and registrations are preserved.

**Implementation in `extension-context.tsx`:**

Add an `useEffect` that creates an `EventSource` connection to the extension events endpoint. On receiving `extension_reloaded`, call a new `reloadExtensions(ids: string[])` method on the `ExtensionLoader` class.

**New method on `ExtensionLoader`:**

```typescript
/**
 * Hot-reload specific extensions: deactivate, re-import, and reactivate.
 *
 * @param ids - Extension IDs to reload
 * @returns Updated loaded map
 */
async reloadExtensions(ids: string[]): Promise<Map<string, LoadedExtension>>
```

#### 4.3 Bundle URL Cache Busting

The browser caches ESM modules by URL. When an extension is recompiled, the same URL (`/api/extensions/{id}/bundle`) would return the cached module. Cache busting is achieved by appending a timestamp query parameter:

```typescript
const module = await import(`/api/extensions/${id}/bundle?t=${Date.now()}`);
```

The server already sets `Cache-Control: no-store` on bundle responses (see `routes/extensions.ts`), but the browser's ESM module cache is separate from the HTTP cache. The query string ensures a fresh module evaluation.

**Memory note:** Each `import()` with a unique URL creates a new module instance that cannot be garbage collected. For interactive development loops (10-50 reloads), this is acceptable (~50-500KB per module instance). A server restart or page reload clears all module instances.

### 5. Template System

#### 5.1 Template Registry

Templates are string constants defined directly in the MCP tools file (`extension-tools.ts`). There are no external template files. Each template is a function that accepts the extension name and description and returns the `index.ts` content as a string.

```typescript
const TEMPLATES: Record<string, (name: string, description: string) => string> = {
  'dashboard-card': generateDashboardCardTemplate,
  command: generateCommandTemplate,
  'settings-panel': generateSettingsPanelTemplate,
};
```

#### 5.2 `dashboard-card` Template

The default template. Creates a dashboard section with a placeholder component.

```typescript
function generateDashboardCardTemplate(name: string, description: string): string {
  return `// ${name} — DorkOS Extension
// ${description || 'A dashboard section extension.'}
//
// ExtensionAPI Quick Reference:
//   api.registerComponent(slot, id, component, options?) — Register a React component in a UI slot
//   api.registerCommand(id, label, callback, options?)   — Register a command palette item
//   api.notify(message, options?)                        — Show a toast notification
//   api.loadData<T>() / api.saveData<T>(data)            — Persistent storage scoped to this extension
//   api.getState()                                       — Read-only host state (currentCwd, activeSessionId)
//   api.subscribe(selector, callback)                    — Subscribe to state changes
//
// Available slots: dashboard.sections, command-palette.items, settings.tabs,
//   sidebar.footer, sidebar.tabs, header.actions, dialog, session.canvas

import type { ExtensionAPI } from '@dorkos/extension-api';

/** Main dashboard section component. */
function ${toPascalCase(name)}Section() {
  return (
    <div style={{ padding: '16px', border: '1px solid var(--border)', borderRadius: '12px' }}>
      <h3 style={{ margin: '0 0 8px 0', fontSize: '14px', fontWeight: 600 }}>
        ${toTitleCase(name)}
      </h3>
      <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted-foreground)' }}>
        ${description || 'Extension content goes here. Edit this file and call reload_extensions.'}
      </p>
    </div>
  );
}

export function activate(api: ExtensionAPI): void {
  // Register a section on the dashboard
  api.registerComponent('dashboard.sections', '${name}-section', ${toPascalCase(name)}Section, {
    priority: 50,
  });
}
`;
}
```

#### 5.3 `command` Template

Creates a command palette item that shows a notification.

```typescript
function generateCommandTemplate(name: string, description: string): string {
  return `// ${name} — DorkOS Extension
// ${description || 'A command palette extension.'}
//
// ExtensionAPI Quick Reference:
//   api.registerComponent(slot, id, component, options?) — Register a React component in a UI slot
//   api.registerCommand(id, label, callback, options?)   — Register a command palette item
//   api.notify(message, options?)                        — Show a toast notification
//   api.loadData<T>() / api.saveData<T>(data)            — Persistent storage scoped to this extension
//   api.getState()                                       — Read-only host state (currentCwd, activeSessionId)
//
// Available slots: dashboard.sections, command-palette.items, settings.tabs,
//   sidebar.footer, sidebar.tabs, header.actions, dialog, session.canvas

import type { ExtensionAPI } from '@dorkos/extension-api';

export function activate(api: ExtensionAPI): void {
  // Register a command in the command palette (Cmd+K)
  api.registerCommand(
    '${name}-run',
    '${toTitleCase(name)}',
    () => {
      api.notify('${toTitleCase(name)} executed!', { type: 'success' });
    },
    { icon: 'terminal' }
  );
}
`;
}
```

#### 5.4 `settings-panel` Template

Creates a settings tab with `loadData`/`saveData` persistence.

```typescript
function generateSettingsPanelTemplate(name: string, description: string): string {
  return `// ${name} — DorkOS Extension
// ${description || 'A settings panel extension.'}
//
// ExtensionAPI Quick Reference:
//   api.registerComponent(slot, id, component, options?) — Register a React component in a UI slot
//   api.registerCommand(id, label, callback, options?)   — Register a command palette item
//   api.registerSettingsTab(id, label, component)        — Register a tab in the settings dialog
//   api.notify(message, options?)                        — Show a toast notification
//   api.loadData<T>() / api.saveData<T>(data)            — Persistent storage scoped to this extension
//   api.getState()                                       — Read-only host state (currentCwd, activeSessionId)
//
// Available slots: dashboard.sections, command-palette.items, settings.tabs,
//   sidebar.footer, sidebar.tabs, header.actions, dialog, session.canvas

import type { ExtensionAPI } from '@dorkos/extension-api';

/** Settings panel component demonstrating persistent storage. */
function ${toPascalCase(name)}Settings() {
  return (
    <div style={{ padding: '16px' }}>
      <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600 }}>
        ${toTitleCase(name)} Settings
      </h3>
      <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted-foreground)' }}>
        Configure your extension here. Use api.loadData() and api.saveData() for persistence.
      </p>
    </div>
  );
}

export function activate(api: ExtensionAPI): void {
  // Register a tab in the settings dialog
  api.registerSettingsTab('${name}-settings', '${toTitleCase(name)}', ${toPascalCase(name)}Settings);
}
`;
}
```

**Helper functions** used by templates:

```typescript
/** Convert kebab-case to PascalCase: "github-prs" → "GithubPrs" */
function toPascalCase(str: string): string {
  return str
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

/** Convert kebab-case to Title Case: "github-prs" → "Github Prs" */
function toTitleCase(str: string): string {
  return str
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}
```

#### 5.5 Generated `extension.json`

The manifest template used by `create_extension`:

```typescript
function generateManifest(name: string, description?: string, template?: string): object {
  const contributions: Record<string, boolean> = {};
  switch (template) {
    case 'dashboard-card':
      contributions['dashboard.sections'] = true;
      break;
    case 'command':
      contributions['command-palette.items'] = true;
      break;
    case 'settings-panel':
      contributions['settings.tabs'] = true;
      break;
  }

  return {
    id: name,
    name: toTitleCase(name),
    version: '0.1.0',
    ...(description && { description }),
    author: 'agent',
    minHostVersion: '0.1.0',
    contributions,
  };
}
```

**Example output for `create_extension({ name: 'github-prs', description: 'Shows PR review queue', template: 'dashboard-card' })`:**

```json
{
  "id": "github-prs",
  "name": "Github Prs",
  "version": "0.1.0",
  "description": "Shows PR review queue",
  "author": "agent",
  "minHostVersion": "0.1.0",
  "contributions": {
    "dashboard.sections": true
  }
}
```

### 6. ExtensionAPI Context Delivery

#### 6.1 `get_extension_api` Tool Response

The `get_extension_api` tool returns a comprehensive text reference that gives the agent everything it needs to write correct extension code. The content includes:

1. **ExtensionModule contract** -- the `activate()` function signature and return type
2. **Full ExtensionAPI interface** -- all methods with parameter types and return types
3. **ExtensionPointId union** -- all available slot names
4. **ExtensionReadableState interface** -- the shape returned by `getState()`
5. **Usage examples** -- one example for each common pattern (dashboard section, command, settings tab, storage)

The text is formatted as markdown with TypeScript code blocks. This format is optimal for LLM consumption: the markdown structure provides semantic organization, and the code blocks provide exact type information.

The reference is approximately 200-300 lines / 2000-3000 tokens. This is well within the context budget for a single tool response.

#### 6.2 Inline Comments in Scaffolded Code

Every generated `index.ts` template includes a compact API reference in the file header comments (see Section 5.2-5.4). These comments:

- List the most commonly used API methods with parameter signatures
- List all available slot names
- Survive context truncation (they travel with the code)
- Provide enough information for the agent to make its first edit without calling `get_extension_api`

The inline comments are intentionally compact (~10 lines). The full reference is available via the `get_extension_api` tool when the agent needs more detail.

---

## Data Flow

### Agent Creates Extension

```
1. Agent calls create_extension(name: "github-prs", template: "dashboard-card", scope: "local")
2. MCP handler validates parameters
3. ExtensionManager.createExtension() runs:
   a. Resolves path: {cwd}/.dork/extensions/github-prs/
   b. Checks directory does not exist
   c. Creates directory
   d. Writes extension.json (manifest)
   e. Writes index.ts (dashboard-card template)
   f. Calls reload() to discover the new extension
   g. Calls enable("github-prs") to compile and add to enabled list
4. esbuild compiles index.ts → cached as {dorkHome}/cache/extensions/github-prs.{hash}.js
5. MCP handler broadcasts extension_reloaded SSE event
6. MCP handler returns { created: true, status: "compiled", bundleReady: true, ... }
7. Client receives SSE event → dynamic import() of /api/extensions/github-prs/bundle
8. Client activates extension → registerComponent() called → dashboard section appears
```

### Agent Iterates on Extension

```
1. Agent edits {cwd}/.dork/extensions/github-prs/index.ts (writes file to disk)
2. Agent calls reload_extensions(id: "github-prs")
3. MCP handler calls ExtensionManager.reloadExtension("github-prs"):
   a. Reads updated source from disk
   b. Computes new content hash → cache miss → esbuild recompile (~10ms)
   c. Updates ExtensionRecord: status, sourceHash, bundleReady
4. If compilation error:
   a. Returns structured error: { status: "compile_error", error: { errors: [...] } }
   b. Agent reads error (file:line:col:message), fixes source, goes to step 1
5. If compilation success:
   a. MCP handler broadcasts extension_reloaded SSE event
   b. Returns { status: "compiled", bundleReady: true }
6. Client receives SSE event:
   a. Deactivates current github-prs instance (cleanup functions)
   b. Re-imports bundle with cache-bust URL (/api/extensions/github-prs/bundle?t=...)
   c. Creates fresh ExtensionAPI, calls activate()
   d. Dashboard section re-renders with updated component
7. User sees the updated extension (~200-300ms from step 2)
```

### End-to-End Workflow

```
User → "Build me a dashboard card showing my GitHub PR review queue"
  │
  ├─ Agent calls get_extension_api() → reads API reference
  │
  ├─ Agent calls create_extension(name: "github-prs", description: "...", template: "dashboard-card")
  │   └─ Extension scaffolded, compiled, activated → user sees placeholder card
  │
  ├─ Agent calls test_extension("github-prs")
  │   └─ { status: "ok", contributions: { "dashboard.sections": 1, ... } }
  │
  ├─ Agent edits index.ts: adds fetch logic, PR list rendering, status badges
  │
  ├─ Agent calls reload_extensions(id: "github-prs")
  │   └─ Compilation error: line 45 — 'fetchPRs' is not defined
  │
  ├─ Agent fixes: adds fetchPRs function
  │
  ├─ Agent calls reload_extensions(id: "github-prs")
  │   └─ Success → SSE → client hot reload → user sees PR list
  │
  ├─ User: "Add repo filter and review status badges"
  │
  ├─ Agent edits index.ts: adds filter dropdown, status badges
  │
  ├─ Agent calls reload_extensions(id: "github-prs")
  │   └─ Success → user sees updated card with filters and badges
  │
  └─ Agent calls list_extensions() → confirms github-prs is active
```

---

## User Experience

When Kai asks his agent to build a dashboard card, here is what he sees:

1. **Immediate feedback:** Within 1-2 seconds of asking, a new card appears on the dashboard. It has a placeholder title and description from the template. This confirms the extension system is working.

2. **Iterative refinement:** As the agent edits the extension and reloads, the card updates in place. The transition is smooth -- the card content changes but the card itself does not flicker or reposition. Other dashboard sections are unaffected. The total visible latency from "agent makes a change" to "card updates" is under 500ms.

3. **Error visibility:** If the agent encounters a compilation error, Kai sees nothing change -- the previous version of the card remains active (or the placeholder remains if it was the first compile). The agent autonomously reads the structured error, fixes the code, and reloads. Kai is not interrupted by error states.

4. **Persistence:** The extension survives page reloads and server restarts. It is automatically compiled and activated on startup because it was added to the enabled list. If Kai changes his working directory to a different project, local extensions from the previous project are removed and local extensions from the new project are loaded.

5. **Discoverability:** Kai can see all installed extensions in Settings > Extensions. Agent-created extensions appear with `author: "agent"` and can be enabled, disabled, or inspected like any other extension.

---

## Testing Strategy

### Unit Tests

**File:** `apps/server/src/services/runtimes/claude-code/mcp-tools/__tests__/extension-tools.test.ts`

Test each handler factory in isolation with a mock `ExtensionManager`:

- `createListExtensionsHandler`: returns formatted extension list, handles empty list, handles missing manager
- `createCreateExtensionHandler`: validates parameters, handles existing directory error, handles local scope without CWD, verifies manifest and template content
- `createReloadExtensionsHandler`: returns per-extension results, handles single-extension reload, handles not-found ID, broadcasts SSE event
- `createGetExtensionErrorsHandler`: returns errors for known extension, returns null error for healthy extension, handles unknown ID
- `createGetExtensionApiHandler`: returns reference text containing all API methods
- `createTestExtensionHandler`: returns contributions map on success, returns compilation errors, returns activation errors

**Mock strategy:** Create a mock `ExtensionManager` with `vi.fn()` stubs for `listPublic()`, `get()`, `reload()`, `enable()`, `createExtension()`, `testExtension()`, `reloadExtension()`. Inject via `McpToolDeps`.

**File:** `apps/server/src/services/extensions/__tests__/extension-manager-create.test.ts`

Test `createExtension()`:

- Writes correct manifest JSON for each template
- Writes correct index.ts for each template
- Creates directory structure at correct path (global vs local)
- Throws when directory exists
- Throws when local scope requested with no CWD
- Triggers reload and enable after creation

**File:** `apps/server/src/services/extensions/__tests__/extension-manager-test.test.ts`

Test `testExtension()`:

- Returns contribution counts for valid extension
- Returns compilation errors for broken extension
- Returns activation errors when activate() throws
- MockExtensionAPI counts registrations correctly per slot

**File:** `apps/server/src/services/extensions/__tests__/extension-manager-reload.test.ts`

Test `reloadExtension()`:

- Recompiles changed source (different hash)
- Returns cached result for unchanged source
- Updates record status correctly
- Returns structured errors on compilation failure

### Integration Tests

**File:** `apps/server/src/services/core/__tests__/mcp-extension-tools.test.ts`

Test the MCP tool registrations via the MCP server instance:

- All 6 tools are registered and callable
- Tool parameter validation works (invalid ID rejected, required fields enforced)
- End-to-end: `create_extension` → `list_extensions` includes new extension
- End-to-end: `create_extension` → `reload_extensions` → `get_extension_errors` returns no errors

**Mock strategy:** Use a temp directory for `dorkHome`, create a real `ExtensionManager` and `ExtensionCompiler`, mock only the filesystem paths.

### E2E Tests

**File:** `apps/e2e/tests/agent-extension-workflow.spec.ts`

A Playwright test that exercises the full workflow:

1. Connect to the MCP server
2. Call `create_extension` with the `dashboard-card` template
3. Verify the dashboard page shows the new card
4. Edit the extension's `index.ts` on disk
5. Call `reload_extensions`
6. Verify the dashboard card content updates
7. Introduce a syntax error in `index.ts`
8. Call `reload_extensions`, verify structured error in response
9. Fix the error, reload, verify recovery

---

## Performance Considerations

**Iteration speed budget:** The write-compile-reload-render cycle must complete in under 500ms on the explicit reload path. The budget breakdown:

| Phase                     | Budget     | Notes                                   |
| ------------------------- | ---------- | --------------------------------------- |
| esbuild compilation       | <20ms      | ~10ms typical for <300 line extensions  |
| Content-hash cache check  | <1ms       | SHA-256 of source string                |
| Server-side record update | <1ms       | In-memory map update                    |
| SSE event broadcast       | <5ms       | Express write to socket                 |
| Client SSE receive        | <200ms     | Network + EventSource delivery          |
| Dynamic import()          | <20ms      | Module parsing + evaluation             |
| Extension activation      | <10ms      | activate() call                         |
| React rerender            | <30ms      | DOM diff for affected slots             |
| **Total**                 | **<300ms** | Theoretical minimum ~85ms on warm cache |

**Compilation caching:** The content-hash cache (ADR-0202) is critical for iteration speed. When the agent calls `reload_extensions` without changing any files, the compile step returns in <1ms (cache hit). When the agent changes a file, only the changed extension is recompiled (~10ms).

**Per-extension reload:** Only the changed extension goes through the deactivate-recompile-reactivate cycle. Unmodified extensions are untouched. This preserves state in working extensions and keeps the reload fast regardless of how many extensions are installed.

**SSE delivery:** The SSE event is a small JSON payload (<200 bytes). Delivery latency depends on the network path (local: ~1-5ms, tunnel: ~50-200ms). The `extension_reloaded` event carries only the extension IDs, not the bundle content -- the client fetches the bundle separately via HTTP.

---

## Security Considerations

**Model:** Full-trust (Obsidian model). Extensions run in the browser context with full React integration and DOM access. There is no sandbox, no iframe isolation, no permission system.

**Rationale:** The v1 audience is developers running their own agents on their own machines (Kai persona). The risk model is identical to Obsidian community plugins: you are running code you chose to install. Adding sandbox overhead (100-300ms rendering penalty from iframe/proxy approaches) provides zero security benefit for this audience.

**Scope as a safety measure:** Local extensions (default) are scoped to the working directory. They do not persist across projects. Global extensions require explicit `scope: 'global'` and affect all sessions.

**Future considerations:** If DorkOS expands to less-trusted extension sources (marketplace, sharing), the Grafana proxy-membrane model is the recommended upgrade path. The current architecture's clean `ExtensionAPI` interface makes this retrofit feasible without breaking extensions -- the API surface stays the same, only the implementation would be proxied.

---

## Documentation Updates

The following contributing guides need updates after implementation:

| Guide                           | Update                                                         |
| ------------------------------- | -------------------------------------------------------------- |
| `contributing/architecture.md`  | Add extension MCP tools to the MCP server architecture section |
| `contributing/api-reference.md` | Document the 6 new MCP tools with parameter schemas            |

A new section should be added to the external docs (`docs/`) covering:

- How agents build extensions (the MCP tool workflow)
- Available templates and their purposes
- The ExtensionAPI reference (matching `get_extension_api` output)
- Troubleshooting: common compilation errors and fixes

---

## Implementation Phases

### Phase 1: Core MCP Tools

New and changed files:

| File                                                                                        | Change                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts`                | **NEW** -- `createListExtensionsHandler`, `createCreateExtensionHandler`, `createReloadExtensionsHandler`, `createGetExtensionErrorsHandler` |
| `apps/server/src/services/runtimes/claude-code/mcp-tools/types.ts`                          | Add `extensionManager?: ExtensionManager` to `McpToolDeps`                                                                                   |
| `apps/server/src/services/core/mcp-server.ts`                                               | Import and register the 4 extension tools                                                                                                    |
| `apps/server/src/services/extensions/extension-manager.ts`                                  | Add `createExtension()` method, `reloadExtension()` method                                                                                   |
| `apps/server/src/services/runtimes/claude-code/mcp-tools/__tests__/extension-tools.test.ts` | **NEW** -- Unit tests for all 4 handlers                                                                                                     |
| `apps/server/src/services/extensions/__tests__/extension-manager-create.test.ts`            | **NEW** -- Tests for `createExtension()`                                                                                                     |

Deliverables: The core agent loop works end-to-end. Agent can list extensions, scaffold a new one, reload it, and read errors. Templates for all 3 types. Structured compilation errors in reload responses.

### Phase 2: Agent DX Improvements

New and changed files:

| File                                                                           | Change                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts`   | Add `createGetExtensionApiHandler`, `createTestExtensionHandler`                     |
| `apps/server/src/services/core/mcp-server.ts`                                  | Register `get_extension_api` and `test_extension` tools                              |
| `apps/server/src/services/extensions/extension-manager.ts`                     | Add `testExtension()` method, `MockExtensionAPI` class                               |
| `apps/client/src/layers/features/extensions/model/extension-context.tsx`       | Add SSE listener for `extension_reloaded`, per-extension hot reload                  |
| `apps/client/src/layers/features/extensions/model/extension-loader.ts`         | Add `reloadExtensions(ids)` method                                                   |
| `apps/server/src/routes/extensions.ts`                                         | Add `GET /api/extensions/events` SSE endpoint (or integrate into existing broadcast) |
| `apps/server/src/services/extensions/__tests__/extension-manager-test.test.ts` | **NEW** -- Tests for `testExtension()`                                               |

Deliverables: Agent can get the full API reference. Agent can smoke-test extensions without a browser. Client performs per-extension hot reload on SSE events.

### Phase 3: Polish (Optional)

| File                                                       | Change                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/server/src/services/extensions/extension-watcher.ts` | **NEW** -- chokidar v5 file watcher with 750ms per-extension debounce |
| `apps/server/src/services/extensions/extension-manager.ts` | Integrate watcher startup/shutdown                                    |

Deliverables: Automatic reload on file changes (no explicit `reload_extensions` call needed). 750ms per-extension debounce prevents mid-write triggers. Watcher coexists with explicit reload via shared `reloadExtension()` implementation.

---

## Acceptance Criteria

From the brief (preserved verbatim):

- [ ] `list_extensions` MCP tool returns all extensions with status and source
- [ ] `create_extension` MCP tool scaffolds a working extension that compiles and activates
- [ ] `create_extension` supports `scope: 'global' | 'local'` parameter
- [ ] `reload_extensions` MCP tool recompiles and reloads, returns per-extension structured results
- [ ] Compilation errors include file, line, column, message -- enough for the agent to fix
- [ ] Runtime activation errors include error type, message, stack trace
- [ ] ExtensionAPI type definitions accessible to the agent (via MCP tool)
- [ ] End-to-end workflow works: agent writes extension -> reload -> extension renders in correct slot
- [ ] Agent can iterate: edit extension -> reload -> see updated rendering
- [ ] Default scope is local (`.dork/extensions/` in active CWD)
- [ ] Agent can create a global extension by passing `scope: 'global'`
- [ ] Scaffolded extension includes ExtensionAPI usage examples in comments
- [ ] No new tools registered outside the MCP server boundary (no direct HTTP endpoints for agent use)

From the ideation (additional):

- [ ] `create_extension` supports `template` parameter with 3 slot-specific templates
- [ ] `get_extension_api` MCP tool returns full type definitions
- [ ] `test_extension` MCP tool performs headless smoke test and returns contributions map
- [ ] Per-extension hot reload: changing one extension does not affect others
- [ ] SSE `extension_reloaded` event notifies connected clients
- [ ] Agent iteration cycle completes in <500ms (explicit reload path)

---

## Related ADRs

- **ADR-0201** (`decisions/0201-extension-storage-separate-from-code.md`): Extension data at `{dorkHome}/extension-data/{ext-id}/data.json`, separate from code directories. Relevant to `create_extension` not conflating code and data paths.
- **ADR-0202** (`decisions/0202-esbuild-content-hash-compilation-cache.md`): SHA-256 content hash caching at `{dorkHome}/cache/extensions/`. Critical for iteration speed -- cache hits return in <1ms.
- **ADR-0203** (`decisions/0203-extension-api-includes-ui-control-for-phase-4.md`): UI control methods (`executeCommand`, `openCanvas`, `navigate`) included in v1 ExtensionAPI. Enables agent-built extensions to control the UI without an API version bump.

---

## References

- `specs/ext-platform-04-agent-extensions/00-brief.md` -- Original Phase 4 brief
- `specs/ext-platform-04-agent-extensions/01-ideation.md` -- Ideation with all decisions
- `specs/ext-platform-03-extension-system/02-specification.md` -- Phase 3 specification (foundation)
- `research/20260326_agent_built_extensions_phase4.md` -- Deep research on all 7 open questions
- `research/20260323_plugin_extension_ui_architecture_patterns.md` -- Obsidian/VSCode architecture patterns
- `research/20260326_extension_system_open_questions.md` -- Extension system design research
- `apps/server/src/services/extensions/extension-manager.ts` -- Current ExtensionManager implementation
- `apps/server/src/services/extensions/extension-compiler.ts` -- Current compilation service
- `apps/server/src/services/core/mcp-server.ts` -- MCP tool registration hub
- `packages/extension-api/src/extension-api.ts` -- ExtensionAPI interface
