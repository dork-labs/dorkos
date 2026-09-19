# 02: How long the pipeline takes (dork-labs/dorkos)

Measured 2026-09-19. Two windows: **30 days** (from 2026-08-20 00:00Z) and **7 days** (from 2026-09-12 00:00Z). Everything here was read-only. Nothing was re-run, cancelled, labelled, commented on or merged.

The raw pulls and every script are in `ci-review/data/`. Each section names the script that produced it. The script outputs sit beside them (`pr_analysis.md`, `runs_analysis.md`, `jobs_analysis.md`, `flaky_dora.md`, `concurrency_and_wait.md`, `pr_checks_wall.md`, `local_gate_timings.md`), so every number can be traced back to its source.

---

## TL;DR

| Metric                                                                    | 30d                                            | 7d                                                 |
| ------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| PRs merged                                                                | **779** (25.7/day)                             | **116** (15.8/day; only 2-5/day on 09-17 to 09-19) |
| PRs opened (merged / closed-unmerged / open)                              | 783 (774 / 8 / 1)                              | 116 (113 / 2 / 1)                                  |
| Open to merged, median / p90                                              | **60m / 4.7h**                                 | **58m / 3.0h**                                     |
| First commit to merged, median / p90                                      | 2.0h / 8.4h                                    | 1.8h / 8.2h                                        |
| PR required checks to all green, median / p90                             | 16.6m / 37.9m                                  | 14.3m / 38.6m                                      |
| Merge-queue build (last entry to merged), median / p90                    | 26m / 56m                                      | 30m / 48m                                          |
| PRs ejected from the queue at least once                                  | 17% (13% for failed checks)                    | 22% (17% failed checks)                            |
| Failed-check ejections re-queued with **no code change** that then merged | **85%** (209/247)                              | 77% (27/35)                                        |
| Merge-group builds per merged PR                                          | 1.88 (1,465 builds; 40% had a failing check)   | 1.46 (169 builds)                                  |
| browser-test merge_group failure rate                                     | **25%**                                        | **17%**                                            |
| test merge_group failure rate                                             | 15%                                            | 2%                                                 |
| Job queue wait (runner starvation)                                        | none since 08-24; p90 26m in the week of 08-20 | median 2s, max 1.3m                                |
| Releases                                                                  | 8 (about every 3.1 days)                       | 2 (last: v0.75.1 on 09-14)                         |
| Merged to shipped in a release, median / p90                              | **36.9h / 5.2d**                               | n/a (62 PRs merged since v0.75.1 have not shipped) |
| Local `git push` (pre-push gate) in agent sessions, median / p90          | 120s / 600s (13% hit the 10-min tool ceiling)  | 59s / 601s (18% hit it)                            |

**The single biggest wait inside the pipeline is the merge queue.** A clean queue build takes about 30 minutes, and `browser-test` finishes last in 112 of 125 all-green builds in the last 7 days. That is about half of the median PR's 58 minutes from open to merge. The tail comes from queue ejections, most of which look flaky: an ejected PR spends a median of **2.1h** in the queue against **26m** for one that never gets ejected. Over 30 days that added about **818 queue-hours**.

**Outside the pipeline, the biggest wait is the release train.** A merged change waits a median of 37 hours before it ships.

---

## A. PR lifecycle

Scripts: `fetch_timelines.py` (GraphQL, 15 PRs per query, timeline item types listed below) and `analyze_prs.py`. Raw data: `prs_merged.json`, `prs_created.json`, `pr_timelines.json`, `pr_derived.json`.

```bash
gh pr list -R dork-labs/dorkos --state merged --search "merged:>=2026-08-20" --limit 1000 \
  --json number,title,createdAt,mergedAt,closedAt,additions,deletions,changedFiles,labels,author,isDraft,headRefName > prs_merged.json
gh pr list -R dork-labs/dorkos --state all --search "created:>=2026-08-20" --limit 1000 \
  --json number,title,state,createdAt,mergedAt,closedAt,author,labels > prs_created.json
python3 fetch_timelines.py   # gh api graphql; timelineItems(first:100, itemTypes:[READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT,
                             #   ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT, AUTO_MERGE_ENABLED_EVENT,
                             #   AUTO_MERGE_DISABLED_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT,
                             #   HEAD_REF_FORCE_PUSHED_EVENT, LABELED_EVENT, UNLABELED_EVENT]) + commits, reviews, comments
python3 analyze_prs.py > pr_analysis.md
```

