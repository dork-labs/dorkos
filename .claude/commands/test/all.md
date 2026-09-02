---
description: 'Run the whole verification ladder — typecheck/lint/affected tests, the full unit suite, the Playwright mock leg, and the free structural evals — then ask before spending anything. Writes one summary report with pass/fail per tier.'
argument-hint: '[skip:e2e,evals] [only:1,2] [--yes-paid]'
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion
category: testing
---

Run every **free, deterministic** verification tier in this repo, in one pass, and produce a single report with a pass/fail verdict per tier. Then **stop** and ask before running anything that spends money or needs a live stack.

This is the run-everything entry point described in `meta/chat-capabilities.md` §11. It does not replace the individual commands — it sequences them and reports honestly on what actually ran.

**The one rule that matters:** a tier that did not execute is never green. See "Honest reporting" below — turbo's cache replay is designed to look exactly like a passing run.

---

## Argument Parsing

Parse `$ARGUMENTS`:

1. **`skip:a,b`** — skip named tiers. Names: `verify`, `unit`, `e2e`, `evals`. Skipped tiers are reported as `SKIPPED (requested)`, never as PASS.
2. **`only:1,2`** — run only these tier numbers (1–4). Mutually exclusive with `skip:`.
3. **`--yes-paid`** — the operator has pre-approved the gated tier, so Phase 6 runs its ladder without a second question. **Without this flag, never start a paid tier on your own initiative.**

Default (no arguments): tiers 1–4, then ask.

## Results File

```bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_DIR="test-results/test-all"
mkdir -p "$RESULTS_DIR"
RESULTS_FILE="$RESULTS_DIR/$TIMESTAMP.md"
```

Write the header immediately (`Status: IN PROGRESS`, the tier plan, git branch + `git rev-parse --short HEAD`) and **append after every tier**, so an interrupted run still leaves a truthful partial record. `test-results/` is gitignored — the report is a local artifact, not a commit.

Full command output goes to `$RESULTS_DIR/$TIMESTAMP-<tier>.log`; the report links to it and quotes only the verdict lines. Never paste a thousand lines of turbo output into the report.

## Phase 0 — Preflight

```bash
node -v && pnpm -v
git rev-parse --abbrev-ref HEAD && git status --short | head -20
ls node_modules >/dev/null 2>&1 || echo "WARNING: no node_modules — run 'pnpm install' first"
```

A dirty tree is fine (that is usually the point), but record it: a run against uncommitted work is only meaningful alongside the diff it tested.

Check for a live stack, because it changes what tier 3 can do:

```bash
for port in 4244 4245 4243 4248; do
  lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1 && echo "PORT $port BUSY"
done
```

Record the result as `PORTS_BUSY`. See tier 3 for why it matters.

---

## Tier 1 — `pnpm verify`

```bash
pnpm verify 2>&1 | tee "$RESULTS_DIR/$TIMESTAMP-verify.log"
```

What it actually is (`package.json`): `pnpm test:scripts && export TURBO_SCM_BASE="$(git rev-parse --verify --quiet origin/main || echo main)" && turbo run typecheck lint --affected && turbo run test --affected -- --run`. So it is **affected-only** — it is the pre-PR loop-closer, not full coverage. That is exactly why tier 2 exists and why "verify passed" is never reported as "the suite passed".

The `TURBO_SCM_BASE` pin (DOR-1717) is what makes "affected-only" mean anything here: turbo's default base is the _local_ `main` ref, which on a worktree machine trails `origin/main`, and diffing against it swept in everybody else's merges — a root-files-only tree resolved to the entire monorepo that way. Report the packages turbo actually selected, not the ones you expected it to.

