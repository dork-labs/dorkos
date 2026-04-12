import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';
import { broadcastExtensionReloaded } from '../../../../routes/extensions.js';

/**
 * Full ExtensionAPI reference as markdown with TypeScript code blocks.
 *
 * This is a static string — not dynamically read from disk. It must be updated
 * when the `ExtensionAPI` interface in `packages/extension-api/` changes.
 */
const EXTENSION_API_REFERENCE = `# DorkOS Extension API Reference

## Client-Side: ExtensionModule Interface

Your extension must export an \`activate\` function:

\`\`\`typescript
import type { ExtensionAPI } from '@dorkos/extension-api';

export function activate(api: ExtensionAPI): void | (() => void) {
  // Register contributions, return optional cleanup function
}
\`\`\`

## ExtensionAPI Interface

\`\`\`typescript
interface ExtensionAPI {
  readonly id: string;

  // --- UI Contributions ---
  registerComponent(slot: ExtensionPointId, id: string, component: ComponentType, options?: { priority?: number }): () => void;
  registerCommand(id: string, label: string, callback: () => void, options?: { icon?: string; shortcut?: string }): () => void;
  registerDialog(id: string, component: ComponentType): { open: () => void; close: () => void };
  registerSettingsTab(id: string, label: string, component: ComponentType): () => void;

  // --- UI Control ---
  executeCommand(command: UiCommand): void;
  openCanvas(content: UiCanvasContent): void;
  navigate(path: string): void;

  // --- State ---
  getState(): ExtensionReadableState;
  subscribe(selector: (state: ExtensionReadableState) => unknown, callback: (value: unknown) => void): () => void;

  // --- Storage ---
  loadData<T>(): Promise<T | null>;
  saveData<T>(data: T): Promise<void>;

  // --- Notifications ---
  notify(message: string, options?: { type?: 'info' | 'success' | 'error' }): void;

  // --- Context ---
  isSlotAvailable(slot: ExtensionPointId): boolean;
}
\`\`\`

## ExtensionPointId (Available Slots)

\`\`\`typescript
type ExtensionPointId =
  | 'sidebar.footer'
  | 'sidebar.tabs'
  | 'dashboard.sections'
  | 'header.actions'
  | 'command-palette.items'
  | 'dialog'
  | 'settings.tabs'
  | 'right-panel';
\`\`\`

## ExtensionReadableState

\`\`\`typescript
interface ExtensionReadableState {
  currentCwd: string | null;
  activeSessionId: string | null;
  agentId: string | null;
}
\`\`\`

## Usage Examples

### Dashboard Section
\`\`\`typescript
export function activate(api: ExtensionAPI) {
  api.registerComponent('dashboard.sections', 'my-section', MyComponent, { priority: 50 });
}
\`\`\`

### Command Palette Item
\`\`\`typescript
export function activate(api: ExtensionAPI) {
  api.registerCommand('greet', 'Say Hello', () => {
    api.notify('Hello from my extension!', { type: 'success' });
  });
}
\`\`\`

### Settings Tab with Persistence
\`\`\`typescript
export function activate(api: ExtensionAPI) {
  api.registerSettingsTab('config', 'My Settings', MySettingsPanel);
}
\`\`\`

### Storage
\`\`\`typescript
const data = await api.loadData<{ count: number }>();
await api.saveData({ count: (data?.count ?? 0) + 1 });
\`\`\`

## Server-Side: DataProviderContext

Extensions with server-side capabilities export a \`register\` function from \`server.ts\`:

\`\`\`typescript
import type { ServerExtensionRegister } from '@dorkos/extension-api/server';

const register: ServerExtensionRegister = (router, ctx) => {
  router.get('/data', async (req, res) => {
    const apiKey = await ctx.secrets.get('my_api_key');
    res.json({ data: 'from server' });
  });
};

export default register;
\`\`\`

### DataProviderContext Interface

\`\`\`typescript
interface DataProviderContext {
  readonly secrets: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    has(key: string): Promise<boolean>;
  };
  readonly storage: {
    loadData<T>(): Promise<T | null>;
    saveData<T>(data: T): Promise<void>;
  };
  schedule(intervalSeconds: number, fn: () => Promise<void>): () => void;
  emit(event: string, data: unknown): void;
  readonly extensionId: string;
  readonly extensionDir: string;
}
\`\`\`

### Manifest: serverCapabilities

\`\`\`json
{
  "serverCapabilities": {
    "serverEntry": "./server.ts",
    "externalHosts": ["https://api.example.com"],
    "secrets": [
      { "key": "api_key", "label": "API Key", "required": true }
    ]
  }
}
\`\`\`

### Manifest: dataProxy (zero-code proxy)

\`\`\`json
{
  "dataProxy": {
    "baseUrl": "https://api.example.com",
    "authHeader": "Authorization",
    "authType": "Bearer",
    "authSecret": "api_key"
  }
}
\`\`\`

Proxy routes are auto-mounted at \`/api/ext/{id}/proxy/*\`.
`;

