# Implementation Summary: Full capability MCP schemas

**Created:** 2026-11-16
**Last Updated:** 2026-11-17
**Spec:** specs/capability-mcp-full-schemas/02-specification.md

## Progress

**Status:** Implementation complete; delivery pending
**Delivery:** Pending final clean commit, exact-head full verification, push, PR/security review and merge. Root independently confirmed DOR-4485 and DOR-4152 Done on 2026-11-17.
**Tasks Completed:** 4 / 4

## Tasks Completed

### Session 1 - 2026-11-16

**Workers:** `/root/mcp_2067_decompose` (analysis), `/root/mcp_2067_task_1_1` (implementation, tasks 1.1–3.2 reviewed).

- Task #1.1: Introduce strict full-object projection and prepare extension listability — worker: `/root/mcp_2067_task_1_1`; independent reviewer: `/root/mcp_2067_review_1_1`; CLEAN Stage 1 then Stage 2 at `b6a0397deacaaa308799a17926ebf92d81faa1fd`.

## Files Modified/Created

**Source files:**

See per-task records and sealed source inventories below.

**Test files:**

See per-task records and sealed source inventories below.

## Known Issues

See per-task records and sealed source inventories below.

## Implementation Notes

### Session 1

All four source tasks independently reviewed; final delivery is pending.

## Orchestration and evidence boundaries

- Worktree: `/Users/doriancollier/.codex/worktrees/runtime-parity-mcp-schema/dorkos`; branch `codex/runtime-parity-mcp-schema`; source base `1cc1a721518d4287412ea1a6ef33e9283b576594`.
- Root session: `01a1e0c1` (public session prefix); owns Flow claim, actual Linear plan projection/readback, stages and final delivery.
- Frozen specification SHA-256: `733e9fa50b6753d1055d379a90f0e550bf0a1575070d51e27b49e2ac75b46b75`; canonical task JSON SHA-256: `b8193cccb70bb276260f5e558b52d622c831ff27f8758f5996c11b9fa1e6ab9b`. Definitions remain unchanged during execution; this file and actual tracker checklist hold progress.
- Four serial dependency-valid batches: `1.1 → 2.1 → 3.1 → 3.2`. Each source task receives an independent REVIEW.md Stage 1 then Stage 2 pass before it counts complete. No simultaneous writers in this checkout.
- Task API tools are unavailable. Canonical JSON/Markdown, this explicit progress file, actual Linear phase checklist/readback and Flow task checkpoints are the truthful substitute; no live task IDs or calls are invented.
- Model policy: classes use workhorse, bindings are empty. IDEATE/SPECIFY used the inherited harness default with no binding; DECOMPOSE explicitly used available `gpt-6.1-sol`. Subsequent analysis, implementation and review delegates explicitly name the available workhorse fallback.
- Internal change: `chore(...)` subject, no fragment, eventual `skip-changelog`; never `skip-review`. All normal hooks and exact-head full verification remain required.
- DOR-4485 remains a typed delivery dependency. Root's separate prerequisite full gate at e962 failed in config setup and task launch readiness; DOR-4519 and DOR-4521 track the required repairs. No worker starts another full gate or touches that tree.
- Runtime implementation through task 2.1 is reviewed locally; delivery is outstanding. Offline planning and SDK probes are not native, live-model or production-service evidence. No paid/provider/auth operations are authorized here.

### Historical batch 1 before completion

Task 1.1 is in progress, not complete. Root validated the actual phase 1 tracker mutation and a fresh account-pinned Flow readback (only the observed single blank-line Markdown normalization), 0/4. DECOMPOSE released ready/execute; root manually reclaimed EXECUTE in the same worktree. Execution analysis confirmed no missing dependency or cycle. The implementation worker may make normal source-only per-task seal commits after its checks; root owns final squash/publication/delivery. Planning files remain intentionally uncommitted until the completed migration.

### Task 1.1 reviewed completion

Source head `b6a0397deacaaa308799a17926ebf92d81faa1fd`, base `1cc1a721518d4287412ea1a6ef33e9283b576594`, unpublished. Six source/test files sealed against both committed and disk bytes. Strict full-object projection and extension listability preparation are complete; existing raw registrar/helper/export remain live until task 2.1 and no final retirement is claimed. Author and independent reviewer each ran 71 tests in four files; independent strictness removal produced exactly two intended failures and shape reconstruction exactly one refinement failure, followed by 71 restored green. Shared/extension builds and affected types/lint passed; server and spaces typecheck required the established 8GB heap (the initial 4GB OOM is retained and uncredited). Author normal commit hooks passed 27 lint tasks. No full gate, source push or native/model/production-service claim.

