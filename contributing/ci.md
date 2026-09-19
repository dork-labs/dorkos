# CI Pipeline Guide

## Overview

This guide covers everything between an agent's edit and a change on `main`: the local hooks, the GitHub Actions checks, the merge queue, merge-tail, and CI Steward, the system that records and judges every change to the pipeline itself. Merges into `main` are fully autonomous, with no human approval ever, so the pipeline is the only thing between an agent and `main`. It is written for agents first: exact commands, exact paths, and the rules that stop twenty agents from making one incident twenty times worse.

## Key Files

| Concept                                  | Location                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Required checks (declared intent)        | `ci/required-checks.json`, mirrored into the generated block below                                                        |
| Every gate and what it is for            | `ci/gates.yaml` (`{id, source, purpose}`)                                                                                 |
| Repo-specific steward config             | `ci/config.yaml`; SLOs `ci/slos.yaml`; metric catalogue `ci/metrics.yaml`; ratchets `ci/ratchets.yaml`                    |
| Steward-owned paths (the fence)          | `ci/steward-owned-paths.json`                                                                                             |
| Census exceptions, each with a reason    | `ci/census-allowlist.yaml`                                                                                                |
| One ledger entry per pipeline change     | `ci/ledger/<YYMMDD-HHMMSS>-<slug>.md`                                                                                     |
| The engine                               | `packages/ci-steward` (`@dorkos/ci-steward`), entry `packages/ci-steward/src/cli.ts` (`--help` lists every command)       |
| The daily collector                      | `.github/workflows/ci-steward.yml` (job `collect`, 05:00 UTC, never required)                                             |
| Data-branch file formats                 | `packages/ci-steward/src/data.ts` (snapshots, `latest.json`, verdicts, floors, local exports)                             |
| Local hook timings                       | `packages/ci-steward/bin/time-wrap.sh`, the first line of every `lefthook.yml` command; export via `ci-local-export`      |
| Reading it                               | `/ci-status` (`pnpm ci:status`), `/ci-pulse` (`pnpm ci:pulse`); a SessionStart line when the collector stops or breaks    |
| Where the census runs                    | `.github/workflows/typecheck.yml` steps "CI Steward census", "CI Steward ledger check", "CI Steward ledger coverage"      |
| Local hooks                              | `lefthook.yml` (pre-commit, pre-push), `.claude/settings.json` (Claude Code hooks)                                        |
| Arming merges                            | `.github/workflows/merge-tail.yml`, decision in `scripts/should-arm-automerge.sh`                                         |
| "Did the suite really run?"              | `scripts/assert-tests-executed.sh`, pinned by `scripts/test-assert-tests-executed.sh`                                     |
| Admin-merge guard                        | `.claude/hooks/merge-guard.mjs`, fixtures `scripts/test-merge-guard.sh`                                                   |
| The PR author's side                     | `.agents/skills/creating-pull-requests/SKILL.md` and `scripts/watch-prs.sh` there                                         |
| The method (PDCA, hypotheses, the fence) | `.agents/skills/stewarding-ci-pipeline/SKILL.md`                                                                          |
| Path-triggered protocol                  | `.claude/rules/ci-pipeline.md`                                                                                            |
| Decisions                                | ADR `260728-112203` (merge queue), ADR `260919-174348` (autonomous merges), ADR `260919-174349` (hypotheses and verdicts) |
| Evidence and plan                        | `research/20260919_ci-pipeline-deep-review.md`, `plans/ci-steward-plan.md`                                                |

## When to Use What

| Situation                                                                                                                             | Do this                                                                                                                                                         | Why                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| You changed a workflow, `lefthook.yml`, `turbo.json`, `.claude/settings.json`, a gate script, `ci/**` or `packages/ci-steward/src/**` | Add a ledger entry with a hypothesis in the same commit                                                                                                         | Every pipeline change is an experiment; the coverage step checks for the entry    |
| You want a check to become required                                                                                                   | Land the job (reporting on `pull_request` **and** `merge_group`, no `paths:`) plus `ci/required-checks.json` plus a ledger entry first; edit the ruleset second | A required check that never reports deadlocks the queue                           |
| You want to stop requiring a check                                                                                                    | Ledger entry and `ci/required-checks.json` first, ruleset edit second, delete the job last                                                                      | The ruleset must never require something the declared intent does not             |
| Your PR is behind `main`                                                                                                              | Nothing                                                                                                                                                         | The queue tests the combined tree; being behind blocks nothing                    |
| A PR check failed and it is yours                                                                                                     | Fix and push                                                                                                                                                    |                                                                                   |
| A PR check failed and it is not yours (red elsewhere, infra)                                                                          | `gh run rerun <run-id> --failed`, once                                                                                                                          | One job, not a 19-to-25-job round                                                 |
| Your PR was ejected from the queue for failed checks, first time                                                                      | Read the failing job; once it is plainly not yours, `gh pr merge --auto <n>`                                                                                    | 85% re-pass unchanged; merge-tail runs only every 2-3 h                           |
| Same job ejected it twice with no change in between                                                                                   | Treat it as real: reproduce, fix, push                                                                                                                          |                                                                                   |
| The queue itself is broken or backed up                                                                                               | Say so; do not push, rerun or re-arm                                                                                                                            | Load is the problem. Incident mode (freeze, shed, break-glass) is phase 1b        |
| You are tempted to merge with admin rights                                                                                            | Don't. `gh pr merge --auto <n>`                                                                                                                                 | Admin merges skip every required check; reserved for `/ci-break-glass` (phase 1b) |

