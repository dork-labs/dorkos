import { source, blog } from '@/lib/source';
import { siteConfig } from '@/config/site';
import { subsystems } from '@/layers/features/marketing/lib/subsystems';
import {
  features,
  CATEGORY_LABELS,
  type FeatureCategory,
} from '@/layers/features/marketing/lib/features';
import { fetchMarketplaceJson } from '@/layers/features/marketplace';

export const dynamic = 'force-static';

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

function buildDocsSections(): string {
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

function buildBlogSection(): string {
  const posts = blog
    .getPages()
    .sort((a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime());

  const lines = posts.map((post) => {
    const url = `${siteConfig.url}${post.url}`;
    const date = new Date(post.data.date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const desc = post.data.description;
    return desc
      ? `- [${post.data.title}](${url}): ${desc} (${date})`
      : `- [${post.data.title}](${url}) (${date})`;
  });

  return lines.join('\n');
}

function buildCapabilitiesSection(): string {
  const available = subsystems.filter((s) => s.status === 'available');
  return available.map((s) => `- **${s.name}**: ${s.description}`).join('\n');
}

function buildFeaturesSection(): string {
  return features
    .map((f) => `- **${f.name}** (${f.product}/${f.category}): ${f.tagline}`)
    .join('\n');
}

function buildFeatureCategoriesSection(): string {
  return (Object.keys(CATEGORY_LABELS) as FeatureCategory[])
    .map((cat) => {
      const label = CATEGORY_LABELS[cat];
      const catFeatures = features.filter((f) => f.category === cat);
      const lines = catFeatures.map((f) => `- ${f.name}: ${f.tagline}`);
      return `### ${label}\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

/**
 * Build the marketplace section of llms.txt — fetches the registry and emits
 * one bullet per package. Degrades gracefully on fetch failure to a single
 * browse link so transient registry outages don't break the file.
 */
async function buildMarketplaceSection(): Promise<string> {
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

/**
 * Dynamic llms.txt route handler.
 *
 * Generates the llms.txt file at build time from live fumadocs loaders,
 * siteConfig, subsystems data, and the dorkos-community marketplace registry.
 * Replaces the static public/llms.txt.
 */
export async function GET() {
  const marketplaceSection = await buildMarketplaceSection();
  const text = `# ${siteConfig.name}

> ${siteConfig.description}

DorkOS is an OS-layer for AI agents that provides the scheduling, memory, communication, and coordination infrastructure that agents themselves don't provide. It runs on your machine, wraps the Claude Agent SDK, and gives your agents a web-based command center.

## Core Capabilities

${buildCapabilitiesSection()}

## Features

${buildFeaturesSection()}

## Feature Categories

${buildFeatureCategoriesSection()}

## Marketplace

${marketplaceSection}

## Documentation

${buildDocsSections()}

## Blog

${buildBlogSection()}

RSS feed: ${siteConfig.url}/blog/feed.xml

## Links

- Website: ${siteConfig.url}
- GitHub: ${siteConfig.github}
- npm: ${siteConfig.npm}
- Contact: ${siteConfig.contactEmail}
`;

  return new Response(text, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
