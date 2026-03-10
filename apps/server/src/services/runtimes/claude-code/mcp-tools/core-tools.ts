import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readManifest } from '@dorkos/shared/manifest';
import { env } from '../../../../env.js';
import { SERVER_VERSION } from '../../../../lib/version.js';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

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
 * Session count handler factory — returns the number of sessions from SDK transcripts.
 * Validates the dependency injection pattern needed for future service-dependent tools.
 */
export function createGetSessionCountHandler(deps: McpToolDeps) {
  return async function handleGetSessionCount() {
    try {
      const sessions = await deps.transcriptReader.listSessions(deps.defaultCwd);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              count: sessions.length,
              cwd: deps.defaultCwd,
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
 * Get the agent manifest for the current working directory.
 * Always available — not guarded by any feature flag.
 */
export function createGetCurrentAgentHandler(deps: McpToolDeps) {
  return async () => {
    try {
      const manifest = await readManifest(deps.defaultCwd);
      if (!manifest) {
        return jsonContent({ agent: null, message: 'No agent registered for current directory' });
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

/** Returns the core tool definitions for registration with the MCP server. */
export function getCoreTools(deps: McpToolDeps) {
  const handleGetSessionCount = createGetSessionCountHandler(deps);
  const handleGetCurrentAgent = createGetCurrentAgentHandler(deps);

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
      'Returns the number of sessions visible in the SDK transcript directory.',
      {},
      handleGetSessionCount
    ),
    tool(
      'get_current_agent',
      'Get the agent identity for the current working directory. Returns the agent manifest from .dork/agent.json if one exists, or null if no agent is registered.',
      {},
      handleGetCurrentAgent
    ),
  ];
}
