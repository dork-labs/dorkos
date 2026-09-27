# Audit delivery verification

Recorded 2026-09-26 on macOS at source baseline `7168a5b7c69def16bb2cb48319b24285c9894a3f`. Documentation is the only tracked change. These runs credit existing executable evidence; they do not test the proposed future disposal API.

## Local checks

- `pnpm install --frozen-lockfile`: completed without lockfile changes.
- `pnpm --filter @dorkos/server... build`: exit 0. Builds existing dependencies for local tests; no deployment or billable service.
- First targeted run: **16 suites, 397 tests passed**, exit 0.
- Uninstall/classification run: **3 suites, 79 tests passed**, exit 0.
- Both diagnostic fixtures: exit 0; exact code and results are [preserved here](../../research/20260926-marketplace-retained-copy-reproduction.md). They prove local scanner/copy behavior, not native harness execution or an approval bypass.

The first invocation also supplied two misordered uninstall paths, which selected no extra files. Those omissions were noticed and corrected in the second run below. The first command is shown with only its 16 actual selected suites so it is directly reproducible.

```sh
pnpm vitest run \
  apps/server/src/services/marketplace/__tests__/transaction.test.ts \
  apps/server/src/services/marketplace/__tests__/install-recovery.test.ts \
  apps/server/src/services/marketplace/__tests__/install-recovery-ownership.test.ts \
  apps/server/src/services/marketplace/__tests__/transaction-concurrency.test.ts \
  apps/server/src/services/marketplace/__tests__/transaction-ownership.test.ts \
  apps/server/src/services/marketplace/__tests__/ownership-flows.test.ts \
  apps/server/src/services/marketplace/__tests__/failure-paths.test.ts \
  apps/server/src/services/marketplace/__tests__/backup-janitor.test.ts \
  apps/server/src/services/marketplace/lib/__tests__/uninstall-journal.test.ts \
  apps/server/src/services/session/__tests__/session-list-broadcaster.test.ts \
  apps/server/src/services/session/__tests__/session-list-broadcaster-asks.test.ts \
  apps/server/src/services/search/__tests__/search-indexer.test.ts \
  apps/server/src/services/search/__tests__/sweep-guard.test.ts \
  apps/server/src/services/tasks/__tests__/task-scheduler-service.test.ts \
  apps/server/src/services/harness/__tests__/skills-watcher.test.ts \
  apps/server/src/services/marketplace/__tests__/package-cache-retention.test.ts

pnpm vitest run \
  apps/server/src/services/marketplace/__tests__/flows/uninstall.test.ts \
  apps/server/src/services/marketplace/__tests__/flows/uninstall-in-place.test.ts \
  apps/server/src/services/marketplace/lib/integrity/__tests__/strict-record.test.ts
```

No full-server restart, new SIGKILL exercise, Windows recovery proof, live agent turn, Cloud/Community verification or CI configuration change was performed. Historical process-kill evidence is credited separately in the recovery matrix. No generic recovery suite was added.

## Design completion boundary

The ownership map and pilot are specified, not implemented. DOR-2428 owns future local implementation; DOR-2429 owns separately selected central-adoption design. DOR-2340 and DOR-2341 retain their existing records with deferred approval/ownership decisions. DOR-2349 remains open beyond its local DOR-2427 slice.

Independent review and merged PR evidence are attached to DOR-2347 and DOR-2427 at closeout. A green docs-only PR check does not substitute for the explicit local test results above.

## Class-local pilot verification

DOR-2428 was explicitly selected on 2026-09-27 after the design delivery. Implementation starts from pinned base `4eb4d1f40b796253c7839990090626b6f79c75a9`. The audit evidence above remains historical; it is not evidence for the new disposal API.

The production boundary is `workspace-reconciler.ts` plus focused adjacent tests. Existing constructor callers and the five-minute cadence are preserved. The root still starts the reconciler without adopting terminal disposal. This pilot therefore establishes no server-wide shutdown deadline, restart safety, startup rollback or lock-release ordering.

### Verification record

