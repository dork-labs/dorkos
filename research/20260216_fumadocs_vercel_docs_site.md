---
title: 'Fumadocs + Vercel Documentation Site'
date: 2026-02-16
type: implementation
status: archived
tags: [fumadocs, vercel, docs, next-js, mdx]
feature_slug: documentation-infrastructure
searches_performed: 14
---

# Fumadocs + Vercel Documentation Site — Research Report

**Date**: 2026-02-16
**Mode**: Deep Research
**Searches performed**: 14
**Sources evaluated**: 40+

---

## Research Summary

Fumadocs is a mature, flexible docs framework built on Next.js App Router. The recommended architecture for DorkOS is a **single Next.js app using route groups** to co-locate marketing pages and docs under one deployment, with MDX content pulled in from the main repo's `docs/` directory via git submodule or direct copy at build time. Vercel's Turborepo integration handles the monorepo deployment cleanly — each app in `apps/` becomes an independent Vercel project pointing at the same repo with different root directory settings.

---

## Key Findings

### 1. Fumadocs works natively with Next.js App Router route groups

Fumadocs composes into the App Router without friction. The canonical pattern for combining marketing pages and docs in a single Next.js app is Next.js **route groups**: `app/(web)/` for marketing pages and `app/(docs)/docs/[[...slug]]/` for documentation. Each group has its own root layout and providers. Fumadocs only needs to be mounted in the `(docs)` layout — the rest of the app is untouched. This is well-documented and widely used in the community (see [fumadocs/discussions/860](https://github.com/fuma-nama/fumadocs/discussions/860)).

### 2. Fumadocs MDX supports external content directories and git submodules via Workspaces

Fumadocs has a first-class **Workspace** feature in `source.config.ts` that points to an external directory (including a git submodule path). Each workspace is independent, has its own config, and generates isolated collections under `.source/{workspace}/`. This is the cleanest path for DorkOS: the main repo's `docs/` directory can be mounted as a workspace pointing to content that came from the `dorkos` repo via submodule.

### 3. Vercel handles Turborepo monorepos natively — each app is a separate Vercel project

Vercel auto-detects Turborepo monorepos. You create **one Vercel project per app**, each configured with a `Root Directory` pointing to `apps/web`, `apps/docs`, etc. Build commands are `turbo build` (scoped automatically). This means `docs.dorkos.ai` and `dorkos.ai` can be entirely separate Vercel projects from the same monorepo, independently deployed and cached.

### 4. Private git submodules on Vercel require a manual HTTPS token workaround

Vercel does **not** natively support private git submodules. The workaround is: create a fine-grained GitHub PAT (read-only, no expiry), store it as `GITHUB_REPO_CLONE_TOKEN` in Vercel env vars, and add a pre-install bash script that re-initializes the submodule over HTTPS using the token. Public submodules work without any extra configuration.

### 5. Vercel Hobby plan supports personal account private repos but not org repos

Personal GitHub account private repos deploy fine on Hobby (free). GitHub organization-owned private repos require a Pro or Enterprise Vercel plan ($20/user/month). Since `dork-labs/dorkos` is an organization repo, deploying the marketing/docs site from it will require Vercel Pro — or the workaround of deploying via GitHub Actions + Vercel CLI (which sidesteps the direct Git integration requirement).

---

## Detailed Analysis

### Fumadocs Integration Patterns

#### Project Structure

The canonical Fumadocs + marketing layout in a single Next.js app:

```
app/
  (web)/                    # Marketing pages — own layout
    layout.tsx
    page.tsx                # Landing page
    pricing/page.tsx
    blog/page.tsx
  (docs)/                   # Docs — own layout with Fumadocs providers
    layout.tsx              # <RootProvider> + DocsLayout from fumadocs-ui
    docs/
      [[...slug]]/
        page.tsx            # Dynamic catch-all route
source.config.ts            # Fumadocs MDX configuration
content/
  docs/                     # MDX files (or git submodule path)
    index.mdx
    getting-started.mdx
```

The `(web)` and `(docs)` route groups are invisible to URL routing — they exist only to allow separate `layout.tsx` files. Both groups share the same Next.js app, same deployment, and same domain.

#### How Fumadocs Consumes MDX

Fumadocs uses **fumadocs-mdx** as its default content pipeline. It is a webpack/turbopack plugin that processes `.mdx` files at build time into React Server Components, generating type-safe collection data. Content is declared in `source.config.ts`:

```ts
// source.config.ts
import { defineDocs, defineConfig } from 'fumadocs-mdx/config';

export const docs = defineDocs({
  dir: 'content/docs',   // point this anywhere, including a submodule path
});

export default defineConfig({ ... });
```

For external content directories (e.g., a git submodule at `content/docs` that actually lives in the `dorkos` repo), you simply point `dir` at the resolved path. The **Workspace** feature extends this for multi-source scenarios:

```ts
// source.config.ts (workspace approach)
export default defineConfig({
  workspaces: {
    'dorkos-docs': {
      dir: './content/docs', // git submodule or symlinked path
      config: await import('./content/docs/source.config.ts'),
    },
  },
});
```

#### Fumadocs vs Content Collections

| Aspect         | fumadocs-mdx                          | Content Collections                 |
| -------------- | ------------------------------------- | ----------------------------------- |
| Processing     | Webpack/Turbopack plugin (build-time) | mdx-bundler (more flexible)         |
| Type safety    | Yes                                   | Yes                                 |
| Performance    | Excellent (500+ files OK)             | Good                                |
| Flexibility    | Opinionated (good defaults)           | Bring-your-own MDX                  |
| Recommendation | Default for Fumadocs                  | When you need CMS-style flexibility |

**Recommendation for DorkOS**: Use `fumadocs-mdx` (the default). Content Collections is only worth the overhead if you need dynamic/CMS-driven content.

#### Fumadocs OpenAPI Integration

`fumadocs-openapi` is a first-class integration package. It reads an OpenAPI 3.0/3.1 spec file (local JSON/YAML or remote URL) and either:

1. **Generates MDX files** via `generateFiles()` — run this as a pre-build script, outputs static `.mdx` files you commit or `.gitignore`
2. **Virtual files** — integrates directly into the Fumadocs Loader API without generating physical files

Setup summary:

```bash
npm i fumadocs-openapi shiki
```

```ts
// In source.config.ts or a separate openapi.ts
import { createOpenAPI, attachFile } from 'fumadocs-openapi/server';

const openapi = createOpenAPI({
  input: ['./docs/api/openapi.json'], // path to your exported spec
});
```

The integration provides: endpoint listings, interactive API playground (try-it), code samples in multiple languages, TypeScript type definitions, response schemas. It requires Tailwind CSS (already in DorkOS).

For DorkOS's use case: `npm run docs:export-api` already exports `docs/api/openapi.json`. This file becomes the `input` for `createOpenAPI()`. The generated API docs pages slot into the Fumadocs navigation automatically.

---

### Monorepo vs Single Repo

#### Current DorkOS Structure

DorkOS already has a Turborepo monorepo (`apps/`, `packages/`). The question is whether the marketing/docs Next.js site lives:

**Option A: As a new app in the existing DorkOS monorepo** (`apps/web`)

- Pros: Shared packages (design tokens, types), single repo to manage, automatic rebuild when shared packages change, one CI pipeline
- Cons: Larger repo, website deployment couples with CLI/server changes, Vercel org repo restriction applies (need Pro plan)
- Best for: Tight coupling between product and docs, shared design system

**Option B: Separate repo for the marketing/docs site**

- Pros: Independent deployment, can be on Vercel Hobby if personal account, simpler repo
- Cons: No shared packages without npm publishing, two repos to manage
- Best for: When the site is mostly static and doesn't share code with the product

**Option C: New Turborepo for the marketing/docs site only** (next-forge pattern)

- The next-forge template shows: `apps/web` (marketing), `apps/docs` (Fumadocs), `apps/app` (product), with shared packages
- Pros: Maximum separation between marketing and docs at the deployment level
- Cons: Overkill for a docs-only site, two separate Turborepos to maintain

**Recommendation for DorkOS**: Option A — add `apps/web` to the existing monorepo. The design system and types are already shared packages. A single Vercel project per app means independent deploy, so coupling isn't a build problem. The org repo / Vercel Pro requirement is the main cost consideration.

#### When Does a Separate Monorepo Make Sense?

A Turborepo for the website alone makes sense when: (1) the website team is separate from the product team, (2) the website has its own design tokens not shared with the product, or (3) you want free Vercel Hobby on a personal fork. For a solo/small team project like DorkOS, it adds complexity without benefit.

---

### Git Submodule vs Other Content Integration Patterns

#### Pattern Comparison

| Pattern                    | How it works                                                    | Vercel support                                                     | Complexity                                  | Freshness                                            |
| -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------- |
| **Git submodule**          | `docs/` is a submodule pointing to `dorkos` repo's `docs/` dir  | Needs PAT workaround for private repos; public repos work natively | Medium                                      | Manual `git submodule update` or CI trigger          |
| **Build-time fetch**       | Script fetches content from GitHub API or raw URLs during build | Works natively                                                     | Low-medium                                  | Always fresh (fetches on every build)                |
| **npm package**            | Content published as `@dork-labs/docs-content` npm package      | Works natively                                                     | High (need to publish on every docs change) | Requires version bump + publish                      |
| **Direct copy / monorepo** | Content lives in `apps/web/content/docs/` — same repo           | Works natively                                                     | Lowest                                      | Committed to same repo                               |
| **`@fumadocs/mdx-remote`** | Fetches and compiles MDX at runtime (SSG)                       | Works natively                                                     | Low                                         | Fresh on every build; supports remote GitHub content |

#### Detailed Analysis of Each Pattern

**Git Submodule (recommended for DorkOS if public repo)**

The `docs/` directory in the `dorkos` repo is already the canonical content source. A git submodule in the marketing site repo at `content/docs` pointing to `dorkos/docs/` is the most architecturally clean approach. The Fumadocs workspace or `dir` config can point directly at it.

For public repos: works out-of-the-box with Vercel.
For private repos: requires the HTTPS PAT workaround (see Private Repo section below).

Trigger on content change: add a GitHub Actions workflow in the `dorkos` repo that dispatches a `repository_dispatch` event to the marketing site repo on every commit to `docs/**`.

**Direct Copy in Same Monorepo (recommended for DorkOS in practice)**

Since the marketing site would live in `apps/web` inside the `dorkos` monorepo, the `docs/` content is already in the same repo. No submodule needed. The `source.config.ts` in `apps/web` points `dir` at `../../docs/` (relative to the app). This is the simplest approach and eliminates all submodule complexity.

```ts
// apps/web/source.config.ts
export const docs = defineDocs({
  dir: '../../docs', // points to /docs/ at repo root
});
```

**Build-time fetch via `@fumadocs/mdx-remote`**

For content that must come from a different repo (e.g., a community docs repo), `@fumadocs/mdx-remote` is a first-class Fumadocs package that fetches and processes MDX files at build time without requiring physical files. Supports GitHub API or raw URLs.

**npm package**

Only worth it if you need semantic versioning of docs content (e.g., docs that need to match specific product versions). High operational overhead.

---

### Vercel Deployment for Docs Sites

#### Multi-App Turborepo on Vercel

Each app in `apps/` becomes a separate **Vercel Project** connected to the same GitHub repo:

| Vercel Project  | Root Directory               | Domain      |
| --------------- | ---------------------------- | ----------- |
| `dorkos-web`    | `apps/web`                   | `dorkos.ai` |
| `dorkos-server` | N/A (not deployed to Vercel) | —           |

Configuration in the Vercel dashboard per project:

- **Root Directory**: `apps/web`
- **Build Command**: `turbo build` (Vercel auto-scopes to the root directory's package)
- **Ignored Build Step**: `npx turbo-ignore --fallback=HEAD^1` (skips build if nothing in `apps/web` or its dependencies changed)

The `turbo-ignore` step is critical for monorepos — it prevents the docs site from rebuilding when only the server code changed.

#### Subdomain vs Path Routing

| Approach                                | Implementation                                                | SEO                       | Complexity         |
| --------------------------------------- | ------------------------------------------------------------- | ------------------------- | ------------------ |
| `docs.dorkos.ai` (subdomain)            | Separate Vercel project, separate deployment, CNAME to Vercel | Separate domain authority | Low (two projects) |
| `dorkos.ai/docs` (path)                 | Same Next.js app, route groups, one deployment                | Shares domain authority   | Low (one project)  |
| `dorkos.ai/docs` via Next.js Multi-Zone | Two separate deployments, `rewrites` to stitch together       | Shares domain authority   | Medium             |

**Recommendation**: `dorkos.ai/docs` via route groups in a single Next.js app. This is the simplest approach, shares domain authority for SEO, requires no DNS configuration beyond the main domain, and Fumadocs coexists cleanly with marketing pages via route groups. Use `docs.dorkos.ai` only if you want the docs site to be independently deployable by a different team.

#### Build Caching and Performance

Vercel's Turborepo Remote Cache is enabled automatically when you deploy from Vercel. Build times for a typical Fumadocs site with 50-100 MDX pages are under 60 seconds on first build, and under 10 seconds on cache hit. The `turbo-ignore` step further reduces unnecessary builds.

For the OpenAPI docs: `generateFiles()` should run as part of the build step, not committed to source. Add it to `turbo.json`'s `build` pipeline as a pre-step, and add the output directory to `.gitignore`.

---

### Private Repo Considerations

#### Vercel Plan Requirements

| Scenario                                      | Plan Needed                                | Cost           |
| --------------------------------------------- | ------------------------------------------ | -------------- |
| Personal GitHub account, private repo         | Hobby (free)                               | $0             |
| GitHub org repo (`dork-labs/dorkos`), private | Pro Team                                   | $20/user/month |
| GitHub org repo, public                       | Hobby (free)                               | $0             |
| GitHub Actions → Vercel CLI deploy            | Any plan (bypasses direct Git integration) | Hobby free     |

**The key restriction**: Vercel's direct GitHub integration for organization repos requires a Team (Pro) plan. This affects `dork-labs/dorkos` if it remains private.

**Workaround for avoiding Pro plan**: Deploy via **GitHub Actions + Vercel CLI**. The workflow runs `vercel deploy` with `VERCEL_TOKEN` on every push to `main`. This sidesteps Vercel's direct organization repo restriction. A working pattern:

```yaml
# .github/workflows/deploy.yml
- uses: actions/checkout@v4
  with:
    submodules: recursive # handles public submodules
- run: vercel deploy --prod --token=${{ secrets.VERCEL_TOKEN }}
```

#### Private Submodule Authentication on Vercel

If using git submodules from a private repo, the required setup for Vercel is:

1. Create a GitHub fine-grained PAT: read-only, no expiry, scoped to the content repo only
2. Add to Vercel project env vars as `GITHUB_REPO_CLONE_TOKEN`
3. Add a pre-install script in `package.json`:

```json
"preinstall": "bash scripts/init-submodule.sh"
```

```bash
#!/bin/bash
# scripts/init-submodule.sh
git config submodule.content/docs.url \
  "https://${GITHUB_REPO_CLONE_TOKEN}@github.com/dork-labs/dorkos.git"
git submodule sync
git submodule update --init --recursive
```

Important: **do not commit `.gitmodules`** — keep it in `.gitignore`. The submodule URL is injected at build time via the script.

**Simpler alternative**: If the `docs/` directory is in the same monorepo (Option A above), no submodule configuration is needed at all — this entire complexity disappears.

---

## Recommendations for DorkOS

### Recommended Architecture

```
dorkos/                          (existing monorepo)
  apps/
    web/                         (NEW — Next.js 15 app)
      app/
        (marketing)/             (route group)
          layout.tsx
          page.tsx               (landing page)
          pricing/page.tsx
        (docs)/                  (route group — Fumadocs)
          layout.tsx             (RootProvider + DocsLayout)
          docs/
            [[...slug]]/
              page.tsx
      source.config.ts           (points dir at ../../docs/)
      next.config.ts
      package.json
    client/                      (existing)
    server/                      (existing)
    obsidian-plugin/             (existing)
  docs/                          (existing — MDX content, already here)
    api/
      openapi.json               (generated, gitignored)
```

### Content Integration Decision

Use **direct path reference** from `apps/web/source.config.ts` pointing at `../../docs/`. The `docs/` directory is already in the same monorepo — no submodule complexity needed. Fumadocs MDX compiles it at build time.

### OpenAPI Docs

Add `generateFiles()` as a pre-build step. The `docs/api/openapi.json` is already generated by `npm run docs:export-api`. Wire it into the Fumadocs OpenAPI integration with `createOpenAPI({ input: ['../../docs/api/openapi.json'] })`.

### Vercel Deployment

- If `dork-labs/dorkos` becomes **public**: Deploy directly from Vercel, Hobby plan is fine.
- If it stays **private**: Either upgrade to Vercel Pro (simplest), or use GitHub Actions + Vercel CLI deploy (free workaround).
- Create a single Vercel project `dorkos-web` with Root Directory = `apps/web`.
- Add `vercel.json` or configure `ignored build step` to `npx turbo-ignore`.
- Domain: Start with `dorkos.ai/docs` (route groups, same deployment) — can split to `docs.dorkos.ai` later if needed.

---

## Research Gaps and Limitations

- Exact Fumadocs v16 `source.config.ts` workspace syntax could not be fully verified from live docs (some pages returned 404 during research).
- Vercel Pro plan pricing ($20/user/month as of 2025) may have changed — verify at vercel.com/pricing before committing.
- `@fumadocs/mdx-remote` documentation was inaccessible (npm returned 403) — the package exists and is actively maintained but setup specifics require consulting the fumadocs GitHub directly.
- Next-forge structure page returned 404; structure was inferred from search results and the GitHub repo.

---

## Contradictions and Disputes

- Some sources suggest running marketing and docs as **entirely separate Next.js apps** (next-forge pattern) for maximum independence. Others (including Fumadocs maintainer guidance) recommend a single app with route groups for simplicity. For a small team, route groups win on simplicity. For a large team with separate deploy cadences, separate apps win.
- Git submodules have a vocal "never use them" contingent in the developer community, primarily due to DX friction for contributors. For a CI/CD-only use case (docs content consumed but not edited in the site repo), submodules are fine. The "same monorepo" approach sidesteps this debate entirely.

---

## Sources and Evidence

- [Fumadocs official site](https://www.fumadocs.dev/) — framework homepage
- [Fumadocs Discussion #860: Separate root layout under /docs](https://github.com/fuma-nama/fumadocs/discussions/860) — route group pattern confirmed by maintainer
- [Fumadocs Workspace docs](https://www.fumadocs.dev/docs/mdx/workspace) — external content dir / submodule workspace feature
- [Fumadocs OpenAPI integration](https://www.fumadocs.dev/docs/integrations/openapi) — generateFiles(), createOpenAPI() config
- [fumadocs-mdx npm](https://www.npmjs.com/package/fumadocs-mdx) — default MDX pipeline
- [@fumadocs/mdx-remote npm](https://www.npmjs.com/package/@fumadocs/mdx-remote) — remote MDX content adapter
- [Fumadocs Content Collections](https://www.fumadocs.dev/docs/headless/content-collections) — alternative content source
- [Vercel: Deploying Turborepo](https://vercel.com/docs/monorepos/turborepo) — root directory config, turbo-ignore, remote cache
- [Vercel: Using Monorepos](https://vercel.com/docs/monorepos) — multi-app deployment patterns
- [Vercel: Account Plans](https://vercel.com/docs/plans) — Hobby vs Pro limitations
- [Vercel: Hobby Plan](https://vercel.com/docs/plans/hobby) — personal vs org repo restrictions
- [Private Git Submodules with Vercel — Timmy O'Mahony](https://timmyomahony.com/blog/private-git-submodule-with-vercel/) — HTTPS PAT workaround
- [Vercel community: Private submodule support](https://github.com/vercel/community/discussions/44) — official limitation discussion
- [next-forge: Turborepo marketing + docs template](https://www.next-forge.com/) — reference architecture
- [Turborepo: Next.js guide](https://turborepo.dev/docs/guides/frameworks/nextjs) — monorepo setup
- [Vercel Academy: Production Monorepos](https://vercel.com/academy/production-monorepos) — deploy both apps tutorial

---

## Search Methodology

- Searches performed: 14
- Most productive search terms: "fumadocs route groups marketing pages", "Vercel git submodule private repo authentication", "Vercel hobby plan private org repo", "fumadocs workspace source.config.ts external"
- Primary information sources: fumadocs.dev, vercel.com/docs, GitHub discussions (fumadocs repo), developer blog posts
