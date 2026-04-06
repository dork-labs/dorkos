---
slug: marketplace-04-web-and-registry
number: 227
created: 2026-04-06
status: specified
parent-spec: dorkos-marketplace
project: dorkos-marketplace
sequence: 4
depends-on: [marketplace-01-foundation, marketplace-02-install]
depended-on-by: []
linear-issue: null
---

# Marketplace 04: Web & Registry — Technical Specification

**Slug:** marketplace-04-web-and-registry
**Author:** Claude Code
**Date:** 2026-04-06
**Project:** DorkOS Marketplace (5 specs total)
**Sequence:** 4 of 5

---

## Overview

This specification covers the **public face** of the DorkOS Marketplace: the `dorkos-community` GitHub organization with its registry repo, the `/marketplace` web pages on dorkos.dev, the 8 seed packages (3 agents, 2 plugins, 2 skill packs, 1 adapter), the submission process, and the install telemetry pipeline that powers ranking and analytics.

After this spec ships, anyone with a web browser can discover what DorkOS does without installing it, install pre-built packages from a curated catalog, and contribute their own packages via PR. The flywheel begins.

### Why

Specs 01–03 give us the technical machinery: schemas, install, browse UI. None of it matters without **content**. A marketplace with 0 packages is just an unused feature. This spec ships the seed content that makes the marketplace immediately useful and creates the contribution pathway for the community to add more.

The web page is equally important. Users discover DorkOS via search engines and AI tools long before they install it. A public marketplace surface gives them a way to evaluate what DorkOS can do without committing to a CLI install.

### Source Documents

- `specs/marketplace-04-web-and-registry/01-ideation.md` — This spec's ideation
- `specs/dorkos-marketplace/01-ideation.md` — Parent project ideation
- `specs/marketplace-02-install/02-specification.md` — HTTP API and telemetry hook
- `apps/site/` — Existing dorkos.dev marketing site (Next.js 16, Fumadocs)
- `apps/site/src/layers/features/marketing/lib/features.ts` — Reference: existing feature catalog data model
- `apps/site/src/app/features/` — Reference: existing feature catalog routes + OG images
- `meta/site-feature-catalog.md` — Memory note: feature catalog is the closest existing pattern

---

## Goals

- Create `dorkos-community` GitHub organization and seed it with the registry + 8 packages
- Implement `/marketplace` and `/marketplace/[slug]` pages on dorkos.dev
- Implement telemetry endpoint (Vercel Edge Function) with KV + Postgres storage
- Implement ranking function that combines featured weight, install count, and recency
- Implement submission flow with GitHub Actions validation
- Generate OG images for every marketplace page
- Update `llms.txt` and sitemap with marketplace pages
- Wire DorkOS client to send opt-in telemetry events to the endpoint
- Complete vitest + Playwright coverage for web routes

## Non-Goals

- Browse UI inside DorkOS (spec 03)
- MCP server (spec 05)
- Personal marketplace publishing (spec 05)
- Self-serve registry submission (PR-based for v1)
- User accounts on dorkos.dev (deferred)
- Payment processing (deferred)
- Reviews / ratings (deferred)
- Sigstore signing (deferred)

---

## Technical Dependencies

| Dependency                 | Version       | Purpose                                                           |
| -------------------------- | ------------- | ----------------------------------------------------------------- |
| `@dorkos/marketplace`      | `workspace:*` | Schemas, types from spec 01                                       |
| Next.js 16 (App Router)    | (existing)    | apps/site framework                                               |
| Fumadocs                   | (existing)    | Docs framework integrated with apps/site                          |
| `@vercel/og`               | (existing)    | OG image generation (Satori)                                      |
| `@vercel/edge-config`      | (new on site) | Featured-package overrides at the edge                            |
| `@upstash/redis`           | (new on site) | Install count counters (telemetry). Replaces sunset `@vercel/kv`. |
| `@neondatabase/serverless` | (new on site) | Telemetry event storage. Replaces sunset `@vercel/postgres`.      |
| `streamdown` / `mdx`       | (existing)    | README rendering                                                  |
| TanStack Query             | N/A           | Web pages are SSG, no client-side query                           |

