---
title: 'OG Tags, SEO Metadata & AI Agent Readability Overhaul — Research Report'
date: 2026-02-28
type: implementation
status: archived
tags: [og-tags, seo, ai-readability, llms-txt, meta, next-js]
feature_slug: og-seo-ai-readability-overhaul
---

# OG Tags, SEO Metadata & AI Agent Readability Overhaul — Research Report

**Feature slug**: `og-seo-ai-readability-overhaul`
**Date**: 2026-02-28
**Scope**: DorkOS marketing site (`apps/web`) — Next.js 16, deployed on Vercel

Note on JSON-LD code snippets: `dangerouslySetInnerHTML` is used intentionally for JSON-LD script tags per Next.js official guidance. The `.replace(/</g, '\\u003c')` call sanitizes the only dangerous character in JSON-LD payloads. This is the documented approach from nextjs.org/docs/app/guides/json-ld.

---

## Research Summary

DorkOS's current metadata baseline is solid — `metadataBase`, OG/Twitter fields, and `opengraph-image.tsx`/`twitter-image.tsx` are all present. However, several high-value improvements are missing: structured data (JSON-LD), `llms.txt` for AI agent readability, favicon infrastructure, blog post OG images, an improved `robots.ts` strategy for AI crawlers, and a more precisely worded meta description. This report covers the full landscape and provides concrete, code-level recommendations ordered by impact.

---

## Key Findings

### 1. OG/Twitter Card Best Practices (2025-2026)

**Canonical dimensions**: 1200x630px at a 1.91:1 aspect ratio is the universal standard. Works on Facebook, LinkedIn, Twitter/X, Slack, Discord, Telegram, WhatsApp, and iMessage. The existing `opengraph-image.tsx` already uses this — no change needed.

**Twitter card type**: `summary_large_image` is the right choice for a developer tool. Already set correctly.

**File size constraints**:

- `opengraph-image` must not exceed 8 MB (Next.js build fails otherwise)
- `twitter-image` must not exceed 5 MB
- Both are PNG — fine at this image complexity

**OG vs Twitter image — same or different?**
The Next.js docs confirm: "you only need to set it for openGraph; twitter will be generated automatically." Having separate `twitter-image.tsx` and `opengraph-image.tsx` with different content is a design choice that is valid but requires maintenance. The current situation where the two files have different content (OG says "Claude Code in your browser", Twitter says "Build fast. Learn faster.") creates inconsistency. The two images should either be unified or clearly differentiated for purpose.

**Platform rendering differences**:

- **Discord**: Renders full OG embed. Supports up to 15 MB. Shows `og:title`, `og:description`, `og:image`. Important for developer audiences.
- **Slack**: Reads `og:title` and `og:description` from HTML. Renders image if provided. Tight 3-5 second timeout — if edge OG image generation is slow on cold start, Slack will show blank preview.
- **iMessage/WhatsApp**: Strict timeout. Fast static rendering preferred.
- **LinkedIn**: Prefers 1200x627px but 1200x630px works. Caches aggressively — changes take time to propagate.
- **Facebook**: Fetches as `facebookexternalhit` — an HTML-limited bot. Next.js streaming metadata does NOT block for this bot's head render, which means OG tags will be in `<head>` correctly (Next.js detects HTML-limited bots automatically).

**Critical finding — edge runtime plus custom fonts**:
The current `opengraph-image.tsx` uses `export const runtime = 'edge'` but does NOT load a custom font. The text will render in the default system font (Helvetica/Arial-like). This looks noticeably different from the IBM Plex font used in the actual site. To load IBM Plex Sans on edge: fetch from Google Fonts as an ArrayBuffer. Or switch to Node.js runtime and use `readFile` from `node:fs/promises`.

```ts
// Option A: Stay on edge, fetch font from Google Fonts
const fontRes = await fetch(
  'https://fonts.gstatic.com/s/ibmplexsans/v19/zYXgKVEl...(url for SemiBold TTF)'
);
const fontData = await fontRes.arrayBuffer();

// Option B: Switch to Node.js runtime (remove runtime = 'edge')
// const fontData = await readFile(join(process.cwd(), 'assets/IBMPlexSans-Bold.ttf'))
```

