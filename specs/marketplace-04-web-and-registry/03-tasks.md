# Task Breakdown: Marketplace 04 — Web & Registry

Generated: 2026-04-07
Source: specs/marketplace-04-web-and-registry/02-specification.md
Last Decompose: 2026-04-07
Last Updated: 2026-04-07 (Drizzle/Neon revision)
Mode: Full

> **2026-04-07 revision:** Tasks 1.1, 2.3, 5.1, 5.2, 9.3 modified to use **Neon Postgres + Drizzle ORM** as the single source of truth (no Upstash Redis, no Vercel Queues). New task 1.4 added for Drizzle schema + migration. Total tasks: **29** (was 28). See `03-tasks.json` and the live task system for current task descriptions. See `02-specification.md` Changelog for the architectural decision and rationale.

## Overview

Spec 04 ships the public face of the DorkOS Marketplace: the public `/marketplace` browse and detail pages on dorkos.ai (Next.js 16 SSG + ISR), the seed `marketplace.json` that lives in `dorkos-community/marketplace`, the opt-in install telemetry endpoint (Neon Postgres + Drizzle ORM, single source of truth), the in-product consent surface, and the CLI commands the GitHub submission workflow needs to validate PRs.

The work depends on specs 01 (foundation schemas) and 02 (install machinery + telemetry hook) which are already merged. Spec 03 (in-product Dork Hub) ships in parallel and provides the consent banner host surface.

After this spec ships:

- Anyone can browse `https://dorkos.ai/marketplace` and discover what DorkOS does without installing it.
- Eight seed packages are listed in the canonical registry and visible on the web.
- `dorkos install <name>` works for every listed package once the seed package repos exist (out of scope for this spec).
- DorkOS clients can opt in to anonymous install telemetry, gated behind a default-off toggle and a public privacy contract.

## Critical Path

1.1 / 1.2 / 1.3 (parallel foundation) → 2.1 / 2.2 / 2.3 (parallel libs) → 3.1 / 3.2 / 3.3 (parallel UI) → 3.4 / 3.5 (page wiring) → 4.1 / 4.2 (SEO) → 5.1 (telemetry endpoint) → 6.1 / 6.2 / 6.3 (client wiring) → 7.1 / 7.2 (CLI + fixtures) → 8.x (testing) → 9.x / 10.1 (docs + deploy).

## Parallel Opportunities

- Foundation: tasks 1.1, 1.2, 1.3 are fully independent.
- Lib layer: tasks 2.1, 2.2, 2.3 share only the scaffold from 1.2 and can run in parallel.
- UI layer: tasks 3.1, 3.2, 3.3 share only the lib layer outputs and can run in parallel.
- Page wiring: 3.4, 3.5, 3.6 are independent of each other once the UI is in place.
- SEO: 4.1, 4.2 run in parallel after pages exist.
- Documentation: 9.1, 9.2, 9.3 run in parallel.

---

## Phase 1: Foundation

### Task 1.1: Add Upstash Redis and Neon serverless dependencies to apps/site

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.2, 1.3

Add `@upstash/redis` and `@neondatabase/serverless` to `apps/site/package.json`. These replace the sunset `@vercel/kv` and `@vercel/postgres`. The actual Vercel integrations (`vercel integration add upstash`, `vercel integration add neon`) are provisioned in Phase 5 documentation; this task only adds the npm packages.

**Acceptance Criteria**:

- [ ] Both packages in `apps/site/package.json` dependencies
- [ ] Lockfile refreshed
- [ ] Typecheck passes
- [ ] No references to sunset `@vercel/kv` / `@vercel/postgres` remain

### Task 1.2: Scaffold marketplace feature module under apps/site

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.1, 1.3

Create the FSD layer scaffold mirroring `apps/site/src/layers/features/marketing/`:

