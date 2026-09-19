---
title: 'CI, review and merge pipeline: deep review (what we do, how long it takes, how we improve it)'
date: 2026-09-19
type: internal-audit
status: active
tags: [ci, merge-queue, code-review, dora, flaky-tests, devex, theory-of-constraints, pdca, slo]
related:
  - research/20260919_ci-pipeline-01-inventory.md
  - research/20260919_ci-pipeline-02-timings.md
  - research/20260919_ci-pipeline-03-benchmarks-and-methods.md
  - research/20260919_ci-pipeline-04-change-tracking.md
  - research/20260919_ci-pipeline-supporting/
---

# CI, review and merge pipeline: deep review

**Date:** 2026-09-19. **Repo:** `dork-labs/dorkos` at `main` = `9688d2db0`.
**Scope:** every step between an agent editing a file and a change reaching users: Claude Code hooks, lefthook, `pnpm verify`, pre-PR agent review, 24 GitHub Actions workflows, the Claude PR review, merge-tail, the merge queue, post-merge workflows and the release.

This file is the synthesis. It answers the six questions the operator asked. The evidence sits in four detailed reports beside it:

| Report                                              | What it holds                                                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260919_ci-pipeline-01-inventory.md`              | Stage-by-stage map from edit to release, every check and where it runs, file:line citations                                                         |
| `20260919_ci-pipeline-02-timings.md`                | Measured durations: 779 merged PRs, 33,290 Actions runs, 1,872 runs' job timings, 3,643 local `git commit`/`git push` calls from agent transcripts  |
| `20260919_ci-pipeline-03-benchmarks-and-methods.md` | Industry benchmarks (DORA, CircleCI, LinearB, Google, Meta) and named improvement methods, with sources and a verified/recalled tag on every number |
| `20260919_ci-pipeline-04-change-tracking.md`        | Every pipeline change since June (about 94 PRs), whether it stated a hypothesis, whether its result was measured                                    |
| `20260919_ci-pipeline-supporting/`                  | Per-layer notes and the scripts that produced every number (raw JSON pulls were not committed; the scripts re-fetch them)                           |

**How the work was done.** Four independent agents ran in parallel (inventory, timings, external research, change history). The orchestrator then re-checked the load-bearing claims against live GitHub (org plan, ruleset, Homebrew runs, review triggers, cache usage, which queue check finishes last since 09-16) before writing this. All GitHub access was read-only.

---

## TL;DR

1. **It is not slow by team standards. It is slow by machine standards, and it is flaky.** Median PR open-to-merge is 58 minutes and first-commit-to-merge is 1.8 hours. Industry "elite" is under 25 hours. But those benchmarks are mostly human review wait, and we have no human in the loop. Measured against the right yardstick (the 10-minute build), our machine time is 3 to 5 times too long, local hooks are 5 to 10 times too long, and the merge queue fails far more often than it should.
2. **The bottleneck is the merge queue, and inside it, flaky browser tests.** A clean queue pass takes about 30 minutes. 22% of PRs get kicked out at least once, and 77 to 85% of those kicks re-pass with no code change. A kicked PR takes 2.1 hours instead of 26 minutes. Over 30 days that was about 818 extra queue-hours.
3. **The wait you probably feel most is not CI at all.** It is (a) agents stuck on `git push`: 13 to 18% of pushes hit the 10-minute tool ceiling, and (b) the release train: a merged change waits a median of 37 hours to reach users.
4. **We track changes well and results not at all.** About 94 pipeline changes in 14 weeks, 13 a week lately. Each is well documented. Zero had a planned "did it help?" check that was actually done. Three results found by accident contradicted the change.
5. **Named methods exist, and we half-use one.** Our incident habit is the "Do" half of PDCA (Plan, Do, Check, Act). We skip "Check". Adopting Theory of Constraints plus a PDCA ledger plus three or four CI SLOs would cover it. We don't need team surveys (SPACE, DX Core 4); there is one human.
6. **Things that are simply broken today:** Homebrew publish has failed 25 of 25 times; a push erases a red Claude review; Dependabot PRs always get a red review; no job timeout on several workflows; the Actions cache is full (10.3 of 10 GB) and thrashing; there is no remote build cache; six CI-required checks can't be run locally.

---

## Q1. What do we currently do?

Full map with citations: `01-inventory.md` §1. The short version, in order:

```
EDIT       Claude hooks: 3 guards on every Bash call; typecheck + eslint + any-ban on every edit
TURN END   prettier --write on changed files; checkpoint (worktree); flow-loop x3
COMMIT     lefthook pre-commit: drizzle generate, dir-size, prettier, turbo lint --affected,
           turbo typecheck --affected (sequential). post-commit seeds a changelog fragment.