**Blog post OG images**: The blog `[slug]/page.tsx` generates metadata but does NOT have a route-level `opengraph-image.tsx`. Blog posts fall through to the root OG image, which shows "Claude Code in your browser" regardless of the article topic. This is a significant missed opportunity for click-through rate. Each blog post should have a dynamic OG image that shows the article title.

### 2. SEO Best Practices for Developer Tool Sites

**Meta description audit**:
Current: `"The operating system for autonomous AI agents. Scheduling, communication, memory, and a command center. Open source. Self-hosted."`
This is 124 characters — within the 155-160 character limit. However it reads like a feature list. A stronger format: lead with the value proposition, include a differentiator, end with the key differentiator. Suggested: `"DorkOS is the open-source OS layer for AI agents — scheduling, memory, communication, and a web UI for Claude Code. Self-hosted on your machine."`

**Title template**: The current `template: '%s | DorkOS'` is correct. The `default: 'DorkOS'` fallback is used on the homepage.

**Canonical URLs**: Currently set as relative paths (`'/'`, `/blog/${slug}`). With `metadataBase: new URL(siteConfig.url)`, these resolve correctly to `https://dorkos.ai` and `https://dorkos.ai/blog/${slug}`. This is correct.

**robots.txt analysis**: The current `robots.ts` only has one rule block (`userAgent: '*'`). In 2025-2026, AI crawlers are a major concern:

- GPTBot (OpenAI) accounted for 30% of non-human traffic by mid-2025
- ClaudeBot (Anthropic) and PerplexityBot are significant
- Vercel's network recorded 569M GPTBot requests and 370M ClaudeBot requests

For DorkOS — an open-source tool that benefits from AI visibility — the correct strategy is to ALLOW AI indexing crawlers (so they can describe DorkOS to users asking about it), while the `llms.txt` provides curated content for better comprehension. The current `allow: '/'` is correct but explicit per-bot rules improve clarity.

**Sitemap analysis**: The current `sitemap.ts` is well-structured. Static pages have appropriate `priority` values. Doc pages use `changeFrequency: 'weekly'` which is appropriate. One improvement: `lastModified: new Date()` always returns the current build time — it should use the actual file modification date for accuracy.

**Missing: Blog posts in sitemap**: The sitemap includes doc pages but NOT blog post pages. `blog.getPages()` should also be called alongside `source.getPages()`.

**Structured data (JSON-LD) — missing entirely**:
The site has no JSON-LD. For a developer tool, two schemas are high-value:

