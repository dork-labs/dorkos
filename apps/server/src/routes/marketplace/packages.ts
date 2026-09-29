/**
 * Marketplace routes: `/packages` and `/packages/:name`: browse every enabled marketplace and read one package.
 *
 * @module routes/marketplace/packages
 */
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  mergeMarketplace,
  primaryCategory,
  type MergedMarketplaceEntry,
  type PluginSource,
} from '@dorkos/marketplace';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { logger } from '../../lib/logger.js';
import type { PackageFetcher } from '../../services/marketplace/package-fetcher.js';
import { disclosedEffectsOf } from '../../services/marketplace/preview/disclosed-effects.js';
import { packageContentHash } from '../../services/marketplace/lib/content-hash.js';
import {
  installCountsProvider,
  enrichWithInstallCounts,
} from '../../services/marketplace/telemetry/install-counts.js';
import {
  updatedAtProvider,
  enrichWithUpdatedAt,
} from '../../services/marketplace/telemetry/updated-at.js';
import type { MarketplaceSource } from '../../services/marketplace/types.js';
import type { MarketplaceRouteDeps } from '../marketplace.js';
import type { MarketplaceRouteContext } from './context.js';
import { mapErrorToStatus, safeReaddir } from './shared.js';
import type { Router } from 'express';

/** Query schema for `GET /api/marketplace/packages/:name`. */
const GetPackageQuerySchema = z.object({
  marketplace: z.string().optional(),
});

/**
 * Aggregate package entries from every enabled marketplace source into a
 * single flat list, tagging each entry with its origin marketplace name.
 * A single marketplace fetch failure is logged and skipped so one broken
 * source never blocks the whole listing.
 *
 * On completion, logs an info summary of `source → plugin count` for
 * every source — including zero-count sources — so the "empty results"
 * case is self-explanatory in logs without having to grep for warnings.
 */
async function aggregatePackages(
  sources: MarketplaceSource[],
  fetcher: PackageFetcher
): Promise<AggregatedPackage[]> {
  const results: AggregatedPackage[] = [];
  const breakdown: Record<string, number | string> = {};
  for (const source of sources) {
    try {
      const [json, sidecar] = await Promise.all([
        fetcher.fetchMarketplaceJson(source),
        fetcher.fetchDorkosSidecar(source),
      ]);
      const { entries, orphans } = mergeMarketplace(json, sidecar);
      if (orphans.length > 0) {
        logger.warn('[Marketplace] Orphan sidecar entries', {
          marketplace: source.name,
          orphans,
        });
      }
      for (const entry of entries) {
        results.push(flattenMergedEntry(entry, source.name, source.source));
      }
      breakdown[source.name] = entries.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      breakdown[source.name] = `error: ${message}`;
      logger.warn(`[Marketplace] Failed to fetch marketplace for ${source.name}: ${message}`);
    }
  }
  logger.info('[Marketplace] Aggregated packages from enabled sources', {
    totalPlugins: results.length,
    sourceCount: sources.length,
    perSource: breakdown,
  });
  return results;
}

/**
 * Convert a {@link PluginSource} discriminated union into a giget-compatible
 * template reference string.
 *
 * Handles all five source forms:
 * - **Relative path** (string starting with `./`) — resolved against the
 *   marketplace source URL. E.g. marketplace `https://github.com/dork-labs/marketplace`
 *   + source `./plugins/security-auditor` → `github:dork-labs/marketplace/plugins/security-auditor`.
 * - **GitHub** — `github:owner/repo`
 * - **URL** — the clone URL as-is
 * - **Git subdir** — the clone URL as-is (subpath handled at install time)
 * - **npm** — not supported for template download; passes `npm:<package>` so
 *   downstream callers produce a clear error rather than a cryptic git failure.
 *
 * @internal Exported for testing only.
 */
