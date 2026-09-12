/**
 * How DorkOS builds the {@link CodexOptions} object every `codex exec` turn is
 * spawned with.
 *
 * Three concerns that only make sense together: which MCP servers the turn
 * carries, which environment it inherits, and the rule that keeps the two from
 * mixing — `config` becomes visible argv, so credentials go in `env` and only
 * their variable NAMES go in `config`.
 *
 * Lifted off `codex-runtime.ts` so that file stays under the repo's 500-line
 * ceiling; the runtime calls {@link buildCodexOptions} once per turn and owns
 * nothing about the shape of the options themselves.
 *
 * @module services/runtimes/codex/codex-options
 */
import { runtimeEnvironment } from '../shared/runtime-environment-config.js';
import type { CodexOptions } from '@openai/codex-sdk';
import { DORKOS_MCP_SERVER_NAME } from '../shared/dorkos-tool-names.js';
import { type DorkosMcpInjection } from '../shared/dorkos-mcp-injection.js';
import { dorkosHeaderEnv, dorkosHeaderEnvNames } from './dorkos-header-env.js';
import {
  CONNECTOR_RUNTIME_MCP_SERVER_NAME,
  type ConnectorRuntimeMcpInjection,
} from '../connector-tools.js';
import { connectorHeaderEnv, connectorHeaderEnvNames } from './connector-header-env.js';
import { type CodexManagedMcpServers, type CodexMcpServerRecord } from './mcp-server-config.js';

/**
 * Build the {@link CodexOptions} for the SDK `Codex` client.
 *
 * `codexPathOverride` is set whenever a binary path is given, and every DorkOS
 * caller now gives one ({@link CodexRuntime} resolves it through the shared
 * ladder first) — leaving it unset falls back to the SDK's own binary discovery,
 * which THROWS when it finds nothing rather than reporting it.
 * `config.mcp_servers` carries four contributors: the agent's enabled managed
 * servers (`managedServers`, spec `mcp-server-management`), the scoped
 * `dorkos_ui` bridge when a UI MCP URL is provided, and the `dorkos` tool server
 * when one is injected (`dorkosTools`, spec `tool-only-room-replies`), plus the
 * turn-bound connector server — see {@link buildMcpServersConfig} for the merge
 * and the shadowing guarantee.
 * `config` is omitted entirely when no source contributes a server.
 *
 * `CodexOptions.env` starts with the projected OS/runtime environment. Four
 * additional credential sources must travel only through environment values:
 * `extraEnv` (the agent's `DORKOS_AGENT_TOKEN`), the `dorkos` server's
 * turn-binding header values, and every HTTP header the agent's own
 * managed servers carry (DOR-993), plus the connector server's turn bearer and
 * context headers — all placed under the variable names their `env_http_headers`
 * entries point Codex at. Every launch receives a complete projected environment, including launches
 * with no MCP servers or extra variables. The SDK never falls back to ambient
 * inheritance. Header values are added only by their exact internal converters.
 *
 * @param binaryPath - Absolute path to the `codex` binary, or null/undefined
 * @param extraEnv - Extra environment entries for the `codex exec` subprocess
 *   (the agent's identity token). Omitted or empty contributes none.
 * @param managed - The agent's enabled managed MCP servers, already converted to
 *   Codex config shape: `servers` goes into `config`, `env` into the subprocess
 *   environment. Omitted or empty adds none.
 * @param dorkosTools - The resolved `dorkos` tool server, or null/undefined to
 *   inject none. Its URL goes into `config`; its header VALUES go into `env`,
 *   never into `config`, because `config` becomes visible argv.
 * @param connectorTools - Turn-bound connector-only server. Header values use
 *   the same environment indirection and never enter visible config arguments.
 */
