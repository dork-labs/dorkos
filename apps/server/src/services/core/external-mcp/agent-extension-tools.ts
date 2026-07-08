/**
 * Registers `create_agent` and the `*_extension(s)` external MCP tools
 * against a live `McpServer` instance. Split out of `mcp-server.ts` — see
 * `core-tools.ts` in this directory for why. Grouped together (rather than
 * one file each) since `create_agent` is a single tool.
 *
 * @module services/core/external-mcp/agent-extension-tools
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { createCreateAgentHandler } from '../../runtimes/claude-code/mcp-tools/agent-tools.js';
import {
  createListExtensionsHandler,
  createGetExtensionErrorsHandler,
  createGetExtensionApiHandler,
  createCreateExtensionHandler,
  createReloadExtensionsHandler,
  createTestExtensionHandler,
} from '../../runtimes/claude-code/mcp-tools/extension-tools.js';
import { ToolAnnotationPresets } from '../mcp-tool-metadata.js';

const A = ToolAnnotationPresets;

/**
 * Register `create_agent` and every `*_extension(s)` tool (7 total) against
 * `server`.
 *
 * @param server - The external `McpServer` instance to register tools against.
 * @param deps - Shared MCP tool dependencies.
 */
export function registerAgentAndExtensionTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    'create_agent',
    {
      description: 'Create a new DorkOS agent workspace with scaffolded config files',
      inputSchema: {
        name: z.string().describe('Agent name (kebab-case, e.g. my-agent)'),
        directory: z.string().optional().describe('Optional workspace directory path'),
        description: z.string().optional().describe('Optional agent description'),
        runtime: z.string().optional().describe('Agent runtime (default: claude-code)'),
      },
      annotations: A.mutateCreateLocal,
    },
    createCreateAgentHandler(deps)
  );

  server.registerTool(
    'get_extension_api',
    {
      description:
        'Get the full ExtensionAPI type definitions and usage examples. Call this when writing or debugging an extension to understand the available API surface. Returns TypeScript interface definitions for ExtensionAPI, ExtensionPointId, ExtensionReadableState, and ExtensionModule.',
      inputSchema: {},
      annotations: A.readOnlyLocal,
    },
    createGetExtensionApiHandler(deps)
  );
  server.registerTool(
    'list_extensions',
    {
      description:
        'List all discovered DorkOS extensions with their status, scope, and errors. Returns both global (~/.dork/extensions/) and local (.dork/extensions/ in active CWD) extensions.',
      inputSchema: {},
      annotations: A.readOnlyLocal,
    },
    createListExtensionsHandler(deps)
  );
  server.registerTool(
    'get_extension_errors',
    {
      description:
        'Get only extensions in an error state (invalid manifest, incompatible version, compile error, or activation failure). Returns error details for diagnosis.',
      inputSchema: {},
      annotations: A.readOnlyLocal,
    },
    createGetExtensionErrorsHandler(deps)
  );
  server.registerTool(
    'create_extension',
    {
      description:
        'Scaffold a new DorkOS extension with manifest and starter code. Creates the directory, writes extension.json and index.ts, compiles, and enables the extension in one step.',
      inputSchema: {
        name: z.string().describe('Extension name (kebab-case, e.g. my-dashboard-widget)'),
        description: z.string().optional().describe('Short description shown in settings UI'),
        template: z
          .enum(['dashboard-card', 'command', 'settings-panel'])
          .optional()
          .describe('Starter template (default: dashboard-card)'),
        scope: z
          .enum(['global', 'local'])
          .optional()
          .describe(
            'Install scope: global (~/.dork/extensions/) or local (.dork/extensions/ in CWD). Default: global'
          ),
      },
      annotations: A.mutateCreateLocal,
    },
    createCreateExtensionHandler(deps)
  );
  server.registerTool(
    'reload_extensions',
    {
      description:
        'Re-scan the filesystem for extensions and recompile any that changed. When id is provided, performs a targeted hot-reload of a single extension (recompile only). When omitted, runs a full discovery + recompile cycle.',
      inputSchema: {
        id: z.string().optional().describe('Extension ID for targeted reload. Omit to reload all.'),
      },
      annotations: A.mutateUpdateLocal,
    },
    createReloadExtensionsHandler(deps)
  );
  server.registerTool(
    'test_extension',
    {
      description:
        'Compile an extension and activate it against a mock API to verify it loads without errors. Returns contribution counts per UI slot on success, or detailed error information on failure.',
      inputSchema: {
        id: z.string().describe('Extension ID to test'),
      },
      annotations: A.mutateUpdateLocal,
    },
    createTestExtensionHandler(deps)
  );
}
