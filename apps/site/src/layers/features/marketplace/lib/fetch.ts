/**
 * Marketplace registry fetch helpers — pulls `.claude-plugin/marketplace.json`
 * from `dork-labs/marketplace` (marketplace-05 layout) plus the optional
 * `dorkos.json` sidecar, and per-package READMEs dispatched by source type.
 *
 * Used by the /marketplace and /marketplace/[slug] pages with hourly ISR.
 *
 * @module features/marketplace/lib/fetch
 */

import {
  parseMarketplaceWithSidecar,
  resolvePluginSource,
  type MergedMarketplaceEntry,
  type MarketplaceJson,
  type DorkosSidecar,
  type PluginSource,
} from '@dorkos/marketplace';

const MARKETPLACE_ROOT_URL = 'https://raw.githubusercontent.com/dork-labs/marketplace/main';
const MARKETPLACE_URL = `${MARKETPLACE_ROOT_URL}/.claude-plugin/marketplace.json`;
const DORKOS_SIDECAR_URL = `${MARKETPLACE_ROOT_URL}/.claude-plugin/dorkos.json`;

const REVALIDATE_SECONDS = 3600;

/**
 * Merged fetch result: the parsed `marketplace.json`, the optional sidecar,
 * the merged-per-plugin entries (CC fields + DorkOS extensions), and any
 * orphan sidecar plugin names logged for awareness.
 *
 * The `plugins` field is named to mirror `MarketplaceJson.plugins` so
 * existing consumers continue to iterate via `result.plugins`. Each entry
 * is a `MergedMarketplaceEntry` which is a structural superset of the
 * CC-standard shape plus an optional `dorkos` extension object.
 */
export interface MarketplaceFetchResult {
  marketplace: MarketplaceJson;
  sidecar: DorkosSidecar | null;
  plugins: MergedMarketplaceEntry[];
  orphans: string[];
}

/**
 * Fetch the Dork Labs marketplace registry and its optional sidecar in
 * parallel, merge them, and return the result.
 *
 * Uses Next.js fetch revalidation (hourly) so SSG pages and ISR refreshes
 * pick up registry updates within an hour. A missing sidecar is NOT an
 * error — every merged entry simply has `dorkos: undefined` and the
 * caller treats the plugin as a default `plugin` type with no extensions.
 *
 * @throws when `marketplace.json` cannot be fetched or fails validation.
 */
export async function fetchMarketplaceJson(): Promise<MarketplaceFetchResult> {
  const [marketplaceRes, sidecarRes] = await Promise.all([
    fetch(MARKETPLACE_URL, { next: { revalidate: REVALIDATE_SECONDS } }),
    fetch(DORKOS_SIDECAR_URL, { next: { revalidate: REVALIDATE_SECONDS } }),
  ]);

  if (!marketplaceRes.ok) {
    throw new Error(
      `Failed to fetch marketplace registry: ${marketplaceRes.status} ${marketplaceRes.statusText}`
    );
  }

  const rawMarketplace = await marketplaceRes.text();
  const rawSidecar = sidecarRes.ok ? await sidecarRes.text() : null;

  const result = parseMarketplaceWithSidecar(rawMarketplace, rawSidecar);
  if (!result.ok) {
    throw new Error(`marketplace.json parse failed: ${result.error}`);
  }

  if (result.orphans.length > 0) {
    console.warn('marketplace: orphan plugins in sidecar', { orphans: result.orphans });
  }

  return {
    marketplace: result.marketplace,
    sidecar: result.sidecar,
    plugins: result.merged,
    orphans: result.orphans,
  };
}

/**
 * Fetch the README.md for a package given its discriminated `PluginSource`.
 *
 * Dispatches per source type (relative-path, github, url, git-subdir, npm)
 * so the site can surface READMEs from every form of marketplace source.
 * A missing or unreachable README returns an empty string — the rendering
 * components already handle empty markdown gracefully.
 *
 * @param source - The package's `source` field from the merged entry.
 */
export async function fetchPackageReadme(source: PluginSource): Promise<string> {
  const readmeUrl = resolvePackageReadmeUrl(source);
  if (!readmeUrl) return '';
  try {
    const res = await fetch(readmeUrl, { next: { revalidate: REVALIDATE_SECONDS } });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Compute the raw README URL for a plugin source. Mirrors the same
 * per-type dispatch the server-side source resolver uses, keeping the
 * site and server READMEs in sync.
 *
 * @internal Exported for testing.
 */
export function resolvePackageReadmeUrl(source: PluginSource): string | null {
  const resolved = resolvePluginSource(source, { marketplaceRoot: MARKETPLACE_ROOT_URL });
  switch (resolved.type) {
    case 'relative-path':
      return `${MARKETPLACE_ROOT_URL}/${resolved.path}/README.md`;
    case 'github':
      return `https://raw.githubusercontent.com/${resolved.repo}/main/README.md`;
    case 'url':
      return `${resolved.url.replace(/\.git$/, '')}/raw/main/README.md`;
    case 'git-subdir':
      return `${resolved.cloneUrl.replace(/\.git$/, '')}/raw/main/${resolved.subpath}/README.md`;
    case 'npm':
      // npm README fetching is deferred with npm install support itself.
      return null;
  }
}
