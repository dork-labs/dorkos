/**
 * Sitemap entries for the marketplace pages.
 *
 * @module features/marketplace/lib/sitemap-entries
 */

import type { MetadataRoute } from 'next';
import { MARKETPLACE_CATEGORIES, type MergedMarketplaceEntry } from '@dorkos/marketplace';

import { isInCategory } from './ranking';

/**
 * Build sitemap entries for the marketplace browse page, the privacy page, the
 * category landing pages that hold at least one package, and one entry per
 * published package.
 *
 * Every category page is prerendered and stays reachable, but an empty one only
 * says "No packages yet", which is thin content for search engines, so it is
 * left out of the sitemap. When the registry could not be read (`plugins` is
 * `null`) there is no way to tell which categories are empty, so every category
 * stays listed, as before.
 *
 * These URLs have no reliable modification signal, so `lastModified` is omitted
 * (fabricating a date is actively harmful for Google's trust model).
 *
 * @param baseUrl - The site's absolute origin, without a trailing slash
 * @param plugins - Merged registry entries, or `null` when the fetch failed
 */
export function marketplaceSitemapEntries(
  baseUrl: string,
  plugins: MergedMarketplaceEntry[] | null
): MetadataRoute.Sitemap {
  const categories =
    plugins === null
      ? MARKETPLACE_CATEGORIES
      : MARKETPLACE_CATEGORIES.filter((category) =>
          plugins.some((pkg) => isInCategory(pkg, category))
        );

  return [
    { url: `${baseUrl}/marketplace`, changeFrequency: 'daily', priority: 0.9 },
    { url: `${baseUrl}/marketplace/privacy`, changeFrequency: 'monthly', priority: 0.4 },
    ...categories.map((category) => ({
      url: `${baseUrl}/marketplace/category/${category}`,
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    })),
    ...(plugins ?? []).map((pkg) => ({
      url: `${baseUrl}/marketplace/${pkg.name}`,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
  ];
}
