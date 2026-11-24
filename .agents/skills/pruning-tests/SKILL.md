---
name: pruning-tests
description: "Find and delete DorkOS tests that cost more than they catch: duplicates, tests of mocks, constants and re-exports, one-case-per-prop files, slow or flaky tests other tests already cover, and browser specs that repeat a unit test. Tightens that package's test budget afterwards. Weekly from @dorkos-qa's heartbeat, or on demand when a package is over its test budget (`pnpm check:test-ratio` is red) or a person asks to cut test bloat."
---

# pruning-tests

Agents write tests faster than anyone reads them, and nothing else in the repo pushes the count down. This skill is the push. One run picks one package, deletes or collapses the tests that fail the four keep-questions, proves nothing real lost its guard, and tightens that package's test budget.

The rubric is `.claude/rules/testing.md`, "Is this test worth keeping?". Read it before step 3. This file is the procedure around it.

## Run

1. **Work in a throwaway worktree, never a shared checkout.** `git fetch origin`, run `git rev-parse origin/main`, keep the SHA it prints and use it for the whole run. Clear a copy a killed run left (`git worktree remove --force "$TMPDIR/pruning-tests" 2>/dev/null; git worktree prune`), then `git worktree add -b chore/prune-tests-<date> "$TMPDIR/pruning-tests" <sha>`. Install and build shared there (`pnpm install --frozen-lockfile --prefer-offline`, `pnpm --filter @dorkos/shared build`), through the load gate on Node 24. Under 46 GB free disk, stop and report "skipped: disk".

2. **Pick one package.** `pnpm check:test-ratio -- --report` prints every package's lines of test per line of source. Take the package furthest above 1.0 (`apps/e2e` and `apps/space` are not measured; prune them when their specs are the slowest or flakiest). If none is above 1.0, take the one with the most test time in `scripts/sharding/durations.json` (milliseconds per test file). Skip a package another open PR is pruning (`gh pr list --search "chore(tests): prune in:title"`).

3. **Find candidates, cheapest signal first.** Aim for at most 30 files per run so one person can review it.
   - **Slow:** the package's files in `scripts/sharding/durations.json`, slowest first.
   - **Flaky:** `pnpm ci:flaky` and the quarantine lane (`pnpm ci:quarantine list`).
   - **Shape:** files that `vi.mock` our own modules (`pnpm check:own-mocks` counts them), files with many near-identical `it(` blocks, `toMatchSnapshot`, tests of constants, types or barrels.
   - **Overlap:** several files testing the same module at different layers, or a browser spec whose steps a component or route test already asserts.

4. **Judge each test against the four questions.** For questions 1 and 3, don't guess; break it. Change one line of the source the test guards so the behaviour is wrong, run the package's tests for that area, and look at what went red:
   - Only this test went red: it is the guard. Keep it (or keep the better-written equivalent).
   - Other tests went red too: this one is a duplicate. Delete it, or the weaker of the two.
   - Nothing went red, including this test: it can't fail. Delete it, and note that the behaviour has no guard.
   Undo every break before moving on by reversing your edit (or `git show HEAD:<path> > <path>`; `git checkout -- <path>` is refused here), and check with `git diff` that only test files changed.

5. **Delete, or collapse.** Remove whole files where you can. Fold one-case-per-prop tests into a single `it.each` table. Never turn a test into `.skip` or `.todo`, never weaken an assertion to keep a test, and never delete a red test to make CI green: a test failing for a real reason is a bug report.

6. **Never delete without a replacement:** a regression test naming a DOR id, tests of permissions, security or data loss, and the conformance suites (`runtimeConformance`, `communityConformance`). One of these goes only when step 4 shows another test fails for the same break.

7. **Prove it.** Run the package's remaining tests (`pnpm vitest run <dir>`), its typecheck and its lint. Then lower every ratchet the deletions moved: `pnpm check:test-ratio -- --update --package <package>` (one line of the baseline, so it does not collide with other PRs), plus `pnpm check:own-mocks -- --update` and `pnpm check:max-lines -- --update` when they report a drop. Commit the baselines with the deletions.

8. **Open one PR.** Labels `skip-changelog` and `review:light`. The body has one line per file: what went and which question it failed ("duplicate: `x.test.ts` goes red for the same break", "asserts its own mock", "per-prop cases folded into one table"), plus every behaviour step 4 found unguarded. No ledger entry is needed: deleting tests from source lowers the pass-count marks on its own (`ci/ratchets.yaml`). Run lint, typecheck and `pnpm verify:preopen` (heavy work through `pnpm heavy`; exit 75 means wait and retry), do a fresh-context review against `REVIEW.md`, then open it with `scripts/open-pr.sh --title "chore(tests): prune <package> (-<n> lines)" --body-file <file>`. Never `gh pr create`, and never arm, queue or merge it by hand: the cloud checks, including the Security lens, decide.

9. **Clean up.** Remove `$TMPDIR/pruning-tests` once the PR is pushed. Spare anything with unpushed work.

## Report

One line to @dorkos-pm, in #dorkos:

`Test prune (<date>): <package> <before> → <after> test/source, -<n> lines in <m> files, PR #<k>. Unguarded: <behaviours | none>.`

A run that found nothing worth deleting is one line too, naming the package it checked. An unguarded behaviour is filed as a ticket only when a person would notice it breaking; otherwise it stays in the report line.

## Never

- Raise or remove a budget in `scripts/test-ratio/baseline.json`, or raise any other baseline.
- Delete tests in more than one package per PR, or touch another agent's worktree or PR.
- Run paid evals, set a paid flag, `git stash`, `git checkout -- <path>`, or kill a process by name.
