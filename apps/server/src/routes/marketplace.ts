/**
 * Marketplace management routes -- sources, cache status, installed
 * package listing, plus package discovery/preview/install/uninstall/update
 * under `/api/marketplace/*`.
 *
 * The router is constructed via a factory that injects its dependencies
 * (source manager, cache, fetcher, installer, uninstall flow, update flow,
 * dorkHome) so the same factory can be exercised under supertest without
 * touching the real filesystem.
 *
 * @module routes/marketplace
 */
import { Router } from 'express';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { MarketplaceJsonEntry, PackageType } from '@dorkos/marketplace';
import { PACKAGE_MANIFEST_PATH } from '@dorkos/marketplace/constants';
import { validatePackage } from '@dorkos/marketplace/package-validator';
import { logger } from '../lib/logger.js';
import type { MarketplaceCache, CachedPackage } from '../services/marketplace/marketplace-cache.js';
import type { MarketplaceSourceManager } from '../services/marketplace/marketplace-source-manager.js';
import type { PackageFetcher } from '../services/marketplace/package-fetcher.js';
import type { InstallerLike } from '../services/marketplace/marketplace-installer.js';
import {
  ConflictError,
  InvalidPackageError,
} from '../services/marketplace/marketplace-installer.js';
import {
  PackageNotFoundError,
  MarketplaceNotFoundError,
} from '../services/marketplace/package-resolver.js';
import {
  PackageNotInstalledError,
  type UninstallFlow,
} from '../services/marketplace/flows/uninstall.js';
import type { UpdateFlow } from '../services/marketplace/flows/update.js';
import type { MarketplaceSource } from '../services/marketplace/types.js';

/** Dependencies injected into {@link createMarketplaceRouter}. */
export interface MarketplaceRouteDeps {
  /** Source manager for marketplaces.json CRUD. */
  sourceManager: MarketplaceSourceManager;
  /** Cache abstraction for marketplace.json documents and cloned packages. */
  cache: MarketplaceCache;
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
}

/**
 * A single marketplace entry augmented with the marketplace source name
 * it was discovered in. Returned by `GET /api/marketplace/packages`.
 */
export type AggregatedPackage = MarketplaceJsonEntry & { marketplace: string };

/**
 * Summary of an installed marketplace package as surfaced by
 * `GET /api/marketplace/installed`.
 */
export interface InstalledPackage {
  /** Package name from `.dork/manifest.json`. */
  name: string;
  /** Package version from `.dork/manifest.json`. */
  version: string;
  /** Package type (plugin, agent, skill-pack, adapter). */
  type: PackageType;
  /** Absolute path to the package root directory. */
  installPath: string;
  /** Marketplace source the package was installed from, if known. */
  installedFrom?: string;
  /** ISO timestamp when the package was installed, if known. */
  installedAt?: string;
}

const AddSourceBodySchema = z.object({
  name: z.string().min(1).max(128),
  source: z.string().min(1),
  enabled: z.boolean().optional(),
});

/**
 * Body schema for `POST /api/marketplace/packages/:name/preview` and
 * `POST /api/marketplace/packages/:name/install` — everything on
 * {@link InstallRequest} except `name`, which is taken from the URL
 * param.
 */
const InstallRequestBodySchema = z.object({
  marketplace: z.string().optional(),
  source: z.string().optional(),
  force: z.boolean().optional(),
  yes: z.boolean().optional(),
  projectPath: z.string().optional(),
});

/** Body schema for `POST /api/marketplace/packages/:name/uninstall`. */
const UninstallRequestBodySchema = z.object({
  purge: z.boolean().optional(),
  projectPath: z.string().optional(),
});

/** Body schema for `POST /api/marketplace/packages/:name/update`. */
const UpdateRequestBodySchema = z.object({
  apply: z.boolean().optional(),
  projectPath: z.string().optional(),
});

/** Body schema for `POST /api/marketplace/cache/prune`. */
const PruneCacheBodySchema = z.object({
  keepLastN: z.number().int().nonnegative().optional(),
});

/** Query schema for `GET /api/marketplace/packages/:name`. */
const GetPackageQuerySchema = z.object({
  marketplace: z.string().optional(),
});

/**
 * Centralized error → HTTP status mapping. Shared by every install-related
 * handler so the translation rules stay in one place and the telemetry
 * remains consistent across endpoints.
 *
 * @param err - The error thrown by the installer, uninstall flow, update
 *   flow, resolver, or fetcher.
 * @returns The HTTP status and response body to send.
 */
