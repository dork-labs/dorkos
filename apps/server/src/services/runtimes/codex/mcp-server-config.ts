/**
 * Convert runtime-neutral {@link McpAppServerConnection} details into the shape
 * Codex reads from `mcp_servers.*` config entries, so an agent's managed MCP
 * servers (spec `mcp-server-management`) can be folded into
 * `CodexOptions.config.mcp_servers` at turn time (DOR-892).
 *
 * This is the Codex-local analogue of the claude-code `toSdkMcpServers`
 * converter — deliberately NOT shared with it: Codex has its own config schema
 * (verified against the vendored CLI at the pin), not the Claude Agent SDK's
 * `McpServerConfig` union. `@openai/codex-sdk` is ESLint-confined to this
 * directory, so the SDK-shape translation lives here.
 *
 * Codex speaks two MCP transports: `stdio` (`{ command, args, env }`) and
 * `streamable_http` (`{ url, http_headers }`). It has NO SSE transport, so a
 * neutral `sse` server cannot be honestly injected and is skipped (surfaced via
 * {@link CodexMcpConversion.skipped} for a diagnostic, never silently mismapped
 * onto streamable HTTP).
 *
 * @module services/runtimes/codex/mcp-server-config
 */
import type { CodexOptions } from '@openai/codex-sdk';
import type {
  McpAppServerConnection,
  ManagedMcpServerResolver,
} from '@dorkos/shared/agent-runtime';
import { CODEX_UI_MCP_SERVER } from './codex-ui-mcp-server.js';
import { DORKOS_MCP_SERVER_NAME } from '../shared/dorkos-tool-names.js';
import { logger } from '../../../lib/logger.js';

/**
 * One `mcp_servers.<name>` config entry. The SDK's `CodexConfigObject` is not
 * exported, so derive it from the (exported) {@link CodexOptions.config} shape —
 * a recursive `{ [key: string]: string | number | boolean | ... }` the SDK
 * flattens into `--config key=value` CLI overrides.
 */
type CodexConfigObject = NonNullable<CodexOptions['config']>;

/** A name → Codex-config-entry record, ready to spread into `config.mcp_servers`. */
export type CodexMcpServerRecord = Record<string, CodexConfigObject>;

/**
 * Map one neutral connection to a Codex `mcp_servers.<name>` config object, or
 * `null` when Codex cannot run it (an `sse` connection — Codex has no SSE
 * transport). Empty `args`/`env`/`headers` are omitted so the flattened
 * `--config` overrides stay minimal.
 *
 * @param connection - The runtime-neutral managed-server connection.
 */
export function toCodexMcpServerConfig(
  connection: McpAppServerConnection
): CodexConfigObject | null {
  switch (connection.transport) {
    case 'stdio':
      return {
        command: connection.command,
        ...(connection.args && connection.args.length > 0 ? { args: connection.args } : {}),
        ...(connection.env && Object.keys(connection.env).length > 0
          ? { env: connection.env }
          : {}),
      };
    case 'http':
      return {
        url: connection.url,
        ...(connection.headers && Object.keys(connection.headers).length > 0
          ? { http_headers: connection.headers }
          : {}),
      };
    case 'sse':
      return null;
  }
}

/** The result of converting an agent's managed servers to Codex config shape. */
export interface CodexMcpConversion {
  /** Convertible servers, keyed by name, ready to spread into `config.mcp_servers`. */
  servers: Record<string, CodexConfigObject>;
  /** Names skipped because Codex has no matching transport (`sse`), for a one-line diagnostic. */
  skipped: string[];
  /**
   * Names dropped because DorkOS reserves them — a user's own server called
   * `dorkos` or `dorkos_ui`.
   *
   * Reported rather than merely dropped, and that is the whole reason this field
   * exists. The drop used to be silent, which was survivable while `dorkos_ui`
   * was the only reserved name (nobody names a server that). `dorkos` is a name
   * a person plausibly gave their own server, and watching their tools vanish
   * with no diagnostic anywhere is the failure this closes (DOR-1613).
   */
  reserved: string[];
}