The site already runs on Vercel; Upstash Redis and Neon Postgres are added via Vercel Marketplace integrations:

```bash
vercel integration add upstash    # Provisions UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
vercel integration add neon       # Provisions DATABASE_URL
```

**Important:** `@vercel/kv` and `@vercel/postgres` are **sunset**. We use `@upstash/redis` (with `Redis.fromEnv()`) and `@neondatabase/serverless` directly.

---

## Detailed Design

### Architecture

```
                ┌─────────────────────────────────────┐
                │  github.com/dorkos-community         │
                │  ┌──────────────────────────────┐   │
                │  │ marketplace/                 │   │
                │  │   marketplace.json           │   │  ← source of truth
                │  │   CONTRIBUTING.md            │   │
                │  │   .github/workflows/         │   │
                │  └──────────────────────────────┘   │
                │  ┌──────────────────────────────┐   │
                │  │ code-reviewer/               │   │  ← seed package
                │  │ security-auditor/            │   │
                │  │ ... (8 total)                │   │
                │  └──────────────────────────────┘   │
                └─────────────────────────────────────┘
                            │
                            │  hourly ISR fetch
                            ▼
        ┌───────────────────────────────────────────────────┐
        │  dorkos.dev (Vercel — Next.js 16 SSG + ISR)       │
        │                                                    │
        │  /marketplace            ← grid + filter + search │
        │  /marketplace/[slug]     ← detail + README + OG   │
        │  /marketplace/sitemap.xml                          │
        │                                                    │
        │  /api/telemetry/install  ← Edge Function          │
        │                            ↓ Vercel KV (counters) │
        │                            ↓ Neon Postgres (events) │
        └───────────────────────────────────────────────────┘
                            ↑
                            │  POST install events
                            │  (opt-in only)
                            │
        ┌───────────────────────────────────────────────────┐
        │  DorkOS client (local install)                     │
        │   reads telemetry consent from settings            │
        │   reports anonymous install events on success      │
        └───────────────────────────────────────────────────┘
```

### Registry Repo (`dorkos-community/marketplace`)

```
dorkos-community/marketplace/
├── marketplace.json                  # The registry index
├── README.md                         # Public-facing description
├── CONTRIBUTING.md                   # How to submit a package
├── CODE_OF_CONDUCT.md
├── LICENSE                           # MIT
└── .github/
    └── workflows/
        ├── validate-submission.yml   # Runs `dorkos package validate` on PRs
        └── publish-update.yml        # Notifies dorkos.dev when registry changes
```

**`marketplace.json`** (initial state):

```json
{
  "name": "dorkos-community",
  "description": "Official community marketplace for DorkOS — agents, plugins, skill packs, and adapters",
  "plugins": [
    {
      "name": "code-reviewer",
      "source": "https://github.com/dorkos-community/code-reviewer",
      "description": "Reviews your PRs every weekday morning, posts findings to Slack, files Linear issues for blockers",
      "type": "agent",
      "category": "code-quality",
      "tags": ["review", "pr", "ci"],
      "icon": "🔍",
      "featured": true
    },
    {
      "name": "security-auditor",
      "source": "https://github.com/dorkos-community/security-auditor",
      "description": "Weekly dependency vulnerability scans, secret detection, and license compliance audits",
      "type": "agent",
      "category": "security",
      "tags": ["audit", "security", "dependencies"],
      "icon": "🛡️",
      "featured": true
    },
    {
      "name": "docs-keeper",
      "source": "https://github.com/dorkos-community/docs-keeper",
      "description": "Watches code changes, suggests documentation updates, keeps READMEs in sync with reality",
      "type": "agent",
      "category": "documentation",
      "tags": ["docs", "maintenance"],
      "icon": "📚",
      "featured": true
    },
    {
      "name": "linear-integration",
      "source": "https://github.com/dorkos-community/linear-integration",
      "description": "Linear status dashboard extension and webhook adapter for issue notifications",
      "type": "plugin",
      "category": "integration",
      "tags": ["linear", "issues"],
      "layers": ["extensions", "adapters"],
      "icon": "📋"
    },
    {
      "name": "posthog-monitor",
      "source": "https://github.com/dorkos-community/posthog-monitor",
      "description": "PostHog dashboard widget and error alerting for your DorkOS sidebar",
      "type": "plugin",
      "category": "observability",
      "tags": ["analytics", "monitoring", "errors"],
      "layers": ["extensions", "tasks"],
      "icon": "📊"
    },
    {
      "name": "security-audit-pack",
      "source": "https://github.com/dorkos-community/security-audit-pack",
      "description": "Scheduled security audit tasks: dependency scanning, secret detection, license checks",
      "type": "skill-pack",
      "category": "security",
      "tags": ["audit", "tasks"],
      "layers": ["tasks"],
      "icon": "🔐"
    },
    {
      "name": "release-pack",
      "source": "https://github.com/dorkos-community/release-pack",
      "description": "Tasks for version bumping, changelog generation, and git tagging",
      "type": "skill-pack",
      "category": "release",
      "tags": ["release", "versioning", "changelog"],
      "layers": ["tasks", "skills"],
      "icon": "🚀"
    },
    {
      "name": "discord-adapter",
      "source": "https://github.com/dorkos-community/discord-adapter",
      "description": "Discord relay adapter — bridge agent messages to Discord channels and DMs",
      "type": "adapter",
      "category": "messaging",
      "tags": ["discord", "chat"],
      "layers": ["adapters"],
      "icon": "💬"
    }
  ]
}
```