Every PR is authored as `doriancollier` (782) or `dependabot` (6). Agents work through the operator's account, so authorship cannot separate human work from agent work. None of the 788 timelines ran past 100 items, so no pagination was needed.

### A1. Open to merged

| Segment (30d)                   | n   | median | p75  | p90  | mean |
| ------------------------------- | --- | ------ | ---- | ---- | ---- |
| all                             | 779 | 60m    | 2.0h | 4.7h | 2.8h |
| size XS (<10 lines)             | 10  | 50m    | 87m  | 2.7h | 83m  |
| size S (10-49)                  | 34  | 39m    | 57m  | 1.9h | 57m  |
| size M (50-249)                 | 135 | 50m    | 1.6h | 3.4h | 1.9h |
| size L (250-999)                | 283 | 58m    | 1.8h | 3.9h | 2.5h |
| size XL (1000+)                 | 317 | 71m    | 2.5h | 6.0h | 3.7h |
| label `skip-changelog`          | 238 | 43m    | 84m  | 3.0h | 1.7h |
| label `review:light`            | 235 | 52m    | 1.6h | 3.2h | 2.1h |
| label `skip-review`             | 32  | 74m    | 2.9h | 7.9h | 6.5h |
| label `review:deep`             | 26  | 1.8h   | 2.5h | 4.8h | 2.7h |
| no review:* / skip-review label | 486 | 61m    | 2.1h | 4.9h | 2.9h |
| ever a draft                    | 5   | 4.6h   | 6.9h | 7.2h | 5.1h |

| Segment (7d)     | n   | median | p75  | p90  | mean |
| ---------------- | --- | ------ | ---- | ---- | ---- |
| all              | 116 | 58m    | 1.6h | 3.0h | 1.9h |
| size M           | 19  | 55m    | 1.8h | 3.5h | 2.6h |
| size L           | 35  | 46m    | 72m  | 84m  | 58m  |
| size XL          | 54  | 69m    | 2.2h | 4.9h | 2.4h |
| `skip-changelog` | 46  | 41m    | 75m  | 1.9h | 69m  |
| `review:light`   | 34  | 46m    | 82m  | 2.4h | 76m  |
| `review:deep`    | 7   | 1.8h   | 2.2h | 3.4h | 2.1h |

What stands out:

- PRs are large. The median change is 720 lines (841 in the last 7d), and 41% are XL (1,000+ lines). Size matters less than you might expect: an XL PR's median is only about 20 minutes slower than an S PR's. The difference shows up in the tail (p90 of 6.0h against 1.9h), because big PRs get ejected from the queue more often.
- The `review:*` labels barely move the median. `review:deep` adds about an hour, because a deep review is more likely to lead to a round of fixes. `skip-review` PRs are _slower_ (mean 6.5h). They are probably infra or CI PRs that tend to hit queue trouble. This is correlation, not cause.
- Drafts are almost never used (5 of 779), so "ready for review" and "created" are effectively the same moment.

### A2. Stage intervals (merged PRs)

| Stage                                                                   | 30d n | 30d median | p75  | p90  | mean | 7d median | 7d p90 |
| ----------------------------------------------------------------------- | ----- | ---------- | ---- | ---- | ---- | --------- | ------ |
| ready to first Claude review comment                                    | 691   | **4m**     | 5m   | 7m   | 6m   | 4m        | 7m     |
| created to auto-merge armed (first)                                     | 647   | **0m**     | 0m   | 12m  | 16m  | 0m        | 39m    |
| first Claude review to armed (only the 88 PRs armed after their review) | 88    | 19m        | 62m  | 3.3h | 67m  | 15m       | 2.4h   |
| armed to first queue entry (= waiting for PR checks)                    | 647   | 17m        | 35m  | 80m  | 57m  | 10m       | 36m    |
| created to first queue entry                                            | 779   | 23m        | 55m  | 2.0h | 73m  | 16m       | 75m    |
| first queue entry to merged                                             | 779   | 28m        | 48m  | 2.0h | 1.6h | 30m       | 1.8h   |
| last queue entry to merged                                              | 779   | 26m        | 35m  | 56m  | 34m  | 30m       | 48m    |
| time resident in queue (sum of stints)                                  | 779   | 28m        | 44m  | 83m  | 50m  | 30m       | 71m    |
| last queue entry to merged, never-ejected PRs                           | 646   | 26m        | 34m  | 52m  | 33m  | 30m       | 44m    |
| first commit (authored) to merged                                       | 779   | 2.0h       | 3.8h | 8.4h | 4.7h | 1.8h      | 8.2h   |
| last commit to merged                                                   | 779   | 58m        | 83m  | 2.4h | 87m  | 55m       | 1.7h   |

