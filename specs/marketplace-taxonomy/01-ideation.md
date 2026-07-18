---
slug: marketplace-taxonomy
id: 260718-043238
created: 2026-07-17
status: ideation
provenance: { tracker: linear, issue: DOR-356 }
---

# Marketplace Category Taxonomy — Ideation

**Slug:** marketplace-taxonomy
**Author:** spec-taxonomy agent (DorkOS Shapes program, W3)
**Date:** 2026-07-17
**Tracker:** DOR-356 (workstream W3 of the Shapes program, `plans/shapes-program.md`)

---

## 1) Intent & Assumptions

- **Task brief:** Give the DorkOS marketplace a **controlled category vocabulary** (a closed, CI-checked list) and the plumbing that makes it useful: multi-membership `categories[]` on packages via the ADR-0236 sidecar, validator + scaffolder support, client facet chips wired to the reserved `?category=` param, per-category SEO routes on the site, category-aware MCP tools, and a mechanical backfill for the `dork-labs/marketplace` registry.
- **Decided input (founder, 2026-07-17, not relitigated):** membership is **`categories[]` (plural, multi)** carried through the **ADR-0236 sidecar** (`.claude-plugin/dorkos.json`), Segment-catalog-style multi-membership. See `plans/shapes-program.md` W3 row and the resolved open question (DOR-368).
- **Assumptions** (each restated in §Assumptions of the spec):
  1. A package belongs to **one or more** categories; the singular `category` remains the **primary** category (`categories[0]`) and the **Claude-Code-interop** field.
  2. The closed list is **DorkOS-authored surface only**. We cannot constrain Claude Code's inline `category` string on foreign marketplaces (inbound-lenient invariant), so the enum binds `.dork/manifest.json`, the sidecar `categories[]`, and the CI vocabulary check on our own registry — never the inbound `marketplace.json` parser.
  3. v1 is **keyword/no-ML**: category filtering and boosting are exact-slug set operations, consistent with the existing `recommend-engine` non-goal.
  4. The `dork-labs/marketplace` registry backfill executes **in that repo** (external); this spec ships the mechanical map + checklist so it is a listable mechanical change, not research.
- **Out of scope:** free-tagging redesign (`tags[]` stays as-is); category hierarchies / sub-categories (flat list only); ML relevance; a category-management admin UI; renaming or removing the existing `tags` field; changing CC's marketplace format.

## 2) Pre-reading Log

