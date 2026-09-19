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
| The engine (census, ledger)              | `packages/ci-steward` (`@dorkos/ci-steward`), entry `packages/ci-steward/src/cli.ts`                                      |
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

| Situation                                                                                                                         | Do this                                                                                                                                                         | Why                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| You changed a workflow, `lefthook.yml`, `turbo.json`, `.claude/settings.json`, a gate script, `ci/**` or `packages/ci-steward/**` | Add a ledger entry with a hypothesis in the same commit                                                                                                         | Every pipeline change is an experiment; the coverage step checks for the entry    |
| You want a check to become required                                                                                               | Land the job (reporting on `pull_request` **and** `merge_group`, no `paths:`) plus `ci/required-checks.json` plus a ledger entry first; edit the ruleset second | A required check that never reports deadlocks the queue                           |
| You want to stop requiring a check                                                                                                | Ledger entry and `ci/required-checks.json` first, ruleset edit second, delete the job last                                                                      | The ruleset must never require something the declared intent does not             |
| Your PR is behind `main`                                                                                                          | Nothing                                                                                                                                                         | The queue tests the combined tree; being behind blocks nothing                    |
| A PR check failed and it is yours                                                                                                 | Fix and push                                                                                                                                                    |                                                                                   |
| A PR check failed and it is not yours (red elsewhere, infra)                                                                      | `gh run rerun <run-id> --failed`, once                                                                                                                          | One job, not a 19-to-25-job round                                                 |
| Your PR was ejected from the queue for failed checks, first time                                                                  | Nothing; merge-tail re-queues it                                                                                                                                | 85% re-pass unchanged                                                             |
| Same job ejected it twice with no change in between                                                                               | Treat it as real: reproduce, fix, push                                                                                                                          |                                                                                   |
| The queue itself is broken or backed up                                                                                           | Say so; do not push, rerun or re-arm                                                                                                                            | Load is the problem. Incident mode (freeze, shed, break-glass) is phase 1b        |
| You are tempted to merge with admin rights                                                                                        | Don't. `gh pr merge --auto <n>`                                                                                                                                 | Admin merges skip every required check; reserved for `/ci:break-glass` (phase 1b) |

## How a change reaches `main`

```
EDIT     Claude Code hooks: four PreToolUse guards on every Bash call; typecheck, eslint and an any-ban on every edit
TURN END prettier --write on changed files (Stop hook); checkpoint in worktrees
COMMIT   lefthook pre-commit: prettier, drizzle generate, dir-size, turbo lint --affected, turbo typecheck --affected
PUSH     lefthook pre-push: prettier check on changed files, turbo test --affected (TURBO_SCM_BASE pinned to origin/main)
PR       ~19-25 Actions jobs; the 9 required checks below must pass ON THE PR before it may enter the queue
ARM      merge-tail (every 10 min) arms finished PRs; agents may arm with gh pr merge --auto
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
- **An ejection is usually not your fault.** 22% of PRs are ejected at least once; 85% of failed-checks ejections (209 of 247 over 30 days) re-pass with no change. The first response to one is to wait for merge-tail to re-queue it. It counts as real only on a second ejection by the same job with no commit in between.

## merge-tail: who arms a merge

`merge-tail.yml` arms auto-merge every 10 minutes on PRs that are finished: open, not a draft, no hold label (`hold`, `do-not-merge`, `do not merge`, `wip`, `blocked`), not conflicting, mergeability known, no requested changes, no unresolved review threads (outdated ones count), and every check settled green with none cancelled. Its decision is `scripts/should-arm-automerge.sh`, pinned by `scripts/test-should-arm-automerge.sh`, and it is affirmative: anything unknown is a skip.

- Apply `hold` (or `do-not-merge`, `wip`, `blocked`) to keep a green PR from being armed. The queue itself does not read labels, so a hold label on a PR that is **already** armed does nothing: disarm it with `gh pr merge --disable-auto <n>`.
- Agents may arm their own PR: `gh pr merge --auto <n>` (no strategy flag; the queue owns it). In practice most PRs are armed at creation.
- Once armed, only the required checks bind. The Claude review and open threads bind only merge-tail's arming, so a PR armed at creation merges with its findings open. The pre-PR adversarial review is the review gate that actually holds today; a blocking review gate is planned for phase 2.

## Admin merges and credentials

**No admin merges.** Every agent on this machine runs as the operator's GitHub account, which holds the admin role. `gh pr merge --admin`, a REST `PUT repos/{owner}/{repo}/pulls/<n>/merge`, and the GraphQL `mergePullRequest` mutation all land a change without the queue's checks. `.claude/hooks/merge-guard.mjs` refuses all three in Claude Code sessions (fixtures: `scripts/test-merge-guard.sh`). Admin merges are reserved for the CI Steward break-glass path, `/ci:break-glass`, which arrives in phase 1b and does not exist yet. Until then no agent has a sanctioned admin merge.

The guard is the paved road, not the fence. It reads command text only, so a script on disk, `curl` with `gh auth token`, or a harness that does not run the hook walks past it (Codex reads a generated, trust-gated `.codex/hooks.json`; whether this guard fires there is unverified). The fence arrives in phase 1b: a detector for any commit on `main` with no merge-queue provenance, and an automatic revert.

**Invariant: no admin credential exists in GitHub Actions.** Nothing automated may be able to edit the ruleset, so no automated change can un-require a check. **Status: true once the phase-0 PR merges and the old `MERGE_TAIL_TOKEN` secret is deleted, which happens right after that merge.** `merge-tail.yml` and `dependabot-lockfile-repair.yml` mint a short-lived token for the `dorkos-merge-tail` GitHub App (`actions/create-github-app-token`), which has contents, pull-requests and actions write and **no** Administration, in place of the admin-account PAT. Phase 0's exit gate proves two things about it: a REST merge of a blocked PR with the app token is refused, and a merge group the app token enqueues receives check runs (groups created by `GITHUB_TOKEN` get none and jam the queue).

## CI Steward: how the pipeline itself changes

The pipeline changed about 13 times a week, each change well documented, and none checked afterwards: 0 of about 94 changes had a planned post-rollout check, and 3 results found by accident contradicted their change. CI Steward closes that loop (plan: `plans/ci-steward-plan.md`; method: the `stewarding-ci-pipeline` skill).

### Intent on `main`, observations on the data branch

| Where                                  | What                                                                                        | Written by                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `main`: `ci/` hand files, `ci/ledger/` | What we want: gates and their purpose, required checks, SLOs, metrics, ratchets, the ledger | People and agents, through PRs                |
| `ci-steward-data` (orphan branch)      | What happened: daily snapshots, computed verdicts, floors, high-water marks, weekly reports | The daily collector only, with `GITHUB_TOKEN` |

Nothing the system generates ever needs a PR. Ruleset 23704437 makes `ci-steward-data` append-only (no deletion, no force-push, no bypass). The branch and its collector arrive in phase 1; once they exist, read an observation with `git fetch origin ci-steward-data` and then `git show origin/ci-steward-data:latest.json` (or `:verdicts/<ledger-id>.json`, `:reports/<YYYY-Www>.md`).

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
field-changes: []
---
Why, what was tried, what would make us revert. Short.
```

