/**
 * The marketplace's reads on `/api/marketplace/*` as capabilities the mount
 * serves (DOR-4978, ADR 261123-170830): the same paths, queries, bodies and
 * refusals the hand routes had.
 *
 * Every read is open to agents but one, as it was: the CLI an agent runs
 * (`dorkos marketplace installed`, `held-back`, `refresh`) reads them, and the
 * `marketplace_*` tools show an agent the same sources and installs. On both
 * surfaces an agent reads them without the working folder a dev-linked
 * package runs from (`marketplace-reader.ts`). The dev links name a person's
 * working folders on this computer, and no tool or command an agent runs
 * reads them, so only a person does (`http.audience: 'person'`). One package's detail (`GET /packages/{name}`)
 * stays by hand: its refusals carry `errors` and `codes` the mount cannot send.
 *
 * @module services/marketplace/doors/marketplace-read-capabilities
 */
import { z } from 'zod';
import { PageQuerySchema, nextCursorOutput } from '@dorkos/shared/paging';

import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
} from '../../core/capabilities/capability-definition.js';
import type { MarketplaceMcpDeps } from '../../marketplace-mcp/marketplace-mcp-tools.js';
import { BoundaryError, validateBoundary } from '../../../lib/boundary.js';
import { logger } from '../../../lib/logger.js';
import { computeCacheStatus } from '../cache/cache-status.js';
import { aggregatePackages } from '../aggregate-packages.js';
import { globalPackageDir } from '../consent/global-plugin-consent.js';
import { listHeldBackPackages } from '../consent/ask-withheld-global-plugins.js';
import { checkInstalledUpdates, scanUpdateView } from '../flows/update-installed.js';
import { computeProvides, scanInstallationsAcrossScopes } from '../installed-scanner.js';
import { withIntegrity } from '../lib/integrity/verify-install.js';
import { describeLastFetch } from '../sources/source-listing.js';
import {
  AggregatedPackageSchema,
  DevLinkStatusSchema,
  HeldBackPackageSchema,
  InstallationUpdatesResultSchema,
  InstalledPackageDetailSchema,
  InstalledPackageSchema,
  MarketplaceCacheStatusSchema,
  MarketplaceSourceSchema,
  SourceLastFetchSchema,
} from './marketplace-door-schemas.js';
import {
  agentIsAsking,
  heldBackWithoutFolder,
  installationForReader,
} from './marketplace-reader.js';
import { PAGES, assertMarketplaceCursor, pageInListOrder } from './marketplace-list-page.js';
import { callerReaderKey } from '../../../lib/paging/caller-reader-key.js';
import {
  marketplaceFailure,
  marketplaceRefusal,
  type MarketplaceRefusalCode,
} from './marketplace-refusals.js';

/**
 * The marketplace's services, or a throw when the marketplace did not start.
 *
 * @param deps - The composed dependency bag.
 */
function marketplaceOf(deps: CapabilityDeps): MarketplaceMcpDeps {
  if (!deps.marketplaceDeps) throw new Error('The marketplace is unavailable.');
  return deps.marketplaceDeps;
}

/**
 * Run a read, answering anything it throws but its own refusals with `code`,
 * logged as the hand route logged it.
 */
async function orRefuse<T>(
  code: MarketplaceRefusalCode,
  what: string,
  read: () => Promise<T>
): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof CapabilityToolError) throw err;
    logger.error(`[Marketplace] Failed to ${what}`, err);
    throw marketplaceRefusal(code);
  }
}

/** A query value: one string, or several when the key repeats. */
const QueryValue = z.union([z.string(), z.array(z.string())]);

/** `?projectPath`: one folder, the project whose view to read. Sent twice, it is refused. */
const ProjectPathQuery = QueryValue.optional().describe(
  'The project whose merged view to read: global installs plus its own. Send it once; a ' +
    'repeated key is refused.'
);

/** `?verify=true` adds each installation's integrity. Any other value is ignored. */
const VerifyQuery = QueryValue.optional().describe(
  "`true` adds each installation's `integrity`. Reads every shipped file."
);

/**
 * The project a read names, at the canonical path the boundary resolved, or
 * none. A repeated key and a folder outside the boundary are refused.
 *
 * @param raw - The query's `projectPath`.
 */
async function projectInView(raw: string | string[] | undefined): Promise<string | undefined> {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw marketplaceRefusal('MARKETPLACE_PROJECT_PATH_REPEATED');
  if (raw === '') return undefined;
  try {
    return await validateBoundary(raw);
  } catch (err) {
    if (err instanceof BoundaryError) throw marketplaceRefusal('MARKETPLACE_PROJECT_PATH_OUTSIDE');
    throw err;
  }
}

