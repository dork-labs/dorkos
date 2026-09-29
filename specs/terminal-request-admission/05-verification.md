# Admission-only verification

Work item: DOR-2551. This record covers A1–A5 only. Full terminal-action ownership, active-work drain and database/lock/successor permissions remain outside this implementation.

## Scope and environment

Pinned implementation base: `50bb34cb34b8fff8807a0f2663ca2005e1ec154f`. Tests use real loopback HTTP and WebSocket transport, real admission objects, controlled authorization/domain callbacks and disposable local fixtures. No paid inference, external service operation, production reset or process handoff is used as evidence.

Local shared and Cloud API outputs were stale after the checkout advanced. Rebuilding those packages restored imports/types. Import failures with zero tests and stale-type failures are prerequisite diagnostics, not regression-test evidence.

## HTTP boundary (A1–A3)

At the task 1.1 milestone, `pnpm vitest run apps/server/src/__tests__/app-terminal-admission.test.ts` passed six tests. Task 1.3 adds the seventh HTTP case for construction after closure. The combined seven-file HTTP/security group passes 77 tests total, including those six. The independent compliance and code-quality reviewers reran the six boundary tests.

The tests exercise the actual app and its first middleware, exact TCP connection reuse, a request whose body parser is still waiting, an admitted handler and an established SSE stream. A source-AST census derives 65 route/mount paths from app/root composition. Conditional root services are not booted; the census and generic refusal prove the app-wide placement without asserting those domains drained. Running authentication, host/origin policy, signed ingress and static behavior retain positive controls. HEAD preserves normal empty-body semantics.

The sandbox harness boot test (`packages/evals/src/runner/__tests__/harness-server.test.ts`, filter `boots against the sandbox DORK_HOME`) passes one test with eight skipped, without a credentialed turn. The app's required injection is supplied explicitly by root, the harness and existing test callers.

## WebSocket boundary (A4)

The admission and existing upgrade-router suites pass 59 tests total: 15 new and 44 existing. The independent compliance reviewer reran both suites. Entry closure precedes route lookup and credentials, including unknown paths. Controlled credential and route authorization resolve after closure with allow, refusal or error; no upgrade/open occurs. Both credential postures are exercised, including ordinary close-frame refusals. An established socket still exchanges messages after closure.

## Root closure and late listener (A5)

The restored combined admission/upgrade/workspace group passes 109 tests in eight files. It includes seven HTTP tests, with actual app construction after closure, five listener tests and three root wiring tests. The helper is tested with real Node listening events plus controlled synchronous acquisition and a close callback that never finishes. An already-listening server remains bound and its admitted request completes.

The actual root shutdown function is executed in an isolated VM with real admission/workspace owners and a sentinel that stops unrelated domain cleanup. Workspace fencing happens synchronously despite pending listener-close completion. Precise AST checks verify one root admission instance reaches app, upgrade and listener seams, and both cleanup entries close it before the direct workspace disposal await. These tests do not boot the whole root or prove all writers stopped.

The independent requirements review passed. Its combined run had 19 passes and one timeout in an existing workspace test's first dynamic import; that existing suite passed five of five on an isolated rerun. No assertion mismatch was observed.

## Mutation controls

| Mutation                             | Intended failure from green baseline                                                                            | Restoration                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Remove Express gate                  | Reused TCP request returns 200 instead of 503; one failed, five skipped                                         | Exact source restored; 77-test HTTP/security group passed |
| Remove upgrade-entry gate            | Route lookup occurs after closure and unknown route loses generic 503; two failed, 13 skipped                   | Exact source restored; 59 tests passed                    |
| Remove final post-authorization gate | Allowed/denied route decisions can accept or refuse with stale semantics; six failed, two passed, seven skipped | Exact source restored; 59 tests passed                    |

One initial mutation filter selected zero tests. It was corrected and is excluded from mutation evidence.

Additional root mutations each produced one intended failure with two other tests skipped: move ordinary admission closure after the workspace await; insert an unrelated await before startup admission closure; give HTTP a separate instance. The first two failed the precise first-statement ordering assertion; the last failed the exact one-instance assertion. Root source was restored after each, and the 109-test combined group passed. These are structural mutation controls supplemented by the real-owner VM behavior above.

## Final affected verification (task 1.4)

Verified source milestone: `d3181cbc0f29ed7af35ef8929eaa40f6fe8dc779`. The required `pnpm verify` phases were run sequentially with its moving `origin/main` lookup replaced by the pinned implementation base. The repository command was not changed:

```sh
unset TMPDIR
export TURBO_SCM_BASE=50bb34cb34b8fff8807a0f2663ca2005e1ec154f
export VITEST_MAX_WORKERS=4
pnpm test:scripts
pnpm lint:root
pnpm exec turbo run typecheck lint --affected
pnpm exec turbo run test --affected --concurrency=1 -- --run
```