## How a change reaches `main`

```
EDIT     Claude Code hooks: four PreToolUse guards on every Bash call; typecheck, eslint and an any-ban on every edit
TURN END prettier --write on changed files (Stop hook); checkpoint in worktrees
COMMIT   lefthook pre-commit: prettier, drizzle generate, dir-size, turbo lint --affected, turbo typecheck --affected
PUSH     lefthook pre-push: prettier check on changed files, turbo test --affected (TURBO_SCM_BASE pinned to origin/main)
PR       ~19-25 Actions jobs; the 9 required checks below must pass ON THE PR before it may enter the queue
ARM      agents arm with gh pr merge --auto; merge-tail (every 2-3 h, throttled) is the backstop
QUEUE    merge_group: the required checks re-run on main + everything ahead, up to 5 PRs per group, ALLGREEN
MAIN     squash merge; a few push-to-main legs (db-check, CLI smoke, scripts-test, desktop smoke)
```

## Required checks

Ruleset 19893973 is the **only** protection on `main`. Classic branch protection was deleted on 2026-09-19, and `db-check`, `deletion` and `non_fast_forward` moved into the ruleset then. All 9 contexts are pinned to the GitHub Actions app (integration id 15368), so nothing else can post a status that satisfies them. No human approval is required and conversation resolution is off.

<!-- The block below is generated from ci/required-checks.json and checked byte for byte
     by the CI Steward census; prettier would add blank lines inside it, hence the ignore. -->
<!-- prettier-ignore-start -->
<!-- ci-steward:required-checks:start -->
- `typecheck`
- `fragment-present`
- `no-fragment-under-skip-label`
- `version-outranks-base`
- `test`
- `browser-test`
- `lint`
- `credential-free-build`
- `db-check`
<!-- ci-steward:required-checks:end -->
<!-- prettier-ignore-end -->

That block is generated from `ci/required-checks.json`, and the census fails when it drifts, here or in the `creating-pull-requests` skill. To ask the live repo:

```bash
gh api repos/{owner}/{repo}/rules/branches/main \
  --jq '[.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context]'
```

Queue settings (live, 2026-09-19): squash, `ALLGREEN`, build up to 5 and merge up to 5 per group, check timeout 120 minutes, `strict_required_status_checks_policy: false`. ADR `260728-112203` still says batch size 1; the live setting is 5.

Admin bypass is narrowed to `pull_request`: nobody pushes to `main` directly, admin included, and releases already go through a PR. An admin can still merge a **pull request** around the queue, which is what the merge guard below exists for.

## Two gates: local and Actions

**Split by what each is good at.** The lefthook `pre-push` hook runs **affected-only** tests (`turbo test --affected`): fast, survivable on a machine already busy with other agents, and it skips packages your push never touched. GitHub Actions splits by cost (2026-08-23/24, the CI-saturation fix):

