---
slug: og-seo-ai-readability-overhaul
---

# Specification: OG Tags, Share Cards, SEO & AI Readability Overhaul

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-02-28
**Spec Number:** 73

---

## 1. Overview

Overhaul all OG tags, share cards, SEO metadata, and AI agent readability for the DorkOS marketing site (`apps/web`). This specification covers seven prioritized changes: unified OG/Twitter share card images, blog sitemap inclusion, llms.txt for AI discoverability, enhanced robots.txt with AI crawler rules, BlogPosting JSON-LD structured data, and siteConfig cleanup.

The primary user-facing goal is that sharing a DorkOS link on iMessage, Facebook, LinkedIn, Slack, or Discord produces a consistent, on-brand share card featuring the hero copy and Dorkian logo. Secondary goals improve search engine and AI agent discoverability.

## 2. Background / Problem Statement

The current OG image and metadata setup has several issues:

1. **Inconsistent share cards.** `opengraph-image.tsx` shows "Claude Code in your browser." while `twitter-image.tsx` shows "Build fast. Learn faster." Neither matches the current homepage hero copy.
2. **iMessage share card bug.** The `(marketing)/layout.tsx` exports an `openGraph` metadata object without an `images` field. Next.js metadata merging treats this as an override, stripping the dynamically generated OG image from the marketing routes. iMessage (which relies on `og:image`) shows no preview image.
3. **Blog posts missing from sitemap.** `sitemap.ts` calls `source.getPages()` for docs but never calls `blog.getPages()`. Blog posts are invisible to search engine crawlers.
4. **No AI agent readability.** There is no `llms.txt` file, so AI agents visiting the site have no structured entry point for understanding DorkOS capabilities.
5. **Robots.txt too permissive.** The current `robots.ts` allows all user agents without blocking known aggressive scrapers (CCBot, Bytespider) or disallowing test routes.
6. **No BlogPosting JSON-LD.** Individual blog posts have per-post OG metadata but no structured data for rich search results.
7. **Dead siteConfig field.** `siteConfig.ogImage = '/og-image.png'` is never used since the dynamic route handlers take precedence. Its presence is confusing.

## 3. Goals

- Produce a single, unified share card design used by both OG and Twitter image routes
- Fix the iMessage preview bug caused by metadata merging in the marketing layout
- Include all blog posts in the XML sitemap
- Provide AI-readable site description via `llms.txt`
- Block aggressive AI scrapers while allowing beneficial ones
- Add BlogPosting JSON-LD to individual blog post pages
- Remove dead configuration and update descriptions to match current marketing copy

## 4. Non-Goals

- Custom font loading in OG images (edge runtime limitation -- system fonts only)
- Content rewrites beyond meta tags and structured data
- New marketing pages or landing pages
- Analytics, tracking, or performance monitoring setup
- Per-blog-post OG images (all blog posts fall through to the root-level image)
- `llms-full.txt` (full documentation dump)
- Changes to docs pages metadata or structured data
- Social media integration or automated sharing

## 5. Technical Dependencies

| Dependency | Version | Purpose |
|---|---|---|
| `next/og` (ImageResponse) | Next.js 16 built-in | Dynamic OG image generation at edge runtime |
| `fumadocs-core` | existing | `source.getPages()` and `blog.getPages()` for sitemap |
| `fumadocs-mdx` | existing | Blog post frontmatter (title, description, date, author) |

No new packages are required. All changes use existing Next.js APIs and Fumadocs sources.

## 6. Detailed Design

### 6.1 Priority 1 (Critical): Unified OG/Twitter Share Card Image

#### 6.1.1 Design Specification

Replace the current graph-paper pattern with a clean, modern share card:

- **Background:** Solid gradient from `#1A1A1A` (charcoal) to `#2A2A2A` (slightly lighter charcoal), angled 135 degrees
- **Logo:** Dorkian logo SVG (geometric DORK lettering), rendered white (`#FFFFFF`) against the dark background, centered horizontally, positioned in the upper third
- **Headline (line 1):** "Your agents are brilliant." in white (`#FFFFFF`), 48px, weight 700, centered
- **Headline (line 2):** "They just can't do anything when you leave." in warm orange (`#E86C3A`), 48px, weight 700, centered
- **Tagline:** "You slept. They shipped." in muted gray (`#9A9A9A`), 24px, weight 300, centered, below headline
- **Bottom bar:** Thin accent stripe -- 4px `#E86C3A` followed by 4px `#5B8C5A` at the absolute bottom
- **Dimensions:** 1200x630 (OG standard), PNG format
- **No custom fonts** -- edge runtime only supports system fonts; use sans-serif defaults

#### 6.1.2 File: `apps/web/src/app/opengraph-image.tsx`

Complete rewrite of the existing file:

```tsx
import { ImageResponse } from 'next/og'

export const runtime = 'edge'

export const alt = 'DorkOS - The operating system for autonomous AI agents'
export const size = {
  width: 1200,
  height: 630,
}
export const contentType = 'image/png'

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          background: 'linear-gradient(135deg, #1A1A1A 0%, #2A2A2A 100%)',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          padding: '60px',
        }}
      >
        {/* Dorkian logo SVG -- geometric DORK lettering in white */}
        <svg
          width="400"
          height="138"
          viewBox="0 0 2325 799"
          fill="none"
          style={{ marginBottom: '40px' }}
        >
          <rect
            x="50"
            y="50"
            width="2225"
            height="699"
            stroke="#FFFFFF"
            strokeWidth="100"
          />
          <path
            d="M200 599V200H492L599.5 296V491.5L492 599H200Z"
            fill="#FFFFFF"
          />
          <path
            d="M699.5 599V296.5L802.5 200H1108V497.5L1001 599H699.5Z"
            fill="#FFFFFF"
          />
          <path
            d="M1208 599V200H1616.5L1509.5 395L1616.5 599L1409 499.5L1208 599Z"
            fill="#FFFFFF"
          />
          <path
            d="M1716.5 599V200L1917.5 291.5L2125 200L2017.5 400L2125 599H1917.5H1716.5Z"
            fill="#FFFFFF"
          />
        </svg>

        {/* Headline */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          <span
            style={{
              fontSize: '48px',
              fontWeight: 700,
              color: '#FFFFFF',
              letterSpacing: '-0.03em',
              lineHeight: 1.2,
            }}
          >
            Your agents are brilliant.
          </span>
          <span
            style={{
              fontSize: '48px',
              fontWeight: 700,
              color: '#E86C3A',
              letterSpacing: '-0.03em',
              lineHeight: 1.2,
              textAlign: 'center',
            }}
          >
            They just can&apos;t do anything
          </span>
          <span
            style={{
              fontSize: '48px',
              fontWeight: 700,
              color: '#E86C3A',
              letterSpacing: '-0.03em',
              lineHeight: 1.2,
            }}
          >
            when you leave.
          </span>
        </div>

        {/* Tagline */}
        <span
          style={{
            fontSize: '24px',
            color: '#9A9A9A',
            marginTop: '24px',
            fontWeight: 300,
          }}
        >
          You slept. They shipped.
        </span>

        {/* Bottom accent stripes */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ height: '4px', background: '#E86C3A' }} />
          <div style={{ height: '4px', background: '#5B8C5A' }} />
        </div>
      </div>
    ),
    { ...size }
  )
}
```

#### 6.1.3 File: `apps/web/src/app/twitter-image.tsx`

Replace the current file with a re-export of the OG image for guaranteed parity:

```tsx
// Twitter uses the exact same image as OpenGraph for consistency.
// Re-exporting ensures both routes always render identically.
export { default, alt, size, contentType, runtime } from './opengraph-image'
```

#### 6.1.4 File: `apps/web/src/app/(marketing)/layout.tsx` -- iMessage Bug Fix

The current `openGraph` override at lines 11-16 creates an `openGraph` metadata object without an `images` field. Next.js metadata merging replaces (not deep-merges) the parent's `openGraph`, which strips the dynamically generated OG image URL from the merged output. This causes iMessage (and any client that requires `og:image`) to show no preview image.

