# packages/shared test-pruning ledger

- Source/head before edits: **6fccd4873b**. Branch: **codex/prune-tests-shared**.
- Physical test lines before / after: **35,033 / 34,965**. Net removed: **68 (0.194%)**.
- Test files before / after: **153 / 153**. Deleted cases: **8**; deleted whole files: **0**.
- Recorded case blocks (with adjacent separators/comments): **67 lines**. Support cleanup: **1 blank line**.
- Test-file git numstat: **70 deletions, 2 additions (two unused import specifiers removed)**. Ledger lines are separate and excluded from test-line totals.
- Production code: **unchanged**. Suites/typecheck/lint/coverage/mutation/timing: **not run** in this lane.
- This ledger accompanies the first local package commit. Read its exact head from git log; no push or PR is performed by this lane.

## Conflict check

Coordinator check do-not-touch-nov12.md, November 12 18:30 CT, clears paths outside its exclusions and covers current PRs and tracker work. No excluded source or its tests were edited. Tools are intentionally unavailable in this lane; the coordinator supplies those checks. Local edits only; the verifier owns executable checks, the normal commit hook, and pushing.

## Counting and scope

Baseline file inventory: prune-shared-inventory.tsv. Scope: rg --files packages/shared with globs *.test.ts, *.test.tsx, *.spec.ts and *.spec.tsx. Count physical lines with bytes.splitlines(), including comments and blanks. Use pinned source 6fccd4873b. Do not substitute str.splitlines(): literal Unicode separators in some test fixtures split that count differently. No timing or mutation improvement is inferred from removed lines.

The companion prune-shared-screen.tsv inventories every file with a conservative text-screen disposition. It is an initial screen, not a claim that each case has received semantic/coverage review. Marker hits can over-retain files. Unreviewed and uncertain cases remain; they are never automatically deleted. This is a small reviewable batch, not completion of the whole cleanup programme or its 40% target.

## Deletions

| File | Test | Reason | Lines | Surviving behavior |
| --- | --- | --- | ---: | --- |
| `packages/shared/src/__tests__/dorkbot-templates.test.ts` | returns a non-empty string with DorkBot header | trivial | 6 | Only pins the fixed header of a static template; the remaining positioning test still exercises the returned template. |
| `packages/shared/src/__tests__/dorkbot-templates.test.ts` | DORKBOT_ONBOARDING_LINES / never uses an em dash (writing-for-humans) | trivial | 14 | Only checks punctuation in onboarding copy; keep the DOR-1972 disclosure regression and all welcome/sign-in behavior. |
| `packages/shared/src/__tests__/dorkbot-templates.test.ts` | DORKBOT_TOUR_LINES / never uses an em dash (writing-for-humans) | trivial | 10 | Only checks punctuation in tour copy; keep the tour offer/caption completeness check. |
| `packages/shared/src/__tests__/template-catalog.test.ts` | has exactly 7 built-in templates | trivial | 4 | Pins the size of a fixed data array; retain entry/catalog schema validation, unique IDs, builtin flags, tags and source checks. |
| `packages/shared/src/__tests__/template-catalog.test.ts` | has correct category distribution | trivial | 12 | Pins fixed catalog inventory by category; retain all category/entry/catalog schemas and validation of every default template. |
| `packages/shared/src/__tests__/template-catalog.test.ts` | satisfies TemplateEntry[] type | trivial | 5 | Assigns a compiler-checked array type and inspects a fixed first ID; retain default-template uniqueness, schema validation and blank-template source behavior. |
| `packages/shared/src/__tests__/links.test.ts` | names the site, docs and repositories | trivial | 10 | Only checks fixed URL constants and relationships; retain joins paths with exactly one slash, which exercises site/docs/repo URL builders. |
| `packages/shared/src/__tests__/account-usage.test.ts` | has eight lowercase #rrggbb defaults | duplicate-of account-palette.test.ts / holds 8 distinct lowercase #rrggbb values | 6 | The retained palette test checks the same exported DEFAULT_ACCOUNT_COLORS length, lowercase hex spelling and uniqueness. Account usage/ledger behavior and conformance tests remain unchanged. |

## Protected classes

The three schema suites and all default-entry/catalog validation in template-catalog.test.ts remain byte-for-byte unchanged. Welcome/sign-in behavior and DOR-1972 storage-disclosure regression remain. The palette duplicate only checks constants; ledger/conformance behavior is untouched. All other security, auth, permissions, upgrades/migrations, named regressions, contracts/conformance and scripts guards are unchanged. No deletion relies on mock count or coverage overlap alone. Exact duplicate claims are checked against the original literal bodies and describe/fixture scope, preserving string whitespace.

## Unsure — retained

- convention-files.test.ts: filename/limit assertions pin disk formats, prompt budgets and safety-template content.
- manifest.test.ts: MANIFEST_DIR/MANIFEST_FILE constants pin the public disk layout.
- trait-renderer.test.ts: constants and copy coexist with directive preservation and autonomy semantics; unchanged as requested.
- account-palette.test.ts: exact palette equality connects the contrast fixture to real defaults; do not leave contrast testing only the fixture.
- agent-runtime.test.ts: compiler-only appearances protect runtime/permission contracts.
- bounded-read-import.test.ts, zod-openapi.test.ts and aliased-module-imports.test.ts: apparent import/implementation checks protect named regressions.

## Verification and handoff

The normal git commit attempt was refused by pre-commit: format could not find prettier, lint could not find turbo. Directory-size check passed with unrelated existing-directory warnings. No install or hook bypass was attempted. The verifier must run normal hooks and commit the staged patch. Final syntax checks passed for all four changed test files; fresh counts are confirmed below.

Run the changed test files in the verifier, then the package checks and protected-class review before pushing. Full per-case semantic review, coverage/mutation evidence and the programme-wide reduction remain outstanding.

Final static verification: node --check exited 0 for every changed test file; git diff --check HEAD exited 0 in both worktrees. Reconstruction from the pinned base matches exactly the recorded case deletions and listed import/blank cleanup. Every retained duplicate body is unchanged. Fresh bytes-based counts match the totals above, and all changed paths are outside the supplied exclusions. These checks do not execute Vitest or prove coverage.

Coordinator update, November 12: dependencies are installed in both worktrees. The initial hook/dependency blocker below is historical; retrying the normal commit with all hooks enabled. Fresh host load was 11.28, below the revised ceiling of 24.
