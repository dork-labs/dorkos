import type { MetadataRoute } from 'next';
import { siteConfig } from '@/config/site';
import { source, blog } from '@/lib/source';
import { features, CATEGORY_LABELS, type FeatureCategory } from '@/layers/features/marketing';
import { fetchMarketplaceJson } from '@/layers/features/marketplace';

const BASE_URL = siteConfig.url;

/**
 * Build sitemap entries for the marketplace browse page, privacy page, and one
 * entry per published package.
 *
 * Wraps {@link fetchMarketplaceJson} in try/catch so a registry outage degrades
 * to just the static `/marketplace` and `/marketplace/privacy` entries — the
 * sitemap must keep generating even when the upstream registry is unavailable.
 */
async function buildMarketplaceEntries(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = [
    {
      url: `${BASE_URL}/marketplace`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/marketplace/privacy`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.4,
    },
  ];

  try {
    const marketplace = await fetchMarketplaceJson();
    const packageEntries: MetadataRoute.Sitemap = marketplace.plugins.map((pkg) => ({
      url: `${BASE_URL}/marketplace/${pkg.name}`,
      lastModified: new Date(),
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    }));
    return [...staticEntries, ...packageEntries];
  } catch {
    return staticEntries;
  }
}

/**
 * Generate the sitemap for the DorkOS marketing site.
 *
 * Includes static marketing/legal pages, all Fumadocs documentation pages,
 * all blog posts, and the marketplace browse page plus one entry per published
 * package (fetched from the dorkos-community registry with graceful fallback).
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: BASE_URL,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 1.0,
    },
    {
      url: `${BASE_URL}/privacy`,
      lastModified: new Date(),
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    {
      url: `${BASE_URL}/terms`,
      lastModified: new Date(),
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    {
      url: `${BASE_URL}/cookies`,
      lastModified: new Date(),
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    {
      url: `${BASE_URL}/blog`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.6,
    },
  ];

  const featureCatalogPage: MetadataRoute.Sitemap = [
    {
      url: `${BASE_URL}/features`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.7,
    },
  ];

  const featurePages: MetadataRoute.Sitemap = features.map((feature) => ({
    url: `${BASE_URL}/features/${feature.slug}`,
    lastModified: new Date(),
    changeFrequency: 'monthly' as const,
    priority: 0.8,
  }));

  const featureCategoryPages: MetadataRoute.Sitemap = (
    Object.keys(CATEGORY_LABELS) as FeatureCategory[]
  ).map((category) => ({
    url: `${BASE_URL}/features/category/${category}`,
    changeFrequency: 'monthly' as const,
    priority: 0.6,
  }));

  const docPages: MetadataRoute.Sitemap = source.getPages().map((page) => ({
    url: `${BASE_URL}${page.url}`,
    lastModified: new Date(),
    changeFrequency: 'weekly' as const,
    priority: 0.7,
  }));

  const blogPages: MetadataRoute.Sitemap = blog.getPages().map((page) => ({
    url: `${BASE_URL}${page.url}`,
    lastModified: new Date(),
    changeFrequency: 'monthly' as const,
    priority: 0.6,
  }));

  const marketplacePages = await buildMarketplaceEntries();

  return [
    ...staticPages,
    ...featureCatalogPage,
    ...featurePages,
    ...featureCategoryPages,
    ...docPages,
    ...blogPages,
    ...marketplacePages,
  ];
}
