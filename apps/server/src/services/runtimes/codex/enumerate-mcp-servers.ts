/**
 * Codex MCP-server enumeration.
 *
 * Codex loads MCP servers from its OWN config (`$CODEX_HOME/config.toml`,
 * default `~/.codex/config.toml`), NOT from DorkOS injection — so DorkOS can
 * only surface, never manage, that list (`supportsMcp` stays false). We read it
 * by shelling out to the vendored `codex` CLI (`codex mcp list --json`) rather
 * than parsing TOML ourselves: there is no TOML parser dependency available and
 * `os.homedir()` is banned in server code, whereas the CLI resolves its own
 * `$CODEX_HOME`. The probe is bounded and non-blocking (shared run-probe helper)
 * so a hung CLI degrades to "unavailable" rather than stalling the event loop.
 *
 * @module services/runtimes/codex/enumerate-mcp-servers
 */
import type { McpServerEntry } from '@dorkos/shared/transport';
import { logger } from '../../../lib/logger.js';
import { resolveCodexBinaryPath } from './check-dependencies.js';
import { runBinaryProbe } from '../shared/run-probe.js';

/** Defensive cap on the `codex mcp list` probe. */
const MCP_LIST_TIMEOUT_MS = 5_000;

/** Transport sub-shape of one entry in `codex mcp list --json`. */
interface CodexMcpTransport {
  /** Codex transport discriminator: `'stdio'` or `'streamable_http'`. */
  type?: string;
  /** Present on streamable-HTTP servers. */
  url?: string;
}

/** One entry from `codex mcp list --json` (only the fields we surface). */
interface CodexMcpServer {
  name?: string;
  transport?: CodexMcpTransport;
}

/**
 * Map a Codex transport to the DorkOS {@link McpServerEntry} type. Codex uses
 * `streamable_http` for its HTTP transport (no `sse` variant at the 0.142.5
 * pin); anything else is treated as `stdio`.
 */
function mapTransportType(transport: CodexMcpTransport | undefined): McpServerEntry['type'] {
  const type = transport?.type;
  if (type === 'streamable_http' || type === 'http' || transport?.url !== undefined) return 'http';
  if (type === 'sse') return 'sse';
  return 'stdio';
}

/**
 * Enumerate the MCP servers Codex has configured, via `codex mcp list --json`.
 *
 * Each configured server maps to an {@link McpServerEntry} with `scope: 'user'`
 * (Codex config is user-global) and no `status` — the SDK only reports MCP
 * connectivity per `mcp_tool_call` at runtime, so config-time status is unknown.
 * Returns `[]` when none are configured, and `null` only when enumeration
 * genuinely fails (the binary is unresolvable, the probe errors or times out, or
 * the output is not parseable JSON).
 */
export async function enumerateCodexMcpServers(): Promise<McpServerEntry[] | null> {
  try {
    const binary = await resolveCodexBinaryPath();
    if (!binary) return null;

    const stdout = await runBinaryProbe(binary, ['mcp', 'list', '--json'], MCP_LIST_TIMEOUT_MS);
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return [];

    return (parsed as CodexMcpServer[])
      .filter(
        (server): server is CodexMcpServer & { name: string } => typeof server.name === 'string'
      )
      .map((server) => ({
        name: server.name,
        type: mapTransportType(server.transport),
        scope: 'user',
      }));
  } catch (err) {
    logger.debug('[CodexRuntime] MCP enumeration failed', { err });
    return null;
  }
}
