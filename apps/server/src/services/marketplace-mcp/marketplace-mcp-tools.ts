/**
 * Marketplace MCP tools — central dispatch table.
 *
 * This module is the single coordination point that wires every marketplace
 * tool handler (`marketplace_search`, `marketplace_get`,
 * `marketplace_list_marketplaces`, `marketplace_list_installed`,
 * `marketplace_recommend`, `marketplace_install`, `marketplace_uninstall`,
 * `marketplace_create_package`) into the existing external MCP server
 * (`services/core/mcp-server.ts`).
 *
 * The shared {@link MarketplaceMcpDeps} bundle is constructed once at server
 * startup in `apps/server/src/index.ts` and threaded through every handler so
 * tool implementations stay decoupled from the rest of the server. Each
 * handler lives in its own sibling file (`tool-search.ts`, etc.) and exports
 * a `create*Handler(deps)` factory plus its Zod input shape — this file
 * imports both and registers every tool against the supplied `McpServer`.
 *
 * Concentrating registration in one helper keeps the dispatch table in a
 * single, reviewable place and means downstream batches that add or remove
 * tools only ever touch this file plus the new handler module.
 *
 * @module services/marketplace-mcp/marketplace-mcp-tools
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '@dorkos/shared/logger';

import type { InstallerLike } from '../marketplace/marketplace-installer.js';
import type { MarketplaceSourceManager } from '../marketplace/marketplace-source-manager.js';
import type { PackageFetcher } from '../marketplace/package-fetcher.js';
import type { MarketplaceCache } from '../marketplace/marketplace-cache.js';
import type { UninstallFlow } from '../marketplace/flows/uninstall.js';
import type { AgentScopeRef } from '../marketplace/installed-scanner.js';

import type { ConfirmationProvider } from './confirmation-provider.js';
import { createSearchHandler, SearchInputSchema } from './tool-search.js';
import { createGetHandler, GetInputSchema } from './tool-get.js';
import { createListMarketplacesHandler } from './tool-list-marketplaces.js';
import { createListInstalledHandler, ListInstalledInputSchema } from './tool-list-installed.js';
import { createRecommendHandler, RecommendInputSchema } from './tool-recommend.js';
import { createInstallHandler, InstallInputSchema } from './tool-install.js';
import { createUninstallHandler, UninstallInputSchema } from './tool-uninstall.js';
import { createCreatePackageHandler, CreatePackageInputSchema } from './tool-create-package.js';
import { ToolAnnotationPresets } from '../core/mcp-tool-metadata.js';

const A = ToolAnnotationPresets;

/**
 * Dependency bundle for the marketplace MCP tools. Mirrors the existing
 * `McpToolDeps` pattern in `services/runtimes/claude-code/mcp-tools/types.ts`
 * but is scoped to the marketplace surface so tool handlers do not need to
 * pull in unrelated services.
 *
 * Constructed once at server startup and passed into
 * {@link registerMarketplaceTools}.
 */
export interface MarketplaceMcpDeps {
  /** Resolved DorkOS data directory (`.claude/rules/dork-home.md`). */
  dorkHome: string;
  /** Installer orchestrator used by `marketplace_install` and `marketplace_get`. */
  installer: InstallerLike;
  /** Source manager for `marketplace_list_marketplaces`. */
  sourceManager: MarketplaceSourceManager;
  /** Fetcher used to refresh marketplace.json before search. */
  fetcher: PackageFetcher;
  /** Cache used by search/get when reading marketplace.json. */
  cache: MarketplaceCache;
  /** Uninstall flow used by `marketplace_uninstall`. */
  uninstallFlow: UninstallFlow;
  /** Confirmation provider that gates mutation tools. */
  confirmationProvider: ConfirmationProvider;
  /**
   * Registered agent scopes whose `.dork/plugins` the cross-scope installed
   * listing should walk (typically `meshCore.listWithPaths()`). Resolved lazily
   * per call so agents registered after startup are included. When absent — mesh
   * disabled — `marketplace_list_installed` reports global installs only.
   */
  listAgentScopes?: () => AgentScopeRef[];
  /** Structured logger. */
  logger: Logger;
}

