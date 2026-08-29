/**
 * The two halves of getting the `dorkos` MCP server's headers to Codex without
 * putting them on the command line (spec `tool-only-room-replies` §D4).
 *
 * ## Why this split exists at all
 *
 * The Codex SDK flattens `CodexOptions.config` into `--config key=value`
 * arguments on the `codex exec` command line, so anything written there is in
 * the spawned process's argv — readable by any process running as this user,
 * with a bare `ps`. Both of this server's headers carry credentials: the
 * instance's MCP bearer, and an agent identity that can post in rooms AS that
 * agent. Neither may go there.
 *
 * So the header set is split in two, and the two halves travel by different
 * routes: {@link dorkosHeaderEnvNames} produces the NAMES for the config's
 * `env_http_headers` entry, and {@link dorkosHeaderEnv} produces the VALUES for
 * the subprocess environment — the same channel `DORKOS_AGENT_TOKEN` already
 * uses. Codex resolves one against the other inside the subprocess.
 *
 * Kept beside the runtime rather than inside it because `codex-runtime.ts` is at
 * the repo's 500-line ceiling, and because the pairing is a self-contained
 * transport concern: these two functions must agree with each other and with
 * `DORKOS_MCP_HEADER_ENV_VARS`, and nothing else needs to see them.
 *
 * @module services/runtimes/codex/dorkos-header-env
 */
import {
  DORKOS_MCP_HEADER_ENV_VARS,
  type DorkosMcpInjection,
} from '../shared/dorkos-mcp-injection.js';

/**
 * Header name → env var NAME, for the `env_http_headers` config entry.
 *
 * Derived from the headers the injection actually produced rather than from a
 * fixed pair, so a header added there without a variable name to carry it fails
 * loudly here instead of being dropped on the floor.
 *
 * @param injection - The resolved `dorkos` entry.
 * @throws When a header has no environment variable defined for it. Refusing is
 *   the only safe answer: the alternative is passing the value through `config`,
 *   which becomes visible argv.
 */
export function dorkosHeaderEnvNames(injection: DorkosMcpInjection): Record<string, string> {
  const names: Record<string, string> = {};
  for (const header of Object.keys(injection.headers)) {
    const envVar = DORKOS_MCP_HEADER_ENV_VARS[header];
    if (envVar === undefined) {
      throw new Error(
        `[CodexRuntime] no environment variable is defined for the "${header}" header. ` +
          'Add one to DORKOS_MCP_HEADER_ENV_VARS — it must not be passed through `config`, ' +
          'which becomes visible argv.'
      );
    }
    names[header] = envVar;
  }
  return names;
}

/**
 * The header VALUES, keyed by the env var Codex will read each one from.
 *
 * This is the half that carries the secrets, and it goes into
 * `CodexOptions.env` — the subprocess environment — never into `config`.
 *
 * @param injection - The resolved `dorkos` entry, or null when none is injected.
 */
export function dorkosHeaderEnv(injection?: DorkosMcpInjection | null): Record<string, string> {
  if (!injection) return {};
  const values: Record<string, string> = {};
  for (const [header, value] of Object.entries(injection.headers)) {
    const envVar = DORKOS_MCP_HEADER_ENV_VARS[header];
    if (envVar !== undefined) values[envVar] = value;
  }
  return values;
}
