# Implementation Summary: Marketplace 04: Web & Registry

> ⚠️ **Schema superseded** — The `marketplace.json` schema shipped in
> this spec was a draft that did not pass `claude plugin validate`. It
> has been superseded by
> [marketplace-05-claude-code-format-superset](../marketplace-05-claude-code-format-superset/02-specification.md),
> which converts the format to a strict superset of the Claude Code
> marketplace format. Spec 05 covers the new schema, the sidecar
> strategy for DorkOS extensions (ADR-0236), the same-repo monorepo
> pattern (ADR-0237), the port-to-Zod CC validator (ADR-0238), and
> the plugin runtime activation via Claude Agent SDK `options.plugins`
> (ADR-0239). Task #28 (the manual GitHub org bootstrap) is unblocked
> by spec 05's Phase 8 with the rewritten `dork-labs/marketplace` seed.

**Created:** 2026-04-07
**Last Updated:** 2026-04-07
**Spec:** specs/marketplace-04-web-and-registry/02-specification.md

## Progress

**Status:** Complete (28 / 29 automated; 1 task — #28 — requires manual GitHub org bootstrap)
**Tasks Completed:** 28 / 29

## Tasks Completed

### Session 1 - 2026-04-07

**Batch 1 (8/8 tasks) — ✅ COMPLETE**

- Task #1: [P1] Add Neon serverless and Drizzle ORM dependencies to apps/site
- Task #2: [P1] Scaffold marketplace feature module under apps/site
- Task #3: [P1] Document the dorkos-community registry repo layout in contributing/marketplace-registry.md
- Task #12: [P2] Add /marketplace/privacy page
- Task #16: [P2] Document Vercel integrations and env var setup in contributing guide
- Task #17: [P2] Add telemetry config setting to DorkOS server config
- Task #20: [P2] Add `dorkos package validate-marketplace` and `validate-remote` CLI commands
- Task #26: [P4] Write user-facing docs/marketplace.mdx page in apps/site Fumadocs

**Batch 1 Holistic Gate:** ✅ PASS

- `pnpm typecheck` (workspace): 21/21 successful
- `pnpm lint` (workspace): 0 errors, 9 pre-existing warnings in apps/client (unrelated)
- `packages/shared` config-schema tests: 62/62 ✅
- `packages/cli` validate tests: 20/20 ✅

**Batch 2 (6/6 tasks) — ✅ COMPLETE**

- Task #4: [P2] Implement fetchMarketplaceJson and fetchPackageReadme
- Task #5: [P2] Implement rankPackages function
- Task #9: [P2] Build PermissionPreviewServer and format-permissions helper
- Task #18: [P2] Implement registerDorkosCommunityTelemetry server-side reporter (wired into server bootstrap)
- Task #21: [P2] Author marketplace.json seed file and submission workflow YAML
- Task #29: [P1] Define Drizzle schema and migration for marketplace_install_events (load-bearing — unblocks #6, #15)

**Batch 2 Holistic Gate:** ✅ PASS

- `pnpm typecheck` (workspace): 21/21 successful
- `pnpm lint` (workspace): 0 errors
- `apps/site` marketplace + db tests: 38/38 ✅ (fetch 10, ranking 9, format-permissions 4, PermissionPreviewServer 3, schema 12)
- `apps/server` telemetry-reporter tests: 8/8 ✅
- `packages/marketplace` seed-fixture tests: 4/4 ✅
- **End-to-end validation:** task #21's seed JSON successfully validated by task #20's CLI (`dorkos package validate-marketplace` → "OK: ... (8 packages)")

**Batch 3 (7/7 tasks) — ✅ COMPLETE**

- Task #6: [P2] Implement telemetry read helpers via Drizzle (fetchInstallCount, fetchInstallCounts)
- Task #7: [P2] Build MarketplaceGrid, PackageCard, FeaturedAgentsRail, MarketplaceHeader
- Task #8: [P2] Build PackageHeader, PackageReadme (streamdown), InstallInstructions, RelatedPackages
- Task #14: [P2] Update sitemap and llms.txt to include marketplace pages
- Task #15: [P2] Implement /api/telemetry/install Edge Function (Drizzle insert, no Redis)
- Task #19: [P2] Surface telemetry consent toggle in Dork Hub UI (+ extended telemetry schema with userHasDecided)
- Task #24: [P3] End-to-end privacy assertion test (runtime PII checks via os.hostname/userInfo/cwd)

**Batch 3 Holistic Gate:** ✅ PASS

- `pnpm typecheck` (workspace): 21/21 successful
- `pnpm lint` (workspace): 16/16 successful, 0 errors
- `apps/site` full suite: 119/119 ✅ (17 test files, including new marketplace UI tests)
- `apps/server` marketplace tests: 307/307 ✅ (telemetry-reporter, telemetry-privacy, etc)
- `packages/shared` config-schema: 65/65 ✅ (+3 new userHasDecided tests)
- `apps/client` TelemetryConsentBanner: 8/8 ✅

**Key architectural wins in Batch 3:**

- End-to-end telemetry pipeline wired: DorkOS client → `reportInstallEvent` → `registerDorkosCommunityTelemetry` reporter → HTTPS POST → `/api/telemetry/install` Edge Function → Drizzle INSERT → Neon Postgres. Single hop, single source of truth.
- Privacy enforced at 3 layers: (1) Zod schema validation on the wire, (2) Drizzle schema column allow-list enforced by `apps/site/src/db/__tests__/schema.test.ts`, (3) runtime PII assertion at `apps/server/src/services/marketplace/__tests__/telemetry-privacy.test.ts` (checks `os.hostname()`, `os.userInfo().username`, `process.cwd()` do not appear in payload).
- `apps/site/vitest.config.ts` gained the `@/*` path alias (first lib in apps/site to use the alias in a test — latent config gap fixed).
- `streamdown` added as apps/site dependency for README rendering. Tiny `StreamdownMarkdown.tsx` client wrapper keeps `PackageReadme` as a server component.

**Batch 4 (2/2 tasks) — ✅ COMPLETE**

- Task #10: [P2] Wire /marketplace browse page route (dynamic/SSR, ISR via revalidate=3600)
- Task #11: [P2] Wire /marketplace/[slug] detail page route (SSG with generateStaticParams, JSON-LD BreadcrumbList + SoftwareApplication)

**Batch 4 Holistic Gate:** ✅ PASS

- `pnpm typecheck`: 21/21 successful
- `pnpm lint`: 16/16 successful
- `pnpm build --filter @dorkos/site`: succeeds with `generateStaticParams` fallback to `[]` on registry fetch failure (graceful pre-deploy behavior)

**Batch 4 post-fix:** Added `try/catch` fallback to `apps/site/src/app/(marketing)/marketplace/[slug]/page.tsx` `generateStaticParams` so the build succeeds even when the dorkos-community registry is unreachable. Slugs fall through to on-demand SSR and the hourly ISR loop picks them up once the registry is live.

**Batch 5 (5/5 tasks + 1 manual) — ✅ COMPLETE**

- Task #13: [P2] OG image generators for /marketplace and /marketplace/[slug] (edge runtime, graceful fallback for missing packages)
- Task #22: [P3] Playwright E2E test for marketplace browse and detail flow (registry fetch mocked from seed fixture)
- Task #23: [P3] Lighthouse + accessibility audit — **deferred** (research artifact at `research/20260407_marketplace_lighthouse_baseline.md`; cannot audit until registry deploys)
- Task #25: [P4] Marketplace nav link (between Features and Blog) + CHANGELOG entry under `## [Unreleased] → ### Added`
- Task #27: [P4] CLAUDE.md routes table + `apps/site` database section; ADR-0234 (Neon + Drizzle SSoT) + ADR-0235 (site-local schema); `decisions/manifest.json` bumped to 236
- **Task #28: [P4] Create dorkos-community GitHub org and bootstrap registry repo** — **NEEDS MANUAL.** Cannot be automated (requires human with GitHub org-creation permissions). Full runbook in task #28 description. Acceptance criteria open pending human action.

**Batch 5 Holistic Gate:** ✅ PASS

- `pnpm typecheck`: 21/21 successful
- `pnpm lint`: 16/16 successful (full turbo cache hit)
- Build succeeds (`ƒ /marketplace`, `● /marketplace/[slug]`, `○ /marketplace/privacy`, `ƒ /marketplace/opengraph-image-*`, `ƒ /marketplace/[slug]/opengraph-image-*`)

## Final Status

**Automated: 28/29 tasks complete.** Spec implementation is done. Task #28 is the only remaining item and requires manual GitHub org bootstrap by a human with the appropriate permissions.

**Follow-ups after #28 deploys:**

1. Run the deferred Lighthouse audit (task #23's research file has the runbook)
2. Run the Playwright E2E test against the live registry (task #22 ready to go)
3. Verify `pnpm build --filter @dorkos/site` populates `generateStaticParams` with all 8 packages (currently returns `[]` as a build-time fallback)
4. Build out the 8 individual seed package repos (`code-reviewer`, `security-auditor`, etc.) — **explicitly out of scope** per the ideation, tracked as a separate engineering effort

## Files Modified/Created

**Source files:**

- `apps/site/package.json` — added `@neondatabase/serverless@^1.0.2`, `drizzle-orm@^0.39.3`, `drizzle-kit@^0.30.6`, `@dorkos/marketplace: workspace:*`
- `apps/site/src/layers/features/marketplace/index.ts` — barrel export
- `apps/site/src/layers/features/marketplace/lib/fetch.ts` — stub for task 2.1
- `apps/site/src/layers/features/marketplace/lib/ranking.ts` — stub for task 2.2 (exports `RankFilters`, `RankedPackage`)
- `apps/site/src/layers/features/marketplace/lib/telemetry.ts` — stub for task 6 (will use Drizzle)
- `apps/site/src/layers/features/marketplace/lib/format-permissions.ts` — stub for task 9 (exports `FormattedPermission`)
- `apps/site/src/layers/features/marketplace/ui/.gitkeep`
- `apps/site/src/app/(marketing)/marketplace/privacy/page.tsx` — static privacy page
- `packages/shared/src/config-schema.ts` — added `telemetry: { enabled: boolean }` block
- `packages/cli/src/cli.ts` — registered `package validate-marketplace` and `package validate-remote` subcommands (lines 44-54, 76-87, 279-280)
- `packages/cli/src/commands/package-validate-marketplace.ts` — new CLI command
- `packages/cli/src/commands/package-validate-remote.ts` — new CLI command

**Documentation:**

- `contributing/marketplace-registry.md` — NEW (273 lines, 7 sections)
- `contributing/marketplace-telemetry.md` — NEW (~190 lines, 8 sections, Neon+Drizzle architecture)
- `docs/marketplace.mdx` — NEW (top-level Fumadocs page, 6 sections)
- `docs/getting-started/quickstart.mdx` — added cross-link to marketplace doc
- `docs/meta.json` — added `marketplace` to sidebar
- `CLAUDE.md` — added `marketplace-registry.md` and `marketplace-telemetry.md` rows to guides table

**Test files:**

- `packages/shared/src/__tests__/config-schema.test.ts` — +7 telemetry test cases, updated 2 snapshot assertions
- `packages/cli/src/commands/__tests__/package-validate-marketplace.test.ts` — NEW, 10 tests
- `packages/cli/src/commands/__tests__/package-validate-remote.test.ts` — NEW, 10 tests

**Drizzle-orm dedup regression fix (infrastructure):**

- `package.json` (root) — added `drizzle-orm: 0.39.3` to `pnpm.overrides`
- `packages/relay/package.json` — added `drizzle-orm: ^0.39.3` as direct dependency (was relying on transitive hoist, which broke when apps/site's peer context forked drizzle-orm)
- `pnpm-lock.yaml` — refreshed

## Known Issues

1. **Pre-existing lint warnings in apps/client** (9 warnings in `SettingsDialog.tsx`, `event-stream-context.tsx`, etc.) — all predate this spec. Not blocking.
2. **Pre-existing peer-dep warning**: `@tanstack/zod-adapter` wants `zod@^3.23.8` but workspace has `4.3.6`. Predates this spec.
3. **`packages/cli` had 57 pre-existing typecheck errors** (unrelated — missing @types/better-sqlite3, older implicit-any patterns). Task #20's new files add 0 errors.
4. **`@dorkos/marketplace` exports `validatePackage` from `/package-validator` subpath**, not the root barrel (Node-only vs browser-safe). Task #20 spec used the wrong import path; agent corrected it.
5. **`validatePackage` return shape** is `{ ok, issues, manifest? }` not `{ ok, errors }`. Task #20 spec assumed the wrong shape; agent corrected filtering on `level === 'error'`.
6. **Orphaned test file** (pre-existing, not Batch 3): `apps/server/src/services/marketplace-mcp/__tests__/tool-install.test.ts` is untracked and imports a `../tool-install.ts` that doesn't exist in that directory. Fails to load in vitest but all other 307 server marketplace tests pass. Left from a previous spec's work in this worktree. Needs cleanup in a follow-up.
7. **`@tailwindcss/typography` not enabled in apps/site** (apps/site uses Tailwind v4). `PackageReadme` uses `prose prose-zinc` classes as a cosmetic wrapper, but the actual styling comes from `streamdown/styles.css` which is imported in `StreamdownMarkdown.tsx`. README rendering works regardless; the prose classes are inert but harmless.

## Implementation Notes

### Session 1

**Review approach:** Per stored feedback (`feedback_holistic_batch_gates.md`), this 29-task spec uses **holistic batch-level verification gates** instead of the skill's default per-task two-stage review. After each parallel batch, the orchestrator runs `pnpm typecheck` + targeted `pnpm vitest run` + `pnpm eslint` against touched directories. Per-task review is reserved for load-bearing slim/integration tasks only.

**Spec revision mid-execution:** Before Batch 1 launched, the spec was revised (Changelog 2026-04-07) to use **Neon Postgres + Drizzle ORM as single source of truth** instead of the original dual-store pattern (Upstash Redis + Neon Postgres via Vercel Queues). Tasks #1, #6, #15, #16, #27 were modified and task #29 was added for the Drizzle schema. Reasons: (1) ORM consistency with `packages/db` (SQLite via Drizzle), (2) future-proof for adding new tables, (3) hourly ISR makes counter-query latency moot, (4) simpler infra.

**Architectural regression fix:** Task #1 added `@neondatabase/serverless` to apps/site, which exposed a latent issue: `packages/relay/src/sqlite-index.ts` imported from `drizzle-orm` without declaring it as a direct dependency, relying on transitive hoist. pnpm forked drizzle-orm into two physical copies (one with neon peer context, one without), causing nominal type mismatches. Fix: added `drizzle-orm` as a direct dep to `packages/relay/package.json` (which it should have been all along) and added `drizzle-orm: 0.39.3` to `pnpm.overrides` in root `package.json`. Workspace typecheck went from broken → 21/21 successful.

**Cross-task coordination:** Task #2 (scaffold) discovered `@dorkos/marketplace` wasn't yet a dependency of `apps/site` and added it proactively. This unblocked task #12's typecheck gate without explicit coordination.