Independent report: `.dork/flow/tmp/2067-task-1.1/independent-review.md`. Phase 2/task2.1 remains pending until root verifies the regenerated real tracker projection/readback and task checkpoint. Canonical task definitions and frozen specification hashes remain unchanged.

Phase 2 write gate released after actual plan/readback and measured Flow task1.1 checkpoint at b6a0397 (unpublished, intentional planning dirt). Originating worker `/root/mcp_2067_task_1_1` resumes task2.1 under the same explicit gpt-6.1-sol workhorse fallback.

### Task 2.1 reviewed completion

- Task #2.1: Migrate both MCP registrars and retire portable helpers — worker: `/root/mcp_2067_task_1_1`; independent reviewer: `/root/mcp_2067_review_1_1`, explicit gpt-6.1-sol workhorse fallback; CLEAN Stage 1 then Stage 2 at `4f5d9174740329dc8a3a6d997b059dd9f344a03e` (base `b6a0397deacaaa308799a17926ebf92d81faa1fd`), unpublished.
- All 27 owned paths checked against committed and disk bytes. Full ordinary Claude/external registrars retain SDK factory metadata, digest, hidden filtering and existing callback/authority policy. Portable source/export/helper and live consumer references are retired; the hand-tool guard remains. Living guide/INDEX and affected tests migrated. Exact paths and hashes: `.dork/flow/tmp/2067-task-2.1/root-source-seal.json` and `handoff.json`.
- Author 333 cases/18 files; independent baseline and restored runs 342/18 with independently selected adjacent suites. Raw-map registration mutation produced exactly two intended in-session unknown-key failures while two external controls passed; metadata removal produced three intended actual wire-list failures. Both byte-restored. Shared/extension builds/types/lint, 8GB server/Spaces typecheck and normal commit hooks passed. One pre-existing changed-file lint warning remains.
- Independent report `.dork/flow/tmp/2067-task-2.1/independent-review.md`, SHA256 `c6b27550383e0c6fab5babef7ac1c98d11dbb8ae80e2a2aef8017e352d45daf3`. Hidden/no-ignore sweep found no living consumers; canonical historical planning references remain contextual.
- Progress 2/4. Broader census/default-node/canvas/approval/extension matrix is task 3.1; final migration handoff is 3.2. Neither is complete. Root must validate actual phase 3 projection/readback and checkpoint before releasing the next writer.

### Task 3.1 reviewed completion

- Task #3.1: Prove current parse semantics and authority boundaries — worker `/root/mcp_2067_task_1_1`; separate reviewer `/root/mcp_2067_review_1_1`, explicit gpt-6.1-sol workhorse fallback; CLEAN Stage 1 then Stage 2 at `5c723eb22d24d3fa928905be538734c7a079a911` (base `4f5d9174740329dc8a3a6d997b059dd9f344a03e`), unpublished. Six test/helper paths sealed against committed and disk bytes; production unchanged.
- Current composed census: 131 total / 129 MCP-relevant / 117 ordinary union / 116 in-session / 84 external / 12 private IDs. Original 29 default nodes (15 top-level fields across 14 capabilities), 11 numeric coercions and both actual canvas inputs at 16,384 accepted / 16,385 refused bytes cross actual SDK and original registry schemas. Real approval service/local DB covers hash binding, tokens, pending/holds/denial/cancellation and fresh per-call facts; safe list_capabilities is the production-handler positive. Extension accepted/refused siblings list beside core. Recording handlers are schema proof, not production service or live model proof.
- Author and independent reviewer baseline/restored each 420 tests across 23 explicit files. Independent strictness removal fails exactly two wire gate subjects, object reconstruction exactly one refinement subject, metadata removal exactly three actual listings; production bytes restored. Author 8GB server/Spaces types and lint pass (145 existing warnings); own six-path lint clean; normal commit hooks 29/29. Reviewer independently built own shared/extension dependencies and ran lint, avoiding a competing full gate.
- Report `.dork/flow/tmp/2067-task-3.1/independent-review.md`, SHA256 `d5dcfde75eb5f3f78a92365c0cd01514531d99a358278b45b2ca15c7f8f53006`. Exact owned paths/hashes and fixture limits in handoff/root-review-seal.
- Progress 3/4; 3.2 is pending. Root validates actual phase 3 checklist/readback and task checkpoint before releasing the originating writer. Primary immutable 514 full verification is running elsewhere; DOR-4485 delivery dependency remains unresolved. No source push, final full receipt, PR, native/model or merged-delivery claim.

