# Specification: /compare comparison pages

**Status:** specified · **Date:** 2026-08-23 · **Spec id:** 260823-174248
**Research:** `research/20260823_comparison-pages-competitor-verification.md` (the 11 named products) · `research/20260823_comparison-pages-landscape-and-seo.md` (wider sweep + SEO mechanics)
**Mandate:** `meta/positioning-202607/07-website-changes.md` §4.1 · `05-marketing-strategy.md` §2
**Copy formula:** `meta/value-architecture.md` §4C (validate frustration → name the villain _paradigm_ → assert alternative → prove) · `meta/value-architecture-applied.md` §1A (competitive alternative map), §1D (anti-positioning)

## 1. Goal

Data-driven comparison pages at `/compare` on dorkos.ai, built on the existing feature catalog, with full SEO/GEO wiring. Honest by design (AGENTS.md decision filters + `writing-for-humans` for all visible prose).

## 2. Existing substrate (audited 2026-08-23 — reuse, do not reinvent)

- **Feature catalog:** `apps/site/src/layers/features/marketing/lib/features.ts` — authoritative `Feature` registry (30 entries; `slug`, `name`, `product`, `category`, `tagline` ≤80, `description` 120–160, `status: 'ga'|'beta'|'alpha'|'coming-soon'`, `benefits` 3–5, `docsUrl`, `relatedFeatures`), exported via the slice barrel `apps/site/src/layers/features/marketing/index.ts`. Invariant tests: `lib/__tests__/features.test.ts`.
- **Routes precedent:** `(marketing)/features/page.tsx`, `features/[slug]/page.tsx` (+ `opengraph-image.tsx` with `generateImageMetadata`), `features/category/[category]/page.tsx`.
- **Metadata house pattern:** `title`/`description`, `alternates: { canonical, types: rssFeedAlternateTypes }`, `openGraph`, `twitter: twitterFromOpenGraph(...)` — helpers in `apps/site/src/lib/metadata/index.ts`; `siteConfig` in `src/config/site.ts`.
- **OG toolkit:** `apps/site/src/lib/og/` (`OG_SIZE`, `OG_COLORS`, fonts, `OgEyebrow`/`OgTitle`/`OgDescription`/`OgChip`/`OgWordmark`/`OgAccentStripes`).
- **JSON-LD:** site-wide blocks in `(marketing)/layout.tsx` (SoftwareApplication with stable `@id` `${url}/#software`, WebSite, Organization, SoftwareSourceCode); per-page BreadcrumbList precedent in `features/[slug]` and marketplace routes; `.replace(/</g, '\\u003c')` XSS guard.
- **Sitemap:** `apps/site/src/app/sitemap.ts`; policy: `lastModified` carries a real signal or nothing.
- **AI surfaces:** `llms.txt/route.ts` + `lib/ai/site-index.ts` (shared with `sitemap.md`); IndexNow ping on deploy; robots.ts allow-list already correct.
- **Icons:** `packages/icons/src/adapter-logos.tsx` is the precedent for third-party logo components (do NOT ship other companies' trademarked logos without need — text wordmarks are fine for v1).

## 3. Data model

New file `apps/site/src/layers/features/marketing/lib/comparisons.ts`, exported through the slice barrel. Conventions of `features.ts`: typed const arrays, TSDoc on every export, char-limit invariants.

```ts
export type ComparisonFraming = 'competitor' | 'runtime' | 'adjacent' | 'discontinued';
export type CapabilityVerdict = 'yes' | 'partial' | 'no';

/** Shared comparison axis; DorkOS's side derives from the feature catalog. */
export interface ComparisonDimension {
  id: string; // 'multi-runtime' | 'scheduling' | 'coordination' | 'local-first' | 'surfaces' | 'extensibility' | 'pricing' (initial set; extensible)
  label: string;
  /** Feature slugs backing DorkOS's cell. MUST resolve in features.ts. */
  featureSlugs: string[];
  /** One-sentence framing of what this dimension means for the user. */
  question: string;
}

export interface ComparisonCell {
  verdict: CapabilityVerdict;
  note: string; // one sentence, plain language
  source?: string; // URL backing a yes/partial claim
}

export interface Competitor {
  slug: string; // → /compare/[slug]; kebab, unique
  name: string;
  maker: string;
  framing: ComparisonFraming;
  category: string; // human label, e.g. 'AI IDE'
  oneLiner: string; // 120–160 chars → meta description
  pricing: string; // short factual summary
  openSource: boolean;
  /** Two-to-four-sentence honest verdict; leads the page. */
  verdict: string;
  /** Where THEY win. Non-empty for competitor/adjacent framings. */
  theirStrengths: string[];
  /** Keyed by ComparisonDimension id. Every dimension present. */
  cells: Record<string, ComparisonCell>;
  faq: { q: string; a: string }[]; // 2–5, rendered visibly
  lastVerified: string; // ISO date; visible on page; sitemap lastModified
  sources: string[]; // non-empty
  /** Related feature slugs for cross-links; MUST resolve. */
  relatedFeatures?: string[];
}
```

DorkOS's own cells are **derived, not stored**: a helper `dorkosCellFor(dimension)` maps the backing features' `status` to a verdict — all `ga`/`beta` → `yes`; any `alpha`/`coming-soon` in the set → `partial` with an honest note; this is the **demo-claim gate in code**. Never hand-author a DorkOS cell.

### Invariant tests (`lib/__tests__/comparisons.test.ts`)

1. Unique slugs; kebab-case; no slug collides with a feature slug route.
2. Every `featureSlugs` / `relatedFeatures` entry resolves in `features`.
3. `oneLiner` 120–160 chars; `verdict` non-empty; 2–5 `faq` entries.
4. `theirStrengths` non-empty for `competitor`/`adjacent` framings.
5. Every competitor has a cell for every dimension; every `yes`/`partial` cell carries a `source`.
6. **Demo-claim gate:** `dorkosCellFor` never returns `yes` when any backing feature is `alpha`/`coming-soon` (seed a fake alpha feature and watch it go red — prove the check can fail).
7. `lastVerified` parses as a date, is not in the future, and is ≤120 days old (freshness alarm).
8. `sources` non-empty; all URLs https.

## 4. Routes

Under `apps/site/src/app/(marketing)/compare/`:

- `page.tsx` — hub: intro, grid grouped by framing, `ItemList` JSON-LD, links to every page. Metadata via house pattern.
- `[slug]/page.tsx` — `generateStaticParams` from `comparisons`; template branches on `framing`:
  - **competitor/adjacent:** verdict box → "Use X if / use DorkOS if" (theirStrengths vs ours) → dimension table (DorkOS cells link to `/features/[slug]`) → criterion H2 sections → visible FAQ → last-verified + sources → install CTA. Adjacent adds a scope banner ("different category — here's where they actually overlap").
  - **runtime:** "DorkOS + X" — what X is, what DorkOS adds on top (dimension table reframed as "what DorkOS adds"), FAQ, CTA. Never adversarial.
  - **discontinued:** "X alternatives" — what happened (dated, sourced), migration options table (DorkOS + honest mentions of other successors), FAQ, CTA.
- `[slug]/opengraph-image.tsx` — OG toolkit; "DorkOS vs X" / "DorkOS + X" lockup; `generateImageMetadata` for alt.
- JSON-LD per page: `BreadcrumbList` + two `SoftwareApplication` nodes (DorkOS by stable `@id` ref; competitor with its own data) ; `FAQPage` only where the visible FAQ exists.
- H1s: "DorkOS vs X" (competitor/adjacent), "DorkOS + X" (runtime), "X alternatives" (discontinued). Reverse-order intent is satisfied by title/H2 copy, never a second URL.

## 5. Registration (all required per page-set PR)

`sitemap.ts` (hub + entries, `lastModified: lastVerified`) · `llms.txt/route.ts` (Comparisons section) · `lib/ai/site-index.ts` · hub linked from `/features` page footer or nav where the design allows (small, non-invasive) · changelog fragment per PR.

## 6. Roster and batches

| Batch          | Entries (framing)                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------- |
| A (foundation) | Cursor (competitor) — flagship proving the whole stack                                             |
| B              | Claude Code, Codex, OpenCode (runtime)                                                             |
| C              | GitHub Copilot Agent HQ, Devin, Conductor (Melty Labs), Emdash, Claude Squad (competitor)          |
| D              | Omnara, Amp, Cline, Factory Droid, DeepSeek Harness (competitor)                                   |
| E              | OpenClaw, Hermes Agent, Buzz (adjacent — Buzz scoped to rooms) + Terragon, Roo Code (discontinued) |

Facts/sourcing come from the two research reports; workers verify anything they extend with fresh web research. Copy passes `writing-for-humans`. Never claim an unverified DorkOS surface works (AGENTS.md demo-claim gate).

## 7. Out of scope (v1)

Third-party logo assets (text wordmarks only) · MDX body content (`mdxSlug`-style hook may be stubbed like features.ts does) · aggregated "best X 2026" roundups beyond the hub · automated re-verification cron (the freshness test is the alarm).

## 8. Companion correction (separate work item)

Update `research/20260227_competitive_landscape_agent_infrastructure.md` (+ any `meta/positioning-202607/*` copy leaning on it) where it claims Claude scheduling requires an awake machine — Cowork cloud sessions schedule device-off since July 2026. Mark superseded claims, cite sources, keep the nuance that Claude Code-specific coverage is unverified.