### Seed Package Contents

Each seed package is its own git repo with:

- `README.md` — Description, install instructions, screenshots
- `LICENSE` — MIT
- `.dork/manifest.json` — DorkOS package manifest (validated by spec 01 schemas)
- `.claude-plugin/plugin.json` — Claude Code compatibility (except agent packages)
- Type-specific content (skills/, tasks/, extensions/, adapters/, etc.)

A separate engineering effort builds these — this spec defines the contract and the initial set, the actual content development happens in parallel branches by the seed team. Each package must pass `dorkos package validate` before being added to `marketplace.json`.

### Web Pages

#### `/marketplace` — Browse Page

```
apps/site/src/app/marketplace/
├── page.tsx                     # Main browse page (SSG + ISR)
├── opengraph-image.tsx          # OG image for the page
├── layout.tsx                   # Marketplace layout wrapper
└── [slug]/
    ├── page.tsx                 # Detail page
    ├── opengraph-image.tsx      # Per-package OG image
    └── README.tsx               # README rendering component
```

`page.tsx`:

```tsx
import { fetchMarketplaceJson } from '@/layers/features/marketplace/lib/fetch';
import { rankPackages } from '@/layers/features/marketplace/lib/ranking';
import { MarketplaceGrid } from '@/layers/features/marketplace/ui/MarketplaceGrid';

export const revalidate = 3600; // Hourly ISR

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: { type?: string; category?: string; q?: string };
}) {
  const params = await searchParams;
  const marketplace = await fetchMarketplaceJson();
  const installCounts = await fetchInstallCounts(); // From KV
  const ranked = rankPackages(marketplace.plugins, installCounts, params);

  return (
    <main>
      <MarketplaceHeader />
      <FeaturedAgentsRail packages={ranked.filter((p) => p.featured && p.type === 'agent')} />
      <MarketplaceGrid packages={ranked} initialFilters={params} />
    </main>
  );
}
```

`/marketplace/[slug]/page.tsx`:

```tsx
export const revalidate = 3600;

export async function generateStaticParams() {
  const marketplace = await fetchMarketplaceJson();
  return marketplace.plugins.map((p) => ({ slug: p.name }));
}

export default async function PackageDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const marketplace = await fetchMarketplaceJson();
  const pkg = marketplace.plugins.find((p) => p.name === slug);
  if (!pkg) notFound();

  const readme = await fetchPackageReadme(pkg.source);
  const installCount = await fetchInstallCount(slug);

  return (
    <article>
      <PackageHeader package={pkg} installCount={installCount} />
      <PermissionPreviewServer package={pkg} />
      <PackageReadme markdown={readme} />
      <InstallInstructions package={pkg} />
      <RelatedPackages currentName={pkg.name} />
    </article>
  );
}
```

