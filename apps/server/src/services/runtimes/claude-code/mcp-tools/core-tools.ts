import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readManifest } from '@dorkos/shared/manifest';
import { env } from '../../../../env.js';
import { SERVER_VERSION } from '../../../../lib/version.js';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/**
 * Resolve the agent working directory from either an `agent_id` or `cwd` argument.
 * Exactly one must be provided (mutually exclusive). Throws descriptive errors
 * when validation fails.
 *
 * @param deps - MCP tool dependencies (needs `meshCore` when resolving by agent_id)
 * @param args - The agent_id or cwd provided by the caller
 * @returns The resolved absolute working directory path
 */
export function resolveAgentCwd(
  deps: McpToolDeps,
  args: { agent_id?: string; cwd?: string }
): string {
  if (!args.agent_id && !args.cwd) {
    throw new Error('Either agent_id or cwd must be provided to identify the agent.');
  }
  if (args.agent_id && args.cwd) {
    throw new Error('Provide either agent_id or cwd, not both.');
  }
  if (args.cwd) {
    return args.cwd;
  }
  // agent_id path
  if (!deps.meshCore) {
    throw new Error('Mesh is not enabled. Cannot resolve agent_id without Mesh.');
  }
  const projectPath = deps.meshCore.getProjectPath(args.agent_id!);
  if (!projectPath) {
    throw new Error(`Agent not found: ${args.agent_id}`);
  }
  return projectPath;
}

/**
 * Ping handler — validates the MCP tool injection pipeline is working.
 * Returns a pong response with timestamp and server identifier.
 */
export async function handlePing() {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          status: 'pong',
          timestamp: new Date().toISOString(),
          server: 'dorkos',
        }),
      },
    ],
  };
}

/**
 * Server info handler — returns DorkOS server metadata.
 * Validates Zod optional fields and env var access from tool handlers.
 */
export async function handleGetServerInfo(args: { include_uptime?: boolean }) {
  const info: Record<string, unknown> = {
    product: 'DorkOS',
    port: env.DORKOS_PORT,
    version: SERVER_VERSION,
  };
  if (args.include_uptime) {
    info.uptime_seconds = Math.floor(process.uptime());
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(info, null, 2),
      },
    ],
  };
}

/**
 * Session count handler factory — returns the number of sessions for a specific agent.
 * Requires either `agent_id` (ULID) or `cwd` (working directory path) to scope the query.
 */
export function createGetSessionCountHandler(deps: McpToolDeps) {
  return async function handleGetSessionCount(args: { agent_id?: string; cwd?: string }) {
    try {
      const resolvedCwd = resolveAgentCwd(deps, args);
      const sessions = await deps.transcriptReader.listSessions(resolvedCwd);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              count: sessions.length,
              cwd: resolvedCwd,
              ...(args.agent_id && { agent_id: args.agent_id }),
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: err instanceof Error ? err.message : 'Failed to list sessions',
            }),
          },
        ],
        isError: true,
      };
    }
  };
}

/**
 * Get the agent manifest for a specific agent.
 * Requires either `agent_id` (ULID) or `cwd` (working directory path).
 * Always available — not guarded by any feature flag.
 */
export function createGetAgentHandler(deps: McpToolDeps) {
  return async (args: { agent_id?: string; cwd?: string }) => {
    try {
      const resolvedCwd = resolveAgentCwd(deps, args);
      const manifest = await readManifest(resolvedCwd);
      if (!manifest) {
        return jsonContent({
          agent: null,
          message: 'No agent registered for the specified directory',
        });
      }
      return jsonContent({ agent: manifest });
    } catch (err) {
      return jsonContent(
        { error: err instanceof Error ? err.message : 'Failed to read agent manifest' },
        true
      );
    }
  };
}

/** Zod schema for the agent_id / cwd parameter pair shared by scoped core tools. */
const agentScopeSchema = {
  agent_id: z.string().optional().describe('Agent ULID to scope the query to'),
  cwd: z.string().optional().describe('Working directory path to scope the query to'),
};

/** Returns the core tool definitions for registration with the MCP server. */
export function getCoreTools(deps: McpToolDeps) {
  const handleGetSessionCount = createGetSessionCountHandler(deps);
  const handleGetAgent = createGetAgentHandler(deps);

  return [
    tool(
      'ping',
      'Check that the DorkOS server MCP integration is working. Returns pong with a timestamp.',
      {},
      handlePing
    ),
    tool(
      'get_server_info',
      'Returns DorkOS server metadata including version, port, and optionally uptime.',
      { include_uptime: z.boolean().optional().describe('Include server uptime in seconds') },
      handleGetServerInfo
    ),
    tool(
      'get_session_count',
      'Returns the number of sessions for a specific agent. Provide either agent_id (ULID) or cwd (working directory path).',
      agentScopeSchema,
      handleGetSessionCount
    ),
    tool(
      'get_agent',
      'Get the agent manifest for a specific agent. Provide either agent_id (ULID) or cwd (working directory path). Returns the agent manifest from .dork/agent.json if one exists, or null if no agent is registered.',
      agentScopeSchema,
      handleGetAgent
    ),
  ];
}