/** Why a read has no permission area: reading is free. */
const READ_NOTE = 'reading the marketplace; agents read the same with the marketplace_ tools';

/** `marketplace.list_sources`: every configured source and how its last fetch went. */
export const marketplaceListSourcesCapability = defineCapability({
  id: 'marketplace.list_sources',
  title: 'List package sources',
  description:
    'Every configured marketplace source with `lastFetch`: how the latest fetch of its ' +
    `listing went (never, fetched, failed or stale, with the reason).${PAGES}`,
  tier: 'observe',
  area: null,
  areaNote: READ_NOTE,
  input: PageQuerySchema,
  output: z.object({
    sources: z.array(MarketplaceSourceSchema.extend({ lastFetch: SourceLastFetchSchema })),
    nextCursor: nextCursorOutput,
  }),
  surfaces: { http: { method: 'get', path: '/api/marketplace/sources' } },
  invoke: async (deps, query) => {
    const { sourceManager, cache } = marketplaceOf(deps);
    const options = { list: 'sources', query };
    assertMarketplaceCursor(options);
    return orRefuse('MARKETPLACE_SOURCES_UNLISTED', 'list sources', async () => {
      const page = pageInListOrder(await sourceManager.list(), (source) => source.name, options);
      // From the record the fetcher keeps (DOR-2324), so a failed listing is
      // still shown after a reload.
      const listed = await Promise.all(
        page.items.map(async (source) => ({
          ...source,
          lastFetch: await describeLastFetch(cache, source.name),
        }))
      );
      return { sources: listed, nextCursor: page.nextCursor };
    });
  },
});

/** `marketplace.cache_status`: the package cache's counts and size. */
export const marketplaceCacheStatusCapability = defineCapability({
  id: 'marketplace.cache_status',
  title: 'Read the package cache',
  description:
    'How many listings and packages the cache holds, its total size, and whether its ' +
    'automatic cleanup is paused.',
  tier: 'observe',
  area: null,
  areaNote: READ_NOTE,
  input: z.object({}),
  output: MarketplaceCacheStatusSchema,
  surfaces: { http: { method: 'get', path: '/api/marketplace/cache' } },
  invoke: async (deps) => {
    const { cache, cacheRetention } = marketplaceOf(deps);
    return orRefuse('MARKETPLACE_CACHE_UNREADABLE', 'read cache status', async () => {
      if (!cacheRetention) throw new Error('The cache cleanup is not wired.');
      const status = await computeCacheStatus(cache);
      return { ...status, cleanup: cacheRetention.status() };
    });
  },
});

/** `marketplace.browse`: every package every enabled source lists. */
export const marketplaceBrowseCapability = defineCapability({
  id: 'marketplace.browse',
  title: 'Browse packages',
  description:
    'Every package listed by every enabled marketplace, each tagged with its marketplace, ' +
    'with install counts and update dates when known. One source that fails is skipped. ' +
    `Source by source, in the order each listing names its packages.${PAGES}`,
  tier: 'observe',
  area: null,
  areaNote: READ_NOTE,
  input: PageQuerySchema,
  output: z.object({ packages: z.array(AggregatedPackageSchema), nextCursor: nextCursorOutput }),
  surfaces: { http: { method: 'get', path: '/api/marketplace/packages' } },
  invoke: async (deps, query) => {
    const { sourceManager, fetcher } = marketplaceOf(deps);
    const options = { list: 'packages', query };
    assertMarketplaceCursor(options);
    try {
      const sources = await sourceManager.list();
      const all = await aggregatePackages(
        sources.filter((source) => source.enabled),
        fetcher
      );
      const page = pageInListOrder(all, (row) => `${row.marketplace}/${row.name}`, options);
      const packages = page.items;
      // Cached maps, refreshed in the background: never blocks on the network.
      // Loaded on first browse: each module builds its provider from the
      // server's settings when it loads.
      const { enrichWithInstallCounts, installCountsProvider } =
        await import('../telemetry/install-counts.js');
      const { enrichWithUpdatedAt, updatedAtProvider } = await import('../telemetry/updated-at.js');
      const withCounts = enrichWithInstallCounts(packages, installCountsProvider.getCounts());
      return {
        packages: enrichWithUpdatedAt(withCounts, updatedAtProvider.getUpdatedAt()),
        nextCursor: page.nextCursor,
      };
    } catch (err) {
      if (err instanceof CapabilityToolError) throw err;
      logger.error('[Marketplace] Failed to aggregate packages', err);
      throw marketplaceFailure(err);
    }
  },
});