**SoftwareApplication schema** (for Google rich results and AI comprehension):

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "DorkOS",
  "description": "The operating system for autonomous AI agents. Open-source web UI for Claude Code with scheduling, memory, communication, and coordination infrastructure.",
  "url": "https://dorkos.ai",
  "downloadUrl": "https://www.npmjs.com/package/dorkos",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "macOS, Linux, Windows",
  "license": "https://github.com/dork-labs/dorkos/blob/main/LICENSE",
  "codeRepository": "https://github.com/dork-labs/dorkos",
  "screenshot": "https://dorkos.ai/images/dorkos-screenshot.png",
  "featureList": [
    "Claude Code web UI",
    "AI agent scheduling",
    "Inter-agent messaging",
    "Agent mesh discovery",
    "Tool approval flows",
    "SSE streaming"
  ],
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "USD"
  }
}
```

**WebSite schema** (enables Google Sitelinks Searchbox):

```json
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "DorkOS",
  "url": "https://dorkos.ai"
}
```

**Article schema for blog posts** (should complement the existing OG metadata):

```json
{
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  "headline": "{{ page.data.title }}",
  "description": "{{ page.data.description }}",
  "datePublished": "{{ page.data.date (ISO 8601) }}",
  "author": {
    "@type": "Organization",
    "name": "DorkOS"
  },
  "publisher": {
    "@type": "Organization",
    "name": "DorkOS",
    "url": "https://dorkos.ai"
  }
}
```

**Favicon infrastructure — missing**:
The `apps/web/public` directory has only `.gitkeep` and `images/`. There is no `favicon.ico`, no `apple-touch-icon.png`, no `site.webmanifest`. Next.js file-based metadata detects `app/icon.png`, `app/apple-icon.png`, and `app/favicon.ico`.

Modern minimal favicon set (Evil Martians "three files" approach):

- `favicon.ico` (32x32, for legacy browser tab)
- `icon.svg` (SVG favicon, supports dark mode via `prefers-color-scheme`)
- `apple-touch-icon.png` (180x180, for iOS home screen — needs solid background + padding)
- `site.webmanifest` (for Android Chrome PWA install prompt)
- `icon-192.png` and `icon-512.png` (referenced from manifest)

In Next.js App Router, placing files in `apps/web/src/app/`:

- `favicon.ico` → auto-detected as `<link rel="icon">`
- `icon.png` or `icon.svg` → auto-generates `<link rel="icon">`
- `apple-icon.png` → auto-generates `<link rel="apple-touch-icon">`

### 3. AI Agent Readability

**llms.txt — high-value addition for a developer tool**:
The `llms.txt` standard was proposed by Jeremy Howard (FastAI) in September 2024 and had 844,000 implementors by October 2025. Major adopters include Anthropic (for Claude documentation itself), Cloudflare, Stripe, Vercel, Pinecone, and Svelte.dev.

**Why it matters specifically for DorkOS**: AI assistants (Claude, ChatGPT, Perplexity) are increasingly the first place developers discover tools. When a developer asks "what's a good web UI for Claude Code?" or "how do I add scheduling to my AI agents?", the AI needs clean structured content to cite DorkOS. Without `llms.txt`, the AI must parse navigation menus, JavaScript-rendered content, and marketing copy — resulting in poor citations or being ignored entirely. Token reduction of up to 10x has been reported when serving Markdown vs HTML.

**Format specification**:
File must live at `https://dorkos.ai/llms.txt`. Format uses Markdown:

```
# DorkOS

> The open-source OS layer for AI agents. Provides scheduling (Pulse), inter-agent messaging (Relay), agent mesh discovery, and a web UI for Claude Code (the Anthropic agent SDK). Self-hosted, runs on Node.js. Install via npm.

DorkOS is not a hosted service. It is a CLI tool (`npm install -g dorkos`) and a local server that wraps Claude Code sessions in a web UI with additional infrastructure.

## Getting Started

- [Installation](https://dorkos.ai/docs/installation): Install via npm, configure, and run
- [Quick Start](https://dorkos.ai/docs/quick-start): First session in 5 minutes
- [Configuration](https://dorkos.ai/docs/configuration): Environment variables and config file

## Core Concepts

- [Agent Sessions](https://dorkos.ai/docs/sessions): How Claude Code sessions are managed
- [Pulse Scheduler](https://dorkos.ai/docs/pulse): Cron-based agent scheduling
- [Relay Messaging](https://dorkos.ai/docs/relay): Inter-agent message bus
- [Mesh Discovery](https://dorkos.ai/docs/mesh): Multi-agent topology and registry

## API Reference

- [REST API](https://dorkos.ai/docs/api): OpenAPI spec for all endpoints
- [SSE Streaming](https://dorkos.ai/docs/streaming): Event types and protocol
- [Tool Approval](https://dorkos.ai/docs/tools): Interactive tool approval flows

## Optional

- [Architecture](https://dorkos.ai/docs/architecture): Hexagonal design, Transport interface
- [Blog](https://dorkos.ai/blog): Development updates and release notes
- [GitHub](https://github.com/dork-labs/dorkos): Source code and issues
```

**Implementation in Next.js**: Serve as a static file at `apps/web/public/llms.txt` (simplest) or as a Route Handler at `apps/web/src/app/llms.txt/route.ts` that dynamically builds the link list from the Fumadocs source.

**robots.txt for AI crawlers** — nuanced strategy:
DorkOS should welcome AI indexing crawlers (so AI can answer questions about it) while optionally blocking non-compliant scrapers.