- **Auto-merge is armed the moment the PR opens.** That holds for 647 of 779 PRs, via `gh pr merge --auto`. The other 132 went straight into the queue because their checks were already green when someone merged them. Every enqueue event has `doriancollier` as the actor, and so does every auto-merge event. `merge-tail.yml` uses that same token, so its arming cannot be told apart from an agent's.
- **The Claude review is fast (4m) and is not a required check**, so it is off the critical path. It posted on 691 of 779 merged PRs. The `re-review` label was applied on 58 PRs (75 re-reviews in total).

### A3. The merge queue

Queue settings (`gh api repos/dork-labs/dorkos/rules/branches/main`): SQUASH, grouping `ALLGREEN`, `max_entries_to_build: 5`, `max_entries_to_merge: 5`, `check_response_timeout_minutes: 120`. The required contexts are `typecheck`, `fragment-present`, `no-fragment-under-skip-label`, `version-outranks-base`, `test`, `browser-test`, `lint` and `credential-free-build`. `credential-free-build` was new as of 2026-09-15.

| Queue metric                                                                       | 30d                                                                                                                               | 7d                                            |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Queue entries total (per PR)                                                       | 1,116 (1.43)                                                                                                                      | 164 (1.41)                                    |
| Entries per PR                                                                     | 1x=646, 2x=82, 3x=23, 4x=9, 5+x=19                                                                                                | 1x=90, 2x=16, 3x=5, 4x=3, 5+x=2               |
| PRs ejected at least once                                                          | 134 (17%)                                                                                                                         | 26 (22%)                                      |
| Ejected for failed checks at least once                                            | 99 (13%)                                                                                                                          | 20 (17%)                                      |
| Ejection events by reason                                                          | failed_checks 247, merge_conflict 45, manual 42 (+2 by the queue), invalid_merge_commit 2, git_tree_invalid 1, checks_timed_out 1 | failed_checks 35, manual 10, merge_conflict 3 |
| Failed-check ejections re-queued **with no new commit or force-push**, then merged | **209 / 247 (85%)**                                                                                                               | 27 / 35 (77%)                                 |
| Ejection to re-entry when unchanged                                                | median 23m, p90 2.1h                                                                                                              | median 17m, p90 1.7h                          |
| First entry to merged: never ejected vs ejected                                    | 26m (p90 52m) vs **2.1h (p90 19.7h)**                                                                                             |                                               |
| Extra queue-hours caused by ejections                                              | **about 818h**                                                                                                                    |                                               |

The removal event's reason field is filled in, so ejections can be classified by cause. The "re-queued with no change, then merged" test comes from `analyze_flaky_dora.py`. For each `failed_checks` removal, it asks whether there was a force-push, or a commit dated after the removal, before the next `AddedToMergeQueueEvent`. In 85% of cases there was neither. Either the failure was flaky, or it came from an interaction with a PR ahead in the queue that later went away. Either way, re-queuing the same code later passed.

The worst cases in the 30d window:

| PR    | queue entries | ejections                                    | first entry to merged |
| ----- | ------------- | -------------------------------------------- | --------------------- |
| #1284 | 21            | failed_checks 17, merge_conflict 1, manual 2 | 24.0h                 |
| #1520 | 19            | failed_checks 14, merge_conflict 4           | 2.7d                  |
| #1231 | 15            | failed_checks 13, manual 1                   | 5.0d                  |
| #1598 | 15            | failed_checks 13, manual 1                   | 20.3h                 |
| #1524 | 14            | failed_checks 12, merge_conflict 1           | 35.9h                 |

### A4. Rework proxies

|                                                | 30d                | 7d                |
| ---------------------------------------------- | ------------------ | ----------------- |
| Commits per PR, median / p90 / mean / max      | 2 / 8 / 3.8 / 44   | 2 / 13 / 5.1 / 44 |
| Force-pushes per PR, mean; PRs with at least 1 | 0.23; 110 (14%)    | 0.26; 24 (21%)    |
| PRs with a `re-review` label                   | 58 (75 re-reviews) | 13 (19)           |

The PR merge queue squashes on merge, so commits per PR reflects rework on the branch, not on `main`.

---

## B. GitHub Actions

