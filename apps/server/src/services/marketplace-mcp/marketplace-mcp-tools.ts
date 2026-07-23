/**
 * The marketplace MCP dependency bundle.
 *
 * The marketplace tool surface itself (`marketplace_search`, `marketplace_get`,
 * `marketplace_list_marketplaces`, `marketplace_list_installed`,
 * `marketplace_recommend`, `marketplace_install`, `marketplace_uninstall`,
 * `marketplace_create_package`) is declared once as the {@link marketplaceDomain}
 * capability set and generated onto both MCP servers by the Capability Registry
 * projection (`core/external-mcp/capability-mcp-tools.ts` and the in-session
 * `capability-mcp-tools.ts`) — there is no marketplace-specific registration
 * glue any more.
 *
 * This module owns only the {@link MarketplaceMcpDeps} bundle those capabilities
 * consume: it is constructed once at server startup in `apps/server/src/index.ts`
 * and threaded through the registry's dependency bag so tool implementations stay
 * decoupled from the rest of the server.
 *
 * @module services/marketplace-mcp/marketplace-mcp-tools
 */
import type { Logger } from '@dorkos/shared/logger';

import type { InstallerLike } from '../marketplace/marketplace-installer.js';
import type { MarketplaceSourceManager } from '../marketplace/marketplace-source-manager.js';
import type { PackageFetcher } from '../marketplace/package-fetcher.js';
import type { MarketplaceCache } from '../marketplace/marketplace-cache.js';
import type { UninstallFlow } from '../marketplace/flows/uninstall.js';
import type { AgentScopeRef } from '../marketplace/installed-scanner.js';

import type { ConfirmationProvider } from './confirmation-provider.js';

/**
 * Dependency bundle for the marketplace MCP tools. Mirrors the existing
 * `McpToolDeps` pattern in `services/runtimes/claude-code/mcp-tools/types.ts`
 * but is scoped to the marketplace surface so tool handlers do not need to
 * pull in unrelated services.
 *
 * Constructed once at server startup and threaded through the Capability
 * Registry's dependency bag, from which the marketplace capabilities read it.
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
