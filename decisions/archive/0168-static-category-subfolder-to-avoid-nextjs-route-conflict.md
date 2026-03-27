---
number: 168
title: Use Static category/ Subfolder Prefix to Avoid Next.js Dynamic Route Conflict
status: proposed
created: 2026-03-21
spec: site-feature-category-pages
superseded-by: null
---

# 0168. Use Static category/ Subfolder Prefix to Avoid Next.js Dynamic Route Conflict

## Status

Proposed

## Context

The DorkOS marketing site has an existing `/features/[slug]/page.tsx` dynamic route. Adding category landing pages at `/features/[category]/page.tsx` would cause a Next.js build error: "You cannot use different slug names for the same dynamic path." Two dynamic segments at the same URL level are incompatible in the App Router. Three approaches were considered: (1) a static `category/` subfolder prefix yielding `/features/category/{category}`, (2) a single `[slug]/page.tsx` that detects both feature slugs and category values, (3) middleware URL rewrites to serve `/features/{category}` externally while routing internally to a different path.

## Decision

Use option (1): a static `category/` subfolder at `apps/site/src/app/(marketing)/features/category/[category]/page.tsx`, yielding URLs like `/features/category/chat` and `/features/category/scheduling`. The static prefix completely eliminates the route conflict with zero risk. No existing files change. The slightly longer URL is an acceptable trade-off for zero implementation risk and zero complexity.

## Consequences

### Positive

- Zero Next.js build errors — static prefix fully resolves the dynamic route collision
- Existing `/features/[slug]` and `/features` routes are untouched
- Clean, predictable URL structure with an explicit `category/` namespace
- No middleware complexity or special routing logic required

### Negative

- URLs are `/features/category/chat` rather than `/features/chat` — one extra path segment
- If the URL shape is later changed to `/features/{category}`, a rewrite rule or migration would be needed
