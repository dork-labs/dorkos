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
 * With `verify: true` each entry also says whether its files still match what
 * was installed (DOR-2197), read from its installed-files record.
 *
 * @module services/marketplace-mcp/tool-list-installed
 */
import { z } from 'zod';
import { PAGE_LIMIT_DEFAULT, PageQuerySchema } from '@dorkos/shared/paging';
import type { MarketplaceMcpDeps } from './marketplace-mcp-tools.js';
import type { InstalledPackage } from '../marketplace/installed-scanner.js';
import { scanUpdateView } from '../marketplace/flows/update-installed.js';
import type { InstallationUpdateCheck } from '../marketplace/flows/update-types.js';
import { withIntegrity } from '../marketplace/lib/integrity/verify-install.js';
import { invalidCursor } from '../core/capabilities/capability-definition.js';
import { assertPageCursor, pageInOwnOrder } from '../../lib/paging/keyset-page.js';

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
  /**
   * Also say whether each package's files still match what was installed
   * (DOR-2197). Off by default: it reads every shipped file.
   */
  verify: z
    .boolean()
    .optional()
    .describe(
      "Also say, for each package, whether its files still match what was installed: 'clean', " +
        "'modified' (with the changed, missing or added files) or 'unknown' (installed by an " +
        'older DorkOS, or a linked working copy). Slower: reads every shipped file.'
    ),
  /** The `nextCursor` of the page before (DOR-4982). */
  cursor: PageQuerySchema.shape.cursor,
  /** How many one page holds. */
  limit: PageQuerySchema.shape.limit,
};

/** Inferred TypeScript type for the tool's input arguments. */
export type ListInstalledInput = {
  type?: 'agent' | 'plugin' | 'skill-pack' | 'adapter';
  checkUpdates?: boolean;
  verify?: boolean;
  cursor?: string;
  limit?: number;
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
 * An installation without the working folder its dev link runs from: what an
 * agent reads.
 *
 * @param installation - The installation as a person reads it.
 */
function withoutDevLinkFolder<T extends InstalledPackage>(installation: T): T {
  if (!installation.devLink) return installation;
  const { path: _folder, ...devLink } = installation.devLink;
  return { ...installation, devLink } as T;
}

/**
 * Build the `marketplace_list_installed` handler. Returns an async function
 * suitable for `McpServer.tool(...)` that scans every install scope under
 * `deps.dorkHome` plus each registered agent's `.dork/plugins` (via
 * `deps.listAgentScopes`) and returns a JSON-serialized cross-scope list — one
 * entry per installation, each tagged with scope and agent identity, and with
 * `checkUpdates` an `update` summary ({@link InstalledUpdateSummary}).
 *
 * Filtering happens in memory after the scan, and so does the cut to one page
 * (scan order, `cursor` and `limit` in, `nextCursor` back, DOR-4982), both
 * before any update check, because the scan is cheap and the checks are not. The return type is intentionally inferred so
 * the MCP SDK's `CallToolResult` shape (which has an index signature) accepts
 * the handler directly at the registration site.
 *
 * The handler's second argument says who is reading: an agent's list leaves
 * out the working folder a dev link runs from, as `GET /api/marketplace/installed`
 * does (`marketplace/doors/marketplace-reader.ts`). The rows this tool lists
 * carry no `heldBack`, so the dev link is the only folder to leave out.
 *
 * @param deps - Marketplace MCP dependency bundle. Reads `dorkHome`, and, when
 *   present, `listAgentScopes` (absent → global installs only); `updateFlow`
 *   only with `checkUpdates`.
 * @returns An async handler accepting {@link ListInstalledInput}
 */
export function createListInstalledHandler(deps: MarketplaceMcpDeps) {
  return async (args: ListInstalledInput, reader: { agentAsking?: boolean; key?: string } = {}) => {
    // The type filter is bound into the cursor, and the cursor to the reader.
    const list = `mcp-installed:${args.type ?? ''}`;
    const query = { cursor: args.cursor, limit: args.limit ?? PAGE_LIMIT_DEFAULT };
    assertPageCursor(list, query.cursor, invalidCursor, reader.key);
    // Filter and cut before any check: a check nobody will see is a fetch for nothing.
    const scanned = (await scanUpdateView(deps, undefined)).filter(
      (r) => !args.type || r.package.type === args.type
    );
    const idOf = (r: (typeof scanned)[number]) => r.package.installPath;
    const page = pageInOwnOrder(list, scanned, idOf, query, invalidCursor, reader.key);
    const records = page.items;
    let installed: Array<InstalledPackage & { update?: InstalledUpdateSummary }> = records.map(
      (r) => r.package
    );
    if (args.checkUpdates) {
      const { checks } = await deps.updateFlow.planInstallations({ installations: records });
      const byPath = new Map(checks.map((c) => [c.installPath, c]));
      installed = records.map((r) => {
        const check = byPath.get(r.package.installPath);
        return check ? { ...r.package, update: summaryOf(check) } : r.package;
      });
    }

    if (args.verify) installed = await withIntegrity(installed);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              installed: reader.agentAsking ? installed.map(withoutDevLinkFolder) : installed,
              nextCursor: page.nextCursor,
            },
            null,
            2
          ),
        },
      ],
    };
  };
}
