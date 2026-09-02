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
 * `streamable_http` (`{ url, env_http_headers }` — see below for why never
 * `http_headers`, which is the other spelling Codex accepts). It has NO SSE
 * transport, so a neutral `sse` server cannot be honestly injected and is
 * skipped (surfaced via {@link CodexMcpConversion.skipped} for a diagnostic,
 * never silently mismapped onto streamable HTTP).
 *
 * ## No header value is written into the config (DOR-993)
 *
 * The SDK flattens `CodexOptions.config` into `--config key=value` arguments on
 * the `codex exec` command line, so anything written there is an entry in the
 * spawned process's argv — readable by any process running as this user with a
 * bare `ps`. HTTP headers are where a managed server's credentials live: the
 * OAuth bearer DorkOS merges in for a signed-in server
 * (`agent-mcp-server-service.mergeOAuthHeaders`), and whatever key the operator
 * typed into a static header. So this converter writes no header VALUE at all.
 * It mints one environment variable per header, names it in the entry's
 * `env_http_headers`, and hands the values back in
 * {@link CodexMcpConversion.env} for {@link buildCodexOptions} to put in the
 * subprocess environment — the same split `dorkos-header-env.ts` already makes
 * for the `dorkos` server's own two headers.
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
 * The prefix every minted header variable carries.
 *
 * DorkOS-owned and explicit rather than short, because these are spread into an
 * inherited environment: a collision would silently replace a credential with
 * somebody else's value. Deliberately distinct from the `dorkos` server's own
 * `DORKOS_MCP_HEADER_*` names (`dorkos-mcp-injection.ts`) so the two mints can
 * never land on the same variable.
 */
const MANAGED_HEADER_ENV_PREFIX = 'DORKOS_MCP_HDR_';

/**
 * One managed server in Codex shape: the config entry, and the header values
 * that must not be in it.
 */
export interface CodexMcpServerEntry {
  /** The `mcp_servers.<name>` config object — flattened into argv, so credential-free. */
  config: CodexConfigObject;
  /** Env var NAME → header VALUE, for `CodexOptions.env`. Empty when the server carries no headers. */
  env: Record<string, string>;
}

/**
 * Map one neutral connection to a Codex `mcp_servers.<name>` config object plus
 * the environment its header values ride in, or `null` when Codex cannot run it
 * (an `sse` connection — Codex has no SSE transport). Empty `args`/`env`/
 * `headers` are omitted so the flattened `--config` overrides stay minimal.
 *
 * Headers never appear in the returned config: each one is redirected to an
 * environment variable named in `env_http_headers`, for the reason the module
 * doc gives. A stdio server's `env` block IS still written into the config,
 * because Codex has no equivalent redirection for it that lets DorkOS choose
 * the variable name the child process sees — that residue is named out loud at
 * the `mergeOAuthHeaders` custody disclosure rather than left implied.
 *
 * @param name - The server's name, which seeds readable variable names.
 * @param connection - The runtime-neutral managed-server connection.
 * @param takenEnvVars - Variable names already minted this turn. **Mutated**:
 *   every name this call mints is added, so two servers can never share one
 *   variable and be handed each other's credential. REQUIRED, with no default,
 *   deliberately: a defaulted fresh set would make the one call shape that
 *   breaks the guarantee — a new set per server inside a loop — also the
 *   shortest one to write. The caller has to hold the set that spans the whole
 *   record, so the type says so.
 */
export function toCodexMcpServerConfig(
  name: string,
  connection: McpAppServerConnection,
  takenEnvVars: Set<string>
): CodexMcpServerEntry | null {
  switch (connection.transport) {
    case 'stdio':
      return {
        config: {
          command: connection.command,
          ...(connection.args && connection.args.length > 0 ? { args: connection.args } : {}),
          ...(connection.env && Object.keys(connection.env).length > 0
            ? { env: connection.env }
            : {}),
        },
        env: {},
      };
    case 'http': {
      const { names, values } = redirectHeadersToEnv(name, connection.headers, takenEnvVars);
      return {
        config: {
          url: connection.url,
          ...(Object.keys(names).length > 0 ? { env_http_headers: names } : {}),
        },
        env: values,
      };
    }
    case 'sse':
      return null;
  }
}

