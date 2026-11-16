---
slug: site-feature-catalog
number: 155
created: 2026-03-20
status: ideation
---

# Feature Catalog System for Marketing Site

**Slug:** site-feature-catalog
**Author:** Claude Code
**Date:** 2026-03-20
**Branch:** preflight/site-feature-catalog

---

## 1) Intent & Assumptions

- **Task brief:** Build a structured feature catalog system for `apps/site` that surfaces DorkOS product features with SEO-optimized individual pages, a browsable `/features` catalog with a homepage teaser section, and full integration with sitemap.xml, llms.txt, and other site infrastructure. The catalog is data-driven (TypeScript const + optional MDX) and designed to be maintained alongside the product.
- **Assumptions:**
  - This is additive — no existing `/features` route or feature pages to migrate
  - `subsystems.ts` and `modules.ts` are not deprecated in this spec; they continue serving existing homepage sections
  - Features are authored by the team, not user-submitted — no CMS UI needed
  - Static site generation at build time (no client-side filtering or runtime fetching)
  - The initial catalog will have ~10-20 features; full coverage can come iteratively
- **Out of scope:**
  - Feature flagging / gating in the product application
  - Admin CMS interface for editing catalog entries
  - Migrating subsystems.ts or modules.ts to features.ts (deferred to a future cleanup spec)
  - A/B testing or personalization on feature pages
  - User-submitted content or community features

---

## 2) Pre-reading Log

- `apps/site/src/app/sitemap.ts`: Aggregates 3 sources (static pages, `source.getPages()` for docs, `blog.getPages()` for blog posts) into an XML sitemap. Trivially extensible — feature pages map into a new `featurePages` array added to the same spread.
- `apps/site/src/app/llms.txt/route.ts`: Dynamic route handler that builds a `## Core Capabilities` section from `subsystems`, `## Documentation` from docs, and `## Blog` from blog posts. Adding `## Features` section follows the same `buildXSection()` helper pattern.
- `apps/site/src/app/robots.ts`: Allows all crawlers except aggressive bots. No changes needed — `/features` is crawlable by default.
- `apps/site/src/config/site.ts`: Centralized `siteConfig` with name, URL, GitHub, npm. Used in all metadata + OG generation.
- `apps/site/src/app/(marketing)/blog/[slug]/page.tsx`: Gold-standard reference for dynamic feature pages — `generateStaticParams()`, `generateMetadata()` with OG + canonical, JSON-LD (BlogPosting + BreadcrumbList), TOC sidebar, prev/next navigation.
- `apps/site/src/app/(marketing)/blog/page.tsx`: Blog index pattern — renders with `blog.getPages()` directly, category color coding, sorted by date. Reference for the catalog index page structure.
- `apps/site/source.config.ts`: Fumadocs `defineDocs()` + `defineCollections()` for blog posts. A new `defineCollections()` entry for `features/` MDX files can be added here for the optional MDX layer.
- `apps/site/src/lib/source.ts`: Fumadocs loaders for docs and blog. A `features` loader would be added here if MDX is enabled.
- `apps/site/src/app/(marketing)/layout.tsx`: JSON-LD (SoftwareApplication + WebSite), canonical, OG defaults. Feature pages inherit this layout.
- `apps/site/src/layers/features/marketing/lib/modules.ts`: `SystemModule[]` with id, name, label, description, status, group. Partial overlap with feature catalog — kept as-is in this spec.
- `apps/site/src/layers/features/marketing/lib/subsystems.ts`: `Subsystem[]` with id, benefit, name, description, status, integrations. Used in llms.txt. Kept as-is in this spec.
- `apps/site/src/layers/features/marketing/lib/faq-items.ts`: Pattern reference — single-responsibility TS constant with interface + exported array. This is the exact pattern for `features.ts`.
- `apps/site/src/layers/features/marketing/index.ts`: Barrel file for marketing feature exports. New `features` export registered here.

---

## 3) Codebase Map

**Primary Components/Modules (to create):**

- `apps/site/src/layers/features/marketing/lib/features.ts` — Feature catalog data source (TypeScript const array, authoritative)
- `apps/site/src/app/(marketing)/features/page.tsx` — Catalog index route (`/features`)
- `apps/site/src/app/(marketing)/features/[slug]/page.tsx` — Individual feature route with `generateStaticParams`, `generateMetadata`, JSON-LD
- `apps/site/src/app/(marketing)/features/[slug]/opengraph-image.tsx` — Dynamic OG image per feature
- `apps/site/src/layers/features/marketing/ui/FeatureCatalogSection.tsx` — Homepage teaser (featured features grid linking to `/features`)
- `apps/site/src/layers/features/marketing/ui/FeatureCard.tsx` — Reusable feature card for catalog index
- `apps/site/src/layers/features/marketing/ui/FeaturePageHero.tsx` — Hero section for individual feature pages

