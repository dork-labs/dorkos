import { siteConfig } from '@/config/site';
import {
  buildDocsSections,
  buildBlogSection,
  buildFeatureLinks,
  buildMarketplaceSection,
} from '@/lib/ai/site-index';

export const dynamic = 'force-static';

/**
 * Markdown sitemap for agents (Vercel's agent-crawl pattern): a plain-markdown
 * link list of every docs, feature, blog, and marketplace page, grouped by
 * area. Shares its link builders with `llms.txt` (see `lib/ai/site-index.ts`)
 * so the two indexes cannot drift. Complements the machine-readable
 * `sitemap.xml`: this one an agent can read and follow directly.
 */
export async function GET() {
  const marketplaceSection = await buildMarketplaceSection();
  const text = `# ${siteConfig.name} Sitemap

> A markdown link list of every page on ${siteConfig.url}, for AI agents and crawlers.

## Documentation

${buildDocsSections()}

## Features

${buildFeatureLinks()}

## Blog

${buildBlogSection()}

## Marketplace

${marketplaceSection}
`;

  return new Response(text, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
    },
  });
}