export function resolvePackageSource(entrySource: PluginSource, marketplaceUrl: string): string {
  // String source = relative path (e.g. `./plugins/foo`) or bare name
  if (typeof entrySource === 'string') {
    if (!entrySource.startsWith('./') && !entrySource.startsWith('../')) return entrySource;

    const ghMatch = marketplaceUrl.match(/github\.com\/([^/]+\/[^/.]+)/);
    if (!ghMatch) return entrySource; // Can't resolve — pass through as-is

    const orgRepo = ghMatch[1];
    const subpath = entrySource.replace(/^\.\//, '');
    return `github:${orgRepo}/${subpath}`;
  }

  // Object source — dispatch on discriminator
  switch (entrySource.source) {
    case 'github':
      return `github:${entrySource.repo}`;
    case 'url':
      return entrySource.url;
    case 'git-subdir':
      return entrySource.url;
    case 'npm':
      return `npm:${entrySource.package}`;
  }
}

/**
 * Flatten a {@link MergedMarketplaceEntry} (CC fields + nested DorkOS sidecar)
 * into the flat {@link AggregatedPackage} shape expected by the client.
 */
function flattenMergedEntry(
  entry: MergedMarketplaceEntry,
  marketplace: string,
  marketplaceUrl: string
): AggregatedPackage {
  return {
    name: entry.name,
    displayName: entry.dorkos?.displayName,
    source: resolvePackageSource(entry.source, marketplaceUrl),
    description: entry.description,
    version: entry.version,
    author: typeof entry.author === 'object' ? entry.author?.name : undefined,
    homepage: entry.homepage,
    repository: entry.repository,
    license: entry.license,
    keywords: entry.keywords,
    categories: entry.dorkos?.categories,
    // Primary category prefers the sidecar's categories[0], falling back to the
    // CC-inline singular category so single-category consumers keep working.
    category: primaryCategory(entry.dorkos?.categories, entry.category),
    tags: entry.tags,
    type: entry.dorkos?.type,
    // Gated on type so the AggregatedPackage contract ("present only for
    // adapter packages") is enforced here, not merely documented — a sidecar
    // that sets adapterType on a non-adapter entry does not leak it downstream.
    adapterType: entry.dorkos?.type === 'adapter' ? entry.dorkos.adapterType : undefined,
    icon: entry.dorkos?.icon,
    featured: entry.dorkos?.featured,
    marketplace,
  };
}

/**
 * Hard cap on the README payload the detail endpoint returns (200 KB). READMEs
 * are a preview surface, not a source of truth — at most this many bytes are
 * ever read from disk, so a pathological file cannot balloon server memory.
 */
const MAX_README_BYTES = 200 * 1024;

/**
 * Read a package's root `README.md` from its staged directory for the detail
 * endpoint. The match is case-insensitive (`README.md`, `readme.md`, …) and
 * restricted to the package root — nested READMEs are ignored. The package is
 * already cloned locally by the installer's preview step, so this is a pure
 * filesystem read with no network access.
 *
 * Staged packages are third-party content from ANY user-added marketplace, so
 * the read is hardened:
 *
 * - **Symlinked READMEs are treated as absent.** Clones preserve symlinks, so
 *   a malicious package could otherwise commit `README.md` as a link to a
 *   sensitive file (e.g. `~/.dork/config.json`) and exfiltrate its contents at
 *   detail-view time — before any install consent. `lstat` never follows links.
 * - **The read itself is bounded.** At most {@link MAX_README_BYTES} are read
 *   through a `FileHandle` into a preallocated buffer — an attacker-sized
 *   README never loads fully into memory.
 * - **Truncation is UTF-8 safe.** A byte-offset cut can split a multibyte
 *   character; any trailing partial sequence is dropped so the payload never
 *   ends in a U+FFFD replacement glyph.
 *
 * Returns `undefined` when no README exists, the entry is not a regular file,
 * or the content is empty/whitespace, so the caller can omit the field
 * entirely. Read errors are swallowed — the detail endpoint never fails over
 * a preview.
 *
 * @param packagePath - Absolute path to the staged package directory.
 */
async function readPackageReadme(packagePath: string): Promise<string | undefined> {
  const entries = await safeReaddir(packagePath);
  const match = entries.find((entry) => entry.toLowerCase() === 'readme.md');
  if (!match) return undefined;
  const readmePath = join(packagePath, match);
  try {
    // lstat never follows links — anything but a regular file is rejected.
    const meta = await lstat(readmePath);
    if (!meta.isFile()) return undefined;

    const handle = await open(readmePath, 'r');
    try {
      // Size from the open handle (not the earlier lstat) so the bound and the
      // read refer to the same inode.
      const { size } = await handle.stat();
      const length = Math.min(size, MAX_README_BYTES);
      if (length === 0) return undefined;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      // Only a cap-truncated read can split a character mid-sequence; a file
      // read in full keeps whatever bytes it genuinely contains.
      const end = size > bytesRead ? trimPartialUtf8Tail(buffer, bytesRead) : bytesRead;
      const text = buffer.subarray(0, end).toString('utf8');
      return text.trim().length === 0 ? undefined : text;
    } finally {
      await handle.close();
    }
  } catch {
    // A README that vanished or is unreadable between the readdir and the read
    // is treated as absent — the detail endpoint never fails over a preview.
    return undefined;
  }
}

/**
 * Drop a trailing partial UTF-8 sequence from `buffer[0, length)`.
 *
 * A byte-offset truncation can land mid-character; decoding that tail would
 * emit a U+FFFD replacement glyph. Walks back over at most three continuation
 * bytes to the final lead byte and drops the sequence when its continuation
 * bytes were cut off. Bytes that were already invalid UTF-8 are left as-is —
 * this only repairs damage done by the cap.
 *
 * @param buffer - The bytes that were read.
 * @param length - Number of valid bytes in `buffer`.
 * @returns The largest end offset that does not end in a split sequence.
 */
function trimPartialUtf8Tail(buffer: Buffer, length: number): number {
  let i = length - 1;
  const floor = Math.max(0, length - 4);
  // Walk back over continuation bytes (0b10xxxxxx) to the sequence's lead byte.
  while (i >= floor && (buffer[i] & 0xc0) === 0x80) i--;
  // Four continuation bytes in a row, or an ASCII/continuation byte where a
  // lead should be: the content was never valid UTF-8 there — leave it alone.
  if (i < floor || buffer[i] < 0x80) return length;
  const lead = buffer[i];
  let expected: number;
  if ((lead & 0xe0) === 0xc0) expected = 2;
  else if ((lead & 0xf0) === 0xe0) expected = 3;
  else if ((lead & 0xf8) === 0xf0) expected = 4;
  else return length; // Stray continuation/invalid lead — the file's own bytes.
  return length - i >= expected ? length : i;
}

/**
 * Register the `/packages` and `/packages/:name` routes on the marketplace router.
 *
 * @param router - The marketplace router.
 * @param deps - The router's injected dependencies.
 * @param _ctx - The helpers every route group shares.
 */
export function mountPackageRoutes(
  router: Router,
  deps: MarketplaceRouteDeps,
  _ctx: MarketplaceRouteContext
): void {
  const { sourceManager, fetcher, installer } = deps;

  // GET /packages -- aggregate packages from every enabled marketplace
  router.get('/packages', async (_req, res) => {
    try {
      const sources = await sourceManager.list();
      const enabled = sources.filter((source) => source.enabled);
      const packages = await aggregatePackages(enabled, fetcher);
      // Enrich with community install counts and registry-recency dates so the
      // client can offer the Popular and Recent sorts. Both read cached maps
      // (background-refreshed) — never block the browse response on the
      // dorkos.ai network calls, and each degrades to no data (hiding its sort)
      // when the cache is cold or the site is unreachable.
      const withCounts = enrichWithInstallCounts(packages, installCountsProvider.getCounts());
      const enriched = enrichWithUpdatedAt(withCounts, updatedAtProvider.getUpdatedAt());
      res.json({ packages: enriched });
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
        .json({ error: 'Validation failed', details: z.flattenError(parsedQuery.error) });
    }

    try {
      const { preview, manifest, packagePath } = await installer.preview({
        name: req.params.name,
        marketplace: parsedQuery.data.marketplace,
      });
      // The installer already staged the package locally, so read its README
      // straight off disk — no extra network fetch. Omitted when absent so the
      // response shape stays clean (the client shows nothing rather than an
      // empty placeholder).
      const readme = await readPackageReadme(packagePath);
      return res.json({
        manifest,
        packagePath,
        preview,
        disclosed: disclosedEffectsOf(preview),
        // What a global install's approval binds: sent back as
        // `approvedContentHash`, and compared with the hash the installer
        // records when the package lands (DOR-2306).
        contentHash: await packageContentHash(packagePath),
        ...(readme !== undefined && { readme }),
      });
    } catch (err) {
      logger.error(`[Marketplace] Failed to fetch package ${req.params.name}`, err);
      const mapped = mapErrorToStatus(err);
      return res.status(mapped.status).json(mapped.body);
    }
  });
}