/** `marketplace.list_installations`: every installation, or one project's view. */
export const marketplaceListInstallationsCapability = defineCapability({
  id: 'marketplace.list_installations',
  title: 'List installations',
  description:
    'Without projectPath, one entry per installation across all scopes, each with its ' +
    'scope and agent. With projectPath, that project’s merged view, scanned at the ' +
    'canonical path so its install paths match the update check’s. A global package held ' +
    `back from chats says so in \`heldBack\`. In scan order.${PAGES}`,
  tier: 'observe',
  area: null,
  areaNote: READ_NOTE,
  input: PageQuerySchema.extend({ projectPath: ProjectPathQuery, verify: VerifyQuery }),
  output: z.object({ packages: z.array(InstalledPackageSchema), nextCursor: nextCursorOutput }),
  surfaces: { http: { method: 'get', path: '/api/marketplace/installed' } },
  invoke: async (deps, { projectPath: rawProject, verify, ...query }, context) => {
    const market = marketplaceOf(deps);
    const readable = installationForReader(context);
    return orRefuse('MARKETPLACE_INSTALLED_UNLISTED', 'list installed packages', async () => {
      const projectPath = await projectInView(rawProject);
      // The view is bound into the cursor: a cursor for one project's view
      // does not go on in another's.
      const list = `installed:${projectPath ?? ''}`;
      const options = { list, query, sealedFor: callerReaderKey(context) };
      assertMarketplaceCursor(options);
      const records = await scanUpdateView(market, projectPath);
      // A held-back global package says so on its row (DOR-2306).
      const heldBack = new Map(
        (await listHeldBackPackages(market.dorkHome, { bindings: false })).map((held) => [
          globalPackageDir(market.dorkHome, held.name),
          {
            reason: held.reason,
            note: held.note,
            reviewable: held.reviewable,
            ...(held.linkedPath !== undefined && { linkedPath: held.linkedPath }),
          },
        ])
      );
      const packages = records.map((r) => {
        const held = r.package.scope === 'global' ? heldBack.get(r.package.installPath) : undefined;
        return held ? { ...r.package, heldBack: held } : r.package;
      });
      const page = pageInListOrder(packages, (row) => row.installPath, options);
      // Verification hashes every shipped file, so it is asked for (DOR-2197),
      // and only for the page.
      const listed = verify === 'true' ? await withIntegrity(page.items) : page.items;
      return { packages: listed.map(readable), nextCursor: page.nextCursor };
    });
  },
});

/** `marketplace.read_installed`: every installation of one package, with what it provides. */
export const marketplaceReadInstalledCapability = defineCapability({
  id: 'marketplace.read_installed',
  title: 'Read one installed package',
  description:
    'Every installation of the named package across all scopes, each with how many ' +
    'commands and skills it provides and whether it has hooks.',
  tier: 'observe',
  area: null,
  areaNote: READ_NOTE,
  input: z.object({ name: z.string(), verify: VerifyQuery }),
  output: z.object({ installations: z.array(InstalledPackageDetailSchema) }),
  surfaces: { http: { method: 'get', path: '/api/marketplace/installed/{name}' } },
  invoke: async (deps, input, context) => {
    const { dorkHome, listAgentScopes } = marketplaceOf(deps);
    const readable = installationForReader(context);
    const what = `get installed package ${input.name}`;
    return orRefuse('MARKETPLACE_INSTALLED_UNREADABLE', what, async () => {
      const all = await scanInstallationsAcrossScopes(dorkHome, listAgentScopes?.() ?? []);
      const matches = all.filter((p) => p.name === input.name);
      if (matches.length === 0) throw marketplaceRefusal('MARKETPLACE_NOT_FOUND');
      const installations = await Promise.all(
        matches.map(async (match) => ({
          ...match,
          provides: await computeProvides(match.installPath),
        }))
      );
      const read = input.verify === 'true' ? await withIntegrity(installations) : installations;
      return { installations: read.map(readable) };
    });
  },
});