- `node packages/ci-steward/src/cli.ts ledger-new --slug <kebab-slug> [--kind experiment|incident-fix|hygiene]` scaffolds an entry with a fresh id and prints its path (`--help` lists every command and flag); `ledger-check` validates every entry. Root aliases: `pnpm ci:census`, `pnpm ci:ledger-check`, `pnpm ci:ledger-new`. The engine's schema is the authority; the example above is the plan's shape.
- `verified`, `failed` and `inconclusive` are **verdicts**, computed by code on the data branch after the window closes (phase 1). They never appear on `main`; the validity check rejects them.
- **Coverage:** a PR that touches any gate source, any script a gate invokes, `turbo.json`, `lefthook.yml`, `.claude/settings.json`, a `ci/` hand file, `packages/ci-steward/**` or the `creating-pull-requests` skill must add or edit a ledger entry. The PR-only `typecheck` step "CI Steward ledger coverage" checks it. A missing entry fails the PR. On a `ci-improve/*` branch, touching a fenced path fails it too.
- **Ratchet releases block by default.** A `ratchet-release` lowers a quality floor on its own say-so, so the review treats it as blocking unless the reason is specific. `field-changes` is required when a required gate's retry, shards, timeout or required status changes.

### The census and the deadlock invariant

`node packages/ci-steward/src/cli.ts census` generates the facts that live in YAML (triggers, events reported on, required, timeout, retries, shards, invoked scripts) and fails when:

- a gate exists in YAML but not in `ci/gates.yaml`, or the reverse (ids: `wf.<workflow-stem>.<job-id>`, `lefthook.<hook>.<command>`, `claude.<HookEvent>.<script-basename>`, `ruleset.<rule>`);
- a job has no `timeout-minutes`;
- **deadlock invariant:** a context in `ci/required-checks.json` has no job of that exact name, or its workflow lacks `pull_request` or `merge_group`, or has a `paths:` filter, or its `pull_request.types` (if present) omits `synchronize`, or a job-level `if:` cannot be satisfied on both events;
- a required job contains `continue-on-error`, or a step-level `if:` that is not true on both events on a green run (`!cancelled()` is), or its job-level `if:` can skip it, and no `ci/census-allowlist.yaml` entry excuses it. Every entry carries a reason; `continue-on-error` and `no-timeout` entries also carry `expires:`;
- an allowlist entry has expired, or excuses nothing any more;
- a generated block (the required-checks list here and in the `creating-pull-requests` skill) differs byte for byte from `ci/required-checks.json`. `census --fix` rewrites the blocks.

It runs as a step of the required `typecheck` job on every PR and every merge group, so it adds no new required context and no deadlock exposure of its own.