Verdict: exit code 0 → PASS. Non-zero → FAIL, and record the first failing package and the first real error line (not the last line, which is usually turbo's summary).

## Tier 2 — Full unit suite

```bash
pnpm test -- --run 2>&1 | tee "$RESULTS_DIR/$TIMESTAMP-unit.log"
```

Always `pnpm test -- --run` via turbo, **never** a bare `pnpm vitest run` for a full run — bare vitest skips the per-package environment turbo sets up and has produced false failures in dev (`AGENTS.md` → Commands).

**Read the turbo footer before judging this tier.** A full cache hit replays in a few hundred milliseconds and prints a summary that is indistinguishable from a real run — `>>> FULL TURBO`, `cached` on every task, and a total duration far below the suite's real cost. CI does not trust that line either: `scripts/assert-tests-executed.sh` (pinned by `scripts/test-assert-tests-executed.sh`) exists precisely to assert the `test` job actually executed rather than replayed.

So classify tier 2 as one of three, never two:

| Verdict       | When                                                        |
| ------------- | ----------------------------------------------------------- |
| PASS          | Exit 0 **and** tasks executed (cache misses, real duration) |
| PASS (CACHED) | Exit 0 but turbo replayed a cache hit — nothing ran         |
| FAIL          | Non-zero exit                                               |

`PASS (CACHED)` is a yellow result in the summary, not a green one. If the run needs a real answer, bypass the cache explicitly and report that number instead:

```bash
pnpm exec turbo run test --force -- --run
```

(`--force` is turbo's own flag — "ignore the existing cache (to force execution)" — so it must go **before** the `--`, and only what follows the `--` reaches vitest.)

Also note: turbo strips `ANTHROPIC_API_KEY`, so the one money-spending test in the repo (`packages/evals/src/runner/__tests__/harness-server.test.ts`, gated on `DORKOS_EVALS_CREDENTIALED=1`) is never reached by this tier. That is a property to state in the report, not something to "verify" by running it.

## Tier 3 — Playwright browser tests (mock leg + cockpit leg, no model spend)

Run it from the repo root — every other tier here does, and a `cd` that persists would send the later tiers' logs somewhere else:

```bash
pnpm --filter @dorkos/e2e exec playwright test 2>&1 | tee "$RESULTS_DIR/$TIMESTAMP-e2e.log"
```

**This tier boots its own servers.** `apps/e2e/playwright.config.ts` sets `REUSE_EXISTING_SERVER = false` deliberately (a default-port run once attached to the operator's real cockpit on 4242 and mutated the real `~/.dork`). Every leg also boots on its own ports, against its own throwaway `DORK_HOME` under `/tmp`, wiped before every boot — so this tier can no longer read or write the operator's data (DOR-1223). Consequences:

- Ports **4245** (Express API), **4244** (Vite), **4243** (test-mode API), **4248** (test-mode Vite) must be **free**. None is a dev port (6xxx) or the production default (4242), so a plain `pnpm dev` / `pnpm dev:dogfood` does not collide — but do not read that as "nothing else can be there": the desktop app starts at 4242 and walks up to the next free port across a ten-port range, which covers every port in this list. A collision is loud either way (`reuseExistingServer: false` makes a busy port a startup error naming it), never a silent adoption. If Phase 0 found any busy, this tier will fail on startup with a port error. Report it as `BLOCKED (port in use)`, never as FAIL, and tell the operator which port and which command to stop. The isolated-run recipe in `apps/e2e/README.md` (move `DORKOS_COCKPIT_PORT` / `DORKOS_COCKPIT_VITE_PORT` / `DORKOS_MOCK_PORT` / `DORKOS_MOCK_VITE_PORT`) lets two runs coexist.
- Playwright starts every configured `webServer` leg for the run, so the boot cost is paid even for a narrow project selection.

**Which projects run without a live stack — all of them, and none of them spends money:**

| Project                | Leg                            | Runtime                                                                            |
| ---------------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| `chromium`             | Express API 4245 + Vite 4244   | real claude-code, but `@integration` specs are excluded unless `E2E_INTEGRATION=1` |
| `chromium-mock`        | test-mode API 4243 + Vite 4248 | `TestModeRuntime` (no model)                                                       |
| `chromium-connections` | test-mode                      | `TestModeRuntime`                                                                  |
| `chromium-streams`     | test-mode                      | `TestModeRuntime` (incl. the multi-window connection-budget guard)                 |
| `chromium-team-room`   | test-mode                      | `TestModeRuntime`                                                                  |
| `chromium-bridge`      | test-mode                      | `TestModeRuntime`                                                                  |

The marketing-site specs (`marketplace.spec.ts`, `features.spec.ts`) are **excluded** unless `E2E_SITE=1`, because that leg is a heavy Next.js boot and reaches the live registry over the network. Leave them out of the default ladder; note the exclusion in the report so nobody reads this tier as full browser coverage.

To run only the test-mode legs: `pnpm --filter @dorkos/e2e exec playwright test --project chromium-mock --project chromium-streams --project chromium-team-room --project chromium-bridge`.

Verdict from Playwright's own summary line (`N passed, M failed`) plus the exit code. Read `apps/e2e/test-results/results.json` for the per-spec breakdown, and name every failing spec in the report — not just the count.

## Tier 4 — Free structural evals

```bash
pnpm evals -- --suite core --tier test-mode 2>&1 | tee "$RESULTS_DIR/$TIMESTAMP-evals.log"
```

`--tier test-mode` reaches no model, so this costs nothing. The CLI prints a pass/fail table and exits non-zero when the run gate fails — **including when it gated on zero cases**, which is deliberate, because a run that selected nothing otherwise looks exactly like a pass (`packages/evals/bin/evals.ts`).

**Second run — the `rooms` suite** (landed with DOR-1217; run it, it is not conditional any more):

```bash
pnpm evals -- --suite rooms --tier test-mode 2>&1 | tee "$RESULTS_DIR/$TIMESTAMP-evals-rooms.log"
```

Two runs rather than one selector, because `--suite` takes a single name. This one gates on **four** cases — a mentioned agent runs a turn, an unaddressed message runs none and spends no budget, a burst collects into one charged turn, and Stop interrupts a live turn and writes one notice — and prints eight further rows as `skipped-wrong-tier`. Those eight declare a credentialed runtime, so the runner never starts them here; that is the designed outcome, not a gap, and it is why the GATING line reads `4 of 4` rather than `4 of 12`.

Still check rather than assume, because the mechanism is what it always was: `--suite` resolves against the tag list in `packages/evals/src/suite/index.ts` (today: `smoke`, `core`, `connector`, `experimental`, `rooms`) or a case id. A name that matches nothing prints `No eval cases matched suite '<name>'` and exits 2 — report that as `NOT AVAILABLE YET`, never as a failure of the ladder and never as a pass.

---

## Phase 5 — Write the free-tier summary

Append to the report:

```markdown
## Summary — free tiers

| #   | Tier                     | Verdict | Duration | Notes                     |
| --- | ------------------------ | ------- | -------- | ------------------------- |
| 1   | pnpm verify (affected)   |         |          |                           |
| 2   | Full unit suite          |         |          | executed / cache-replayed |
| 3   | Playwright (6 projects)  |         |          | site specs excluded       |
| 4   | Evals — core, test-mode  |         |          |                           |
| 4b  | Evals — rooms, test-mode |         |          | 4 gating + 8 wrong-tier   |
```

Then list every failure with: tier, the failing package/spec/case name, the first real error line, and the log file path. If everything passed, say so in one sentence and move on — no victory paragraphs.

## Phase 6 — The gated tier (ask first, always)

**Stop here.** Everything below either spends money, needs a live stack, or takes many minutes. Use `AskUserQuestion` to present the options and let the operator choose which (if any) to run. Do not start any of them on a default, on an inference, or because the free tiers were green.

Present these, with what each costs:

| Option                      | Command                                                                                           | Cost                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Live evals                  | `pnpm evals:local` (`--suite core --tier claude-code-cheap --isolation child-process --budget 2`) | Real model spend, budget-capped at $2                |
| `/chat:self-test`           | `mode:live` (or `mode:sandbox` for free)                                                          | Model spend + a running dev stack                    |
| `/chat:session-switch-test` | `mode:live` (or `mode:sandbox` for free)                                                          | Model spend ×2 concurrent sessions + a running stack |
| `/chat:rooms-test`          | `mode:live` (or `mode:sandbox` for free)                                                          | Model spend ×2 agents + a running stack              |
| `/multiwindow`              | wraps `pnpm --filter @dorkos/e2e multi-window`                                                    | Model spend per window + a **running** DorkOS        |
| Docker smokes               | `pnpm smoke:docker`, `pnpm smoke:integration`                                                     | No model spend; needs Docker, costs minutes          |

Notes to carry into the question:

- The three self-tests each accept `mode:sandbox`, which runs the test-mode leg and spends nothing. If the operator wants coverage but not spend, that is the answer — offer it explicitly.
- `/multiwindow` and the `mode:live` self-tests need a stack the operator is already running; this command must not start one for them.
- The Docker smokes are free of model spend but are the slowest item here.

Whatever the operator picks, run it, then append a `## Summary — gated tiers` table in the same shape. Anything not chosen is recorded as `NOT RUN (declined)`.

## Phase 7 — Close the report

Flip `Status: IN PROGRESS` → `COMPLETE`, append the total duration, and print the path to the report plus a one-screen verdict:

```
═══════════════════════════════════════════════════
  TEST ALL — [N] green / [N] red / [N] not run
═══════════════════════════════════════════════════
  Report: test-results/test-all/[TIMESTAMP].md
```

---

## Honest reporting (non-negotiable)

- **A tier that did not execute is never green.** Cache replay, a skipped tier, a blocked port, a suite that matched zero cases — each has its own verdict word (`PASS (CACHED)`, `SKIPPED`, `BLOCKED`, `NOT AVAILABLE YET`). None of them is PASS.
- **Never infer a verdict from a green exit code alone** when the command has a known way of exiting zero without working. Turbo's replay is the one in this repo; `scripts/assert-tests-executed.sh` exists because a full cache hit prints "29 successful" in ~280ms and CI could not tell the difference either.
- **Name failures, don't count them.** "3 specs failed" is not a report; the three spec names are.
- **Never claim a tier ran on a surface you didn't touch.** This ladder covers the cockpit; the Obsidian plugin, the desktop apps, and the marketing site are outside it unless explicitly run.
- **Report the paid tier's cost after the fact** when one runs — the evals CLI prints which credential answered and what the run spent; carry that number into the report.

## Technical Notes

- `pnpm verify` = `pnpm test:scripts && export TURBO_SCM_BASE="$(git rev-parse --verify --quiet origin/main || echo main)" && turbo run typecheck lint --affected && turbo run test --affected -- --run`; it also runs the shell-script test battery (`scripts/test-*.sh`), which is why it is tier 1 and not a subset of tier 2. The `export` (not a per-command env prefix) is deliberate — a prefix would cover only the first turbo call.
- **Turbo's task count is not a suite count.** A `turbo test` plan folds in the `build` and `generate:api-docs` tasks each suite depends on: the full monorepo plan is 57 tasks, of which 23 are `test`. Quote both, or quote suites and say so.
- `pnpm test` = `dotenv -- turbo test`; the `-- --run` passes vitest's non-watch flag through.
- A stale `@dorkos/shared` dist produces false-red type errors outside a running dev session — if tier 1 fails with import/type errors in packages you did not touch, run `pnpm --filter @dorkos/shared build` and re-run before reporting a FAIL. A `TS6053` on a `@dorkos/typescript-config` extends means stale `node_modules` — run `pnpm install`.
- Browser-test execution has its own CI assertion, `scripts/assert-browser-tests-executed.sh`, for the same cache-replay reason as the unit suite.
- Eval credential order is `ANTHROPIC_API_KEY` → `CLAUDE_CODE_OAUTH_TOKEN` → the local `claude` sign-in, and the run prints which one answered. No credential at all is a **runner error**, never a pass.
- The capability contract these tiers are measured against is `meta/chat-capabilities.md` (§10 lists the whole test surface; §11 defines this ladder).