**Fix:** Add explicit `images` field referencing the dynamic OG image route.

```typescript
export const metadata: Metadata = {
  title: `${siteConfig.name} - ${siteConfig.description}`,
  description: metaDescription,
  openGraph: {
    title: `${siteConfig.name} - ${siteConfig.description}`,
    description: metaDescription,
    url: '/',
    type: 'website',
    images: [
      {
        url: '/opengraph-image',
        width: 1200,
        height: 630,
        alt: 'DorkOS - The operating system for autonomous AI agents',
      },
    ],
  },
  alternates: {
    canonical: '/',
  },
}
```

The `/opengraph-image` path is the convention Next.js uses for file-based OG image route handlers. By explicitly including it here, the metadata merge chain preserves the image reference through the marketing layout.

### 6.2 Priority 2 (High): Add Blog Posts to Sitemap

#### File: `apps/web/src/app/sitemap.ts`

Import the `blog` source and append blog pages to the sitemap output.

```typescript
import type { MetadataRoute } from 'next'
import { siteConfig } from '@/config/site'
import { source, blog } from '@/lib/source'

const BASE_URL = siteConfig.url

/**
 * Generate the sitemap for the DorkOS marketing site.
 *
 * Includes static marketing/legal pages, all Fumadocs documentation pages,
 * and all blog posts.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: BASE_URL,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 1.0,
    },
    {
      url: `${BASE_URL}/privacy`,
      lastModified: new Date(),
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    {
      url: `${BASE_URL}/terms`,
      lastModified: new Date(),
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    {
      url: `${BASE_URL}/cookies`,
      lastModified: new Date(),
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    {
      url: `${BASE_URL}/blog`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.6,
    },
  ]

  const docPages: MetadataRoute.Sitemap = source.getPages().map((page) => ({
    url: `${BASE_URL}${page.url}`,
    lastModified: new Date(),
    changeFrequency: 'weekly' as const,
    priority: 0.7,
  }))

  const blogPages: MetadataRoute.Sitemap = blog.getPages().map((page) => ({
    url: `${BASE_URL}${page.url}`,
    lastModified: new Date(),
    changeFrequency: 'monthly' as const,
    priority: 0.6,
  }))

  return [...staticPages, ...docPages, ...blogPages]
}
```

Changes from current:
- Import `blog` alongside `source` from `@/lib/source`
- Add `/blog` index page to static pages
- Add `blogPages` array from `blog.getPages()`
- Blog posts get `priority: 0.6` and `changeFrequency: 'monthly'`

### 6.3 Priority 3 (High): Add llms.txt

#### New File: `apps/web/public/llms.txt`

Static file served at `https://dorkos.ai/llms.txt`, following the llms.txt standard proposed by Jeremy Howard. This provides a structured entry point for AI agents exploring the site.

```
# DorkOS

> The operating system for autonomous AI agents. Scheduling, communication, memory, and a command center. Open source. Self-hosted.

DorkOS is an OS-layer for AI agents that provides the scheduling, memory, communication, and coordination infrastructure that agents themselves don't provide. It runs on your machine, wraps the Claude Agent SDK, and gives your agents a web-based command center.

## Core Capabilities

- **Pulse Scheduler**: Cron-based scheduling for autonomous agent runs with approval workflows
- **Relay Message Bus**: Inter-agent communication with adapter system (Telegram, Webhooks)
- **Mesh Discovery**: Agent registry, topology visualization, and health monitoring
- **Chat Interface**: Web UI for Claude Code with tool approval flows and slash command discovery
- **CLI**: Install via `npm install -g dorkos` and run `dorkos` to start

## Documentation

- [Getting Started](https://dorkos.ai/docs/getting-started): Installation and first run
- [Configuration](https://dorkos.ai/docs/configuration): Server and agent configuration
- [Pulse Scheduler](https://dorkos.ai/docs/pulse): Autonomous scheduling setup
- [Relay Messaging](https://dorkos.ai/docs/relay): Inter-agent communication
- [Mesh Discovery](https://dorkos.ai/docs/mesh): Agent registry and topology
- [API Reference](https://dorkos.ai/docs/api): REST API documentation

## Links

- Website: https://dorkos.ai
- GitHub: https://github.com/dork-labs/dorkos
- npm: https://www.npmjs.com/package/dorkos
- Contact: hey@dorkos.ai
```

