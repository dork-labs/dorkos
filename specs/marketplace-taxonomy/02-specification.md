---
slug: marketplace-taxonomy
id: 260718-043238
created: 2026-07-17
status: specified
provenance: { tracker: linear, issue: DOR-356 }
---

# Marketplace Category Taxonomy

**Status:** Draft
**Author:** spec-taxonomy agent (DorkOS Shapes program, W3)
**Date:** 2026-07-17
**Tracker:** DOR-356

## Overview

Give the DorkOS marketplace a **controlled category vocabulary** — a closed, CI-checked list of 16 slugs — and the end-to-end plumbing that makes it discoverable: multi-membership `categories[]` on packages carried through the ADR-0236 sidecar, validator + scaffolder support, client facet chips wired to the already-reserved `?category=` URL param, per-category SEO landing pages on the marketing site, category-aware `marketplace_search` / `marketplace_recommend` MCP tools, and a mechanical backfill for the `dork-labs/marketplace` registry.

The singular `category` field is **retained** as the Claude-Code-interop field and the package's **primary** category (`categories[0]`), and it **stays a lenient string** — never the enum — so already-installed packages with legacy free-string categories keep parsing (see §B2's harness-consumer note). The new plural `categories[]` is the DorkOS multi-membership signal, is enum-typed, and lives only in the sidecar (never inline in `marketplace.json`, which would break `claude plugin validate`).

## Background / Problem Statement

Today the registry uses **free-string** singular `category` values with no controlled vocabulary and no sidecar (`packages/marketplace/src/marketplace-json-schema.ts:216`, `manifest-schema.ts:98`). The cached `dork-labs/marketplace` registry has 11 packages spread across nine ad-hoc strings (`code-quality`, `security`, `documentation`, `integration`, `observability`, `release`, `development`, `productivity`, `workflow` — see ideation §5). Three consequences:

1. **No SEO surface.** The Shapes program (`plans/shapes-program.md`, success criterion 4) needs "≥6 category SEO routes with zero unverified claims." Static generation needs a **closed** set of slugs.
2. **No multi-membership.** `linear-integration` is both project-management and an integration; `flow` is both agent-ops and project-management. A scalar `category` forces a wrong single choice.
3. **No shared vocabulary.** Client facet chips, site routes, and MCP filters each need to agree on the same slugs; free strings drift.

The founder decided (2026-07-17, DOR-368) on **`categories[]` (multi) via the ADR-0236 sidecar**. This spec implements exactly that.

## Goals

- A **closed** 16-slug category vocabulary in code (a Zod enum), CI-checked so an off-list `categories[]` entry fails validation.
- `categories[]` multi-membership on packages via the ADR-0236 sidecar (`.claude-plugin/dorkos.json`), plus in the author-source `.dork/manifest.json`.
- Singular `category` preserved as CC-interop + primary-category fallback, with a validator coherence rule (`category === categories[0]` when both present).
- Client facet chips wiring the reserved `?category=` param; a clear empty state for a zero-result category.
- A `/marketplace/category/[slug]` SEO route cloned from the `features/category/[category]` template — metadata, OG, JSON-LD, honest copy under the demo-claim gate.
- Category-aware `marketplace_search` (membership filter) and `marketplace_recommend` (membership filter + boost), both taught to merge the sidecar.
- A mechanical, listable backfill plan for `dork-labs/marketplace`.

## Non-Goals

- No category **hierarchy** / sub-categories (flat list only).
- No ML relevance — filtering/boosting are exact-slug set operations (mirrors the `recommend-engine` v1 non-goal).
- No redesign of `tags[]` / `keywords[]` (they stay; categories are a distinct, closed axis).
- No category-management admin UI; the vocabulary ships in code and changes via PR + migration.
- No change to Claude Code's marketplace format; no tightening of the inbound-lenient `marketplace.json` parser (a foreign CC marketplace with any `category` string must still parse).
- No Act-2 marketing of the business-seed categories (they exist as vocabulary; no shape claims them yet — the demo-claim gate holds).

