# Implementation: Stable HTTP Test Listeners

**Created:** 2026-09-06
**Last updated:** 2026-09-06
**Specification:** `specs/stable-http-test-listeners/02-specification.md`
**Tasks:** `specs/stable-http-test-listeners/03-tasks.json`

## Progress

**Status:** Implemented
**Tasks implemented:** 11 / 11
**Independent reviews:** Stage 1 and fresh Stage 2 passed with 0 important findings and 0 nits

## Implemented

- **1.1 — Base and pre-edit trace.** Integrated merged DOR-1803 commit `1328ca1b60f72615956ab848cb8a1a7cd8626bab` and pinned tree `929a1ff05ebb83c377001d069b6dad8c9db08137`. The accepted Node 24.14.1 baseline collected all 133 files and passed 2,276 tests. Its lossless trace measured 3,224 listener starts: 3,185 Supertest, one existing stable helper, and 38 reviewed custom fixtures. The earlier incomplete trace remains preserved as test-health evidence only.
- **1.2 — Facade and helper regressions.** Added the `@dorkos/test-utils/supertest` public subpath, named `Test` and `Response` type exports, stable Server and HTTP(S) URL validation, and actionable callable-app/unbound-Server rejection. Added regressions for exact supplied-listener requests, loopback URL dispatch, invalid bind paths, and unmapped/app-A/app-B swappable routing. The focused 11 tests, test-utils typecheck, and test-utils lint passed; boundary and remount mutations made the owning assertions fail.
- **1.3 — Import guard.** Added a composed server-test restriction for `supertest` and its package subpaths without replacing runtime SDK confinement or type-import policy. Its executable fixture passed 59 ordinary, sibling-test, owner-directory, facade, and cross-owner cases; disabling the Supertest restriction made all 26 intended guard cases fail while the other 33 cases remained green.
- **1.4 — Already-stable imports.** Routed the 25 already-stable test files and their shared trigger-turn helper through the facade without changing listener ownership. The exact 25-file cohort passed all 469 tests.
- **1.5 — Testing guidance.** Documented fixed, hook-built, local-factory, and custom-protocol listener ownership, and corrected the helper documentation to distinguish measured listener churn from the unproven operating-system failure mechanism.
- **3.1 — Mixed-lifecycle fixtures.** Migrated the 16 mixed fixtures while preserving every original app-factory evaluation and lazy request boundary. The exact 16-file cohort passed all 379 tests; server typecheck and the owned-file lint checks passed.
- **2.1 — Module-initialized fixtures.** Applied the reviewed 50-file source patch from `f84a891f7f346babfeb6e9d85af098ec665247d0`. Its exact cohort passed all 743 tests, and its seven same-app durable SSE calls now share the owning listener.
- **2.2 — Hook-built fixtures.** Applied the reviewed 39-file portion of `3713c95d670335edda7f9f5bc2d2428883e3fd7c`. Its exact cohort passed all 654 tests.
- **2.3 — Local-factory fixtures.** Applied the reviewed 28-file portion of `3713c95d670335edda7f9f5bc2d2428883e3fd7c`. The first exact cohort exposed one collapsed app construction; the author restored that and the remaining syntax-audited construction boundaries, then passed focused coverage for every corrected file. The final static proof preserves every original factory evaluation.
- **3.2 — Integration reconciliation.** The applied 50-file and 67-file patches match their authors' post-format hashes. Static analysis accounts for 133 unique migrated fixtures and all 2,133 known calls within an unchanged 2,267 total factory calls, including 134 already-bound calls in `config.test.ts`. All 158 test files and the shared helper import the facade; no direct Supertest runtime import or namespace type remains.

Exact task 1.1 and 1.2 proof is archived from `.dork/flow/evidence/` by the coordinator.

## Roster

- **Facade/integration lane:** this worktree, `codex-stable-http-tests`; tasks 1.1–1.5, 3.1, 3.2, and 4.1.
- **Module-initialized lane:** retained worker `/root/connections_broker_impl` in `codex-stable-http-module-fixtures`; task 2.1, including seven observed same-app SSE collector calls.
- **Hook/local-factory lane:** retained worker `/root/connections_foundation_impl` in `codex-stable-http-factory-fixtures`; tasks 2.2 and 2.3.
- **Coordinator:** shared commits, integration gates, review, pull request, and merge.

## Fixture-construction invariant

Every migration preserves the source test's original app-factory evaluations and mounts each resulting app at that same boundary. Dependent requests that already shared one app stay on one mount; a later original factory call may remount only after the prior lazy request has settled.

## Completion

- [x] 1.3 Supertest import guard and executable fixture.
- [x] 1.4 Already-stable import and shared-helper migration.
- [x] 1.5 Testing-rule documentation.
- [x] 2.1 Module-initialized fixture migration.
- [x] 2.2 Hook-built fixture migration.
- [x] 2.3 Local-factory fixture migration.
- [x] 3.1 Mixed-lifecycle fixture migration.
- [x] 3.2 Lane integration and 158-import reconciliation.
- [x] 4.1 Independent review stages.

The final Node 24.14.1 trace passed all 2,276 tests in the same 133-file cohort and observed 149 listener starts and closes: 141 helper-owned and eight reviewed custom fixtures, with zero Supertest-origin starts. The one full `pnpm verify` passed with 41/41 typecheck and lint tasks and 22/22 test tasks. The exact pushed source tree at `21226a00f56dd09ec11105a022b454d4a8114a66` then passed the zero-cache pre-push gate with 22/22 tasks.

The final Stage 1 specification review passed with 0 important findings and 0 nits; its report hash is `b6baaf3c2b09b3d95d446ddf229517d74d86156ce0120a67fac8dd74cb7f5361`. A fresh Stage 2 quality review independently read the same pushed tree and passed with 0 important findings and 0 nits; its report hash is `1a8d60c9e1380240f8319cc7c7df4a73d0260a586399350e09e7c88599361c95`. Stage 2 also proved the multi-app boundary by changing one request to the prior mounted app: the focused result changed from 6 passing tests to 1 failure and 5 passes (`429` instead of `200`), then returned to 6 passes after restoration. Reviewer task provenance is recorded below.

- **Stage 1 reviewer:** `/root/http_listener_spec_review` (`gpt-5.6-sol`, high reasoning)
- **Stage 2 reviewer:** `/root/http_listener_quality_review` (`gpt-5.6-sol`, high reasoning; fresh review context)

Both reviewers sequentially owned the clean `codex-stable-http-review` worktree on host `DC-MBP-M4-2.local` under parent Codex session `01a0732c-cb71-7513-8217-375eaeddcdb0`. The coordinator read and accepted both complete reports.

The reviewed source tree is unchanged by this completion metadata. Pull-request creation and merge remain pending. The work does not claim a proven operating-system failure mechanism.