- On PRs, `test` runs **affected-only** and `browser-test` reports an instant pass-through.
- The **full monorepo `test` sweep and the Playwright shards run only on `merge_group`**, as required merge-queue checks. The queue's combined-tree build decides every merge.
- The PR legs exist because GitHub requires a required check to succeed **on the PR** before the PR may enter the queue at all. A `merge_group`-only required check deadlocks every PR out of the queue (measured on PR #1246).
- Push-to-main no longer re-runs the suites: the queue already tested the exact tree content (squash rewrites the SHA, not the content).

**Sharding.** Both `test` legs are **split four ways** (`test-shard (N/4)`, DOR-1731 for the PR leg). The four shard jobs are where the suites run; `test` itself is only their fan-in, so read a red on a PR off the shard, not off `test`. Only `test` is a required context. Never make a shard one.

**`assert-tests-executed.sh`.** Turbo caches `test` and replays a full cache hit in about 280 ms while printing "29 successful". So the merge-group `test` run asserts the suites actually executed (`scripts/assert-tests-executed.sh`, pinned by `scripts/test-assert-tests-executed.sh`). Never weaken that step without reading its header. `scripts/assert-shard-union.sh` is the other half: it restores the zero-collected-files net that `--passWithNoTests` removes from the sharded sweep.

**`lint`.** Full monorepo `turbo lint` (DOR-627), full rather than affected-only for the same cross-PR interaction reason `typecheck` gives. It became a required merge-queue check on 2026-09-02 and dropped its push-to-main leg the same day, because the queue already tested the exact tree. It runs a second ESLint pass beside `turbo lint`: `pnpm lint:root` (`eslint .` from the repo root, DOR-1696), because turbo only reaches workspace packages. `scripts/`, `.claude/`, `.agents/` and `templates/` belong to none, and the hooks and automation there (the guards, the ADR and docs scripts) sat behind zero lint coverage with 164 standing errors until then. The root config declares the Node and browser globals those files need, so `no-undef` still means something there. Its first step is `pnpm format:check`, so a red `lint` is often prettier, not ESLint.

**`site-build`** compiles the marketing site (`turbo build --filter=@dorkos/site`, DOR-913), because nothing else ever did: `typecheck` type-checks the site without bundling it, and `browser-test` builds only the site's **dependencies** (`--filter=@dorkos/site^...`) and then serves the dev server. A page declaring `runtime = 'edge'` beside a node-only import was green everywhere and failed only at the Vercel deploy, blocking production for hours (PR #743, hotfixed by #755).

- It builds unconditionally on `merge_group`. On `pull_request` it builds only when the change reaches the site: turbo `--affected` intersected with the site's dependency closure, plus a `docs/` and `blog/` check. Both are prerendered content roots that `apps/site/source.config.ts` points at from outside any package, where turbo's file-to-package mapping cannot see them (a blog-only commit, which every release ships, otherwise scores as zero affected packages). A collection added there with a `dir` outside `apps/site` needs a matching entry in the workflow.
- The scope decision lives **inside the job**, never in a workflow-level `paths:` filter, so the check always reports. A path-filtered workflow reports nothing, which keeps a PR out of the queue and then stalls the queue for an hour.
- **It is not a required check yet.** Making it one is a ruleset change, the operator's to make, and it needs no edit to the workflow (and, under the steward, a ledger entry first).

**Other Actions checks.** `fragment-present` and `no-fragment-under-skip-label` (changelog), `scripts-test` (the shell fixture suites, path-filtered and advisory), and CLI smoke tests (Node 22/24) plus integration tests, which run on push to `main` and on PRs that touch what they package. Locally: `pnpm smoke:docker` and `pnpm smoke:integration`. Advisory checks such as `site-build`, `openapi-fresh`, `harness-windows` and the Claude `review` do not block the queue, but any red check stops merge-tail arming a PR.

**Capacity.** The org is on the GitHub **Team** plan: 60 concurrent jobs, not the Free plan's 20. One push to a PR starts 19 jobs (docs-only) to 25 (code); a queue entry costs about 19 to 20. Twenty agents each pushing once is 400 to 500 jobs, 7 to 8 full refills of the pool, and the queue's own builds wait behind them. That arithmetic is why no remedy anywhere here is "push an empty commit".

## The merge queue

`main` merges through a merge queue (ADR `260728-112203`). You never update a branch to satisfy a gate: GitHub builds your PR on top of `main` plus everything ahead of it in the queue, runs the required checks against that combined tree, and merges only if they pass. "Require branches to be up to date" is off, and being behind `main` blocks nothing. Consequences:

- **Every required check must report on `merge_group`.** A required check that fires only on `pull_request` blocks the queue forever. Any new required check needs `merge_group:` in its `on:` list, and the census enforces it (the deadlock invariant below).
- **Some checks stay PR-only on purpose.** Fragment _coverage_ needs the PR's labels and number, which the `merge_group` payload does not carry, so it is answered before queueing and not re-asked. Fragment _validity_ does re-run in the queue. This is sound only because a PR cannot enter the queue until its required checks pass on the PR, and neither its labels nor its diff can change afterwards.
- **A skipped job satisfies a required context.** A job-level `if:` that skips posts a _skipped_ check run, and GitHub counts skipped as passing. Never "fix" a required check by making it skip.
- **An ejection is usually not your fault.** 22% of PRs are ejected at least once; 85% of failed-checks ejections (209 of 247 over 30 days) re-pass with no change. The first response to one is to read the failing job without pushing or rerunning, and to re-arm with `gh pr merge --auto <n>` once it is plainly not yours (merge-tail would re-arm it too, but only every 2-3 hours). It counts as real only on a second ejection by the same job with no commit in between.

## merge-tail: who arms a merge

`merge-tail.yml` arms auto-merge on PRs that are finished. Its schedule says every 10 minutes, but GitHub throttles it: over 200 scheduled runs from 2026-08-25 to 09-19 the median gap was 162 minutes (p90 305, max 748), so it runs roughly every 2-3 hours and is a backstop, not the arming path. Arm your own green PR with `gh pr merge --auto <n>`, and re-arm after a failed-checks ejection once the failing job's log shows it was not yours; arming is idempotent. A finished PR is open, not a draft, no hold label (`hold`, `do-not-merge`, `do not merge`, `wip`, `blocked`), not conflicting, mergeability known, no requested changes, no unresolved review threads (outdated ones count), and every check settled green with none cancelled. Its decision is `scripts/should-arm-automerge.sh`, pinned by `scripts/test-should-arm-automerge.sh`, and it is affirmative: anything unknown is a skip.

- Apply `hold` (or `do-not-merge`, `wip`, `blocked`) to keep a green PR from being armed. The queue itself does not read labels, so a hold label on a PR that is **already** armed does nothing: disarm it with `gh pr merge --disable-auto <n>`.
- Agents may arm their own PR: `gh pr merge --auto <n>` (no strategy flag; the queue owns it). In practice most PRs are armed at creation.
- Once armed, only the required checks bind. The Claude review and open threads bind only merge-tail's arming, so a PR armed at creation merges with its findings open. The pre-PR adversarial review is the review gate that actually holds today; a blocking review gate is planned for phase 2.

## Admin merges and credentials

**No admin merges.** Every agent on this machine runs as the operator's GitHub account, which holds the admin role. `gh pr merge --admin`, a REST `PUT repos/{owner}/{repo}/pulls/<n>/merge`, and the GraphQL `mergePullRequest` mutation all land a change without the queue's checks. `.claude/hooks/merge-guard.mjs` refuses all three in Claude Code sessions (fixtures: `scripts/test-merge-guard.sh`). Admin merges are reserved for the CI Steward break-glass path, `/ci-break-glass`, which arrives in phase 1b and does not exist yet. Until then no agent has a sanctioned admin merge.

The guard is the paved road, not the fence. It reads command text only, so a script on disk, `curl` with `gh auth token`, or a harness that does not run the hook walks past it (Codex reads a generated, trust-gated `.codex/hooks.json`; whether this guard fires there is unverified). The fence arrives in phase 1b: a detector for any commit on `main` with no merge-queue provenance, and an automatic revert.

**Invariant: no admin credential exists in GitHub Actions.** Nothing automated may be able to edit the ruleset, so no automated change can un-require a check. **Status: true once the phase-0 PR merges and the old `MERGE_TAIL_TOKEN` secret is deleted, which happens right after that merge.** `merge-tail.yml` and `dependabot-lockfile-repair.yml` mint a short-lived token for the `dorkos-merge-tail` GitHub App (`actions/create-github-app-token`), which has `contents` and `pull_requests` write, `checks`, `statuses` and `metadata` read, and **no** Administration or actions permission (client id in the secret `MERGE_TAIL_APP_CLIENT_ID`, key in `MERGE_TAIL_APP_PRIVATE_KEY`), in place of the admin-account PAT. Phase 0's exit gate proves two things about it: a REST merge of a blocked PR with the app token is refused, and a merge group the app token enqueues receives check runs (groups created by `GITHUB_TOKEN` get none and jam the queue).

## CI Steward: how the pipeline itself changes

The pipeline changed about 13 times a week, each change well documented, and none checked afterwards: 0 of about 94 changes had a planned post-rollout check, and 3 results found by accident contradicted their change. CI Steward closes that loop (plan: `plans/ci-steward-plan.md`; method: the `stewarding-ci-pipeline` skill).

### Intent on `main`, observations on the data branch

| Where                                  | What                                                                                        | Written by                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `main`: `ci/` hand files, `ci/ledger/` | What we want: gates and their purpose, required checks, SLOs, metrics, ratchets, the ledger | People and agents, through PRs                |
| `ci-steward-data` (orphan branch)      | What happened: daily snapshots, computed verdicts, floors, high-water marks, weekly reports | The daily collector only, with `GITHUB_TOKEN` |

Nothing the system generates ever needs a PR. Ruleset 23704437 makes `ci-steward-data` append-only (no deletion, no force-push, no bypass), and ruleset 23705388 makes its weekly backup tags `ci-steward-data/YYYY-Www` permanent. Read it with `/ci-status`, or by hand: `git fetch origin ci-steward-data`, then `git show origin/ci-steward-data:latest.json` (or `:verdicts/<ledger-id>.json`, `:reports/<YYYY-Www>.md`, `:snapshots/<YYYY-MM-DD>.json`). The collector's first run creates the branch; until then `/ci-status` says so and `/ci-pulse` collects into a temporary directory instead.

### The ledger

One file per pipeline change, `ci/ledger/<YYMMDD-HHMMSS>-<slug>.md` (ids from `.claude/scripts/id.ts`, so fragments never conflict):

```yaml
---
id: 260919-143012
title: Quarantine flaky browser specs out of the blocking lane
kind: experiment # experiment | incident-fix | hygiene
status: active # hand states only: proposed | active | withdrawn | reverted
actor: agent # agent | ci-improve-tick
gates: [wf.browser-test.browser-shard]
prs: [1931]
hypothesis: # required unless kind: hygiene
  metric: gate.wf.browser-test.browser-shard.failure_rate # a catalogue id (ci/metrics.yaml), the narrowest that can move
  baseline: 0.17
  baseline_source: research/20260919_ci-pipeline-02-timings.md # phase 0: hand-copied, say where from
  target: 0.05
  after_days: 14 # the after-window, anchored on the merge time
ratchet-release: []
floor-release: [] # [{slo, stat, value, reason}]: the only way an SLO floor loosens
field-changes: []
---
Why, what was tried, what would make us revert. Short.
```

- `node packages/ci-steward/src/cli.ts ledger-new --slug <kebab-slug> [--kind experiment|incident-fix|hygiene]` scaffolds an entry with a fresh id and prints its path (`--help` lists every command and flag); `ledger-check` validates every entry. Root aliases: `pnpm ci:census`, `pnpm ci:ledger-check`, `pnpm ci:ledger-new`. The engine's schema is the authority; the example above is the plan's shape.
- `verified`, `partial`, `failed` and `inconclusive` are **verdicts**, computed by code into `verdicts/<id>.json` on the data branch once the after-window closes (the rules are under "Observing" below). They never appear on `main`; the validity check rejects them.
- **Coverage:** a PR that touches any gate source, any script a gate invokes, `turbo.json`, `lefthook.yml`, `.claude/settings.json`, a `ci/` hand file, `packages/ci-steward/src/**` or the `creating-pull-requests` skill must add or edit a ledger entry. The PR-only `typecheck` step "CI Steward ledger coverage" checks it. Only a new entry counts, or an existing entry whose `prs:` gains this PR's number (how an implemented proposal records its PR); a typo fix in an old entry does not. A missing entry fails the PR. Dependabot PRs are exempt (the step's `if:` skips them): Dependabot cannot write an entry, and its version-bump PRs would otherwise stay red forever. On a `ci-improve/*` branch, touching a fenced path fails it too.
- **Ratchet releases block by default.** A `ratchet-release` lowers a quality floor on its own say-so, so the review treats it as blocking unless the reason is specific. `field-changes` is required when a required gate's retry, shards, timeout or required status changes.