**Shared Dependencies (to modify):**

- `apps/site/src/app/sitemap.ts` — Add `featurePages` array
- `apps/site/src/app/llms.txt/route.ts` — Add `## Features` section
- `apps/site/src/layers/features/marketing/index.ts` — Export `features` and `Feature` type
- `apps/site/src/app/(marketing)/page.tsx` — Add `<FeatureCatalogSection />` to homepage

**Optional (if MDX layer is activated):**

- `apps/site/source.config.ts` — Add `defineCollections` for `features/` MDX
- `apps/site/src/lib/source.ts` — Add `features` Fumadocs loader
- `features/` directory at repo root (or `apps/site/src/content/features/`) — MDX files for rich feature content

**Data Flow:**

```
features.ts (const array)
  ├─→ /features           (FeatureCard grid, category filter, link to /features/[slug])
  ├─→ /features/[slug]    (Hero, Benefits, Media, Related, optional MDX body)
  ├─→ /sitemap.xml        (featurePages entries)
  ├─→ /llms.txt           (## Features section)
  ├─→ homepage            (FeatureCatalogSection — 4-6 featured features)
  └─→ OG images           (dynamic per feature via opengraph-image.tsx)
```

**Feature Flags/Config:**

- None required — all routes are statically generated

**Potential Blast Radius:**

- Direct: 5 new files (features.ts, 2 route pages, OG image, homepage section component)
- Modified: 4 files (sitemap.ts, llms.txt/route.ts, marketing/index.ts, (marketing)/page.tsx)
- Indirect: Navigation component — add `/features` link to marketing nav
- Optional: source.config.ts, lib/source.ts if MDX is activated per feature

---

## 4) Root Cause Analysis

_Not applicable — this is a new feature, not a bug fix._

---

## 5) Research

**Potential Solutions**

**1. Pure TypeScript const array (like existing `subsystems.ts`)**

- Description: All feature metadata (including page copy) lives in a single TypeScript array. No MDX.
- Pros: Zero build overhead, fully typesafe, trivially queryable by sitemap/llms.txt/JSON-LD, consistent with codebase precedent
- Cons: Long-form content (code examples, detailed how-it-works prose) becomes unwieldy in TypeScript strings; no MDX component support
- Complexity: Low | Maintenance: Low

**2. Fumadocs `defineCollections` MDX-only (like blog posts)**

- Description: Feature content lives entirely as MDX files; catalog data comes from frontmatter.
- Pros: Full MDX authoring, same toolchain as docs and blog, Fumadocs search integration
- Cons: All metadata in MDX frontmatter — harder to query without going through Fumadocs; build time increases; less ergonomic for sitemap/llms.txt/JSON-LD
- Complexity: Medium | Maintenance: Medium

**3. Hybrid — TypeScript const data + optional MDX bodies (RECOMMENDED)**

- Description: `features.ts` TypeScript const array is the authoritative single source of truth for all structured metadata. Features optionally link to MDX files for rich long-form content rendered below the structured section.
- Pros: Typesafe queryable metadata + opt-in authoring-friendly long-form content; no MDX migration required to start; consistent with existing dual-source codebase pattern; MDX activates per-feature as content matures
- Cons: Two files to keep in sync if MDX is used; `mdxSlug` coupling is implicit
- Complexity: Medium | Maintenance: Low-Medium

**Recommended Schema:**

```typescript
export type FeatureStatus = 'ga' | 'beta' | 'coming-soon';
export type FeatureCategory =
  | 'console' // Chat UI, session management, interactive tools
  | 'pulse' // Scheduling, automation, cron triggers
  | 'relay' // Messaging, adapters, inter-agent communication
  | 'mesh' // Agent discovery, topology, registry
  | 'core'; // Platform fundamentals (MCP, CLI, config, install)

export interface Feature {
  slug: string; // URL key — immutable, lowercase-kebab
  name: string; // Display name (e.g. "Pulse Scheduler")
  category: FeatureCategory; // Used for grouping, filtering, badge color
  tagline: string; // Benefit one-liner ≤80 chars (OG title suffix, card hook)
  description: string; // 120-160 chars, meta-description ready, problem-first
  status: FeatureStatus; // Drives badge + catalog filter
  featured?: boolean; // Show on homepage FeatureCatalogSection (4-6 max)
  benefits: string[]; // 3-5 concrete capability statements (≤12 words each)
  media?: {
    screenshot?: string; // Path relative to /public (e.g. '/features/pulse-screenshot.png')
    demoUrl?: string; // YouTube embed ID or full URL
    alt?: string; // Required if screenshot/video exists (a11y + SEO)
  };
  mdxSlug?: string; // Optional Fumadocs collection entry slug for long-form body
  docsUrl?: string; // Explicit link to docs (e.g. '/docs/pulse') — not derived
  relatedFeatures?: string[]; // Other feature slugs for cross-linking
  sortOrder?: number; // Display order within category (lower = first)
}
```