Scripts: `fetch_runs.sh` fetches the runs endpoint one day at a time. `fetch_runs_split.sh` re-fetches, in 2-hour windows, any day that hit the endpoint's 1,000-result cap. That happened on 14 of 31 days. No 2-hour window hit the cap, and the day totals were checked against `total_count`. `analyze_runs.py` does the rest. Output: `runs_all.json` (**33,290 runs**, 4,567 of them `skipped`).

```bash
gh api --paginate "repos/dork-labs/dorkos/actions/runs?created=$DAY&per_page=100" --jq '.workflow_runs[] | {id,name,path,event,status,conclusion,created_at,run_started_at,updated_at,run_attempt,head_branch,head_sha,run_number,pull_requests:[.pull_requests[].number]}'
# capped days: created=${DAY}T00:00:00Z..${DAY}T01:59:59Z etc.
python3 analyze_runs.py > runs_analysis.md
```

Run duration is `updated_at - run_started_at`. Run queue is `run_started_at - created_at`, which is 0s for every workflow. Runner starvation shows up only at the job level (B3).

### B1. Workflows by event (30d, non-skipped runs; durations over success+failure)

| workflow                         | event                                   | runs                                 | fail %             | cancel % | dur median         | dur p90   | reruns |
| -------------------------------- | --------------------------------------- | ------------------------------------ | ------------------ | -------- | ------------------ | --------- | ------ |
| **browser-test**                 | merge_group                             | 1,465                                | **25%**            | 0%       | **22.1m**          | 28.1m     | 0      |
| **test**                         | merge_group                             | 1,465                                | **15%**            | 2%       | 15.9m              | 33.8m     | 1      |
| typecheck                        | merge_group                             | 1,464                                | 1%                 | 0%       | 5.1m               | 8.0m      | 0      |
| lint                             | merge_group                             | 900                                  | 1%                 | 0%       | 6.3m               | 7.1m      | 0      |
| site-build                       | merge_group                             | 856                                  | 0%                 | 0%       | 2.7m               | 3.3m      | 0      |
| docs-openapi-check               | merge_group                             | 356                                  | 1%                 | 0%       | 2.8m               | 3.1m      | 0      |
| harness-windows                  | merge_group                             | 318                                  | 6%                 | 0%       | 5.2m               | 6.1m      | 5      |
| credential-free-build            | merge_group                             | 41 (7d only)                         | 21%                | 5%       | **25.7m**          | **55.2m** | 0      |
| db-check / changelog / op-skills | merge_group                             | 1,464 each                           | 0%                 | 0%       | 20-47s             | ≤1.2m     | 0      |
| test                             | pull_request                            | 1,211                                | 4%                 | 10%      | 16.4m              | 36.5m     | 33     |
| browser-test                     | pull_request                            | 1,211                                | 2%                 | 2%       | 46s (pass-through) | 19.9m     | 1      |
| typecheck                        | pull_request                            | 1,212                                | 3%                 | 3%       | 5.1m               | 8.0m      | 2      |
| lint                             | pull_request                            | 732                                  | 2%                 | 5%       | 6.4m               | 7.2m      | 0      |
| claude-code-review               | pull_request                            | 1,556 (519 skipped)                  | 7%                 | **25%**  | 3.7m               | 6.8m      | 0      |
| CLI Smoke Test                   | pull_request / push                     | 938 / 717                            | 1% / 0%            | 2%       | 2.9m               | 3.7m      | 6      |
| docs-openapi-check               | pull_request                            | 846                                  | 6%                 | 1%       | 2.5m               | 3.0m      | 4      |
| changelog-fragment-check         | pull_request                            | 2,056                                | 4%                 | 0%       | 32s                | 50s       | 2      |
| Desktop Smoke                    | push / pull_request                     | 561 / 191                            | 1% / 6%            | 3% / 7%  | 7.1m / 7.3m        | 10.6m     | 0      |
| harness-windows                  | pull_request                            | 364                                  | 7%                 | 5%       | 4.9m               | 5.9m      | 5      |
| merge-tail                       | schedule                                | 414                                  | **40%** (0% in 7d) | 0%       | 20s                | 41s       | 0      |
| Evals                            | pull_request                            | 2,005 (1,783 skipped, 222 cancelled) | n/a                | 100%     | -                  | -         | 0      |
| claude                           | issue_comment / review / review_comment | 1,603 / 286 / 286                    | all skipped        |          |                    |           |        |
| test / typecheck                 | push (main)                             | 98 / 263                             | 7% / 1%            |          | 30.4m / 7.6m       |           |        |