#### Fetching the Registry

```typescript
// apps/site/src/layers/features/marketplace/lib/fetch.ts
import { parseMarketplaceJson } from '@dorkos/marketplace/marketplace-json-parser';

const REGISTRY_URL =
  'https://raw.githubusercontent.com/dorkos-community/marketplace/main/marketplace.json';

export async function fetchMarketplaceJson(): Promise<MarketplaceJson> {
  const res = await fetch(REGISTRY_URL, { next: { revalidate: 3600 } });
  if (!res.ok) throw new Error(`Failed to fetch registry: ${res.status}`);
  const text = await res.text();
  const result = parseMarketplaceJson(text);
  if (!result.ok) throw new Error(result.error);
  return result.marketplace;
}

export async function fetchPackageReadme(sourceUrl: string): Promise<string> {
  // Convert github URL to raw URL, fetch README.md, fall back to empty string
  // Cache with same TTL as registry
}
```

### Telemetry Endpoint

```typescript
// apps/site/src/app/api/telemetry/install/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { z } from 'zod';

export const runtime = 'edge';

// Reads UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN from env
const redis = Redis.fromEnv();

const InstallEventSchema = z.object({
  packageName: z.string().min(1).max(64),
  marketplace: z.string().min(1).max(64),
  type: z.enum(['agent', 'plugin', 'skill-pack', 'adapter']),
  outcome: z.enum(['success', 'failure', 'cancelled']),
  durationMs: z.number().int().min(0).max(600000),
  errorCode: z.string().max(64).optional(),
  // Anonymized installation ID (random per-install, not per-user)
  installId: z.string().uuid(),
  // DorkOS version (for compatibility analytics)
  dorkosVersion: z.string().max(32),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = InstallEventSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid event' }, { status: 400 });
  }

  const event = parsed.data;

  // Increment Upstash Redis counter for ranking
  if (event.outcome === 'success') {
    await redis.incr(`marketplace:install_count:${event.marketplace}:${event.packageName}`);
  }

  // Persist event to Neon Postgres (async via queue, non-blocking response)
  // (implemented via Vercel Queues for durability)
  await fetch(process.env.TELEMETRY_QUEUE_URL!, {
    method: 'POST',
    body: JSON.stringify(event),
  });

  return NextResponse.json({ ok: true });
}
```

The `fetchInstallCounts()` and `fetchInstallCount()` helpers used by the marketplace pages also use `@upstash/redis`:

```typescript
// apps/site/src/layers/features/marketplace/lib/telemetry.ts
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export async function fetchInstallCount(packageName: string): Promise<number> {
  const count = await redis.get<number>(
    `marketplace:install_count:dorkos-community:${packageName}`
  );
  return count ?? 0;
}

export async function fetchInstallCounts(): Promise<Record<string, number>> {
  const keys = await redis.keys('marketplace:install_count:dorkos-community:*');
  if (keys.length === 0) return {};
  const values = await redis.mget<number[]>(...keys);
  return Object.fromEntries(
    keys.map((key, i) => [
      key.replace('marketplace:install_count:dorkos-community:', ''),
      values[i] ?? 0,
    ])
  );
}
```

**Privacy guarantees** (documented in `CONTRIBUTING.md` and a public `/marketplace/privacy` page):

- No IP addresses logged
- No user identifiers — only random per-install UUIDs
- No package contents transmitted
- Opt-in: disabled by default in DorkOS settings
- Aggregate counts only displayed publicly
- Full event data accessible only to DorkOS team for debugging

### Ranking Function

```typescript
// apps/site/src/layers/features/marketplace/lib/ranking.ts
export function rankPackages(
  packages: MarketplaceJsonEntry[],
  installCounts: Record<string, number>,
  filters: { type?: string; category?: string; q?: string }
): MarketplaceJsonEntry[] {
  // Filter by type/category/search
  let filtered = packages;
  if (filters.type) filtered = filtered.filter((p) => p.type === filters.type);
  if (filters.category) filtered = filtered.filter((p) => p.category === filters.category);
  if (filters.q) {
    const q = filters.q.toLowerCase();
    filtered = filtered.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q) ||
        (p.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  }

  // Score: featured (weight 100) + log(install_count) + recency boost
  return filtered
    .map((p) => ({
      ...p,
      score: (p.featured ? 100 : 0) + Math.log(Math.max(1, installCounts[p.name] ?? 0)) * 10,
    }))
    .sort((a, b) => b.score - a.score);
}
```

