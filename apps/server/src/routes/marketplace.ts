/**
 * Marketplace management routes -- sources, cache status, installed
 * package listing, plus package discovery/preview/install/uninstall/update
 * and the all-packages update check under `/api/marketplace/*`.
 *
 * The router is constructed via a factory that injects its dependencies
 * (source manager, cache, fetcher, installer, uninstall flow, update flow,
 * dorkHome) so the same factory can be exercised under supertest without
 * touching the real filesystem.
 *
 * @module routes/marketplace
 */
import { Router } from 'express';
import type { MarketplaceCache } from '../services/marketplace/cache/marketplace-cache.js';
import type { PackageCacheRetention } from '../services/marketplace/cache/package-cache-retention.js';
import type { MarketplaceSourceManager } from '../services/marketplace/sources/marketplace-source-manager.js';
import type { PackageFetcher } from '../services/marketplace/package-fetcher.js';
import type { InstallerLike } from '../services/marketplace/installer/marketplace-installer.js';
import type { GlobalConsentRecorder } from '../services/marketplace/consent/global-plugin-consent.js';
import type { AskAboutWithheldGlobalPluginsOptions } from '../services/marketplace/consent/ask-withheld-global-plugins.js';
import type { ConfirmationProvider } from '../services/marketplace-mcp/confirmation-provider.js';
import type { UninstallFlow } from '../services/marketplace/flows/uninstall/uninstall.js';
import type { UpdateFlow } from '../services/marketplace/flows/update.js';
import type { NotifyPluginsChanged } from '../services/marketplace/types.js';
import type { AgentScopeRef } from '../services/marketplace/installed-scanner.js';
import type { CapabilityRegistry } from '../services/core/capabilities/index.js';
import { createRouteContext } from './marketplace/context.js';
import { mountCacheRoutes } from './marketplace/cache.js';
import { mountHeldBackRoutes } from './marketplace/held-back.js';
import { mountInstalledRoutes } from './marketplace/installed.js';
import { mountPackageActionRoutes } from './marketplace/package-actions.js';
import { mountPackageRoutes } from './marketplace/packages.js';
import { mountSourceRoutes } from './marketplace/sources.js';
import { mountUpdateRoutes } from './marketplace/updates.js';

/** Dependencies injected into {@link createMarketplaceRouter}. */
export interface MarketplaceRouteDeps {
  /** Source manager for marketplaces.json CRUD. */
  sourceManager: MarketplaceSourceManager;
  /** Cache abstraction for marketplace.json documents and cloned packages. */
  cache: MarketplaceCache;
  /** The package cache's retention owner; `POST /cache/prune` runs its sweep. */
  cacheRetention: PackageCacheRetention;
  /** Fetcher that resolves marketplace.json documents and package clones. */
  fetcher: PackageFetcher;
  /** Installer orchestrator for preview and install dispatch. */
  installer: InstallerLike;
  /** Uninstall flow — removes installed packages. */
  uninstallFlow: UninstallFlow;
  /** Update flow — advisory-by-default update checker and applier. */
  updateFlow: UpdateFlow;
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
  /**
   * The composed capability registry, read lazily because it is built AFTER this
   * router (`index.ts`) — the same late-bound read the approval service uses.
   *
   * These routes perform marketplace mutations directly rather than through
   * `registry.invoke`, because they own a response contract the cockpit and the
   * CLI already depend on. They therefore have to reach the tier gate explicitly,
   * through `authorizeCapability`. Returning `undefined` here means the registry
   * is not composed yet, which FAILS CLOSED for a destructive route rather than
   * waving it through — see {@link createMarketplaceRouter}.
   */
  capabilityRegistry: () => CapabilityRegistry | undefined;
  /**
   * Fired after a successful install, uninstall or applied update. Carries the
   * change context (which package, which action, and the project root for a
   * project-scoped change) so the handler can both refresh the runtime plugin
   * cache and project the plugin's assets to the project's other harnesses
   * (Harness Sync auto-projection, GAP-4). `projectPath` is `undefined` for a
   * global install/uninstall. Required, and the same notifier the marketplace
   * MCP tools receive, so neither surface can skip it (DOR-2057).
   */
  onPluginsChanged: NotifyPluginsChanged;
  /**
   * The server's one marketplace confirmation provider, shared with the MCP
   * tools: an agent's update over HTTP raises the same approval card, bound
   * the same way, as `marketplace_update` does (DOR-2306).
   */
  confirmationProvider: ConfirmationProvider;
  /**
   * Records a person's approval of what a global package runs, where they gave
   * it (their own install or update), so it loads into sessions without a
   * second card (`global-plugin-consent.ts`, DOR-2306).
   */
  consent: GlobalConsentRecorder;
  /**
   * How a held-back global package's card is raised when a person asks for it
   * (the Installed view's Review button), and what runs after a yes: the
   * approval primitive and the plugin refresh (DOR-2306).
   */
  heldBackCards: Pick<AskAboutWithheldGlobalPluginsOptions, 'approvals' | 'onGranted'>;
  /**
   * List the registered agents whose project directories the cross-scope
   * installed scan should walk (typically `meshCore.listWithPaths()`). When
   * absent — mesh disabled or not yet initialized — the installed listing
   * falls back to global scopes only.
   */
  listAgentScopes?: () => AgentScopeRef[];
}

export type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';

/**
 * Create the marketplace management router.
 *
 * Registers the following endpoints under the caller-chosen mount point
 * (typically `/api/marketplace`):
 *
 * - `GET /sources` — list configured marketplace sources
 * - `POST /sources` — add a new source and fetch its listing once (operator-only; agents are refused)
 * - `DELETE /sources/:name` — remove a source (operator-only; agents are refused)
 * - `POST /sources/:name/refresh` — force refetch of a source's marketplace.json
 * - `GET /installed` — list installed packages across scopes (or one project via `?projectPath`)
 * - `GET /installed/:name` — every installation of a package, one entry per scope
 * - `GET /cache` — cache status
 * - `DELETE /cache` — clear cache
 * - `GET /packages` — aggregate packages from every enabled marketplace
 * - `GET /packages/:name` — fetch and validate a single package
 * - `POST /packages/:name/preview` — build a permission preview without installing
 * - `POST /packages/:name/install` — install a package
 * - `POST /packages/:name/uninstall` — uninstall a package
 * - `POST /packages/:name/update` — advisory update check of one package
 * - `GET /updates` — advisory update check of every installation in view, with what each new version runs
 * - `POST /updates` — reinstall exactly the installations a person was shown, held to what they saw
 *
 * @param deps - Injected dependencies (source manager, cache, fetcher,
 *   installer, uninstall flow, update flow, dorkHome).
 */
export function createMarketplaceRouter(deps: MarketplaceRouteDeps): Router {
  const router = Router();
  const ctx = createRouteContext(deps);
  // Registered in this order, which is the order Express matches them in.
  mountSourceRoutes(router, deps, ctx);
  mountInstalledRoutes(router, deps, ctx);
  mountCacheRoutes(router, deps, ctx);
  mountPackageRoutes(router, deps, ctx);
  mountPackageActionRoutes(router, deps, ctx);
  mountUpdateRoutes(router, deps, ctx);
  mountHeldBackRoutes(router, deps, ctx);
  return router;
}
