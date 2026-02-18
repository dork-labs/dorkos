---
slug: world-class-release-notes
number: 44
created: 2026-02-18
status: decomposed
last-decompose: 2026-02-18
---

# World-Class Release Notes & Blog Infrastructure — Tasks

## Phase 1: Blog Infrastructure (Foundation)

### Task 1: Add blogPosts collection to source.config.ts

Update `apps/web/source.config.ts` to add the `blogPosts` collection using `defineCollections` from `fumadocs-mdx/config`. The existing `docs` export must remain unchanged.

**File**: `apps/web/source.config.ts`

```typescript
import { defineConfig, defineDocs, defineCollections } from 'fumadocs-mdx/config'
import { z } from 'zod'

export const docs = defineDocs({
  dir: '../../docs',
})

export const blogPosts = defineCollections({
  type: 'doc',
  dir: '../../blog',
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

**Acceptance Criteria:**
- [ ] `blogPosts` collection exported from `source.config.ts`
- [ ] Zod schema validates all frontmatter fields (title required, rest optional)
- [ ] `docs` export unchanged
- [ ] TypeScript compiles (`npx tsc --noEmit` in `apps/web`)

---

### Task 2: Add blog loader to lib/source.ts

Update `apps/web/src/lib/source.ts` to add a `blog` loader alongside the existing `source` loader. Must import `toFumadocsSource` from `fumadocs-mdx/runtime/server` since `defineCollections` does not have `.toFumadocsSource()` built in (unlike `defineDocs`).

**File**: `apps/web/src/lib/source.ts`

```typescript
import { docs, blogPosts } from '@/.source'
import { loader } from 'fumadocs-core/source'
import { openapiPlugin } from 'fumadocs-openapi/server'
import { toFumadocsSource } from 'fumadocs-mdx/runtime/server'

/**
 * Fumadocs source loader for documentation pages.
 */
export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
  plugins: [openapiPlugin()],
})

/**
 * Fumadocs source loader for blog posts.
 */
export const blog = loader({
  baseUrl: '/blog',
  source: toFumadocsSource(blogPosts, []),
})
```

**Acceptance Criteria:**
- [ ] `blog` loader exported from `lib/source.ts`
- [ ] Uses `toFumadocsSource` from `fumadocs-mdx/runtime/server`
- [ ] `source` loader unchanged
- [ ] TypeScript compiles

---

### Task 3: Create blog content directory with v0.2.0 post

Create the `blog/` directory at the monorepo root (sibling to `docs/`) and write the retroactive v0.2.0 release post as `blog/dorkos-0-2-0.mdx`.

**Directory**: `blog/` (monorepo root)
**File**: `blog/dorkos-0-2-0.mdx`

The post should:
- Use the frontmatter schema: title, description, date (2026-02-17), author ("DorkOS Team"), category ("release"), tags
- Contain narrative content based on `CHANGELOG.md` v0.2.0 section AND the GitHub Release v0.2.0 content
- Include highlights for: marketing site, FSD migration, tunnel integration, config system, ESLint/Prettier, ADR system
- Be written in a blog-friendly narrative voice, not just bullet points
- Include the bug fix "CLI build failure for config-manager import resolution" that was missing from CHANGELOG.md but present in the GitHub Release

The CHANGELOG.md v0.2.0 section contains:
- Added: marketing website, logging, directory boundary, versioning, gtr, config, tunnel, ESLint, ADR, TSDoc
- Changed: FSD migration, guides rename, constants extraction, file splitting, port change, .env centralization
- Fixed: shell eval, OpenAPI JSON, API docs, React Compiler warnings, barrel imports

**Acceptance Criteria:**
- [ ] `blog/dorkos-0-2-0.mdx` exists with valid frontmatter
- [ ] Frontmatter date is `2026-02-17`
- [ ] Category is `release`
- [ ] Content covers all v0.2.0 changes in narrative form
- [ ] No v0.1.0 blog post created

---

### Task 4: Create blog index page

Create `apps/web/src/app/(marketing)/blog/page.tsx` that lists all blog posts sorted by date descending.

**File**: `apps/web/src/app/(marketing)/blog/page.tsx`

The page should:
- Import `blog` from `@/lib/source`
- Call `blog.getPages()` to get all posts
- Sort by date descending
- Display each post with: title, formatted date, category badge, and description
- Generate metadata with title "Blog"
- Use the marketing site's cream/neutral design tokens
- Be a server component (no 'use client')

```typescript
import { blog } from '@/lib/source'
import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Blog',
  description: 'Release notes, tutorials, and announcements from the DorkOS team.',
}

