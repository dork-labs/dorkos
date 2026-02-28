---
slug: og-seo-ai-readability-overhaul
number: 72
created: 2026-02-28
status: ideation
---

# OG Tags, Share Cards, SEO & AI Readability Overhaul

**Slug:** og-seo-ai-readability-overhaul
**Author:** Claude Code
**Date:** 2026-02-28
**Branch:** preflight/og-seo-ai-readability-overhaul
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Deep review and overhaul of all OG tags, share cards, and SEO metadata across the DorkOS marketing site. Update everything to be consistent with the latest website branding and copy. Apply SEO best practices and add AI agent readability features (llms.txt, enhanced robots.txt).
- **Assumptions:**
  - Scope is the marketing site (`apps/web`) only — not the client app, server, or docs content
  - The current homepage hero copy ("Your agents are brilliant. They just can't do anything when you leave.") is the canonical brand message
  - The Dorkian logo SVG (`public/images/dorkian-logo.svg`) is the canonical logo mark
  - OG and Twitter images should be identical (one consistent share card everywhere)
  - Deployed on Vercel; edge runtime constraints apply
- **Out of scope:**
  - Content rewrites beyond meta tags and structured data
  - New marketing pages
  - Analytics or tracking setup
  - Custom font loading in OG images (font mismatch is a known minor issue — fixing requires either Node runtime or fetching from Google Fonts CDN)

## 2) Pre-reading Log

- `apps/web/src/config/site.ts`: Central config with branding, URLs, description. Has a dead `ogImage: '/og-image.png'` field (unused — dynamic route handlers take precedence)
- `apps/web/src/app/layout.tsx`: Root metadata with keywords, robots, viewport, theme colors. OG/Twitter images auto-detected from route handlers. Comments confirm this
- `apps/web/src/app/(marketing)/layout.tsx`: Marketing-specific metadata override with JSON-LD (SoftwareApplication + WebSite). Overrides `openGraph` without specifying images — potential metadata merging issue
- `apps/web/src/app/opengraph-image.tsx`: 1200x630 PNG, edge runtime. Headline: "Claude Code in your browser." — **outdated**, doesn't match current marketing
- `apps/web/src/app/twitter-image.tsx`: Same dimensions, different headline: "Build fast. Learn faster." — **also outdated**. Misleading comment says "uses the same image as OpenGraph for consistency" but content differs
- `apps/web/src/app/robots.ts`: Simple allow-all with `/api/` and `/_next/` disallowed. No AI crawler-specific rules
- `apps/web/src/app/sitemap.ts`: Includes static pages + docs. **Missing blog posts entirely**
- `apps/web/src/app/(marketing)/blog/[slug]/page.tsx`: Per-post OG metadata with `type: 'article'` and `publishedTime`. No JSON-LD BlogPosting schema. No per-post OG image
- `apps/web/src/app/icon.svg`: Favicon — "D" monogram from the DORK logotype
- `apps/web/public/images/dorkian-logo.svg`: Full DORK logotype (geometric letter shapes in bordered rectangle)
- `apps/web/src/layers/features/marketing/ui/ActivityFeedHero.tsx`: Current hero with "Your agents are brilliant." headline and "You slept. They shipped." tagline

## 3) Codebase Map

**Primary components/modules:**

| File | Role |
|---|---|
| `apps/web/src/config/site.ts` | Centralized branding config (name, description, URLs) |
| `apps/web/src/app/layout.tsx` | Root metadata (keywords, robots, viewport, OG/Twitter defaults) |
| `apps/web/src/app/(marketing)/layout.tsx` | Marketing metadata + JSON-LD structured data |
| `apps/web/src/app/opengraph-image.tsx` | Dynamic OG image generation (1200x630, edge) |
| `apps/web/src/app/twitter-image.tsx` | Dynamic Twitter image generation (1200x630, edge) |
| `apps/web/src/app/robots.ts` | robots.txt generation |
| `apps/web/src/app/sitemap.ts` | Sitemap generation (static + docs) |
| `apps/web/src/app/(marketing)/blog/[slug]/page.tsx` | Blog post metadata (per-post OG, no JSON-LD) |
| `apps/web/src/app/icon.svg` | Favicon (D monogram) |
| `apps/web/public/images/dorkian-logo.svg` | Full DORK logotype |

**Shared dependencies:**
- `siteConfig` singleton used by all metadata exports
- `source` (Fumadocs) used by sitemap and docs metadata
- `blog` (Fumadocs) used by blog pages (but not sitemap — this is a bug)

**Data flow:**
siteConfig → layout metadata exports → Next.js metadata merging → HTML `<head>` tags
siteConfig → opengraph-image.tsx/twitter-image.tsx → `og:image`/`twitter:image` meta tags
siteConfig → robots.ts/sitemap.ts → `/robots.txt` and `/sitemap.xml`