### Observing: the collector, verdicts, floors and the report

**The daily run.** `.github/workflows/ci-steward.yml` runs at 05:00 UTC (and on `workflow_dispatch`): `data-prepare` checks out `ci-steward-data`, `daily` runs `collect`, then `verdicts`, then on Mondays `report`, and `data-publish` pushes, fetching, rebasing and retrying if the local export pushed first, then tags the head `ci-steward-data/YYYY-Www` whenever this ISO week has no backup tag yet (so a failed Monday is covered by the next good run). The checkout keeps no credentials (`persist-credentials: false`), so no token sits in `.git/config` during `pnpm install`; only the publish step gets `CI_STEWARD_PUSH_TOKEN`, which the engine hands to git as an HTTP header through `GIT_CONFIG_*` variables. It is never a required check and never will be: it runs on no PR or merge-group event. Any command runs locally too; pass `--data <dir>` (a working tree of the branch) and `--now <iso>` to pin the clock.

**What `collect` reads, per UTC day, all through `gh`:** every Actions run created that day, fetched in created-time windows split until each is under the API's 1,000-result cap and asserted against its `total_count`; the jobs of every head SHA (one `commits/{sha}/check-runs` call each), mapped back to gate ids and kept per event (`<gate-id>@pull_request`, `@merge_group`, ...), so a shard's PR leg and queue leg stay apart; the timelines of every PR merged that day (queue entries, removals and their reasons, new commits), paged to the end, because a timeline comes oldest first and a cut-off one loses exactly the merge and the last queue events; a sample of queue builds' test reports (`collect.artifact_builds_per_day`) for flaky-test-runs; the releases, the Actions cache, and the three rulesets. It writes `snapshots/YYYY-MM-DD.json` and `latest.json`. `latest.json` never moves back: it points at the newest complete day on disk, so a run that only backfilled August still reads as today, and it carries this run's failures even when the day it points at was healthy.