**Key schema improvements over original proposal:**

- `tagline` is distinct from `description` — tagline is benefit-led and short (≤80 chars), description is meta-ready (120-160 chars, problem-first). This enforces copy discipline.
- `folder` removed — unnecessary with slug-based routing
- `benefits` is a typed `string[]` not free-form prose — enforces concise, scannable bullet points
- `featured` boolean gates homepage teaser section membership
- `mdxSlug` is optional — MDX layer is additive, not required
- `sortOrder` allows manual curation within category buckets
- `media.alt` explicitly required by type (a11y + SEO best practice)
- `docsUrl` is explicit, not derived — avoids fragile URL construction

**SEO Strategy:**

- URL structure: `/features/[slug]` (plural, no nesting)
- Sitemap priority: `/features` at 0.7, `/features/[slug]` at 0.8 (above blog at 0.6, below homepage at 1.0)
- JSON-LD per feature: `BreadcrumbList` (Home > Features > Name) + `SoftwareApplication` with `featureList: benefits` — follow the exact pattern already in `blog/[slug]/page.tsx`
- OG image: Dynamic per-feature via `opengraph-image.tsx` in the `[slug]` route
- `coming-soon` pages: Index them (rank for aspirational queries), but use clear availability language to avoid user confusion
- Title pattern: `[Feature Name] — DorkOS` with `tagline` as OG description

**Content split (what lives where):**

| Content                                                                                                                 | Location                                       |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| slug, name, category, tagline, description, status, featured, benefits, media refs, docsUrl, relatedFeatures, sortOrder | `features.ts` TypeScript const (authoritative) |
| Detailed how-it-works prose, code examples, architecture notes, embedded media                                          | MDX file body (optional, via `mdxSlug`)        |
| MDX-specific authoring fields (contentVersion, lastReviewed)                                                            | MDX frontmatter only — never duplicated in TS  |

**Rule:** TypeScript data is authoritative. MDX files do not repeat or override TypeScript fields — they only contribute page body content.

**llms.txt integration:**

```typescript
// In llms.txt/route.ts — add ## Features section
const featuresSection = `## Features\n\n${features
  .map((f) => `- **${f.name}** (${f.category}): ${f.tagline}`)
  .join('\n')}`;
```

---

## 6) Decisions

| #   | Decision                                 | Choice                                                                    | Rationale                                                                                                                                                                                                                                        |
| --- | ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Relationship to subsystems.ts/modules.ts | Keep separate — features.ts is additive                                   | Lowest blast radius in this spec. subsystems.ts/modules.ts continue serving existing homepage components. A future cleanup spec will migrate them. Avoids touching 10+ import sites now.                                                         |
| 2   | Catalog page placement                   | Dedicated `/features` route + homepage teaser section                     | `/features` is essential for SEO — individual feature pages need a canonical parent to maximize crawl depth. Homepage section (`FeatureCatalogSection`) drives organic discovery via `featured: true` flag on 4-6 features.                      |
| 3   | Feature categories                       | Product subsystem categories: `console`, `pulse`, `relay`, `mesh`, `core` | Directly maps to DorkOS architecture that Kai already understands. Consistent with how subsystems.ts groups capabilities. Easily extended as new subsystems ship.                                                                                |
| 4   | Feature page content model               | Hybrid — TypeScript data + optional MDX body                              | TypeScript data is authoritative for all structured metadata (queryable by sitemap, llms.txt, JSON-LD, OG). MDX body is additive per-feature for long-form content. Start with TypeScript-only for initial features; add MDX as content matures. |

---

## 7) Open Questions (Not Blocking)

These are worth resolving in the spec phase but don't block ideation:

- **Navigation placement:** Should `/features` appear in the main marketing nav (`MarketingNav.tsx`)? If so, alongside or replacing an existing link?
- **Filter UX:** Should the catalog index have client-side category filtering (JS-driven) or separate category sub-routes (`/features?category=pulse`)? Research warns against client-side JS filtering for SEO — static generation per category is better if needed.
- **Feature count at launch:** How many features should be populated at launch? A skeleton with 5-10 well-written features beats 20 stubs.
- **Media strategy:** Are screenshots/videos ready or will most features launch media-free? The schema supports this gracefully — `media` is optional.
- **Subsystems migration timeline:** When should `features.ts` supersede `subsystems.ts`? Noting this so it isn't forgotten.
