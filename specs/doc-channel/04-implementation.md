# Doc Channel implementation record

**Status:** EXECUTE authorized; task 1.1 implemented and under final verification/review. Full delivery remains in progress.
**Issue:** DOR-2665
**Worktree:** /Users/doriancollier/.codex/worktrees/171d/dorkos
**Branch:** codex/doc-channel-foundation
**Pinned source/base:** 996161118a84f938fe76b6e569ba077dfb7a574a

## Run assumptions — 2026-10-01

- Human explicitly selected GPT-6.1 Sol with Medium reasoning for implementation, analysis and independent review subagents; this overrides Flow tier bindings.
- Human authorized this assigned scope through commits, pushes, independently reviewed PRs, the normal merge queue, verified merge, Flow DONE and safe cleanup. Earlier read-only/push approval handoffs are superseded.
- All source, tests, specs and manifest edits stay in owned isolated worktrees. Coordinator clarified that installed Flow's canonical shared ignored operational journal/run store is permitted.
- Direct assigned issue advancement follows Flow issue routing. Global queue snapshot reports four claimed items against cap three; no unrelated claims are touched. The coordinator later released the fixes implementation slot when DOR-2663 entered review, explicitly authorizing this lane to claim and implement before its merge. No global cap/configuration or unrelated claim was changed.
- Full v1, v1.1 and v2 scope remains assigned. Supporting issues and managed-browser replacement belong to other lanes. Vault consumer is read-only input; migration contract is proved with fake fixtures.
- This harness has no Task API display. Once generated, 03-tasks.json is canonical, with 03-tasks.md as readable projection.

## Session 1 — 2026-10-01

**Workers:** /root/source_audit (read-only server investigation); /root/consumer_contract (read-only consumer investigation).

### Done

Verified managed linked worktree, read repository and Flow rules, resolved configured Linear adapter and re-enabled canonical journal after coordinator clarified metadata exception. Seeded only Doc Channel source artifacts and two proposed ADRs. Flow stage SPECIFY succeeded with checkpoint and readback. No implementation claim or production edits.

### Findings under reconciliation

- Current private session acceptance service already supplies atomic durable source consumption, queued placeholders, stable receipts, dispatch CAS and boot outcome_unknown quarantine. Doc batches should extend that seam instead of inventing a parallel session admission ledger.
- Projector turn_start currently precedes runtime iteration; it is a DorkOS dispatch observation, not backend admission proof.
- Canvas scope rekey currently runs as a best-effort observer and cannot establish the draft's claimed atomic canonical session/channel move.
- Reference consumer drops SDK event IDs at v0 writer endpoints and runs its own notifier; migration needs an explicit handoff so retained writes do not create two turns.

### Next

Resolve source findings in SPECIFY; independent adversarial spec review; canonical decomposition; take the next available programme implementation slot.

### Open questions

No major product choice identified. Technical review pending. Parent issue remains open throughout partial PRs.

## Specification review and decomposition

Independent reviewer: /root/spec_review, GPT-6.1 Sol/Medium. Initial pass found
two blockers: accepted wire events exceeding every rendered prompt slice, and
canonical rekey omitting the reused shared receipt/queue. Both were corrected;
changed-scope review converged after removing one stale limit fragment.

Decomposition worker: /root/source_audit. Canonical 03-tasks.json and readable
03-tasks.md contain 22 pending tasks across six phases (2/8/4/5/2/1). Task 2.6
(room admission) and 4.3 (checkbox crash safety) are XL and were promoted as
DOR-2669 and DOR-2670, each with native Fibonacci estimate 8 and stage/decompose;
they stay unready until prerequisites pass. Parent native estimate is also 8.
remaining tasks stay internal. Parent validation confirmed unique IDs, acyclic
dependencies and no forbidden placeholder descriptions. Keep admission source
union/DB enum/registration changes together in task 2.4 so foundation ships with
the two existing sources intact.

Coordinator accepted SPECIFY convergence and assigned this lane the next
implementation slot after DOR-2663's verified merge. Managed browser pixel
viewing does not replace iframe transport; retain the lightweight preview. Later
compatibility proof covers zero-viewer delivery/replay, two viewers without
duplicate emission and navigation retiring prior transport.

## Direct-session shipping authority

The coordinator confirmed the explicitly delegated direct-issue programme uses
independent adversarial review of the exact pushed head, truthful review/evidence
records, Flow REVIEW and the repository's normal gh auto-merge/merge queue path.
After verified final merge use Flow DONE. This overrides the generic skill stop
for this run without changing project-wide autonomy/calibration. Never approve
as a person, manufacture a reviewer token or route around an actual refusal.