REVIEW     before a PR exists: self-trace, gate, fresh adversarial Opus reviewer against
           REVIEW.md, fix, re-review until clean (no round cap). /flow adds per-task
           two-stage review. Typical /flow change: 10-18 reviewer runs.
PUSH       lefthook pre-push: prettier check on changed files, then turbo test --affected
           (concurrency 1, retry 2, watchdog 300s stall / 2h cap)
PR         ~16-23 jobs. Required: typecheck (FULL), lint (FULL), test (affected, 4 shards +
           Postgres/Playwright leg), browser-test (instant pass-through on PRs),
           credential-free-build (serial), db-check, 3 fragment/version checks.
           Advisory: Claude review (once, not on push), site-build, openapi, Windows, etc.
ARM        merge-tail cron every 10 min arms auto-merge (13 skip rules). In practice agents
           arm at PR creation (median 0 min).
QUEUE      merge_group: 11 workflows, ~19 jobs, up to 5 PRs per batch, ALLGREEN.
           Full typecheck, full lint, full test (4 shards), full Playwright (3 shards),
           credential-free-build (cold), site-build, openapi, Windows harness...
MAIN       squash. push:main re-runs db-check, CLI smoke (5 jobs), scripts-test, desktop smoke.
           Vercel deploys the site.
RELEASE    manual /system:release: version bump PR through the queue, tag, npm publish,
           desktop build, Docker, Homebrew (always fails).