**Late, never truncated.** `GITHUB_TOKEN` allows 1,000 REST requests an hour for the repository; the collector stops at `collect.api_budget` (700). A day it cannot finish is written with `complete: false` and resumed by the next run, SHA by SHA, without double counting. Days are planned yesterday first, then missing or late days in the last `collect.lookback_days`, then backfill back to `collect.backfill_from`, oldest first, because Actions keeps run data for 90 days. Measured on 2026-09-19: a quiet day costs about 35 requests, a 1,666-run day about 180.

**The health block, and what turns the run red.** Every snapshot records pages fetched against `total_count`, head SHAs done, each SLO's n against its `min_n`, API requests, gaps in the series, the age of each clone's local export, the merge-queue ruleset reconciled against `ci/required-checks.json`, and whether rulesets 23704437 and 23705388 still exist, are active, still carry their rules and have no bypass actor (an admin token sees the list; any token sees whether it could bypass). A shortfall against `total_count` or against the merged-PR search's count (which also keeps that day `complete: false`, so the next run fetches it again rather than trusting it forever), a drifted ruleset, a missing or changed safeguard, an API error, or a local export more than 3 days old (measured from the clone's `exported.json` heartbeat, which every export run writes, so an idle clone is not a stale one; a clone silent for 14 days counts as retired, reported but not red) fails the run and marks the snapshot unhealthy; the snapshot is still published so `/ci-status` shows why. A late day, a thin sample and an unmeasured SLO are warnings, never red.

**Verdicts** (`verdicts/<ledger-id>.json`, for every entry with a hypothesis and a merged PR):

