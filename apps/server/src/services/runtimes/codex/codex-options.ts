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
import type { CodexOptions } from '@openai/codex-sdk';
import { CODEX_UI_MCP_SERVER } from './codex-ui-mcp-server.js';
import { DORKOS_MCP_SERVER_NAME } from '../shared/dorkos-tool-names.js';
import { type DorkosMcpInjection } from '../shared/dorkos-mcp-injection.js';
import { dorkosHeaderEnv, dorkosHeaderEnvNames } from './dorkos-header-env.js';
import { type CodexMcpServerRecord } from './mcp-server-config.js';

/**
 * Build the {@link CodexOptions} for the SDK `Codex` client.
 *
 * `codexPathOverride` is set whenever a binary path is given, and every DorkOS
 * caller now gives one ({@link CodexRuntime} resolves it through the shared
 * ladder first) — leaving it unset falls back to the SDK's own binary discovery,
 * which THROWS when it finds nothing rather than reporting it.
 * `config.mcp_servers` carries three contributors: the agent's enabled managed
 * servers (`managedServers`, spec `mcp-server-management`), the scoped
 * `dorkos_ui` bridge when a UI MCP URL is provided, and the `dorkos` tool server
 * when one is injected (`dorkosTools`, spec `tool-only-room-replies`) — see
 * {@link buildMcpServersConfig} for the merge and the shadowing guarantee.
 * `config` is omitted entirely when no source contributes a server.
 *
 * `CodexOptions.env` has two sources, and both are secrets that must not travel
 * any other way: `extraEnv` (the agent's `DORKOS_AGENT_TOKEN`) and the `dorkos`
 * server's two header values, which are placed under the variable names
 * `env_http_headers` points Codex at. Setting `env` at all stops the SDK
 * inheriting `process.env` wholesale, so this function spreads the parent
 * environment back in explicitly (see {@link inheritedEnv}) before layering
 * those on top. With neither source, `env` stays unset — the SDK's own
 * inherit-everything path.
 *
 * @param binaryPath - Absolute path to the `codex` binary, or null/undefined
 * @param mcpUiUrl - Loopback URL of the scoped `dorkos_ui` MCP server, or undefined
 * @param extraEnv - Extra environment entries for the `codex exec` subprocess
 *   (the agent's identity token). Omitted or empty contributes none.
 * @param managedServers - The agent's enabled managed MCP servers, already
 *   converted to Codex config shape. Omitted or empty adds none.
 * @param dorkosTools - The resolved `dorkos` tool server, or null/undefined to
 *   inject none. Its URL goes into `config`; its header VALUES go into `env`,
 *   never into `config`, because `config` becomes visible argv.
 */
export function buildCodexOptions(
  binaryPath?: string | null,
  mcpUiUrl?: string,
  extraEnv?: Record<string, string>,
  managedServers?: CodexMcpServerRecord,
  dorkosTools?: DorkosMcpInjection | null
): CodexOptions {
  const env = { ...(extraEnv ?? {}), ...dorkosHeaderEnv(dorkosTools) };
  const hasExtraEnv = Object.keys(env).length > 0;
  const mcpServers = buildMcpServersConfig(mcpUiUrl, managedServers, dorkosTools);
  return {
    ...(binaryPath ? { codexPathOverride: binaryPath } : {}),
    ...(mcpServers ? { config: { mcp_servers: mcpServers } } : {}),
    ...(hasExtraEnv ? { env: { ...inheritedEnv(), ...env } } : {}),
  };
}

/**
 * Merge the agent's managed MCP servers with the two servers DorkOS owns — the
 * scoped `dorkos_ui` bridge and the `dorkos` tool server — into one
 * `mcp_servers` config record, or `undefined` when none contributes.
 *
 * Both DorkOS entries are written LAST, so a managed server can never shadow
 * either whatever its name — the same ordering guarantee the claude-code
 * adapter's `mergeSessionMcpServers` gives, and defense in depth on top of the
 * converter already dropping (and now reporting) the reserved names.
 *
 * The `dorkos` entry is streamable HTTP with `http_headers`, which is the only
 * transport that can carry the bearer and the agent identity — see
 * {@link resolveDorkosMcpInjection} for why both are mandatory. Codex's MCP
 * client sends no `Origin`, so it clears `validateMcpOrigin` through the
 * non-browser early return, exactly as `dorkos_ui` already does.
 *
 * @param mcpUiUrl - Loopback URL of the `dorkos_ui` server, or undefined.
 * @param managedServers - Enabled managed servers in Codex config shape.
 * @param dorkosTools - The resolved `dorkos` entry, or null/undefined to inject none.
 */
function buildMcpServersConfig(
  mcpUiUrl?: string,
  managedServers?: CodexMcpServerRecord,
  dorkosTools?: DorkosMcpInjection | null
): CodexMcpServerRecord | undefined {
  const servers: CodexMcpServerRecord = { ...(managedServers ?? {}) };
  if (mcpUiUrl) servers[CODEX_UI_MCP_SERVER] = { url: mcpUiUrl };
  if (dorkosTools) {
    servers[DORKOS_MCP_SERVER_NAME] = {
      url: dorkosTools.url,
      // `env_http_headers`, never `http_headers`. This config object is
      // flattened into `--config key=value` arguments on the `codex exec`
      // command line, so a value written here lands in the spawned argv, where
      // any process running as this user can read it with `ps`. Both values are
      // credentials — the MCP bearer, and an identity that can post as this
      // agent — so the config carries only the NAMES of the environment
      // variables holding them, and Codex resolves the values inside the
      // subprocess. `buildCodexOptions` puts them there.
      env_http_headers: dorkosHeaderEnvNames(dorkosTools),
    };
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}

/**
 * The parent environment as a `Record<string, string>`, dropping unset keys.
 *
 * Reproduces exactly what the Codex SDK does when `CodexOptions.env` is absent,
 * so passing this plus one extra key is equivalent to inheritance plus that key,
 * never a narrowed environment that loses PATH, HOME, or CODEX_HOME.
 */
function inheritedEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  // eslint-disable-next-line no-restricted-syntax -- full env needed for the codex subprocess to inherit PATH/HOME/CODEX_HOME
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