## Assumptions

Restated from ideation §1, updated for the harness-consumer finding:

1. **Multi-membership with a primary.** A package belongs to one or more categories; the singular `category` remains the primary category (`categories[0]`) and the Claude-Code-interop field.
2. **The enum binds `categories[]` only.** The closed list constrains the `categories[]` field (sidecar + `.dork/manifest.json`) and the CI vocabulary check on our own registry. It never constrains the inbound `marketplace.json` parser (foreign CC marketplaces may carry any `category` string — the ADR-0236 inbound invariant), and it never constrains the singular `category` field, which stays a lenient `z.string()`: `packages/harness/src/sources/installed.ts:117` safeParses installed packages' on-disk manifests and returns `undefined` on failure, so an enum there would make legacy-categorized installed packages invisible to Harness projection (the DOR-264 regression class). The coherence refine (`category === categories[0]`, with `categories[0]` enum-typed) is the effective constraint for newly-authored packages.
3. **Keyword/no-ML v1.** Category filtering and boosting are exact-slug set operations, consistent with the existing `recommend-engine` non-goal.
4. **External backfill.** The `dork-labs/marketplace` registry backfill executes in that repo; this spec ships the mechanical map + checklist (§H) so it is a listable mechanical change, not research.

## Technical Dependencies

- `zod` (already used throughout `packages/marketplace`).
- `@dorkos/marketplace` browser-safe barrel (`packages/marketplace/src/index.ts`).
- Next.js 16 App Router static generation (site), matching the `features/category/[category]` template.
- No new runtime dependencies.

## Detailed Design

### A. The controlled vocabulary — `packages/marketplace/src/categories.ts` (new)

Browser-safe (`zod` only, no Node), mirroring `package-types.ts`. Single source of truth.

```typescript
import { z } from 'zod';

/**
 * Closed, ordered marketplace category vocabulary (v1). The order is
 * meaningful — it is the canonical display order for facet chips, SEO
 * `generateStaticParams`, and dropdowns. Adding, removing, or renaming a
 * slug is a breaking taxonomy change: bump nothing here, but ship a backfill
 * migration for the registry (see the spec's Registry Backfill section).
 */
export const MARKETPLACE_CATEGORIES = [
  // Act 1 — dev-facing
  'code-review',
  'security',
  'release-ops',
  'observability',
  'documentation',
  'agent-ops',
  'project-management',
  'dev-tools',
  // Cross-cutting
  'integrations',
  'productivity',
  // Act 2 — business seeds
  'marketing',
  'sales-crm',
  'content',
  'support',
  'accounting',
  'research',
] as const;

/** A single controlled category slug. */
export const MarketplaceCategorySchema = z.enum(MARKETPLACE_CATEGORIES);

/** A controlled category slug (`'code-review' | 'security' | …`). */
export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number];

/** Human display label for each category. Exhaustive over the enum. */
export const CATEGORY_LABELS: Record<MarketplaceCategory, string> = {
  'code-review': 'Code Review',
  security: 'Security',
  'release-ops': 'Release Ops',
  observability: 'Observability',
  documentation: 'Documentation',
  'agent-ops': 'Agent Ops',
  'project-management': 'Project Management',
  'dev-tools': 'Developer Tools',
  integrations: 'Integrations',
  productivity: 'Productivity',
  marketing: 'Marketing',
  'sales-crm': 'Sales & CRM',
  content: 'Content',
  support: 'Support',
  accounting: 'Accounting',
  research: 'Research',
};

/**
 * One-line, honest description per category — used as the SEO route's meta
 * description seed and the facet-chip tooltip. Plain language, no hype, no
 * unverified capability claims (demo-claim gate). Exhaustive over the enum.
 */
export const CATEGORY_DESCRIPTIONS: Record<MarketplaceCategory, string> = {
  'code-review': 'Agents and packages that review code and pull requests.',
  security: 'Security auditing, dependency and configuration checks.',
  'release-ops': 'Release, versioning, and deploy workflows.',
  observability: 'Monitoring, analytics, and run tracking.',
  documentation: 'Keeping docs in sync with your code.',
  'agent-ops': 'Orchestrating, scheduling, and coordinating agents.',
  'project-management': 'Issue tracking, boards, and planning.',
  'dev-tools': 'Tooling for building on and extending DorkOS.',
  integrations: 'Connectors and adapters for outside services.',
  productivity: 'Personal planning and knowledge work.',
  marketing: 'Content marketing, campaigns, and outreach.',
  'sales-crm': 'Contacts, pipeline, and follow-ups.',
  content: 'Drafting, editing, and publishing content.',
  support: 'Customer support and help workflows.',
  accounting: 'Bookkeeping, invoicing, and finance.',
  research: 'Gathering, summarizing, and analyzing information.',
};

/**
 * Derive a package's primary category from its multi-membership list and its
 * legacy singular field. `categories[0]` wins; the singular `category` is the
 * back-compat fallback for packages that predate `categories[]`.
 *
 * @param categories - The multi-membership list, if present.
 * @param category - The legacy singular category, if present.
 * @returns The primary category slug, or `undefined` when uncategorized.
 */
export function primaryCategory(
  categories: readonly string[] | undefined,
  category: string | undefined
): string | undefined {
  return categories?.[0] ?? category;
}

/** Narrow an arbitrary string to a controlled category (or `undefined`). */
export function asMarketplaceCategory(value: string): MarketplaceCategory | undefined {
  return (MARKETPLACE_CATEGORIES as readonly string[]).includes(value)
    ? (value as MarketplaceCategory)
    : undefined;
}
```

