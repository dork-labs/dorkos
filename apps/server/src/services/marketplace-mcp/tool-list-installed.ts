/**
 * `marketplace_list_installed` MCP tool — lists every package currently
 * installed in the active DorkOS instance, optionally filtered by package
 * type.
 *
 * The handler delegates to {@link scanInstallationsAcrossScopes}, the same
 * cross-scope scanner the HTTP route (`GET /api/marketplace/installed`) uses,
 * so the MCP and HTTP surfaces always agree on what "installed" means — one
 * entry per installation, tagged with scope and (for agent installs) agent
 * identity. The returned content block is JSON-serialized so external MCP
 * clients (Claude Code, Cursor, Codex) can parse it without additional tooling.
 *
 * @module services/marketplace-mcp/tool-list-installed
 */
import { z } from 'zod';
import type { MarketplaceMcpDeps } from './marketplace-mcp-tools.js';
import {
  scanInstallationsAcrossScopes,
  type InstalledPackage,
} from '../marketplace/installed-scanner.js';

/**
 * Zod input schema for `marketplace_list_installed`. The schema is exported
 * as a plain shape (not wrapped in `z.object`) because `McpServer.tool()`
 * accepts the shape directly and derives the parameter names from its keys.
 */
export const ListInstalledInputSchema = {
  /**
   * Optional package type filter. When supplied, only installed packages
   * whose `type` matches are returned. When omitted, every installed package
   * is returned.
   */
  type: z.enum(['agent', 'plugin', 'skill-pack', 'adapter']).optional(),
};

/** Inferred TypeScript type for the tool's input arguments. */
export type ListInstalledInput = {
  type?: 'agent' | 'plugin' | 'skill-pack' | 'adapter';
};

/**
 * Build the `marketplace_list_installed` handler. Returns an async function
 * suitable for `McpServer.tool(...)` that scans every install scope under
 * `deps.dorkHome` plus each registered agent's `.dork/plugins` (via
 * `deps.listAgentScopes`) and returns a JSON-serialized cross-scope list — one
 * entry per installation, each tagged with scope and agent identity.
 *
 * Filtering happens in memory after the scan because the underlying scanner
 * is cheap and a single source of truth is cleaner than wiring a filter
 * argument all the way through. The return type is intentionally inferred so
 * the MCP SDK's `CallToolResult` shape (which has an index signature) accepts
 * the handler directly at the registration site.
 *
 * @param deps - Marketplace MCP dependency bundle. Reads `dorkHome` and, when
 *   present, `listAgentScopes` (absent → global installs only).
 * @returns An async handler accepting {@link ListInstalledInput}
 */
export function createListInstalledHandler(deps: MarketplaceMcpDeps) {
  return async (args: ListInstalledInput) => {
    const all = await scanInstallationsAcrossScopes(deps.dorkHome, deps.listAgentScopes?.() ?? []);
    const installed: InstalledPackage[] = args.type
      ? all.filter((pkg) => pkg.type === args.type)
      : all;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ installed }, null, 2),
        },
      ],
    };
  };
}
