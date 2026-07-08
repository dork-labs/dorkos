/**
 * Registers the `binding_*` external MCP tools against a live `McpServer`
 * instance. Split out of `mcp-server.ts` — see `core-tools.ts` in this
 * directory for why.
 *
 * @module services/core/external-mcp/binding-tools
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import {
  createBindingListHandler,
  createBindingCreateHandler,
  createBindingDeleteHandler,
} from '../../runtimes/claude-code/mcp-tools/binding-tools.js';
import { ToolAnnotationPresets } from '../mcp-tool-metadata.js';

const A = ToolAnnotationPresets;

/**
 * Register `binding_list`, `binding_create`, and `binding_delete` against
 * `server`.
 *
 * @param server - The external `McpServer` instance to register tools against.
 * @param deps - Shared MCP tool dependencies.
 */
export function registerBindingTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    'binding_list',
    {
      description: 'List all adapter-to-agent bindings.',
      inputSchema: {},
      annotations: A.readOnlyLocal,
    },
    createBindingListHandler(deps)
  );
  server.registerTool(
    'binding_create',
    {
      description:
        'Create a new adapter-to-agent binding. Maps an external adapter to a specific agent directory.',
      inputSchema: {
        adapterId: z.string().describe('ID of the adapter to bind'),
        agentId: z.string().describe('Agent ID to route messages to'),
        sessionStrategy: z
          .string()
          .optional()
          .describe('Session strategy: per-chat, per-user, or stateless (default per-chat)'),
        chatId: z.string().optional().describe('Optional chat ID for targeted routing'),
        channelType: z
          .string()
          .optional()
          .describe('Optional channel type filter: dm, group, channel, or thread'),
        label: z.string().optional().describe('Optional human-readable label for this binding'),
      },
      annotations: A.mutateCreateLocal,
    },
    createBindingCreateHandler(deps)
  );
  server.registerTool(
    'binding_delete',
    {
      description: 'Delete an adapter-to-agent binding by ID.',
      inputSchema: {
        id: z.string().describe('Binding UUID to delete'),
      },
      annotations: A.mutateDeleteLocal,
    },
    createBindingDeleteHandler(deps)
  );
}
