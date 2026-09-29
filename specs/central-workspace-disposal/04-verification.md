# Verification: central workspace disposal

## Local evidence

At base `5794f638160a68811382347356fd29b31ee2e911`, with the selected workspace owner and root wiring:

- Initial tests were red before implementation: the owner API was missing and all five root wiring/callback cases failed.
- New owner plus root wiring tests: 17 passed in 2 files.
- New tests plus existing class lifecycle tests: 35 passed in 3 files before mutation controls.
- After all four mutations were restored, `pnpm vitest run apps/server/src/services/workspace/__tests__`: 126 passed in 10 files.
- `pnpm --filter @dorkos/server typecheck`: exit 0.
- Changed source/test lint: exit 0.
- Changed source/test formatting: passed.

## Mutation controls

Each mutation was applied alone, ran a named targeted test with nonzero collection, and was restored byte-for-byte:

| Mutation                                  | Observed failure                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| Remove terminal admission guard           | Late startup was accepted instead of throwing; 1 failed, 11 deliberately unselected           |
| Remove root disposal call                 | Ordinary cleanup no longer awaited disposal first; 1 failed, 4 deliberately unselected        |
| Remove await on root disposal             | Required await absent; 1 failed, 4 deliberately unselected                                    |
| Move disposal after another cleanup await | First await no longer addressed the root workspace owner; 1 failed, 4 deliberately unselected |

The restored workspace suite passed afterward. The earlier unchanged class-local late-write and overlap mutations remain historical evidence in the pilot; this change adds adoption-specific controls.

## Evidence limits

The tests exercise the real lifecycle owner and reconciler against narrow controlled stores and fake clocks, with positive write controls. Root AST checks establish structural adoption; they do not boot the full server. The startup callback test executes the actual extracted catch callback with safe bindings and proves original-error identity across workspace disposal errors only. Existing fixture-close failures remain outside that guarantee.

No paid inference, deployment, local browser suite or local Docker smoke was run. Initial host disk pressure deferred broad local verification; it later cleared. Original-head required PR checks passed, including unit tests, typecheck, lint, credential-free build, CLI smoke and integration. The actual merge-group result remains pending.

Independent compliance review passed tasks 1.1 and 1.2 and independently reran 35 tests across 3 lifecycle files. Final root wiring run after formatting: 5 passed. Independent REVIEW.md review of pushed head `0886df6bb8777375975f1473a0b8c76420c2f4b5` found 0 important issues and 0 nits, traced root/admin callers, and independently reran 35 lifecycle tests. Normal pre-commit affected lint passed 21 tasks (17 cached), with existing warnings and no errors. Changelog validity/coverage and pre-push formatting passed. The final receipt-only amend does not change implementation. Broader CI and merge results are recorded on the PR and tracker after this commit.

## Conflict repair — 2026-09-28

Rebased onto pinned `a1710cbc1b0d357b44c6600274c3153a823b605a` to resolve an actual `specs/manifest.json` conflict, preserving both the Cloud entry and this specification. Independent range-diff review found no new findings: implementation and test patches are unchanged, and upstream root changes preserve the reviewed cleanup ordering.

- Workspace tests: 126 passed across 10 files.
- Server typecheck: exit 0.
- Affected typecheck and lint: 40 tasks passed, 17 cached.
- Changelog validity and coverage: passed.
- Affected tests/build dependencies: 19 tasks passed; server 21,859 tests, CLI 1,337, desktop 814 and evals 572 passed (24,582 total passed; 58 skipped).