```

Facts that matter most:

- **9 checks are required** (8 in the ruleset plus `db-check` via the old classic branch protection, still active). No human approval is required. Conversation resolution is not required. So **any green PR lands with no human looking at it**; the "human gate" in `/flow` is a convention only.
- **The same work runs many times.** Typecheck runs up to 7 times per change (edit hook, `/git:commit` full, pre-commit, `/git:push` full, `verify`, PR full, PR credential-free, queue full, queue credential-free). Prettier 5 layers. Unit tests 5 to 6 times; in the queue the same suites run twice in parallel (sharded `test` and serial `credential-free-build`). About 11 cold builds of `@dorkos/shared` per queue entry, 14 separate `pnpm install`s.
- **There is no turbo remote cache**, and the GitHub Actions cache is at its 10 GB cap, so entries live about 11 hours. Windows pnpm (735 MB) and Playwright (268 MB) caches are saved on PR and queue refs that nothing else can read, so they evict useful entries for nothing.
- **Six CI-required gates can't run locally** (`format:check` in full, banned-words, vocab-gate, boundary, NUL bytes, dead doc paths). A green `pnpm verify` does not predict a green `typecheck`/`lint` check.
- **Docs drift:** AGENTS.md's CI section, the `creating-pull-requests` skill, ADR 260728-112203 (says batch size 1; live is 5), `browser-test.yml`'s header (cites a Free-plan 20-job cap; the org is on Team, verified), and `.claude/README.md`. There is no CI guide in `contributing/`.
- **The installed `/flow` plugin has autonomy on** (installed v0.5.0, `autonomy.default: "auto"`), while the ADRs and `contributing/flow-engine.md` assume off.

## Q2. How long do the steps take, and how does that compare?

Full numbers: `02-timings.md`. Benchmarks and sources: `03-benchmarks-and-methods.md`. Windows: 30 days from 08-20, 7 days from 09-12.

### Our numbers (7-day medians unless noted)

| Stage                                           | Median                           | p90       | Notes                                                                                                              |
| ----------------------------------------------- | -------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| Local `git commit` (pre-commit hook)            | 50 s                             | 3.5 min   | from 2,457 agent calls                                                                                             |
| Local `git push` (pre-push hook)                | 59 s (30d: 120 s)                | 10 min    | **13-18% hit the agent's 10-min tool ceiling**                                                                     |
| Branch work before PR (first commit to PR open) | ~50-60 min                       |           | includes the pre-PR review loop                                                                                    |
| PR open to Claude review posted                 | 4 min                            | 7 min     | not required, off the critical path                                                                                |
| PR open to all required checks green            | 14.3 min                         | 38.6 min  | `test` shards finish last                                                                                          |
| Queue build, never-ejected PR                   | 30 min                           | 44 min    | since 09-16: p90 55 min; `browser-test` and `credential-free-build` now tie for last (15 vs 13 of 28 green builds) |
| Queue, PR ejected at least once (22% of PRs)    | 2.1 h                            | 19.7 h    | 77-85% of failed-check ejections re-pass unchanged                                                                 |
| **PR open to merged**                           | **58 min**                       | **3.0 h** |                                                                                                                    |
| First commit to merged                          | 1.8 h                            | 8.2 h     |                                                                                                                    |
| Merged to released                              | 36.9 h (30d)                     | 5.2 d     | 62 PRs merged since v0.75.1 (09-14) not shipped                                                                    |
| Queue builds that had any failing check         | 25% (30d: 40%, since 09-16: 18%) |           | improving fast                                                                                                     |
| Restore a red `main` (push-only checks)         | ~1.5 h                           |           |                                                                                                                    |

Volume: 779 PRs merged in 30 days (25.7/day), median PR 720 lines, 41% over 1,000 lines. One queue build costs about 150 runner job-minutes; the two queue suites use 56% of all runner time.

### Against the industry

| What                                    | Us                                                             | Benchmark                                                                                                  | Read                            |
| --------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------- |
| First commit to merge                   | 1.8 h median                                                   | LinearB 2026 elite: under 25 h (P75)                                                                       | **far faster than elite**       |
| Time to first review                    | 4 min                                                          | Google 2018: under 1 h for small changes, under 4 h overall. LinearB elite pickup under 7 h                | **far faster**                  |
| Machine time per PR (PR checks + queue) | ~45 min median                                                 | XP / Fowler / Humble & Farley "10-minute build"; current shift-left guidance: commit feedback under 10 min | **3-5x too long**               |
| Pre-commit hook                         | 50 s                                                           | practitioner consensus 5-10 s                                                                              | **5-10x too long**              |
| Pipeline success rate                   | queue green 75% (7d), 60% (30d)                                | CircleCI 2026: industry main-branch 70.8%, target 90%                                                      | now about average, below target |
| Flakiness                               | ~80% of queue failures re-pass unchanged                       | Google: ~1.5% of test runs flaky                                                                           | **an order of magnitude worse** |
| Release lead time                       | 37 h merge to release, release every ~3 days                   | DORA elite: lead time under 1 day, on-demand deploys                                                       | "high", not elite               |
| Change failure proxy                    | 0 reverts; 3.1% of merges fix a regression from the prior week | DORA elite: 0-15%                                                                                          | good (weak proxy)               |
| Time to restore                         | ~1.5 h                                                         | CircleCI median 72 min, target 60 min                                                                      | about average                   |
| PR size                                 | 720 lines median                                               | LinearB elite ~100-200 lines; AI-assisted PRs P75 408                                                      | 3-5x larger than elite          |

### Why it feels long even though the headline is "elite"

The team benchmarks are dominated by humans waiting for humans. Remove the human and what is left is machine time, and machine time should be minutes, not the better part of an hour. Four things make it feel slow:

1. **The tail, not the median.** One PR in five gets ejected and takes 2 hours to 20 hours. The worst five PRs in 30 days took 20 hours to 5 days, each with 14 to 21 queue entries. People remember the tail.
2. **Agents block on local gates.** A push that takes 10 minutes and times out makes the agent guess whether it went through. That's 1 push in 6.
3. **The pre-PR review loop.** 10 to 18 reviewer runs per `/flow` change is thorough, and it is where much of the hour before the PR opens goes. It is not measured anywhere (see Q5).
4. **Users see nothing for 1.5 days.** Merge is not "done" for anyone outside the repo.

## Q3. Do we track pipeline changes and their results? Should we?

Full analysis: `04-change-tracking.md`.

**Changes: yes, in unusual depth, but scattered.** Every change has a detailed PR body, a dated workflow header comment (63% of workflow lines are comments), and usually a Linear ticket. But it is spread over six places, the changelog excludes CI work by design, and there is exactly one real CI ADR (merge queue, 260728-112203). The largest change of the period, the 08-24 move of the heavy suites into the queue (#1246), has no ADR.

**Results: no.**

- About 75% of pipeline changes were reactions to an incident.
- 6 stated a numeric prediction. About 35 proved the fix before merge.
- **0** had a planned post-rollout check that was done. At least 5 promised one in writing and dropped it (#1523's two-week flake revisit, #1538's unchecked box, the `browser-test.yml` "~16 min, not yet measured" comment, DOR-1818's 7-day evidence window, #1467's `^lint` follow-up).
- Results that surfaced did so by accident, and three contradicted the change: #1246 (saturation relief, then a 56% queue failure rate two weeks later, designed around a Free-plan cap that no longer applied), #39 (retry budget inert in 19 of 21 projects for 11 weeks), #1521 (drift gate missed 4 of 4 breaks).
- The one real retrospective (DOR-1818) was closed "Done" at ideation; its recommendations never shipped and its evidence expired.

**Consequences visible in the data:** high churn (reviewer changed in 10 PRs in 10 weeks; `test.yml` topology 6 times in 6 weeks; lockfile formatting reversed in 13 days), and the same incident classes recur 3 to 15 times (timeouts killing green runs 5 times, pre-push under load about 15 tickets, flaky-test tickets rising 12 then 27 then 19-and-counting per month).

**Should we? Yes, and cheaply.** The data already exists in the GitHub API; the 04 report showed five minutes of queries reveal a big improvement from W36 to W38 that nobody recorded or can attribute. The minimum loop is: a weekly job that saves a few numbers, and a one-line hypothesis on every `ci(` PR with a date to check it. Details in Q6.

## Q4. Are there standard methods? Which should we use?

Yes. Full descriptions and sources in `03-benchmarks-and-methods.md` Part 2.

| Method                                                                                     | What it is                                                                                                                                             | Using it?                                         | Should we?                                                                                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **DORA metrics / Four Keys**                                                               | 5 delivery metrics: deploy frequency, lead time, change failure rate, recovery time, rework rate. Four Keys is Google's open-source dashboard for them | No                                                | **Yes, lightly.** Compute them weekly from GitHub; skip the dashboard product                                  |
| **Theory of Constraints** (Goldratt)                                                       | Find the one bottleneck, fix it, then find the next. Optimizing anything else does nothing                                                             | Not by name                                       | **Yes, as the prioritization rule.** Today's constraint is queue flakiness                                     |
| **PDCA / Kaizen / Toyota Kata**                                                            | Plan (hypothesis), Do, Check (measure), Act (keep or revert). Small repeated experiments                                                               | Half: strong Do, strong pre-merge proof, no Check | **Yes. This is the missing piece.**                                                                            |
| **Blameless postmortems**                                                                  | For each failure: what conditions allowed it, what safeguard was missing, action items with owners and due dates, tracked closure                      | Partly (excellent root-cause PR bodies)           | Add closure tracking; the repeat incidents say actions don't stick                                             |
| **SRE SLOs + error budgets**                                                               | A numeric target (e.g. "p90 queue time under 30 min") and a budget; when the budget is spent, stability work beats feature work                        | No                                                | **Yes, 3-4 CI SLOs.** Gives agents a machine-checkable "stop and fix CI" signal                                |
| **Value Stream Mapping / Flow Framework** (Kersten)                                        | Map every stage, split work time from wait time. Typical flow efficiency is 15-25%                                                                     | No                                                | Once, as a one-off exercise; Q2's stage table is most of it                                                    |
| **DevEx framework** (Noda, Storey, Forsgren, Greiler 2023)                                 | Three dimensions: feedback loops, cognitive load, flow state                                                                                           | No                                                | Use the feedback-loop idea: keep the loop an agent waits on to about 2 minutes, push the rest behind the queue |
| **SPACE, DX Core 4**                                                                       | Multi-dimension productivity frameworks built on developer surveys                                                                                     | No                                                | **No.** Built for teams of people; n=1 human                                                                   |
| **Developer Productivity Engineering, CI observability** (OpenTelemetry CI/CD conventions) | Treat build and test speed as its own discipline with its own telemetry                                                                                | No                                                | Later. A weekly JSON series is enough now                                                                      |
| **Trunk-based development, test impact analysis**                                          | Small changes to main often; run only affected tests                                                                                                   | Yes, mostly (`--affected`, merge queue)           | Keep. Extend affected-only to PR typecheck and lint                                                            |

**Recommendation:** Theory of Constraints to choose what to fix, PDCA to run each fix as an experiment, a handful of SLOs to know when to stop and fix. That is the whole method; everything else is optional.

## Q5. What should you be asking, and the answers

**5.1 Which gates actually catch real bugs, and what does each one cost?**
Unknown, and that is the problem. We pay for about 7 typechecks, 5 formatting passes, 5-6 test runs and 10-18 review runs per change, but nobody records what each layer catches. Partial evidence: the pre-PR adversarial review has caught about 45 real defects (orchestrating-parallel-work skill); the queue exists to catch "green alone, red together" and that happened 3 times in 3 months (#488/#489, #1225/#1227, #1231/#1226). Against that, the queue ejected PRs 247 times for failed checks in 30 days, and 85% of those were not the PR's fault. **Recommendation:** tag every CI failure and every review finding by the layer that caught it, for one month. Drop or merge layers that catch nothing unique.

**5.2 Is the merge queue earning its cost?**
Probably yes as a safety net, but currently it is mostly a flake amplifier. One build is about 150 job-minutes and we run 1.46 builds per merged PR. The fix is not removing the queue; it is making its checks trustworthy (quarantine flakes, fix browser shards 1 and 2), then measuring how often it catches something real.

**5.3 Is it OK that nothing needs a human approval to merge?**
This is a governance question only the operator can answer. Today a green PR lands with zero human review, and a push quietly erases a red Claude review (the review runs once, on open, and the check belongs to the old commit). If "agents merge on their own" is the intent, write it down in an ADR and close the review-erasure hole. If it isn't, require one approval or require the review check.

**5.4 Are PRs the right size?**
Median 720 lines, 41% over 1,000. Every dataset says small PRs review and merge faster, and our own data shows XL PRs have 3x the p90 (6 h vs 1.9 h), mostly from ejections. But each PR also costs a 150 job-minute queue build. With no human reviewer the size penalty is smaller than for human teams. **Recommendation:** don't force splits; do watch XL ejection rate as one of the SLOs.

**5.5 What is the real "done"?**
For users it is the release, 37 hours after merge. Pre-launch alpha makes that fine for now. After launch, lead time to users becomes the DORA metric that matters. Worth deciding before launch whether releases stay manual.

**5.6 What does the pipeline cost in agent tokens and operator attention?**
Actions minutes are free (public repo). The expensive parts are Opus review loops and agents idling on watchers and pushes. `scripts/measure-agent-hours.ts` measures token cost per agent hour but not per pipeline stage. Not measured today. **Recommendation:** add "tokens spent in review" and "agent minutes blocked on push/CI" to the weekly numbers once the basics exist.

**5.7 Is the pipeline itself too complex to reason about?**
24 workflows, about 7,650 lines of workflow YAML, about 13 changes a week, docs drifting behind it. Each change is careful, but the whole is hard to hold in one head, which is how a Free-plan assumption survived two weeks past its expiry. **Recommendation:** a single `contributing/ci.md` that states the current design, and a rule that a pipeline PR updates it.

**5.8 Does local match CI?**
No. Six required checks are CI-only, `/git:commit` and `/git:push` run full checks that lefthook then re-runs, and the pre-push hook claims to share a cache with CI that doesn't exist. Every mismatch is a queue red waiting to happen.

**5.9 What happens when the operator is away?**
The installed `/flow` plugin has autonomy on while every doc says off, and merges need no human. So the answer today is "agents keep merging". That may be exactly what's wanted, but it should be a decision, not drift.

## Q6. What are we not doing that we should be?

Ordered by Theory of Constraints: fix the constraint first. Each item is written as a PDCA experiment: the metric to watch and a target.

### Tier 1: the constraint (queue flakiness)

1. **Flake quarantine for the browser suite.** Auto-detect tests that fail then pass unchanged (the data is already in the flake reporter and queue ejection events), move them to a non-blocking quarantine lane, and file one ticket each. Fix browser shards 1 and 2 first; they cause most ejections. _Metric:_ failed-check ejections re-passing unchanged. _Target:_ under 20% of ejections, queue green rate over 90%.
2. **Retry once at the test level before ejecting.** The unit `test` queue leg already has `--retry=1`; confirm Playwright's retry is set and reported for the browser shards, so one flaky test doesn't eject a whole batch of up to 5 PRs.
3. **Split or slim `credential-free-build`.** It became required on 09-15, runs 26 min median and 55 min p90 in the queue, and repeats the unit tests the `test` shards already run. Either shard it (its header already sketches how) or drop its duplicate test step. _Target:_ no longer the last check to finish.

### Tier 2: speed (machine time and local gates)

4. **Turn on a turbo remote cache.** About 11 cold builds per queue entry and no cache sharing between PR, queue and local. Vercel's hosted turbo remote cache is the obvious candidate since the site already deploys there (check the current plan terms before enabling). _Metric:_ queue build p50. _Target:_ under 20 min.
5. **Stop the duplicate runs.** Make PR `typecheck` and `lint` affected-only like PR `test`; run `prettier --check` once, not in both `lint` and `typecheck`; drop the full lint/typecheck/build from `/git:commit` and `/git:push` since lefthook re-runs them.
6. **Fix the push that times out.** 1 push in 6 hits the agent's 10-minute ceiling. Options: cap pre-push at a few minutes and leave the rest to CI, or finish DOR-2022 (load-aware gate, machine-wide lock). _Target:_ p90 push under 3 min, 0% at the ceiling.
7. **Fix cache thrash.** Stop saving Windows pnpm and Playwright caches on PR and queue refs, or seed them from a scheduled run on `main` so they are readable everywhere.
8. **Close local/CI parity.** Add the six CI-only checks to `pnpm verify`.

### Tier 3: close the learning loop (the method)

9. **A weekly CI metrics job.** A scheduled workflow that writes a small JSON series (committed or as a long-retention artifact): PR open-to-merge p50/p90, queue build p50/p90, queue green rate, ejections per merged PR, share re-passing unchanged, per-check duration vs its `timeout-minutes`, push p90 from agent transcripts if feasible, merged-to-released lead time. The scripts in `20260919_ci-pipeline-supporting/` are a working first draft.
10. **CI SLOs with a budget.** Start with four: PR checks p90 under 20 min; queue build p90 under 30 min; queue green rate over 90%; no job's p95 above 70% of its timeout. When a week breaks the budget, the next pipeline work goes to that, not to new gates.
11. **A pipeline change ledger with PDCA fields.** Every `ci(` PR states: the metric, the current value, the predicted value, and a check date. The Linear ticket stays open until the check is posted. Keep it in one file (for example `contributing/ci-changelog.md`) so "what changed in the pipeline this month" has one answer.
12. **Record the missing decisions.** An ADR for the 08-24 queue restructure (#1246); amend ADR 260728-112203 with real queue numbers and batch size 5; decide DOR-1818's parked R1/R2.

### Tier 4: broken or risky today (small, do anytime)

13. Set `HOMEBREW_TAP_TOKEN`, and publish the release with a token that can trigger the cask workflow (Homebrew has failed 25 of 25 runs).
14. Re-run the Claude review on push (or make a missing review block arming), so a push can't erase a red review. Give Dependabot PRs `skip-review` so they stop getting a guaranteed red.
15. Pin the Claude review model; add `timeout-minutes` to every job that lacks one (merge-tail, `claude`, desktop-release, update-homebrew, the fragment and version checks).
16. Remove the leftover classic branch protection (or document why `db-check` lives only there), so there is one source of truth for required checks.
17. Fix the stale docs: AGENTS.md CI section, `creating-pull-requests` skill, `browser-test.yml` header (Free-plan cap, "~16 min not yet measured"), `.claude/README.md`, and add `contributing/ci.md`.
18. Reconcile the installed `/flow` config (autonomy on) with the docs (autonomy off), whichever is intended.

---

## Decisions for the operator

Two choices only a human should make. Everything else above is reversible engineering work.

1. **Human approval before merge.** (a) Keep fully autonomous merges and write it down, closing the review-erasure hole. (b) Require one human approval. Recommendation: (a) during pre-launch alpha, revisit at launch.
2. **Where to spend the next pipeline week.** (a) Tier 1 (flakes and credential-free-build), the measured constraint. (b) Tier 3 (metrics and SLOs) first, so Tier 1's effect can be proven. Recommendation: do the weekly metrics job first (half a day, and it makes everything after it measurable), then Tier 1.

## Method notes and caveats

- Authorship can't separate agent work from human work: every PR is authored as the operator's account.
- "Re-queued unchanged, then merged" can't tell a flaky test from a failure caused by another PR in the same batch. Both are failures unrelated to the PR's own code.
- Local timings come from agent session transcripts only; a push that hit the ceiling means "at least 10 minutes".
- The 30-day window includes the 08-20 to 08-24 runner saturation and the pre-shard `test` job; the 7-day columns reflect the current pipeline.
- Industry numbers marked [R] in the 03 report were recalled rather than fetched and should be re-checked before quoting externally.
- The memory note that the org is capped at 20 concurrent jobs is out of date: the org plan is `team` (verified 2026-09-19) and 52 concurrent jobs were measured on 09-15 with no job waiting over 1.3 minutes.
