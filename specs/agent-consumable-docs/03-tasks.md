# Tasks — Agent-consumable docs (DOR-165)

- **Spec:** `specs/agent-consumable-docs/02-specification.md`
- **Slug:** `agent-consumable-docs`
- **Generated:** 2026-07-17 · **Mode:** full
- **Canonical source:** `03-tasks.json` (this file is the human-readable mirror). If they disagree, the JSON wins.

## Two-PR plan (the PR boundaries)

This spec ships as **two sequenced pull requests**. A ships first so the value cannot be held hostage by the upgrade that already reverted once.

- **PR 1 — Phase A (tasks 1.1–1.6): AI consumption, no version bump.** Additive: one config flag, one helper, two static routes, one scaffolded UI component, one page insertion. Ships the entire user-facing value on the currently-installed fumadocs (core/ui 16.7.16, openapi 10.6.8, mdx 14.3.0). Carries the user-facing `### Added` changelog fragment (the on-brand headline). Near-zero risk to existing pages.
- **PR 2 — Phase B (tasks 2.0–2.6): fumadocs 16.10 / openapi 11 upgrade.** The welded core/ui 16.10 + openapi 11 bump and the `APIPage` client-component migration the openapi 10→11 major forces. Opens with a **reproduce-first** step (2.0) and is **done when its gate is green** — site build incl. `/docs/api/*` prerender + `/docs/api` renders + `openapi-fresh` CI green — not when a hypothesis is confirmed. Carries a `### Changed` changelog fragment **only if** a user-visible change results (honestly, likely none — the upgrade is invisible infrastructure). Carries the ADR.

**Sequencing:** Phase B depends on Phase A **only for sequencing** (A merges first). There is no hard code dependency from B on A, so B.0's reproduction can be investigated independently; but the PRs land in order, and B edits the post-A `page.tsx` (the 1.6 action-row block must be preserved by task 2.3).

## Dependency graph & critical path

```
PHASE A (PR 1)
  1.1 config flag ─────────────┐
  1.2 getLLMText helper ──┬──▶ 1.3 raw .mdx route ──┐
                          └──▶ 1.4 llms-full.txt + predicate ──┐
  1.5 scaffold page-actions ───────────────────────┐          │
                                                    ▼          ▼
                        1.6 page insert + D-A1 + BUILD GATE + changelog
                              (deps: 1.1, 1.3, 1.4, 1.5; transitively 1.2)

PHASE B (PR 2)  — 2.0 gates everything in B
  2.0 REPRODUCE (throwaway install) ──▶ 2.1 dep bump + lockfile ──┬──▶ branch 1: 2.2 client APIPage ──▶ 2.3 props bridge ──┐
                                                                  └──▶ branch 2: 2.4 generator v11 ──▶ 2.5 regen + openapi-fresh ──┐
                                                                                                                              ▼   ▼
                                                                              2.6 verify source.ts + FULL PHASE B GATE + ADR
                                                                                    (deps: 2.3, 2.5)
```

- **Phase A critical path:** 1.2 → (1.3 & 1.4) → 1.6, with 1.1 and 1.5 joining at 1.6. Longest chain = 3 hops.
- **Phase B critical path:** 2.0 → 2.1 → 2.2 → 2.3 → 2.6 (runtime branch) run against 2.0 → 2.1 → 2.4 → 2.5 → 2.6 (generator branch); the two branches are file-disjoint and run in parallel; 2.6 joins them. Longest chain = 5 hops. **2.0 gates all of Phase B.**

## Parallelization

