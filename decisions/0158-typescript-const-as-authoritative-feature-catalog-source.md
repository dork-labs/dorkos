---
number: 158
title: Use TypeScript Const Array as Authoritative Feature Catalog Source
status: draft
created: 2026-03-20
spec: site-feature-catalog
superseded-by: null
---

# 0158. Use TypeScript Const Array as Authoritative Feature Catalog Source

## Status

Draft (auto-extracted from spec: site-feature-catalog)

## Context

The DorkOS marketing site needs a feature catalog that can serve SEO-optimized individual pages, a browsable index, sitemap entries, llms.txt content, and JSON-LD structured data. Options included a headless CMS (Contentful, Sanity), MDX-primary authorship (Fumadocs collection), or a TypeScript const array following the existing `subsystems.ts` pattern.

The site already uses TypeScript const arrays for structured marketing data (`subsystems.ts`, `modules.ts`). These files are queryable at build time with full type safety, importable by any route or utility without an API call, and versioned alongside the code they describe.

## Decision

The `features.ts` const array is the authoritative source of truth for all feature metadata. TypeScript types enforce the schema at compile time. MDX files (if added via `mdxSlug`) may contribute long-form body content but cannot override structured fields like `slug`, `name`, `tagline`, `benefits`, or `category`.

## Consequences

### Positive

- Zero runtime cost — features are evaluated once at build time
- Full TypeScript type safety across the schema
- Consistent with existing site data patterns (`subsystems.ts`)
- No external service dependency or API key required
- Sitemap, llms.txt, and JSON-LD all read from the same source without data sync risk
- Content changes go through code review, preventing accidental schema drift

### Negative

- Non-technical editors cannot update features without a code change
- No live preview or WYSIWYG editing
- Adding 50+ features would make the file unwieldy (but can be split by category)