Barrel export from `packages/marketplace/src/index.ts`:

```typescript
export {
  MARKETPLACE_CATEGORIES,
  MarketplaceCategorySchema,
  CATEGORY_LABELS,
  CATEGORY_DESCRIPTIONS,
  primaryCategory,
  asMarketplaceCategory,
  type MarketplaceCategory,
} from './categories.js';
```

**Exhaustiveness is compile-time-enforced:** `CATEGORY_LABELS` / `CATEGORY_DESCRIPTIONS` are typed `Record<MarketplaceCategory, string>`, so omitting or misspelling a slug is a TypeScript error. A unit test additionally asserts runtime key-set equality.

### B. Schema changes

**B1 — Sidecar (`packages/marketplace/src/dorkos-sidecar-schema.ts`).** Add `categories` to `DorkosEntrySchema` (the ADR-0236 home):

```typescript
import { MarketplaceCategorySchema } from './categories.js';

// inside DorkosEntrySchema:
  /**
   * Controlled multi-membership categories (ADR-0236 sidecar field; not
   * CC-native — Claude Code's strict validator would reject a plural
   * `categories` key inline, so it rides the sidecar). Deduplicated,
   * max 4 to keep browse facets meaningful. The first element is the
   * package's primary category and SHOULD equal the CC-inline singular
   * `category` (validator enforces coherence).
   */
  categories: z
    .array(MarketplaceCategorySchema)
    .max(4)
    .refine((c) => new Set(c).size === c.length, 'categories must be unique')
    .optional(),
```

**B2 — Author manifest (`packages/marketplace/src/manifest-schema.ts`).** On `BasePackageManifestSchema`: add the same enum-typed `categories` field, and **keep the singular `category` lenient** (`z.string().max(64)` — exactly as it is today at line 98; do **not** tighten it to the enum). Add a top-level cross-field refine for coherence:

```typescript
// line 98 stays LENIENT — do NOT replace it with the enum (see the harness note below):
  /**
   * Primary category. Kept CC-interop and deliberately LENIENT (`z.string()`,
   * not the enum): installed packages' on-disk manifests may carry legacy
   * free-string categories, and the harness safeParses them (see below).
   * Coherence with the enum-typed `categories[0]` provides the effective
   * constraint for newly-authored packages.
   */
  category: z.string().max(64).optional(),
  /** Controlled multi-membership categories (ADR-0236). Dedup, max 4. */
  categories: z
    .array(MarketplaceCategorySchema)
    .max(4)
    .refine((c) => new Set(c).size === c.length, 'categories must be unique')
    .optional(),
```

**Why `category` stays lenient (blast-radius consumer):** `packages/harness/src/sources/installed.ts:117` (`readPluginManifest`) runs `MarketplacePackageManifestSchema.safeParse` over every installed package's on-disk `.dork/manifest.json` during Harness projection and **returns `undefined` on failure** — a failed parse makes the package invisible and Harness Sync silently projects zero files (exactly the DOR-264 class that function's own docstring records). Manifests installed before this spec carry free-string categories (`workflow`, `code-quality`, …), so an enum on the singular field would break every one of them on upgrade. The closed vocabulary is enforced where it is _new_: the enum-typed `categories[]`, the coherence refine below (`category === categories[0]` forces the primary onto the enum whenever `categories` is present), the scaffolder (§D2), and the registry CI gate (§H).

The coherence refine must sit **outside** the discriminated union (Zod cannot `.refine` a `discriminatedUnion` member and keep the discriminator). Wrap the union:

```typescript
/** category === categories[0] when both present (primary-category coherence). */
export const MarketplacePackageManifestSchema = z
  .discriminatedUnion('type', [
    PluginManifestSchema,
    AgentManifestSchema,
    SkillPackManifestSchema,
    AdapterManifestSchema,
  ])
  .refine((m) => !(m.category && m.categories?.length) || m.category === m.categories[0], {
    message: 'category must equal categories[0] when both are present',
    path: ['category'],
  });
```

`MarketplacePackageManifest` (the inferred type) is unaffected — `.refine` on a discriminated union preserves the union type.

**B3 — Registry entry + CC validator: unchanged.** `MarketplaceJsonEntrySchema.category` (`marketplace-json-schema.ts:216`) and `CcMarketplaceJsonEntrySchema.category` (`cc-validator.ts:104`) **stay `z.string().max(64)`**. This is load-bearing: the inbound-lenient parser must accept foreign CC marketplaces with any `category` string (ADR-0236 inbound invariant). The controlled enum is enforced on our own registry by the CI check (§D), not by the inbound parser.

**B4 — Wire type (`packages/shared/src/marketplace-schemas.ts`).** Add to `AggregatedPackage` (after line 66):

```typescript
  /** DorkOS extension: controlled multi-membership categories (ADR-0236 sidecar). */
  categories?: string[];
```

Typed `string[]` (not the enum) because `AggregatedPackage` is a browser-safe wire shape that must not import the schema; consumers narrow via `asMarketplaceCategory` where needed.

### C. Merge / flatten — surfacing `categories[]`

**C1 — Server (`apps/server/src/routes/marketplace.ts` `flattenMergedEntry`, line 719).** Add:

```typescript
    categories: entry.dorkos?.categories,
    // primary category prefers categories[0], falls back to the CC-inline singular:
    category: primaryCategory(entry.dorkos?.categories, entry.category),
```

`entry.category` comes from `marketplace.json`; `entry.dorkos?.categories` from the sidecar. Keeping `category = primaryCategory(...)` means existing single-category consumers (client filter, site ranking) keep working unchanged even before they learn `categories[]`.

**C2 — Site ranking (`apps/site/.../marketplace/lib/ranking.ts`, line 47).** Change the category filter to membership, with singular fallback:

```typescript
if (filters.category) {
  const wanted = filters.category;
  filtered = filtered.filter(
    (p) => p.dorkos?.categories?.includes(wanted) ?? p.category === wanted
  );
}
```

### D. Validator + scaffolder + CI