```
apps/site/src/layers/features/marketplace/
├── lib/
│   ├── fetch.ts            # placeholder (2.1)
│   ├── ranking.ts          # placeholder (2.2)
│   ├── telemetry.ts        # placeholder (5.2)
│   └── format-permissions.ts  # placeholder (3.3)
├── ui/
└── index.ts                # barrel
```

**Acceptance Criteria**:

- [ ] Scaffold exists with placeholder stubs that compile
- [ ] Barrel exports module with proper TSDoc

### Task 1.3: Document the dorkos-community registry repo layout in contributing/marketplace-registry.md

**Size**: Small | **Priority**: Medium | **Dependencies**: None | **Parallel with**: 1.1, 1.2

Author `contributing/marketplace-registry.md` with the registry repo layout, the verbatim 8-package seed payload, the submission flow, the GitHub Actions workflow YAML, branch protection requirements, and CODEOWNERS. Update the AGENTS.md guides table.

**Acceptance Criteria**:

- [ ] All 7 sections present
- [ ] AGENTS.md guides table updated

---

## Phase 2: Core Features

### Task 2.1: Implement fetchMarketplaceJson and fetchPackageReadme

**Size**: Small | **Priority**: High | **Dependencies**: 1.2 | **Parallel with**: 2.2, 2.3

Implement `apps/site/src/layers/features/marketplace/lib/fetch.ts`. Uses `parseMarketplaceJson` from `@dorkos/marketplace`, hourly Next.js fetch revalidation, and a github → raw URL helper for READMEs. Tests cover happy path, non-2xx, validation failure, and URL conversion edge cases.

**Acceptance Criteria**:

- [ ] Both exports implemented with TSDoc
- [ ] All 7 test cases pass
- [ ] Typecheck passes

### Task 2.2: Implement rankPackages function

**Size**: Small | **Priority**: High | **Dependencies**: 1.2 | **Parallel with**: 2.1, 2.3

Implement `lib/ranking.ts` with type/category/text filters, then `featured*100 + log(install_count)*10` scoring. Tests verify the formula and filter composition.

**Acceptance Criteria**:

- [ ] Filter + score + sort implementation
- [ ] All 9 test cases pass

### Task 2.3: Implement telemetry read helpers

**Size**: Small | **Priority**: High | **Dependencies**: 1.1, 1.2 | **Parallel with**: 2.1, 2.2

Implement `lib/telemetry.ts` with `fetchInstallCount` and `fetchInstallCounts` using `Redis.fromEnv()`. Lazy `getRedis()` so unit tests work without env vars.

**Acceptance Criteria**:

- [ ] Both functions implemented
- [ ] Uses `Redis.fromEnv()` (not `@vercel/kv`)
- [ ] All 6 test cases pass

### Task 3.1: Build MarketplaceGrid, PackageCard, FeaturedAgentsRail, MarketplaceHeader

**Size**: Medium | **Priority**: High | **Dependencies**: 2.1, 2.2, 2.3 | **Parallel with**: 3.2, 3.3

Build the four browse-page UI components as pure server components matching the `apps/site` Calm Tech design language. Filter strip uses `<Link>` only (no JS). Include component tests.

**Acceptance Criteria**:

- [ ] All 4 components with TSDoc
- [ ] Barrel updated
- [ ] All component tests pass

### Task 3.2: Build PackageHeader, PackageReadme, InstallInstructions, RelatedPackages

**Size**: Medium | **Priority**: High | **Dependencies**: 2.1, 2.2, 2.3 | **Parallel with**: 3.1, 3.3

Build the four detail-page UI components. `PackageReadme` uses an existing markdown renderer (likely `streamdown`) — verify before adding new dependencies. Include component tests.

**Acceptance Criteria**:

- [ ] All 4 components with TSDoc
- [ ] Markdown renderer reused, not duplicated
- [ ] Tests pass

### Task 3.3: Build PermissionPreviewServer and format-permissions helper

**Size**: Small | **Priority**: Medium | **Dependencies**: 1.2 | **Parallel with**: 3.1, 3.2