- `plans/shapes-program.md` (W3 row + resolved question): scope is exactly the seven deliverables above; `?category=` "already reserved"; SEO route "clone `features/category/[category]`"; success criterion 4 = "≥6 category SEO routes with zero unverified claims."
- `decisions/0236-sidecar-dorkos-json-for-marketplace-extensions.md`: CC's validator enforces `additionalProperties: false` on plugin entries (GitHub #26555) → DorkOS-specific fields live in `.claude-plugin/dorkos.json`, keyed by plugin name, merged by name; missing sidecar ⇒ `dorkos: undefined` (not an error). **`categories[]` is a DorkOS-specific field → it must ride the sidecar, never inline in `marketplace.json`.**
- `packages/marketplace/src/manifest-schema.ts:98`: `.dork/manifest.json` already has `category: z.string().max(64).optional()` + `tags` (line 95). This is the **author-source** manifest (DorkOS-only, not CC-validated).
- `packages/marketplace/src/marketplace-json-schema.ts:216`: the registry `marketplace.json` entry has `category: z.string().max(64).optional()` + `tags`/`keywords` — CC-standard, `.passthrough()`.
- `packages/marketplace/src/cc-validator.ts:104-105`: **CC's strict oracle already accepts `category` and `tags` inline.** So singular `category` is CC-native and safe inline; the **plural `categories` is NOT in CC's schema and would fail `claude plugin validate` if inlined** — confirming the sidecar decision.
- `packages/marketplace/src/dorkos-sidecar-schema.ts:40`: `DorkosEntrySchema` (`type`, `layers`, `requires`, `featured`, `icon`, `dorkosMinVersion`, `pricing`) — the home for the new `categories[]`.
- `packages/marketplace/src/merge-marketplace.ts:61` + `apps/server/src/routes/marketplace.ts:719` (`flattenMergedEntry`): merge joins by name; flatten maps `entry.category` (from marketplace.json) + `entry.dorkos?.{type,icon,featured}` (from sidecar) into `AggregatedPackage`. The insertion point for `categories[]` is `entry.dorkos?.categories`.
- `packages/shared/src/marketplace-schemas.ts:44`: `AggregatedPackage` (wire type) has `category?: string` (line 65) but no `categories`.
- `apps/client/src/layers/features/marketplace/model/use-marketplace-params.ts`: `?category=` is **fully plumbed** — `category`, `setCategory`, URL normalization all exist. `filterPackages` (`lib/package-filter.ts:67`) already filters `pkg.category === category` (exact, singular). The **only missing client piece is the facet-chip UI** (`MarketplaceHeader.tsx` renders search + type tabs, no category chips) and membership matching against `categories[]`.
- `apps/site/src/app/(marketing)/features/category/[category]/page.tsx`: the cloneable SEO template — `generateStaticParams()` over `CATEGORY_LABELS`, `generateMetadata()` (OG + canonical + twitter), BreadcrumbList + CollectionPage JSON-LD, `notFound()` on unknown category, `InstallMoment` exit ramp.
- `apps/site/src/layers/features/marketplace/lib/{fetch,ranking}.ts`: site pulls `dork-labs/marketplace` (raw GitHub, hourly ISR) + the `dorkos.json` sidecar, merges, and `rankPackages(..., { type, category, q })` already filters `p.category === filters.category` (singular). `marketplace/page.tsx` already reads `?category=`.
- `apps/server/src/services/marketplace-mcp/tool-search.ts` + `tool-recommend.ts` + `recommend-engine.ts`: `marketplace_search` has a `category` input (exact `r.category === wantedCategory`, line 143); `marketplace_recommend` scores keyword/tag with no category signal. **Both read raw `json.plugins` (`tool-search.ts:117`) and never fetch the sidecar** — so today the MCP tools cannot see any sidecar field. Category-awareness therefore requires teaching them to merge the sidecar (as the HTTP route already does).
- Real registry (cached `apps/server/.temp/.dork/cache/marketplace/marketplaces/dorkos-community/marketplace.json`): 12 packages with free-string singular categories — see §5 table. **No `dorkos.json` sidecar exists in the registry yet** → the `categories[]` backfill is greenfield.

## 3) Codebase Map

- **Vocabulary source (new):** `packages/marketplace/src/categories.ts` — browser-safe (`zod` only), the single closed enum + labels + descriptions + `primaryCategory()` helper. Barrel-exported from `packages/marketplace/src/index.ts`.
- **Schema surfaces:** `dorkos-sidecar-schema.ts` (`DorkosEntrySchema.categories`), `manifest-schema.ts` (`BasePackageManifestSchema.categories` + tighten `category` to the enum + coherence refine), `packages/shared/src/marketplace-schemas.ts` (`AggregatedPackage.categories`).
- **Merge/flatten:** `apps/server/src/routes/marketplace.ts` `flattenMergedEntry` + `apps/site/.../marketplace/lib/ranking.ts`.
- **Validator + scaffolder:** `packages/marketplace/src/{package-validator.ts,scaffolder.ts}`; CI vocabulary check (new script under `.claude/scripts/` or `packages/marketplace/scripts/`).
- **Client:** `apps/client/src/layers/features/marketplace/ui/MarketplaceHeader.tsx` (add chips), `lib/package-filter.ts` (membership match), `ui/PackageEmptyState.tsx` (empty state). Entity/params already done.
- **Site:** `apps/site/src/app/(marketing)/marketplace/category/[category]/page.tsx` (new, cloned), `marketplace/category/[category]/opengraph-image.tsx` (optional OG, cloned from `marketplace/opengraph-image.tsx`), links from browse cards.
- **MCP:** `apps/server/src/services/marketplace-mcp/{tool-search.ts,tool-recommend.ts,recommend-engine.ts}`.
- **Registry backfill (external):** `dork-labs/marketplace` → new `.claude-plugin/dorkos.json` with `categories[]` for all 12 packages + canonicalized inline `category`.
- **Feature-flags/config:** none — the taxonomy is code-shipped, not user-config.
- **Blast radius:** additive. Every schema field is optional; `category` (singular) is preserved for CC-interop; a package with no `categories[]` still browses (falls back to singular `category`, then to "Uncategorized").