export default function BlogIndex() {
  const posts = blog.getPages().sort((a, b) => {
    const dateA = new Date(a.data.date ?? 0)
    const dateB = new Date(b.data.date ?? 0)
    return dateB.getTime() - dateA.getTime()
  })

  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="font-mono text-3xl font-bold tracking-tight text-neutral-900">Blog</h1>
      <p className="mt-2 text-neutral-600">
        Release notes, tutorials, and announcements from the DorkOS team.
      </p>
      <div className="mt-12 space-y-10">
        {posts.map((post) => (
          <article key={post.url}>
            <Link href={post.url} className="group block">
              <div className="flex items-center gap-3 text-sm text-neutral-500">
                <time dateTime={new Date(post.data.date).toISOString()}>
                  {new Date(post.data.date).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                </time>
                {post.data.category && (
                  <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-700">
                    {post.data.category}
                  </span>
                )}
              </div>
              <h2 className="mt-2 text-xl font-semibold text-neutral-900 group-hover:text-neutral-600">
                {post.data.title}
              </h2>
              {post.data.description && (
                <p className="mt-1 text-neutral-600">{post.data.description}</p>
              )}
            </Link>
          </article>
        ))}
      </div>
    </div>
  )
}
```

**Acceptance Criteria:**
- [ ] Blog index page renders at `/blog`
- [ ] Posts sorted by date descending
- [ ] Each post shows title, date, category badge, description
- [ ] Clicking a post navigates to `/blog/[slug]`
- [ ] Metadata generated with title "Blog"

---

### Task 5: Create blog post page with MDX rendering

Create `apps/web/src/app/(marketing)/blog/[slug]/page.tsx` that renders individual MDX blog posts.

**File**: `apps/web/src/app/(marketing)/blog/[slug]/page.tsx`

The page should:
- Import `blog` from `@/lib/source`
- Use `blog.getPage([slug])` to fetch the post
- Return `notFound()` for invalid slugs
- Render MDX content using the fumadocs `<MDXContent>` component approach
- Include `InlineTOC` from `fumadocs-ui/components/inline-toc` for table of contents
- Use `generateStaticParams()` for static site generation
- Generate OpenGraph metadata with `type: 'article'`

```typescript
import { blog } from '@/lib/source'
import { notFound } from 'next/navigation'
import { InlineTOC } from 'fumadocs-ui/components/inline-toc'
import defaultComponents from 'fumadocs-ui/mdx'
import type { Metadata } from 'next'

interface BlogPostProps {
  params: Promise<{ slug: string }>
}

export async function generateStaticParams() {
  return blog.getPages().map((page) => ({
    slug: page.slugs[0],
  }))
}

export async function generateMetadata({ params }: BlogPostProps): Promise<Metadata> {
  const { slug } = await params
  const page = blog.getPage([slug])
  if (!page) return {}

  return {
    title: page.data.title,
    description: page.data.description,
    openGraph: {
      title: page.data.title,
      description: page.data.description,
      type: 'article',
      publishedTime: new Date(page.data.date).toISOString(),
    },
  }
}