/**
 * Convert a name → neutral-connection record (the enabled managed servers the
 * `AgentMcpServerService` resolved for a session cwd) into a name → Codex-config
 * record.
 *
 * A `reservedNames` set is dropped so a managed server can never occupy a name
 * DorkOS owns (the `dorkos_ui` UI bridge, and the injected `dorkos` tool server);
 * the caller also writes the reserved entries LAST when merging, so shadowing is
 * impossible on either count. Dropped names are REPORTED in
 * {@link CodexMcpConversion.reserved} so the caller can say so — see that field
 * for why silence was not good enough. `sse` servers land in
 * {@link CodexMcpConversion.skipped} rather than the output — absence withholds
 * (safe-default), never a silent mismap.
 *
 * @param connections - Enabled managed servers by name, from the resolver.
 * @param reservedNames - Names DorkOS reserves and this converter must not emit.
 */
export function toCodexMcpServers(
  connections: Record<string, McpAppServerConnection>,
  reservedNames: ReadonlySet<string>
): CodexMcpConversion {
  const servers: Record<string, CodexConfigObject> = {};
  const skipped: string[] = [];
  const reserved: string[] = [];
  for (const [name, connection] of Object.entries(connections)) {
    if (reservedNames.has(name)) {
      reserved.push(name);
      continue;
    }
    const config = toCodexMcpServerConfig(connection);
    if (config === null) {
      skipped.push(name);
      continue;
    }
    servers[name] = config;
  }
  return { servers, skipped, reserved };
}

/**
 * Resolve the agent's enabled managed MCP servers for a session cwd and map
 * them to Codex config shape. Returns `{}` when no resolver is wired or the
 * cwd hosts no agent manifest — the safe default (absence withholds). SSE
 * servers have no Codex transport and are dropped with a one-line debug log,
 * never mismapped.
 *
 * @param resolver - The composition root's managed-server resolver, or
 *   `undefined` when none was wired.
 * @param cwd - The session's working directory (the agent's workspace path).
 * @param injectingDorkosTools - Whether THIS turn injects the `dorkos` server,
 *   which is what decides whether that name is reserved.
 */
export function resolveManagedMcpServers(
  resolver: ManagedMcpServerResolver | undefined,
  cwd: string,
  injectingDorkosTools: boolean
): CodexMcpServerRecord {
  if (!resolver) return {};
  const neutral = resolver.injectableServersForCwd(cwd);
  // `dorkos_ui` is always ours — it is injected on every turn. `dorkos` is
  // ours only on the turns we actually inject it, which is why the set is
  // built per turn rather than being a constant.
  //
  // Reserving it unconditionally was a REGRESSION on the default path: with
  // the experiment off DorkOS wants nothing called `dorkos`, so dropping a
  // person's own server of that name took something and gave nothing back,
  // and it made the flag-OFF path stop being byte-identical to the one that
  // shipped before this feature. It also disagreed with OpenCode, where the
  // desired set simply has no `dorkos` entry when the experiment is off and a
  // user's server of that name is therefore never touched. Same experiment,
  // same name, two runtimes: they have to answer this the same way.
  const reservedNames = new Set([CODEX_UI_MCP_SERVER]);
  if (injectingDorkosTools) reservedNames.add(DORKOS_MCP_SERVER_NAME);
  const { servers, skipped, reserved } = toCodexMcpServers(neutral, reservedNames);
  if (skipped.length > 0) {
    logger.debug('[CodexRuntime] skipped SSE managed MCP servers — Codex has no SSE transport', {
      cwd,
      skipped,
    });
  }
  if (reserved.length > 0) {
    // A WARN, not a debug: this is somebody's own server disappearing. The
    // drop itself is correct and stays — DorkOS must own these names — but a
    // person watching their tools vanish needs a line naming the collision
    // and the remedy, which is the whole of DOR-1613's complaint about the
    // silent version of this branch.
    logger.warn(
      `[CodexRuntime] managed MCP server(s) ${reserved
        .map((name) => `"${name}"`)
        .join(', ')} use a name DorkOS reserves and were NOT injected — rename them to inject them`,
      { cwd, reserved }
    );
  }
  return servers;
}
