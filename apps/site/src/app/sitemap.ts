import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { MetadataRoute } from 'next';
import { siteConfig } from '@/config/site';
import { source, blog } from '@/lib/source';
import { features, CATEGORY_LABELS, type FeatureCategory } from '@/layers/features/marketing';
import { fetchMarketplaceJson } from '@/layers/features/marketplace';

const BASE_URL = siteConfig.url;

/** Repo root, resolved from `apps/site` (the build-time cwd). */
const REPO_ROOT = join(process.cwd(), '../..');

/** Per-build memo of git dates so a repeated path never re-shells. */
const gitDateCache = new Map<string, string | null>();

/**
 * Real last-commit date for a repo-relative file, as an ISO string, or
 * `undefined` when git can't answer (shallow clone, untracked file, no git).
 *
 * We deliberately omit `lastModified` on failure rather than fabricate a build
 * time: Google treats an unreliable lastmod as worse than none. Runs at build
 * only (the sitemap is statically generated), so shelling out once per doc file
 * is acceptable; results are memoized per path within the build.
 *
 * @param relPath - File path relative to the repo root (e.g. `docs/index.mdx`).
 */
function gitLastModified(relPath: string): string | undefined {
  const cached = gitDateCache.get(relPath);
  if (cached !== undefined) return cached ?? undefined;
  let result: string | null = null;
  try {
    const out = execSync(`git log -1 --format=%cI -- "${relPath}"`, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    result = out.length > 0 ? out : null;
  } catch {
    result = null;
  }
  gitDateCache.set(relPath, result);
  return result ?? undefined;
}

/**
 * Build sitemap entries for the marketplace browse page, privacy page, and one
 * entry per published package.
 *
 * These are static/registry-driven URLs with no reliable modification signal, so
 * `lastModified` is omitted entirely (fabricating a date is actively harmful for
 * Google's trust model). Wraps {@link fetchMarketplaceJson} in try/catch so a
 * registry outage degrades to just the two static entries — the sitemap must
 * keep generating even when the upstream registry is unavailable.
 */
async function buildMarketplaceEntries(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${BASE_URL}/marketplace`, changeFrequency: 'daily', priority: 0.9 },
    { url: `${BASE_URL}/marketplace/privacy`, changeFrequency: 'monthly', priority: 0.4 },
  ];

  try {
    const marketplace = await fetchMarketplaceJson();
    const packageEntries: MetadataRoute.Sitemap = marketplace.plugins.map((pkg) => ({
      url: `${BASE_URL}/marketplace/${pkg.name}`,
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
 * `lastModified` carries a real signal or nothing at all: blog posts use their
 * frontmatter date, docs pages use the source file's git commit date, and static
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
    ...docPages,
    ...blogPages,
    ...marketplacePages,
  ];
}