export default async function BlogPost({ params }: BlogPostProps) {
  const { slug } = await params
  const page = blog.getPage([slug])
  if (!page) notFound()

  const { body: MDXContent, toc } = await page.data.load()

  return (
    <article className="mx-auto max-w-3xl px-6 py-16">
      <div className="mb-8">
        <div className="flex items-center gap-3 text-sm text-neutral-500">
          <time dateTime={new Date(page.data.date).toISOString()}>
            {new Date(page.data.date).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </time>
          {page.data.category && (
            <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-700">
              {page.data.category}
            </span>
          )}
        </div>
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-neutral-900">
          {page.data.title}
        </h1>
        {page.data.description && (
          <p className="mt-2 text-lg text-neutral-600">{page.data.description}</p>
        )}
        {page.data.author && (
          <p className="mt-2 text-sm text-neutral-500">By {page.data.author}</p>
        )}
      </div>
      {toc.length > 0 && <InlineTOC items={toc} />}
      <div className="prose prose-neutral mt-8 max-w-none">
        <MDXContent components={defaultComponents} />
      </div>
    </article>
  )
}
```

**Acceptance Criteria:**
- [ ] Individual blog post renders at `/blog/dorkos-0-2-0`
- [ ] MDX content renders with fumadocs components
- [ ] InlineTOC shows for posts with headings
- [ ] `generateStaticParams()` generates static pages
- [ ] `notFound()` for invalid slugs
- [ ] OpenGraph metadata generated with `type: 'article'`

---

### Task 6: Add Fumadocs UI styles for blog pages

Blog pages need `fumadocs-ui/style.css` for `InlineTOC` and MDX components to render correctly. The `(docs)/layout.tsx` already imports it but the `(marketing)` route group does not.

Options:
1. Import `fumadocs-ui/style.css` in the blog post page or a blog-specific layout
2. Wrap blog content in `RootProvider` from `fumadocs-ui/provider/next` for theme support

Create a blog layout at `apps/web/src/app/(marketing)/blog/layout.tsx` that:
- Imports `fumadocs-ui/style.css`
- Wraps children in `RootProvider` from `fumadocs-ui/provider/next`

```typescript
import { RootProvider } from 'fumadocs-ui/provider/next'
import type { ReactNode } from 'react'
import 'fumadocs-ui/style.css'

export default function BlogLayout({ children }: { children: ReactNode }) {
  return <RootProvider>{children}</RootProvider>
}
```

**Acceptance Criteria:**
- [ ] Fumadocs MDX components render correctly on blog pages
- [ ] InlineTOC renders with proper styling
- [ ] Blog pages have theme support via RootProvider
- [ ] No style conflicts with marketing layout

---

### Task 7: Add "blog" to marketing navigation

Update `apps/web/src/app/(marketing)/page.tsx` to add "blog" to the `navLinks` array, positioned before "docs".

**File**: `apps/web/src/app/(marketing)/page.tsx`

Change the `navLinks` array from:
```typescript
const navLinks = [
  { label: 'system', href: '#system' },
  { label: 'features', href: '#features' },
  { label: 'about', href: '#about' },
  { label: 'contact', href: '#contact' },
  { label: 'docs', href: '/docs' },
]
```

To:
```typescript
const navLinks = [
  { label: 'system', href: '#system' },
  { label: 'features', href: '#features' },
  { label: 'about', href: '#about' },
  { label: 'contact', href: '#contact' },
  { label: 'blog', href: '/blog' },
  { label: 'docs', href: '/docs' },
]
```

**Acceptance Criteria:**
- [ ] "blog" link appears in marketing navigation
- [ ] Link navigates to `/blog`
- [ ] Positioned before "docs" link

---

### Task 8: Build verification for Phase 1

Run `npm run build -w apps/web` and `npx tsc --noEmit` in `apps/web` to verify everything compiles and builds.

If build errors occur due to Fumadocs API differences (e.g., `toFumadocsSource` import path, `page.data.load()` vs other API), fix them by consulting the installed Fumadocs version.

**Acceptance Criteria:**
- [ ] `npm run build -w apps/web` succeeds
- [ ] TypeScript compiles with no errors
- [ ] Blog index page is generated in build output
- [ ] Blog post page is generated in build output

---

## Phase 2: RSS Feed & Release Command Fixes

### Task 9: Create RSS feed route handler

Create `apps/web/src/app/blog/feed.xml/route.ts` (outside the `(marketing)` route group for a clean `/blog/feed.xml` URL).

**File**: `apps/web/src/app/blog/feed.xml/route.ts`

```typescript
import { blog } from '@/lib/source'
import { siteConfig } from '@/config/site'

export const dynamic = 'force-static'

export function GET() {
  const posts = blog.getPages().sort((a, b) => {
    const dateA = new Date(a.data.date ?? 0)
    const dateB = new Date(b.data.date ?? 0)
    return dateB.getTime() - dateA.getTime()
  })

  const items = posts
    .map(
      (post) => `    <item>
      <title>${escapeXml(post.data.title)}</title>
      <link>${siteConfig.url}${post.url}</link>
      <guid>${siteConfig.url}${post.url}</guid>
      <pubDate>${new Date(post.data.date).toUTCString()}</pubDate>
      ${post.data.description ? `<description>${escapeXml(post.data.description)}</description>` : ''}
    </item>`
    )
    .join('\n')

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>DorkOS Blog</title>
    <link>${siteConfig.url}/blog</link>
    <description>Release notes, tutorials, and announcements from the DorkOS team.</description>
    <language>en-us</language>
    <atom:link href="${siteConfig.url}/blog/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`

  return new Response(rss, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
    },
  })
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
```

**Acceptance Criteria:**
- [ ] RSS feed accessible at `/blog/feed.xml`
- [ ] Valid RSS 2.0 XML
- [ ] Posts sorted by date descending
- [ ] Each item has title, link, guid, pubDate, description
- [ ] Channel title is "DorkOS Blog"
- [ ] Static generation via `force-static`
- [ ] XML properly escaped

---

### Task 10: Fix Phase 5.9 content drift in release command

Update `.claude/commands/system/release.md` Phase 5.9 so the "All Changes" section in GitHub release notes is **copied directly from CHANGELOG.md**, not regenerated.

**File**: `.claude/commands/system/release.md`

Find the release notes template in Phase 5.9 and update it. The current template (around line 557-580) has:

```markdown
### All Changes

