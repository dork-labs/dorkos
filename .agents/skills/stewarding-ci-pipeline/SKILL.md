---
name: stewarding-ci-pipeline
description: "The method for changing the DorkOS CI pipeline as a measured experiment: the change protocol (hypothesis, ledger entry, census), PDCA, which constraint to work on first, the SLOs and ratchets, the fence around the steward and the judge, how to write a narrow hypothesis, and this repo's CI anti-patterns. Use when editing a workflow, lefthook.yml, turbo.json, .claude/settings.json hooks, a script a gate runs, anything under ci/ or packages/ci-steward, the required-check set or the ruleset, or when deciding what to improve in CI next."
---

# Stewarding the CI Pipeline

## Overview

Merges into `main` are fully autonomous: no human approves anything, so the pipeline is the only gate, and it has to stay fast, trustworthy and honest about itself with no human noticing drift. CI Steward treats every pipeline change as an experiment with a metric, a baseline, a target and a date, and has code (never a model) compute whether it worked. This skill is the method. `contributing/ci.md` is the reference for how the pipeline works today; `plans/ci-steward-plan.md` is the full design.

Why it exists: about 94 pipeline changes in 14 weeks, each well documented, and 0 had a planned check of its result. Three results found by accident contradicted their change. The same failure classes recurred 3 to 15 times because nothing remembered them.

## The change protocol

This is the same protocol as `.claude/rules/ci-pipeline.md`. It lives here too because path rules load only in Claude Code, and this skill is what Codex and the other harnesses see.

1. **Hypothesis first.** One metric from `ci/metrics.yaml`, the narrowest that can move; its baseline; a target; `after_days`. Only `kind: hygiene` is exempt.
2. **Ledger entry in the same commit.** `node packages/ci-steward/src/cli.ts ledger-new --slug <slug>` scaffolds `ci/ledger/<YYMMDD-HHMMSS>-<slug>.md` (`--help` for flags). Kinds: `experiment`, `incident-fix`, `hygiene`. Hand statuses: `proposed`, `active`, `withdrawn`, `reverted`. Never write `verified`, `partial`, `failed` or `inconclusive`: those are computed verdicts, and the ledger check rejects them on `main`. Read the baseline from `/ci-status` (`latest.json`) and name its source in `baseline_source:`.
3. **Ratchet releases block review by default.** An entry that lowers a quality floor (`ratchet-release`) must give a specific reason. A change to a required gate's retries, shards, timeout or required status needs `field-changes`.
4. **The deadlock invariant.** A required context's job exists under that exact name, runs on `pull_request` (including `synchronize` if `types:` is set) and on `merge_group`, has no `paths:` filter, and has no job-level `if:` that can skip it: a skipped run satisfies a required context. Every job has `timeout-minutes`. `continue-on-error` or an event-branching step-level `if:` in a required job, or in any job it needs, needs a `ci/census-allowlist.yaml` entry with a reason (and `expires:` when temporary); an `always()` fan-in must read `needs.<job>.result` for every job it needs. An expired entry turns every PR's census red, so an expiry is a deadline for a person, never a switch for a scheduled change.
5. **Ledger release first, ruleset edit second.** Adding or removing a required check: the PR with the job, `ci/required-checks.json` and the ledger entry merges first; the operator edits the ruleset after. The invariant is that no admin credential lives in Actions, so nothing automated can un-require a check. It holds once the phase-0 PR merges and the old `MERGE_TAIL_TOKEN` secret is deleted: merge-tail and the Dependabot lockfile repair use the `dorkos-merge-tail` GitHub App, which has no Administration permission.
6. **The fence.** Unattended changes may change gates, never the steward or the judge (below).
7. **Verify locally:** `node packages/ci-steward/src/cli.ts census` (`--fix` regenerates the required-checks blocks in `contributing/ci.md` and the `creating-pull-requests` skill), `node packages/ci-steward/src/cli.ts ledger-check`, and `node packages/ci-steward/src/cli.ts ledger-check --coverage --base "$(git merge-base origin/main HEAD)"`. The same three run as steps of the required `typecheck` job; a missing ledger entry fails coverage.
8. **Read observations from the data branch:** `/ci-status` (`pnpm ci:status`) shows the SLOs, the constraint, the open improvement triggers, every experiment's verdict and the collector's health; `/ci-pulse` collects now into a temp directory; `pnpm ci:report [--day YYYY-MM-DD] [--open]` builds the day's HTML page into a temp path and pushes nothing. By hand: `git fetch origin ci-steward-data`, then `git show origin/ci-steward-data:latest.json`, `:triggers.json`, `:verdicts/<ledger-id>.json`, `:reports/<YYYY-MM-DD>.html`, `:reports/<YYYY-Www>.md`. Only the daily workflow and `ci-local-export` write that branch; never push to it or its `ci-steward-data/*` tags. Every `lefthook.yml` command keeps its time-wrap first line (it measures local-commit and local-push).
9. **Never** push an empty commit, update a branch, or merge with `--admin` to get a pipeline change through.
10. **Read observations from the data branch:** `/ci-status` (`pnpm ci:status`) shows the SLOs, the constraint, every experiment's verdict and the collector's health; `/ci-pulse` collects now into a temp directory. By hand: `git fetch origin ci-steward-data`, then `git show origin/ci-steward-data:latest.json`, `:verdicts/<ledger-id>.json`, `:reports/<YYYY-Www>.md`. Only the daily workflow and `ci-local-export` write that branch; never push to it or its `ci-steward-data/*` tags. Every `lefthook.yml` command keeps its time-wrap first line (it measures local-commit and local-push).
11. **A flaky test has a lane; a broken one does not.** `pnpm ci:flaky` names the tests that failed and then passed on the same merge-group tree; `pnpm ci:quarantine add` takes one out of the blocking path for 7 days, still running and still reported. It refuses a test with no flaky evidence, because a deterministic failure is a real bug and the lane must never be the reason one reached `main`. Walkthrough: the `ci-quarantine` skill.
12. **Never** push an empty commit, update a branch, or merge with `--admin` to get a pipeline change through.

