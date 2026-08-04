/**
 * Convert runtime-neutral {@link McpAppServerConnection} details into the
 * Claude Agent SDK's `McpServerConfig` shape, so connector tool servers (which
 * the provider-neutral connector layer produces without any SDK type) can be
 * folded into the claude-code `setMcpServerFactory` record.
 *
 * This is the inverse of `toMcpAppConnection` in `messaging/message-sender.ts`
 * and lives inside the SDK import boundary (ESLint confines
 * `@anthropic-ai/claude-agent-sdk` to `services/runtimes/claude-code/`): the
 * connector service stays SDK-agnostic and hands off neutral shapes; the
 * translation to the SDK config union happens here.
 *
 * @module services/runtimes/claude-code/mcp-server-config
 */
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';

/**
 * Map one neutral connection to the SDK's serializable server config. Only the
 * transport discriminant differs (`transport` → `type`); the remote/stdio
 * fields carry over unchanged.
 *
 * @param connection - The runtime-neutral connection resolved by a connector provider.
 */
export function toSdkMcpServerConfig(connection: McpAppServerConnection): McpServerConfig {
  switch (connection.transport) {
    case 'http':
      return { type: 'http', url: connection.url, headers: connection.headers };
    case 'sse':
      return { type: 'sse', url: connection.url, headers: connection.headers };
    case 'stdio':
      return {
        type: 'stdio',
        command: connection.command,
        args: connection.args,
        env: connection.env,
      };
  }
}

/**
 * Convert a name → neutral-connection record (as assembled per session by the
 * connector service) into a name → SDK-config record ready to spread into the
 * `setMcpServerFactory` result. Server names are preserved verbatim — they
 * carry only toolkit + label, never a provider identity.
 *
 * @param connections - The per-session connector tool servers, keyed by server name.
 */
export function toSdkMcpServers(
  connections: Record<string, McpAppServerConnection>
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, connection] of Object.entries(connections)) {
    out[name] = toSdkMcpServerConfig(connection);
  }
  return out;
}

/** The three sources of a claude-code session's MCP tool servers, pre-converted to SDK shape. */
export interface SessionMcpServerSources {
  /** The agent's enabled managed servers (spec `mcp-server-management` §6). */
  managed: Record<string, McpServerConfig>;
  /** The accounts explicitly attached to this session (connector session-exposure). */
  connectors: Record<string, McpServerConfig>;
  /** The DorkOS tool server — always present, and it must never be shadowed. */
  dorkos: McpServerConfig;
}

/**
 * Merge a session's MCP tool servers with the ordering the trust model depends
 * on: managed servers first, connectors second, and the DorkOS tool server LAST.
 *
 * Because later keys win in an object spread and `dorkos` is written as an
 * explicit final property, neither a managed nor a connector server — whatever
 * its name — can shadow `dorkos` (spec `mcp-server-management` §6; `mcp.add` also
 * rejects the reserved name). A managed↔connector name clash resolves to the
 * connector, the documented edge for two user-controlled sources.
 *
 * @param sources - The managed, connector, and dorkos servers for one session.
 * @returns The merged name → SDK-config record for `setMcpServerFactory`.
 */
export function mergeSessionMcpServers(
  sources: SessionMcpServerSources
): Record<string, McpServerConfig> {
  return { ...sources.managed, ...sources.connectors, dorkos: sources.dorkos };
}