Note: The doc links should be verified against the actual docs directory structure before implementation. If specific doc slugs differ, update the URLs accordingly.

### 6.4 Priority 4 (Medium): Update robots.txt

#### File: `apps/web/src/app/robots.ts`

Add AI crawler-specific rules to block aggressive scrapers while allowing beneficial ones. Also disallow `/test/` routes.

```typescript
import type { MetadataRoute } from 'next'
import { siteConfig } from '@/config/site'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // Default: allow all crawlers
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/_next/', '/test/'],
      },
      // Allow beneficial AI crawlers explicitly
      {
        userAgent: 'GPTBot',
        allow: '/',
        disallow: ['/api/', '/_next/', '/test/'],
      },
      {
        userAgent: 'ClaudeBot',
        allow: '/',
        disallow: ['/api/', '/_next/', '/test/'],
      },
      {
        userAgent: 'PerplexityBot',
        allow: '/',
        disallow: ['/api/', '/_next/', '/test/'],
      },
      // Block aggressive scrapers
      {
        userAgent: 'CCBot',
        disallow: '/',
      },
      {
        userAgent: 'Bytespider',
        disallow: '/',
      },
    ],
    sitemap: `${siteConfig.url}/sitemap.xml`,
  }
}
```

### 6.5 Priority 5 (Medium): Add BlogPosting JSON-LD

#### File: `apps/web/src/app/(marketing)/blog/[slug]/page.tsx`

Add a `BlogPosting` JSON-LD script to individual blog post pages. This complements the existing `SoftwareApplication` and `WebSite` JSON-LD in the marketing layout.

Add the JSON-LD construction inside the component function, and render the script tag before the article content. The structured data object is built from the page's frontmatter:

```typescript
// BlogPosting JSON-LD structured data (inside the component function)
const blogPostingJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'BlogPosting',
  headline: page.data.title,
  description: page.data.description,
  datePublished: new Date(page.data.date).toISOString(),
  dateModified: new Date(page.data.date).toISOString(),
  author: page.data.author
    ? { '@type': 'Person', name: page.data.author }
    : { '@type': 'Organization', name: siteConfig.name },
  publisher: {
    '@type': 'Organization',
    name: siteConfig.name,
    url: siteConfig.url,
  },
  url: `${siteConfig.url}/blog/${params.slug}`,
  mainEntityOfPage: {
    '@type': 'WebPage',
    '@id': `${siteConfig.url}/blog/${params.slug}`,
  },
}
```

The script tag is rendered at the top of the component's return JSX, using the same XSS-safe pattern (`replace(/</g, '\\u003c')`) as the existing JSON-LD in `(marketing)/layout.tsx`:

```tsx
<script
  type="application/ld+json"
  // Content is server-controlled (from frontmatter), not user input.
  // The replace() escapes closing tags to prevent XSS in JSON-LD context.
  dangerouslySetInnerHTML={{
    __html: JSON.stringify(blogPostingJsonLd).replace(/</g, '\\u003c'),
  }}
/>
```

Key decisions:
- `dateModified` defaults to `datePublished` (Fumadocs blog frontmatter has no separate modified date field; can be enhanced later if the schema adds one)
- Author falls back to the organization name when no author is specified in frontmatter
- The XSS escaping pattern matches the existing convention in `(marketing)/layout.tsx`

### 6.6 Priority 6 (Low): Remove Dead ogImage from siteConfig

#### File: `apps/web/src/config/site.ts`

Remove the `ogImage` field. The dynamic route handlers (`opengraph-image.tsx`, `twitter-image.tsx`) are the sole source of OG images. The static `/og-image.png` file does not exist in `apps/web/public/` and the field is never referenced in code.