**Feature flags/config:** None — all metadata is unconditional

**Potential blast radius:**
- Direct: 7 files (OG image, Twitter image, layout, marketing layout, robots, sitemap, site config)
- New files: 1 (llms.txt)
- Indirect: Blog post pages (if adding per-post OG images or JSON-LD)
- Tests: None (no existing tests for metadata)

## 5) Research

### OG/Twitter Card Best Practices

**1. Unified OG/Twitter image**
- Recommended: 1200x630px PNG, same image for both `og:image` and `twitter:image`
- When `twitter:image` is absent, Twitter/X falls back to `og:image`. Having both with different content causes platform-specific confusion (confirmed: iMessage is currently showing the Twitter image instead of OG)
- Best practice: Delete `twitter-image.tsx` or make it re-export the same content as `opengraph-image.tsx`

**2. Platform image selection behavior**
- Facebook/LinkedIn/Slack/Discord: Read `og:image`
- Twitter/X: Reads `twitter:image`, falls back to `og:image`
- iMessage: Reads `og:image` but can fall back to `twitter:image` if OG fails
- The current bug (iMessage showing Twitter image) may be caused by the `(marketing)/layout.tsx` overriding `openGraph` without images, which can interfere with metadata merging

**3. Custom fonts in OG images**
- Edge runtime does NOT support `readFile` — fonts must be fetched from CDN
- Current images render in system default font (not IBM Plex Sans)
- Fix requires fetching from Google Fonts: `const fontData = await fetch('https://fonts.gstatic.com/...').then(r => r.arrayBuffer())`

### SEO Best Practices

**4. Blog posts missing from sitemap**
- `sitemap.ts` includes docs pages via `source.getPages()` but never calls `blog.getPages()`
- Blog posts are not being submitted to search engines via sitemap

**5. Structured data gaps**
- JSON-LD SoftwareApplication and WebSite schemas already exist in `(marketing)/layout.tsx` — good
- Missing: BlogPosting JSON-LD on individual blog posts (helps Google rich results)
- Missing: Organization schema (enables Google Knowledge Panel)

**6. robots.txt — AI crawlers**
- Current: Single `userAgent: '*'` rule
- Should block known aggressive/non-compliant scrapers (CCBot, Bytespider) while allowing beneficial AI crawlers (GPTBot, ClaudeBot, PerplexityBot)
- Should also disallow `/test/` routes (internal test/gallery pages)

**7. Dead config reference**
- `siteConfig.ogImage = '/og-image.png'` is never used — dynamic route handlers take precedence
- Should be removed to avoid confusion

### AI Agent Readability

**8. llms.txt standard**
- Proposed by Jeremy Howard (FastAI), September 2024
- 844,000+ implementors by October 2025
- Adopted by Anthropic, Vercel, Stripe, Cloudflare, Svelte
- Format: Plain text at `/llms.txt` with structured description + doc links
- High value for DorkOS: AI assistants are increasingly where developers discover tools. When someone asks "what's a web UI for Claude Code?", the AI needs structured content to cite DorkOS
- Implementation: Static file in `apps/web/public/llms.txt`
- Cost: Near-zero to add and maintain

### Recommendation

Prioritized changes:

| # | Change | Priority | Impact |
|---|--------|----------|--------|
| 1 | Unify OG/Twitter images with homepage hero copy + Dorkian logo | Critical | Fixes iMessage bug, brand consistency |
| 2 | Add blog posts to sitemap | High | Search indexing |
| 3 | Add llms.txt | High | AI agent discoverability |
| 4 | Update robots.txt (block CCBot/Bytespider, disallow /test/) | Medium | Reduce scraper load |
| 5 | Add BlogPosting JSON-LD to blog posts | Medium | Google rich results |
| 6 | Remove dead `ogImage` from siteConfig | Low | Code cleanup |
| 7 | Update siteConfig description to match marketing copy | Low | Consistency |

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | OG share card headline | Match homepage hero: "Your agents are brilliant." | Strongest brand message, matches what visitors see on landing. Current OG text ("Claude Code in your browser") is from an older product positioning |
| 2 | OG vs Twitter image parity | Same image for both | One consistent share card everywhere. Fixes the iMessage bug where it shows the wrong card. Simpler to maintain |
| 3 | Logo in OG image | Use Dorkian logo SVG | The actual brand mark exists in `public/images/dorkian-logo.svg`. Using it builds recognition across share cards vs generic triangles |
| 4 | AI readability features | llms.txt + enhanced robots.txt | High impact, near-zero maintenance. Adopted by major players (Anthropic, Vercel, Stripe). Skip llms-full.txt for now |