function mapErrorToStatus(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof InvalidPackageError) {
    return { status: 400, body: { error: err.message, errors: err.errors } };
  }
  if (err instanceof ConflictError) {
    return { status: 409, body: { error: err.message, conflicts: err.conflicts } };
  }
  if (err instanceof PackageNotInstalledError) {
    return { status: 404, body: { error: err.message } };
  }
  if (err instanceof PackageNotFoundError) {
    return { status: 404, body: { error: err.message } };
  }
  if (err instanceof MarketplaceNotFoundError) {
    return { status: 404, body: { error: err.message } };
  }
  return {
    status: 500,
    body: { error: err instanceof Error ? err.message : String(err) },
  };
}

/**
 * Create the marketplace management router.
 *
 * Registers the following endpoints under the caller-chosen mount point
 * (typically `/api/marketplace`):
 *
 * - `GET /sources` — list configured marketplace sources
 * - `POST /sources` — add a new source
 * - `DELETE /sources/:name` — remove a source
 * - `POST /sources/:name/refresh` — force refetch of a source's marketplace.json
 * - `GET /installed` — list installed packages
 * - `GET /installed/:name` — get a single installed package
 * - `GET /cache` — cache status
 * - `DELETE /cache` — clear cache
 * - `GET /packages` — aggregate packages from every enabled marketplace
 * - `GET /packages/:name` — fetch and validate a single package
 * - `POST /packages/:name/preview` — build a permission preview without installing
 * - `POST /packages/:name/install` — install a package
 * - `POST /packages/:name/uninstall` — uninstall a package
 * - `POST /packages/:name/update` — advisory update check (with `apply: true` option)
 *
 * @param deps - Injected dependencies (source manager, cache, fetcher,
 *   installer, uninstall flow, update flow, dorkHome).
 */
