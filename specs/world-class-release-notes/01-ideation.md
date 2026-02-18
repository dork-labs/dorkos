---
slug: world-class-release-notes
number: 44
created: 2026-02-18
status: ideation
---

# World-Class Release Notes & Blog Infrastructure

**Slug:** world-class-release-notes
**Author:** Claude Code
**Date:** 2026-02-18
**Related:** Spec #33 (Versioning, Release & Update System), Spec #37 (World-Class Documentation)

---

## 1) Intent & Assumptions

- **Task brief:** Improve changelogs, release notes, and release processes end-to-end. Add a blog to the marketing site that serves as the foundation for release announcement pages and general articles. Add an RSS feed. Create the missing `/changelog:backfill` command. Fix content drift between the three changelog surfaces (CHANGELOG.md, docs/changelog.mdx, GitHub Releases).

- **Assumptions:**
  - The existing Fumadocs `defineCollections` API (already in fumadocs-mdx v14.2.7) supports blog collections natively
  - Blog posts live at the monorepo root (`blog/`) alongside `docs/`, following the same pattern
  - The blog renders in the `(marketing)` route group, not the `(docs)` route group
  - `CHANGELOG.md` remains the single source of truth for structured change data
  - GitHub Releases continue to get narrative content (highlights, theme), but "All Changes" is always copied from CHANGELOG.md to prevent drift
  - RSS feed is nice-to-have, not mandatory
  - The backfill command uses a shell script (not Python, unlike the life-os-starter example) since DorkOS has no Python dependency

- **Out of scope:**
  - Blog comments or discussion threads
  - Blog search integration (Fumadocs search covers docs only)
  - Pagination (premature at < 20 posts)
  - Per-major-version changelog splitting (premature at 2 releases)
  - Automated changelog entries via git hooks (too much friction for now)
  - CMS or admin UI for blog posts

## 2) Pre-reading Log

- `CHANGELOG.md`: Standard Keep a Changelog format, 2 releases (v0.1.0, v0.2.0), 70 lines
- `docs/changelog.mdx`: Synced copy of released sections, MDX frontmatter, no highlights
- `.claude/commands/system/release.md`: 708-line orchestrator, Phase 5.5 syncs changelog to docs, Phase 5.9 generates narrative GitHub release (highlights generated fresh, not from changelog)
- `.claude/skills/writing-changelogs/SKILL.md`: Writing standards, emoji reference, "You Can Now" test
- `apps/web/source.config.ts`: `defineDocs({ dir: '../../docs' })` — single collection
- `apps/web/src/lib/source.ts`: `loader({ baseUrl: '/docs', source: docs.toFumadocsSource() })`
- `apps/web/next.config.ts`: `createMDX()` from fumadocs-mdx/next wraps Next config
- `apps/web/src/app/(marketing)/layout.tsx`: Marketing layout with JSON-LD
- `apps/web/src/app/(docs)/layout.tsx`: Fumadocs DocsLayout with sidebar, imports fumadocs-ui/style.css
- GitHub Release v0.2.0: Has "Key Features" highlights + "Complete Changes" section, includes a bug fix NOT in CHANGELOG.md (content drift)
- `/Users/doriancollier/Keep/life-os-starter/.claude/commands/changelog/backfill.md`: Example backfill command using Python script, presents missing entries for approval

## 3) Codebase Map

**Primary files to modify:**

- `apps/web/source.config.ts` — add blogPosts collection
- `apps/web/src/lib/source.ts` — add blog loader
- `.claude/commands/system/release.md` — fix content drift in Phase 5.9, add blog post scaffolding step
- `CHANGELOG.md` — add optional highlights section to format

**New files to create:**

- `blog/` directory at monorepo root (MDX content)
- `apps/web/src/app/(marketing)/blog/page.tsx` — blog index
- `apps/web/src/app/(marketing)/blog/[slug]/page.tsx` — individual post
- `apps/web/src/app/blog/feed.xml/route.ts` — RSS feed (note: outside route group for clean URL)
- `.claude/commands/changelog/backfill.md` — missing backfill command

**Dependencies:**

- `fumadocs-mdx` v14.2.7 (already installed) — `defineCollections` API
- `fumadocs-core` v16.6.2 (already installed) — `loader()`, `toFumadocsSource()`
- `fumadocs-ui` v16.6.2 (already installed) — `InlineTOC`, MDX components
- No new packages needed

