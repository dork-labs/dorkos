# apps/server test-pruning ledger

- Source/head before edits: **6fccd4873b**. Branch: **codex/prune-tests-server**.
- Physical test lines before / after: **879,266 / 879,238**. Net removed: **28 (0.003%)**.
- Test files before / after: **2,568 / 2,568**. Deleted cases: **2**; deleted whole files: **0**.
- Recorded case blocks (with adjacent separators/comments): **27 lines**. Support cleanup: **1 blank line**.
- Test-file git numstat: **28 deletions, 0 additions**. Ledger lines are separate and excluded from test-line totals.
- Production code: **unchanged**. Suites/typecheck/lint/coverage/mutation/timing: **not run** in this lane.
- This ledger accompanies the first local package commit. Read its exact head from git log; no push or PR is performed by this lane.

## Conflict check

Coordinator check do-not-touch-nov12.md, November 12 18:30 CT, clears paths outside its exclusions and covers current PRs and tracker work. No excluded source or its tests were edited. Tools are intentionally unavailable in this lane; the coordinator supplies those checks. Local edits only; the verifier owns executable checks, the normal commit hook, and pushing.

## Counting and scope

Baseline file inventory: prune-server-inventory.tsv. Scope: rg --files apps/server with globs *.test.ts, *.test.tsx, *.spec.ts and *.spec.tsx. Count physical lines with bytes.splitlines(), including comments and blanks. Use pinned source 6fccd4873b. Do not substitute str.splitlines(): literal Unicode separators in some test fixtures split that count differently. No timing or mutation improvement is inferred from removed lines.

The companion prune-server-screen.tsv inventories every file with a conservative text-screen disposition. It is an initial screen, not a claim that each case has received semantic/coverage review. Marker hits can over-retain files. Unreviewed and uncertain cases remain; they are never automatically deleted. This is a small reviewable batch, not completion of the whole cleanup programme or its 40% target.

## Deletions

| File | Test | Reason | Lines | Surviving behavior |
| --- | --- | --- | ---: | --- |
| `apps/server/src/services/rooms/response-gate/__tests__/routing-rules.test.ts` | accepted miss: silences an agent that had something to add, because the post named somebody else | duplicate-of excuses a post that named a different agent in this room | 21 | excuses a post that named a different agent in this room |
| `apps/server/src/services/rooms/__tests__/addressing.test.ts` | leaves a post whose names reached nobody alone | duplicate-of leaves an unaddressed post alone — the seat is what answers it | 6 | leaves an unaddressed post alone — the seat is what answers it |

## Protected classes

Only exact duplicates in two internal room-routing helper suites are removed. The same describe scopes, fixture helpers and literal arguments survive. No HTTP, IPC, DB, MCP, runtime-conformance or security assertion was removed. DOR-2823 cases elsewhere in addressing.test.ts remain unchanged. All other security, auth, permissions, upgrades/migrations, named regressions, contracts/conformance and scripts guards are unchanged. No deletion relies on mock count or coverage overlap alone. Exact duplicate claims are checked against the original literal bodies and describe/fixture scope, preserving string whitespace.

## Unsure — retained

- runtimes/claude-code/__tests__/type-assertions.test.ts: expect(true) is vacuous, but the SSE type assignment checks a protected boundary contract; unchanged.
- runtimes/__tests__/supports-accounts.test.ts: fixed capability flags also declare a runtime contract; unchanged.
- runtimes/shared/__tests__/gen-ui-context.test.ts: looks like constant/copy checks but pins prompt protocol syntax and a prefix budget; unchanged.
- relay/__tests__/binding-router-getters.test.ts: duplicate-looking parsing cases coexist with persisted session scopes and migration behavior; unchanged.
- tasks/__tests__/todo-due-timers.test.ts: callback spies observe due/missed timing; these are real effects, not mock-only assertions.
- harness/__tests__/auto-project.test.ts and project-on-agent-created.test.ts: spies enforce consent/boundaries and named regressions; unchanged.
- lib/__tests__/shutdown-signal.test.ts: callback calls are process-boundary behavior; unchanged.
- __tests__/app-spa-fallback.test.ts: duplicate hashed-bundle assertions are HTTP-contract tests; unchanged.
- identity/__tests__/display-name-provenance.test.ts: text-normalized duplicate search gave a false candidate because spaces inside string inputs matter; no edit.
- runtimes/claude-code/__tests__/claude-code-runtime.test.ts: repeated hasSession assertions sit on the public runtime contract and security-bearing setup; unchanged.

## Verification and handoff

Final node --check passed for both edited files. A second commit-hook run was deferred: the shared worktree already demonstrated missing prettier/turbo, and the fresh host load was 23.67, above the recorded ceiling of 16 for commit hooks. No install or hook bypass was attempted. The verifier must commit the staged patch after executable checks.

Run the changed test files in the verifier, then the package checks and protected-class review before pushing. Full per-case semantic review, coverage/mutation evidence and the programme-wide reduction remain outstanding.

Final static verification: node --check exited 0 for every changed test file; git diff --check HEAD exited 0 in both worktrees. Reconstruction from the pinned base matches exactly the recorded case deletions and listed import/blank cleanup. Every retained duplicate body is unchanged. Fresh bytes-based counts match the totals above, and all changed paths are outside the supplied exclusions. These checks do not execute Vitest or prove coverage.

Coordinator update, November 12: dependencies are installed in both worktrees. The initial hook/dependency blocker below is historical; retrying the normal commit with all hooks enabled. Fresh host load was 11.28, below the revised ceiling of 24.
