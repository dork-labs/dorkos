---
number: 159
title: Use Server-Rendered URL Params for Feature Catalog Filtering
status: draft
created: 2026-03-20
spec: site-feature-catalog
superseded-by: null
---

# 0159. Use Server-Rendered URL Params for Feature Catalog Filtering

## Status

Draft (auto-extracted from spec: site-feature-catalog)

## Context

The `/features` catalog index displays features grouped by category (Console, Pulse, Relay, Mesh, Core). Users need to filter to a single category. Options were client-side JavaScript state (e.g. React `useState` with hidden/shown cards), or server-rendered URL params (`?category=pulse`) where each tab is an `<a href>` link.

Client-side filtering is invisible to search crawlers — a user searching "DorkOS relay features" cannot land on a pre-filtered `/features?category=relay` URL because that state never existed as a real page. Server-rendered filtering via URL params makes each filtered view a distinct, crawlable, cacheable URL.

## Decision

Category filtering uses `?category=` query params on the `/features` server component. The active category is read from `searchParams` (a Next.js 16 `Promise<SearchParams>` in server components). Each tab is a plain `<Link href="/features?category=relay">` — no client-side JavaScript involved. Invalid `?category=` values silently fall back to "All" to prevent 404s from stale links.

## Consequences

### Positive

- Each filtered view is a real URL that search engines can index and cache
- Zero JavaScript required for filtering — works without JS enabled
- Browser back/forward and copy-link work correctly for filtered views
- Consistent with Next.js App Router server component best practices

### Negative

- Full page navigation on each tab click (vs instant client-side filter)
- Slightly more server work per filter interaction vs in-memory JS filter
- Cannot animate the transition between filtered states without adding client JS
