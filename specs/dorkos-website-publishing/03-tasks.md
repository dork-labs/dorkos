---
slug: dorkos-website-publishing
number: 35
created: 2026-02-16
status: draft
---

# DorkOS Website & Documentation Publishing — Tasks

## Phase 1: Scaffold & Strip

### Task 1.1: Copy 144x.co source into apps/web and strip unwanted features

**Size:** Large

Copy the existing Next.js 16 codebase from `/Users/doriancollier/Keep/144/144x.co` into `apps/web/`. Then strip the following features and their associated files:

**Remove these features/files:**
- **BetterAuth:** `src/layers/features/auth/`, `api/auth/`, `src/layers/shared/api/auth.ts`
- **Prisma/DB:** `prisma/`, `src/layers/shared/api/errors.ts` (if DB-specific)
- **User entity:** `src/layers/entities/user/`
- **MCP server:** `src/layers/features/mcp-database-server/`, `api/mcp/`
- **Dashboard:** `src/app/(authenticated)/`
- **Auth pages:** `src/app/(auth)/`
- **Design system page:** `src/app/system/`
- **App sidebar:** `src/layers/widgets/app-sidebar/`
- **API routes:** `src/app/api/` (all)
- **TanStack Query:** `src/layers/shared/lib/query-client.ts`
- **Env validation:** `src/env.ts`
- **PWA manifest:** `src/app/manifest.ts`
- **pnpm files:** `pnpm-lock.yaml`, `pnpm-workspace.yaml`

**Keep these features:**
- PostHog analytics (client init, reverse proxy, server-side client)
- Contact section (terminal-style email reveal)
- Motion animations
- shadcn/ui components
- Dark mode (next-themes)
- Fonts (IBM Plex Sans/Mono via next/font)
- Calm Tech CSS design system (`globals.css`)
- Marketing route group `(marketing)` with Hero, ProjectsGrid, PhilosophyCards, ContactSection

**Remove these npm dependencies from package.json:**
- `better-auth`, `@prisma/adapter-better-sqlite3`
- `prisma`, `@prisma/client`, `better-sqlite3`
- `@modelcontextprotocol/sdk`, `mcp-handler`
- `@t3-oss/env-nextjs`
- `react-hook-form`, `@hookform/resolvers`
- `recharts`
- `nuqs`

Fix any broken imports after stripping. Remove references to deleted modules in remaining files (providers, layouts, etc.).

**Verification:** The stripped codebase has no import errors pointing to deleted modules.

---

### Task 1.2: Create apps/web/package.json and configure workspace

**Size:** Medium
**Dependencies:** None (can start after Task 1.1 copy, but listed separately for clarity)

Create `apps/web/package.json` with workspace configuration:

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

Dependencies should include only the kept packages: Next.js 16, React 19, Tailwind CSS 4, posthog-js, next-themes, motion, shadcn/ui components, and their peer deps. Do NOT include: better-auth, prisma, @prisma/client, better-sqlite3, @modelcontextprotocol/sdk, mcp-handler, @t3-oss/env-nextjs, react-hook-form, @hookform/resolvers, recharts, nuqs.

Run `npm install` from the repo root to resolve all workspace dependencies.

**Verification:** `npm ls @dorkos/web` shows the package in the workspace tree. No missing peer dependency warnings for kept packages.

---

### Task 1.3: Update turbo.json for web workspace

**Size:** Small
**Dependencies:** Task 1.2

Update the root `turbo.json`:

1. Add `.next/**` to the `build` task `outputs` array
2. Add `NEXT_PUBLIC_*` and `POSTHOG_*` to the `build` task env list
3. Add a `generate:api-docs` task definition that the `build` task depends on:

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["generate:api-docs", "^build"],
      "outputs": [".next/**", "dist/**"]
    },
    "generate:api-docs": {
      "cache": true
    }
  }
}
```

Merge these with existing turbo.json config (do not overwrite existing outputs or dependsOn entries).

**Verification:** `npx turbo build --filter=@dorkos/web --dry-run` shows correct task graph including generate:api-docs.

---

## Phase 2: Fumadocs Integration

### Task 2.1: Set up Fumadocs MDX pipeline

**Size:** Medium
**Dependencies:** Task 1.1, Task 1.2

Install Fumadocs packages in `apps/web`:
- `fumadocs-mdx`
- `fumadocs-core`
- `fumadocs-ui`

Create `apps/web/source.config.ts`:

```typescript
import { defineDocs, defineConfig } from 'fumadocs-mdx/config';

