import { siteConfig } from '@/config/site';
import { subsystems } from '@/layers/features/marketing/lib/subsystems';
import {
  features,
  CATEGORY_LABELS,
  type FeatureCategory,
} from '@/layers/features/marketing/lib/features';
import { buildDocsSections, buildBlogSection, buildMarketplaceSection } from '@/lib/ai/site-index';

export const dynamic = 'force-static';

function buildCapabilitiesSection(): string {
  return subsystems.map((s) => `- **${s.name}**: ${s.benefit}`).join('\n');
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
