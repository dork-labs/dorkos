---
title: "Adding a Blog to a Next.js + Fumadocs Site"
date: 2026-02-18
type: implementation
status: archived
tags: [fumadocs, blog, next-js, mdx, release-notes]
feature_slug: world-class-release-notes
---

# Research: Adding a Blog to a Next.js + Fumadocs Site

**Date:** 2026-02-18
**Mode:** Deep Research
**Context:** DorkOS marketing site at `apps/web` — Next.js 16, Fumadocs, already using `fumadocs-mdx`, `source.config.ts`, and a single `docs` collection at `../../docs`.

---

## Research Summary

Fumadocs has first-class blog support via `defineCollections` in `source.config.ts` — no separate package required. The canonical approach is to add a second collection alongside the existing `docs` collection, expose it through a new `blog` loader in `lib/source.ts`, and add a `(marketing)/blog/` route group with an index and `[slug]` page. The blog lives entirely within the same Fumadocs MDX pipeline already present in the project.

For release announcements specifically, the recommended approach (used by Next.js, Tailwind CSS, and Fumadocs itself) is to treat release posts as a blog category or as a dedicated `/blog/releases/` subcollection — keeping announcement posts as full MDX documents rather than the flat `changelog.mdx` file that currently exists.

---

## Key Findings

### 1. Fumadocs Has Built-In Blog Support (No Extra Package)

Fumadocs does **not** have a separate `fumadocs-blog` npm package. Blog support is built into `fumadocs-mdx` via the `defineCollections` API introduced in fumadocs-mdx v10+. There is a community scaffolding project (`rjv.im/blog/...`) that provides opinionated helpers, but they are optional — the core machinery is all in `fumadocs-mdx`.

The official Fumadocs guide ("Making a Blog with Fumadocs", published Dec 2024) uses:
- `defineCollections` in `source.config.ts`
- `loader()` from `fumadocs-core/source` with `toFumadocsSource()`
- Standard Next.js App Router page files under `app/(home)/blog/`

Fumadocs.dev itself uses this exact approach for its own `/blog` section (confirmed live — 17+ posts as of 2025, e.g. "Fumadocs v16", "Fumadocs MDX v12").

### 2. How the Blog Collection System Works

The pipeline has three layers:

**Layer 1 — `source.config.ts`** (build-time, Zod validation):
Defines what MDX files exist and validates their frontmatter.

**Layer 2 — `lib/source.ts`** (runtime, loader):
Exposes typed page accessors (`getPages()`, `getPage([slug])`).

**Layer 3 — App Router pages** (rendering):
Standard Next.js pages that call the source API and render MDX body.

### 3. How Major Developer-Tool Sites Handle Blogs / Release Pages

| Site | Approach | URL Pattern | Technology |
|------|----------|-------------|------------|
| **Next.js** | MDX files in `pages/blog/` (Pages Router), each as its own folder with `index.mdx` + re-exported metadata | `/blog/next-16` | `@next/mdx`, custom `getAllPostPreviews()` util |
| **Tailwind CSS** | Same — each post is a folder with `index.mdx` + metadata exported as `meta` object | `/blog/building-the-tailwind-blog` | Custom MDX pipeline |
| **Fumadocs** | `defineCollections` with `dir: 'content/blog'`, rendered at `/blog/[slug]` | `/blog/v16` | `fumadocs-mdx` (their own library) |
| **shadcn/ui** | Changelog as a flat docs page (`/docs/changelog`) for simple projects; separate blog for major announcements | `/docs/changelog` | Fumadocs-style MDX |

The clear pattern from mature developer-tool projects: **use real blog posts for release announcements** (not a flat `changelog.mdx`). A `/blog/releases/` category or a `type: 'release'` frontmatter field lets you query only release posts for a "What's New" section, while the same posts also appear in the main blog feed.

### 4. Best Way to Structure Release Pages That Also Serve as a General Blog

Two viable approaches for DorkOS:

**Option A — Single blog with a `category` frontmatter field (Recommended)**