export function createMarketplaceRouter(deps: MarketplaceRouteDeps): Router {
  const { sourceManager, cache, fetcher, installer, uninstallFlow, updateFlow, dorkHome } = deps;
  const router = Router();

  // GET /sources -- list configured marketplace sources
  router.get('/sources', async (_req, res) => {
    try {
      const sources = await sourceManager.list();
      res.json({ sources });
    } catch (err) {
      logger.error('[Marketplace] Failed to list sources', err);
      res.status(500).json({ error: 'Failed to list marketplace sources' });
    }
  });

  // POST /sources -- add a new marketplace source
  router.post('/sources', async (req, res) => {
    const parsed = AddSourceBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    try {
      const created = await sourceManager.add(parsed.data);
      return res.status(201).json(created);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add marketplace source';
      if (message.includes('already exists')) {
        return res.status(409).json({ error: message });
      }
      logger.error('[Marketplace] Failed to add source', err);
      return res.status(500).json({ error: 'Failed to add marketplace source' });
    }
  });

  // DELETE /sources/:name -- remove a marketplace source
  router.delete('/sources/:name', async (req, res) => {
    try {
      await sourceManager.remove(req.params.name);
      res.status(204).send();
    } catch (err) {
      logger.error(`[Marketplace] Failed to remove source ${req.params.name}`, err);
      res.status(500).json({ error: 'Failed to remove marketplace source' });
    }
  });

  // POST /sources/:name/refresh -- force refetch of a source's marketplace.json
  router.post('/sources/:name/refresh', async (req, res) => {
    try {
      const source = await sourceManager.get(req.params.name);
      if (!source) {
        return res.status(404).json({ error: `Marketplace source '${req.params.name}' not found` });
      }

      const marketplace = await fetcher.fetchMarketplaceJson(source);
      return res.json({ marketplace, fetchedAt: new Date().toISOString() });
    } catch (err) {
      logger.error(`[Marketplace] Failed to refresh source ${req.params.name}`, err);
      const message = err instanceof Error ? err.message : 'Failed to refresh marketplace source';
      return res.status(502).json({ error: message });
    }
  });

  // GET /installed -- list installed packages from ${dorkHome}/plugins and /agents
  router.get('/installed', async (_req, res) => {
    try {
      const packages = await listInstalledPackages(dorkHome);
      res.json({ packages });
    } catch (err) {
      logger.error('[Marketplace] Failed to list installed packages', err);
      res.status(500).json({ error: 'Failed to list installed packages' });
    }
  });

  // GET /installed/:name -- get a specific installed package
  router.get('/installed/:name', async (req, res) => {
    try {
      const packages = await listInstalledPackages(dorkHome);
      const match = packages.find((p) => p.name === req.params.name);
      if (!match) {
        return res.status(404).json({ error: `Installed package '${req.params.name}' not found` });
      }
      return res.json({ package: match });
    } catch (err) {
      logger.error(`[Marketplace] Failed to get installed package ${req.params.name}`, err);
      return res.status(500).json({ error: 'Failed to get installed package' });
    }
  });

  // GET /cache -- cache status (marketplace count, package count, total bytes)
  router.get('/cache', async (_req, res) => {
    try {
      const status = await computeCacheStatus(cache);
      res.json(status);
    } catch (err) {
      logger.error('[Marketplace] Failed to read cache status', err);
      res.status(500).json({ error: 'Failed to read cache status' });
    }
  });

  // DELETE /cache -- wipe the marketplace cache
  router.delete('/cache', async (_req, res) => {
    try {
      await cache.clear();
      res.status(204).send();
    } catch (err) {
      logger.error('[Marketplace] Failed to clear cache', err);
      res.status(500).json({ error: 'Failed to clear marketplace cache' });
    }
  });

  // POST /cache/prune -- garbage-collect cached packages by keepLastN
  router.post('/cache/prune', async (req, res) => {
    const parsed = PruneCacheBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    try {
      // Snapshot package sizes before pruning so we can report freed bytes —
      // the descriptors returned from `prune()` point at deleted directories
      // that can no longer be stat'd.
      const sizesBeforePrune = new Map<string, number>();
      const cachedBefore = await cache.listPackages();
      await Promise.all(
        cachedBefore.map(async (pkg) => {
          sizesBeforePrune.set(pkg.path, await sumDirectorySize(pkg.path));
        })
      );

      const { removed } = await cache.prune(parsed.data);
      const freedBytes = removed.reduce(
        (sum, pkg) => sum + (sizesBeforePrune.get(pkg.path) ?? 0),
        0
      );

      return res.json({
        removed: removed.map((pkg) => ({
          packageName: pkg.packageName,
          commitSha: pkg.commitSha,
          path: pkg.path,
          cachedAt: pkg.cachedAt.toISOString(),
        })),
        freedBytes,
      });
    } catch (err) {
      logger.error('[Marketplace] Failed to prune cache', err);
      return res.status(500).json({ error: 'Failed to prune marketplace cache' });
    }
  });

  // GET /packages -- aggregate packages from every enabled marketplace
  router.get('/packages', async (_req, res) => {
    try {
      const sources = await sourceManager.list();
      const enabled = sources.filter((source) => source.enabled);
      const packages = await aggregatePackages(enabled, fetcher);
      res.json({ packages });
    } catch (err) {
      logger.error('[Marketplace] Failed to aggregate packages', err);
      const mapped = mapErrorToStatus(err);
      res.status(mapped.status).json(mapped.body);
    }
  });

  // GET /packages/:name -- fetch and validate a single package entry
  router.get('/packages/:name', async (req, res) => {
    const parsedQuery = GetPackageQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: parsedQuery.error.flatten() });
    }

    try {
      const { preview, manifest, packagePath } = await installer.preview({
        name: req.params.name,
        marketplace: parsedQuery.data.marketplace,
      });
      return res.json({ manifest, packagePath, preview });
    } catch (err) {
      logger.error(`[Marketplace] Failed to fetch package ${req.params.name}`, err);
      const mapped = mapErrorToStatus(err);
      return res.status(mapped.status).json(mapped.body);
    }
  });

  // POST /packages/:name/preview -- build a PermissionPreview without installing
  router.post('/packages/:name/preview', async (req, res) => {
    const parsed = InstallRequestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    try {
      const { preview, manifest, packagePath } = await installer.preview({
        name: req.params.name,
        ...parsed.data,
      });
      return res.json({ preview, manifest, packagePath });
    } catch (err) {
      logger.error(`[Marketplace] Failed to preview package ${req.params.name}`, err);
      const mapped = mapErrorToStatus(err);
      return res.status(mapped.status).json(mapped.body);
    }
  });

  // POST /packages/:name/install -- install a marketplace package
  //
  // TODO: SSE clone progress (see services/discovery/scan-stream pattern).
  // The spec mentions optional streaming for clone progress; we ship the
  // unary JSON response first and will wire a dedicated `/install/stream`
  // variant in a follow-up rather than ship a half-implemented SSE here.
  router.post('/packages/:name/install', async (req, res) => {
    const parsed = InstallRequestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    try {
      const result = await installer.install({
        name: req.params.name,
        ...parsed.data,
      });
      return res.json(result);
    } catch (err) {
      logger.error(`[Marketplace] Failed to install package ${req.params.name}`, err);
      const mapped = mapErrorToStatus(err);
      return res.status(mapped.status).json(mapped.body);
    }
  });

  // POST /packages/:name/uninstall -- remove an installed package
  router.post('/packages/:name/uninstall', async (req, res) => {
    const parsed = UninstallRequestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    try {
      const result = await uninstallFlow.uninstall({
        name: req.params.name,
        ...parsed.data,
      });
      return res.json(result);
    } catch (err) {
      logger.error(`[Marketplace] Failed to uninstall package ${req.params.name}`, err);
      const mapped = mapErrorToStatus(err);
      return res.status(mapped.status).json(mapped.body);
    }
  });

  // POST /packages/:name/update -- advisory update check (pass apply:true to apply)
  router.post('/packages/:name/update', async (req, res) => {
    const parsed = UpdateRequestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    try {
      const result = await updateFlow.run({
        name: req.params.name,
        ...parsed.data,
      });
      return res.json(result);
    } catch (err) {
      logger.error(`[Marketplace] Failed to update package ${req.params.name}`, err);
      const mapped = mapErrorToStatus(err);
      return res.status(mapped.status).json(mapped.body);
    }
  });

  return router;
}