| Crawler           | Company      | Recommended                        |
| ----------------- | ------------ | ---------------------------------- |
| `GPTBot`          | OpenAI       | Allow — helps ChatGPT cite DorkOS  |
| `OAI-SearchBot`   | OpenAI       | Allow — ChatGPT search index       |
| `ClaudeBot`       | Anthropic    | Allow — helps Claude cite DorkOS   |
| `PerplexityBot`   | Perplexity   | Allow — search index               |
| `Google-Extended` | Google       | Allow — Gemini AI Overviews        |
| `CCBot`           | Common Crawl | Disallow — aggressive, low benefit |
| `Bytespider`      | ByteDance    | Disallow — often non-compliant     |

**Schema.org for AI comprehension**: In 2025, structured data evolved from an SEO tactic to infrastructure for AI systems. Microsoft's NLWeb initiative (built on Schema.org) enables AI agents to query website content conversationally. The most impactful schema types for a developer tool are `SoftwareApplication`, `WebSite`, `Organization`, and `BlogPosting`.

### 4. Next.js 16 Metadata API — Current State and Gotchas

**Breaking change in v16.0.0**: `params` in `opengraph-image.tsx` and `twitter-image.tsx` is now a **Promise**. The current files don't use `params` (they are root-level static images) so this doesn't affect them. But any route-level OG images for blog posts must `await params`.

**Metadata merging behavior — critical for OG images**:
Next.js does a **shallow merge** of metadata objects across layout then page. This means:

- If `app/layout.tsx` defines `openGraph: { images: [...] }` and `app/blog/[slug]/page.tsx` defines `openGraph: { title, description }` WITHOUT `images`, the entire `openGraph` object from the layout is **replaced** — and the `images` field is lost.
- The file-based `opengraph-image.tsx` at the root level has higher priority than the `metadata` object.
- Blog posts currently inherit the root OG image because they have no route-level `opengraph-image.tsx`. Adding one per-route is the correct fix.

**Streaming metadata** (introduced v15.2.0): `generateMetadata` is now streamed — it no longer blocks the initial HTML response for JS-capable bots. For HTML-limited bots like `facebookexternalhit`, metadata still appears in `<head>`. OG image for Facebook link previews is correctly served.

**File-based metadata takes priority over object-based**:

```
opengraph-image.tsx > metadata.openGraph.images
twitter-image.tsx   > metadata.twitter.images
```

Since both route files exist, the comments in `layout.tsx` noting auto-generation are accurate. The issue is that the two files currently have different marketing taglines.

**Edge runtime limitation**: `export const runtime = 'edge'` means `readFile` from `node:fs/promises` is NOT available. The current images render without IBM Plex Sans font. They fall back to whatever the edge runtime's default font is.

**ImageResponse CSS support**: Supports flexbox, absolute positioning, custom fonts, text wrapping. Does NOT support CSS Grid, `overflow`, `transform`, or many other properties. The current OG images use supported patterns correctly.

**Caching**: `opengraph-image.tsx` route handlers are statically generated at build time and cached. This is correct behavior for the static homepage image. For blog post dynamic OG images, the same caching applies since they use `generateStaticParams`.

---

## Detailed Analysis

### Current State Assessment

**What is already correct:**

- `metadataBase: new URL(siteConfig.url)` in root layout — required for all relative URL resolution
- OG image dimensions: 1200x630 — correct
- `contentType: 'image/png'` — correct
- `twitter.card: 'summary_large_image'` — correct
- `robots` with `googleBot` directive — correct
- `alternates.canonical` — present
- `viewport` exported separately from `metadata` — correct (required since Next.js 14)
- Sitemap includes doc pages — good
- `siteConfig` singleton for centralized config — excellent pattern

**What is missing or needs improvement:**