One collection at `content/blog/`, posts can have `category: 'release' | 'tutorial' | 'news'`. The index page shows all posts; a `/blog?category=release` filter or a separate `/releases` page queries by category. This is what Fumadocs itself does — release posts are just blog posts tagged differently.

**Option B — Two separate collections**

`content/blog/` (general posts) + `content/releases/` (release notes). Two loaders, two route groups. Cleaner separation but more boilerplate. Worth it only if release notes need substantially different rendering (e.g. a versioned changelog component, diff viewer, etc.).

For DorkOS at its current stage, **Option A** is the right choice. The existing `docs/changelog.mdx` can stay for the docs sidebar; the blog becomes the primary surface for release storytelling.

---

## Detailed Analysis

### Current DorkOS Setup

```
apps/web/
├── source.config.ts          # Only has: defineDocs({ dir: '../../docs' })
├── src/
│   ├── lib/source.ts         # Only has: loader({ baseUrl: '/docs', ... })
│   ├── app/
│   │   ├── (marketing)/      # Marketing layout — cream background, MarketingShell
│   │   │   └── page.tsx      # Landing page
│   │   └── (docs)/           # Fumadocs layout — DocsLayout, RootProvider, sidebar
│   │       └── docs/[[...slug]]/page.tsx
```

The blog should live in `app/(marketing)/blog/` so it uses the existing marketing layout (header, footer, nav) rather than the docs sidebar layout. This matches how Fumadocs.dev structures its own blog.

### Exact Code Changes Required

#### Step 1: Add the blog collection to `source.config.ts`

```typescript
// apps/web/source.config.ts
import { defineConfig, defineDocs, defineCollections } from 'fumadocs-mdx/config'
import { z } from 'zod'

export const docs = defineDocs({
  dir: '../../docs',
})

export const blogPosts = defineCollections({
  type: 'doc',
  dir: '../../blog',  // Root-level blog/ directory in the monorepo
  schema: (ctx) =>
    z.object({
      title: z.string(),
      description: z.string().optional(),
      date: z.coerce.date(),
      author: z.string().optional(),
      category: z.enum(['release', 'tutorial', 'announcement', 'news']).optional(),
      tags: z.array(z.string()).optional(),
      image: z.string().optional(),
    }),
})

export default defineConfig()
```

**Note on `dir`:** The existing `docs` uses `dir: '../../docs'` (relative to `apps/web/`). For a root-level `blog/` directory, use `dir: '../../blog'`. Alternatively, keep blog content co-located as `dir: 'content/blog'` within `apps/web/content/blog/`.

The monorepo-root approach (`../../blog`) is cleaner for DorkOS since `docs/` already lives at the root — blog posts conceptually belong at the same level.

#### Step 2: Add blog loader to `lib/source.ts`

```typescript
// apps/web/src/lib/source.ts
import { docs, blogPosts } from '@/.source'
import { loader } from 'fumadocs-core/source'
import { openapiPlugin } from 'fumadocs-openapi/server'
import { toFumadocsSource } from 'fumadocs-mdx/runtime/server'

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
  plugins: [openapiPlugin()],
})

export const blog = loader({
  baseUrl: '/blog',
  source: toFumadocsSource(blogPosts, []),
})
```

**Important:** The import path for `blogPosts` is `@/.source` (the generated virtual module), not `source.config.ts` directly. The `@/.source` module is auto-generated by `fumadocs-mdx` during build from the `source.config.ts` definitions.

#### Step 3: Blog index page

```typescript
// apps/web/src/app/(marketing)/blog/page.tsx
import Link from 'next/link'
import { blog } from '@/lib/source'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Blog - DorkOS',
  description: 'Updates, releases, and writing from the DorkOS team.',
}

export default function BlogIndexPage() {
  const posts = blog
    .getPages()
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime())

  return (
    <main className="w-full max-w-4xl mx-auto px-4 py-16">
      <h1 className="text-4xl font-bold mb-2">Blog</h1>
      <p className="text-muted-foreground mb-12">
        Updates, releases, and writing from the DorkOS team.
      </p>
      <div className="flex flex-col gap-8">
        {posts.map((post) => (
          <Link
            key={post.url}
            href={post.url}
            className="group flex flex-col gap-2"
          >
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <time dateTime={post.data.date.toISOString()}>
                {post.data.date.toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </time>
              {post.data.category && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize">
                  {post.data.category}
                </span>
              )}
            </div>
            <h2 className="text-xl font-semibold group-hover:underline">
              {post.data.title}
            </h2>
            {post.data.description && (
              <p className="text-muted-foreground">{post.data.description}</p>
            )}
          </Link>
        ))}
      </div>
    </main>
  )
}
```