export const docs = defineDocs({
  dir: '../../docs',  // Points to repo root docs/ directory
});

export default defineConfig();
```

Create `apps/web/lib/source.ts`:

```typescript
import { docs } from 'fumadocs-mdx:collections/server';
import { loader } from 'fumadocs-core/source';

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
});
```

Update `apps/web/next.config.ts` to use `createMDX` from `fumadocs-mdx/next`:

```typescript
import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

const nextConfig = {
  // ... existing config (PostHog rewrites, etc.)
};

export default withMDX(nextConfig);
```

**Verification:** `npm run build --filter=@dorkos/web` completes without Fumadocs-related errors.

---

### Task 2.2: Create docs route group with layout and catch-all page

**Size:** Medium
**Dependencies:** Task 2.1

Create `apps/web/app/(docs)/layout.tsx`:

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

Create `apps/web/app/(docs)/docs/[[...slug]]/page.tsx`:

```typescript
import { source } from '@/lib/source';
import { DocsPage, DocsBody } from 'fumadocs-ui/page';
import { notFound } from 'next/navigation';

export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();
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

Create `apps/web/components/mdx-components.tsx` for MDX component overrides (export default components object with any custom element mappings).

**Verification:** `localhost:3000/docs` renders the Getting Started page. Sidebar shows all doc sections.

---

## Phase 3: OpenAPI Docs

### Task 3.1: Wire fumadocs-openapi for interactive API reference

**Size:** Medium
**Dependencies:** Task 2.2

Install packages in `apps/web`:
- `fumadocs-openapi`
- `shiki`

Create `apps/web/lib/openapi.ts`:

```typescript
import { createOpenAPI } from 'fumadocs-openapi/server';

export const openapi = createOpenAPI({
  input: ['../../docs/api/openapi.json'],
});
```

Create `apps/web/scripts/generate-api-docs.ts`:

```typescript
import { generateFiles } from 'fumadocs-openapi';
import { openapi } from '../lib/openapi';

void generateFiles({
  input: openapi,
  output: '../../docs/api',
  includeDescription: true,
});
```

Create `apps/web/components/api-page.tsx` wrapper component:

```typescript
import { APIPage as FumadocsAPIPage } from 'fumadocs-openapi/ui';

export function APIPage(props: React.ComponentProps<typeof FumadocsAPIPage>) {
  return <FumadocsAPIPage {...props} />;
}
```

Update `apps/web/app/(docs)/docs/[[...slug]]/page.tsx` to handle OpenAPI pages:

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

**Verification:** `npm run generate:api-docs` produces MDX files. `localhost:3000/docs/api/...` renders interactive API endpoint documentation.

---

## Phase 4: Branding & Content

### Task 4.1: Create site config and update branding metadata

**Size:** Medium
**Dependencies:** Task 1.1

Create `apps/web/lib/site-config.ts`:

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

Update `apps/web/app/layout.tsx` metadata:
- Change title from "Dorkian" to "DorkOS"
- Change description from "Independent studio..." to "A web UI for Claude Code"
- Update openGraph metadata to use siteConfig values

Update `apps/web/app/(marketing)/layout.tsx`:
- Change JSON-LD schema from `Organization` (Dorkian) to `SoftwareApplication` (DorkOS)
- Reference siteConfig for all string values

Update all components that hardcode site name, description, or URLs to use `siteConfig` imports instead.

**Verification:** View source of rendered pages shows DorkOS metadata, not Dorkian/144x.co.

---

### Task 4.2: Update marketing content with DorkOS placeholders

**Size:** Medium
**Dependencies:** Task 4.1

Update projects data file (likely `apps/web/layers/features/marketing/lib/projects.ts`):
- Replace the 6 portfolio projects with DorkOS feature highlights (placeholder content)
- Each item should have: title, description, image/icon placeholder

Update philosophy items (likely `apps/web/layers/features/marketing/lib/philosophy.ts`):
- Replace studio values with DorkOS design principles (e.g., "Open Source", "Developer First", "Privacy Respecting")
- Use placeholder descriptions

Update contact section:
- Change email to `siteConfig.contactEmail` (`hey@dorkos.ai`)

Update OG image generation (`apps/web/app/opengraph-image.tsx`):
- Change branding text from Dorkian to DorkOS
- Keep Calm Tech style (cream/charcoal/orange color palette)