### OG Image Generation

```typescript
// apps/site/src/app/marketplace/[slug]/opengraph-image.tsx
import { ImageResponse } from 'next/og';
import { fetchMarketplaceJson } from '@/layers/features/marketplace/lib/fetch';

export const runtime = 'edge';
export const size = { width: 1200, height: 630 };

export default async function PackageOgImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const marketplace = await fetchMarketplaceJson();
  const pkg = marketplace.plugins.find(p => p.name === slug);
  if (!pkg) return null;

  return new ImageResponse(
    <div tw="flex flex-col items-center justify-center w-full h-full bg-zinc-950 text-white p-16">
      <div tw="flex items-center gap-4 mb-8">
        <span tw="text-7xl">{pkg.icon ?? '📦'}</span>
        <span tw="text-3xl text-zinc-400">{(pkg.type ?? 'plugin').toUpperCase()}</span>
      </div>
      <h1 tw="text-6xl font-bold mb-4">{pkg.name}</h1>
      <p tw="text-2xl text-zinc-300 max-w-3xl text-center">{pkg.description ?? ''}</p>
      <div tw="absolute bottom-12 right-12 text-xl text-zinc-500">dorkos.dev/marketplace</div>
    </div>,
    { ...size }
  );
}
```

### Sitemap & llms.txt

Update `apps/site/src/app/sitemap.ts` to include marketplace URLs:

```typescript
const marketplace = await fetchMarketplaceJson();
const marketplaceUrls = [
  { url: 'https://dorkos.dev/marketplace', priority: 0.9, changeFrequency: 'daily' },
  ...marketplace.plugins.map((p) => ({
    url: `https://dorkos.dev/marketplace/${p.name}`,
    priority: 0.7,
    changeFrequency: 'weekly' as const,
  })),
];
```

Update `apps/site/src/app/llms.txt/route.ts` to add a Marketplace section listing all packages.

### Submission Flow

`dorkos-community/marketplace/CONTRIBUTING.md`:

```markdown
# Submitting a Package to the DorkOS Marketplace

## Quick Start

1. Build your package using `dorkos package init <name> --type <type>`
2. Develop, test locally with `dorkos package validate`
3. Push your package to a public GitHub repo
4. Open a PR to this repo adding your package to `marketplace.json`

## Submission Checklist

- [ ] Package builds and validates with `dorkos package validate`
- [ ] README explains what the package does and any required setup
- [ ] LICENSE file present (MIT, Apache-2.0, or compatible)
- [ ] No hardcoded secrets or credentials
- [ ] External hosts declared in `.dork/manifest.json`
- [ ] If type is `plugin`, includes `.claude-plugin/plugin.json`

## PR Format

Add your package to the `plugins` array in `marketplace.json`, alphabetically ordered:

\`\`\`json
{
"name": "your-package-name",
"source": "https://github.com/your-username/your-package",
"description": "What it does in one sentence",
"type": "plugin",
"category": "your-category",
"tags": ["relevant", "tags"],
"icon": "📦"
}
\`\`\`

The `featured` field is set by maintainers, not contributors.

## Validation

Our GitHub Actions workflow runs `dorkos package validate` on every submission.
PRs failing validation cannot be merged.

## Review

A maintainer will review your submission within 7 days. We check:

- Package quality and usefulness
- Code safety (no obvious malware or supply chain risks)
- Description accuracy
- Category appropriateness
```

`.github/workflows/validate-submission.yml`:

```yaml
name: Validate Submission
on:
  pull_request:
    paths:
      - 'marketplace.json'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - name: Install dorkos CLI
        run: pnpm install -g dorkos
      - name: Validate marketplace.json
        run: dorkos package validate-marketplace marketplace.json
      - name: Validate each new package
        run: |
          for pkg in $(jq -r '.plugins[].source' marketplace.json); do
            dorkos package validate-remote "$pkg"
          done
```