7d changes: `test` merge_group dropped to **2% failures** with a steady **16.6m** (p90 17.6m) since the four-way shard. `browser-test` merge_group is still **17% failures**, and it is now slower: **28.2m** median. `merge-tail` failures went to 0. `test` and `typecheck` no longer run on push to `main` after 08-24 and 09-02.

**Rerun rate:** 68 of 28,723 non-skipped runs (0.24%) have `run_attempt > 1`. Almost none are in the queue, because the queue's retry is eject then re-arm, not a rerun. So the rerun rate understates flakiness. The 85% "re-queued unchanged, then merged" figure in A3 is the better flakiness signal.

**Merge-group builds:** 1,465 distinct queue SHAs in 30d. 846 were all green, **590 (40%) had at least one failing check**, and 28 were cancelled. Failures by workflow: browser-test 366, test 219, harness-windows 20, typecheck 14, lint 9, credential-free-build 8, docs-openapi-check 3.

### B2. Wall time to all-required-green (per head SHA)

Script: `pr_checks_wall.py`. For each SHA whose required runs all succeeded, it measures `max(updated_at) - min(created_at)`.

| Event        | window | SHAs | median    | p75   | p90   | last to finish                                 |
| ------------ | ------ | ---- | --------- | ----- | ----- | ---------------------------------------------- |
| pull_request | 30d    | 917  | 16.6m     | 31.2m | 37.9m | test 637, lint 119, typecheck 76               |
| pull_request | 7d     | 143  | **14.3m** | 16.9m | 38.6m | test 71, lint 41                               |
| merge_group  | 30d    | 864  | 25.4m     | 30.6m | 34.2m | browser-test 557, test 294                     |
| merge_group  | 7d     | 125  | **28.7m** | 29.6m | 37.1m | **browser-test 112**, credential-free-build 13 |

### B3. Job-level timings

Scripts: `pick_job_samples.py` (seed 42), `fetch_jobs.sh` / `fetch_one_job.sh`, `analyze_jobs.py`, `concurrency_and_wait.py`. 1,872 runs' jobs, fetched with `gh api repos/dork-labs/dorkos/actions/runs/<id>/jobs?per_page=100&filter=all`, into `jobs/<run_id>.json`. There are three sets:

- **S1**: stratified sample, 30 runs per heavy workflow and event (20 random from 30d plus 10 from 7d, success or failure). 270 runs.
- **S2**: every merge_group failure of `test` / `browser-test` in 30d. 585 runs.
- **S3**: every non-skipped run created on 2026-09-15 UTC, a busy day with 29 merges. 1,053 runs.

**Dominant jobs and steps (S1, 30d, attempt 1):**

| workflow / event           | long-pole job                 | job median                        | job p90 | dominant step (median)                                         |
| -------------------------- | ----------------------------- | --------------------------------- | ------- | -------------------------------------------------------------- |
| browser-test / merge_group | browser-shard (3/3)           | 21.9m (7d: **25.5m**)             | 28.4m   | "Run the browser suite" 18.4m; build 54s; Chromium install 27s |
| browser-test / merge_group | browser-shard (1/3), (2/3)    | 18.5m / 20.2m (7d: 21.4m / 22.4m) | 22.8m   | same                                                           |
| test / merge_group         | test-shard x4                 | 12.8m (7d: 15.1m)                 | 16.0m   | suite 11-12m per shard, balanced                               |
| test / pull_request        | test-shard x4 (affected-only) | 9.4m                              | 15.6m   | 8-11m per shard                                                |
| lint                       | lint                          | 6.3m                              | 7.1m    | **prettier --check 3.4m** + ESLint 2.2m                        |
| typecheck                  | typecheck                     | 5.2m                              | 7.6m    | tsc 3.6m + **prettier --check 3.3m**                           |
| claude-code-review         | review                        | 3.6m                              | 6.3m    | Claude Code review 3.2m                                        |

Before the shards landed, the old unsharded `test` job ran a median of about 30m. `test-shard` first appears on 2026-08-29 in merge_group, and `browser-shard` on 2026-08-22.

Two smaller findings:

- Setup overhead (checkout, node, pnpm install) is only about 30-45s per job, so it is not worth optimising.
- **The prettier check runs twice**, once in `lint` and once in `typecheck`, costing about 3.3m of runner time per run each time. It does not lengthen the wall clock, because those jobs run in parallel with the longer `browser-test` and `test`.