/**
 * Guard that returns the ExtensionManager if available, or null if not.
 * Callers must check for null and return an appropriate error response.
 */
function requireExtensionManager(deps: McpToolDeps) {
  if (!deps.extensionManager) {
    return null;
  }
  return deps.extensionManager;
}

/**
 * Handler factory for `list_extensions` — lists all discovered extensions
 * with their status, scope, bundle readiness, and any errors.
 *
 * The `path` field is intentionally excluded from the response to avoid
 * exposing server-internal filesystem details to agents.
 */
export function createListExtensionsHandler(deps: McpToolDeps) {
  return async () => {
    const manager = requireExtensionManager(deps);
    if (!manager) {
      return jsonContent({ error: 'Extension system is not available' }, true);
    }
    const extensions = manager.listPublic().map((ext) => ({
      id: ext.id,
      name: ext.manifest.name,
      version: ext.manifest.version,
      status: ext.status,
      scope: ext.scope,
      bundleReady: ext.bundleReady,
      hasServerEntry: ext.hasServerEntry,
      hasDataProxy: ext.hasDataProxy,
      serverStatus: manager.getServerRouter(ext.id) ? ('active' as const) : ('inactive' as const),
      ...(ext.manifest.description && { description: ext.manifest.description }),
      ...(ext.error && { error: ext.error }),
    }));
    return jsonContent({ extensions, count: extensions.length });
  };
}

/** Error statuses that indicate an extension has a problem. */
const ERROR_STATUSES = new Set(['invalid', 'incompatible', 'compile_error', 'activate_error']);

/**
 * Handler factory for `get_extension_errors` — returns only extensions
 * that are in an error state (invalid, incompatible, compile_error, activate_error).
 *
 * Useful for agents diagnosing extension problems without sifting through
 * healthy extensions in the full list.
 */
export function createGetExtensionErrorsHandler(deps: McpToolDeps) {
  return async () => {
    const manager = requireExtensionManager(deps);
    if (!manager) {
      return jsonContent({ error: 'Extension system is not available' }, true);
    }
    const errors = manager
      .listPublic()
      .filter((ext) => ERROR_STATUSES.has(ext.status))
      .map((ext) => ({
        id: ext.id,
        name: ext.manifest.name,
        version: ext.manifest.version,
        status: ext.status,
        scope: ext.scope,
        ...(ext.manifest.description && { description: ext.manifest.description }),
        ...(ext.error && { error: ext.error }),
      }));
    return jsonContent({ errors, count: errors.length });
  };
}

/**
 * Handler factory for `get_extension_api` — returns the full ExtensionAPI
 * type definitions and usage examples as text.
 *
 * Does not require `extensionManager` to be initialized — the API reference
 * is always available regardless of extension system state.
 */
export function createGetExtensionApiHandler(_deps: McpToolDeps) {
  return async () => {
    return {
      content: [{ type: 'text' as const, text: EXTENSION_API_REFERENCE }],
    };
  };
}

/**
 * Handler factory for `reload_extensions` — re-scans the filesystem and
 * recompiles changed extensions.
 *
 * When `id` is provided, performs a targeted hot-reload of a single extension
 * (recompile only). When omitted, runs a full discovery + recompile cycle
 * across both global and local extension directories.
 *
 * @param deps - Shared MCP tool dependencies
 */
export function createReloadExtensionsHandler(deps: McpToolDeps) {
  return async (args: { id?: string }) => {
    const manager = requireExtensionManager(deps);
    if (!manager) {
      return jsonContent({ error: 'Extension system is not available' }, true);
    }

    try {
      if (args.id) {
        const result = await manager.reloadExtension(args.id);

        // Broadcast SSE event only for successful compilations
        if (result.status === 'compiled') {
          broadcastExtensionReloaded([result.id]);
        }

        return jsonContent({ ok: true, extension: result });
      }

      const extensions = await manager.reload();

      // Broadcast SSE event for all successfully compiled extensions
      const compiledIds = extensions.filter((ext) => ext.bundleReady).map((ext) => ext.id);
      if (compiledIds.length > 0) {
        broadcastExtensionReloaded(compiledIds);
      }

      return jsonContent({ ok: true, extensions, count: extensions.length });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Reload failed';
      return jsonContent({ error: message, code: 'RELOAD_FAILED' }, true);
    }
  };
}

/**
 * Handler factory for `create_extension` — scaffolds a new extension with
 * manifest, starter code, compiles, and enables it in one step.
 *
 * @param deps - Shared MCP tool dependencies
 */