(`dorkos package validate-marketplace` and `validate-remote` are added in this spec to the `packages/cli`.)

### Client-Side Telemetry Wiring

Spec 02 included a `registerTelemetryReporter` hook. This spec implements the reporter inside the DorkOS server:

```typescript
// apps/server/src/services/marketplace/telemetry-reporter.ts
import { reportInstallEvent } from './telemetry-hook.js';

export function registerDorkosCommunityTelemetry(consent: boolean) {
  if (!consent) return;

  registerTelemetryReporter(async (event) => {
    await fetch('https://dorkos.dev/api/telemetry/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...event,
        installId: getOrCreateInstallId(),
        dorkosVersion: getCurrentVersion(),
      }),
    });
  });
}
```

A new setting in DorkOS config enables/disables telemetry. Defaults to **off**. The Marketplace Extension UI (spec 03) should show the consent toggle prominently.

---

## Implementation Phases

### Phase 1 — GitHub Org & Registry Repo Setup

- Create `dorkos-community` GitHub org
- Create `marketplace` repo with `marketplace.json`, `README.md`, `CONTRIBUTING.md`, workflows
- Set up branch protection, CODEOWNERS

### Phase 2 — Seed Package Repos

- Create 8 package repos under `dorkos-community/`
- Each repo built and validated separately (parallel work)
- Add each to `marketplace.json` after passing validation

### Phase 3 — Web Marketplace Pages

- `apps/site/src/app/marketplace/page.tsx`
- `apps/site/src/app/marketplace/[slug]/page.tsx`
- `apps/site/src/layers/features/marketplace/lib/fetch.ts`
- `apps/site/src/layers/features/marketplace/lib/ranking.ts`
- `apps/site/src/layers/features/marketplace/ui/*` (mirror existing feature catalog component patterns)

### Phase 4 — OG Images & SEO

- `opengraph-image.tsx` for browse + detail pages
- Sitemap updates
- llms.txt updates
- robots.txt sanity check

### Phase 5 — Telemetry Endpoint

- Add Vercel KV via marketplace integration
- Add Neon Postgres via marketplace integration
- `apps/site/src/app/api/telemetry/install/route.ts`
- `/marketplace/privacy` page documenting telemetry

### Phase 6 — Client Telemetry Wiring

- Implement `registerDorkosCommunityTelemetry` in server
- Add config setting `telemetry.enabled` (default false)
- Wire into existing config system
- DorkOS client respects setting

### Phase 7 — Submission Validation

- Add `dorkos package validate-marketplace` and `validate-remote` CLI commands to `packages/cli`
- GitHub Actions workflow tested against fixture submissions

### Phase 8 — Documentation & Launch

- Add marketplace pages to navigation
- Write announcement blog post (separate effort)
- Update CLAUDE.md, CHANGELOG

---

## Testing Strategy

### Web Page Tests

- Unit tests for `ranking.ts`, `fetch.ts`
- Component tests for `MarketplaceGrid`, `PackageCard`, `PackageHeader`
- Playwright E2E tests for browse → detail → install instructions flow

### Telemetry Endpoint Tests

- Unit tests for the Edge Function (input validation, error paths)
- Integration tests with KV mocked
- Privacy: assert no PII in stored events

### Registry Repo Tests

- GitHub Actions workflow runs on every PR (live test)
- Fixture submissions verify validation works

### Package Validation Tests

- Each seed package's repo includes its own validation in CI

---

## File Structure

### New (apps/site)

```
apps/site/src/app/marketplace/
├── page.tsx
├── opengraph-image.tsx
├── layout.tsx
├── privacy/
│   └── page.tsx
└── [slug]/
    ├── page.tsx
    └── opengraph-image.tsx

apps/site/src/app/api/telemetry/install/
└── route.ts

apps/site/src/layers/features/marketplace/
├── lib/
│   ├── fetch.ts
│   ├── ranking.ts
│   └── format-permissions.ts
├── ui/
│   ├── MarketplaceHeader.tsx
│   ├── FeaturedAgentsRail.tsx
│   ├── MarketplaceGrid.tsx
│   ├── PackageCard.tsx
│   ├── PackageHeader.tsx
│   ├── PermissionPreviewServer.tsx
│   ├── PackageReadme.tsx
│   ├── InstallInstructions.tsx
│   └── RelatedPackages.tsx
└── index.ts
```

