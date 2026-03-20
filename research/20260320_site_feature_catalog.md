---
title: 'Site Feature Catalog System — Research Report'
date: 2026-03-20
type: external-best-practices
status: active
tags: [feature-catalog, seo, next-js, fumadocs, marketing, structured-data, llms-txt]
feature_slug: site-feature-catalog
searches_performed: 10
sources_count: 18
---

# Site Feature Catalog System — Research Report

**Feature slug**: `site-feature-catalog`
**Date**: 2026-03-20
**Scope**: DorkOS marketing site (`apps/site`) — Next.js 16, Fumadocs, Vercel

---

## Research Summary

A feature catalog system for a developer tool needs to thread two needles simultaneously: be an SEO-valuable set of individually-indexable pages AND be a human experience that earns the trust of technical users who distrust marketing. The best pattern — exemplified by Linear's hub-and-spoke model at `/features` — uses TypeScript-defined structured data as the single source of truth, with individual statically-generated feature pages at `/features/[slug]` backed by optional MDX for long-form content. This integrates cleanly with the existing DorkOS site patterns: Fumadocs's `defineCollections`, the `subsystems.ts` data pattern, `sitemap.ts`, and the dynamic `llms.txt` route handler.

---

## Key Findings

### 1. Data Architecture — TypeScript-First, MDX for Depth

The dominant pattern across well-engineered marketing sites is to separate two concerns:

- **Catalog data** (slug, name, category, status, one-liner, benefits, media refs) lives in a TypeScript `const` array, identical to the existing `subsystems.ts` pattern. This is the single source of truth for all programmatic uses: the catalog index page, the sitemap, the llms.txt generator, related-feature cross-links, and JSON-LD generation.
- **Rich feature content** (detailed explanation, code samples, deep dives, FAQ content) lives in MDX files managed by Fumadocs's `defineCollections`, exactly like blog posts. The MDX frontmatter references the catalog slug; the TypeScript data references the MDX slug for dynamic lookup.

This split gives you the best of both worlds: structured data is queryable/typesafe, rich content is authorable/extendable. Fumadocs's `defineCollections` already handles exactly this pattern for blog posts in `source.config.ts`.

### 2. URL Structure — `/features/[slug]`, Not `/feature/[slug]`

Plural `/features` is the universal standard across developer tools:

- Linear: `/features` hub with sub-pages at `/plan`, `/build`, `/ai` (flat, not `/features/plan`)
- Vercel: feature-area pages exist as flat routes (`/ai`, `/security`) reached from the homepage
- Most B2B SaaS: `/features/slug` with a hub at `/features`

For DorkOS, `/features/[slug]` is the right choice over Linear's flat model because:

1. DorkOS features have a clear parent (`/features`) that should exist as a browsable catalog page
2. The flat-route model (Linear's `/plan`) works when feature names are distinct brand terms; DorkOS feature names like "pulse" and "mesh" are less universally recognized
3. `/features/pulse`, `/features/relay`, `/features/mesh` are clean, SEO-targeted, and obvious

### 3. SEO for Feature Pages — JSON-LD Is the Differentiator

Standard title/description/OG tags are table stakes. The SEO differentiator for feature pages in 2025-2026 is:

**`SoftwareApplication` feature-level JSON-LD**: Google's Rich Results for software applications support a `featureList` at the application level, but individual feature pages benefit from `WebPage` + `SoftwareApplication` combo JSON-LD that makes each feature discoverable as a discrete capability.

**Breadcrumb JSON-LD**: Already used on blog posts (`BlogPosting` + `BreadcrumbList`). Feature pages should follow the exact same pattern:

```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {
      "@type": "ListItem",
      "position": 1,
      "name": "Features",
      "item": "https://dorkos.ai/features"
    },
    {
      "@type": "ListItem",
      "position": 2,
      "name": "Pulse",
      "item": "https://dorkos.ai/features/pulse"
    }
  ]
}
```

**Feature-level `SoftwareApplication` sub-schema**: Each page should include a `SoftwareApplication` schema that scopes to just that feature, with its own `description` and `featureList` (the specific capabilities within the feature).

**Meta title formula** that works for developer tool feature pages: `[Feature Name] — DorkOS | [one-liner benefit]`. E.g., `Pulse — DorkOS | Schedule AI agents with cron`. This targets the long-tail queries developers actually type.

### 4. Feature Catalog Index Page — Problem-Oriented Grid

Research from the Evil Martians study of 100+ dev tool pages (confirmed in existing `research/20260217_dorkos_landing_page_marketing.md`) identifies the "problem-oriented" framing as the most effective approach, surpassing simple feature lists.

The existing `subsystems.ts` already has a `benefit` field ("Makes agents work autonomously") that captures this framing. The catalog index should lead with benefits/problems solved, not feature names. A card grid with benefit-first copy, status badges, and a CTA to the individual feature page is the right structure.

UX patterns that work for developer tool feature catalogs:

- **No client-side filtering for < 12 features**: Static HTML is better for SEO and performance. Filter complexity adds friction without value at this scale.
- **Category grouping is useful if > 8 features**: For DorkOS's 6 current features (4 available, 2 coming-soon), simple status-based grouping (Available / Coming Soon) is sufficient.
- **Feature status badges** ("GA", "Beta", "Coming Soon") are essential: developers need to know what they can use now.

### 5. Content Split — What Goes Where

| Content Type                       | Lives In                       | Rationale                                                       |
| ---------------------------------- | ------------------------------ | --------------------------------------------------------------- |
| slug, name, category               | `features.ts` TypeScript const | Programmatic use (sitemap, llms.txt, JSON-LD, related features) |
| one-liner, benefit                 | `features.ts` TypeScript const | Used on catalog index, OG title, JSON-LD description            |
| status (ga/beta/coming-soon)       | `features.ts` TypeScript const | Drives badge rendering, catalog filtering                       |
| docsUrl, learnMoreHref             | `features.ts` TypeScript const | Cross-links to Fumadocs pages                                   |
| relatedFeatures (slug[])           | `features.ts` TypeScript const | Cross-linking without MDX coupling                              |
| heroImage, demoUrl                 | `features.ts` TypeScript const | Media pointers, not assets themselves                           |
| Full description, capabilities     | MDX frontmatter + body         | Authoring in MDX, queried via Fumadocs `defineCollections`      |
| Benefits (detailed), use cases     | MDX body                       | Long-form, benefits from MDX components                         |
| Code examples, screenshots gallery | MDX body                       | Fumadocs MDX components handle this well                        |
| FAQ per feature                    | MDX body                       | FAQ JSON-LD can be extracted at render time                     |

### 6. Individual Feature Page Content Structure

Based on analysis of Linear, Vercel, and high-performing B2B SaaS developer tool pages:

1. **Hero section**: Feature name + one-liner benefit + status badge + primary CTA ("Read the docs" or "Get started")
2. **Problem framing**: 1-2 sentences on what pain this solves (not a feature list)
3. **How it works**: 3-4 concrete capabilities, each with a micro-visual or icon
4. **Use case scenarios**: 2-3 real developer workflows (Kai Nakamura persona: "I want my agent to run every morning and tell me what changed")
5. **Media**: Screenshot or animated demo (static image at launch, video enhancement later)
6. **Related features**: Cross-links to 2-3 related features with benefit summaries
7. **CTA block**: Link to docs + install command
8. **Optional**: FAQ accordion for long-tail keywords (renders to FAQ JSON-LD)

The page should feel like a thorough product page, not a marketing brochure. Developers read for signal-to-noise ratio — every word must earn its place.

### 7. llms.txt Integration

The existing `llms.txt/route.ts` uses `buildCapabilitiesSection()` which already iterates `subsystems`. Feature catalog integration is straightforward: add a `buildFeaturesSection()` function that lists each available feature with its URL and one-liner, grouped by category. This gives AI assistants a structured list of DorkOS features with direct links to both the feature page and the docs page.

### 8. Sitemap Integration

Feature pages follow the same pattern as blog posts in `sitemap.ts`. Feature pages warrant `priority: 0.8` (higher than blog posts at 0.6, lower than homepage at 1.0) and `changeFrequency: 'monthly'`. The `/features` catalog index should be a static page at `priority: 0.7`.

---

## Detailed Analysis

### Data Source Architecture: Comparison of Approaches

**Approach 1: Pure TypeScript const array (like `subsystems.ts`)**

This is the simplest approach. All feature metadata lives in a TypeScript file. No MDX, no build-time processing. Suitable when feature pages have minimal long-form content.

- Pros: Zero build tooling overhead, fully typesafe, trivially queryable, no Fumadocs coupling for feature data
- Cons: Long-form content (code examples, detailed how-it-works) becomes unwieldy in TypeScript strings; no MDX component support; hard to write for non-engineers
- Best for: < 200 words per feature page, or when feature pages are primarily visual (screenshots + short copy)

**Approach 2: Fumadocs `defineCollections` (like blog posts)**

Feature content lives as MDX files in a `features/` directory. Fumadocs processes them; frontmatter is validated with Zod. The catalog index queries `featuresCollection.getPages()`.

- Pros: Full MDX authoring (React components, code blocks, images), Zod-validated frontmatter, same toolchain as docs and blog, easy to add Fumadocs search indexing
- Cons: Build time increases with each feature page; all metadata is in MDX frontmatter (harder to query without going through Fumadocs); less ergonomic for programmatic use (sitemap, llms.txt)
- Best for: Feature pages with significant long-form content, code samples, or interactive demos

**Approach 3: Hybrid — TypeScript const + optional MDX (RECOMMENDED)**

A TypeScript const array (`features.ts`) is the single source of truth for all metadata used programmatically (sitemap, llms.txt, JSON-LD, related features, catalog index). Each feature can optionally link to an MDX file (`mdxSlug?: string`) for extended content. The feature page renders the TypeScript data as the above-the-fold content and dynamically loads the MDX body if present.

This maps exactly to the existing DorkOS architecture:

- `subsystems.ts` is already the TypeScript const pattern
- `source.config.ts`/`blog/` is already the Fumadocs MDX pattern
- The hybrid approach composes them without coupling them

For DorkOS's 6 features at launch, starting with pure TypeScript const and adding MDX bodies when features need deeper documentation is the pragmatic path.

### Next.js App Router Implementation Pattern

The route structure mirrors the blog post pattern exactly:

```
apps/site/src/app/(marketing)/
  features/
    page.tsx                    # /features catalog index
    [slug]/
      page.tsx                  # /features/[slug] individual page
      opengraph-image.tsx       # Dynamic OG image per feature
```

`generateStaticParams` reads from the TypeScript features array:

```ts
export function generateStaticParams() {
  return features.map((f) => ({ slug: f.slug }));
}
```

All feature pages are statically generated at build time. No ISR needed — feature data changes only on deploy.

The OG image for feature pages follows the same pattern as blog posts (already implemented in `blog/[slug]/opengraph-image.tsx`): brand grid background, feature name in large type, benefit one-liner as subtitle, brand stripe footer.

### Feature Status Model

Three statuses cover all cases for DorkOS's current feature set and roadmap:

- `ga` — Generally Available, in production
- `beta` — Available but may change
- `coming-soon` — Not yet shipped

This maps to UI badges, catalog filtering, and drives a `noIndex` consideration: `coming-soon` features should still be indexed (they create interest and can rank for queries about problems DorkOS will solve), but should include a prominent "not yet available" indicator and a waitlist/notify CTA rather than "Get started."

The existing `subsystems.ts` uses `available | coming-soon` — the feature catalog should extend this with `beta` as a distinct state.

### Category Model

DorkOS's features map cleanly to categories that reflect what the product does:

- **Scheduling** — Pulse (run agents on a schedule)
- **Messaging** — Relay (communicate with agents)
- **Discovery** — Mesh (agent-to-agent coordination)
- **Interface** — Console (web UI and command center)
- **Intelligence** — Loop, Wing (coming soon — learning and memory)

Category is useful for the catalog index page grouping and for the llms.txt section structure. It is not needed for URL structure (features live under `/features/[slug]`, not `/features/[category]/[slug]`).

---

## Data Schema Recommendation

The recommended TypeScript interface for the feature catalog data source:

```ts
/**
 * Status of a DorkOS product feature.
 *
 * - `ga` — Generally Available, stable and in production
 * - `beta` — Available but API/behavior may change
 * - `coming-soon` — On the roadmap, not yet shipped
 */
export type FeatureStatus = 'ga' | 'beta' | 'coming-soon';

/**
 * Category grouping for the feature catalog index.
 * Used for visual organization, not URL structure.
 */
export type FeatureCategory =
  | 'scheduling'
  | 'messaging'
  | 'discovery'
  | 'interface'
  | 'intelligence';

export interface FeatureMedia {
  /** Path relative to /public, e.g. '/images/features/pulse-screenshot.png' */
  screenshot?: string;
  /** YouTube embed ID or full URL for a product demo */
  demoUrl?: string;
  /** Alt text for the screenshot (required for accessibility and SEO) */
  alt?: string;
}

export interface Feature {
  /**
   * URL-safe identifier. Used in /features/[slug] route.
   * Must be unique and stable — changing it is a breaking URL change.
   */
  slug: string;

  /** Display name shown in headers, catalog cards, and JSON-LD */
  name: string;

  /**
   * Category for visual grouping on the catalog index.
   * Not used in URL structure.
   */
  category: FeatureCategory;

  /**
   * One-liner benefit statement used in catalog cards, OG titles, and llms.txt.
   * Should complete: "DorkOS [name] [benefit]".
   * Example: "schedules your AI agents to run autonomously"
   * Target length: < 80 chars.
   */
  tagline: string;

  /**
   * 2-3 sentence description used in meta description, JSON-LD, and OG tags.
   * Problem-oriented framing preferred over feature-list framing.
   * Target length: 120-160 chars for meta description use.
   */
  description: string;

  /** Deployment status drives badge rendering and catalog filtering */
  status: FeatureStatus;

  /**
   * Ordered list of 3-5 concrete benefit statements shown in the
   * "How it works" / capabilities section of the individual feature page.
   * Each benefit should be ≤ 12 words.
   */
  benefits: string[];

  /** Optional media assets for the feature page hero and gallery */
  media?: FeatureMedia;

  /**
   * Slug of an MDX file in the features/ Fumadocs collection.
   * When present, the feature page renders the MDX body below the
   * structured above-the-fold content.
   * When absent, the page renders from TypeScript data only.
   */
  mdxSlug?: string;

  /**
   * Relative URL to the primary Fumadocs documentation page.
   * Used for "Read the docs" CTA and llms.txt cross-reference.
   * Example: '/docs/pulse'
   */
  docsUrl?: string;

  /**
   * Slugs of 2-3 related features for cross-linking at bottom of feature pages.
   * Must reference valid feature slugs in this array.
   */
  relatedFeatures?: string[];
}
```

**Field-by-field rationale:**

- `slug` — immutable URL key; semantic value, not UUID
- `name` — display name for UI and structured data
- `category` — grouping only, decoupled from URL structure to allow re-categorization without URL changes
- `tagline` — benefit-oriented, short enough for OG title suffix; distinct from description
- `description` — 120-160 chars, meta-description ready, problem-first framing
- `status` — three-value enum covering all current and near-future DorkOS states
- `benefits` — ordered list powers the "capabilities" section; length cap enforces copywriting discipline
- `media` — object (not string) so screenshot + demo video can coexist; alt text is first-class
- `mdxSlug` — optional coupling to Fumadocs MDX collection; keeps TypeScript data clean when MDX is not needed
- `docsUrl` — explicit rather than derived (e.g., `/docs/${slug}`) because docs URLs may not match feature slugs
- `relatedFeatures` — slug references for validated cross-linking

---

## SEO Considerations

**Title format**: `[Feature Name] — DorkOS | [tagline]`
Example: `Pulse — DorkOS | Schedule AI agents automatically`

**Meta description**: Use the `description` field directly (already 120-160 chars by schema constraint).

**JSON-LD per feature page**: Two schemas, same pattern as blog posts:

1. `BreadcrumbList` — `Home > Features > [Name]` (3-level for feature pages, 2-level for blog posts)
2. `SoftwareApplication` scoped to the feature — `name: "DorkOS [Name]"`, `description`, `featureList: benefits`

**Canonical URL**: Always absolute, e.g. `https://dorkos.ai/features/pulse`

**OG image**: Dynamic per-feature via `opengraph-image.tsx` in the `[slug]` route directory, same pattern as blog posts. Feature name in large type + tagline + brand stripe.

**`coming-soon` feature pages**: Index them (`noIndex: false`) — they rank for aspirational queries. Include `<meta name="robots" content="nosnippet">` to prevent Google from showing a snippet that might confuse users about availability. Better yet, include a clear first paragraph: "Pulse is now available. Loop is coming soon — [notify me]."

**Sitemap priority**: `/features` catalog index at `0.7`, individual feature pages at `0.8`. Higher than blog posts (`0.6`) because feature pages are core product content.

---

## Page Structure Recommendation

```
/features                     # Catalog index — all features in a card grid
/features/pulse               # Individual feature page
/features/relay               # Individual feature page
/features/mesh                # Individual feature page
/features/console             # Individual feature page
/features/loop                # Coming-soon feature page
/features/wing                # Coming-soon feature page
```

The `/features` catalog index lives inside the `(marketing)` route group alongside `page.tsx`. It does NOT use Fumadocs's layout — it uses the `MarketingHeader`/`MarketingFooter` shell.

Individual feature pages at `/features/[slug]` also live in the `(marketing)` group and use the same shell.

**Nav link**: Add `{ label: 'features', href: '/features' }` to the `navLinks` array in `page.tsx` alongside `blog` and `docs`.

---

## Content Split Recommendation

**TypeScript const (`features.ts` in `apps/site/src/layers/features/marketing/lib/`):**

- All metadata fields above
- This file is the single source of truth for the catalog index, sitemap, llms.txt, JSON-LD, and related-feature cross-links
- Mirrors the `subsystems.ts` pattern — same directory, same conventions

**Fumadocs MDX collection (`features/` directory, sibling to `docs/` and `blog/`):**

- Optional, feature-by-feature; start empty and add MDX content as features mature
- MDX files use frontmatter `slug: 'pulse'` to link back to the TypeScript data
- Body contains: detailed how-it-works prose, code examples, architecture diagrams, FAQ section
- The individual feature page renders this below the structured hero/benefits/media content

**Do NOT put in MDX frontmatter**: slug, name, category, tagline, description, status, benefits, docsUrl, relatedFeatures. These belong in the TypeScript const. MDX frontmatter should only contain fields that are purely content-authoring concerns (`author`, `lastUpdated`, `contentVersion`).

---

## Recommendation

**Recommended Approach**: TypeScript const data source (Approach 1/3 Hybrid — TypeScript-first with optional MDX)

**Rationale**: DorkOS already has `subsystems.ts` which is effectively a prototype of this system. The feature catalog extends it with richer metadata (status, benefits, media, docsUrl, relatedFeatures), adds the route structure (`/features` and `/features/[slug]`), and plugs into the existing sitemap, llms.txt, and JSON-LD patterns without introducing new build tooling. MDX support can be added feature-by-feature when content depth warrants it — it is not needed at launch. This approach is consistent with the codebase's established conventions and requires no new dependencies.

**Caveats**:

- If DorkOS feature pages eventually need rich authoring (long-form technical prose, interactive component embeds, customer quotes inline), the MDX collection should be activated — the `mdxSlug` field in the schema accommodates this without a breaking change to the data model.
- The `features.ts` file will need to stay in sync with `subsystems.ts` during any transition period. Consider whether `subsystems.ts` should be refactored into `features.ts` (supersetting the existing interface) rather than having two parallel data sources for overlapping concepts. The `subsystems.ts` file is currently used in `SubsystemsSection.tsx`, `llms.txt/route.ts`, and potentially other places — a rename/supersede plan is warranted.
- Do not add client-side filtering to the catalog index page. Static rendering serves both SEO and performance. If the catalog grows beyond 15 features, simple anchor-link category navigation (no JS required) is the right upgrade.

---

## Sources & Evidence

- [We studied 100 dev tool landing pages — Evil Martians (2025)](https://evilmartians.com/chronicles/we-studied-100-devtool-landing-pages-here-is-what-actually-works-in-2025)
- [Features — Linear](https://linear.app/features)
- [Schema for SaaS companies — SALT.agency](https://salt.agency/blog/schema-for-saas-companies-salt-agency/)
- [Schema for SaaS: Product, HowTo, FAQ, and Review — SaaS Consult](https://saasconsult.co/blog/schema-for-saas/)
- [What Is llms.txt? — ProMarketer](https://www.promarketer.ca/post/what-is-llms-txt)
- [The Complete Guide to llms.txt — Publii](https://getpublii.com/blog/llms-txt-complete-guide.html)
- [Next.js generateStaticParams](https://nextjs.org/docs/app/api-reference/functions/generate-static-params)
- [Next.js Dynamic Routes](https://nextjs.org/docs/app/building-your-application/routing/dynamic-routes)
- [Next.js MDX Guide](https://nextjs.org/docs/app/guides/mdx)
- [JSON-LD Schema Markup Complete Guide — SEO Strategy Ltd](https://www.seostrategy.co.uk/schema-structured-data/json-ld-guide/)
- [Structured Data 2024 — Web Almanac, HTTP Archive](https://almanac.httparchive.org/en/2024/structured-data)
- Existing research: `research/20260228_og_seo_ai_readability_overhaul.md`
- Existing research: `research/20260217_dorkos_landing_page_marketing.md`
- Codebase: `apps/site/src/layers/features/marketing/lib/subsystems.ts`
- Codebase: `apps/site/src/app/llms.txt/route.ts`
- Codebase: `apps/site/src/app/sitemap.ts`
- Codebase: `apps/site/src/app/(marketing)/blog/[slug]/page.tsx`
- Codebase: `apps/site/source.config.ts`

---

## Research Gaps & Limitations

- **Fumadocs `defineCollections` + feature pages integration**: The exact Fumadocs API for a `features/` collection needs to be verified against the Fumadocs version in use. The blog collection in `source.config.ts` is a concrete template.
- **`subsystems.ts` migration scope**: The exact usage surface of `subsystems.ts` across the codebase was not fully audited. Before superseding it with `features.ts`, a grep for all import sites is needed.
- **Competitor feature page performance data**: No quantitative SEO data (rankings, click-through rates, organic traffic) was available for developer tool feature pages specifically. The recommendations are based on structural and schema best practices, not A/B test data.

---

## Search Methodology

- Searches performed: 10
- Most productive terms: "developer tool feature catalog page design Linear Vercel", "SaaS feature page JSON-LD structured data schema.org", "Next.js generateStaticParams feature pages static generation"
- Primary sources: evilmartians.com study, linear.app live analysis, nextjs.org docs, schema.org, existing DorkOS codebase patterns
- Codebase files reviewed: `subsystems.ts`, `source.config.ts`, `sitemap.ts`, `llms.txt/route.ts`, `blog/[slug]/page.tsx`, `site.ts`, `page.tsx` (marketing homepage)
