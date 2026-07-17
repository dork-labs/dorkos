import { source, blog } from '@/lib/source';
import { sortBlogPagesNewestFirst } from '@/lib/blog-order';
import { siteConfig } from '@/config/site';
import { features } from '@/layers/features/marketing/lib/features';
import { fetchMarketplaceJson } from '@/layers/features/marketplace';

/**
 * Shared markdown link-list builders for the site's agent-facing indexes.
 *
 * Both `llms.txt` (the AI index file) and `sitemap.md` (the agent-crawl link
 * list) group the same docs, blog, features, and marketplace links. These
 * builders are the single source of that grouping so the two surfaces cannot
 * drift.
 *
 * @module lib/ai/site-index
 */

const SECTION_TITLES: Record<string, string> = {
  'getting-started': 'Getting Started',
  guides: 'Guides',
  concepts: 'Concepts',
  integrations: 'Integrations',
  api: 'API Reference',
  'self-hosting': 'Self-Hosting',
  contributing: 'Contributing',
  changelog: 'Changelog',
};

const SECTION_ORDER = [
  'getting-started',
  'guides',
  'concepts',
  'integrations',
  'api',
  'self-hosting',
  'contributing',
  'changelog',
];

function toTitleCase(slug: string): string {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getSectionTitle(slug: string): string {
  return SECTION_TITLES[slug] ?? toTitleCase(slug);
}

/**
 * Docs pages grouped by their top-level section, each an `### Title` heading
 * over a markdown bullet list of `[title](url): description` links. Sections
 * follow {@link SECTION_ORDER}, then any unknown sections alphabetically. The
 * root `/docs` page (no slug) and generated OpenAPI operation pages under the
 * `api` section (slug depth > 1) are skipped.
 */
export function buildDocsSections(): string {
  const pages = source.getPages();

  // Group by first slug segment; skip pages with no slugs (root /docs page)
  const groups = new Map<string, typeof pages>();
  for (const page of pages) {
    if (page.slugs.length === 0) continue;
    const section = page.slugs[0];
    // For the api section, only include the root page (slugs.length === 1)
    if (section === 'api' && page.slugs.length > 1) continue;
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section)!.push(page);
  }

  // Sort sections: known order first, then unknown alphabetically
  const knownSections = SECTION_ORDER.filter((s) => groups.has(s));
  const unknownSections = [...groups.keys()].filter((s) => !SECTION_ORDER.includes(s)).sort();
  const orderedSections = [...knownSections, ...unknownSections];

  return orderedSections
    .map((section) => {
      const pages = groups.get(section)!;
      const title = getSectionTitle(section);
      const lines = pages.map((page) => {
        const url = `${siteConfig.url}${page.url}`;
        const desc = page.data.description;
        return desc ? `- [${page.data.title}](${url}): ${desc}` : `- [${page.data.title}](${url})`;
      });
      return `### ${title}\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

/**
 * Blog posts, newest first, as a markdown bullet list of
 * `[title](url): description (date)` links.
 */
export function buildBlogSection(): string {
  const posts = sortBlogPagesNewestFirst(blog.getPages());

  const lines = posts.map((post) => {
    const url = `${siteConfig.url}${post.url}`;
    const date = new Date(post.data.date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      // Frontmatter dates parse as UTC midnight; render in UTC so the day
      // doesn't shift in negative-offset timezones.
      timeZone: 'UTC',
    });
    const desc = post.data.description;
    return desc
      ? `- [${post.data.title}](${url}): ${desc} (${date})`
      : `- [${post.data.title}](${url}) (${date})`;
  });

  return lines.join('\n');
}

/**
 * Feature detail pages as a markdown bullet list of `[name](url): tagline`
 * links to `/features/<slug>`. Distinct from llms.txt's feature summary (which
 * is not a link list); this is for the crawl-oriented `sitemap.md`.
 */
export function buildFeatureLinks(): string {
  return features
    .map((feature) => {
      const url = `${siteConfig.url}/features/${feature.slug}`;
      return `- [${feature.name}](${url}): ${feature.tagline}`;
    })
    .join('\n');
}

/**
 * Marketplace section: one bullet per published package, fetched from the
 * registry. Degrades gracefully on fetch failure to a single browse link so a
 * transient registry outage never breaks the file.
 */
export async function buildMarketplaceSection(): Promise<string> {
  const browseUrl = `${siteConfig.url}/marketplace`;
  try {
    const marketplace = await fetchMarketplaceJson();
    if (marketplace.plugins.length === 0) {
      return `Browse the catalog at ${browseUrl}`;
    }
    const lines = marketplace.plugins.map((pkg) => {
      const url = `${siteConfig.url}/marketplace/${pkg.name}`;
      const type = pkg.type ?? 'plugin';
      const description = pkg.description ?? '';
      return description
        ? `- [${pkg.name}](${url}) (${type}): ${description}`
        : `- [${pkg.name}](${url}) (${type})`;
    });
    return lines.join('\n');
  } catch {
    return `Browse the catalog at ${browseUrl}`;
  }
}