### Task 3.2 reviewed completion and implementation handoff

- Task #3.2: Verify retirement and hand off immutable-head delivery evidence — worker `/root/mcp_2067_task_1_1`; separate reviewer `/root/mcp_2067_review_1_1`, explicit gpt-6.1-sol workhorse fallback; CLEAN Stage 1 then Stage 2 at `96bf522d5a6af2df8be9d3295606313229061925` (base `5c723eb22d24d3fa928905be538734c7a079a911`). Source was unpublished during task review.
- Five changed paths are the developer guide, INDEX and three comment-only TypeScript modules. Independent normalized TypeScript and emitted JavaScript match reviewed 5c; all six task 3.1 test/helper hashes are unchanged. All 36 cumulative changed paths were independently checked against committed and disk bytes.
- Fresh retirement inventory: 15 explicitly historical planning lines, zero living consumers. All 170 shared export type targets exist; Node executes a known shared export and refuses the removed portable subpath with ERR_PACKAGE_PATH_NOT_EXPORTED. Seven guide paths, conformance anchor, INDEX, scoped lint and formatting pass. Normal hooks pass 29/29 lint tasks.
- The preceding independent 420/23 baseline/restored runs and 2/1/3 strictness/refinement/metadata controls carry across proven identical executable/test bytes; no expensive unchanged runtime test repetition is claimed. No native/model or full-gate evidence is inferred.
- Report `.dork/flow/tmp/2067-task-3.2/independent-review.md`, SHA256 `5fa962e0269a619dc097e69fc975aed36f9f68a71969913dc7a49010b8fed763`. Frozen specification and JSON task definitions remain byte-identical.
- Implementation progress is 4/4, not merged delivery. Root must validate the actual final checklist/readback and measured checkpoint, commit the planning artifacts with normal hooks, obtain final published-head review, resolve DOR-4485, run a genuine exact-head pnpm verify and use the normal PR/queue gates. DOR-4485's c8 full gate is running separately; no competing full gate is authorized here. This internal chore has no fragment and uses skip-changelog, never skip-review.

## Current composition and verification — 2026-11-17

The earlier sections above are retained historical task records, including their old counts and unresolved prerequisites at the time. This section supersedes their delivery status; it does not convert any failed or old-head proof into a current pass.

- Current owned checkout: `/Users/doriancollier/.codex/worktrees/runtime-parity-mcp-final/dorkos`, branch `codex/runtime-parity-capability-schemas`, main base `c0e4d14e18f36944999aff305efbbbbc670468ac`. Old clean source `f36220f590e6854336a0a84d3ffabd9761f75e0c`, its prior proofs and failed full attempts remain preserved in the old checkout.
- Root independently confirmed the actual DOR-4485 and DOR-4152 deliveries are Done before claiming this VERIFY lane. Root personally reviews source and evidence under REVIEW.md, following the latest user instruction; no new delegated review or DorkOS Desktop/app delegation was used for this composition.
- Only the original 47-path delta from `65c5fa9ebd7ef402ac7581275cb56f5c6a43fe3d` to f362 was replayed. All 44 non-documentation blobs were initially exact old-source bytes; the three living documentation files deliberately combine main corrections with MCP guidance. Frozen specification `02-specification.md` and canonical `03-tasks.json` remain exact. Current main's manifests, lockfile, guard, heavy-slot wiring and permission/mark gates are preserved.
- Shared public exports are exactly 174 keys **and values**: current main's 175-entry map minus only the retired portable-input-shape export. This is an export count, not a test count. Living helper/source consumers are retired; historical planning references remain historical.
- Fresh owned frozen install and server dependency-closure build passed under the normal 153 guard and protected environment. Build: 17 successful tasks, five cached and twelve executed. No runtime binary or model was launched for this provisioning.

### Fresh baseline and static checks

