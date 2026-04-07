/**
 * Marketplace registry fetch helpers — pulls marketplace.json from
 * dorkos-community and per-package READMEs from raw GitHub URLs.
 *
 * Used by the /marketplace and /marketplace/[slug] pages with hourly ISR.
 *
 * @module features/marketplace/lib/fetch
 */

import { parseMarketplaceJson } from '@dorkos/marketplace';
import type { MarketplaceJson } from '@dorkos/marketplace';

const REGISTRY_URL =
  'https://raw.githubusercontent.com/dorkos-community/marketplace/main/marketplace.json';

const REVALIDATE_SECONDS = 3600;

/**
 * Fetch the dorkos-community marketplace.json index.
 *
 * Uses Next.js fetch revalidation (hourly) so build pages SSG and ISR refreshes
 * pick up registry updates within an hour.
 *
 * @throws when the fetch fails or the payload does not validate
 */
export async function fetchMarketplaceJson(): Promise<MarketplaceJson> {
  const res = await fetch(REGISTRY_URL, { next: { revalidate: REVALIDATE_SECONDS } });
  if (!res.ok) {
    throw new Error(`Failed to fetch marketplace registry: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  const result = parseMarketplaceJson(text);
  if (!result.ok) {
    throw new Error(`marketplace.json parse failed: ${result.error}`);
  }
  return result.marketplace;
}

/**
 * Fetch the README.md for a package given its source URL.
 *
 * Converts a github.com URL like `https://github.com/dorkos-community/code-reviewer`
 * into the corresponding `https://raw.githubusercontent.com/.../main/README.md` URL.
 * Falls back to an empty string when the README is missing or the source URL is
 * not a GitHub URL.
 *
 * @param sourceUrl - The package's `source` field from marketplace.json
 */
export async function fetchPackageReadme(sourceUrl: string): Promise<string> {
  const rawUrl = githubSourceToRawReadme(sourceUrl);
  if (!rawUrl) return '';
  try {
    const res = await fetch(rawUrl, { next: { revalidate: REVALIDATE_SECONDS } });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Convert a github.com source URL into a raw README URL.
 *
 * Tries `main` first; the caller may extend this to fall back to `master` if
 * needed for older repos.
 *
 * @internal Exported for testing.
 */
export function githubSourceToRawReadme(sourceUrl: string): string | null {
  const match = sourceUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) return null;
  const [, owner, repo] = match;
  return `https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`;
}