#### Step 4: Individual blog post page

```typescript
// apps/web/src/app/(marketing)/blog/[slug]/page.tsx
import { notFound } from 'next/navigation'
import { InlineTOC } from 'fumadocs-ui/components/inline-toc'
import defaultMdxComponents from 'fumadocs-ui/mdx'
import { blog } from '@/lib/source'
import type { Metadata } from 'next'

interface PageProps {
  params: Promise<{ slug: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const post = blog.getPage([slug])
  if (!post) notFound()

  return {
    title: `${post.data.title} - DorkOS Blog`,
    description: post.data.description,
    openGraph: {
      title: post.data.title,
      description: post.data.description,
      type: 'article',
      publishedTime: post.data.date.toISOString(),
    },
  }
}

export function generateStaticParams(): { slug: string }[] {
  return blog.getPages().map((post) => ({ slug: post.slugs[0] }))
}

export default async function BlogPostPage({ params }: PageProps) {
  const { slug } = await params
  const post = blog.getPage([slug])
  if (!post) notFound()

  const Mdx = post.data.body

  return (
    <main className="w-full max-w-4xl mx-auto px-4 py-16">
      <div className="mb-8">
        <div className="flex items-center gap-3 text-sm text-muted-foreground mb-3">
          <time dateTime={post.data.date.toISOString()}>
            {post.data.date.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </time>
          {post.data.category && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize">
              {post.data.category}
            </span>
          )}
        </div>
        <h1 className="text-4xl font-bold mb-3">{post.data.title}</h1>
        {post.data.description && (
          <p className="text-xl text-muted-foreground">{post.data.description}</p>
        )}
        {post.data.author && (
          <p className="mt-4 text-sm text-muted-foreground">
            By {post.data.author}
          </p>
        )}
      </div>

      <InlineTOC items={post.data.toc} />

      <article className="prose prose-neutral dark:prose-invert max-w-none mt-8">
        <Mdx components={defaultMdxComponents} />
      </article>
    </main>
  )
}
```

#### Step 5: Example blog post MDX file

```mdx
---
title: DorkOS 0.2.0 — Marketing Site, Tunnels, and FSD Migration
description: This release ships the public marketing site, Fumadocs docs, runtime tunnel toggling, and completes the Feature-Sliced Design client migration.
date: 2026-02-17
author: DorkOS Team
category: release
tags: [release, fsd, docs, tunnel]
---

## What's New

DorkOS 0.2.0 is here. Here's what changed.

### Marketing Site

The marketing site at `apps/web` now serves a full landing page...

### Fumadocs Integration

All documentation is now rendered through Fumadocs...
```

#### Step 6: Final directory structure

```
monorepo root/
├── blog/                         # NEW: root-level blog content (mirrors docs/)
│   ├── dorkos-0-2-0.mdx          # Release post
│   └── introducing-dorkos.mdx    # Announcement
├── docs/                         # Existing docs content
│   ├── changelog.mdx             # Keep for docs sidebar (detailed format)
│   └── ...
apps/web/
├── source.config.ts              # MODIFIED: add blogPosts collection
├── src/
│   ├── lib/source.ts             # MODIFIED: add blog loader
│   └── app/
│       └── (marketing)/
│           └── blog/             # NEW
│               ├── page.tsx      # Blog index
│               └── [slug]/
│                   └── page.tsx  # Individual post
```

### The `@/.source` Virtual Module