## 4) Root Cause Analysis

Not a bug — a feature. Omitted.

## 5) Research — the real registry today

The `dork-labs/marketplace` `marketplace.json` (cached copy read verbatim) carries **free-string** singular categories with no controlled vocabulary and no sidecar:

| Package               | type       | `category` today | keywords/tags                 | Proposed `categories[]` (v1)             |
| --------------------- | ---------- | ---------------- | ----------------------------- | ---------------------------------------- |
| `code-reviewer`       | plugin     | `code-quality`   | review, pr, ci                | `["code-review"]`                        |
| `security-auditor`    | plugin     | `security`       | security, audit               | `["security"]`                           |
| `security-audit-pack` | skill-pack | `security`       | skills, security              | `["security"]`                           |
| `docs-keeper`         | plugin     | `documentation`  | docs, sync                    | `["documentation"]`                      |
| `linear-integration`  | plugin     | `integration`    | linear, issues                | `["project-management", "integrations"]` |
| `discord-adapter`     | adapter    | `integration`    | discord, adapter              | `["integrations"]`                       |
| `posthog-monitor`     | plugin     | `observability`  | posthog, analytics            | `["observability"]`                      |
| `release-pack`        | skill-pack | `release`        | skills, release               | `["release-ops"]`                        |
| `marketplace-dev`     | plugin     | `development`    | marketplace, packaging        | `["dev-tools"]`                          |
| `lifeos-starter`      | agent      | `productivity`   | coaching, obsidian            | `["productivity"]`                       |
| `flow`                | plugin     | `workflow`       | orchestration, autonomous, pm | `["agent-ops", "project-management"]`    |

Nine distinct free strings today (`code-quality`, `security`, `documentation`, `integration`, `observability`, `release`, `development`, `productivity`, `workflow`). `linear-integration` and `flow` are the two natural **multi-membership** cases — the concrete justification for `categories[]` over a scalar.

**Potential solutions considered:**

1. **Keep singular free-string `category`** — status quo. Rejected: no controlled vocabulary (SEO routes need a closed set), no multi-membership, `linear-integration`/`flow` mis-file.
2. **Scalar controlled `category` (single enum)** — closed list, no plural. Rejected by the founder decision (multi-membership required; Segment-catalog pattern).
3. **`categories[]` inline in `marketplace.json`** — Rejected by ADR-0236 / `cc-validator.ts` `.strict()`: unknown plural key fails `claude plugin validate`.
4. **`categories[]` in the ADR-0236 sidecar (`dorkos.json`), enum-controlled, with singular `category` retained as CC-interop primary** — **chosen.** Multi-membership, CC-safe, backward compatible.