One actual deduplicated baseline ran on the composed source: **557 tests in 32 files, all passed, no skips**, `--maxWorkers=1 --retry=0`, default plus JSON reporters. Its actual groups were 420 schema/authority subjects, 95 strict-consumer subjects and 42 current-main outside-words/alias/dispatcher subjects. The current-schema cases cover all 29 default nodes, coercions, canvas bounds, metadata, 12 principal-bound capabilities, real approval-service behavior and extension lifecycle/listability. Recording handlers and scripted SDK dependencies remain schema/authority-fixture evidence, not native production-service or live-model proof.

Four typecheck commands (server main plus Spaces, shared, extension-api and test-utils) and four corresponding lints passed. Formatting passed for all 46 existing candidate files; the 47th path is deleted. The original batch then **failed** documentation coverage at command 11: INDEX's coverage row omitted the intended MCP description and directory pattern. Commands 12–15 did not run in that failed batch. Its full logs, census and frozen source seals remain in `.dork/flow/tmp/mcp-baseline-001/`.

The first repair attempt incorrectly forced formatting of the ignored generated map, producing unrelated array wrapping. Its guarded follow-up refused with actual exit 75 before any child check ran. Both the forced-format artifact and zero-child refusal remain preserved in `.dork/flow/tmp/mcp-doc-repair-002/`; neither is credited as passing.

The approved narrow repair used the **real** coverage-map generator to restore canonical writer bytes and standard formatting only on INDEX. It preserved all main patterns and added only the intended MCP directory/description. The Nov 17 addition is attributed separately from the historical Nov 16 Claude review. Five lightweight checks then actually passed: documentation coverage; exact 174-export map/targets and living retirement scan; max-lines; own-mocks; and ledger coverage. Evidence: `.dork/flow/tmp/mcp-doc-repair-003/`. No behavioral baseline rerun was needed for that documentation-only correction.

### Fresh current-source removal controls

Root reviewed the exact mutants, subjects and protected launcher before one actual execution of `.dork/flow/tmp/mcp-control-proposal-002/launcher.py` under the normal guard. The launcher preserved and sealed protected HOME/CODEX_HOME/XDG values and absence, used a private DORK_HOME, and forwarded only the actual guard-owned slot token to test children. No paid flags, credentials, account/profile reads or native/model calls were added.

| Single mutant                                               | Intended failures | Positive passes | Restored selected passes |
| ----------------------------------------------------------- | ----------------: | --------------: | -----------------------: |
| Remove strictness from the shared projection                |                 2 |               1 |                        3 |
| Reconstruct an object from its raw shape, losing refinement |                 1 |               1 |                        2 |
| Pass a raw shape at ordinary SDK registration               |                 1 |               1 |                        2 |
| Omit ordinary SDK metadata                                  |                 3 |               1 |                        4 |

All seven intended failures matched the actual assertions: unknown-authority refusal at wire test line 168, invalid refined input at projection test line 149, and missing `activity_list` SDK metadata at exposure test line 884. The four positive subjects passed under their respective mutants. Each single mutant restored exact bytes naturally in `finally`, then reran the same selected subjects green: 11 restored passes across four runs. Thirty-six filtered cases per phase were not executed and receive no credit. Raw default logs had no unhandled/startup errors. Root personally read all eight actual JSON/status pairs, failures, positives and raw logs.

All 47 source hashes and staged tree `bb2f88790d5783b1e2978672969c5648ce2b375c` matched before/after controls. Projection SHA-256 restored `54cf48ae391992770b9245a918604ed257c86b8323ff257a41e4bbc3f0bfc7fe`; registrar restored `7fa273449ae3565108884413d3f6f944c8f7517223a8222378ffa2eec6077698`. This is fresh evidence for the current registrar, not a claim that an older registrar mutation ran on these bytes. Exact receipts: `.dork/flow/tmp/mcp-control-proposal-002/EXECUTION-REPORT.md`, `outcomes.json` and `execution/`; attempt manifest SHA-256 `c4bac5ff7107cbc14ea33b51fcbd09e50cc76eb0b537237679eba3c12cd7c741`.

### Delivery remains pending

Implementation is complete; delivered completion is not claimed. Final clean commit, genuine exact-head full verification and authentic receipt, source push, PR, security review and merge are **not done for this MCP candidate**. The historical failed MCP full runs remain failed. Runtime cohort c97's receipt cannot cover this source. This internal chore needs no changelog fragment and uses `skip-changelog`, never `skip-review`; normal hooks and root personal review remain required. No native/model/provider or shipped-service proof is inferred from the offline baseline and controls.
