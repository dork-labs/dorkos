/**
 * `marketplace_list_installed` MCP tool — lists every package currently
 * installed in the active DorkOS instance, optionally filtered by package
 * type.
 *
 * The handler scans every scope once ({@link scanUpdateView}: the global roots
 * plus each registered agent's project), the same walk the HTTP route
 * (`GET /api/marketplace/installed`) lists, so the MCP and HTTP surfaces always agree on what "installed" means — one
 * entry per installation, tagged with scope and (for agent installs) agent
 * identity. The returned content block is JSON-serialized so external MCP
 * clients (Claude Code, Cursor, Codex) can parse it without additional tooling.
 *
 * With `checkUpdates: true` each entry also says whether a newer version exists
 * (DOR-2195). That check reaches every package's marketplace, so it is opt-in:
 * without it the handler never touches the update flow, and makes no network
 * call. With it, the list and the check come from ONE scan, the same records the
 * all-packages update door (`flows/update-installed.ts`) checks.
 *
 * @module services/marketplace-mcp/tool-list-installed
 */
import { z } from 'zod';
import type { MarketplaceMcpDeps } from './marketplace-mcp-tools.js';
import type { InstalledPackage } from '../marketplace/installed-scanner.js';
import { scanUpdateView } from '../marketplace/flows/update-installed.js';
import type { InstallationUpdateCheck } from '../marketplace/flows/update-types.js';

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
  /**
   * Also check each listed package for a newer version. Off by default: it
   * fetches every package's marketplace, and the plain list is cheap.
   */
  checkUpdates: z
    .boolean()
    .optional()
    .describe(
      'Also say, for each package, whether a newer version exists (slower: checks each ' +
        "package's marketplace). Use marketplace_update to install it."
    ),
};

/** Inferred TypeScript type for the tool's input arguments. */
export type ListInstalledInput = {
  type?: 'agent' | 'plugin' | 'skill-pack' | 'adapter';
  checkUpdates?: boolean;
};

/** What `checkUpdates` adds to one listed installation. */
export interface InstalledUpdateSummary {
  /** `update-available`, `current`, or `unknown` when it could not be checked. */
  status: InstallationUpdateCheck['status'];
  /** What installing now would give; `''` when the status is `unknown`. */
  latestVersion: string;
  /** `true` exactly when `status` is `update-available`. */
  hasUpdate: boolean;
  /** Why the status is `unknown`, or a caveat on a known answer. */
  note?: string;
}

/**
 * The part of one check a listed installation carries.
 *
 * @param check - The installation's update check.
 * @returns Its status, latest version and note.
 */
function summaryOf(check: InstallationUpdateCheck): InstalledUpdateSummary {
  return {
    status: check.status,
    latestVersion: check.latestVersion,
    hasUpdate: check.hasUpdate,
    ...(check.note !== undefined && { note: check.note }),
  };
}

/**
 * Build the `marketplace_list_installed` handler. Returns an async function
 * suitable for `McpServer.tool(...)` that scans every install scope under
 * `deps.dorkHome` plus each registered agent's `.dork/plugins` (via
 * `deps.listAgentScopes`) and returns a JSON-serialized cross-scope list — one
 * entry per installation, each tagged with scope and agent identity, and with
 * `checkUpdates` an `update` summary ({@link InstalledUpdateSummary}).
 *
 * Filtering happens in memory after the scan, and before any update check,
 * because the scan is cheap and the checks are not. The return type is intentionally inferred so
 * the MCP SDK's `CallToolResult` shape (which has an index signature) accepts
 * the handler directly at the registration site.
 *
 * @param deps - Marketplace MCP dependency bundle. Reads `dorkHome`, and, when
 *   present, `listAgentScopes` (absent → global installs only); `updateFlow`
 *   only with `checkUpdates`.
 * @returns An async handler accepting {@link ListInstalledInput}
 */
export function createListInstalledHandler(deps: MarketplaceMcpDeps) {
  return async (args: ListInstalledInput) => {
    // Filter before any check: a check nobody will see is a fetch for nothing.
    const records = (await scanUpdateView(deps, undefined)).filter(
      (r) => !args.type || r.package.type === args.type
    );
    let installed: Array<InstalledPackage & { update?: InstalledUpdateSummary }> = records.map(
      (r) => r.package
    );
    if (args.checkUpdates) {
      const { checks } = await deps.updateFlow.checkInstallations({ installations: records });
      const byPath = new Map(checks.map((c) => [c.installPath, c]));
      installed = records.map((r) => {
        const check = byPath.get(r.package.installPath);
        return check ? { ...r.package, update: summaryOf(check) } : r.package;
      });
    }

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