/** `marketplace.check_updates`: an advisory update check of every installation in view. */
export const marketplaceCheckUpdatesCapability = defineCapability({
  id: 'marketplace.check_updates',
  title: 'Check installations for updates',
  description:
    'Advisory: one check per installation in view, and nothing installed changes. Without ' +
    'projectPath, every installation in every scope; with it, that project’s merged view. ' +
    'A newer version carries `disclosed`, what it runs on its own, which an apply sends back.',
  tier: 'observe',
  area: null,
  areaNote: READ_NOTE,
  input: z.object({ projectPath: ProjectPathQuery }),
  output: InstallationUpdatesResultSchema,
  surfaces: { http: { method: 'get', path: '/api/marketplace/updates' } },
  invoke: async (deps, input) => {
    const market = marketplaceOf(deps);
    try {
      return await checkInstalledUpdates(market, await projectInView(input.projectPath));
    } catch (err) {
      if (err instanceof CapabilityToolError) throw err;
      logger.error('[Marketplace] Failed to check installed packages for updates', err);
      throw marketplaceFailure(err);
    }
  },
});

/** `marketplace.list_held_back`: global packages held back from every session, and why. */
export const marketplaceListHeldBackCapability = defineCapability({
  id: 'marketplace.list_held_back',
  title: 'List held-back packages',
  description:
    'Every global package held back from chats until a person approves it: why, what ' +
    `it runs, and \`bindsTo\`, what a decision is bound to. Only a person decides.${PAGES}`,
  tier: 'observe',
  area: null,
  areaNote: READ_NOTE,
  input: PageQuerySchema,
  output: z.object({ packages: z.array(HeldBackPackageSchema), nextCursor: nextCursorOutput }),
  surfaces: { http: { method: 'get', path: '/api/marketplace/held-back' } },
  invoke: async (deps, query, context) => {
    const { dorkHome } = marketplaceOf(deps);
    const options = { list: 'held-back', query, sealedFor: callerReaderKey(context) };
    assertMarketplaceCursor(options);
    return orRefuse('MARKETPLACE_HELD_BACK_UNLISTED', 'list held-back packages', async () => {
      const page = pageInListOrder(await listHeldBackPackages(dorkHome), (p) => p.name, options);
      const packages = agentIsAsking(context) ? page.items.map(heldBackWithoutFolder) : page.items;
      return { packages, nextCursor: page.nextCursor };
    });
  },
});

/** `marketplace.list_dev_links`: every package running from a folder, a person's read. */
export const marketplaceListDevLinksCapability = defineCapability({
  id: 'marketplace.list_dev_links',
  title: 'List dev links',
  description:
    'Every package running from a folder on this computer, and whether its link is in ' +
    `force. \`registryUnreadable\` is set when the record of links can’t be read.${PAGES}`,
  tier: 'observe',
  area: null,
  areaNote: 'folders on this computer; only a person reads them',
  input: PageQuerySchema,
  output: z.object({
    links: z.array(DevLinkStatusSchema),
    registryUnreadable: z.string().optional(),
    nextCursor: nextCursorOutput,
  }),
  surfaces: { http: { method: 'get', path: '/api/marketplace/dev-links', audience: 'person' } },
  invoke: async (deps, query) => {
    const { devLinks } = marketplaceOf(deps);
    if (!devLinks) throw marketplaceRefusal('MARKETPLACE_DEV_LINKS_UNAVAILABLE');
    const options = { list: 'dev-links', query };
    assertMarketplaceCursor(options);
    return orRefuse('MARKETPLACE_DEV_LINKS_UNLISTED', 'list dev links', async () => {
      const { links, ...listing } = await devLinks.list();
      const page = pageInListOrder(links, (link) => `${link.scope}/${link.name}`, options);
      return { ...listing, links: page.items, nextCursor: page.nextCursor };
    });
  },
});

/** The marketplace's reads, in the order the mount serves them. */
const MARKETPLACE_READ_CAPABILITIES = [
  marketplaceListSourcesCapability,
  marketplaceCacheStatusCapability,
  marketplaceBrowseCapability,
  marketplaceListInstallationsCapability,
  marketplaceReadInstalledCapability,
  marketplaceCheckUpdatesCapability,
  marketplaceListHeldBackCapability,
  marketplaceListDevLinksCapability,
] as const;

/**
 * The marketplace's reads on `/api/marketplace/*`: a second `marketplace`
 * domain beside the tools' (`marketplace-mcp/marketplace-capabilities.ts`),
 * over the same services, which the composition root
 * (`core/self-description/dorkos-registry.ts`) adds whenever it adds those.
 */
export const marketplaceReadsDomain: CapabilityDomain = {
  name: 'marketplace',
  assertDeps: marketplaceOf,
  capabilities: [...MARKETPLACE_READ_CAPABILITIES],
};