/**
 * Split a server's headers into the NAMES Codex reads them from and the VALUES
 * the subprocess environment carries.
 *
 * Every header is redirected, not just the ones that look like credentials.
 * There is no reliable way to tell a secret header from an innocent one — the
 * static-header field is exactly where people paste API keys — and a heuristic
 * that guesses wrong puts a live credential on the command line, which is the
 * failure this whole function exists to make impossible.
 *
 * @param serverName - The owning server's name, for a readable variable name.
 * @param headers - The connection's headers, or undefined when it has none.
 * @param taken - Names already minted; mutated with each new one.
 */
function redirectHeadersToEnv(
  serverName: string,
  headers: Record<string, string> | undefined,
  taken: Set<string>
): { names: Record<string, string>; values: Record<string, string> } {
  const names: Record<string, string> = {};
  const values: Record<string, string> = {};
  for (const [header, value] of Object.entries(headers ?? {})) {
    const envVar = mintHeaderEnvVar(serverName, header, taken);
    names[header] = envVar;
    values[envVar] = value;
  }
  return { names, values };
}

/**
 * A free environment-variable name for one server's one header.
 *
 * Derived from the two names so a person reading `--config` output or a process
 * environment can tell which header it holds, then suffixed until it is unused:
 * `my-server` and `my_server` reduce to the same token, and handing them one
 * variable would send each server the other's credential.
 *
 * @param serverName - The owning server's name.
 * @param header - The header name.
 * @param taken - Names already minted; the chosen name is added to it.
 */
function mintHeaderEnvVar(serverName: string, header: string, taken: Set<string>): string {
  const base = `${MANAGED_HEADER_ENV_PREFIX}${envToken(serverName)}_${envToken(header)}`;
  let name = base;
  for (let suffix = 2; taken.has(name); suffix++) name = `${base}_${suffix}`;
  taken.add(name);
  return name;
}

/** Reduce a name to the `[A-Z0-9_]` an environment variable may be spelled with. */
function envToken(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

/** The result of converting an agent's managed servers to Codex config shape. */
export interface CodexMcpConversion {
  /** Convertible servers, keyed by name, ready to spread into `config.mcp_servers`. */
  servers: Record<string, CodexConfigObject>;
  /**
   * Env var NAME → header VALUE across every converted server, for
   * `CodexOptions.env`. These are the credentials the config deliberately does
   * not carry (DOR-993); `{}` when no server has headers.
   */
  env: Record<string, string>;
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
 * Header values are collected into {@link CodexMcpConversion.env} rather than
 * written into the entries, and the variable names are minted against ONE set
 * across the whole record, so no two servers can be handed the same variable.
 *
 * @param connections - Enabled managed servers by name, from the resolver.
 * @param reservedNames - Names DorkOS reserves and this converter must not emit.
 */
export function toCodexMcpServers(
  connections: Record<string, McpAppServerConnection>,
  reservedNames: ReadonlySet<string>
): CodexMcpConversion {
  const servers: Record<string, CodexConfigObject> = {};
  const env: Record<string, string> = {};
  const takenEnvVars = new Set<string>();
  const skipped: string[] = [];
  const reserved: string[] = [];
  for (const [name, connection] of Object.entries(connections)) {
    if (reservedNames.has(name)) {
      reserved.push(name);
      continue;
    }
    const entry = toCodexMcpServerConfig(name, connection, takenEnvVars);
    if (entry === null) {
      skipped.push(name);
      continue;
    }
    servers[name] = entry.config;
    Object.assign(env, entry.env);
  }
  return { servers, env, skipped, reserved };
}

/** The agent's managed servers for one turn: the config entries, and their header values. */
export interface CodexManagedMcpServers {
  /** Name → Codex config entry, ready to spread into `config.mcp_servers`. */
  servers: CodexMcpServerRecord;
  /** Env var NAME → header VALUE, for `CodexOptions.env`; `{}` when no server has headers. */
  env: Record<string, string>;
}

/**
 * Resolve the agent's enabled managed MCP servers for a session cwd and map
 * them to Codex config shape. Returns empty maps when no resolver is wired or
 * the cwd hosts no agent manifest — the safe default (absence withholds). SSE
 * servers have no Codex transport and are dropped with a one-line debug log,
 * never mismapped.
 *
 * The returned `env` is the half that carries credentials and belongs in
 * `CodexOptions.env`; a caller that spreads only `servers` puts nothing on the
 * command line but also hands those servers no headers at all.
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
): CodexManagedMcpServers {
  if (!resolver) return { servers: {}, env: {} };
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
  const { servers, env, skipped, reserved } = toCodexMcpServers(neutral, reservedNames);
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
  return { servers, env };
}