- Dependency installation and `pnpm --filter @dorkos/server... build`: exit 0, no lockfile changes.
- Initial TDD run: 14 tests collected, 10 failed and 4 passed. Failures identified the missing disposal API, overlapping work and unref rollback defect.
- Expanded unmutated baseline: **18 tests passed**. The real class runs against a narrow store boundary with fake timers and deferred checkout/manifest reads.
- Fence mutation: removed only the two post-read generation checks. Running `pnpm vitest run apps/server/src/services/workspace/__tests__/workspace-reconciler-lifecycle.test.ts -t 'fences late writes'` failed exactly **2 selected tests**, at the intended late `removeRow('workspace-1')` and changed-manifest `upsertRow` calls.
- Overlap mutation: removed scheduled pending-work skipping and manual pending-pass joining. Running the same file with `-t 'skips pending ticks'` failed exactly **1 selected test**: `store.list` ran 7 times instead of 1.
- Restored the byte-identical implementation, confirmed with comparison to the pre-mutation source, then ran the complete focused file: **18/18 passed**, exit 0. `git diff --check` passed.
- `pnpm lint:root`: exit 0, 10 existing warnings in unchanged root scripts.

The tests include same-input positive controls for both deferred read boundaries, exact default/injected deadlines, stable concurrent/repeated disposal promises and outcomes, late completion/rejection, failed interval/unref acquisition retries, stop/start overlap, and exact unchanged cache counts. No arbitrary sleeps or real agent turns were used.

- Workspace directory run: **108 passed, 1 timed out** across 8 files. The unchanged `resolve-session-cwd.subagent.test.ts` source scan hit its 5-second deadline; its first isolated retry also timed out. After builds settled, the exact test passed unmodified on the current source (2.42-second test time) and pinned-base source (1.22 seconds). The comparison temporarily restored the only changed production file, then restored the implementation byte-for-byte. No timeout or assertion was weakened. This supports a transient timing failure, not a new resolver regression.
- `TURBO_SCM_BASE=4eb4d1f40b796253c7839990090626b6f79c75a9 pnpm exec turbo run typecheck lint --affected`: **40 tasks successful**, exit 0 (29 cache hits). This includes server and dependent CLI, desktop and evaluation checks. Existing warnings remain outside this change.

- Root script gate was run in components to retain the pinned base and isolated scratch directory. `pnpm test:scripts` passed through the shell fixtures until the inherited `DORKOS_HEAVY_LOCK=0` run setting made the lock fixture fail. Re-running from that fixture with the override removed passed all 29 lock checks and the subsequent shell checks. The Node script fixtures initially discovered the enclosing repository through the in-worktree temporary directory; setting `GIT_CEILING_DIRECTORIES` to that temporary root restored their intended standalone-fixture environment. All **52 Node script tests passed**. Fixture-generated manifest entries were removed; the final manifest diff changes only this pilot's status and issue pointer. No script, assertion or timeout changed.

- Documentation coverage map: in sync, exit 0.
- Root Vitest: **695 passed, 4 failed** across 41 files. This is **not a passing local gate**. Two `q3-contention` fixtures require a trusted OS-temp path; the bare-checkout hook fixture requires no ancestor `node_modules`. In-worktree `TMPDIR` violates those three fixture preconditions. The fourth failure is the retired whole-line comment filter in unchanged `apps/client/src/__tests__/status-color-classes.test.ts:116`. A direct equivalent reproduction reads that file at the pinned baseline and applies the exact census regex, matching the same line; a shared-lexer call is the nonmatching control. No census guard, client source or CI change belongs to this pilot. Required clean PR and merge-queue checks remain the landing prerequisite.
- The source-census follow-up is [DOR-2470](https://linear.app/dorkspace/issue/DOR-2470) - Resolve the status-color guard’s retired comment-filter census failure. It remains separate maintenance work, with no readiness or implementation folded into this pilot.

- The affected package test gate's server leg passed: **1,243 files passed, 2 skipped; 21,569 tests passed, 54 skipped**. This includes the new lifecycle suite, 16 existing workspace integration tests using real Git/database fixtures, and the unchanged source-scan test that had timed out in earlier isolated runs. The skips are existing opt-in cases; no paid/live flags were enabled.

- `TURBO_SCM_BASE=4eb4d1f40b796253c7839990090626b6f79c75a9 VITEST_MAX_WORKERS=4 pnpm exec turbo run test --affected --concurrency=1 -- --run`: **19 tasks successful**, exit 0. In addition to server: CLI **1,337 passed / 2 skipped**, desktop **814 passed**, evaluations **572 passed / 1 skipped**. Total: **24,292 passed / 57 skipped**, 1,422 passing files and 3 skipped files. All test scratch used the isolated worktree's temporary directory.

These are the pinned-base components of the affected verification workflow, not a claim that a single `pnpm verify` invocation passed: the root Vitest limitations above remain explicit. No live deployment, agent turn or paid inference was run.
