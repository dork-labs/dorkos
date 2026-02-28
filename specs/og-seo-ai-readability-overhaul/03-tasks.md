# Task Breakdown: OG Tags, Share Cards, SEO & AI Readability Overhaul

**Spec:** `specs/og-seo-ai-readability-overhaul/02-specification.md`
**Generated:** 2026-02-28
**Mode:** Full decomposition
**Total Tasks:** 8 across 4 phases

---

## Phase 1: Share Card Fix (Critical)

### Task 1.1 — Rewrite opengraph-image.tsx with unified share card design
- **Size:** Medium | **Priority:** High
- **Dependencies:** None
- **Parallel with:** 1.2

Complete rewrite of `apps/web/src/app/opengraph-image.tsx` with new design: dark gradient background (#1A1A1A to #2A2A2A), Dorkian logo SVG in white, two-line hero headline ("Your agents are brilliant." / "They just can't do anything when you leave."), tagline ("You slept. They shipped."), and orange/green bottom accent stripes. 1200x630 PNG, edge runtime, no custom fonts.

### Task 1.2 — Replace twitter-image.tsx with re-export from opengraph-image
- **Size:** Small | **Priority:** High
- **Dependencies:** 1.1
- **Parallel with:** None

Replace `apps/web/src/app/twitter-image.tsx` with a single re-export line: `export { default, alt, size, contentType, runtime } from './opengraph-image'`. Guarantees OG and Twitter share cards are always identical.

### Task 1.3 — Fix marketing layout metadata to resolve iMessage share card bug
- **Size:** Small | **Priority:** High
- **Dependencies:** 1.1
- **Parallel with:** None

Add explicit `images` array to the `openGraph` metadata in `apps/web/src/app/(marketing)/layout.tsx`. The current metadata override strips the OG image due to Next.js metadata merging behavior (replace, not deep-merge). The fix adds `images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: '...' }]` and `alternates.canonical`.

---

## Phase 2: SEO & Discoverability (High)

### Task 2.1 — Add blog posts to sitemap.ts
- **Size:** Small | **Priority:** High
- **Dependencies:** None
- **Parallel with:** 2.2

Update `apps/web/src/app/sitemap.ts` to import `blog` from `@/lib/source`, add `/blog` index to static pages, and append `blog.getPages()` entries with `priority: 0.6` and `changeFrequency: 'monthly'`.

### Task 2.2 — Create llms.txt for AI agent discoverability
- **Size:** Small | **Priority:** High
- **Dependencies:** None
- **Parallel with:** 2.1

Create `apps/web/public/llms.txt` following the llms.txt standard. Contains DorkOS description, core capabilities (Pulse, Relay, Mesh, Chat, CLI), documentation links, and contact info. Served statically at `/llms.txt`.

---

## Phase 3: Crawler Rules & Structured Data (Medium)

### Task 3.1 — Update robots.ts with AI crawler rules
- **Size:** Small | **Priority:** Medium
- **Dependencies:** None
- **Parallel with:** 3.2

Update `apps/web/src/app/robots.ts` to explicitly allow GPTBot, ClaudeBot, PerplexityBot while blocking CCBot and Bytespider. Add `/test/` to the disallow list for all agents.

### Task 3.2 — Add BlogPosting JSON-LD to blog post pages
- **Size:** Medium | **Priority:** Medium
- **Dependencies:** None
- **Parallel with:** 3.1

Add `BlogPosting` JSON-LD structured data to `apps/web/src/app/(marketing)/blog/[slug]/page.tsx`. Includes headline, description, datePublished, dateModified, author (Person or Organization fallback), publisher, and mainEntityOfPage. Uses the same XSS-safe `replace(/</g, '\\u003c')` pattern as the existing JSON-LD in the marketing layout.

---

## Phase 4: Cleanup (Low)

### Task 4.1 — Remove dead ogImage from siteConfig and verify description
- **Size:** Small | **Priority:** Low
- **Dependencies:** 1.1
- **Parallel with:** None

Remove unused `ogImage: '/og-image.png'` field from `apps/web/src/config/site.ts`. Verify no code references `siteConfig.ogImage` before removal. Verify `description` matches current marketing copy. Add TSDoc comment to the `siteConfig` export.

---

## Dependency Graph

```
Phase 1:  1.1 ──┬── 1.2
                 └── 1.3

Phase 2:  2.1 ║ 2.2  (independent, parallel)

Phase 3:  3.1 ║ 3.2  (independent, parallel)

Phase 4:  1.1 ──── 4.1
```

Phases 2 and 3 are independent of Phase 1 and can run in parallel. Phase 4 depends on Phase 1 (Task 1.1) to ensure the new OG image is in place before removing the old `ogImage` config field.
