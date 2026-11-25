/**
 * The one way Codex gets an MCP server's headers without putting them on the
 * command line.
 *
 * Codex flattens its config into `--config key=value` arguments, so anything
 * written there is visible argv — readable with a bare `ps`. So a header never
 * travels in config: config names the ENV VAR to read it from
 * (`env_http_headers`), and the subprocess environment carries the VALUE. Every
 * Codex header path — the agent's managed servers (`mcp-server-config.ts`), the
 * `dorkos` tool server and the connector server — splits its headers here.
 *
 * @module services/runtimes/codex/header-env
 */

/** A header set split into the names Codex reads and the values the environment carries. */
export interface RedirectedHeaders {
  /** Header name → env var NAME, for the config's `env_http_headers` entry. */
  names: Record<string, string>;
  /** Env var NAME → header value, for the subprocess environment. */
  values: Record<string, string>;
  /** Headers `envFor` had no variable for, in the order they appeared. */
  unmapped: string[];
}

/**
 * Split headers into the env var names config may carry and the values only
 * the subprocess environment may carry.
 *
 * @param headers - The headers to redirect, or undefined when there are none.
 * @param envFor - The env var to carry one header, or `undefined` when none is
 *   defined for it. Called once per header, in order.
 */
export function redirectHeaders(
  headers: Record<string, string> | undefined,
  envFor: (header: string) => string | undefined
): RedirectedHeaders {
  const names: Record<string, string> = {};
  const values: Record<string, string> = {};
  const unmapped: string[] = [];
  for (const [header, value] of Object.entries(headers ?? {})) {
    const envVar = envFor(header);
    if (envVar === undefined) {
      unmapped.push(header);
      continue;
    }
    names[header] = envVar;
    values[envVar] = value;
  }
  return { names, values, unmapped };
}
