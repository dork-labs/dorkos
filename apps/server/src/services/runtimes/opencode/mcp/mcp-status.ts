/**
 * OpenCode MCP-server enumeration (read-only status).
 *
 * OpenCode loads MCP servers from its OWN config — the merged global +
 * per-project `opencode.json` `mcp` map for a directory — NOT from DorkOS
 * injection, so DorkOS can only SURFACE that list, never manage it
 * (`supportsMcp` stays false; see the module doc on {@link OpenCodeRuntime}).
 * We read it against the running sidecar (`GET /mcp` for live connectivity,
 * `GET /config` for each server's transport, both scoped by the `directory`
 * query — the sidecar boots one internal instance per directory, NOTES.md §1)
 * rather than parsing config files ourselves: the sidecar already resolves
 * OpenCode's config precedence and reports real connection state, and
 * `os.homedir()` is banned in server code.
 *
 * `GET /mcp` returns only a per-server status discriminant with no transport
 * type, so the type is enriched from `GET /config`'s `mcp` map (best-effort: a
 * failed config read defaults every entry to `stdio` rather than dropping the
 * whole roster). Confined to this directory so the `@opencode-ai/sdk` import
 * never leaks past the adapter (Hard Rule 2).
 *
 * @module services/runtimes/opencode/mcp-status
 */
import type { McpStatus, McpLocalConfig, McpRemoteConfig, OpencodeClient } from '@opencode-ai/sdk';
import type { McpServerEntry } from '@dorkos/shared/transport';
import { logger, logError } from '../../../../lib/logger.js';

/** Map one OpenCode {@link McpStatus} discriminant to the neutral {@link McpServerEntry} status + error. */
function mapStatus(status: McpStatus): { status: McpServerEntry['status']; error?: string } {
  switch (status.status) {
    case 'connected':
      return { status: 'connected' };
    case 'disabled':
      return { status: 'disabled' };
    case 'needs_auth':
      return { status: 'needs-auth' };
    case 'needs_client_registration':
      // An OAuth registration state that still requires the operator to act —
      // the closest neutral bucket is "needs auth"; keep the sidecar's error.
      return { status: 'needs-auth', error: status.error };
    case 'failed':
      return { status: 'failed', error: status.error };
  }
}

/**
 * OpenCode's transport type for a configured server. `remote` is OpenCode's
 * streamable-HTTP transport (there is no `sse` config variant at this pin), and
 * anything else — including an entry with no matching config — is `stdio`.
 */
function resolveType(config: McpLocalConfig | McpRemoteConfig | undefined): McpServerEntry['type'] {
  return config?.type === 'remote' ? 'http' : 'stdio';
}

/**
 * Enumerate the MCP servers OpenCode has loaded for a directory, via the
 * sidecar's `GET /mcp` (live status) joined with `GET /config` (transport type).
 *
 * Each server maps to an {@link McpServerEntry} with its live `status`
 * (connected/disabled/failed/needs-auth) and `error` when the sidecar reports
 * one. `scope` is deliberately omitted: the directory-scoped config merges
 * OpenCode's global and per-project sources, so a single honest scope cannot be
 * assigned (absence withholds the claim). Returns `[]` when none are configured,
 * and `null` only when the status read genuinely fails (the sidecar is
 * unreachable or answers without data) — the caller treats `null` as "not yet
 * available" and keeps its last-known cache.
 *
 * @param client - A ready sidecar client (the caller resolves it via `peekClient`).
 * @param cwd - The session/agent working directory, sent as the `directory` query.
 */
export async function enumerateOpenCodeMcpServers(
  client: OpencodeClient,
  cwd: string
): Promise<McpServerEntry[] | null> {
  let statuses: Record<string, McpStatus>;
  try {
    const result = await client.mcp.status({ query: { directory: cwd } });
    if (result.data === undefined) return null;
    statuses = result.data;
  } catch (err) {
    logger.debug('[OpenCodeRuntime] MCP status read failed', logError(err));
    return null;
  }

  // Best-effort transport-type enrichment: `GET /mcp` carries no type, so join
  // `GET /config`'s `mcp` map. A failed read leaves the map empty and every
  // entry falls back to `stdio` rather than dropping the roster.
  let configMap: Record<string, McpLocalConfig | McpRemoteConfig> = {};
  try {
    const config = await client.config.get({ query: { directory: cwd } });
    configMap = config.data?.mcp ?? {};
  } catch (err) {
    logger.debug(
      '[OpenCodeRuntime] MCP config read failed — defaulting transports to stdio',
      logError(err)
    );
  }

  return Object.entries(statuses).map(([name, status]) => {
    const mapped = mapStatus(status);
    return {
      name,
      type: resolveType(configMap[name]),
      ...(mapped.status !== undefined ? { status: mapped.status } : {}),
      ...(mapped.error !== undefined ? { error: mapped.error } : {}),
    };
  });
}
