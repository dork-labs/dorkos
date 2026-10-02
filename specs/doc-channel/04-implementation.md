# Doc Channel implementation record

**Status:** EXECUTE authorized; task 1.1 merged. Authority/ingest integration and later delivery phases remain in progress.
**Issue:** DOR-2665
**Worktree:** /Users/doriancollier/.codex/worktrees/171d/dorkos
**Branch:** codex/doc-channel-authority
**Current integration base:** e3210be2cb14c823696a213f4df0ab21fa8acdd8

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

## Foundation merge and authority/ingest integration

Foundation PR #2458 merged through the normal queue at 2026-10-01T22:44:08Z,
commit e3210be2cb14c823696a213f4df0ab21fa8acdd8. Both independent review stages
converged on pushed head 778d32f; normal PR and merge-group checks passed.
Parent personally fetched/verified the merge, recorded Flow ci merged, and used
normal release/reclaim to continue EXECUTE on codex/doc-channel-authority. No
Flow DONE or parent closure: completed count is 1/22. Both ADRs stay proposed.

The bounded next change integrates lifecycle 1.2, exact grant/manifest services 2.1
and ingest/accounting/retention 2.2 onto verified main. Lifecycle independent
reviews converged at 48fbf76: initial findings on original execution path and a
stale post-await identity were corrected with real SQLite regressions. Final
canonical authority is returned; rekey requires unchanged original source,
canonical/current agent and frozen approved target path. Grants independent
reviews converged at fc1a11d with 59 grant/manifest/consumption and 43 existing
approval-service tests. Approval notifications publish only after the actual
transaction commits; mutable target relocation cannot change the approved path.
These constituent reviews do not replace fresh exact combined-head reviews.

Ingest stage 1 converged at 0f4c5ed after a delayed async-validator regression;
thenable validators are typed/refused/observed before acceptance. Quality review
found repeated full-history totals and empty global accounting scans. Retention
now computes grouped totals once and adjusts exact compacted/deleted row and
orphaned batch sizes; the unmerged 0138 includes partial accounting and ordered
retention indexes. The new 1,000-row regression reports 4,000 aggregate calls under
old code and at most 2 after restoration; real EXPLAIN proves both access paths.
Existing 44 focused tests plus the new bounded-work test, server/DB types,
scoped lint, normal hooks and post-commit db:check pass. Corrected ingest pushed
a9bac093 still requires both changed-head review stages before acceptance.

Common opening/declaration/original-opener integration and production HTTP/Transport
are active task 2.3 work in the transport checkout, not claimed as delivered here.
Task 2.4 works separately on the actual document private source, runtime context
and recovery composition. Actual Relay awaits verified DOR-2660; frames await
verified DOR-2662 (DOR-2663 isolation already merged d19d3ee). Accounting 0138 remains
the sole migration writer window; DOR-2666 stays separate. No personal vault edits,
paid flags, fabricated review authority or protection bypasses.

Changed-head ingest review reproduced comment superseding when a route explicitly declares task.comment coalescible, and found that the migration index census had not included the two new indexes. A real migrated-SQLite regression failed before the comment guard; the correction preserves comment IDs and pending receipts in order. The migration census now checks both index columns and the exact partial accounting predicate. Fresh changed-head review remains required.

The corrected ingest leaf is pushed and remote-verified at cc67f238e6d82a2d00d82344127ceb6e28c48836. All five affected ingest/migration test files pass 34/34 on the final snapshot. The first added predicate assertion used the wrong SQL qualification and failed; correction and fresh verification passed. Normal hooks, server typecheck, scoped lint and diff checks passed. The original identical fresh-accounted benchmark fixture now measures 1.675 ms / 1.506 ms / 2.952 ms for 250 / 500 / 1,000 rows; timing is indicative, while query-count and EXPLAIN assertions guard bounded work. The generated internal-only changelog fragment is omitted from the combined change; the full feature needs a truthful release entry after delivery proof.

The final ingest leaf 1ad92993 passed both independent review stages after two
additional real regressions: a mutable callback could change its selected IDs and
matching SQL together, and a wrapped Drizzle failure hid the native SQLite storage
code. Admission now freezes the selected IDs and effective label before callback
execution, compares their persisted values before commit, and maps bounded native
cause chains to a disclosure-safe 507 storage refusal. Final 36 focused tests pass.

The combined authority branch integrates production HTTP/common opening and live
runtime ownership from a18b07be, private document source 1e002ca4, and downstream
state/acknowledgments e9959007. Private-source compliance review is clean with one
copy nit; its quality review remains pending. Both downstream review stages are
clean. Production composition now installs the document source beside existing
protected sources on the actual session queue before recovery, even when
Connections is disabled. Registered grant and downstream capabilities resolve the
actual production services through the shared dependency bag. A real migrated
SQLite composition test proves document writes and state patches and rejects
missing authority. The private source's neutral sentence includes the selected
action count; page payload remains in the structured fenced context.

A broader preparation verification run failed its client Transport parity check
while HTTP integration was in progress. The current Transport parity test passes
4/4. The first composition check exposed a module augmentation on a barrel that
shadowed the dependency interface; it now augments the existing definition leaf.
The UI argument census required its new exact schemas, including bounded JSON
preprocessing and the common opening declaration. Final combined verification and
both independent reviews of the exact pushed composition head remain required.
Task 2.5 and task 3.3 are active in isolated pump and widget checkouts; completion
remains one merged task of 22. Migration 0138 remains held, with the pump warning
marker behind a required persistence port until the next serialized schema step.

Private-source quality review at frozen 1e002ca4 requested changes: its typed
receipt-kind census still expected only two kinds, and that leaf carried the new
index census without the matching ingest schema/migration/snapshot. Independent
verification found 108 passing and two failing checks. The combined branch
already includes the actual two indexes from final ingest integration; its typed
census now includes document_event_batch while preserving unchanged existing
receipt rows and SQL schema assertions. This is a review finding, not a clean
leaf verdict. Fresh combined-head review must verify the correction.

The first full composition verification passed all affected typecheck/lint tasks
but stopped at the shared additional-context exhaustive test: its runtime census
had not included the new doc_events member. It reported 2,806 passing shared tests
and one failing census. The census is corrected without changing the context
contract or weakening its exactness assertion; a fresh full verification remains
required. Combined production composition is committed at 85376f914 before this
census correction, not yet pushed or claimed clean.
