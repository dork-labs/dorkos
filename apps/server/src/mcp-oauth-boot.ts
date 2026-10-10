/**
 * Boot-time warming of the managed-MCP OAuth token cache (DOR-942), moved out of the server's
 * bootstrap unchanged.
 *
 * @module mcp-oauth-boot
 */
import type { MeshCore } from '@dorkos/mesh';
import type { AgentMcpOAuthService } from './services/mesh/agent-mcp-oauth-service.js';
import type { AgentMcpServerService } from './services/mesh/agent-mcp-server-service.js';

/**
 * Re-prime the managed-MCP OAuth token cache from disk on boot (DOR-942): for
 * every registered agent's enabled http/sse servers, hand the OAuth engine the
 * `(agentId, serverName, serverUrl)` targets so it can load any stored token and
 * schedule its background refresh. A server with no stored token is skipped by
 * the engine (stays needs-auth). Best-effort per agent — an unreadable manifest
 * for one agent never blocks warming the rest.
 *
 * @param oauth - The managed-MCP OAuth engine to warm.
 * @param service - The managed-server service that lists each agent's servers.
 * @param mesh - The mesh core whose registry enumerates the agents.
 */
export async function warmMcpOAuthTokens(
  oauth: AgentMcpOAuthService,
  service: AgentMcpServerService,
  mesh: MeshCore
): Promise<void> {
  const targets: { agentId: string; serverName: string; serverUrl: string }[] = [];
  for (const agent of mesh.agentRegistry.list()) {
    try {
      const servers = await service.list(agent.id);
      for (const s of servers) {
        if (s.enabled && s.connection.transport !== 'stdio') {
          targets.push({ agentId: agent.id, serverName: s.name, serverUrl: s.connection.url });
        }
      }
    } catch {
      // Unreadable/absent manifest for one agent: skip it, warm the others.
    }
  }
  await oauth.warm(targets);
}