Build the static permission preview component that surfaces high-level claims from the marketplace.json layer hints. Includes the `formatPermissions` helper and the disclaimer footer pointing users to the full install-time preview.

**Acceptance Criteria**:

- [ ] Helper + component implemented
- [ ] All tests pass

### Task 3.4: Wire /marketplace browse page route

**Size**: Small | **Priority**: High | **Dependencies**: 3.1 | **Parallel with**: 3.5, 3.6

Create `apps/site/src/app/(marketing)/marketplace/page.tsx` with `revalidate = 3600`, parallel fetch of registry + install counts, and ranked grid render. Telemetry read failures degrade gracefully.

**Acceptance Criteria**:

- [ ] Page renders with header, featured rail, grid
- [ ] Hourly ISR enabled
- [ ] Build succeeds

### Task 3.5: Wire /marketplace/[slug] detail page route

**Size**: Small | **Priority**: High | **Dependencies**: 3.2, 3.3 | **Parallel with**: 3.4, 3.6

Create `apps/site/src/app/(marketing)/marketplace/[slug]/page.tsx` with `generateStaticParams`, `generateMetadata`, `notFound()` on missing slug, and JSON-LD breadcrumb + software application matching the existing features pattern.

**Acceptance Criteria**:

- [ ] Static params generated for all packages
- [ ] Metadata + JSON-LD set
- [ ] Build emits HTML for every seed package

### Task 3.6: Add /marketplace/privacy page

**Size**: Small | **Priority**: Medium | **Dependencies**: None | **Parallel with**: 3.4, 3.5

Static privacy contract page reproducing the spec's 6 privacy guarantees verbatim, plus a list of fields collected on opt-in and a link to the open source pipeline.

**Acceptance Criteria**:

- [ ] Page renders at `/marketplace/privacy`
- [ ] All 6 guarantees listed verbatim

### Task 4.1: Add OG image generators for /marketplace and /marketplace/[slug]

**Size**: Small | **Priority**: Medium | **Dependencies**: 3.4, 3.5 | **Parallel with**: 4.2

Add `opengraph-image.tsx` for both routes using `@vercel/og` and matching the existing `features/[slug]/opengraph-image.tsx` style (plain `style={}` not `tw=`). Per-package image fetches the registry and renders icon + name + description.

**Acceptance Criteria**:

- [ ] Both files created
- [ ] `runtime = 'edge'` exported
- [ ] Build succeeds and OG image endpoints return PNGs

### Task 4.2: Update sitemap and llms.txt to include marketplace pages

**Size**: Small | **Priority**: Medium | **Dependencies**: 2.1 | **Parallel with**: 4.1

Make `sitemap.ts` async, fetch the registry, and emit one sitemap entry per package plus the static browse + privacy URLs. Make `llms.txt/route.ts` async and add a `## Marketplace` section. Both degrade gracefully when the registry is unreachable.

**Acceptance Criteria**:

- [ ] Sitemap includes all marketplace URLs
- [ ] llms.txt includes Marketplace section with type-tagged entries
- [ ] Both degrade gracefully

### Task 5.1: Implement /api/telemetry/install Edge Function

**Size**: Medium | **Priority**: High | **Dependencies**: 1.1 | **Parallel with**: 5.2

Implement the Edge Function at `apps/site/src/app/api/telemetry/install/route.ts`. Validates the event with Zod, increments the Upstash counter on success, forwards the full event to `TELEMETRY_QUEUE_URL` best-effort. Includes a privacy assertion test verifying no header data leaks into stored events.

**Acceptance Criteria**:

- [ ] Endpoint returns 400 on invalid payload, 200 on success
- [ ] Counter only increments on `outcome === 'success'`
- [ ] All test cases pass including privacy assertion
- [ ] Uses `Redis.fromEnv()`

### Task 5.2: Document Vercel integrations and env var setup

**Size**: Small | **Priority**: Medium | **Dependencies**: None | **Parallel with**: 5.1

