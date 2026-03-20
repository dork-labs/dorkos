---
slug: dorkos-website-publishing
number: 35
created: 2026-02-16
status: ideation
---

# DorkOS Website & Documentation Publishing

**Slug:** dorkos-website-publishing
**Author:** Claude Code
**Date:** 2026-02-16
**Branch:** preflight/dorkos-website-publishing
**Related:** [Documentation Infrastructure](../documentation-infrastructure/) (spec #31)

---

## 1) Intent & Assumptions

- **Task brief:** Set up the dorkos.ai marketing website and docs.dorkos.ai (or dorkos.ai/docs) documentation site, hosted on Vercel. Repurpose an existing Next.js codebase at `/Users/doriancollier/Keep/144/144x.co` as the starting point. Place in a new private GitHub repo under the `dork-labs` org.

- **Assumptions:**
  - The 144x.co codebase is a suitable starting point (confirmed: Next.js 16, React 19, Tailwind 4, shadcn/ui)
  - Fumadocs will be the documentation framework (per spec #31)
  - The `docs/` directory in the DorkOS repo is the canonical content source
  - Vercel is the hosting platform
  - The marketing site and docs site share the same domain (`dorkos.ai`)

- **Out of scope:**
  - Content authoring (what goes in `docs/`)
  - Blog system or CMS integration
  - Authentication/gated content
  - Analytics beyond basic Vercel Analytics
  - Custom domains for non-docs subdomains

## 2) Pre-reading Log

- `specs/documentation-infrastructure/02-specification.md`: Defines the `docs/` directory structure, MDX format, Fumadocs consumption model. Non-Goals explicitly list "Hosting, deployment, or CI/CD" and "Marketing website"
- `/Users/doriancollier/Keep/144/144x.co/package.json`: Next.js 16, React 19, Tailwind CSS 4, shadcn/ui, Motion, BetterAuth, Prisma, PostHog, pnpm
- `/Users/doriancollier/Keep/144/144x.co/next.config.ts`: Standard Next.js config with Turbopack
- `/Users/doriancollier/Keep/144/144x.co/src/layers/`: Full FSD architecture (shared, entities, features, widgets, app)
- `/Users/doriancollier/Keep/144/144x.co/src/layers/widgets/landing/`: Marketing components (Hero, ProjectsGrid, TechStackGrid, TestimonialsCarousel, etc.)
- `/Users/doriancollier/Keep/144/144x.co/src/components/ui/`: 55+ shadcn/ui components
- `research/20260216_fumadocs_vercel_docs_site.md`: Comprehensive research on Fumadocs integration, monorepo patterns, Vercel deployment, private repo considerations

## 3) Codebase Map

### 144x.co Source (to be repurposed)

**Primary Components/Modules:**

- `src/layers/widgets/landing/ui/Hero.tsx` - Landing page hero section
- `src/layers/widgets/landing/ui/ProjectsGrid.tsx` - Project showcase grid
- `src/layers/widgets/landing/ui/TechStackGrid.tsx` - Technology stack display
- `src/layers/widgets/landing/ui/TestimonialsCarousel.tsx` - Testimonials section
- `src/layers/widgets/landing/ui/FooterSection.tsx` - Site footer
- `src/layers/widgets/header/ui/Header.tsx` - Site header/navigation
- `src/layers/features/contact/` - Contact form feature
- `src/layers/features/theme/` - Theme toggle (dark/light mode)
- `src/layers/shared/ui/` - Base UI primitives (shadcn/ui)
- `src/layers/shared/lib/` - Utilities (cn, fonts, etc.)

**Shared Dependencies:**

- `tailwind.config.ts` - Tailwind CSS 4 configuration
- `src/layers/shared/lib/fonts.ts` - Font configuration (Geist Sans + Mono)
- `src/components/ui/` - 55+ shadcn components (legacy location, coexists with FSD)

**Data Flow:**

Static marketing content → React Server Components → HTML

**Feature Flags/Config:**

- BetterAuth (authentication) - can be removed for public marketing site
- Prisma (database) - can be removed
- PostHog (analytics) - can be replaced with Vercel Analytics

**Potential Blast Radius:**

- Direct: New `apps/web` directory (or separate repo)
- Indirect: `docs/` content directory (consumed by Fumadocs at build time)
- Build: `turbo.json` pipeline additions (if monorepo approach)
- CI/CD: New Vercel project configuration
- DNS: `dorkos.ai` domain configuration

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

## 5) Research

### Potential Solutions

**1. Add `apps/web` to existing DorkOS monorepo**

- Description: Add the marketing/docs Next.js app as a new workspace in the existing Turborepo monorepo. Content from `docs/` is referenced directly via relative path (`../../docs/`).
- Pros:
  - Shared packages (design tokens, types, shared UI)
  - Single repo to manage, one CI pipeline
  - `docs/` content is already in the same repo — no submodule complexity
  - Automatic rebuild when shared packages change
  - Turborepo remote caching on Vercel
- Cons:
  - Larger monorepo
  - Vercel org private repo requires Pro plan ($20/user/month) or GitHub Actions workaround
  - Website deployment couples with product changes (mitigated by `turbo-ignore`)
- Complexity: Low
- Maintenance: Low

**2. Separate private repo (`dork-labs/dorkos-web`)**

- Description: Create a standalone Next.js repo for the website. Pull `docs/` content via git submodule pointing to the DorkOS repo.
- Pros:
  - Independent deployment lifecycle
  - Can use personal GitHub account to avoid Vercel Pro requirement
  - Simpler, focused repo
- Cons:
  - No shared packages without npm publishing
  - Git submodule complexity (especially for private repos on Vercel — needs PAT workaround)
  - Two repos to manage
  - Content sync requires manual `git submodule update` or CI triggers
- Complexity: Medium
- Maintenance: Medium

**3. Separate Turborepo for website only**

- Description: New Turborepo with `apps/web` (marketing) and potentially `apps/docs` (separate Fumadocs app). Inspired by next-forge pattern.
- Pros:
  - Maximum deployment independence
  - Could split marketing and docs into separate Vercel projects
- Cons:
  - Two Turborepos to maintain
  - Overkill for a single website
  - Still needs content sync from DorkOS repo
- Complexity: High
- Maintenance: High

### Security Considerations

- Private repo on Vercel: Ensure no secrets leak via build logs
- If using git submodules with private repos: PAT token must be fine-grained and read-only
- OpenAPI spec should not expose internal-only endpoints

### Performance Considerations

- Fumadocs with 50-100 MDX pages: under 60s first build, under 10s cached
- `turbo-ignore` prevents unnecessary rebuilds in monorepo
- Route groups add zero runtime overhead (Next.js convention only)

### Recommendation

**Recommended Approach:** Option 1 — Monorepo (`apps/web`)

**Rationale:**
Adding `apps/web` to the existing DorkOS Turborepo eliminates content sync complexity entirely — `docs/` is referenced directly via `../../docs/`. Shared packages (design tokens, types, UI) work automatically. The repo is going public, so Vercel Hobby (free) works without workarounds.

## 6) Clarification — Resolved

All clarification questions were answered during ideation review:

| #   | Question                  | Decision                                                                                        |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | Monorepo vs separate repo | **Monorepo** — `apps/web` in existing DorkOS Turborepo                                          |
| 2   | Domain structure          | **`dorkos.ai/docs`** — path-based via Next.js route groups                                      |
| 3   | Vercel plan               | **Hobby (free)** — repo going public removes org restriction                                    |
| 4   | Feature scope             | **Remove** BetterAuth + Prisma. **Keep** PostHog, contact form, Motion, shadcn, existing styles |
| 5   | Content integration       | **Direct path** — `../../docs/` from `apps/web/source.config.ts` (monorepo, no sync needed)     |
| 6   | API docs                  | **Include from day one** via `fumadocs-openapi`                                                 |
| 7   | Going public              | **Now** — audit repo for secrets before making public                                           |

### Additional Notes from Discussion

- **Changelog separation**: `apps/web/` will NOT be added to `changelog-populator.py`'s `SYSTEM_PATHS`. Website changes don't generate product changelog entries.
- **Future closed-source services**: Would go in separate private repos (e.g., `dork-labs/dorkos-cloud`), consuming published packages from the public monorepo.
- **Existing styles**: The 144x.co visual design and CSS will be preserved during the repurposing — the site should maintain its current aesthetic while being customized for DorkOS branding.