**An expiry is a deadline for a person, never a switch.** When an allowlist entry expires, the census fails on every PR, whatever the PR touches, until a PR removes the entry. That is correct for an exception that has genuinely gone stale (a `no-timeout` job that now has data, a `continue-on-error` that was meant to be temporary), and it is an outage if the date was used to schedule a behaviour change. So never schedule a behaviour change with an expiry: if a change must happen on a date, put the date in `ci/config.yaml` and have the tool read it. An entry gets an `expires:` only when a person should act before then. Event-branching `step-if` and `job-if` entries are permanent design and carry no expiry.

### Ledger release first, ruleset edit second

The ruleset is edited by hand, with the operator's admin session, and nothing in Actions can edit it. So changes to the required set go in this order:

1. **PR:** the ledger entry (with `field-changes`), the `ci/required-checks.json` change, the regenerated blocks, and, when adding a check, the job itself reporting on both `pull_request` and `merge_group`. It merges through the queue.
2. **Ruleset edit**, after that PR is on `main`.
3. **When removing a check,** a later PR may delete the job, once the ruleset no longer requires it.

The other order leaves a window where live protection differs from declared intent with no record of why, and when adding a check it can require a context no job on `main` reports yet, which deadlocks the queue.

### The fence

The steward may change gates, never the steward or the judge. When the unattended `ci-improve-tick` exists (phase 3), the coverage step fails a `ci-improve/*` PR that touches any path in `ci/steward-owned-paths.json`: `packages/ci-steward/**`, `ci/slos.yaml`, `ci/metrics.yaml`, `ci/ratchets.yaml`, `ci/required-checks.json`, `ci/steward-owned-paths.json`, `ci/config.yaml`, `.claude/rules/ci-pipeline.md`, this guide, `claude-code-review.yml`, `REVIEW.md`, `scripts/should-arm-automerge.sh` and `merge-tail.yml`. `typecheck.yml` and `lefthook.yml` are fenced by content instead (the census steps and the time-wrap must stay present), checked by a different runner, because the census cannot guard its own removal.

### What exists now

| Piece                                                                                            | Phase | Status      |
| ------------------------------------------------------------------------------------------------ | ----- | ----------- |
| `ci/` hand files, `census`, `ledger-check`, `ledger-new`, typecheck steps                        | 0     | this change |
| Merge guard, de-staled `creating-pull-requests` skill and watcher                                | 0     | this change |
| `MERGE_TAIL_TOKEN` replaced by the `dorkos-merge-tail` app                                       | 0     | this change |
| Daily collector, data branch, verdicts, weekly report, `/ci:status`, `/ci:pulse`, `/ci:record`   | 1     | not built   |
| Incident mode: sentinel, freeze, quarantine, `/ci:incident`, `/ci:break-glass`, `ci-steward arm` | 1b    | not built   |
| Ratchet assertions, the blocking `review-gate`                                                   | 2     | not built   |
| `/ci:improve`, `ci-improve-tick`, fence enforcement                                              | 3     | not built   |

Never document a later-phase command as if it works; name its phase.

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
- ❌ Pushing, rerunning or re-arming on the first failed-checks ejection. ✅ Wait for the re-queue.

## Troubleshooting

### A required check sits "Expected: waiting for status to be reported"

**Cause:** the workflow did not run for this event: a `paths:` filter, a missing `merge_group:` trigger, or a conflicting PR (GitHub runs no workflows when it cannot build the test-merge commit). **Fix:** rebase if conflicting; otherwise the workflow is wrong, and the census should have caught it. Fix the workflow with a ledger entry.

### "CI Steward census" is red in `typecheck`

**Cause:** YAML and the `ci/` hand files disagree (a new job with no `ci/gates.yaml` entry, a missing `timeout-minutes`, a generated block out of date, a required check that can deadlock). **Fix:** read the step log, which names the gate. `node packages/ci-steward/src/cli.ts census --fix` regenerates the blocks; gates and timeouts are hand edits.

### "CI Steward ledger coverage" is red

**Cause:** the PR touches a pipeline path and adds no `ci/ledger/` entry. **Fix:** `node packages/ci-steward/src/cli.ts ledger-new --slug <what-changed>`, fill in the hypothesis, amend it into the commit.

### `fragment-present` red on a `skip-changelog` PR

**Cause:** the label raced the `opened` event, whose payload is what the step reads. A re-run replays the same payload and fails again. **Fix:** reword a genuinely non-user-facing commit to `chore(`/`ci(` and force-push, or drop the label and add a fragment. See the `creating-pull-requests` skill.

### The queue holds many PRs and nothing merges

**Cause:** usually a flaky required job ejecting groups, runner starvation, or a GitHub Actions outage (githubstatus.com; one on 2026-08-26 held the queue for about 4 hours). **Fix:** do not push, rerun or re-arm. Name the failing job and the evidence where the operator will see it. Automated freeze and recovery are phase 1b.
