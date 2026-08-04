/**
 * Convert runtime-neutral {@link McpAppServerConnection} details into the shape
 * OpenCode's sidecar accepts on `POST /mcp` (`client.mcp.add`), so an agent's
 * enabled managed MCP servers (spec `mcp-server-management`) can be registered
 * into the live per-directory sidecar instance at turn time (DOR-893).
 *
 * This is the OpenCode-local analogue of the claude-code `toSdkMcpServers` and
 * codex `toCodexMcpServers` converters — deliberately NOT shared: OpenCode has
 * its own config schema (`McpLocalConfig` / `McpRemoteConfig`), and
 * `@opencode-ai/sdk` is ESLint-confined to this directory, so the SDK-shape
 * translation lives here.
 *
 * OpenCode speaks two MCP transports: `local` (stdio — a single `command`
 * array plus `environment`) and `remote` (streamable HTTP — `url` + `headers`).
 * It has NO SSE transport, so a neutral `sse` server cannot be honestly
 * registered and is skipped (surfaced via {@link OpenCodeMcpConversion.skipped}
 * for a diagnostic, never silently mismapped onto HTTP — mirrors codex).
 *
 * @module services/runtimes/opencode/mcp-server-config
 */
import type { McpLocalConfig, McpRemoteConfig } from '@opencode-ai/sdk';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';

/** One OpenCode MCP server config, the `config` body of `client.mcp.add`. */
export type OpenCodeMcpServerConfig = McpLocalConfig | McpRemoteConfig;

/**
 * Map one neutral connection to an OpenCode MCP config, or `null` when OpenCode
 * cannot run it (an `sse` connection — OpenCode has no SSE transport). Empty
 * `env`/`headers` are omitted so the body stays minimal. `enabled: true` is set
 * explicitly so the sidecar connects the server on registration.
 *
 * OpenCode's `local` transport takes ONE `command` array (executable followed by
 * its arguments), so the neutral `command` + `args` are concatenated.
 *
 * @param connection - The runtime-neutral managed-server connection.
 */
export function toOpenCodeMcpServerConfig(
  connection: McpAppServerConnection
): OpenCodeMcpServerConfig | null {
  switch (connection.transport) {
    case 'stdio':
      return {
        type: 'local',
        command: [connection.command, ...(connection.args ?? [])],
        ...(connection.env && Object.keys(connection.env).length > 0
          ? { environment: connection.env }
          : {}),
        enabled: true,
      };
    case 'http':
      return {
        type: 'remote',
        url: connection.url,
        ...(connection.headers && Object.keys(connection.headers).length > 0
          ? { headers: connection.headers }
          : {}),
        enabled: true,
      };
    case 'sse':
      return null;
  }
}

/** The result of converting an agent's managed servers to OpenCode config shape. */
export interface OpenCodeMcpConversion {
  /** Convertible servers, keyed by name, ready to register via `client.mcp.add`. */
  servers: Record<string, OpenCodeMcpServerConfig>;
  /** Names skipped because OpenCode has no matching transport (`sse`), for a one-line diagnostic. */
  skipped: string[];
}

/**
 * Convert a name → neutral-connection record (the enabled managed servers the
 * `AgentMcpServerService` resolved for a session cwd) into a name →
 * OpenCode-config record. `sse` servers land in
 * {@link OpenCodeMcpConversion.skipped} rather than the output — absence
 * withholds (safe-default), never a silent mismap.
 *
 * @param connections - Enabled managed servers by name, from the resolver.
 */
export function toOpenCodeMcpServers(
  connections: Record<string, McpAppServerConnection>
): OpenCodeMcpConversion {
  const servers: Record<string, OpenCodeMcpServerConfig> = {};
  const skipped: string[] = [];
  for (const [name, connection] of Object.entries(connections)) {
    const config = toOpenCodeMcpServerConfig(connection);
    if (config === null) {
      skipped.push(name);
      continue;
    }
    servers[name] = config;
  }
  return { servers, skipped };
}