**Which jobs fail in the queue (S2, all 585 failed runs):**

| workflow     | failing job                            | 30d                | 7d  |
| ------------ | -------------------------------------- | ------------------ | --- |
| browser-test | browser-shard (1/3)                    | 219                | 14  |
| browser-test | browser-shard (2/3)                    | 206                | 7   |
| browser-test | browser-shard (3/3)                    | 72                 | 6   |
| test         | test (old unsharded job, before 08-29) | 136 (failing step) | 0   |
| test         | test-shard (3/4)                       | 50                 | 0   |
| test         | test-shard (4/4)                       | 17                 | 3   |
| test         | test-shard (1/4)                       | 13                 | 0   |

The failing step is almost always the suite itself ("Run the browser suite" 491, "Run every package's test suite" 136+81), not setup. **Browser shards 1 and 2 account for most of the queue ejections.**

**Runner starvation (job `started_at - created_at`):**

| ISO week             | jobs sampled | median | p90     | p99  | max     | share >2m | share >10m |
| -------------------- | ------------ | ------ | ------- | ---- | ------- | --------- | ---------- |
| W34 (08-17 to 08-23) | 82           | 3s     | **26m** | 66m  | **82m** | 33%       | 24%        |
| W35                  | 406          | 2s     | 3s      | 3.4m | 8.6m    | 1.2%      | 0%         |
| W36                  | 1,691        | 2s     | 4s      | 3.3m | 7.8m    | 1.9%      | 0%         |
| W37                  | 352          | 2s     | 3s      | 0.6m | 1.2m    | 0%        | 0%         |
| W38 (09-14 to 09-19) | 2,045        | 2s     | 3s      | 0.2m | 1.3m    | 0%        | 0%         |

Sampled long waits appear on 08-23 (24 jobs, up to 82m), 08-24 and 09-05 (up to about 8m). None have appeared since. This matches the CI-saturation fix of 08-23/24.

**Full-day census, 2026-09-15:** 1,841 executed jobs and 9,196 job-minutes (153 runner-hours). By share:

| workflow / event         | share           |
| ------------------------ | --------------- |
| browser-test merge_group | 31%             |
| test merge_group         | 25%             |
| test pull_request        | 14%             |
| everything else          | 3% or less each |

**The two merge-queue suites use 56% of all runner time.**

- **Concurrency peaked at 52 jobs running at once** (49 on Ubuntu), measured to the second, and 20 or more were running for 123 minutes of the day. Even so, no job waited more than 1.3m.
- **The 20-job cap noted in memory is not binding now.** Either the account has a higher limit than the Free plan's 20, or the cap does not apply to this public repo. Starvation is no longer a factor. Check the plan before relying on either reading.

**Estimated Actions job-minutes per ISO week.** Mean job-minutes per run for each workflow and event (from S1+S3) is multiplied by that workflow's run count. Where no sample exists, the run's wall time is used instead.

| week                      | job-minutes | runner-hours |
| ------------------------- | ----------- | ------------ |
| W34 (partial, from 08-20) | 34,193      | 570h         |
| W35                       | 63,748      | 1,062h       |
| W36                       | **106,707** | **1,778h**   |
| W37                       | 59,718      | 995h         |
| W38 (partial, to 09-19)   | 27,682      | 461h         |

Mean job-minutes per run:

| workflow / event         | job-minutes per run                 |
| ------------------------ | ----------------------------------- |
| browser-test merge_group | 67.3 (3 shards)                     |
| test merge_group         | 53.5 (4 shards plus community legs) |
| test pull_request        | 31.2                                |

**One merge-group build costs about 150 job-minutes, and the queue builds 1.88 of them per merged PR.** The repo is public, so these are not billed minutes. They cost runner capacity and wall clock.

---

## C. Critical path for a typical PR (7d medians)

