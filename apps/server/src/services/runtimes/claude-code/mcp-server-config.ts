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