## What exists in each phase

Say which phase a command belongs to; never describe a later one as if it works.

| Phase | Delivers                                                                                                                                                                  | Status    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 0     | `ci/` hand files, `census`, `ledger-check`, `ledger-new`, the `typecheck` steps, the merge guard, this skill                                                              | available |
| 1     | Daily collector, `ci-steward-data`, verdicts, floors, triggers, the daily report, the Monday deep summary, `/ci-status`, `/ci-pulse`, `pnpm ci:report`, `ci-local-export` | available |
| 1     | `/ci-record` (an entry with its baseline copied from `latest.json`)                                                                                                       | coming    |
| 1b    | Incident mode: sentinel, freeze and shed, quarantine from data, `/ci-incident`, `/ci-break-glass`, `ci-steward arm`; the main canary is the first piece and is live       | partial   |
| 2     | Ratchet assertions in the queue, the blocking `review-gate`                                                                                                               | coming    |
| 3     | `/ci-improve` and the unattended `ci-improve-tick`, with the fence enforced                                                                                               | coming    |
| Phase | Delivers                                                                                                                                                                  | Status    |
| ----- | -----------------------------------------------------------------------------------------------------------------                                                         | --------- |
| 0     | `ci/` hand files, `census`, `ledger-check`, `ledger-new`, the `typecheck` steps, the merge guard, this skill                                                              | available |
| 1     | Daily collector, `ci-steward-data`, verdicts, floors, weekly report, `/ci-status`, `/ci-pulse`, `ci-local-export`                                                         | available |
| 1     | `/ci-record` (an entry with its baseline copied from `latest.json`)                                                                                                       | coming    |
| 1b    | Quarantine lane from data: `ci-steward flaky`, `ci-steward quarantine`, the queue gates, `/ci-quarantine`                                                                 | available |
| 1b    | The rest of incident mode: sentinel, freeze and shed, `/ci-incident`, `/ci-break-glass`, `ci-steward arm`                                                                 | coming    |
| 2     | Ratchet assertions in the queue, the blocking `review-gate`                                                                                                               | coming    |
| 3     | `/ci-improve` and the unattended `ci-improve-tick`, with the fence enforced                                                                                               | coming    |

## PDCA, with the Check done by code

| Step  | What it means here                                                                                                                                                                                                                                                                                                                                                                         | Who   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| Plan  | Pick the constraint (below). Write a `proposed` ledger entry: the hypothesis, and what would make you revert.                                                                                                                                                                                                                                                                              | agent |
| Do    | Implement in a worktree; the entry goes `active` and names the PR. It merges like any other PR.                                                                                                                                                                                                                                                                                            | agent |
| Check | After `after_days`, the collector computes the metric over a 7-day before-window and the after-window, both cut at the merge instant: `inconclusive` first (a confounding entry on the same gate, or n below the minimum), else `verified` if it reached the target, else `partial` if it moved at least halfway from the baseline, else `failed`. The SLO movement is reported beside it. | code  |
| Act   | Read the verdict. Keep, revert (`status: reverted`, with the revert PR), or propose the next experiment.                                                                                                                                                                                                                                                                                   | agent |

