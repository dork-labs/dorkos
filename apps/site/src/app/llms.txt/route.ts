import { siteConfig } from '@/config/site';
import { subsystems } from '@/layers/features/marketing/lib/subsystems';
import {
  features,
  CATEGORY_LABELS,
  type FeatureCategory,
} from '@/layers/features/marketing/lib/features';
import {
  buildDocsSections,
  buildBlogSection,
  buildComparisonLinks,
  buildMarketplaceSection,
} from '@/lib/ai/site-index';

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

DorkOS is where a founder runs their business with people and agents. Three things set it apart:

1. **Mini apps.** Ask for a tool your business needs, like a dashboard or a tracker, and your agents build it inside DorkOS. It turns on once you say yes, and opens on its own page, in the side panel, or on your dashboard. (The app calls these extensions.)
2. **Built for founders.** DorkOS is not a general chat tool. It is made for founders running a big or complex business mostly with agents.
3. **Ownership.** It runs on your own computer, with your real files and the AI plan you already pay for. It is free forever and open source (MIT), with no account required. DorkOS Cloud is optional.

You and your agents also talk in channels, DMs and threads, agents work on a schedule and reach you when they need you, and each agent runs on Claude Code, Codex or OpenCode.

## Core Capabilities

${buildCapabilitiesSection()}

## Features

${buildFeaturesSection()}

## Feature Categories

${buildFeatureCategoriesSection()}

## Comparisons

How DorkOS compares to other tools for working with AI agents. Each page carries the date its facts were last checked.

${buildComparisonLinks()}

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