The runner and all four phases exited **0**. Script verification passed its shell fixture groups, **52 Node tests**, and **732 Vitest tests in 41 files**; the docs coverage map was in sync. Root lint reported **zero errors and 11 warnings**. Affected typecheck/lint completed **40 of 40 tasks**, with **34 cached**; existing lint warnings remain, so this is not a zero-warning claim.

Affected testing completed **19 of 19 tasks**, with **two dependency tasks cached**, in **13m20.899s**. All four test suite tasks were cache misses and executed:

| Suite   | Passed tests | Skipped tests | Passed files | Skipped files |
| ------- | -----------: | ------------: | -----------: | ------------: |
| Server  |       23,211 |            55 |        1,318 |             3 |
| Evals   |          572 |             1 |           35 |             0 |
| CLI     |        1,370 |             2 |          101 |             1 |
| Desktop |          815 |             0 |           45 |             0 |

All **85 changed server test files**, including the **79 mechanical app-caller updates**, appear in the full server run's passing-file results; none is missing. These package suites ran through Turbo's strict environment with no paid flags armed. This verifies local fixture and mocked behavior, not paid/live runtime behavior or full-process shutdown. No source or test changes were needed during task 1.4, and the already-completed mutation controls were not repeated.

The initial script attempt exited 1 because its repository-local `TMPDIR` placed spec-manifest fixtures under the real checkout. Their CLI's `git rev-parse --show-toplevel` discovered the checkout and added four fake manifest records. The complete diff contained exactly those additions; the manifest was restored byte-identically to HEAD. The corrected run used normal system temporary directories outside Git and passed all phases. This was an environment-induced fixture failure, not an admission regression; no CI or production code was changed to resolve it.

Local evidence is preserved under `.dork/flow/admission/`: `task1.4-verify-pinned.sh`, `task1.4-scripts.log`, `task1.4-root-lint.log`, `task1.4-affected-types-lint.log`, `task1.4-affected-tests.log`, `task1.4-changed-test-coverage.json` and `task1.4-evidence.md`. The initial failure remains separately recorded in `task1.4-scripts-local-tmp-failed.log`.

## Merge-queue integration repair

The first queue candidate `d8f943aaee6df0848199497e35934541569e2a2e` combined this branch with account-eligibility PR #2336. Its newly added `sessions-account-eligibility.test.ts` constructed the app without the required option. Queue typecheck run `36568551018` and credential-free build run `36568551130` reported that exact TS2554; this was a real integration defect, not a flaky check.

Recreated the exact candidate tree locally and supplied the same explicit fresh admission instance as the other test callers. No production behavior or test expectation changed. The unpatched suite failed during app construction before running tests. After the patch, rebuilding stale local shared outputs restored the newly added account error-code export; that missing build output was a prerequisite failure, not a product change. The new three-test eligibility suite plus seven HTTP boundary tests then passed, 10/10 across two files. Server typecheck, targeted ESLint and formatting checks passed.

The earlier full-suite counts above describe the original verified branch. The additional caller is covered by this focused integration run; final remote checks must validate the combined revision. The failed queue entry was held and removed after remaining unmergeable, without an unchanged re-arm.

## Delivery evidence

[PR #2338](https://github.com/dork-labs/dorkos/pull/2338) merged at **2026-09-29T14:04:54Z** as `a874ad85f0d87c09ad4b4e38cf3110af198ffb87`. Its final reviewed source head was `9404dab3166e3f7615f2b5d9c2986a3cfb0b19d4`, based on the actual account-eligibility merge `89c24d15a082427da8e805461513d47602f7cece`. That head's tree is identical to the focused compatibility proof `78f93e8271e6c28bf27d367626ff5040e8753238`; final review found zero important findings and zero nits. Automated review likewise found zero important findings and zero nits, and there were no unresolved review threads before queue admission.

All required PR checks passed. All **12 merge-group workflows** on the exact merged candidate passed, including [test run 36575489914](https://github.com/dork-labs/dorkos/actions/runs/36575489914) (all four test shards and both Community jobs), [browser run 36575490298](https://github.com/dork-labs/dorkos/actions/runs/36575490298) (all six browser shards and copy drift), typecheck, lint, credential-free build, scripts, site build, OpenAPI, DB, Windows harness, changelog and operating-skills version gates. The optional Vercel preview was queued when merge was armed; it was not a required gate or treated as passing. Separate post-merge smoke runs are not included in the twelve-workflow claim.

DOR-2551 was moved to Done through the Flow adapter and read back as completed with `agent/completed`. Tasks 1.1–1.4 are complete. The original terminal specification remains **specified**, because exclusive terminal actions, full writer drain and destructive DB/lock/reset/successor handoff were not part of this implementation. The follow-on DOR-2482 design does not expand these runtime guarantees.