This is the key detail that trips people up. When you add a new collection in `source.config.ts`, it is not immediately importable. The `fumadocs-mdx` Next.js plugin (called via `createMDX()` in `next.config.ts`) generates a virtual module at `@/.source` at build time. That module exports both `docs` and `blogPosts` (whatever you export from `source.config.ts`).

In the existing `lib/source.ts`, the import is:
```typescript
import { docs } from '@/.source'
```

After adding the blog collection, it becomes:
```typescript
import { docs, blogPosts } from '@/.source'
```

The `toFumadocsSource()` helper from `fumadocs-mdx/runtime/server` wraps a raw collection for use with `loader()`. Note: `defineDocs` (used for docs) has a `.toFumadocsSource()` method built in; `defineCollections` (used for blog) requires the explicit `toFumadocsSource(blogPosts, [])` call.

### Handling the `InlineTOC` in the Marketing Layout

The `InlineTOC` component from `fumadocs-ui/components/inline-toc` works outside the `DocsLayout` — it is a standalone component. However, it requires `fumadocs-ui/style.css` to be loaded. Currently this CSS is imported in `app/(docs)/layout.tsx`. To use Fumadocs UI components in the blog (marketing layout), add the same import to the marketing layout or a shared root layout.

Two options:
1. Import `fumadocs-ui/style.css` in `app/layout.tsx` (root layout) — simplest, affects all routes
2. Import it in `app/(marketing)/blog/layout.tsx` — scoped to blog only

The Fumadocs UI styles are scoped via CSS custom properties so they won't conflict with Tailwind.

### Release Pages: Dual Surface Strategy

For DorkOS specifically, the recommended structure is:

- `docs/changelog.mdx` — Keep as-is. This is the machine-readable, structured format (Keep a Changelog). Stays in the docs sidebar under `/docs/changelog`. Good for developers reading docs linearly.
- `blog/dorkos-X-Y-Z.mdx` — Human-readable release stories with context, screenshots, migration guides. Lives at `/blog/dorkos-0-2-0`. Good for announcements, SEO, social sharing.

These are complementary, not redundant. The changelog is a table of facts; the blog post is the story behind the facts. Next.js does exactly this: they have a structured changelog in their GitHub releases AND full blog posts at `/blog/next-16`.

### Sorting and Filtering Posts

The `blog.getPages()` call returns all pages. Since Fumadocs loaders don't have a built-in `orderBy`, sort in the page component:

```typescript
// Sort by date descending (newest first)
const posts = blog.getPages().sort(
  (a, b) => b.data.date.getTime() - a.data.date.getTime()
)

// Filter to only release posts
const releases = blog.getPages()
  .filter((p) => p.data.category === 'release')
  .sort((a, b) => b.data.date.getTime() - a.data.date.getTime())
```

This can be extracted to a `lib/blog.ts` helper once there are enough query patterns to justify it.

### RSS Feed (Optional But Recommended)

A `/blog/feed.xml` route for RSS is a one-file addition:

```typescript
// apps/web/src/app/blog/feed.xml/route.ts
import { blog } from '@/lib/source'

export function GET() {
  const posts = blog.getPages().sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime()
  )

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>DorkOS Blog</title>
    <link>https://dorkos.ai/blog</link>
    <description>Updates from the DorkOS team</description>
    ${posts
      .map(
        (post) => `
    <item>
      <title>${post.data.title}</title>
      <link>https://dorkos.ai${post.url}</link>
      <pubDate>${post.data.date.toUTCString()}</pubDate>
      <description>${post.data.description ?? ''}</description>
    </item>`
      )
      .join('')}
  </channel>
</rss>`

  return new Response(rss, {
    headers: { 'Content-Type': 'application/xml' },
  })
}
```

---

## How Reference Sites Handle Blogs

### Next.js (`nextjs.org/blog`)
- Each release post is a standalone MDX file with rich content (tables, code blocks, images)
- URL pattern: `/blog/next-16`, `/blog/next-15-3`
- Post metadata is a `meta` object exported from each MDX file
- Build utility `getAllPostPreviews()` reads all posts, sorts by date
- No "blog framework" — custom `getAllPostPreviews()` utility + standard `@next/mdx`
- Separate from their versioned docs — announcement posts are editorial, not docs

### Tailwind CSS (`tailwindcss.com/blog`)
- Same folder-per-post structure with `index.mdx` + metadata re-export
- Metadata includes: `title`, `description`, `date`, `authors` (array), OG image, Discussion link
- Notable: every post links to a GitHub Discussions thread for comments
- Also uses a custom MDX pipeline, not Fumadocs

### Fumadocs (`fumadocs.dev/blog`)
- Uses their own `defineCollections` API (the exact approach documented above)
- URL pattern: `/blog/v16`, `/blog/mdx-v10`
- Index page is a card grid sorted by date
- No pagination for developer-tool blogs at their scale (< 50 posts)

### shadcn/ui (`ui.shadcn.com`)
- Uses a flat `/docs/changelog` page for release notes (Fumadocs docs page)
- No separate blog — their "blog" is their Twitter/X activity
- Works at their scale because changes are incremental component additions, not releases

---

## Recommendation for DorkOS

Given the existing setup, **the lowest-friction path is:**

1. Add `defineCollections` for `blogPosts` to `source.config.ts`
2. Add `blog` loader to `lib/source.ts`
3. Create `blog/` directory at monorepo root (sibling to `docs/`)
4. Add `app/(marketing)/blog/page.tsx` and `app/(marketing)/blog/[slug]/page.tsx`
5. Write the first post as a 0.2.0 release announcement (`blog/dorkos-0-2-0.mdx`)
6. Keep `docs/changelog.mdx` as-is for the docs sidebar

This reuses 100% of existing infrastructure — no new packages, no separate MDX pipeline, no separate Next.js config changes. The only addition is ~40 lines across two new page files and a two-line change to `source.config.ts` and `lib/source.ts`.

The key files to change/create:
- `apps/web/source.config.ts` — add `blogPosts` collection
- `apps/web/src/lib/source.ts` — add `blog` loader
- `apps/web/src/app/(marketing)/blog/page.tsx` — blog index
- `apps/web/src/app/(marketing)/blog/[slug]/page.tsx` — post page
- `blog/` directory at monorepo root with MDX posts

---

## Research Gaps and Limitations

- The `toFumadocsSource()` vs `.toFumadocsSource()` API difference between `defineCollections` and `defineDocs` was not fully documented in official sources — inferred from the "Making a Blog" guide and confirmed by looking at existing `source.ts` in the project.
- Pagination: Fumadocs does not provide a built-in `paginate()` helper for the blog loader. For > 20 posts, a custom cursor-based or page-number approach would be needed.
- Search integration: The Fumadocs search index only covers docs sources by default. Blog posts would need to be added to the search source separately (or excluded intentionally).

---

## Sources and Evidence

- "Making a Blog with Fumadocs" (official guide, Dec 2024): https://www.fumadocs.dev/blog/make-a-blog
- Fumadocs Collections docs: https://www.fumadocs.dev/docs/mdx/collections
- "Setup a Blog with NextJS & Fuma Docs" (community deep-dive): https://rjv.im/blog/solution/setup-blog-with-fuma-docs
- Fumadocs live blog (proof of concept): https://www.fumadocs.dev/blog
- Next.js blog release example: https://nextjs.org/blog/next-16
- "Building the Tailwind Blog" (architecture reference): https://tailwindcss.com/blog/building-the-tailwind-blog
- shadcn/ui changelog approach: https://ui.shadcn.com/docs/changelog

---

## Search Methodology

- Searches performed: 9
- Most productive search terms: `fumadocs defineCollections blog source.config.ts`, `fumadocs blog support plugin 2025`, `Next.js MDX blog alongside fumadocs`
- Primary information sources: fumadocs.dev official docs and blog, rjv.im community guide, nextjs.org blog, direct codebase inspection
- Codebase files inspected: `source.config.ts`, `lib/source.ts`, `app/(docs)/layout.tsx`, `app/(docs)/docs/[[...slug]]/page.tsx`, `app/(marketing)/layout.tsx`, `next.config.ts`, `components/mdx-components.tsx`, `docs/changelog.mdx`