**Recommendation:** Solution 4 (the founder's decision), with a 16-entry closed vocabulary (§6 D2) spanning Act-1 dev surfaces and Act-2 business seeds.

## 6) Decisions

| #   | Decision                             | Choice                                                                                                                                                               | Rationale                                                                                                                                                      |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Membership cardinality               | **`categories[]` (multi)** via ADR-0236 sidecar                                                                                                                      | Founder decision 2026-07-17 (DOR-368); Segment catalog pattern; `flow`/`linear-integration` need it.                                                           |
| D2  | The closed vocabulary v1             | **16 slugs** (see §6 table below)                                                                                                                                    | Grounded in the 9 real registry strings + the named reference shapes (Linear Ops, Flow Board, content pipeline, CRM-lite, Release Ops) + Act-2 business seeds. |
| D3  | Where the enum lives                 | New `packages/marketplace/src/categories.ts` (`z.enum`, browser-safe)                                                                                                | Single source of truth consumed by schemas, client, site, MCP, and CI — mirrors `package-types.ts`.                                                            |
| D4  | Sidecar vs inline                    | `categories[]` → `DorkosEntrySchema` (sidecar only)                                                                                                                  | ADR-0236 + `cc-validator.ts:104-105` prove singular `category`/`tags` are CC-native but plural `categories` is not.                                            |
| D5  | Back-compat with singular `category` | **Keep it as the primary category = `categories[0]`, and the CC-interop field.** Derive `primaryCategory = categories[0] ?? category`.                               | Zero-break for CC + existing consumers; backfill is a superset; validator enforces `category === categories[0]` when both present.                             |
| D6  | Enum scope                           | Enum binds **DorkOS-authored surfaces only** (`.dork/manifest.json`, sidecar `categories[]`, our CI check) — **never** the inbound-lenient `marketplace.json` parser | Preserves ADR-0236's inbound invariant: a foreign CC marketplace with `category: "anything"` must still parse.                                                 |
| D7  | Empty / uncategorized                | A package with no `categories[]` and no `category` is "Uncategorized" (not shown as a facet chip, not SEO-routed, still browsable)                                   | No dead SEO pages; no forced mis-classification.                                                                                                               |
| D8  | MCP category-awareness               | tool-search + tool-recommend **merge the sidecar** (as the HTTP route does), filter by membership, and add a category boost to recommend                             | Today both read raw `json.plugins` and can't see sidecar fields — category-awareness is impossible without the merge.                                          |

### D2 — the proposed closed vocabulary (v1, 16 categories)

Bands are organizational only (all 16 are one flat closed list; multi-membership means band overlap is fine):

**Act 1 — dev-facing (8):**

| slug                 | label              | grounded in                                            |
| -------------------- | ------------------ | ------------------------------------------------------ |
| `code-review`        | Code Review        | `code-reviewer` (was `code-quality`)                   |
| `security`           | Security           | `security-auditor`, `security-audit-pack`              |
| `release-ops`        | Release Ops        | `release-pack`; Release Ops shape (P5c)                |
| `observability`      | Observability      | `posthog-monitor`; Eval/QA dashboard shape (P5b)       |
| `documentation`      | Documentation      | `docs-keeper`; docs-health card (P5d)                  |
| `agent-ops`          | Agent Ops          | `flow` (orchestration); Linear Ops shape (P1)          |
| `project-management` | Project Management | `linear-integration`; Flow Board (P2), Linear Ops (P1) |
| `dev-tools`          | Developer Tools    | `marketplace-dev` (was `development`)                  |

**Cross-cutting (2):**

| slug           | label        | grounded in                                                   |
| -------------- | ------------ | ------------------------------------------------------------- |
| `integrations` | Integrations | `discord-adapter`, `linear-integration` (connectors/adapters) |
| `productivity` | Productivity | `lifeos-starter`                                              |

**Act 2 — business seeds (6):**

| slug         | label       | grounded in                               |
| ------------ | ----------- | ----------------------------------------- |
| `marketing`  | Marketing   | Act-2 seed (`plans/shapes-program.md` W3) |
| `sales-crm`  | Sales & CRM | CRM-lite shape (P4)                       |
| `content`    | Content     | content pipeline shape (P3)               |
| `support`    | Support     | Act-2 seed                                |
| `accounting` | Accounting  | Act-2 seed                                |
| `research`   | Research    | Act-2 seed                                |

The nine legacy free strings map cleanly (§5 table) — the backfill is mechanical: `code-quality→code-review`, `security→security`, `documentation→documentation`, `integration→[project-management,integrations] | integrations`, `observability→observability`, `release→release-ops`, `development→dev-tools`, `productivity→productivity`, `workflow→agent-ops`.