export function buildCodexOptions(
  binaryPath?: string | null,
  extraEnv?: Record<string, string>,
  managed?: CodexManagedMcpServers,
  dorkosTools?: DorkosMcpInjection | null,
  connectorTools?: ConnectorRuntimeMcpInjection | null
): CodexOptions {
  // Header converters mint names and values together. Validate the dynamic map
  // against those exact config references before adding it to the projected env.
  const headerNames = new Set(
    Object.values(managed?.servers ?? {}).flatMap((server) =>
      Object.values(
        (server as { env_http_headers?: Record<string, string> }).env_http_headers ?? {}
      )
    )
  );
  for (const name of Object.keys(managed?.env ?? {})) {
    if (!name.startsWith('DORKOS_MCP_HDR_') || !headerNames.has(name)) {
      throw new Error('Invalid managed MCP header environment.');
    }
  }
  const env = {
    ...runtimeEnvironment('codex', 'turn', extraEnv),
    ...(managed?.env ?? {}),
    ...dorkosHeaderEnv(dorkosTools),
    ...connectorHeaderEnv(connectorTools),
  };
  const mcpServers = buildMcpServersConfig(managed?.servers, dorkosTools, connectorTools);
  return {
    ...(binaryPath ? { codexPathOverride: binaryPath } : {}),
    ...(mcpServers ? { config: { mcp_servers: mcpServers } } : {}),
    env,
  };
}

/**
 * Merge the agent's managed MCP servers with the two servers DorkOS owns — the
 * `dorkos` tool server and the turn-bound connector server — into one
 * `mcp_servers` config record, or `undefined` when none contributes.
 *
 * There used to be a third, a scoped `dorkos_ui` bridge carrying one stubbed
 * copy of `control_ui`. It is retired: `control_ui` is a `ui` capability now and
 * reaches Codex on the `dorkos` server below, with a real session behind it
 * (spec `canvas-agent-seat` §5).
 *
 * All DorkOS entries are written LAST, so a managed server can never shadow
 * any of them whatever its name — the same ordering guarantee the claude-code
 * adapter's `mergeSessionMcpServers` gives, and defense in depth on top of the
 * converter already dropping (and now reporting) the reserved names.
 *
 * The `dorkos` entry is streamable HTTP carrying the bound authorization,
 * runtime, and cwd headers. It names them by environment variable rather than
 * value, the same rule the managed-server converter follows for every header it
 * maps. Codex's MCP client sends no browser origin, which the loopback listener
 * accepts after authenticating the turn.
 *
 * @param managedServers - Enabled managed servers in Codex config shape.
 * @param dorkosTools - The resolved `dorkos` entry, or null/undefined to inject none.
 * @param connectorTools - Turn-bound connector-only entry, when available.
 */
function buildMcpServersConfig(
  managedServers?: CodexMcpServerRecord,
  dorkosTools?: DorkosMcpInjection | null,
  connectorTools?: ConnectorRuntimeMcpInjection | null
): CodexMcpServerRecord | undefined {
  const servers: CodexMcpServerRecord = { ...(managedServers ?? {}) };
  if (dorkosTools) {
    servers[DORKOS_MCP_SERVER_NAME] = {
      url: dorkosTools.url,
      // `env_http_headers`, never `http_headers`. This config object is
      // flattened into `--config key=value` arguments on the `codex exec`
      // command line, so a value written here lands in the spawned argv, where
      // any process running as this user can read it with `ps`. The authorization
      // bearer is a credential; the runtime and cwd headers bind it to this
      // adapter and directory. The config therefore carries only the NAMES of
      // the environment variables holding all three, and Codex resolves their
      // values inside the subprocess. `buildCodexOptions` puts them there.
      env_http_headers: dorkosHeaderEnvNames(dorkosTools),
    };
  }
  if (connectorTools) {
    servers[CONNECTOR_RUNTIME_MCP_SERVER_NAME] = {
      url: connectorTools.url,
      env_http_headers: connectorHeaderEnvNames(connectorTools),
    };
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}
