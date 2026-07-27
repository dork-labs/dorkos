/**
 * MCP tool handlers for agent workspace creation.
 *
 * @module services/runtimes/claude-code/mcp-tools/agent-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';
import { createAgentWorkspace, AgentCreationError } from '../../../core/agent-creator.js';

/**
 * Factory for the create_agent MCP tool handler.
 *
 * @param deps - MCP tool dependencies (uses meshCore for post-creation sync)
 */
export function createCreateAgentHandler(deps: McpToolDeps) {
  return async (args: {
    name: string;
    directory?: string;
    description?: string;
    runtime?: string;
  }) => {
    try {
      const result = await createAgentWorkspace(args, deps.meshCore);
      return jsonContent(result.manifest);
    } catch (err) {
      if (err instanceof AgentCreationError) {
        return jsonContent({ error: err.message, code: err.code }, true);
      }
      const message = err instanceof Error ? err.message : 'Agent creation failed';
      return jsonContent({ error: message }, true);
    }
  };
}

/**
 * The agent tool definitions: name, description, input schema, and handler.
 *
 * The single source for all of that on BOTH MCP servers — the external `/mcp`
 * server projects these through `registerFromDefinitions` rather than typing them
 * out again (DOR-499). Unguarded, so it needs no separate definitions function.
 *
 * @param deps - Shared MCP tool dependencies.
 */
export function getAgentTools(deps: McpToolDeps) {
  return [
    tool(
      'create_agent',
      'Create a new DorkOS agent workspace with scaffolded config files',
      {
        name: z.string().describe('Agent name (kebab-case, e.g. my-agent)'),
        directory: z.string().optional().describe('Optional workspace directory path'),
        description: z.string().optional().describe('Optional agent description'),
        runtime: z.string().optional().describe('Agent runtime (default: claude-code)'),
      },
      createCreateAgentHandler(deps)
    ),
  ];
}
