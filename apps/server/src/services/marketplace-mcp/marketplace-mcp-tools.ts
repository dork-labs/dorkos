/**
 * Marketplace MCP tools — external `/mcp` registration.
 *
 * This module registers every marketplace tool (`marketplace_search`,
 * `marketplace_get`, `marketplace_list_marketplaces`,
 * `marketplace_list_installed`, `marketplace_recommend`, `marketplace_install`,
 * `marketplace_uninstall`, `marketplace_create_package`) against the external
 * MCP server (`services/core/mcp-server.ts`).
 *
 * The tool catalog itself — names, descriptions, annotations, input schemas,
 * and handler factories — lives in the transport-neutral
 * `marketplace-tool-descriptors.ts` so it can be shared with the in-session
 * `dorkos` server (`services/runtimes/claude-code/mcp-tools/marketplace-tools.ts`).
 * This file owns only the `@modelcontextprotocol/sdk`-specific registration
 * glue: it walks the shared descriptor table and calls `server.registerTool()`
 * for each entry.
 *
 * The shared {@link MarketplaceMcpDeps} bundle is constructed once at server
 * startup in `apps/server/src/index.ts` and threaded through every handler so
 * tool implementations stay decoupled from the rest of the server.
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
import { MARKETPLACE_TOOL_DESCRIPTORS } from './marketplace-tool-descriptors.js';

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
 * Walks the shared {@link MARKETPLACE_TOOL_DESCRIPTORS} table — the same
 * catalog the in-session `dorkos` server registers — and adds each entry to
 * the external server, wiring in the external server's `annotations`
 * (read/write/destructive/open-world hints) which the in-session SDK helper
 * has no slot for.
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
  for (const descriptor of MARKETPLACE_TOOL_DESCRIPTORS) {
    server.registerTool(
      descriptor.name,
      {
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        annotations: descriptor.annotations,
      },
      descriptor.createHandler(deps)
    );
  }
}