```typescript
/**
 * Site-wide configuration for the DorkOS marketing site.
 *
 * Centralizes branding, URLs, and metadata so changes propagate
 * to layout metadata, JSON-LD, sitemap, robots, and OG images.
 */
export const siteConfig = {
  name: 'DorkOS',
  description:
    'The operating system for autonomous AI agents. Scheduling, communication, memory, and a command center. Open source. Self-hosted.',
  url: 'https://dorkos.ai',
  contactEmail: 'hey@dorkos.ai',
  github: 'https://github.com/dork-labs/dorkos',
  npm: 'https://www.npmjs.com/package/dorkos',

  /**
   * Disable the cookie consent banner across the entire site.
   * Set to `true` to hide the banner completely.
   */
  disableCookieBanner: true,
} as const

export type SiteConfig = typeof siteConfig
```

Before removing, verify no code references `siteConfig.ogImage` with a codebase search. If any references exist, update them to remove the dependency.

### 6.7 Priority 7 (Low): Update siteConfig Description

The current description ("The operating system for autonomous AI agents. Scheduling, communication, memory, and a command center. Open source. Self-hosted.") already matches the marketing copy well. Verify it aligns with the homepage and update if the marketing copy has diverged.

If the description needs updating, change it in `siteConfig.description`. This propagates to:
- Root layout `<meta name="description">`
- Marketing layout `og:description`
- `SoftwareApplication` JSON-LD `description`
- Any future metadata consumers

## 7. Implementation Plan

### Phase 1: Share Card Fix (Critical)

| Step | File | Change |
|---|---|---|
| 1a | `apps/web/src/app/opengraph-image.tsx` | Rewrite with new design (gradient bg, Dorkian logo, hero copy) |
| 1b | `apps/web/src/app/twitter-image.tsx` | Replace with re-export from opengraph-image |
| 1c | `apps/web/src/app/(marketing)/layout.tsx` | Add `images` array to `openGraph` metadata |

**Validation:** Deploy to Vercel preview. Test share card rendering on:
- iMessage (paste link in conversation)
- Facebook Sharing Debugger (`https://developers.facebook.com/tools/debug/`)
- Twitter Card Validator
- LinkedIn Post Inspector
- Slack (paste link in channel)
- Discord (paste link in channel)

### Phase 2: SEO & Discoverability (High)

| Step | File | Change |
|---|---|---|
| 2a | `apps/web/src/app/sitemap.ts` | Add blog import and blogPages array |
| 2b | `apps/web/public/llms.txt` | Create new file with structured AI-readable content |

**Validation:**
- Visit `/sitemap.xml` and confirm blog post URLs appear
- Visit `/llms.txt` and confirm it returns plain text content
- Submit updated sitemap to Google Search Console

### Phase 3: Crawler Rules & Structured Data (Medium)

| Step | File | Change |
|---|---|---|
| 3a | `apps/web/src/app/robots.ts` | Add AI crawler rules (allow/block) |
| 3b | `apps/web/src/app/(marketing)/blog/[slug]/page.tsx` | Add BlogPosting JSON-LD |

**Validation:**
- Visit `/robots.txt` and confirm CCBot/Bytespider are blocked
- Use Google Rich Results Test on a blog post URL to verify JSON-LD
- Check that the `BlogPosting` structured data includes headline, datePublished, and author

### Phase 4: Cleanup (Low)

| Step | File | Change |
|---|---|---|
| 4a | `apps/web/src/config/site.ts` | Remove `ogImage` field |
| 4b | `apps/web/src/config/site.ts` | Verify/update `description` |

**Validation:**
- `grep -r "ogImage" apps/web/` returns no results
- Existing metadata on all pages renders correctly (no regressions)

## 8. File Change Summary

