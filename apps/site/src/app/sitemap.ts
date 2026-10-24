import type { MetadataRoute } from 'next';
import { siteConfig } from '@/config/site';
import { source, blog } from '@/lib/source';
import { gitLastModified } from '@/lib/metadata';
import {
  features,
  comparisons,
  CATEGORY_LABELS,
  type FeatureCategory,
} from '@/layers/features/marketing';
import { fetchMarketplaceJson, marketplaceSitemapEntries } from '@/layers/features/marketplace';

const BASE_URL = siteConfig.url;

/**
 * Build the marketplace sitemap entries (see {@link marketplaceSitemapEntries}).
 *
 * Wraps {@link fetchMarketplaceJson} in try/catch so a registry outage degrades
 * to the static entries with every category listed — the sitemap must keep
 * generating even when the upstream registry is unavailable.
 */
async function buildMarketplaceEntries(): Promise<MetadataRoute.Sitemap> {
  try {
    const marketplace = await fetchMarketplaceJson();
    return marketplaceSitemapEntries(BASE_URL, marketplace.plugins);
  } catch {
    return marketplaceSitemapEntries(BASE_URL, null);
  }
}

/**
 * Generate the sitemap for the DorkOS marketing site.
 *
 * `lastModified` carries a real signal or nothing at all: blog posts use their
 * frontmatter date, docs pages use the source file's git commit date, comparison
 * pages use the date their facts were last checked, and static
 * marketing/feature/marketplace pages omit it (no honest signal exists). Google
 * ignores `priority`/`changeFrequency`, so those are left as loose documentation.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE_URL, changeFrequency: 'monthly', priority: 1.0 },
    { url: `${BASE_URL}/install`, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${BASE_URL}/pricing`, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${BASE_URL}/security`, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${BASE_URL}/privacy`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE_URL}/terms`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE_URL}/cloud/terms`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE_URL}/cookies`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE_URL}/blog`, changeFrequency: 'weekly', priority: 0.6 },
  ];

  const featureCatalogPage: MetadataRoute.Sitemap = [
    { url: `${BASE_URL}/features`, changeFrequency: 'monthly', priority: 0.7 },
  ];

  const featurePages: MetadataRoute.Sitemap = features.map((feature) => ({
    url: `${BASE_URL}/features/${feature.slug}`,
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

  // The hub has no honest modification signal, so it carries no `lastModified`.
  // Each comparison page does: the date someone last checked its facts.
  const comparePages: MetadataRoute.Sitemap = [
    { url: `${BASE_URL}/compare`, changeFrequency: 'monthly', priority: 0.7 },
    ...comparisons.map((competitor) => ({
      url: `${BASE_URL}/compare/${competitor.slug}`,
      lastModified: new Date(competitor.lastVerified),
      changeFrequency: 'monthly' as const,
      priority: 0.8,
    })),
  ];

  const docPages: MetadataRoute.Sitemap = source.getPages().map((page) => {
    const lastModified = gitLastModified(`docs/${page.path}`);
    return {
      url: `${BASE_URL}${page.url}`,
      ...(lastModified ? { lastModified } : {}),
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    };
  });

  const blogPages: MetadataRoute.Sitemap = blog.getPages().map((page) => ({
    url: `${BASE_URL}${page.url}`,
    lastModified: new Date(page.data.date),
    changeFrequency: 'monthly' as const,
    priority: 0.6,
  }));

  const marketplacePages = await buildMarketplaceEntries();

  return [
    ...staticPages,
    ...featureCatalogPage,
    ...featurePages,
    ...featureCategoryPages,
    ...comparePages,
    ...docPages,
    ...blogPages,
    ...marketplacePages,
  ];
}