/**
 * Register every marketplace MCP tool against an existing `McpServer` instance.
 * Called from `createExternalMcpServer()` in `services/core/mcp-server.ts`
 * after the existing tool registrations.
 *
 * This is the dispatch table for the marketplace MCP surface — every tool
 * registration lives here so the catalog of exposed tools is reviewable in a
 * single place. Adding a new tool means adding one `server.registerTool(...)`
 * call here plus a sibling handler file.
 *
 * Read-only tools (search, get, list_marketplaces, list_installed, recommend)
 * never mutate disk and require no confirmation. Mutation tools (install,
 * uninstall, create_package) always route through the
 * {@link ConfirmationProvider} on `deps` before any side effect. `search`,
 * `get`, and `recommend` fetch from configured external marketplace sources
 * over the network, so they carry `openWorldHint: true`; `list_marketplaces`
 * and `list_installed` only read local config/scan state.
 *
 * @param server - The existing `McpServer` instance to register tools against.
 * @param deps - Marketplace dependency bundle shared by all tool handlers.
 */
export function registerMarketplaceTools(server: McpServer, deps: MarketplaceMcpDeps): void {
  // ── Read-only tools ─────────────────────────────────────────────────────
  server.registerTool(
    'marketplace_search',
    {
      description:
        'Search the DorkOS marketplace for installable packages (agents, plugins, skill packs, adapters). ' +
        'Returns matching entries from every enabled marketplace source. ' +
        'Filters: type (agent/plugin/skill-pack/adapter), category, tags, marketplace, query (free-text).',
      inputSchema: SearchInputSchema,
      annotations: A.readOnlyOpenWorld,
    },
    createSearchHandler(deps)
  );

  server.registerTool(
    'marketplace_get',
    {
      description:
        'Get full details for a marketplace package by name. Returns the package manifest, README, marketplace metadata, and any DorkOS-specific fields (type, category, tags).',
      inputSchema: GetInputSchema,
      annotations: A.readOnlyOpenWorld,
    },
    createGetHandler(deps)
  );

  server.registerTool(
    'marketplace_list_marketplaces',
    {
      description:
        'List configured marketplace sources. Each source includes name, source URL/path, enabled flag, and total package count.',
      inputSchema: {},
      annotations: A.readOnlyLocal,
    },
    createListMarketplacesHandler(deps)
  );

  server.registerTool(
    'marketplace_list_installed',
    {
      description:
        'List packages currently installed in this DorkOS instance, one entry per installation across scopes. ' +
        'A package installed globally and on two agents returns three entries, each tagged with scope ' +
        '(global | agent-local | override) and, for agent installs, the owning agent id and name. ' +
        'Filter by type (agent/plugin/skill-pack/adapter). Includes install path, version, and provenance.',
      inputSchema: ListInstalledInputSchema,
      annotations: A.readOnlyLocal,
    },
    createListInstalledHandler(deps)
  );

  server.registerTool(
    'marketplace_recommend',
    {
      description:
        'Recommend marketplace packages based on a context description (e.g., "I need to track errors in my Next.js app"). Uses keyword + tag matching. Returns top matches with relevance scores and reasons.',
      inputSchema: RecommendInputSchema,
      annotations: A.readOnlyOpenWorld,
    },
    createRecommendHandler(deps)
  );

  // ── Mutation tools (gated by confirmation provider) ─────────────────────
  server.registerTool(
    'marketplace_install',
    {
      description:
        'Install a package from a configured marketplace. Requires user confirmation. ' +
        'For external AI agents: the first call returns status:requires_confirmation with a token. ' +
        'After the user approves in DorkOS, re-call with confirmationToken to complete the install.',
      inputSchema: InstallInputSchema,
      // Fetches the package from its configured (possibly remote) marketplace source.
      annotations: A.mutateCreateOpenWorld,
    },
    createInstallHandler(deps)
  );

  server.registerTool(
    'marketplace_uninstall',
    {
      description:
        'Uninstall a previously installed marketplace package. Requires user confirmation. ' +
        'By default, preserves .dork/data/ and .dork/secrets.json. Pass purge:true to remove them.',
      inputSchema: UninstallInputSchema,
      annotations: A.mutateDeleteLocal,
    },
    createUninstallHandler(deps)
  );

  server.registerTool(
    'marketplace_create_package',
    {
      description:
        "Scaffold a new package in the user's personal marketplace. Creates files on disk under " +
        '~/.dork/personal-marketplace/packages/<name>/ and registers the package in personal marketplace.json. ' +
        'Requires user confirmation. Publishing to a public marketplace is a separate step.',
      inputSchema: CreatePackageInputSchema,
      annotations: A.mutateCreateLocal,
    },
    createCreatePackageHandler(deps)
  );
}