**Phase A** — the helper, the routes, and the scaffold are parallelizable; only the page insertion is serial (the directive's "helper/routes vs page insertion" split):

- **Batch A1 (parallel):** `1.1` (config), `1.2` (helper), `1.5` (scaffold) — fully disjoint files, no deps.
- **Batch A2 (parallel, after 1.2):** `1.3` (.mdx route) and `1.4` (llms-full.txt route + predicate) — disjoint route files, both depend only on 1.2.
- **Serial tail:** `1.6` — the integration + build gate + changelog; not parallelizable.

**Phase B** — after the bump, two file-disjoint branches run concurrently:

- **Gate:** `2.0` (reproduce) then `2.1` (bump) — serial, both gate everything downstream.
- **Branch 1 (runtime wiring):** `2.2` → `2.3` (files: `lib/openapi.ts` + `components/api-page.tsx`, then `page.tsx`).
- **Branch 2 (generator/artifacts):** `2.4` → `2.5` (files: `scripts/generate-api-docs.ts`, then `docs/api/api/**`).
- Branch 1 and Branch 2 are marked `parallelWith` each other in the JSON. **Serial tail:** `2.6` (join + full gate + ADR).

## Changelog & ADR encoding (honest)

- **Phase A → `### Added`** (task 1.6): user-facing headline — read any doc as clean markdown, pull the whole corpus in one fetch, copy/open-in-Claude from a quiet action row. On-brand; agent-consumable docs is a genuine differentiator.
- **Phase B → `### Changed` only if user-visible** (task 2.6): the upgrade is isolated infrastructure. If the API reference renders identically (expected), **no fragment** — do not fabricate a user-facing entry for an invisible upgrade.
- **ADR** (task 2.6, extract via `/adr:from-spec`): ONE record for the whole two-phase decision — the decoupling (D1/D2), the client-component `APIPage` + `getOpenAPIPageProps` bridge (D6), and the reproduce-first / gate-defined adaptation boundary (O1). Extracted at the end of Phase B because the client-migration consequences are only proven once the gate is green (follows the spec's B.7 grouping).

---

## Phase A — AI consumption (current fumadocs, PR 1)

### Task 1.1: Enable processed markdown in `source.config.ts` (A.1)

- **Files:** `apps/site/source.config.ts`
- **Do:** add a `docs: { postprocess: { includeProcessedMarkdown: true } }` override to the existing `defineDocs`, keeping `dir`; leave `blogPosts` untouched. Unlocks `page.data.getText('processed')`.
- **Acceptance:** flag set; typecheck passes; processed markdown resolves at build (proven by 1.6's gate).
- **Verify:** `pnpm --filter @dorkos/site typecheck`
- **Deps:** none. **Parallel:** 1.2, 1.5. **Size:** sm.
- **Spec:** Detailed Design A.1.

### Task 1.2: `getLLMText` serialization helper + unit test (A.2)

- **Files:** `apps/site/src/lib/get-llm-text.ts` (new), `apps/site/src/lib/__tests__/get-llm-text.test.ts` (new)
- **Do:** write the verbatim `getLLMText` helper (H1 title + absolute `Source:` URL + optional description + processed body); unit-test header order, absolute URL, and the description present/absent branches with a fake page.
- **Acceptance:** locked contract implemented; test proves it; typecheck + test pass.
- **Verify:** `pnpm --filter @dorkos/site exec vitest run src/lib/__tests__/get-llm-text.test.ts && pnpm --filter @dorkos/site typecheck`
- **Deps:** none. **Parallel:** 1.1, 1.5. **Size:** sm.
- **Spec:** Detailed Design A.2, Testing Strategy (Phase A unit).

### Task 1.3: Raw-markdown route `/docs/<slug>.mdx` + `generateStaticParams` (A.3)

- **Files:** `apps/site/src/app/(docs)/docs/[[...slug]].mdx/route.ts` (new)
- **Do:** verbatim `force-static` route serving `text/markdown` via `getLLMText` + `generateStaticParams`; confirm Next 16 resolves the `[[...slug]].mdx` segment, else use the documented fallback placement and keep `markdownUrl` (1.6) in agreement.
- **Acceptance:** every docs page fetchable as markdown, built statically; typecheck passes (static bytes asserted by 1.6).
- **Verify:** `pnpm --filter @dorkos/site typecheck`
- **Deps:** 1.2. **Parallel:** 1.4. **Size:** sm.
- **Spec:** Detailed Design A.3.

### Task 1.4: `/llms-full.txt` full-corpus route + D3 filter (extract predicate + unit test) (A.4)

- **Files:** `apps/site/src/app/llms-full.txt/route.ts` (new), `apps/site/src/lib/is-generated-api-page.ts` (new), `apps/site/src/lib/__tests__/is-generated-api-page.test.ts` (new)
- **Do:** verbatim `force-static` `text/plain` route joining hand-authored pages via `getLLMText`; **extract** the D3 filter to a pure, unit-tested `isGeneratedApiPage` predicate (primary: `_openapi` marker; fallback: slug-prefix `api` + `slugs.length > 1`). Same predicate reused by 1.6 (D-A1).
- **Acceptance:** the 65 generated pages excluded, hand-authored kept; predicate standalone + tested; typecheck + test pass.
- **Verify:** `pnpm --filter @dorkos/site exec vitest run src/lib/__tests__/is-generated-api-page.test.ts && pnpm --filter @dorkos/site typecheck`
- **Deps:** 1.2. **Parallel:** 1.3. **Size:** md.
- **Spec:** Detailed Design A.4, Testing Strategy (Phase A unit — filter).

### Task 1.5: Scaffold `components/ai/page-actions.tsx` (A.5)

- **Files:** `apps/site/src/components/ai/page-actions.tsx` (new, scaffolded)
- **Do:** `npx @fumadocs/cli add ai/page-actions`; keep the client scaffold as-authored (local ownership); it exports `LLMCopyButton` + `ViewOptions` wrapping the ui `page-actions` primitives; keep honest labels ("Open in Claude" = claude.ai web); add TSDoc if the scaffold omits it.
- **Acceptance:** components exist + TSDoc + honest labels; typecheck + lint pass.
- **Verify:** `pnpm --filter @dorkos/site typecheck && pnpm --filter @dorkos/site lint`
- **Deps:** none. **Parallel:** 1.1, 1.2. **Size:** sm.
- **Spec:** Detailed Design A.5, User Experience (D5 honesty).

### Task 1.6: Insert action row in `page.tsx` (D-A1) + Phase A build gate + changelog (A.6)

- **Files:** `apps/site/src/app/(docs)/docs/[[...slug]]/page.tsx` (edit — add `siteConfig` import), `changelog/unreleased/<id>-agent-consumable-docs.md` (new)
- **Do:** insert the client action row after `<DocsDescription>` / before `<DocsBody>`, gated on `!isGeneratedApiPage(page)` (D-A1); `markdownUrl = page.url + ".mdx"`, `githubUrl = siteConfig.github + "/blob/main/docs/" + page.path` (O2). Run the **Phase A build gate** (both routes emit correct static bytes; row shows on prose, hides on API pages; no dependency bump). Write the `### Added` changelog fragment (timestamp id from `.claude/scripts/id.ts`, writing-for-humans, honest "Open in Claude" framing).
- **Acceptance:** row renders/hides correctly; build + typecheck + lint green; no bump; valid `### Added` fragment.
- **Verify:** `pnpm --filter @dorkos/site build && pnpm --filter @dorkos/site typecheck && pnpm --filter @dorkos/site lint` (+ manual static-bytes / `next start` checks).
- **Deps:** 1.1, 1.3, 1.4, 1.5 (transitively 1.2). **Parallel:** none (serial tail). **Size:** md.
- **Spec:** Detailed Design A.6, Testing Strategy (Phase A build gate), Documentation (changelog).

---

## Phase B — fumadocs 16.10 / openapi 11 upgrade (gated, PR 2)

### Task 2.0: Reproduce the `/docs/api/*` prerender failure on a throwaway install — FIRST (B.0)

- **Files:** none committed (throwaway install; deliverable is the captured error + the written O1 resolution appended to the spec's Open Questions)
- **Do:** in a scratch worktree/branch, bump the four welded deps, `pnpm install`, `pnpm --filter @dorkos/site build`, and **capture the real `/docs/api/*` prerender error**; confirm/correct the D6 hypothesis and the mdx/next/react peer picture. **Adaptation boundary:** Phase B is done when its gate is green regardless of whether the fix matches D6; if the root cause differs, adapt within the gate and record the O1 correction.
- **Acceptance:** real failure reproduced + root cause confirmed (or D6 corrected) in writing **before** any fix is committed.
- **Verify:** `pnpm install` then `pnpm --filter @dorkos/site build` in the throwaway install; capture + write up.
- **Deps:** none. **Gates all of Phase B.** **Parallel:** none. **Size:** md.
- **Spec:** Detailed Design B.0, Open Questions O1.

### Task 2.1: Welded dependency bump (core/ui `^16.10`, openapi `^11`) + lockfile (B.1)

- **Files:** `apps/site/package.json` (edit), `pnpm-lock.yaml` (updated)
- **Do:** bump `fumadocs-core`/`fumadocs-ui` → `^16.10` and `fumadocs-openapi` → `^11` in one change (peers welded); re-check `fumadocs-mdx` and bump only if the resolved peer demands; update lockfile; confirm next/react peers. (Intermediate red build until 2.2–2.5 land is expected.)
- **Acceptance:** versions pinned, lockfile updated, clean peer resolution.
- **Verify:** `pnpm install` (clean peers) + assert the three versions in `package.json`.
- **Deps:** 2.0. **Parallel:** none. **Size:** sm.
- **Spec:** Detailed Design B.1, Technical Dependencies (Phase B).

### Task 2.2: Move `createAPIPage` to a client `APIPage` module (B.2 + B.3, atomic)

- **Files:** `apps/site/src/lib/openapi.ts` (edit — keep server `openapi`, drop the `APIPage` factory), `apps/site/src/components/api-page.tsx` (edit — becomes `'use client'`, creates/re-exports v11 client `APIPage` via `createAPIPage` from `fumadocs-openapi/ui`)
- **Do:** one atomic compile-unit — the factory must move to a client module or the build breaks mid-migration. Delete the load-bearing "must NOT have 'use client'" comment; replace with the v11 client-component rationale. Client `APIPage` renders from serialized props, never file I/O.
- **Acceptance:** `openapi.ts` exports only the server instance; `api-page.tsx` is the client module; comment inverted; typecheck passes.
- **Verify:** `pnpm --filter @dorkos/site typecheck`
- **Deps:** 2.1. **Parallel:** 2.4, 2.5 (branch 2). **Size:** md.
- **Spec:** Detailed Design B.2 + B.3, Background (prerender crux).

### Task 2.3: Server→client OpenAPI props bridge in `page.tsx` (B.4)

- **Files:** `apps/site/src/app/(docs)/docs/[[...slug]]/page.tsx` (edit)
- **Do:** server resolves the bundled OpenAPI props (`page.data.getOpenAPIPageProps()` or the exact v11 accessor confirmed in 2.0) and passes them to the client `APIPage` — no runtime relative-path read. Preserve the Phase A action-row block from 1.6. Precise wiring resolved in EXECUTE from the 2.0 reproduction; the **contract is fixed**: `/docs/api/*` prerenders and renders interactively with no relative-path file read.
- **Acceptance:** props bridge wired; no client relative-path read; 1.6 block preserved; typecheck passes.
- **Verify:** `pnpm --filter @dorkos/site typecheck` (full render proof = 2.6 gate).
- **Deps:** 2.2. **Parallel:** 2.4, 2.5 (branch 2). **Size:** md.
- **Spec:** Detailed Design B.4.

### Task 2.4: Update `generate-api-docs.ts` to the v11 `generateFiles` signature (B.5)

- **Files:** `apps/site/scripts/generate-api-docs.ts` (edit)
- **Do:** re-verify the exact v11 `Config` signature (`fumadocs-openapi/dist/generate-file.d.ts`); DorkOS already passes `input: openapi` (server instance) + `output` + `includeDescription: true` — adjust `input`/options only where the v11 shapes changed; **keep** the pre-generation prune (`fs.rmSync`).
- **Acceptance:** generator calls the correct v11 `generateFiles`; prune retained; script typechecks and runs.
- **Verify:** `pnpm --filter @dorkos/site typecheck && pnpm --filter @dorkos/site generate:api-docs`
- **Deps:** 2.1. **Parallel:** 2.2, 2.3 (branch 1). **Size:** sm.
- **Spec:** Detailed Design B.5.

### Task 2.5: Regenerate `docs/api/api/**` (65 files) to the v11 shape + hold `openapi-fresh` (B.6)

- **Files:** `docs/api/api/**` (65 regenerated MDX), `docs/api/openapi.json` (regenerated if changed)
- **Do:** `pnpm docs:export-api` then `pnpm --filter @dorkos/site generate:api-docs`; commit the regenerated output; a second run must leave a **clean git tree** (deterministic) so the `openapi-fresh` gate stays green. Never hand-edit generated files.
- **Acceptance:** regenerated + committed; deterministic; `openapi-fresh` green (no diff).
- **Verify:** `pnpm docs:export-api && pnpm --filter @dorkos/site generate:api-docs && git status --porcelain docs/api` (empty after commit).
- **Deps:** 2.4. **Parallel:** 2.2, 2.3 (branch 1). **Size:** sm.
- **Spec:** Detailed Design B.6, Testing Strategy (Phase B — openapi-fresh).

### Task 2.6: Verify `source.ts` plugin + full Phase B gate + changelog assessment + ADR (B.7)

- **Files:** `apps/site/src/lib/source.ts` (verify — expected no-op), `decisions/<id>-agent-consumable-docs.md` (new ADR) + `decisions/manifest.json` (edit), optional `changelog/unreleased/<id>-...md` (only if user-visible)
- **Do:** confirm `openapiPlugin()` is v11-correct and supplies `getOpenAPIPageProps`; grep-confirm no removed v11 surface is used (`transformerOpenAPI`, `createCodeSample`, `generateTypeScriptSchema`, `ui/client`, `allowedUrls`/`groupStyle`/`disablePlayground`). Run the **full Phase B gate**: build incl. `/docs/api/*` prerender + `/docs/api` interactive render + `openapi-fresh` green + typecheck + lint. Assess Phase B changelog honestly (`### Changed` only if user-visible; default none). Extract the ADR via `/adr:from-spec` (decoupling D1/D2 + client `APIPage`/`getOpenAPIPageProps` D6 + reproduce-first O1).
- **Acceptance:** plugin verified, no removed surface, gate green, ADR written + manifest valid, changelog only if warranted.
- **Verify:** `pnpm --filter @dorkos/site build && pnpm --filter @dorkos/site typecheck && pnpm --filter @dorkos/site lint` + `node -e "JSON.parse(require('fs').readFileSync('decisions/manifest.json','utf8'))"` (+ manual `/docs/api` render under `next start`; `openapi-fresh` in CI).
- **Deps:** 2.3, 2.5 (transitively 2.2, 2.4, 2.1, 2.0). **Parallel:** none (serial tail). **Size:** md.
- **Spec:** Detailed Design B.7 + Removed v11 surfaces, Testing Strategy (Phase B gate), Documentation (changelog + ADR), Related ADRs.

---

## Next stage

EXECUTE — `/flow:execute specs/agent-consumable-docs/02-specification.md`. Dispatch Phase A (PR 1) first; open Phase B (PR 2) only after Phase A merges, and begin Phase B at task 2.0 (reproduce) — it gates everything else in B.
