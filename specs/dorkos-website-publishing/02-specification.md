---
slug: dorkos-website-publishing
number: 35
created: 2026-02-16
status: draft
---

# DorkOS Website & Documentation Publishing

## Status

Draft

## Authors

Claude (spec:create) — 2026-02-16

## Overview

Add a marketing website and documentation site to the DorkOS monorepo as `apps/web`. Repurpose the existing Next.js 16 codebase at `/Users/doriancollier/Keep/144/144x.co`, stripping authentication and database layers while keeping analytics, contact form, animations, and the existing visual design. The site combines marketing pages (route group `(marketing)`) with Fumadocs-powered documentation (route group `(docs)`) under a single Next.js app deployed to `dorkos.ai`.

## Background / Problem Statement

DorkOS is an open-source product preparing for public release. The `docs/` directory (spec #31) contains MDX content structured for Fumadocs, but there is no website to serve it. The project needs:

1. **A marketing website** — Landing page, feature showcase, and contact form at `dorkos.ai`
2. **Public documentation** — User guides, API reference, and contributor onboarding at `dorkos.ai/docs`
3. **Interactive API docs** — Auto-generated from the existing OpenAPI spec

An existing Next.js 16 codebase (`144x.co`) provides a strong foundation: Calm Tech design system, marketing components (Hero, Projects grid, Philosophy cards, Contact section), PostHog analytics, dark mode, SEO metadata, and FSD architecture. Repurposing it saves significant design and development effort.

## Goals

- Add `apps/web` as a new Turborepo workspace (`@dorkos/web`)
- Repurpose 144x.co marketing components, rebranded for DorkOS
- Integrate Fumadocs to render `docs/` MDX content at `/docs`
- Wire `fumadocs-openapi` to render interactive API reference from `docs/api/openapi.json`
- Preserve PostHog analytics, contact form, Motion animations, and dark mode
- Configure for Vercel deployment (Hobby plan, public repo)
- Ensure `npm run dev` / `npm run build` work across the full monorepo

## Non-Goals

- Writing new marketing copy or docs content (content exists or will be written separately)
- Blog system or CMS integration
- Authentication or gated content on the marketing site
- Versioned documentation (latest-only for now)
- Custom analytics dashboards (PostHog handles this)
- Email newsletter or signup forms (beyond existing contact section)
- Search integration (Fumadocs built-in search is sufficient for launch)

## Technical Dependencies

| Dependency | Version | Purpose | Notes |
|---|---|---|---|
| Next.js | 16.x | App framework | Already in 144x.co source |
| React | 19.x | UI library | Already in 144x.co source |
| Tailwind CSS | 4.x | Styling | Already in 144x.co source |
| Fumadocs | latest | Docs framework | New dependency for `apps/web` |
| fumadocs-mdx | latest | MDX content pipeline | Processes `docs/` at build time |
| fumadocs-openapi | latest | OpenAPI docs rendering | Reads `openapi.json` |
| fumadocs-ui | latest | Docs UI components | DocsLayout, search, sidebar |
| posthog-js | 1.336.x | Client analytics | Already in 144x.co source |
| next-themes | 0.4.x | Dark mode | Already in 144x.co source |
| motion | 12.x | Animations | Already in 144x.co source |
| shiki | latest | Code highlighting | Required by fumadocs-openapi |

**Removed dependencies** (stripped from 144x.co):
- `better-auth`, `@prisma/adapter-better-sqlite3` — Authentication
- `prisma`, `@prisma/client`, `better-sqlite3` — Database
- `@modelcontextprotocol/sdk`, `mcp-handler` — MCP server
- `@t3-oss/env-nextjs` — Env validation (simplified; only PostHog vars needed)
- `react-hook-form`, `@hookform/resolvers` — Form library (contact section uses simple state)
- `recharts` — Charts
- `nuqs` — URL state management

## Detailed Design

### 1. Monorepo Integration

Add `apps/web` as a Turborepo workspace:

**`apps/web/package.json`:**
```json
{
  "name": "@dorkos/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev --turbopack",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "generate:api-docs": "tsx scripts/generate-api-docs.ts"
  }
}
```

**`turbo.json` updates:**
- Add `.next/**` to the `build` task `outputs` array
- Add `NEXT_PUBLIC_*`, `POSTHOG_*` to `build` env list

**Package manager migration:** The 144x.co source uses pnpm. During copy, the `pnpm-lock.yaml` is discarded and dependencies are installed via npm (the monorepo's package manager). The `pnpm-workspace.yaml` and any pnpm-specific config files are not copied.

### 2. Directory Structure

```
apps/web/
├── app/
│   ├── (marketing)/                # Marketing route group
│   │   ├── layout.tsx              # Marketing layout (cream bg, JSON-LD)
│   │   └── page.tsx                # Landing page
│   ├── (docs)/                     # Docs route group
│   │   ├── layout.tsx              # Fumadocs RootProvider + DocsLayout
│   │   └── docs/
│   │       └── [[...slug]]/
│   │           └── page.tsx        # Fumadocs catch-all page
│   ├── (public)/                   # Public pages (privacy, terms, cookies)
│   │   ├── layout.tsx
│   │   ├── privacy/page.tsx
│   │   ├── terms/page.tsx
│   │   └── cookies/page.tsx
│   ├── layout.tsx                  # Root layout (fonts, providers, PostHog)
│   ├── globals.css                 # Calm Tech design system (preserved from 144x.co)
│   ├── providers.tsx               # ThemeProvider, PostHog (no QueryClient needed)
│   ├── not-found.tsx               # 404 page
│   ├── robots.ts                   # SEO
│   ├── sitemap.ts                  # Dynamic sitemap (includes /docs pages)
│   └── opengraph-image.tsx         # OG image generation
├── components/
│   ├── api-page.tsx                # Fumadocs APIPage wrapper
│   └── mdx-components.tsx          # MDX component overrides
├── lib/
│   ├── source.ts                   # Fumadocs source loader
│   ├── openapi.ts                  # createOpenAPI instance
│   └── posthog.ts                  # PostHog client/server setup
├── layers/                         # FSD layers (preserved from 144x.co)
│   ├── shared/
│   │   ├── lib/                    # cn(), fonts
│   │   └── ui/                     # Public footer, base components
│   └── features/
│       └── marketing/              # Marketing page components
│           ├── ui/                 # Hero, ProjectsGrid, ContactSection, etc.
│           └── lib/                # Project data, philosophy items
├── instrumentation-client.ts       # PostHog client init
├── source.config.ts                # Fumadocs MDX configuration
├── next.config.ts                  # Next.js config (PostHog proxy)
├── tsconfig.json
├── postcss.config.mjs
└── scripts/
    └── generate-api-docs.ts        # Pre-build: generate OpenAPI MDX pages
```

### 3. Fumadocs Integration

**`source.config.ts`:**
```typescript
import { defineDocs, defineConfig } from 'fumadocs-mdx/config';

export const docs = defineDocs({
  dir: '../../docs',  // Points to repo root docs/ directory
});

export default defineConfig();
```

**`lib/source.ts`:**
```typescript
import { docs } from 'fumadocs-mdx:collections/server';
import { loader } from 'fumadocs-core/source';

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
});
```

**`app/(docs)/layout.tsx`:**
```typescript
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider';
import { source } from '@/lib/source';
import type { ReactNode } from 'react';

export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <RootProvider>
      <DocsLayout tree={source.getPageTree()}>
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
```

**`app/(docs)/docs/[[...slug]]/page.tsx`:**
```typescript
import { source } from '@/lib/source';
import { DocsPage, DocsBody } from 'fumadocs-ui/page';
import { notFound } from 'next/navigation';
import { APIPage } from '@/components/api-page';

export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  // OpenAPI pages render with APIPage component
  if (page.data.type === 'openapi') {
    return (
      <DocsPage full>
        <DocsBody>
          <APIPage {...page.data.getAPIPageProps()} />
        </DocsBody>
      </DocsPage>
    );
  }

  const MDXContent = page.data.body;
  return (
    <DocsPage>
      <DocsBody>
        <MDXContent />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({ slug: page.slugs }));
}
```

### 4. OpenAPI Documentation

**`lib/openapi.ts`:**
```typescript
import { createOpenAPI } from 'fumadocs-openapi/server';

export const openapi = createOpenAPI({
  input: ['../../docs/api/openapi.json'],
});
```

**`scripts/generate-api-docs.ts`:**
```typescript
import { generateFiles } from 'fumadocs-openapi';
import { openapi } from '../lib/openapi';

void generateFiles({
  input: openapi,
  output: '../../docs/api',
  includeDescription: true,
});
```

This script runs as a pre-build step (`generate:api-docs` in package.json). The generated MDX files slot into the `docs/api/` directory and are picked up by Fumadocs.

**Build pipeline integration** in `turbo.json`:
```json
{
  "build": {
    "dependsOn": ["generate:api-docs", "^build"]
  }
}
```

### 5. PostHog Analytics (Preserved)

The PostHog integration from 144x.co is preserved with minimal changes:

- **Client init:** `instrumentation-client.ts` initializes PostHog with `/ingest` reverse proxy
- **Reverse proxy:** `next.config.ts` rewrites `/ingest/*` to PostHog servers
- **Server-side:** `lib/posthog.ts` provides `getPostHogClient()` for server components
- **Env vars:** `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST`

Auth-related PostHog events (`sign_in_started`, `otp_verified`, `signed_out`, `user_created`) are removed along with the auth feature. Marketing events (`contact_email_revealed`, `cookie_consent_*`) are preserved.

### 6. Contact Section (Preserved)

The terminal-style "reveal email" contact section is preserved as-is from 144x.co. It's a client component with simple `useState` — no form library or backend needed. The email address will be updated to the DorkOS contact email.

### 7. Theme System (Preserved)

Dark/light mode via `next-themes`:
- Root layout: `<html suppressHydrationWarning>`
- Providers: `ThemeProvider` with `attribute="class"`, `defaultTheme="system"`
- CSS: Full light/dark variable sets in `globals.css` (oklch color space)
- Toggle: Simplified standalone component (not tied to sidebar)

### 8. Stripping Unwanted Features

The following are removed during the copy-and-adapt process:

| Feature | Files Removed | Reason |
|---|---|---|
| BetterAuth | `src/layers/features/auth/`, `api/auth/`, `src/layers/shared/api/auth.ts` | No auth on marketing site |
| Prisma/DB | `prisma/`, `src/layers/shared/api/errors.ts` (if DB-specific) | No database needed |
| User entity | `src/layers/entities/user/` | Tied to auth |
| MCP server | `src/layers/features/mcp-database-server/`, `api/mcp/` | Internal tool |
| Dashboard | `src/app/(authenticated)/` | Requires auth |
| Auth pages | `src/app/(auth)/` | No auth |
| Design system page | `src/app/system/` | Internal dev tool |
| App sidebar | `src/layers/widgets/app-sidebar/` | App-level nav, not marketing |
| API routes | `src/app/api/` (all) | No backend API needed |
| TanStack Query | `src/layers/shared/lib/query-client.ts` | No data fetching |
| Env validation | `src/env.ts` | Simplified to just PostHog vars |
| PWA manifest | `src/app/manifest.ts` | Marketing site isn't a PWA |

### 9. Site Configuration

All site-wide strings and settings live in a central config file to avoid hardcoding across components:

**`lib/site-config.ts`:**
```typescript
export const siteConfig = {
  name: 'DorkOS',
  description: 'A web UI for Claude Code',
  url: 'https://dorkos.ai',
  contactEmail: 'hey@dorkos.ai',
  github: 'https://github.com/dork-labs/dorkos',
  npm: 'https://www.npmjs.com/package/dorkos',
  ogImage: '/og-image.png',
} as const;
```

Components reference `siteConfig.contactEmail` instead of hardcoded strings.

### 10. Branding Updates

| Element | 144x.co (Current) | DorkOS (Target) |
|---|---|---|
| Site title | "Dorkian" | "DorkOS" |
| Description | "Independent studio..." | "A web UI for Claude Code" |
| Domain | dorkian.com | dorkos.ai |
| Contact email | hey@dorkian.com | (TBD — user decides) |
| Projects data | 6 portfolio projects | DorkOS features/highlights |
| Philosophy items | 3 studio values | DorkOS design principles |
| JSON-LD schema | Organization (Dorkian) | SoftwareApplication (DorkOS) |
| OG images | Dorkian branding | DorkOS branding |
| Fonts | IBM Plex Sans/Mono | IBM Plex Sans/Mono (keep) |
| Color palette | Cream/charcoal/orange | Cream/charcoal/orange (keep) |

### 11. Vercel Deployment

**Vercel project configuration:**
- **Project name:** `dorkos-web`
- **Root Directory:** `apps/web`
- **Build Command:** `turbo build` (auto-scoped by Vercel)
- **Ignored Build Step:** `npx turbo-ignore` (skips if no relevant changes)
- **Framework:** Next.js (auto-detected)
- **Node.js version:** 20.x

**Domain configuration:**
- Primary: `dorkos.ai` → Vercel project
- Docs: `dorkos.ai/docs` (route group, same deployment)

**Environment variables (Vercel dashboard):**
- `NEXT_PUBLIC_POSTHOG_KEY` — PostHog project API key
- `NEXT_PUBLIC_POSTHOG_HOST` — `https://us.i.posthog.com`

**`turbo-ignore` behavior:** Only rebuilds when files in `apps/web/`, `docs/`, or shared packages change. Changes to `apps/client/`, `apps/server/`, or `packages/cli/` do not trigger a website rebuild.

### 12. Sitemap Integration

The existing `sitemap.ts` from 144x.co generates a dynamic XML sitemap. It will be extended to include Fumadocs pages:

```typescript
import { source } from '@/lib/source';

export default async function sitemap() {
  const docsPages = source.getPages().map((page) => ({
    url: `https://dorkos.ai/docs/${page.slugs.join('/')}`,
    lastModified: new Date(),
  }));

  return [
    { url: 'https://dorkos.ai', lastModified: new Date() },
    { url: 'https://dorkos.ai/privacy', lastModified: new Date() },
    { url: 'https://dorkos.ai/terms', lastModified: new Date() },
    { url: 'https://dorkos.ai/cookies', lastModified: new Date() },
    ...docsPages,
  ];
}
```

## User Experience

### Marketing Site (`dorkos.ai`)

Users land on a visually striking page with the Calm Tech aesthetic:
1. **Hero section** — DorkOS tagline with terminal-style blinking cursor
2. **Features/Projects grid** — Showcase of DorkOS capabilities
3. **Philosophy section** — Design principles (open-source, developer-first, etc.)
4. **Contact section** — Terminal-style email reveal
5. **Footer** — Links to GitHub, npm, docs

Navigation: Sticky header with links to Features, Docs, GitHub.

### Documentation (`dorkos.ai/docs`)

Users navigate docs via Fumadocs' built-in sidebar:
1. **Getting Started** — Installation, quickstart, configuration
2. **Guides** — CLI usage, tunnel setup, slash commands, keyboard shortcuts
3. **API Reference** — Interactive endpoint docs (from OpenAPI spec)
4. **Integrations** — Building integrations, SSE protocol
5. **Self-Hosting** — Deployment, reverse proxy
6. **Contributing** — Development setup, testing, architecture

Fumadocs provides: full-text search, breadcrumbs, table of contents, prev/next navigation, mobile-responsive sidebar.

## Testing Strategy

### What to Test

Since this is primarily a static marketing site with minimal logic, testing focuses on:

1. **Build verification** — Does `npm run build` succeed with no errors?
2. **Fumadocs content loading** — Does `source.getPages()` return all docs pages?
3. **OpenAPI generation** — Does `generate-api-docs.ts` produce valid MDX?
4. **Sitemap generation** — Does the sitemap include all marketing and docs pages?
5. **PostHog init** — Does the client initialize without errors?

### Unit Tests

```typescript
// lib/__tests__/source.test.ts
// Verifies Fumadocs source loader finds docs content
describe('Fumadocs source', () => {
  it('loads pages from docs/ directory', () => {
    const pages = source.getPages();
    expect(pages.length).toBeGreaterThan(0);
  });

  it('generates page tree with expected sections', () => {
    const tree = source.getPageTree();
    expect(tree.children.length).toBeGreaterThan(0);
  });
});
```

### Build-Time Verification

The primary "test" is a successful build. The build pipeline validates:
- All MDX files parse without errors
- All imports resolve
- TypeScript types check
- Fumadocs generates correct static params

### Mocking Strategy

- PostHog: Mock `posthog-js` in tests to avoid network calls
- Fumadocs: Test against actual `docs/` content (integration test)
- No API mocking needed (no backend)

## Performance Considerations

- **Static generation:** All marketing pages and docs are statically generated at build time (SSG). Zero server-side rendering at request time.
- **Image optimization:** Next.js `<Image>` component for all images with automatic optimization.
- **Font loading:** `next/font` with `display: 'swap'` prevents FOIT.
- **Code splitting:** Route groups create natural code split boundaries — marketing JS doesn't load on docs pages and vice versa.
- **Fumadocs build:** 17 MDX files currently; Fumadocs handles 500+ files without issues. Build time impact is negligible.
- **turbo-ignore:** Prevents unnecessary rebuilds on Vercel when only non-web code changes.

## Security Considerations

- **No secrets in client bundle:** Only `NEXT_PUBLIC_*` vars are exposed. PostHog key is designed to be public.
- **PostHog reverse proxy:** Routes analytics through first-party domain, which is standard practice but means the server processes analytics requests.
- **Contact email:** Revealed client-side (not hidden from bots). If spam becomes an issue, replace with Formspree or similar service.
- **Pre-public audit:** Before making the DorkOS repo public, audit git history for accidentally committed secrets (API keys, tokens, etc.). Use `git log --all -p | grep -i "secret\|password\|token\|key"` or BFG Repo Cleaner if needed.
- **No user input processing:** Marketing site accepts no user data beyond PostHog analytics events.

## Documentation

### New Documentation

- Update root `README.md` to mention `apps/web` and the marketing site
- Add `apps/web/README.md` with local development instructions
- Update `CLAUDE.md` monorepo structure diagram to include `apps/web`

### Updated Documentation

- `contributing/project-structure.md` — Add `apps/web` to the monorepo map
- `specs/manifest.json` — Already updated with spec #35

## Implementation Phases

### Phase 1: Scaffold & Strip

Copy 144x.co source into `apps/web/`. Strip BetterAuth, Prisma, MCP, dashboard, auth pages, API routes, TanStack Query, and env validation. Convert from pnpm to npm. Verify `npm run dev` and `npm run build` work for the isolated marketing site within the monorepo.

**Files created/modified:**
- `apps/web/` — Full directory (copied and stripped from 144x.co)
- `apps/web/package.json` — Workspace package, stripped dependencies
- `turbo.json` — Add `.next/**` outputs, web-specific env vars
- Root `package.json` — No changes needed (workspaces glob `apps/*` auto-includes)

**Verification:** `npm run build` succeeds, marketing pages render at `localhost:3000`.

### Phase 2: Fumadocs Integration

Install Fumadocs packages. Create `source.config.ts` pointing at `../../docs/`. Set up route group `(docs)` with DocsLayout and catch-all page. Verify docs render at `/docs`.

**Files created:**
- `apps/web/source.config.ts`
- `apps/web/lib/source.ts`
- `apps/web/app/(docs)/layout.tsx`
- `apps/web/app/(docs)/docs/[[...slug]]/page.tsx`
- `apps/web/components/mdx-components.tsx`

**Verification:** `localhost:3000/docs` renders the Getting Started page. Sidebar shows all doc sections.

### Phase 3: OpenAPI Docs

Install `fumadocs-openapi`. Create the `createOpenAPI` instance and `generateFiles` script. Wire into build pipeline. Verify API reference pages render.

**Files created:**
- `apps/web/lib/openapi.ts`
- `apps/web/scripts/generate-api-docs.ts`
- `apps/web/components/api-page.tsx`

**Verification:** `localhost:3000/docs/api/...` renders interactive API endpoint documentation.

### Phase 4: Branding & Content

Update all 144x.co branding to DorkOS: site title, description, metadata, JSON-LD, OG images, project data, philosophy items, contact email. Update sitemap to include docs pages.

**Files modified:**
- `apps/web/app/layout.tsx` — Metadata, title
- `apps/web/app/(marketing)/layout.tsx` — JSON-LD schema
- `apps/web/layers/features/marketing/lib/projects.ts` — DorkOS features
- `apps/web/layers/features/marketing/lib/philosophy.ts` — DorkOS principles
- `apps/web/app/sitemap.ts` — Include docs pages
- `apps/web/app/opengraph-image.tsx` — DorkOS branding

### Phase 5: Vercel Deployment (CLI-Driven)

Set up the Vercel project, environment variables, domain, and deploy — all via the Vercel CLI. The only manual step is DNS configuration (user must update their domain registrar).

**Prerequisites:**
- Vercel CLI installed: `npm i -g vercel`
- Authenticated: `vercel login`
- DorkOS repo made public on GitHub (removes org private repo restriction)

**Step 5.1: Install Vercel CLI (if needed)**
```bash
npm i -g vercel
vercel login
```

**Step 5.2: Link project to Vercel**
```bash
cd apps/web
vercel link
```
During `vercel link`, select:
- Scope: `dork-labs` (or personal account)
- Link to existing project? → No, create new
- Project name: `dorkos-web`
- Root directory: `./` (already in `apps/web`)
- Build command: `cd ../.. && npx turbo build --filter=@dorkos/web`
- Output directory: `.next`
- Development command: `next dev --turbopack`

This creates `.vercel/project.json` in `apps/web/`.

**Step 5.3: Configure environment variables**
```bash
# PostHog analytics
vercel env add NEXT_PUBLIC_POSTHOG_KEY production preview development
vercel env add NEXT_PUBLIC_POSTHOG_HOST production preview development
```

**Step 5.4: Configure `vercel.json` for monorepo**

Create `apps/web/vercel.json`:
```json
{
  "ignoreCommand": "npx turbo-ignore"
}
```

This tells Vercel to skip rebuilds when only non-web code changes (e.g., changes to `apps/server/` or `packages/cli/`).

**Step 5.5: Deploy preview build**
```bash
cd apps/web
vercel deploy
```
Verify the preview URL works — marketing pages render, docs render, API docs render.

**Step 5.6: Configure custom domain**
```bash
vercel domains add dorkos.ai
```
The CLI outputs DNS records to configure. User must update DNS at their domain registrar:
- **Option A (recommended):** Set Vercel as nameservers (full DNS delegation)
- **Option B:** Add A record (`76.76.21.21`) and CNAME (`cname.vercel-dns.com`)

```bash
# Verify DNS propagation
vercel domains inspect dorkos.ai

# Optionally add www redirect
vercel domains add www.dorkos.ai
```

**Step 5.7: Production deploy**
```bash
vercel deploy --prod
```

**Step 5.8: Verify production**
```bash
# Check deployment status
vercel inspect $(vercel ls --json | head -1)

# Verify live URLs
curl -sI https://dorkos.ai | head -5
curl -sI https://dorkos.ai/docs | head -5
```

**Files created:**
- `apps/web/.vercel/project.json` — Generated by `vercel link` (gitignored)
- `apps/web/vercel.json` — Monorepo ignore command config

**Manual action required (user):**
- Update DNS records at domain registrar to point `dorkos.ai` to Vercel
- Wait for DNS propagation (typically 5-30 minutes, up to 48 hours)
- SSL certificate is automatically provisioned by Vercel after DNS propagates

**Optional: GitHub Integration**
After the initial CLI deploy, connect the GitHub repo in the Vercel dashboard for automatic deploys on push. Since the repo is public, this works on the Hobby plan. Navigate to: Vercel Dashboard → Project Settings → Git → Connect Git Repository.

## Open Questions — Resolved

1. ~~**Contact email**~~ (RESOLVED)
   **Answer:** `hey@dorkos.ai` — stored in a site config file (not hardcoded in component)

2. ~~**Cookie consent**~~ (RESOLVED)
   **Answer:** Keep the cookie consent banner but with PostHog's built-in opt-out setting disabled by default. If no built-in toggle exists, add a config option to enable/disable it.

3. ~~**OG image design**~~ (RESOLVED)
   **Answer:** Keep Calm Tech style (cream/charcoal/orange). Update text to DorkOS branding.

4. ~~**Marketing content**~~ (RESOLVED)
   **Answer:** Use placeholder content during implementation. Actual copy (feature names, descriptions, philosophy items) will be written separately.

## Related ADRs

- **ADR-0004: Monorepo with Turborepo** — Establishes the monorepo pattern that `apps/web` follows
- **ADR-0002: Feature-Sliced Design** — FSD architecture used in marketing components (preserved from 144x.co)

## References

- [Ideation document](./01-ideation.md) — Full ideation with research findings and clarification decisions
- [Research report](../../research/20260216_fumadocs_vercel_docs_site.md) — Fumadocs, Vercel, and monorepo research
- [Documentation Infrastructure spec (#31)](../documentation-infrastructure/02-specification.md) — Defines the `docs/` directory structure
- [Fumadocs documentation](https://fumadocs.dev) — Framework docs
- [Fumadocs OpenAPI integration](https://fumadocs.dev/docs/integrations/openapi) — API docs rendering
- [Vercel Turborepo deployment](https://vercel.com/docs/monorepos/turborepo) — Monorepo deploy docs
- Source codebase: `/Users/doriancollier/Keep/144/144x.co`