- [User-friendly bullet list]
- [Include references when available: (#123) or (abc1234)]
```

Replace with:

```markdown
### All Changes

{COPIED DIRECTLY from CHANGELOG.md version section — do not regenerate or rephrase. Copy the exact Added/Changed/Fixed sections.}
```

Also update the instructions text around the template to explicitly say: "The All Changes section MUST be copied verbatim from the CHANGELOG.md version section. Only the theme paragraph and Highlights are generated fresh."

**Acceptance Criteria:**
- [ ] Release notes template specifies copying from CHANGELOG.md
- [ ] Instructions explicitly say "do not regenerate"
- [ ] Theme and Highlights sections still generated fresh
- [ ] Install/Update section unchanged

---

### Task 11: Add Phase 5.5b blog post scaffolding to release command

Update `.claude/commands/system/release.md` to add a new Phase 5.5b after Phase 5.5 (Sync Changelog to Docs).

**File**: `.claude/commands/system/release.md`

Insert a new section between Phase 5.5 and Phase 5.6:

```markdown
### 5.5b: Scaffold Blog Post

Create `blog/dorkos-X-Y-Z.mdx` (with dots replaced by hyphens in the slug) with initial content:

1. Generate the frontmatter:
   ```yaml
   ---
   title: DorkOS X.Y.Z
   description: {Theme from CHANGELOG.md blockquote, or 1-sentence summary}
   date: {today's date YYYY-MM-DD}
   author: DorkOS Team
   category: release
   tags: [release, {2-3 relevant tags from changelog content}]
   ---
   ```

2. Include the highlights and all changes as initial content:
   ```markdown
   ## What's New

   {Theme paragraph}

   ## Highlights

   {2-3 emoji-decorated feature spotlights}

   ## All Changes

   {Copied from CHANGELOG.md version section}
   ```

3. Report to user: "Blog post scaffolded at `blog/dorkos-X-Y-Z.mdx`. You can edit it before the release commit."

The blog post file will be included in the release commit (Phase 5.6).
```

Also update Phase 5.6 to include the blog post in the git add:
```bash
git add VERSION CHANGELOG.md docs/changelog.mdx blog/ packages/cli/package.json package.json package-lock.json
```

**Acceptance Criteria:**
- [ ] Phase 5.5b documented in release command
- [ ] Blog post frontmatter includes all required fields
- [ ] Blog post content includes highlights and all changes
- [ ] Phase 5.6 git add includes `blog/` directory
- [ ] User is informed they can edit before commit

---

### Task 12: Add theme blockquote convention to changelog skill

Update `.claude/skills/writing-changelogs/SKILL.md` to document the optional theme blockquote convention for version headings in CHANGELOG.md.

**File**: `.claude/skills/writing-changelogs/SKILL.md`

Add a new section documenting:

```markdown
## Theme Blockquote (Optional)

Add a single-line blockquote below version headings to provide a theme/summary for the release:

\`\`\`markdown
## [0.3.0] - 2026-02-20

> DorkOS 0.3.0 adds a scheduler and dynamic MCP tools.

### Added
- ...
\`\`\`

This theme line feeds:
- Blog post descriptions
- GitHub Release "What's New" opening paragraph
- Quick reference for users scanning the changelog

The blockquote is optional and backward-compatible. Older versions without it work fine.
```

**Acceptance Criteria:**
- [ ] Theme blockquote convention documented in changelog skill
- [ ] Example shows correct format
- [ ] Explains where the theme is used (blog, GitHub Release)
- [ ] Notes it is optional and backward-compatible

---

## Phase 3: Backfill Command

### Task 13: Create changelog backfill command

Create `.claude/commands/changelog/backfill.md` that finds missing changelog entries from git history.

**File**: `.claude/commands/changelog/backfill.md`

```markdown
---
description: Find missing changelog entries from git commits since last tag
argument-hint: [tag] [--dry-run]
allowed-tools: Bash, Read, Write, Edit, Glob, AskUserQuestion
---

# Changelog Backfill

Find commits since the last tag (or a specified tag) that are not represented in the [Unreleased] section of CHANGELOG.md, and propose entries for them.

## Arguments

- `$ARGUMENTS` - Optional: specific tag to compare from, or `--dry-run`
  - _(no argument)_ - Compare from latest tag
  - `v0.2.0` - Compare from specified tag
  - `--dry-run` - Show proposed entries without applying

## Process

### Step 1: Determine Base Tag

```bash
# Use argument if provided, otherwise latest tag
TAG="${1:-$(git describe --tags --abbrev=0 2>/dev/null)}"
echo "Comparing from: $TAG"
```

If no tags exist, report and stop.

### Step 2: Get Commits Since Tag

```bash
git log $TAG..HEAD --oneline --no-merges
```

### Step 3: Filter and Categorize

Process each commit line:

**Include** (conventional commit types):
- `feat:` / `feat(scope):` -> **Added**
- `fix:` / `fix(scope):` -> **Fixed**
- `refactor:` / `refactor(scope):` -> **Changed**
- `perf:` / `perf(scope):` -> **Changed**

**Skip** (not user-facing):
- `chore:` / `ci:` / `test:` / `docs:` / `build:` / `style:`

### Step 4: Compare with Existing Entries

Read the [Unreleased] section of CHANGELOG.md. For each categorized commit, check if a similar entry already exists (fuzzy match on key terms). Only propose genuinely missing entries.

### Step 5: Present Proposals

Show proposed entries grouped by category:

```markdown
## Proposed Changelog Entries

**Tag**: [tag]
**Commits analyzed**: [count]
**Already covered**: [count]
**New entries proposed**: [count]

### Added
- [user-friendly description] ([sha])

### Changed
- [user-friendly description] ([sha])

### Fixed
- [user-friendly description] ([sha])
```

Rewrite each entry following the writing-changelogs skill:
- Focus on what users can DO
- Use imperative verbs
- Explain benefits, not mechanisms

### Step 6: User Approval

Use AskUserQuestion:

```
header: "Backfill Entries"
question: "Add these entries to [Unreleased]?"
options:
  - label: "Yes, add all"
    description: "Add all proposed entries to CHANGELOG.md"
  - label: "Review individually"
    description: "Approve each entry one by one"
  - label: "Skip"
    description: "Don't add any entries"
```

If "Yes, add all": Use Edit tool to add entries to appropriate sections in [Unreleased].
If "Review individually": Present each entry with accept/reject options.
If "Skip" or `--dry-run`: Report and exit.
```

**Acceptance Criteria:**
- [ ] Command file exists at `.claude/commands/changelog/backfill.md`
- [ ] Parses conventional commits from git log
- [ ] Filters out non-user-facing commits (chore, ci, test, docs)
- [ ] Compares against existing [Unreleased] entries
- [ ] Presents proposals grouped by category
- [ ] Supports `--dry-run` flag
- [ ] Supports specifying a tag via arguments
- [ ] User can approve all, review individually, or skip