Author `contributing/marketplace-telemetry.md` with the `vercel integration add upstash` and `vercel integration add neon` commands, the env var table (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `DATABASE_URL`, `TELEMETRY_QUEUE_URL`), the eventual Postgres schema, and the 30-day daily aggregation strategy. Update AGENTS.md guides table.

**Acceptance Criteria**:

- [ ] Guide exists with all 6 sections
- [ ] No reference to sunset packages
- [ ] AGENTS.md updated

### Task 6.1: Add telemetry config setting to DorkOS server config

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: 6.2

Extend the Zod config schema with a `telemetry: { enabled: boolean }` block defaulting to `false`. Discover the existing schema location first (`packages/shared/src/config-schema.ts` is the most likely host).

**Acceptance Criteria**:

- [ ] Field added with `default(false)`
- [ ] Schema tests cover present/absent/invalid cases

### Task 6.2: Implement registerDorkosCommunityTelemetry server-side reporter

**Size**: Medium | **Priority**: High | **Dependencies**: 6.1 | **Parallel with**: 6.1

Implement `apps/server/src/services/marketplace/telemetry-reporter.ts` registering a reporter that POSTs to `https://dorkos.ai/api/telemetry/install`. Generates and persists a per-machine UUID in dorkHome (NEVER `os.homedir()` per `.claude/rules/dork-home.md`). Wire into server bootstrap alongside `ensureDorkBot()`.

**Acceptance Criteria**:

- [ ] Reporter only registers when consent is true
- [ ] Install ID stored in dorkHome
- [ ] Server bootstrap wires the call
- [ ] All tests pass

### Task 6.3: Surface telemetry consent toggle in Dork Hub UI

**Size**: Medium | **Priority**: High | **Dependencies**: 6.1, 6.2

Add `TelemetryConsentBanner` to the Dork Hub page with explicit opt-in / no-thanks buttons. Extends the schema with `userHasDecided` so the banner stops showing after the user chooses. Include component tests.

**Acceptance Criteria**:

- [ ] Banner shows once on first marketplace visit
- [ ] Persists decision via config write
- [ ] Privacy link points to `dorkos.ai/marketplace/privacy`
- [ ] All component tests pass

### Task 7.1: Add `dorkos package validate-marketplace` and `validate-remote` CLI commands

**Size**: Medium | **Priority**: High | **Dependencies**: None

Add two new CLI subcommands the dorkos-community GitHub Actions workflow depends on:

- `validate-marketplace <path>` reads a `marketplace.json` and validates with `parseMarketplaceJson`
- `validate-remote <github-url>` shallow-clones into a temp dir and runs `validatePackage`

Both have explicit exit codes and clean up temp dirs in a `try/finally`. Register both in the existing CLI dispatcher.

**Acceptance Criteria**:

- [ ] Both commands implemented with exit codes 0/1/2
- [ ] Reuse existing validators (no duplication)
- [ ] All tests pass

### Task 7.2: Author marketplace.json seed file and submission workflow YAML

**Size**: Small | **Priority**: High | **Dependencies**: 7.1

Author the canonical seed payload and supporting fixtures in `packages/marketplace/fixtures/`:

- `dorkos-community-marketplace.json` (8 packages, verbatim from spec)
- `validate-submission.yml` (GitHub Actions workflow)
- `CONTRIBUTING.md`
- `README.md`

Add a fixture validation test asserting the seed payload always parses against the latest schema and has the exact 3+2+2+1 type distribution.

**Acceptance Criteria**:

- [ ] All 4 fixture files created
- [ ] 8 packages with correct type distribution
- [ ] Fixture validation test passes

---

## Phase 3: Testing

### Task 8.1: Add Playwright E2E test for marketplace browse and detail flow

**Size**: Small | **Priority**: Medium | **Dependencies**: 3.4, 3.5, 3.6, 7.2 | **Parallel with**: 8.2