## Verification preparation

Fresh-worktree pnpm verify initially stopped on missing generated Harness imports.
A targeted Harness build exposed its missing cloud-api dependency output; turbo
then restored the six-package Harness dependency build successfully from cache.
The repository gate is running again over the prepared specification branch.

## Session 2 — 2026-10-01

**Workers:** /root/contracts (shared contracts, then lifecycle design); /root/storage_schema (DB migration); /root/source_audit (transaction store). All use the explicitly selected GPT-6.1 Sol/Medium.

- Task #1.1: Define channel contracts and durable storage — shared worker /root/contracts in `/Users/doriancollier/.codex/worktrees/doc-channel-contracts/dorkos`; DB worker /root/storage_schema in `/Users/doriancollier/.codex/worktrees/doc-channel-storage/dorkos`; store worker /root/source_audit in this checkout while the parent withheld source edits. Parent integrated the disjoint commits serially.
- Shared schemas distinguish public input, agent downstream input and trusted system records, validate bounded JSON before recursive parsing, and export the leaf subpath/common options. No transport or document admission source is activated.
- Seven additive SQLite tables retain channel history independently of physical documents. Schema placement is `packages/db/src/schema/canvas/channel.ts`, refining the proposed root file to satisfy the directory-size guard and existing nested-schema convention. The generator reused an existing filename because the historical journal skips 0133; preserving the old snapshot and naming the additive child 0137 leaves historical migrations unchanged. Normal post-commit db:check reports no schema changes and a clean migration directory.
- The synchronous store composes event/sequence, grants, batches/deliveries, state revisions and recoverable intents in caller transactions. Accepted batch input is immutable, leases are fenced by generation/attempt, and corrupted stored JSON raises a typed failure.
- Worker verification passed: 160 shared contract/existing tests; 22 DB migration/existing tests; 14 real SQLite store tests; relevant typecheck/lint/build; forced workspace typecheck 41 tasks. Removing state revision, frozen-input and renewed-attempt guards failed exactly their intended store tests; restoration passed all 14. Parent reran the three new test files: 80 tests passed. Existing unrelated lint warnings remain.
- Normal API export and site API-doc generation ran after preparing the server dependency builds; only the intended OpenAPI schema additions changed. The first aggregate run found a missing explicit seven-table migration census; the census was corrected and all 234 DB tests passed. The second aggregate pnpm verify passed all 36 tasks. Superseded receipt typing/reopen and valid JSON-null event persistence were added before review; the combined three foundation test files passed all 82 tests. Independent spec compliance passed on 2b0361b, then quality review found one important expired-transaction continuation defect and one JSON-null batch nit. Transaction/query handles now retire on every exit, promise-returning callbacks are rejected at typed/runtime boundaries, and batch null persists consistently. Five new regressions, including rolled-back nested savepoint handles, bring the focused total to 87; removing handle retirement fails the three intended delayed/retained-handle tests. Restored store tests, server typecheck and scoped lint pass. Both stages must re-review the changed pushed head before PR.
- Specification PR #2456 is independently reviewed at e71f11ebfd4aa0276977b822065b60e4c482d2b5, uses Refs DOR-2665, and merged through the normal queue at 2026-10-01T21:09:38Z, commit 27aa09a0b597c6e5429cb2ca39bdccab064e22b3. It does not complete the parent.

**Completed count:** 0/22 until task review converges.

**Next:** finish task 1.1 final refinements/review/merge; task 1.2 lifecycle is committed separately at 70382f9dc115cda9888fc3f1c1ab77399b0feaaa, with 152 targeted tests and a final 32-test backfill rerun, server typecheck/build and normal hooks passing. Grants and ingest remain in progress in their isolated branches. Pre-delete hooks must cover agent close, user close, eviction and orphan sweep. Canonical movement must include linked accepted-unclaimed receipts and queue rows with source-specific digest revalidation; claimed effects remain uncertain. Reopening a deterministic file ID must create a fresh document incarnation while preserving old tombstone/grants.

### Phase-branch tracking

After the specification merge, normal Flow release preserved a signed phase-transition reason and checkpoint. Reclaim on the foundation branch was refused because the configured ownership class was other. The coordinator reassigned this explicitly delegated issue to the configured agent through the Linear adapter; normal claim and checkpoint then succeeded on the foundation branch. No ownership/autonomy settings or reviewer state were changed. Normal report pushed requires a drain-started run and refused this direct-session run; verified remote SHA/checkpoint and truthful journal records preserve the evidence without fabricated drain state. The full-scope delivery remains authorized and open.