| File | Action | Priority |
|---|---|---|
| `apps/web/src/app/opengraph-image.tsx` | Rewrite | Critical |
| `apps/web/src/app/twitter-image.tsx` | Rewrite (re-export) | Critical |
| `apps/web/src/app/(marketing)/layout.tsx` | Edit (add images to openGraph) | Critical |
| `apps/web/src/app/sitemap.ts` | Edit (add blog pages) | High |
| `apps/web/public/llms.txt` | Create | High |
| `apps/web/src/app/robots.ts` | Edit (add crawler rules) | Medium |
| `apps/web/src/app/(marketing)/blog/[slug]/page.tsx` | Edit (add JSON-LD) | Medium |
| `apps/web/src/config/site.ts` | Edit (remove ogImage) | Low |

## 9. Edge Cases & Risks

### OG Image Rendering

- **Edge runtime limitations:** No `fs.readFile`, no custom font loading. All fonts are system sans-serif. The Dorkian logo SVG must be inlined as JSX, not loaded from a file.
- **SVG in ImageResponse:** `next/og` uses Satori under the hood, which supports a subset of CSS and SVG. The Dorkian logo uses only `<rect>` and `<path>` elements with `fill` and `stroke`, which are fully supported.
- **Text wrapping:** The hero copy line "They just can't do anything when you leave." may need to be split across two lines at smaller font sizes. The implementation above splits it manually to ensure consistent rendering across platforms.

### Metadata Merging

- **Next.js metadata merge behavior:** When a child layout exports `openGraph`, it replaces (not deep-merges) the parent's `openGraph`. This is why the `images` field must be explicitly included. If future Next.js versions change this behavior, the explicit images field remains safe (just redundant).
- **Blog post OG images:** Blog posts do not define their own `opengraph-image.tsx`, so they inherit the root-level image via Next.js file-based metadata resolution. This is intentional -- no per-post images are planned.

### llms.txt

- **Doc link accuracy:** The URLs in `llms.txt` are based on the expected Fumadocs routing. If doc slugs change, `llms.txt` must be manually updated (it is a static file, not dynamically generated).
- **Standard stability:** The llms.txt standard is a proposal by Jeremy Howard, not an RFC. The format may evolve. The implementation follows the current convention (heading, blockquote summary, sections with markdown links).

### Sitemap

- **Blog page count:** If the blog grows to hundreds of posts, the single `sitemap()` function may need to be split into a sitemap index. For the current scale this is not a concern.

## 10. Testing

### Manual Testing Checklist

- [ ] Visit `/opengraph-image` directly in a browser and confirm the new design renders
- [ ] Visit `/twitter-image` directly and confirm it matches the OG image exactly
- [ ] Share the homepage URL on iMessage and confirm the preview card appears with the image
- [ ] Use Facebook Sharing Debugger to validate OG tags
- [ ] Visit `/sitemap.xml` and confirm blog post URLs are present
- [ ] Visit `/llms.txt` and confirm it returns the expected content
- [ ] Visit `/robots.txt` and confirm CCBot and Bytespider are disallowed
- [ ] Use Google Rich Results Test on a blog post and confirm BlogPosting schema is valid
- [ ] Verify `siteConfig.ogImage` is removed and no code references it
- [ ] Verify docs pages still have correct metadata (no regressions from layout.tsx change)

### Automated Testing

No new automated tests are required. These changes are:
- Static file additions (`llms.txt`)
- Metadata configuration changes (tested via manual share card validation)
- Edge runtime image generation (not unit-testable in jsdom)
- JSON-LD output (validated via Google's structured data tools)

If desired, a lightweight integration test could verify that `sitemap()` returns entries with `/blog/` URLs, but this is optional given the simplicity of the change.

## 11. Rollback Plan

All changes are independent and can be reverted individually:

- **OG image regression:** Revert `opengraph-image.tsx` and `twitter-image.tsx` to previous versions
- **iMessage bug reintroduced:** Remove the `images` array from the marketing layout's `openGraph` metadata (reverts to current broken behavior)
- **Sitemap issues:** Remove the `blog` import and `blogPages` from `sitemap.ts`
- **Robots.txt too restrictive:** Revert to the simple allow-all configuration
- **JSON-LD validation errors:** Remove the JSON-LD script block from the blog post page

No database migrations, no API changes, no client state changes. All modifications are to Next.js metadata, static files, and server-rendered markup.