**D1 — Validator (`packages/marketplace/src/package-validator.ts`).** No new branch is needed for the _hard_ case: an off-list entry inside `categories[]` or an incoherent `category`/`categories[0]` pair now fails `MarketplacePackageManifestSchema.safeParse` and is surfaced as the existing `MANIFEST_SCHEMA_INVALID` error (lines 165-176). A legacy free-string **singular** `category` deliberately still parses (§B2 — the singular field is lenient). Add **one advisory warning** for the soft case — a package with no categories at all:

```typescript
if (!manifest.category && !manifest.categories?.length) {
  issues.push({
    level: 'warning',
    code: 'CATEGORY_MISSING',
    message: 'Package declares no category — it will browse as "Uncategorized".',
  });
}
```

**D2 — Scaffolder (`packages/marketplace/src/scaffolder.ts`).** Extend `CreatePackageOptions` with an optional `categories?: MarketplaceCategory[]`; write them into the starter manifest (and set `category = categories[0]` for coherence). When omitted, write `categories: []` so the author sees the field and the `CATEGORY_MISSING` warning nudges them:

```typescript
const baseManifest = {
  // …existing…
  tags: [],
  categories: opts.categories ?? [],
  ...(opts.categories?.length ? { category: opts.categories[0] } : {}),
  layers: defaultLayersForType(opts.type),
};
```