/**
 * Aggregate package entries from every enabled marketplace source into a
 * single flat list, tagging each entry with its origin marketplace name.
 * A single marketplace fetch failure is logged and skipped so one broken
 * source never blocks the whole listing.
 */
async function aggregatePackages(
  sources: MarketplaceSource[],
  fetcher: PackageFetcher
): Promise<AggregatedPackage[]> {
  const results: AggregatedPackage[] = [];
  for (const source of sources) {
    try {
      const json = await fetcher.fetchMarketplaceJson(source);
      for (const entry of json.plugins) {
        results.push({ ...entry, marketplace: source.name });
      }
    } catch (err) {
      logger.warn(
        `[Marketplace] Failed to fetch marketplace.json for ${source.name}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  return results;
}

/**
 * Walk `${dorkHome}/plugins/*` and `${dorkHome}/agents/*`, read each
 * `.dork/manifest.json`, and return the resulting {@link InstalledPackage}
 * list. Directories without a readable manifest are skipped silently.
 */
async function listInstalledPackages(dorkHome: string): Promise<InstalledPackage[]> {
  const roots = [join(dorkHome, 'plugins'), join(dorkHome, 'agents')];
  const results: InstalledPackage[] = [];

  for (const root of roots) {
    const entries = await safeReaddir(root);
    for (const entry of entries) {
      const packagePath = join(root, entry);
      const installed = await readInstalledPackage(packagePath);
      if (installed) {
        results.push(installed);
      }
    }
  }

  return results;
}

/**
 * Read a single installed package's `.dork/manifest.json` and translate it
 * into an {@link InstalledPackage} summary. Returns `null` when the manifest
 * is missing, unreadable, or fails validation so the walker can skip silently.
 */
async function readInstalledPackage(packagePath: string): Promise<InstalledPackage | null> {
  const manifestPath = join(packagePath, PACKAGE_MANIFEST_PATH);
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const shallow = parsed as Partial<{
    name: unknown;
    version: unknown;
    type: unknown;
    installedFrom: unknown;
    installedAt: unknown;
  }>;

  if (
    typeof shallow.name !== 'string' ||
    typeof shallow.version !== 'string' ||
    typeof shallow.type !== 'string'
  ) {
    // Fall through to validatePackage for a second opinion; if that fails too,
    // the package is malformed and we skip it.
    const validated = await validatePackage(packagePath);
    if (!validated.ok || !validated.manifest) {
      return null;
    }
    return {
      name: validated.manifest.name,
      version: validated.manifest.version,
      type: validated.manifest.type,
      installPath: packagePath,
    };
  }

  return {
    name: shallow.name,
    version: shallow.version,
    type: shallow.type as PackageType,
    installPath: packagePath,
    ...(typeof shallow.installedFrom === 'string' && { installedFrom: shallow.installedFrom }),
    ...(typeof shallow.installedAt === 'string' && { installedAt: shallow.installedAt }),
  };
}

/** Compute counts + total size of the marketplace cache. */
async function computeCacheStatus(cache: MarketplaceCache): Promise<{
  marketplaces: number;
  packages: number;
  totalSizeBytes: number;
}> {
  const marketplacesRoot = join(cache.cacheRoot, 'marketplaces');
  const marketplaceDirs = await safeReaddir(marketplacesRoot);
  const packages = await cache.listPackages();

  const [marketplacesBytes, packagesBytes] = await Promise.all([
    sumDirectorySize(marketplacesRoot),
    sumPackageSizes(packages),
  ]);

  return {
    marketplaces: marketplaceDirs.length,
    packages: packages.length,
    totalSizeBytes: marketplacesBytes + packagesBytes,
  };
}

/** Sum the recursive size of every file under `root`. Returns 0 if absent. */
async function sumDirectorySize(root: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry);
      try {
        const info = await stat(entryPath);
        if (info.isDirectory()) {
          await walk(entryPath);
        } else if (info.isFile()) {
          total += info.size;
        }
      } catch {
        // Race with prune/clear — skip silently.
      }
    }
  };
  await walk(root);
  return total;
}

/** Sum the recursive size of every cached package directory. */
async function sumPackageSizes(packages: CachedPackage[]): Promise<number> {
  let total = 0;
  for (const pkg of packages) {
    total += await sumDirectorySize(pkg.path);
  }
  return total;
}

/** `fs.readdir` that swallows ENOENT so callers can walk optional trees. */
async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
