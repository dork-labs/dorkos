/**
 * MCP half of the source inventory — the servers declared in the repository's
 * own `.mcp.json` (XA-03).
 *
 * **Server names only, never a value.** An MCP entry carries an `env` block, and
 * a real one in this repository holds live API keys. The inventory is passed
 * around, printed by `dorkos harness sync`, and will one day be served over an
 * API, so it records the KEYS a person declared and nothing else. Reading a
 * value in here — even to hash it, even to say "this one has an env" — is the
 * edit that turns a report into a leak.
 *
 * Installed MCP servers (`.dork/mcp-servers/`) are out of scope: this walks a
 * source tree, and those are an install product with their own reporting path.
 *
 * @module inventory/mcp
 */
import { join } from 'node:path';
import { readJsonFile } from './read.js';
import type { McpInventoryEntry, UnreadableSource } from './types.js';

/** The repo-relative MCP config file Claude Code reads at project scope. */
export const MCP_CONFIG_SOURCE = '.mcp.json';

/**
 * Inventory the server names in the authored `.mcp.json`.
 *
 * An absent file is silent. A file that is not valid JSON, or whose top level or
 * `mcpServers` key is not an object, is reported: it is plainly a config
 * somebody meant to work.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns one entry per declared server name, and why any of it could not be read.
 */
export function inventoryMcpServers(repoRoot: string): {
  mcpServers: McpInventoryEntry[];
  unreadable: UnreadableSource[];
} {
  const { value, unreadable } = readJsonFile(
    join(repoRoot, MCP_CONFIG_SOURCE),
    MCP_CONFIG_SOURCE,
    'mcp'
  );
  if (unreadable) return { mcpServers: [], unreadable: [unreadable] };
  if (value === undefined) return { mcpServers: [], unreadable: [] };

  const servers = (value as { mcpServers?: unknown }).mcpServers;
  if (servers === undefined) return { mcpServers: [], unreadable: [] };
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    return {
      mcpServers: [],
      unreadable: [
        {
          kind: 'mcp',
          source: MCP_CONFIG_SOURCE,
          reason: `${MCP_CONFIG_SOURCE} has an "mcpServers" key that is not an object, so no server was inventoried`,
        },
      ],
    };
  }

  return {
    mcpServers: Object.keys(servers)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        kind: 'mcp' as const,
        name,
        source: MCP_CONFIG_SOURCE,
        provenance: 'authored' as const,
      })),
    unreadable: [],
  };
}