**Data flow:**

```
blog/*.mdx → source.config.ts (defineCollections) → @/.source virtual module
  → lib/source.ts (blog loader) → (marketing)/blog/ route pages

CHANGELOG.md → /system:release → docs/changelog.mdx (sync)
                               → blog/dorkos-X-Y-Z.mdx (scaffold)
                               → gh release create (narrative)
```

**Potential blast radius:**

- Direct: 5 new files, 3 modified files
- Indirect: Release command behavior changes, blog link in marketing nav
- Tests: No server/client tests affected (web app has no tests currently)

## 4) Root Cause Analysis

N/A — this is a feature, not a bug fix.

## 5) Research

Full research documented in `research/fumadocs-blog-research.md`.

### Potential Solutions

**1. Fumadocs `defineCollections` blog (Recommended)**

- Description: Add a second MDX collection alongside docs, render in marketing layout
- Pros: Zero new dependencies, same MDX pipeline, native Fumadocs patterns, Zod-validated frontmatter
- Cons: No built-in pagination, no built-in search for blog posts
- Complexity: Low
- Maintenance: Low — just MDX files

**2. Separate Next.js MDX blog (manual pipeline)**

- Description: Custom `getAllPosts()` utility with `@next/mdx`, like Next.js does
- Pros: Full control over rendering, no Fumadocs dependency for blog
- Cons: Duplicates existing MDX infrastructure, more boilerplate, manual frontmatter parsing
- Complexity: Medium
- Maintenance: Medium

**3. External blog platform (Ghost, Hashnode, etc.)**

- Description: Host blog externally, link from marketing site
- Pros: Rich editor, built-in SEO, analytics, email newsletters
- Cons: External dependency, cost, split domain authority, data lock-in
- Complexity: Low (setup) / High (integration)
- Maintenance: Low

**Recommendation:** Option 1 (Fumadocs `defineCollections`). It reuses 100% of existing infrastructure, adds no packages, and matches how Fumadocs.dev itself handles their blog.

### Release Notes Improvement Strategy

**Three surfaces, three purposes:**

| Surface | Purpose | Content |
|---|---|---|
| `CHANGELOG.md` | Developer reference | Structured bullets (Added/Changed/Fixed) |
| `blog/dorkos-X-Y-Z.mdx` | Public storytelling | Narrative with context, screenshots, migration guides |
| GitHub Release | Distribution channel | Theme + highlights + all changes (copied from CHANGELOG.md) |

**Key fixes:**

1. **Prevent content drift**: GitHub Release "All Changes" section must be copied from CHANGELOG.md, not regenerated. Only highlights and theme are generated fresh.
2. **Add highlights to CHANGELOG.md**: Optional `> Theme sentence` blockquote below version heading. This feeds both the blog post and GitHub release.
3. **Scaffold blog post during release**: Add a Phase 5.5b to the release command that creates `blog/dorkos-X-Y-Z.mdx` from the changelog + highlights.

### Changelog Backfill Command

Adapted from the life-os-starter example but simplified for DorkOS:

- No Python dependency — use a shell script or inline Bash in the command
- Parse `git log` since last tag with conventional commit format
- Present proposed entries for user approval
- Apply approved entries to CHANGELOG.md `[Unreleased]` section

### RSS Feed

Single route handler at `apps/web/src/app/blog/feed.xml/route.ts`:
- Generates RSS 2.0 XML from `blog.getPages()`
- Sorted by date descending
- Includes title, link, pubDate, description per item
- Static generation at build time

## 6) Clarification

1. **Blog URL pattern**: Should release posts be at `/blog/dorkos-0-2-0` (version in slug) or `/blog/v0.2.0` (simpler)? Recommendation: `/blog/dorkos-0-2-0` for SEO and readability.

2. **Marketing nav**: Should "Blog" appear in the marketing nav alongside "docs"? Or keep it discoverable via footer/docs only?

3. **First blog post**: Should we retroactively create blog posts for v0.1.0 and v0.2.0, or start fresh from the next release?

4. **Changelog format enrichment**: The proposal adds an optional theme blockquote to CHANGELOG.md. Is this acceptable, or should CHANGELOG.md remain strictly Keep a Changelog format?

5. **Backfill command scope**: Should the backfill command also detect whether entries need quality improvement (apply "You Can Now" test), or just find missing entries?