Add `apps/e2e/tests/marketplace.spec.ts` covering: browse renders grid, type filter narrows results, click into detail page renders header + install command, privacy page renders. Mock the registry fetch with the seed fixture for determinism.

**Acceptance Criteria**:

- [ ] All 3 tests pass against `pnpm dev`
- [ ] No flake (3 consecutive runs)

### Task 8.2: Lighthouse + accessibility audit for /marketplace

**Size**: Small | **Priority**: Medium | **Dependencies**: 3.4, 3.5 | **Parallel with**: 8.1

Run Lighthouse via `chrome-devtools-mcp` against `/marketplace` and `/marketplace/code-reviewer` and verify the spec's acceptance criteria: LCP < 2.5s, accessibility score 100. Capture results in `research/20260407_marketplace_lighthouse_baseline.md`.

**Acceptance Criteria**:

- [ ] Both pages audited
- [ ] Results captured in research file
- [ ] LCP and a11y targets met (or follow-up issues filed)

### Task 8.3: End-to-end privacy assertion: telemetry pipeline never logs PII

**Size**: Small | **Priority**: High | **Dependencies**: 6.2 | **Parallel with**: 8.1, 8.2

Add `apps/server/src/services/marketplace/__tests__/telemetry-privacy.test.ts`. Spy on `fetch`, register the reporter with consent, trigger an install event, and assert the request body contains only allow-listed keys. Also verify the opt-out path sends zero fetch calls.

**Acceptance Criteria**:

- [ ] Allow-list enforcement test passes
- [ ] Opt-out path sends zero fetches
- [ ] Test referenced from telemetry contributing guide

---

## Phase 4: Documentation

### Task 9.1: Add Marketplace navigation entry to MarketingNav and write CHANGELOG entry

**Size**: Small | **Priority**: Medium | **Dependencies**: 3.4 | **Parallel with**: 9.2, 9.3

Add `/marketplace` to the public marketing nav links and write a CHANGELOG entry summarizing the 7 user-visible deliverables of this spec.

**Acceptance Criteria**:

- [ ] Nav link visible in dev
- [ ] CHANGELOG entry follows project format

### Task 9.2: Write user-facing docs/marketplace.mdx page in apps/site Fumadocs

**Size**: Small | **Priority**: Medium | **Dependencies**: None | **Parallel with**: 9.1, 9.3

Author `docs/marketplace.mdx` with what the marketplace is, install instructions (CLI + Dork Hub), source management, telemetry consent, and submission link. Cross-link from getting-started.

**Acceptance Criteria**:

- [ ] Page renders in Fumadocs
- [ ] Cross-linked from getting-started

### Task 9.3: Update AGENTS.md routes table and run /adr:from-spec

**Size**: Small | **Priority**: Medium | **Dependencies**: 3.4, 3.5, 5.1, 6.2 | **Parallel with**: 9.1, 9.2

Update AGENTS.md to document the 4 new public routes and the marketplace web/registry layer. Run `Skill(adr:from-spec)` and merge at least one ADR for the Upstash/Neon decision (overrides default Vercel guidance).

**Acceptance Criteria**:

- [ ] AGENTS.md routing updated
- [ ] At least 1 ADR created and recorded in `decisions/manifest.json`

### Task 10.1: Create dorkos-community GitHub org and bootstrap registry repo

**Size**: Small | **Priority**: High | **Dependencies**: 7.1, 7.2, 3.4

External deploy task: provision the public `dorkos-community` org, create the `marketplace` repo, push the fixtures from task 7.2 as the initial commit, configure branch protection, and add CODEOWNERS. The 8 individual seed package repos remain out of scope (separate engineering effort per the spec).

**Acceptance Criteria**:

- [ ] Repo exists and is publicly browsable
- [ ] `marketplace.json` fetchable from raw URL with 8 packages
- [ ] Branch protection + CODEOWNERS configured
- [ ] Live `dorkos.ai/marketplace` renders all 8 packages after next deploy