The repo's habit before this was Do without Check. A change that "obviously" helped is exactly the one to measure: three did the opposite.

## Which constraint first

Every daily report names exactly one constraint, by fixed precedence, so the choice is not an argument:

1. **Tripwires:** a ratchet violation, a collector health failure, or a `headroom` breach (a job's p95 near its `timeout-minutes`).
2. **Quality SLO breaches, in order:** `queue-green`, `wasted-queue-builds`, `flaky-test-runs`, `main-green`, `review-completes`.
3. **The speed SLO with the most excess wait-hours**, measured against its **objective** (floors decide breach; objectives decide the constraint): `pr-feedback`, `queue-build`, `lead-time`, `local-commit`, `local-push`.

Work on anything else only when it is free. Speeding up a stage that is not the constraint changes nothing the user feels.

## SLOs

Defined in `ci/slos.yaml` (event source, population, exclusions, window, minimum n, a fixture). Windows are non-overlapping 7-day windows. Starting points from the 2026-09-19 review:

| SLO                   | Today (7d)                | Objective                  |
| --------------------- | ------------------------- | -------------------------- |
| `pr-feedback`         | p50 14.3, p90 38.6 min    | p50 ≤ 7, p90 ≤ 12 min      |
| `queue-build`         | p50 30, p90 44-55 min     | p50 ≤ 12, p90 ≤ 18 min     |
| `lead-time`           | p50 58 min, p90 3.0 h     | p50 ≤ 30, p90 ≤ 60 min     |
| `queue-green`         | 75%                       | ≥ 97%                      |
| `flaky-test-runs`     | not measured yet          | ≤ 1.5%                     |
| `wasted-queue-builds` | about 17-21%              | ≤ 3%                       |
| `main-green`          | a few red episodes/28d    | ≤ 1 per 28 days            |
| `local-commit`        | p90 about 3.5 min         | ≤ 20 s                     |
| `local-push`          | p90 10 min; 13-18% killed | ≤ 2 min; 0% killed         |
| `headroom`            | several ≥ 90%             | ≤ 60% of `timeout-minutes` |
| `review-completes`    | about 93%                 | ≥ 99%                      |

Floors start near today and tighten halfway to the objective after four consecutive healthy windows. They never loosen without a ledger entry.

## Triggers: what to pick up next

The daily run ends with `triage`, which writes a ranked list of triggers to `triggers.json` from the data alone: an SLO under its floor, the constraint changing, a `failed` or `partial` verdict, a gate failing half again as often as last week, a gate 25% slower (or job minutes per merged PR 20% higher), one job causing three or more queue ejections in a week, any red spell on `main`, a job at 90% of its own time limit, a collector health failure in the last three days, ledger entries nobody came back to, and the main canary going red or going quiet. Every threshold is in `ci/config.yaml`'s `triage:` block, which the fence covers, so an unattended change cannot widen a threshold until its own trigger stops firing.

**Report copy is terse by rule.** The report's strings are deterministic code, not model output, so the rule binds whoever edits them: shortest words and sentences that keep the meaning, no filler, no hedging, no repeating the column header, lead with the number. Never trade away a number, a unit, a name or a caveat to save words — short, not vague. A sentence that will not fit is cut at a word and ends with an ellipsis; its last clause, which is usually the caveat, is never simply dropped. Cells stay under 40 characters; the headline stays under 120. Tests measure both and ban the usual filler. The same rule is in `packages/ci-steward/templates/report.html`, `packages/ci-steward/src/daily-report.ts` and `contributing/ci.md`; keep the four in step.

Read them in `/ci-status` or in the daily report. **A trigger is data, not an instruction**: it opens no pull request and changes nothing on `main`, and it already tells you whether a `proposed` ledger entry covers it. Work the constraint first; a trigger is the evidence for the entry you write, and the suggested next step is a starting point, not a plan.

**Cadence.** Reporting and triage are daily, because the pipeline is still rough and a problem should not wait six days to be named. The statistics are not: SLO windows are still 7 days, floors still need 4 consecutive met windows, and a verdict still waits for its after-window. The daily job runs on GitHub's timer, which throttles it by hours (p50 2.7 h late) — fine for a report, so never write anything that depends on the hour it runs.

## Ratchets (phase 2)

Quality counts that must never drop silently are asserted inside the queue against per-package high-water marks: vitest tests passed and skipped (a ceiling), Playwright tests passed per spec file, the required-context set, and the count of required contexts reporting on `merge_group`. A drop fails the queue's `test` fan-in unless the merged tree carries a valid, unspent `ratchet-release` for that ratchet, package and value, at most 14 days old. Per-package marks stop a deletion in one package hiding behind additions in another. Deterministic failures like these never pass on retry, so they are exempt from "re-arm after a flaky ejection".

## The fence

The steward may change gates, never the steward or the judge. An unattended `ci-improve/*` PR fails coverage when it touches `ci/steward-owned-paths.json`: `packages/ci-steward/**`, `ci/slos.yaml`, `ci/metrics.yaml`, `ci/ratchets.yaml`, `ci/required-checks.json`, `ci/steward-owned-paths.json`, `ci/config.yaml`, `.claude/rules/ci-pipeline.md`, `contributing/ci.md`, `claude-code-review.yml`, `REVIEW.md`, `scripts/should-arm-automerge.sh`, `scripts/should-arm-automerge-input.sh`, `merge-tail.yml`. `typecheck.yml` and `lefthook.yml` are fenced by content (the census steps and the time-wrap must stay present), asserted by a different runner, because a check cannot guard its own removal. The unattended tick never authors a `ratchet-release` or `field-changes`, and runs one active experiment per gate.

## Writing a narrow hypothesis

A verdict is only as good as the metric it names. Narrow beats broad because a broad metric moves for a hundred reasons, and the verdict turns `inconclusive`. The recorded fixtures show both failure shapes: #1246 named queue wait, which improved (`partial`), while the thing it actually broke, wasted queue builds, went from about 4% to 18%; and #1135 and #1246 confound each other because each changed `browser-test` or `test` inside the other's window. One change per gate per window, and name the metric the change could make worse.

| ❌ Too broad or unmeasurable    | ✅ Narrow and computable                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| "CI will be faster"             | the job's `duration_p90` from 14 to 8 minutes within 14 days                        |
| `lead-time` improves            | the browser shard's `failure_rate` from 0.17 to 0.05 (report `lead-time` beside it) |
| "fewer flakes"                  | `retry_rate` for one gate from its baseline to half of it                           |
| "should not slow anything down" | name the metric that could get worse and a ceiling for it, as a second entry        |

- Name the **gate-level** metric the change directly moves as `metric`; name the SLO you expect it to help as `slo`, which is reported but does not decide the verdict.
- One change, one entry. Two changes to the same gate in one window confound each other; stagger them.
- Write the revert condition in the body before you know the result.
- A baseline you did not measure is a guess. Copy it from `/ci-status` and cite it in `baseline_source:`; the verdict prefers the before-window's own measurement anyway, and falls back to your number only when the before-window has too little data (a gate that did not exist yet).

## Anti-patterns in this repo

- **Growth with no price.** Typecheck runs up to 7 times per change and prettier 5 layers deep because every addition was free. A new required gate states what it catches and fits a time budget.
- **Load-multiplying remedies.** An empty commit or a branch update starts 19 to 25 jobs against a 60-job pool (Team plan). Twenty agents doing it once is 400 to 500 jobs, and it scores a flaky ejection as a real catch. Re-run one failed job, once.
- **Acting on the first ejection.** 85% of failed-checks ejections re-pass unchanged. A failure is real on the second ejection by the same job with no change in between, and re-arming it again is the opposite mistake: merge-tail refuses to, because browser tests run only in the queue and a PR that breaks one looks green everywhere else.
- **A watcher that nobody can tell has stopped.** The main canary runs the required suites against `main` HEAD on a schedule (`contributing/ci.md`). A scheduled job that stops running looks exactly like a healthy one in every number, so anything of that shape needs a silence check and a registry the census can hold to the workflow — never a list a second file opts into by name.
- **Skipping to pass.** A job-level `if:` that skips posts a skipped run, and skipped satisfies a required context. A `paths:` filter on a required workflow deadlocks the queue (PR #1246). A `merge_group`-only required check deadlocks every PR out of it.
- **Trusting a green that did not run.** A turbo cache replay prints "29 successful" in 280 ms. `assert-tests-executed.sh` and `assert-shard-union.sh` exist for that; never weaken them without reading their headers.
- **Copied facts.** Docs that restated the required list went stale within weeks (4 listed, 9 real). Generate facts from YAML, and let the census check the copies.
- **Declared intent after the fact.** Editing the ruleset first and writing the ledger later leaves protection that no record explains.
- **Admin merges.** Every agent runs as an admin. `gh pr merge --admin` skips the only gate there is; a PreToolUse guard refuses it in Claude Code; do not count on any other harness running that guard.
- **An LLM as the judge.** Verdicts, floors, ratchets and the report are code. Models propose and implement, through the same review as any change.