**D3 — CI vocabulary check (new `packages/marketplace/scripts/check-categories.ts`, run in `pnpm verify` via the marketplace package's test/lint step).** In _this_ repo the check is exhaustiveness + coherence over fixtures and the enum itself:

- `CATEGORY_LABELS` and `CATEGORY_DESCRIPTIONS` key-sets exactly equal `MARKETPLACE_CATEGORIES` (runtime assertion backing the compile-time `Record`).
- Every fixture manifest under `packages/marketplace/fixtures/**` and `apps/server/.../fixtures/**` parses (off-list categories would already fail).

The **registry** vocabulary gate (every `dork-labs/marketplace` package's `categories[]` ∈ the closed list, and `category === categories[0]`) runs in that repo's CI via the same exported `MarketplaceCategorySchema` — documented in the Registry Backfill section; it is not a check this repo can run against an external registry at build time.

### E. Client facet chips

`?category=` is already fully plumbed (`use-marketplace-params.ts` — `category`, `setCategory`, URL normalization). Two changes:

**E1 — Facet chips in `MarketplaceHeader.tsx`.** Below the type-filter tabs, render a wrap of category chips derived from `MARKETPLACE_CATEGORIES` + `CATEGORY_LABELS`, plus an "All" chip that clears. The active chip reads from `useMarketplaceParams().category`; clicking toggles via `setCategory(slug | null)`. Reuse the existing pill styling (`rounded-full`, `data-[state=active]:bg-primary`). Only surface chips for categories that have ≥1 package in the current list (avoid dead facets) — pass the visible package list (or a precomputed `Set<string>` of present categories) from the parent `Marketplace.tsx`. Accessibility: the chip row is a labelled group (`aria-label="Filter by category"`), each chip is a real `<button>` with `aria-pressed`.

**E2 — Membership filter (`lib/package-filter.ts`, line 67).** Match against `categories[]` with singular fallback:

```typescript
if (criteria.category !== null) {
  const inList = pkg.categories?.includes(criteria.category) ?? false;
  if (!inList && pkg.category !== criteria.category) return false;
}
```

**E3 — Empty state.** When a category filter yields zero packages, `PackageEmptyState.tsx` shows a category-specific message ("No packages in {label} yet") with a "Clear category" affordance that calls `setCategory(null)`. The existing empty-state component takes a message prop; thread the active category label through `Marketplace.tsx`.

### F. Site SEO route — `/marketplace/category/[slug]`

Clone the pattern of `apps/site/src/app/(marketing)/features/category/[category]/page.tsx` into `apps/site/src/app/(marketing)/marketplace/category/[category]/page.tsx`. Differences:

- **Source of truth:** `MARKETPLACE_CATEGORIES` + `CATEGORY_LABELS` + `CATEGORY_DESCRIPTIONS` from `@dorkos/marketplace` (not the site's marketing `CATEGORY_LABELS`, which is a different taxonomy).
- **`generateStaticParams()`** over `MARKETPLACE_CATEGORIES` → one static page per category (≥16, satisfying the "≥6 SEO routes" success criterion).
- **`generateMetadata()`**: `title: `${label} — DorkOS Marketplace``, `description` seeded from `CATEGORY_DESCRIPTIONS[slug]` + the in-category package names, OpenGraph (`url: /marketplace/category/${slug}`), `twitterFromOpenGraph`, `alternates.canonical`. Reuse `siteConfig`, `rssFeedAlternateTypes`, `twitterFromOpenGraph`from`@/lib/metadata`.
- **Data:** `fetchMarketplaceJson()` then `rankPackages(plugins, installCounts, { category: slug })` (the membership filter from C2). Render the existing `MarketplaceGrid` / `PackageCard` components.
- **JSON-LD:** BreadcrumbList (Home → Marketplace → {label}) + CollectionPage `hasPart` mapping each package to a `SoftwareApplication` — same shape as the features template.
- **`notFound()`** when `asMarketplaceCategory(slug)` is `undefined`.
- **Registry-down degradation:** mirror `marketplace/page.tsx` — if `fetchMarketplaceJson()` throws, render a "no packages yet" state (never a hard 500), keeping the route valid for SEO even before the sidecar backfill lands.
- **Demo-claim gate:** copy states only what a package _does_ per its own description; no claim that the category or any pillar "works." The generic subhead is "Browse {label} packages for DorkOS" — no capability assertions.

**F2 — OG image (optional, small):** clone `marketplace/opengraph-image.tsx` to `marketplace/category/[category]/opengraph-image.tsx` rendering the category label. If time-boxed out, the route inherits the marketplace default OG — acceptable.

**F3 — Category links from browse:** on `PackageCard` (site), render the primary category as a `<Link href={`/marketplace/category/${primaryCategory(...)}`}>` chip so the SEO routes are internally linked (crawlable) and the browse page cross-links to landing pages.

### G. MCP tools — category-awareness

**G1 — Merge the sidecar (both tools).** Today `collectEntries` (`tool-search.ts:104`) and the `tool-recommend` collector (`tool-recommend.ts:70`) iterate raw `json.plugins` and never fetch the sidecar, so no sidecar field is visible. Add a sidecar fetch + `mergeMarketplace` (the fetcher already exposes `fetchDorkosSidecar`, used by the HTTP route at `marketplace.ts:646`). Aggregate `MergedMarketplaceEntry` (with `dorkos?.categories`) instead of bare `MarketplaceJsonEntry`.

**G2 — `marketplace_search` (`tool-search.ts`).** Tighten the `category` input to `MarketplaceCategorySchema.optional()`; change the filter (line 142) to membership with singular fallback; add `categories` to the result payload (line 82):

```typescript
if (args.category) {
  const wanted = args.category;
  results = results.filter((r) => r.dorkos?.categories?.includes(wanted) ?? r.category === wanted);
}
// payload: … categories: r.dorkos?.categories, category: primaryCategory(r.dorkos?.categories, r.category),
```

**G3 — `marketplace_recommend` (`tool-recommend.ts` + `recommend-engine.ts`).** Add an optional `category` input (`MarketplaceCategorySchema.optional()`) that pre-filters by membership. Add a **category boost** to `scoreEntry`: when a context token equals a category slug or its label words, `+CATEGORY_MATCH_WEIGHT` (a new constant between tag and name weight, e.g. `7`) and a reason fragment. The engine takes `MergedMarketplaceEntry` so it can read `entry.dorkos?.categories`.

### H. Registry backfill — `dork-labs/marketplace` (external, mechanical)

Executed in the `dork-labs/marketplace` repo (not this one). Deliverable: a new `.claude-plugin/dorkos.json` sidecar plus canonicalized inline `category` values. The full map is the ideation §5 table. Mechanical steps:

1. Create `.claude-plugin/dorkos.json` (`schemaVersion: 1`, `plugins: { … }`) with a `categories[]` entry per package per the map.
2. Rewrite each inline `marketplace.json` `category` to the canonical primary slug (`categories[0]`): `code-quality→code-review`, `release→release-ops`, `development→dev-tools`, `workflow→agent-ops`, `integration→project-management`(for `linear-integration`) / `integrations`(for `discord-adapter`). Leave `security`, `documentation`, `observability`, `productivity` (already canonical).
3. Mirror `categories[]` and `category` into each package's own `.dork/manifest.json` (author source).
4. Run `dorkos package validate-marketplace` (uses the exported `MarketplaceCategorySchema`) — every entry must be in-vocabulary and coherent.

Backfill sidecar (illustrative, complete for all 12):

```json
{
  "schemaVersion": 1,
  "plugins": {
    "code-reviewer": { "categories": ["code-review"] },
    "security-auditor": { "categories": ["security"] },
    "security-audit-pack": { "categories": ["security"] },
    "docs-keeper": { "categories": ["documentation"] },
    "linear-integration": { "categories": ["project-management", "integrations"] },
    "discord-adapter": { "categories": ["integrations"] },
    "posthog-monitor": { "categories": ["observability"] },
    "release-pack": { "categories": ["release-ops"] },
    "marketplace-dev": { "categories": ["dev-tools"] },
    "lifeos-starter": { "categories": ["productivity"] },
    "flow": { "categories": ["agent-ops", "project-management"] }
  }
}
```

(11 packages — exhaustive over the live registry at spec time.)

## User Experience

- **Browse (client cockpit):** open `/marketplace` → a row of category chips sits under the type tabs. Click "Security" → the URL becomes `?category=security`, the grid narrows to security packages, the chip shows active. A shared link with `?category=security` reproduces the view. A category with no packages shows "No packages in Security yet — Clear category."
- **Discover (site):** a search engine indexes `/marketplace/category/security` → the page lists every security package with honest descriptions, breadcrumbs, and an install CTA. `PackageCard` chips link between landing pages.
- **Agents (MCP):** `marketplace_search({ category: "security" })` returns only security-member packages; `marketplace_recommend({ context: "audit my dependencies for CVEs" })` boosts security-category packages.
- **Authors:** `dorkos package init --categories security,code-review` scaffolds a manifest with `categories: ["security","code-review"]` and `category: "security"`; validation rejects an off-list slug with a clear message.

## Testing Strategy

- **Unit — vocabulary (`categories.ts`):** `CATEGORY_LABELS`/`CATEGORY_DESCRIPTIONS` key-sets equal `MARKETPLACE_CATEGORIES`; `primaryCategory` prefers `categories[0]`, falls back to `category`, returns `undefined` when both absent; `asMarketplaceCategory` narrows valid / rejects invalid.
- **Unit — schemas:** sidecar accepts `categories: ["security"]`, rejects `["not-a-cat"]` and duplicates; author manifest **accepts a legacy free-string singular-only `category`** (e.g. `"workflow"` — the harness regression guard, §B2), rejects an off-list entry inside `categories[]`, rejects `category !== categories[0]`, accepts coherent pairs and categories-only manifests.
- **Unit — flatten/merge:** `flattenMergedEntry` surfaces `entry.dorkos?.categories` and sets `category = categories[0]`; a package with only inline `category` (no sidecar) still yields `category` and `categories: undefined`.
- **Unit — client filter:** `filterPackages` matches a package whose `categories[]` includes the slug; matches a legacy singular-`category` package; excludes non-members.
- **Component — `MarketplaceHeader`:** chips render for present categories only; clicking sets/clears `?category=`; `aria-pressed` reflects state (jsdom + mock `Transport` per `.claude/rules/testing.md`).
- **Unit — site ranking:** membership filter + singular fallback.
- **Unit — MCP:** `applyFilters` (search) filters by membership; recommend applies the category boost and optional category filter; both read merged sidecar entries (stub fetcher returning a sidecar).
- **Route smoke — site:** `generateStaticParams` returns 16 slugs; an unknown slug → `notFound`; metadata title/canonical are correct for a sample category.

Each test carries a purpose comment; edge cases (duplicate categories, off-list slug, legacy singular-only, empty category) are covered, not just happy paths.

## Performance Considerations

Additive and negligible. `categories[]` is `max 4` per package. The MCP sidecar fetch adds one parallelizable request per source (the HTTP route already does this). Site routes are statically generated at build (one file per category), zero per-request cost. Client filtering is O(n) set membership over an already-loaded list.

## Security Considerations

No new trust surface. The controlled enum _shrinks_ the accepted input space for DorkOS-authored manifests. The inbound-lenient `marketplace.json` parser is deliberately unchanged, so no foreign marketplace can break parsing by supplying an unknown category. No user input reaches a filesystem path or shell.

## Documentation

- `contributing/marketplace-installs.md` (or the marketplace author guide): document the closed vocabulary, the `categories[]`/`category` relationship, and how to add a category (PR + backfill migration).
- `marketplace-dev` skill (external `dork-labs/marketplace`): mention `--categories` and the closed list.
- Changelog: **none** — this spec is IDEATE + SPECIFY only (per task); the implementing PRs carry their own fragments.

## Implementation Phases

- **Phase 1 — Vocabulary + schema:** `categories.ts`, sidecar + manifest fields + coherence refine, `AggregatedPackage.categories`, flatten/merge. (Foundational; unblocks all else.)
- **Phase 2 — Validator + scaffolder + CI:** advisory warning, scaffolder field, exhaustiveness/coherence check.
- **Phase 3 — Client facet chips:** header chips, membership filter, empty state.
- **Phase 4 — Site SEO route:** `/marketplace/category/[slug]`, metadata/OG/JSON-LD, card links.
- **Phase 5 — MCP category-awareness:** sidecar merge, search membership filter, recommend boost.
- **Phase 6 — Registry backfill:** the mechanical map + sidecar in `dork-labs/marketplace`.

Phases 3, 4, 5 are parallelizable once Phase 1 lands (disjoint file sets). Phase 6 is external and depends only on the vocabulary being published (Phase 1's `categories.ts`).

## Open Questions

- **Chip visibility policy:** show _all_ 16 chips always, or only categories with ≥1 present package? Spec chooses **present-only** (no dead facets) — revisit if authors want to see the full menu as guidance. (Leaning present-only; low-risk to flip.)
- **OG per-category image (F2):** ship a per-category OG now, or inherit the marketplace default and add later? Spec treats it as optional/time-boxed.

## Related ADRs

- **ADR-0236** (`decisions/0236-sidecar-dorkos-json-for-marketplace-extensions.md`) — the sidecar mechanism `categories[]` rides. Load-bearing.
- **ADR-0304** (marketplace install transaction) — unaffected; backfill touches registry files, not the installer.
- Candidate new ADR (extract at `/flow:done`): "Controlled marketplace category vocabulary + `categories[]` sidecar membership" — records D1/D4/D5/D6 durably.

## References

- `plans/shapes-program.md` (W3 row; success criterion 4; reference-shape ladder P1–P5).
- Real registry: `apps/server/.temp/.dork/cache/marketplace/marketplaces/dorkos-community/marketplace.json`.
- SEO template: `apps/site/src/app/(marketing)/features/category/[category]/page.tsx`.
- Client params (already reserved `?category=`): `apps/client/src/layers/features/marketplace/model/use-marketplace-params.ts`.
- MCP tools: `apps/server/src/services/marketplace-mcp/{tool-search,tool-recommend,recommend-engine}.ts`.