**Verification:** Marketing pages show DorkOS branding and placeholder content, not 144x.co content.

---

### Task 4.3: Create sitemap and SEO pages

**Size:** Small
**Dependencies:** Task 2.1, Task 4.1

Update `apps/web/app/sitemap.ts` to include Fumadocs pages:

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

Create `apps/web/app/(public)/` route group with placeholder legal pages:
- `apps/web/app/(public)/layout.tsx` — Simple layout wrapper
- `apps/web/app/(public)/privacy/page.tsx` — Placeholder privacy policy
- `apps/web/app/(public)/terms/page.tsx` — Placeholder terms of service
- `apps/web/app/(public)/cookies/page.tsx` — Placeholder cookie policy

Each placeholder page should have a heading, a brief "Coming soon" message, and proper metadata.

Update `apps/web/app/robots.ts` for dorkos.ai domain:

```typescript
export default function robots() {
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: 'https://dorkos.ai/sitemap.xml',
  };
}
```

Create `apps/web/app/not-found.tsx` with a styled 404 page matching the Calm Tech design.

**Verification:** `/sitemap.xml` returns XML with marketing + docs URLs. `/privacy`, `/terms`, `/cookies` render placeholder pages. `/nonexistent` shows 404 page.

---

## Phase 5: Vercel Deployment

### Task 5.1: Configure and deploy to Vercel via CLI

**Size:** Medium
**Dependencies:** Task 4.2, Task 4.3, Task 3.1

This task covers the full Vercel deployment pipeline. Steps:

1. **Install Vercel CLI** (if not already installed):
   ```bash
   npm i -g vercel
   vercel login
   ```

2. **Link project to Vercel:**
   ```bash
   cd apps/web
   vercel link
   ```
   During `vercel link`, select:
   - Scope: `dork-labs` (or personal account)
   - Link to existing project? No, create new
   - Project name: `dorkos-web`
   - Root directory: `./` (already in `apps/web`)
   - Build command: `cd ../.. && npx turbo build --filter=@dorkos/web`
   - Output directory: `.next`
   - Development command: `next dev --turbopack`

3. **Set environment variables:**
   ```bash
   vercel env add NEXT_PUBLIC_POSTHOG_KEY production preview development
   vercel env add NEXT_PUBLIC_POSTHOG_HOST production preview development
   ```

4. **Create `apps/web/vercel.json`:**
   ```json
   {
     "ignoreCommand": "npx turbo-ignore"
   }
   ```

5. **Deploy preview:**
   ```bash
   cd apps/web
   vercel deploy
   ```

6. **Configure domain:**
   ```bash
   vercel domains add dorkos.ai
   ```
   (User must manually update DNS records at their domain registrar)

7. **Deploy production:**
   ```bash
   vercel deploy --prod
   ```

8. **Verify:** Check that marketing pages, docs, and API docs all render at the production URL.

**Note:** DNS configuration is a manual step for the user. SSL is auto-provisioned by Vercel after DNS propagates.

**Verification:** Preview deployment URL loads marketing site, `/docs` loads documentation, `/docs/api/*` loads API reference.

---

## Phase 6: Documentation & Final Verification

### Task 6.1: Update project documentation for apps/web

**Size:** Small
**Dependencies:** Task 5.1

Update the following documentation files:

1. **Root `README.md`:** Add mention of `apps/web` as the marketing website and documentation site.

2. **Create `apps/web/README.md`:** Include:
   - Brief description (marketing site + docs for DorkOS)
   - Local development instructions (`npm run dev` from root or `turbo dev --filter=@dorkos/web`)
   - Build instructions
   - Environment variables needed (`NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`)
   - Deployment info (Vercel, `dorkos.ai`)

3. **Update `CLAUDE.md`:** Add `apps/web` to the monorepo structure diagram:
   ```
   ├── apps/
   │   ├── client/           # @dorkos/client - React 19 SPA
   │   ├── server/           # @dorkos/server - Express API
   │   ├── web/              # @dorkos/web - Marketing site & docs (Next.js 16, Fumadocs)
   │   └── obsidian-plugin/  # @dorkos/obsidian-plugin - Obsidian plugin
   ```

4. **Update `contributing/project-structure.md`:** Add `apps/web` to the monorepo map with a description of its purpose, tech stack, and relationship to the `docs/` directory.

**Verification:** All documentation files accurately reflect the new `apps/web` workspace.