| #   | Stage                                                        | Median       | p90   | Notes                                                                                                                                |
| --- | ------------------------------------------------------------ | ------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | Branch work before the PR opens (first commit to PR created) | about 50-60m |       | 1.8h first-commit-to-merge minus 58m open-to-merge. Includes local gates: commit about 50s, push about 1m (18% of pushes hit 10 min) |
| 1   | PR opened to auto-merge armed                                | 0m           | 39m   | armed at creation                                                                                                                    |
| 2   | PR opened to Claude review posted                            | 4m           | 7m    | parallel, not required, **not on the critical path**                                                                                 |
| 3   | PR required checks all green                                 | **14.3m**    | 38.6m | long pole: `test` PR shards (9-10m each) and `lint`                                                                                  |
| 4   | Armed to entered queue                                       | 10m          | 36m   | ≈ stage 3 plus up to 5 queued builds ahead                                                                                           |
| 5   | **Queue build to merged** (never-ejected PR)                 | **30m**      | 44m   | long pole: **browser-test merge_group, 25-28m**                                                                                      |
| 5b  | Queue, if ejected at least once (22% of PRs in 7d)           | 2.1h         | 19.7h | 77-85% of failed-check ejections re-pass unchanged                                                                                   |
|     | **PR open to merged**                                        | **58m**      | 3.0h  |                                                                                                                                      |
| 6   | Merged to in a release                                       | **36.9h**    | 5.2d  | 62 PRs are waiting now, the oldest for 4.4d                                                                                          |

**Biggest single wait inside CI: the merge-queue build.** It takes about 30m out of 58m, and `browser-test` is the long pole in 90% of green builds. Browser shards 1 and 2 are also the main source of ejections. When a PR gets ejected, its time in the queue grows about 5x. Speeding up `browser-test` or fixing its flaky tests is the highest-leverage change. After that, look at `credential-free-build`: it has been required since 09-15, and in merge_group it runs 25.7m median, 55m p90, with 21% failures. On some builds it is already the last check to finish (13 of 125), so it could become the new long pole.

**Biggest wait end to end: the release.** Changes wait a median of 37 hours after merging before they reach users.

---

## D. Local gates (lefthook pre-commit / pre-push)

I did not run the hooks or the tests. There is no persisted timing on disk:

- `.turbo/runs/` does not exist, because local hooks do not pass `--summarize`.
- `scripts/pre-push-watchdog.sh` writes its log to a `mktemp` file and deletes it on exit.
- `~/.dork/logs` holds DorkOS server logs, not hook logs.

The only measured numbers in the repo are the comments in `lefthook.yml`. On 2026-07-27, a full lint plus typecheck pre-commit took 23 minutes with five agent sessions on the box. On 2026-09-02, the affected-only pre-commit took about 1s for a commit touching only root files and about 103s for a one-line CLI commit.

**Evidence from agent transcripts** (`local_gate_timings.py`):

- **Source:** the Claude Code JSONL transcripts under `~/.claude*/projects/*dork-os-dorkos*`, excluding the private sibling repo, modified since 08-20. That is 2,006 files and 3,643 measured calls.
- **What was measured:** the wall time from each Bash `tool_use` running `git commit` / `git push` to its `tool_result`, which is dominated by the hook.
- **Excluded:** `--no-verify`, `-n`, `--dry-run` and backgrounded calls.

| kind        | window | n     | median   | p75  | p90      | max  | tool error | hit the ~10-min Bash ceiling |
| ----------- | ------ | ----- | -------- | ---- | -------- | ---- | ---------- | ---------------------------- |
| commit      | 30d    | 2,457 | 50s      | 115s | 187s     | 608s | 10%        | 24 (1%)                      |
| commit      | 7d     | 384   | 50s      | 113s | 210s     | 600s | 3%         | 2 (1%)                       |
| push        | 30d    | 1,068 | **120s** | 381s | **600s** | 639s | 19%        | **134 (13%)**                |
| push        | 7d     | 179   | 59s      | 490s | 601s     | 639s | 1%         | **33 (18%)**                 |
| commit+push | 30d    | 98    | 13s      | 80s  | 419s     | 605s | 14%        | 5%                           |

Weekly push medians: W34 156s, W35 120s, W36 182s, W37 66s, W38 88s. Pushes that hit the ceiling: 7, 18, 60, 25, 24.

The push median is improving, but **about 1 push in 6 still runs into the agent's 10-minute tool timeout**. That wastes agent time and makes the agent guess whether the push went through.

Caveats:

- The transcripts cover interactive agent sessions only (`~/.claude`, `~/.claude2`, `~/.claude3`), not a human's terminal.
- Commit durations include runs where prettier or the drizzle step did the work.
- A call that hit the ceiling means "at least 10 minutes", not the true duration.

---

## E. Release cadence and DORA-style numbers

Scripts: `gh release list -R dork-labs/dorkos --limit 100 --json tagName,publishedAt,createdAt,isPrerelease,name > releases.json`, tag commit dates via `gh api repos/dork-labs/dorkos/commits/<tag>` (in `tag_commits.json`), and `analyze_flaky_dora.py` / `fix_regressions.py`.