export function createCreateExtensionHandler(deps: McpToolDeps) {
  return async (args: {
    name: string;
    description?: string;
    template?: string;
    scope?: string;
  }) => {
    const manager = requireExtensionManager(deps);
    if (!manager) {
      return jsonContent({ error: 'Extension system is not available' }, true);
    }

    const template = (args.template ?? 'dashboard-card') as
      | 'dashboard-card'
      | 'command'
      | 'settings-panel'
      | 'data-provider';
    const scope = (args.scope ?? 'global') as 'global' | 'local';

    try {
      const result = await manager.createExtension({
        name: args.name,
        description: args.description,
        template,
        scope,
      });
      return jsonContent(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Extension creation failed';
      return jsonContent({ error: message }, true);
    }
  };
}

/**
 * Handler factory for `test_extension` — compiles an extension and activates
 * it against a mock API to verify it loads without errors.
 *
 * Returns contribution counts per slot on success, or detailed error
 * information (phase, error messages, stack trace) on failure.
 *
 * @param deps - Shared MCP tool dependencies
 */
export function createTestExtensionHandler(deps: McpToolDeps) {
  return async (args: { id: string }) => {
    const manager = requireExtensionManager(deps);
    if (!manager) {
      return jsonContent({ error: 'Extension system is not available' }, true);
    }

    try {
      const result = await manager.testExtension(args.id);

      // Test server-side compilation if the extension has a server entry
      const serverCompileStatus = await manager.testServerCompilation(args.id);

      const enriched = {
        ...result,
        ...(serverCompileStatus != null && { serverCompileStatus }),
      };

      return jsonContent(enriched, result.status === 'error');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Test failed';
      return jsonContent({ error: message, code: 'TEST_FAILED' }, true);
    }
  };
}

/** Returns the extension tool definitions. `get_extension_api` is always available; others require extensionManager. */
export function getExtensionTools(deps: McpToolDeps) {
  if (!deps.extensionManager) {
    // get_extension_api is always available — the API reference is useful
    // even when the extension system is not initialized
    return [
      tool(
        'get_extension_api',
        'Get the full ExtensionAPI type definitions and usage examples for both client-side and server-side extension development. Returns TypeScript interface definitions for ExtensionAPI, ExtensionPointId, ExtensionReadableState, DataProviderContext, and ServerExtensionRegister.',
        {},
        createGetExtensionApiHandler(deps)
      ),
    ];
  }

  return [
    tool(
      'get_extension_api',
      'Get the full ExtensionAPI type definitions and usage examples for both client-side and server-side extension development. Returns TypeScript interface definitions for ExtensionAPI, ExtensionPointId, ExtensionReadableState, DataProviderContext, and ServerExtensionRegister.',
      {},
      createGetExtensionApiHandler(deps)
    ),
    tool(
      'list_extensions',
      'List all discovered DorkOS extensions with their status, scope, server capabilities, and errors. Returns both global (~/.dork/extensions/) and local (.dork/extensions/ in active CWD) extensions. Includes hasServerEntry, hasDataProxy, and serverStatus fields.',
      {},
      createListExtensionsHandler(deps)
    ),
    tool(
      'get_extension_errors',
      'Get only extensions in an error state (invalid manifest, incompatible version, compile error, or activation failure). Returns error details for diagnosis.',
      {},
      createGetExtensionErrorsHandler(deps)
    ),
    tool(
      'create_extension',
      'Scaffold a new DorkOS extension with manifest and starter code. Creates the directory, writes extension.json and index.ts, compiles, and enables the extension in one step.',
      {
        name: z.string().describe('Extension name (kebab-case, e.g. my-dashboard-widget)'),
        description: z.string().optional().describe('Short description shown in settings UI'),
        template: z
          .enum(['dashboard-card', 'command', 'settings-panel', 'data-provider'])
          .optional()
          .describe(
            'Starter template (default: dashboard-card). Use data-provider for extensions with server-side API integration.'
          ),
        scope: z
          .enum(['global', 'local'])
          .optional()
          .describe(
            'Install scope: global (~/.dork/extensions/) or local (.dork/extensions/ in CWD). Default: global'
          ),
      },
      createCreateExtensionHandler(deps)
    ),
    tool(
      'reload_extensions',
      'Re-scan the filesystem for extensions and recompile any that changed. When id is provided, performs a targeted hot-reload of a single extension (recompile only). When omitted, runs a full discovery + recompile cycle.',
      {
        id: z.string().optional().describe('Extension ID for targeted reload. Omit to reload all.'),
      },
      createReloadExtensionsHandler(deps)
    ),
    tool(
      'test_extension',
      'Compile an extension and activate it against a mock API to verify it loads without errors. Returns contribution counts per UI slot on success, or detailed error information (phase, messages, stack trace) on failure. Also tests server-side compilation when the extension has a server entry. Use after editing extension source to validate before enabling.',
      {
        id: z.string().describe('Extension ID to test'),
      },
      createTestExtensionHandler(deps)
    ),
  ];
}
