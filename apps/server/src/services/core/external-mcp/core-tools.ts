/**
 * Registers the core external MCP tools (`ping`, `get_server_info`,
 * `get_session_count`, `get_agent`) against a live `McpServer` instance.
 *
 * Split out of `mcp-server.ts` purely to keep that file's tool-registration
 * bulk under the repo's file-size guidance — see `.claude/rules/conventions.md`.
 *
 * @module services/core/external-mcp/core-tools
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import {
  handlePing,
  handleGetServerInfo,
  createGetSessionCountHandler,
  createGetAgentHandler,
} from '../../runtimes/claude-code/mcp-tools/core-tools.js';
import { ToolAnnotationPresets } from '../mcp-tool-metadata.js';

const A = ToolAnnotationPresets;

/** `outputSchema` for `get_agent` — mirrors both its null and hit success shapes. */
const getAgentOutputSchema = {
  agent: AgentManifestSchema.nullable(),
  message: z.string().optional(),
};

/** Shared `agent_id` / `cwd` scope shape used by `get_session_count` and `get_agent`. */
const agentScopeSchema = {
  agent_id: z.string().optional().describe('Agent ULID to scope the query to'),
  cwd: z.string().optional().describe('Working directory path to scope the query to'),
};

/**
 * Register `ping`, `get_server_info`, `get_session_count`, and `get_agent`
 * against `server`.
 *
 * @param server - The external `McpServer` instance to register tools against.
 * @param deps - Shared MCP tool dependencies.
 */
export function registerCoreTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    'ping',
    {
      description: 'Check that the DorkOS server is running. Returns pong with a timestamp.',
      inputSchema: {},
      annotations: A.readOnlyLocal,
    },
    handlePing
  );
  server.registerTool(
    'get_server_info',
    {
      description: 'Returns DorkOS server metadata including version, port, and optionally uptime.',
      inputSchema: {
        include_uptime: z.boolean().optional().describe('Include server uptime in seconds'),
      },
      annotations: A.readOnlyLocal,
    },
    handleGetServerInfo
  );
  server.registerTool(
    'get_session_count',
    {
      description:
        'Returns the number of sessions for a specific agent. Provide either agent_id (ULID) or cwd (working directory path).',
      inputSchema: agentScopeSchema,
      annotations: A.readOnlyLocal,
    },
    createGetSessionCountHandler(deps)
  );
  server.registerTool(
    'get_agent',
    {
      description:
        'Get the agent manifest for a specific agent. Provide either agent_id (ULID) or cwd (working directory path). Returns the agent manifest from .dork/agent.json if one exists, or null if no agent is registered.',
      inputSchema: agentScopeSchema,
      annotations: A.readOnlyLocal,
      outputSchema: getAgentOutputSchema,
    },
    createGetAgentHandler(deps)
  );
}