1. The anchor is the merge time of the entry's last merged PR. The before-window is the `verdicts.before_days` × 24 hours before it (7), the after-window the `after_days` × 24 hours after it, both cut at that instant. Samples that carry a time (durations, waits) are cut exactly; metrics kept as daily counts (failure and retry rates, catches, SLO shares) read only the whole days inside each window.
2. `pending` until the day holding the after-window's end has been collected, and while any of the window's days still lacks a complete snapshot the collector can fetch (its backfill); `inconclusive` if such a day is past Actions' 90-day retention.
3. `inconclusive` first, naming why: another ledger entry touching one of the same gates merged inside the after-window (a confounder), or the after-window's sample is below the minimum (`verdicts.min_n`, or the SLO's own `min_n`).
4. `verified` when the after-window's value reached `target`.
5. `partial` when it missed the target but moved at least halfway from the baseline toward it. The baseline is the before-window's own reading when it has enough data, otherwise the ledger's `baseline` (for a gate that did not exist before the change).
6. `failed` otherwise.

The entry's `slo` is read over the same windows and reported beside the verdict as better, worse or flat, so a gate that got faster while its SLO got worse is visible. A final verdict is kept as it is unless the hypothesis changes, because Actions data older than 90 days cannot be read again. There is no automatic revert on `failed`: the verdict leads the report, and the next change decides with the numbers in front of it. The three backfilled entries are the recorded fixtures (`packages/ci-steward/src/__tests__/verdicts.test.ts`): each of #1135, #1246 and #1391 comes out `partial` on its own, and against the whole ledger #1135 and #1246 are `inconclusive`, each confounded by the next change to the same gate.

**Floors** (`floors.json`, moved by `report` each Monday): when an SLO is `met` or `ok` for 4 consecutive non-overlapping weekly windows, each floor value tightens halfway to the objective, and the streak starts again. A floor never loosens except through a ledger entry's `floor-release`, applied once and recorded.

**The constraint** is exactly one, by fixed precedence: (1) a tripwire, meaning a collector health failure or a `headroom` breach (ratchet violations join in phase 2); (2) a quality SLO in breach, in `ci/slos.yaml` order; (3) the SLO with the most excess wait-hours against its **objective**: the sum over the population of each item's time beyond the tail objective, plus killed pushes at the tool ceiling for `local-push` and wasted builds at (median ejected wait − median clean queue build) for `wasted-queue-builds`.

**The weekly report**, `reports/YYYY-Www.md`, is deterministic Markdown (the same inputs render the same bytes): the SLO trend over four weekly windows first, then the constraint, the verdicts issued, real catches per gate (an ejection for failed checks followed by a new commit before re-queue; the rest are wasted builds), the tracked metrics, and the collector's own health.

**Local hook timings.** Every `lefthook.yml` command opens with `[ -r packages/ci-steward/bin/time-wrap.sh ] && . packages/ci-steward/bin/time-wrap.sh && ci_steward_time_wrap <hook> <command>` (the guard means a checkout without the script runs the hook untimed, never broken). It is sourced, not a wrapper process, so the command runs in the same shell with the same stdin and exit status; it appends START and END lines to `$(git rev-parse --git-common-dir)/ci-steward/local-timings.jsonl`, shared by every worktree of the clone, and swallows its own errors (`CI_STEWARD_TIMINGS=0` switches it off). INT, TERM and HUP are trapped: the END gets 128+n and the hook exits with it (without the trap, macOS `/bin/sh` recorded a SIGTERM'd hook as a pass and dash wrote no END). A killed run is an END with such a status, or a START with no END older than `local.killed_after_seconds` (7500: the pre-push watchdog's own 7200-second ceiling plus margin, so a push still running is never called killed; SIGKILL runs no trap). Gate metrics may name one leg: `gate.<id>.<metric>@merge_group` or `@pull_request` (`ci/metrics.yaml` `event_qualifiers`). The `ci-local-export` scheduled skill runs `pnpm ci:local-export` daily at 04:30 UTC: it pushes one aggregate per finished day to `local/<clone>/` and a heartbeat `local/<clone>/exported.json`, then trims the file to 30 days and 5 MB (keeping any line appended while it rewrites, so an END is never lost into a phantom kill). It waits on the Schedules page as "Waiting for approval" until the operator approves it with **Approve at Full autonomy**; it runs Bash and `git push`, which a schedule that arrives in a file is held back from (DOR-2100). Runs under `--no-verify` are invisible to it.

**The dead-man's switch.** `.claude/hooks/session-maintenance.sh` runs `packages/ci-steward/bin/session-line.mjs` (plain JavaScript, no type stripping) at SessionStart, only when `origin/ci-steward-data` exists locally and behind a hard 0.4-second timeout, so a slow start under load is silence rather than a slow session. It reads `latest.json` with `git cat-file` (no network) and prints one `[Harness]` line when the newest snapshot is over 2 days old (saying the collector stopped only when this checkout has fetched since; otherwise that the local copy is not fetched), its health failed, a safeguard is reported missing, a local SLO is in breach, or this clone's last hook run in the last 6 hours was killed.