### New (DorkOS server)

```
apps/server/src/services/marketplace/
└── telemetry-reporter.ts
```

### New CLI commands

```
packages/cli/src/commands/
├── package-validate-marketplace.ts
└── package-validate-remote.ts
```

### Modified (apps/site)

```
apps/site/src/app/sitemap.ts            # Add marketplace URLs
apps/site/src/app/llms.txt/route.ts     # Add marketplace section
apps/site/package.json                  # Add @upstash/redis, @neondatabase/serverless
```

### New (out of repo)

```
github.com/dorkos-community/marketplace/
github.com/dorkos-community/code-reviewer/
github.com/dorkos-community/security-auditor/
github.com/dorkos-community/docs-keeper/
github.com/dorkos-community/linear-integration/
github.com/dorkos-community/posthog-monitor/
github.com/dorkos-community/security-audit-pack/
github.com/dorkos-community/release-pack/
github.com/dorkos-community/discord-adapter/
```

---

## Acceptance Criteria

- [ ] `dorkos-community` GitHub org exists and is publicly browsable
- [ ] `marketplace.json` contains 8 seed packages, all validated
- [ ] All 8 seed package repos exist, each passing `dorkos package validate`
- [ ] `/marketplace` page renders on dorkos.dev with all packages
- [ ] `/marketplace/[slug]` works for every package
- [ ] OG images render correctly (visual check)
- [ ] Sitemap includes all marketplace URLs
- [ ] llms.txt includes marketplace section
- [ ] Telemetry endpoint accepts events from DorkOS client
- [ ] Telemetry stores counts in KV and events in Postgres
- [ ] Privacy page documents the telemetry contract
- [ ] DorkOS client telemetry setting is opt-in (default false)
- [ ] Submission GitHub Actions workflow runs on PRs
- [ ] Ranking function returns sorted packages
- [ ] Lighthouse: marketplace page LCP < 2.5s, accessibility 100
- [ ] All seed packages installable via `dorkos install` and via Dork Hub UI

---

## Risks & Mitigations

| Risk                                                         | Severity | Mitigation                                                                                  |
| ------------------------------------------------------------ | :------: | ------------------------------------------------------------------------------------------- |
| Seed packages of insufficient quality → bad first impression |   High   | Each seed package goes through internal review before marketplace.json submission           |
| Telemetry seen as privacy-invasive                           |  Medium  | Opt-in default. Public privacy page. No PII collected. UUID per install (not per user)      |
| GitHub Actions validation has false positives                |  Medium  | Test against fixture submissions before launch. Allow override with maintainer approval     |
| Web pages lag behind registry updates                        |   Low    | 1-hour ISR with on-demand revalidation via webhook on `marketplace.json` push               |
| Vercel KV / Postgres pricing scales unfavorably              |  Medium  | Monitor usage. Aggregate to daily counts after 30 days. Move to PostHog if cheaper at scale |
| Submission spam / low-quality PRs                            |  Medium  | Manual review SLA + GitHub Actions auto-validation + branch protection                      |
| Featured curation perceived as biased                        |   Low    | Document featured criteria publicly. Rotate featured agents monthly                         |

---

## Out of Scope (Deferred)

| Item                                 | Spec |
| ------------------------------------ | ---- |
| MCP server                           | 05   |
| Personal marketplace publishing      | 05   |
| Self-serve registry (no PR required) | v2   |
| User accounts on dorkos.dev          | v2   |
| Reviews / ratings                    | v2   |
| Live preview                         | v2   |
| Sigstore signing                     | v2   |
| Payment processing                   | v2   |
| Recommendation engine                | v2   |

---

## Changelog

### 2026-04-06 — Initial specification

Created from `/ideate-to-spec specs/dorkos-marketplace/01-ideation.md` (batched generation).

This is spec 4 of 5 for the DorkOS Marketplace project.
