/** Agent-safe DorkOS capabilities projected onto the authenticated runtime listener. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentIdentity } from '../../core/agent-identity/index.js';
import type { CapabilityRegistry } from '../../core/capabilities/index.js';
import { registerCapabilitiesAsMcpTools } from '../../core/external-mcp/capability-mcp-tools.js';
import type { ServerPrincipalProof } from '../../connectors/principal/server-principal.js';
import { SERVER_VERSION } from '../../../lib/version.js';

/**
 * Build the DorkOS capability server for one authenticated runtime turn.
 *
 * Only capabilities explicitly marked for the existing `in-session` audience
 * are registered. Hand-written external MCP tools and external-only
 * capabilities never reach this boundary. The verified turn supplies every
 * caller fact; no header or tool argument can select another agent, session, or
 * directory.
 *
 * @param registry - Fully composed server capability registry.
 * @param principal - Turn-bound principal resolved by the loopback listener.
 * @param identity - Active agent identity resolved from the principal's path.
 * @returns MCP server whose handlers retain the authenticated turn context.
 */
export function createAgentRuntimeMcpServer(
  registry: CapabilityRegistry,
  principal: ServerPrincipalProof,
  identity: AgentIdentity
): McpServer {
  if (principal.claims.kind !== 'runtime') {
    throw new Error('Agent runtime tools require a runtime principal.');
  }

  const server = new McpServer({ name: 'dorkos', version: SERVER_VERSION });
  registerCapabilitiesAsMcpTools(server, registry, 'in-session', {
    identity,
    agentIdentityPresented: true,
    sessionId: principal.claims.canonicalSessionId,
    cwd: principal.claims.agentPath,
    serverPrincipal: principal,
  });
  return server;
}