**If the data branch is missing.** The collector never recreates it once a backup tag exists; `data-prepare` fails and the job summary prints the restore command, which pushes the newest tag's commit back to the branch: `git fetch origin tag ci-steward-data/<YYYY-Www> && git push origin 'ci-steward-data/<YYYY-Www>^{commit}:refs/heads/ci-steward-data'`. It creates the branch only on the very first run, when neither the branch nor any tag exists. Worktree sweeps (`scripts/worktree-janitor.sh`) treat the branch as protected.

### The census and the deadlock invariant

`node packages/ci-steward/src/cli.ts census` generates the facts that live in YAML (triggers, events reported on, required, timeout, retries, shards, invoked scripts) and fails when:

- a gate exists in YAML but not in `ci/gates.yaml`, or the reverse (ids: `wf.<workflow-stem>.<job-id>`, `lefthook.<hook>.<command>`, `claude.<HookEvent>.<script-basename>`, `ruleset.<rule>`);
- a job has no `timeout-minutes`;
- **deadlock invariant:** a context in `ci/required-checks.json` has no job of that exact name, or its workflow lacks `pull_request` or `merge_group`, or has a `paths:` filter, or its `pull_request.types` (if present) omits `synchronize`, or a job-level `if:` cannot be satisfied on both events;
- a required job, or any job it needs (directly or through other jobs), contains `continue-on-error`, or a step-level `if:` that is not true on both events on a green run (`!cancelled()` is), or the required job's own job-level `if:` can skip it, and no `ci/census-allowlist.yaml` entry excuses it. Every entry carries a reason; a `no-timeout` entry also carries `expires:`, and any other entry does when the exception is temporary;
- a required fan-in runs with `always()` (or `!cancelled()`) but no step reads `needs.<job>.result` for each job it needs (or `needs.*.result`), so a red dependency would report green;
- an allowlist entry has expired, or excuses nothing any more;
- a generated block (the required-checks list here and in the `creating-pull-requests` skill) differs byte for byte from `ci/required-checks.json`. `census --fix` rewrites the blocks.

It runs as a step of the required `typecheck` job on every PR and every merge group, so it adds no new required context and no deadlock exposure of its own.

**An expiry is a deadline for a person, never a switch.** When an allowlist entry expires, the census fails on every PR, whatever the PR touches, until a PR removes the entry. That is correct for an exception that has genuinely gone stale (a `no-timeout` job that now has data, a `continue-on-error` that was meant to be temporary), and it is an outage if the date was used to schedule a behaviour change. So never schedule a behaviour change with an expiry: if a change must happen on a date, put the date in `ci/config.yaml` and have the tool read it. An entry gets an `expires:` only when a person should act before then. Event-branching `step-if` and `job-if` entries, and harmless `continue-on-error` artifact uploads, are permanent design and carry no expiry.

### Ledger release first, ruleset edit second

The ruleset is edited by hand, with the operator's admin session, and nothing in Actions can edit it. So changes to the required set go in this order:

1. **PR:** the ledger entry (with `field-changes`), the `ci/required-checks.json` change, the regenerated blocks, and, when adding a check, the job itself reporting on both `pull_request` and `merge_group`. It merges through the queue.
2. **Ruleset edit**, after that PR is on `main`.
3. **When removing a check,** a later PR may delete the job, once the ruleset no longer requires it.

The other order leaves a window where live protection differs from declared intent with no record of why, and when adding a check it can require a context no job on `main` reports yet, which deadlocks the queue.

### The fence

The steward may change gates, never the steward or the judge. When the unattended `ci-improve-tick` exists (phase 3), the coverage step fails a `ci-improve/*` PR that touches any path in `ci/steward-owned-paths.json`: `packages/ci-steward/src/**`, `ci/slos.yaml`, `ci/metrics.yaml`, `ci/ratchets.yaml`, `ci/required-checks.json`, `ci/steward-owned-paths.json`, `ci/config.yaml`, `.claude/rules/ci-pipeline.md`, this guide, `claude-code-review.yml`, `REVIEW.md`, `scripts/should-arm-automerge.sh` and `merge-tail.yml`. `typecheck.yml` and `lefthook.yml` are fenced by content instead (the census steps and the time-wrap must stay present), checked by a different runner, because the census cannot guard its own removal.

### What exists now

| Piece                                                                                            | Phase | Status      |
| ------------------------------------------------------------------------------------------------ | ----- | ----------- |
| `ci/` hand files, `census`, `ledger-check`, `ledger-new`, typecheck steps                        | 0     | on `main`   |
| Merge guard, de-staled `creating-pull-requests` skill and watcher                                | 0     | on `main`   |
| `MERGE_TAIL_TOKEN` replaced by the `dorkos-merge-tail` app                                       | 0     | on `main`   |
| Daily collector, data branch, verdicts, floors, weekly report, `/ci-status`, `/ci-pulse`         | 1     | this change |
| Local hook timings (time-wrap) and the `ci-local-export` scheduled skill                         | 1     | this change |
| `/ci-record` (writes an entry with its baseline read from `latest.json`)                         | 1     | not built   |
| Incident mode: sentinel, freeze, quarantine, `/ci-incident`, `/ci-break-glass`, `ci-steward arm` | 1b    | not built   |
| Ratchet assertions, the blocking `review-gate`                                                   | 2     | not built   |
| `/ci-improve`, `ci-improve-tick`, fence enforcement                                              | 3     | not built   |