**Releases in the last 60 days:**

| Tag     | Published |
| ------- | --------- |
| v0.54.0 | 07-21     |
| v0.55.0 | 07-22     |
| v0.56.0 | 07-22     |
| v0.57.0 | 08-03     |
| v0.58.0 | 08-06     |
| v0.59.0 | 08-12     |
| v0.60.0 | 08-17     |
| v0.61.0 | 08-17     |
| v0.62.0 | 08-19     |
| v0.63.0 | 08-22     |
| v0.64.0 | 08-24     |
| v0.65.0 | 08-26     |
| v0.66.0 | 08-29     |
| v0.73.0 | 09-03     |
| v0.74.0 | 09-07     |
| v0.75.0 | 09-14     |
| v0.75.1 | 09-14     |

The version numbers jump from 0.66 to 0.73. Tags v0.67 through v0.72 do not exist. The median gap between releases is 3.1 days and the longest was 11.5 days.

| DORA-style metric                                                                           | Value                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deployment frequency: releases                                                              | 8 in 30d (about 1.9 per week); 2 in 7d, none since 09-14                                                                                                                                   |
| Deployment frequency: merges to main                                                        | 25.7/day (30d), 15.8/day (7d); peak day 60 (09-03); 09-17 to 09-19: 2, 3, 5                                                                                                                |
| Lead time, first commit to merged                                                           | median 2.0h, p90 8.4h                                                                                                                                                                      |
| Lead time, merged to released                                                               | median 36.9h, p75 2.9d, p90 5.2d                                                                                                                                                           |
| Lead time, first commit to released                                                         | median **40.8h**, p90 5.3d                                                                                                                                                                 |
| Change-failure proxy: reverts                                                               | **0** revert PRs in 30d                                                                                                                                                                    |
| Change-failure proxy: `fix` PRs                                                             | 336 of 779 (43%). Most fix bugs found by agents' own tests and reviews, not escaped regressions                                                                                            |
| Change-failure proxy: fix PRs that use regression language and cite a PR merged ≤7d earlier | **24 (3.1% of merges)**, median 7.2h after the cited PR                                                                                                                                    |
| Change-failure proxy: `hotfix` in title                                                     | 1                                                                                                                                                                                          |
| Main-branch red episodes (push-to-main runs, first failure to next success)                 | test 6 (restore median 90m, max 5.0h); Desktop Smoke 3 (73m); docs-openapi-check 2 (10.4h, max 19.4h); CLI Smoke 2 (22m); typecheck 1 (1.8h); browser-test 1 (3.6h); scripts-test 1 (2.6h) |
| Time to restore (proxy)                                                                     | median about 1.5h across those episodes. The queue gates `main`, so these are mostly checks that only run on push, like docs-openapi-check and Desktop Smoke                               |

Conventional-commit type mix for merges in 30d: fix 336, feat 195, docs 109, test 48, chore 38, ci 32, refactor 19.

---

## Caveats

- **Time bases.** The PR lists were pulled at about 07:40Z on 09-19; the latest merge in the data is 07:34Z. The runs were pulled later, and the latest run is 14:13Z. "Merges/day" uses an 08:00Z end.
- **Pagination.** The runs endpoint caps any filtered query at 1,000 results. Capped days were re-fetched in 2-hour windows, and every window was under the cap. `gh pr list --limit 1000` returned 779 and 783 PRs, so it was not truncated.
- **Claude review time** is the first comment or review by login `claude` at or after the PR opened. PRs labelled `skip-review` have none.
- **Job samples.** S1 is 30 runs per workflow and event, so its p90s carry noise. S3 is one full day, which is exact for that day but is only one day. The weekly job-minute totals are estimates from sample means. Before 08-29, the `test` job was unsharded, which pulls the 30d test averages upward.
- **"Re-queued unchanged, then merged"** cannot tell a flaky test apart from a failure caused by another PR ahead in the same queue batch. Both are failures unrelated to the PR's own code.
- **First commit time** is the authored date of the PR's first commit. A rebase keeps authored dates, but squashing a branch locally before opening the PR would hide earlier work.
- **Change-failure rate** is only a proxy. Regressions are not labelled, so it counts reverts plus fix PRs whose body uses regression wording and cites a recent PR.
- The 30d window includes the CI-saturation period of 08-20 to 08-24 and the unsharded-test period before 08-29. For how things run now, use the 7d columns.
