---
number: 169
title: Use CollectionPage JSON-LD for Feature Category Pages
status: archived
created: 2026-03-21
spec: site-feature-category-pages
superseded-by: null
---

# 0169. Use CollectionPage JSON-LD for Feature Category Pages

## Status

Draft (auto-extracted from spec: site-feature-category-pages)

## Context

Feature category pages list all DorkOS features belonging to a given category (e.g. all "scheduling" features). For structured data, three Schema.org types were considered: `ItemList` (designed for ranked/ordered lists), `WebPage` (generic, low signal value), and `CollectionPage` (a curated set of items, subtype of WebPage). The existing `/features/[slug]` pages use `SoftwareApplication` JSON-LD for individual features. Category pages need a parent type that groups multiple `SoftwareApplication` items.

## Decision

Use `CollectionPage` with `hasPart: SoftwareApplication[]`. `CollectionPage` is semantically correct for a curated grouping of related product features — it signals "a page that collects related items" rather than a ranked list (`ItemList`) or a generic page (`WebPage`). The `hasPart` property links each feature as a `SoftwareApplication` child, mirroring the existing per-feature JSON-LD shape and providing richer data for AI search indexers and LLM retrieval systems.

## Consequences

### Positive

- Semantically accurate schema type for a curated product category listing
- `hasPart: SoftwareApplication[]` reuses the existing feature JSON-LD structure — consistent with `/features/[slug]` pages
- Better recognized by AI search indexers than generic `WebPage`
- BreadcrumbList + CollectionPage pair matches the established two-script pattern on feature detail pages

### Negative

- `CollectionPage` is less commonly used than `ItemList`, so tooling support in some validators may be thinner
- `hasPart` is a broad relationship — does not encode ordering or ranking within the category