The `/ci-*` entry points are skills, not commands (`.claude/commands` is legacy): each is a skill in `.agents/skills/` with `disable-model-invocation: true` that wraps one `pnpm ci:<verb>` engine command. `ci-improve-tick` and `ci-local-export` are DorkOS scheduled skills (a `schedule:` block, see `docs/guides/task-scheduler.mdx`): each waits on the Schedules page as "Waiting for approval" until the operator approves it at Full autonomy, because it runs Bash. The daily collector is a GitHub Actions cron, because it must run while the operator's machine sleeps.

Never document a later-phase skill as if it works; name its phase.

## Anti-Patterns

```bash
# ❌ Re-roll CI with an empty commit: 19-25 jobs, a disarm, and a flake scored as a real catch
git commit --allow-empty -m "retrigger" && git push
# ✅ Not yours: re-run the one failed job, once
gh run rerun <run-id> --failed

# ❌ Update a branch to "keep it current" (pre-queue habit; nothing requires it)
gh pr update-branch <n>
# ✅ Nothing. The queue builds on main for you.

# ❌ Merge around the queue
gh pr merge <n> --admin
# ✅ Let merge-tail arm it, or arm it yourself
gh pr merge --auto <n>

# ❌ Ask classic protection which checks are required (retired; returned 6 of 9)
gh api repos/{owner}/{repo}/branches/main/protection
# ✅ Ask the ruleset
gh api repos/{owner}/{repo}/rules/branches/main
```

- ❌ A required check whose workflow has a `paths:` filter, or lacks `merge_group:`. ✅ Decide scope inside the job and always report.
- ❌ A job-level `if:` that skips a required check. ✅ Run and pass explicitly; a skipped run satisfies the requirement.
- ❌ Editing the ruleset, then writing the ledger. ✅ Ledger and `ci/required-checks.json` first.
- ❌ A pipeline change with "should be faster" as its reason. ✅ One catalogue metric, a baseline, a target, a date.
- ❌ Pushing or rerunning on the first failed-checks ejection. ✅ Read the failing job, then re-arm with `gh pr merge --auto <n>` once it is plainly not yours.

## Troubleshooting

### A required check sits "Expected: waiting for status to be reported"

**Cause:** the workflow did not run for this event: a `paths:` filter, a missing `merge_group:` trigger, or a conflicting PR (GitHub runs no workflows when it cannot build the test-merge commit). **Fix:** rebase if conflicting; otherwise the workflow is wrong, and the census should have caught it. Fix the workflow with a ledger entry.

### "CI Steward census" is red in `typecheck`

**Cause:** YAML and the `ci/` hand files disagree (a new job with no `ci/gates.yaml` entry, a missing `timeout-minutes`, a generated block out of date, a required check that can deadlock). **Fix:** read the step log, which names the gate. `node packages/ci-steward/src/cli.ts census --fix` regenerates the blocks; gates and timeouts are hand edits.

### "CI Steward ledger coverage" is red

**Cause:** the PR touches a pipeline path and adds no `ci/ledger/` entry. **Fix:** `node packages/ci-steward/src/cli.ts ledger-new --slug <what-changed>`, fill in the hypothesis, amend it into the commit.

### `fragment-present` red on a `skip-changelog` PR

**Cause:** the label raced the `opened` event, whose payload is what the step reads. A re-run replays the same payload and fails again. **Fix:** reword a genuinely non-user-facing commit to `chore(`/`ci(` and force-push, or drop the label and add a fragment. See the `creating-pull-requests` skill.

### The ci-steward workflow is red

**Cause:** the collector's own health failed; it is never a PR's problem. **Fix:** read the job summary or `/ci-status`, where each failure names its fix: a truncated fetch (re-run the workflow), a drifted ruleset (put the ruleset back, or land a ledgered PR that matches it), a missing safeguard ruleset (restore it; `plans/ci-steward-status.md` §3 records how each was made), or a stale local export (approve or re-run `ci-local-export`).

### "The ci-steward-data branch is missing"

**Cause:** the branch was deleted despite ruleset 23704437, or the ruleset was removed first. **Fix:** run the restore command the job summary prints (the newest `ci-steward-data/*` tag's commit, pushed to the branch), then re-run the workflow. Never create an empty branch by hand: it would bury the history the tags still hold.

### The queue holds many PRs and nothing merges

**Cause:** usually a flaky required job ejecting groups, runner starvation, or a GitHub Actions outage (githubstatus.com; one on 2026-08-26 held the queue for about 4 hours). **Fix:** do not push, rerun or re-arm. Name the failing job and the evidence where the operator will see it. Automated freeze and recovery are phase 1b.