| Item                                          | Priority | Impact                                |
| --------------------------------------------- | -------- | ------------------------------------- |
| JSON-LD structured data (SoftwareApplication) | High     | AI comprehension, Google rich results |
| `llms.txt` at root                            | High     | AI agent discoverability              |
| Blog post OG images (dynamic per-post)        | High     | CTR on social shares                  |
| Blog posts in sitemap                         | Medium   | Search indexing                       |
| Favicon infrastructure                        | Medium   | Brand recognition                     |
| robots.ts — block CCBot/Bytespider            | Medium   | Reduce scraper load                   |
| `/test/` routes excluded from robots disallow | Medium   | Avoid indexing dev pages              |
| OG image consistency (two different taglines) | Low      | Brand coherence                       |
| Custom font in OG images                      | Low      | Visual quality                        |
| Meta description wordsmithing                 | Low      | CTR improvement                       |
| llms-full.txt                                 | Low      | Deep AI comprehension                 |

### Implementation Roadmap

#### Phase 1 — Structural Fixes (no user-visible changes, high SEO value)

**1.1 Add blog posts to sitemap**

In `apps/web/src/app/sitemap.ts`:

```ts
import { source, blog } from '@/lib/source';

const blogPages: MetadataRoute.Sitemap = blog.getPages().map((page) => ({
  url: `${BASE_URL}/blog/${page.slugs[0]}`,
  lastModified: new Date(page.data.date),
  changeFrequency: 'monthly' as const,
  priority: 0.6,
}));

return [...staticPages, ...docPages, ...blogPages];
```

**1.2 Exclude `/test/` from robots.txt disallow**

```ts
// robots.ts
disallow: ['/api/', '/_next/', '/test/'],
```

**1.3 Update robots.ts with explicit AI crawler strategy**

```ts
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/_next/', '/test/'],
      },
      // Block Common Crawl — aggressive scraper with limited benefit
      {
        userAgent: 'CCBot',
        disallow: '/',
      },
      // Block Bytespider — frequently non-compliant with robots.txt
      {
        userAgent: 'Bytespider',
        disallow: '/',
      },
    ],
    sitemap: `${siteConfig.url}/sitemap.xml`,
  };
}
```

#### Phase 2 — Structured Data

**2.1 SoftwareApplication + WebSite JSON-LD on homepage**

Add to `apps/web/src/app/(marketing)/page.tsx` (or extract to a shared component):

```tsx
const softwareAppJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'DorkOS',
  description: siteConfig.description,
  url: siteConfig.url,
  downloadUrl: siteConfig.npm,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'macOS, Linux, Windows',
  license: `${siteConfig.github}/blob/main/LICENSE`,
  codeRepository: siteConfig.github,
  screenshot: `${siteConfig.url}/images/dorkos-screenshot.png`,
  featureList: [
    'Web UI for Claude Code',
    'AI agent scheduling',
    'Inter-agent messaging',
    'Agent mesh discovery',
    'Tool approval flows',
    'SSE streaming',
  ],
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
};

const websiteJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'DorkOS',
  url: siteConfig.url,
};

// In the component, before the return or as a fragment child:
// <script type="application/ld+json" ... />
// (use JSON.stringify with .replace(/</g, '\\u003c') per Next.js docs)
```

**2.2 BlogPosting JSON-LD on blog post pages**

Extend `apps/web/src/app/(marketing)/blog/[slug]/page.tsx`:

```ts
const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'BlogPosting',
  headline: page.data.title,
  description: page.data.description,
  datePublished: new Date(page.data.date).toISOString(),
  author: { '@type': 'Organization', name: 'DorkOS', url: siteConfig.url },
  publisher: { '@type': 'Organization', name: 'DorkOS', url: siteConfig.url },
  url: `${siteConfig.url}/blog/${params.slug}`,
};
```

#### Phase 3 — llms.txt

**3.1 Static approach** (recommended for launch):

Create `apps/web/public/llms.txt` with the content structure shown in Section 3. This is served by Next.js/Vercel as a static file with no server overhead.

**3.2 Dynamic approach** (enhancement):

Create `apps/web/src/app/llms.txt/route.ts`:

```ts
import { source } from '@/lib/source';
import { siteConfig } from '@/config/site';

export const dynamic = 'force-static';

export async function GET() {
  const docPages = source.getPages();
  const links = docPages
    .map((page) => `- [${page.data.title}](${siteConfig.url}${page.url})`)
    .join('\n');

  const body = [
    `# DorkOS`,
    ``,
    `> ${siteConfig.description}`,
    ``,
    `## Documentation`,
    ``,
    links,
    ``,
    `## Optional`,
    ``,
    `- [Blog](${siteConfig.url}/blog)`,
    `- [GitHub](${siteConfig.github})`,
    `- [npm](${siteConfig.npm})`,
  ].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
```

#### Phase 4 — Favicon Infrastructure

Files to create:

- `apps/web/src/app/favicon.ico` (32x32 ICO derived from triangle logo)
- `apps/web/src/app/icon.svg` (SVG with dark-mode-aware `fill`)
- `apps/web/src/app/apple-icon.png` (180x180, solid background)
- `apps/web/public/site.webmanifest`
- `apps/web/public/icon-192.png`
- `apps/web/public/icon-512.png`

Add to root layout `metadata`:

```ts
manifest: '/site.webmanifest',
```

The `icon.*` and `apple-icon.*` files in `app/` are auto-detected by Next.js — no metadata config needed for them.

`site.webmanifest` content:

```json
{
  "name": "DorkOS",
  "short_name": "DorkOS",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "theme_color": "#E86C3A",
  "background_color": "#FFFCF7",
  "display": "standalone"
}
```

#### Phase 5 — Blog Post OG Images

Create `apps/web/src/app/(marketing)/blog/[slug]/opengraph-image.tsx`:

```tsx
import { ImageResponse } from 'next/og';
import { blog } from '@/lib/source';
import { notFound } from 'next/navigation';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = blog.getPage([slug]);
  if (!page) notFound();

  return new ImageResponse(
    <div
      style={{
        background: '#FFFCF7',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        padding: '80px',
        position: 'relative',
      }}
    >
      {/* Grid background matching brand */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'linear-gradient(to right, rgba(139,90,43,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(139,90,43,0.08) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />
      {/* Section label */}
      <span
        style={{
          fontSize: 18,
          color: '#E86C3A',
          letterSpacing: '0.15em',
          textTransform: 'uppercase',
          marginBottom: 24,
          fontFamily: 'monospace',
        }}
      >
        DorkOS Blog
      </span>
      {/* Article title */}
      <span
        style={{
          fontSize: 56,
          fontWeight: 700,
          color: '#2C2C2C',
          lineHeight: 1.1,
          letterSpacing: '-0.03em',
          maxWidth: 900,
        }}
      >
        {page.data.title}
      </span>
      {/* Description */}
      {page.data.description && (
        <span
          style={{
            fontSize: 24,
            color: '#6B6B6B',
            marginTop: 20,
            maxWidth: 800,
          }}
        >
          {page.data.description}
        </span>
      )}
      {/* Brand stripes */}
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
        <div style={{ height: 8, background: '#E86C3A' }} />
        <div style={{ height: 8, background: '#5B8C5A' }} />
      </div>
    </div>,
    { ...size }
  );
}
```

---

## Sources & Evidence

- [Open Graph Image Sizes — Complete 2025 Guide](https://www.krumzi.com/blog/open-graph-image-sizes-for-social-media-the-complete-2025-guide)
- [OG Image Size Guide 2026](https://myogimage.com/blog/og-image-size-meta-tags-complete-guide)
- [The /llms.txt Specification — llmstxt.org](https://llmstxt.org/)
- [What is llms.txt — Mintlify](https://www.mintlify.com/blog/what-is-llms-txt)
- [llms.txt complete guide — Publii](https://getpublii.com/blog/llms-txt-complete-guide.html)
- [Next.js opengraph-image and twitter-image docs](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/opengraph-image)
- [Next.js generateMetadata API reference](https://nextjs.org/docs/app/api-reference/functions/generate-metadata)
- [Next.js JSON-LD guide](https://nextjs.org/docs/app/guides/json-ld)
- [Next.js sitemap.xml](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/sitemap)
- [Next.js robots.txt](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/robots)
- [Twitter/X Summary Card with Large Image](https://developer.x.com/en/docs/x-for-websites/cards/overview/summary-card-with-large-image)
- [Schema.org SoftwareApplication](https://schema.org/SoftwareApplication)
- [Schema Markup for AI — The HOTH](https://www.thehoth.com/blog/schema-markup-for-ai/)
- [What 2025 Revealed About AI Search and Schema Markup](https://www.schemaapp.com/schema-markup/what-2025-revealed-about-ai-search-and-the-future-of-schema-markup/)
- [AI Crawlers — Cloudflare](https://blog.cloudflare.com/from-googlebot-to-gptbot-whos-crawling-your-site-in-2025/)
- [How to Favicon in 2026 — Evil Martians](https://evilmartians.com/chronicles/how-to-favicon-in-2021-six-files-that-fit-most-needs)
- [Next.js Favicon documentation](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/app-icons)
- [Vercel: The Rise of the AI Crawler](https://vercel.com/blog/the-rise-of-the-ai-crawler)
- [Level up link previews in Slack](https://whitep4nth3r.com/blog/level-up-your-link-previews-in-slack/)
- [Anthropic Claude Bots robots.txt granularity](https://www.searchenginejournal.com/anthropics-claude-bots-make-robots-txt-decisions-more-granular/568253/)
- [OG Image Size Guide — platform differences](https://ogpreview.app/guides/og-image-sizes)
- [Understanding AI Crawlers 2025](https://www.qwairy.co/blog/understanding-ai-crawlers-complete-guide)

---

## Research Gaps & Limitations

- **Domain verification**: Cannot confirm whether `dorkos.ai` is verified with Google Search Console or whether platforms have cached stale OG images. OG cache busting tools (LinkedIn Post Inspector, Facebook Sharing Debugger, Twitter Card Validator) should be run post-deployment.
- **llms-full.txt adoption metrics**: Hard data on whether `llms-full.txt` provides measurably better AI citation rates vs `llms.txt` is limited. The token-reduction argument is sound for AI coding assistants (Cursor, Windsurf) but less proven for general AI search.
- **Favicon assets**: The DorkOS logo SVGs exist in `public/images/` but none are in favicon-appropriate formats with the required padding/background. Actual icon design and export work is needed before Phase 4 can be implemented.

---

## Contradictions & Disputes

- **llms.txt skepticism**: Some argue (Peec AI, among others) that llms.txt has limited practical impact on citation rates today because most AI systems don't actively fetch it during inference — it primarily helps retrieval-augmented systems like Perplexity and AI coding assistants. This is a valid concern. However, the cost of adding it is near-zero and Anthropic, Vercel, and Stripe have adopted it.
- **Same vs separate OG/Twitter image**: Next.js docs say Twitter inherits the OG image automatically if no `twitter-image.tsx` is present. The presence of a separate `twitter-image.tsx` with DIFFERENT content is a valid design choice but creates a maintenance burden. The two files currently have different taglines ("Claude Code in your browser" vs "Build fast. Learn faster."). This should be an explicit decision, not an accidental divergence.
- **AI crawler blocking vs allowing**: Some sites block all AI crawlers to protect content. For an open-source developer tool like DorkOS where discoverability is the goal, allowing indexing crawlers is the correct call. The distinction between training crawlers (GPTBot) and retrieval crawlers (OAI-SearchBot) matters less here since DorkOS has no proprietary content to protect.

---

## Search Methodology

- Searches performed: 14
- Tool calls total: ~25 (searches + fetches + file reads)
- Most productive terms: "llms.txt standard AI agent readability 2025", "Next.js 16 metadata opengraph-image", "SoftwareApplication schema.org JSON-LD", "AI crawlers robots.txt user-agent 2025"
- Primary sources: nextjs.org official docs (v16.1.6, updated 2026-02-27), llmstxt.org, schema.org, developer.x.com, Cloudflare blog, Vercel blog, Evil Martians
- Codebase review: `apps/web/src/app/layout.tsx`, `opengraph-image.tsx`, `twitter-image.tsx`, `robots.ts`, `sitemap.ts`, `config/site.ts`, `blog/[slug]/page.tsx`, `public/` directory
