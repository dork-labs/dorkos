---
slug: browser-test-pr-leg
id: 260907-171831
created: 2026-09-07
status: ideation
linearIssue: DOR-1818
---

# The browser suite should red on the PR, not on everyone else's queue entry

- **Slug:** browser-test-pr-leg
- **Id:** 260907-171831
- **Date:** 2026-09-07
- **Status:** ideation
- **Author:** Claude (directed by Dorian), IDEATE stage
- **Tracker:** [DOR-1818](https://linear.app/dorkian/issue/DOR-1818)
- **Anchor:** `origin/main` @ `9c6624df1`, 2026-09-07T16:17Z. Every `file:line` below was opened at that commit. Every number below was measured from the GitHub Actions API on 2026-09-07 over the window **2026-09-03T18:10Z → 2026-09-07T16:31Z** (600 `browser-test` workflow runs, 6 pages of 100), except where a different window is named. "Runner-minutes" means the sum of `completed_at − started_at` across a run's jobs; "wall" means `updated_at − run_started_at` on the run.

---

## 1) Intent & Assumptions

**Task brief.** Since the 2026-08-23/24 CI-saturation split, `browser-test` reports an instant pass-through on `pull_request` and only really runs on `merge_group`. UI changes therefore land with stale e2e specs, and the merge queue is the first place the drift ever shows. Once main's specs are broken, every queued PR fails against the combined tree and gets ejected, so one bad merge stalls everybody.

**The brief is correct, and the measurements make it worse than stated.** The ticket cites "#1598 ×6". The actual figure for that PR is **43 ejections** (§4.3). Across PRs #1590–#1660, **967 ejections over 71 PRs — 100% of them ejected at least once**, mean 13.6. The cited "four stale specs, every queue entry failing" on 2026-09-05 shows up as **135 failed merge-group `browser-test` runs in 13 hours**.

**Three assumptions in the current design are load-bearing, and two of them are now measurably false.** The split's own header (`\.github/workflows/browser-test.yml:19-44`) rests on: (a) runner minutes are scarce, (b) a Free-plan org capped at 20 concurrent hosted jobs makes the shards starve for runners, (c) the merge-group run is the only place the combined tree is seen. Checked one at a time:

- **(a) is false. Minutes are free here.** `gh api repos/dork-labs/dorkos` reports `"visibility": "public"`. GitHub-hosted standard runners on public repositories are not billed, at any plan tier. There is no dollar cost to weigh; the arithmetic in the header measures a resource nobody is paying for.
- **(b) is false today, and the org is no longer on the plan the header names.** `gh api orgs/dork-labs` reports `plan.name: "team"`, not free — the concurrency ceiling is 60 hosted jobs, not 20. And the starvation the header describes (15–40 minute waits, run 32663568051) does not reproduce: measured across 54 `browser-shard` jobs sampled over the whole window, queue wait (`created_at → started_at`) is **p50 0s, mean 6s, p90 6s, max 60s**. Sampled _specifically_ inside the worst hours of the 2026-09-05 outage (48 jobs, 10:00–19:00Z), it is **p50 2s, mean 25s, p90 142s, max 199s**. Three minutes at the very worst, against the fifteen-to-forty the header was written from.
- **(c) is true and stays true.** The combined tree is real, the two-PR interaction class is real (DOR-656), and nothing in this document proposes taking the shards out of the queue. The queue leg is the gate. The question is only whether the PR should _also_ get a real answer.

**What this changes about the argument.** The split was a cost decision made against a cost that no longer exists. What is scarce here is not minutes and not runner slots — it is **operator attention and queue throughput**, and the current design spends both freely. The correct frame is not "how little can the PR leg cost" but "what is the cheapest place to learn the answer", and the measurements say the PR leg is now strictly cheaper than the queue for the dominant failure class.

**Assumptions carried in, each with its check:**

- **An advisory PR check already has teeth, without any branch-protection change.** `scripts/should-arm-automerge.sh:86-121` refuses to arm auto-merge while _any_ check reports `bucket == fail` (condition 11, `SKIP failing-checks`). So a new, non-required job that reds on a PR stops `merge-tail.yml` from arming that PR — enforcement without the operator's ruleset. This is exactly how `copy-spec-drift` already behaves (`browser-test.yml:571-582` says so in as many words).
- **`@smoke` is not a cheap subset.** 60 of 125 `test.describe` blocks under `apps/e2e/tests` carry `@smoke` — 48% of the suite by block count. A "smoke tier" is half the suite, not a tenth, so it does not buy the wall-time saving the option implies (§5, Option E).
- **Playwright's `webServer` array is global.** `apps/e2e/README.md` states it outright: _"whatever legs are listed boot for every run, regardless of `--project`."_ Six legs, booting **sequentially**, ~2m24s fixed cost measured on run 32239903731 (`playwright.config.ts:375-387`). No project- or path-based narrowing recovers that cost — which is what kills the affected-only option (§5, Option A).
- **The suite is not billable.** One file (`chat/send-message.spec.ts`, 5 tests) is `@integration`, drives a real model, and is `grepInvert`-ed out (`playwright.config.ts:785`) and pinned as a `FILTERED_SPECS` exemption in `scripts/assert-browser-tests-executed.sh`. Everything else asserts UI and state without spending anything. Running the suite more often spends no money.

**Out of scope:**

- Changing what the merge-group leg does. It stays the gate; the combined-tree argument is untouched.
- Making anything a _required_ check. Every proposal here lands as an advisory job, because arming-refusal is sufficient (above) and because a required check is a branch-protection change only the operator can make.
- Fixing the shard-boundary flake class itself (DOR-1820, DOR-1834). §4.4 cites it as a measured failure mode that any proposal must not amplify; repairing it is separate work.
- Test selection based on `manifest-curated.json`. §5 Option A rules it out on coverage evidence.

---

## 2) Pre-reading Log

| Read                                                                           | Takeaway                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/browser-test.yml:19-44`                                     | The split's own statement of premises. Names the Free plan, the 20-job cap, and run 32663568051's 15–40 minute waits as the reason. All three are measured stale in §1. The header is otherwise the best document in the repo on this subject and its correctness argument (§1(c)) survives intact.                                                       |
| `.github/workflows/browser-test.yml:46-69`                                     | Why there is no `paths:` filter, and it is the strongest argument against Option A: the motivating regression was a changed placeholder _string_ in `apps/client` breaking a locator in `apps/e2e`, which a path filter misses by construction. Also: a path-filtered workflow can never be a required check, because a skipped workflow reports nothing. |
| `.github/workflows/browser-test.yml:559-582`                                   | `copy-spec-drift` is the existing precedent for exactly this shape — a separate, deliberately-not-required PR-time job whose red still costs a human look because `should-arm-automerge.sh` refuses to arm past it. The proposal in §6 is this pattern applied to the shards.                                                                             |
| `scripts/should-arm-automerge.sh:75,86-121`                                    | The 13-condition arm decision, in precedence order. Per-PR only: it fetches state, isDraft, mergeStateStatus, autoMergeRequest, reviewDecision, labels, unresolvedThreads, and per-check `{name, bucket}`. It has **no notion of queue-wide health, main's status, or this PR's own ejection history**. `HOLD_LABELS` is consumed only here.              |
| `.github/workflows/merge-tail.yml` (cron `*/10 * * * *`)                       | Arms auto-merge every 10 minutes. Already runs one GraphQL query per PR for `mergeQueueEntry` and `reviewThreads`; adding a field to it, or one global `gh api` call per tick, is a round-trip it already pays. No queue-health notion anywhere.                                                                                                          |
| `scripts/assert-browser-tests-executed.sh`                                     | The two self-policing exemption lists (`OPT_IN_SPECS`, `FILTERED_SPECS`) that any quarantine mechanism would have to imitate: named entries, each carrying a reason, each checked for staleness **in both directions**. A spec silently skipped without joining a list reds this script by design.                                                        |
| `scripts/check-copy-spec-drift.ts` (775 lines, DOR-1647; hardened by DOR-1819) | TS-AST walk over `COPY_ROOTS` at base vs HEAD, extracts prose chunks (≥10 chars, must contain whitespace and a letter), cross-references removed chunks against every string and regex literal under `apps/e2e`. Thresholds calibrated on replayed incidents (#1397, #1406, #1549) and pinned by `scripts/__tests__/check-copy-spec-drift.test.ts`.       |
| `.github/workflows/test.yml:174-176` (DOR-1731, #1646)                         | The precedent for a real PR leg: both events run the same 4-way shard matrix; only the `run:` line differs (`turbo test --affected` on PR, full `turbo test` on merge_group). This is the shape §6 copies — the PR leg answers narrower but _actually runs_.                                                                                              |
| `apps/e2e/playwright.config.ts:375-387,456-718,785,810`                        | 8 projects, 6 webServer legs, global boot ~2m24s, `grepInvert: /@integration/`. Sharding is by test count and reported even (110/109/109 of 328 collected at the time the header was written).                                                                                                                                                            |
| `apps/e2e/manifest-curated.json`                                               | 23 curated keys, all with non-empty `relatedCode`, against an addressable key space of ~87 (76 spec files + 11 test-declaring modules) = **26% coverage**. Hand-curated, derived from nothing, consumed today only by `/browsertest:maintain` dashboards — never for test selection.                                                                      |
| `.agents/skills/creating-pull-requests/scripts/watch-prs.sh`                   | Already reads `timelineItems(itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT])` and classifies `EJECTED(reason)`, noting _"nothing else reports this (no webhook, no check goes red)."_ The ejection signal §7 needs is available and already in use — just not by `merge-tail`.                                                                                |

---

## 3) Current Cost Topology (measured)

### 3.1 What a run costs

Measured across 8 consecutive successful `merge_group` runs (40 jobs):

| Job                                          | n   | mean         | min  | max  |
| -------------------------------------------- | --- | ------------ | ---- | ---- |
| `browser-shard` (×3 per run)                 | 24  | **20.2 min** | 16.1 | 24.3 |
| `copy-spec-drift`                            | 8   | 0.8 min      | 0.7  | 1.0  |
| `browser-test` (fan-in)                      | 8   | 0.2 min      | 0.2  | 0.3  |
| **Total runner-minutes per merge_group run** | 8   | **61.6**     | 53.8 | 64.2 |

Wall time, across all 100 runs in the last 24 hours of the window:

| Event          | n   | p50 wall     | mean | p90  | max  |
| -------------- | --- | ------------ | ---- | ---- | ---- |
| `merge_group`  | 44  | **22.1 min** | 21.8 | 23.2 | 24.9 |
| `pull_request` | 56  | **0.8 min**  | 0.9  | 1.1  | 1.3  |

So the PR leg costs **~1.0 runner-minute** today (the fan-in echo plus `copy-spec-drift`) and the queue leg costs **~61.6**. The delta a full PR-leg suite would add is **~60.6 runner-minutes per PR run**.

### 3.2 What the repo runs, per week

Over the 94-hour window (2026-09-03T18:10Z → 2026-09-07T16:31Z):

|                                    | count in window       | per day | **per week (extrapolated)** |
| ---------------------------------- | --------------------- | ------- | --------------------------- |
| `pull_request` `browser-test` runs | 211                   | 54      | **~377**                    |
| `merge_group` `browser-test` runs  | 389                   | 99      | **~694**                    |
| merged PRs                         | 100 (in the last 57h) | 42      | **~290**                    |

The `merge_group` count is nearly double the `pull_request` count, and 2.4× the merged-PR count. That ratio is the cascade: each ejection re-cuts the group and re-runs the suite for every entry still in it.

### 3.3 The bill, and where it goes

|                                                 | runner-min in window    | per week |
| ----------------------------------------------- | ----------------------- | -------- |
| `merge_group` runs, total                       | 389 × 61.6 = **23,962** | ~42,000  |
| — of which **failed**                           | 218 × 61.6 = **13,429** | ~23,500  |
| — of which succeeded                            | 171 × 61.6 = 10,533     | ~18,400  |
| `pull_request` runs, total (today)              | 211 × 1.0 = **211**     | ~370     |
| **Counterfactual: full shards on every PR run** | 211 × 60.6 = **12,787** | ~22,400  |

**This is the finding the whole document turns on.** Running the full browser suite on every pull-request push for four days would have cost **12,787 runner-minutes**. Over the same four days the merge queue burned **13,429 runner-minutes on merge-group builds that failed**. The PR leg the split was avoiding is _cheaper than the waste the split produces_ — and that is before counting the minutes it would have saved by preventing those failures in the first place.

### 3.4 Conclusions by event

`browser-test` run conclusions over the full window (600 runs):

| event          | success | failure | cancelled | **failure rate** |
| -------------- | ------- | ------- | --------- | ---------------- |
| `merge_group`  | 171     | 218     | 0         | **56%**          |
| `pull_request` | 206     | 3       | 2         | 1.4%             |

All three `pull_request` failures were `copy-spec-drift` (verified by pulling the failing job name on each). That is the DOR-1647/1819 gate's entire measured yield in four days: **3 catches out of 211 PR runs**, against a queue that reds at 56%.

---

## 4) Evidence From This Drain

### 4.1 The 2026-09-05 outage, hour by hour

`merge_group` `browser-test` conclusions, bucketed by hour (UTC). The outage window is unmistakable:

```
09-05 10   ok  0   FAIL  6   ######
09-05 11   ok  7   FAIL  7   #######
09-05 12   ok  1   FAIL 10   ##########
09-05 13   ok  2   FAIL 15   ###############
09-05 14   ok  0   FAIL 11   ###########
09-05 15   ok  2   FAIL  9   #########
09-05 16   ok  3   FAIL 16   ################
09-05 17   ok  0   FAIL  9   #########
09-05 18   ok  2   FAIL 13   #############
09-05 19   ok  0   FAIL 16   ################
09-05 20   ok  5   FAIL 13   #############
09-05 21   ok  4   FAIL  3   ###
09-05 22   ok  2   FAIL  7   #######
```

**135 failures against 28 successes in 13 hours** — 8,316 runner-minutes, and roughly 50 hours of queue wall time, spent re-proving the same breakage. Nothing in the system noticed that the _same_ answer was being computed over and over.

### 4.2 It is not one bad day

The calm window (2026-09-06T01:17Z → 2026-09-07T16:17Z, the most recent 100 `merge_group` runs of each workflow) still shows the shape:

| required check | `merge_group` runs | failures | rate    |
| -------------- | ------------------ | -------- | ------- |
| `browser-test` | 100                | 20       | **20%** |
| `test`         | 100                | 22       | 22%     |
| `typecheck`    | 100                | 0        | 0%      |
| `lint`         | 100                | 0        | 0%      |

`typecheck` and `lint` never fail in the queue, because they run for real on the PR. `test` and `browser-test` do. `test` has a real (affected-only) PR leg and still reds at 22%, which is honest evidence that **a PR leg does not eliminate queue reds** — the combined-tree class is real. But `browser-test`, with _no_ real PR leg, contributes an equal share of queue reds while its PR leg catches 1.4%.

### 4.3 The ejection cascade, counted

Queried `timelineItems(itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT])` for every PR from #1590 to #1660:

- **71 PRs, 967 total ejections, mean 13.6 per PR**
- **71 of 71 (100%) were ejected at least once**

| PR    | ejections | title                                                                               |
| ----- | --------- | ----------------------------------------------------------------------------------- |
| #1635 | **57**    | feat(connectors): enforce brokered execution across DorkOS                          |
| #1598 | **43**    | fix(client): the Account row saves through the operator route (DOR-1736)            |
| #1612 | 29        | feat(connectors): add stable connection identities and scoped access                |
| #1590 | 25        | fix(client): keyboard users can reach sidebar drag from the Tab order               |
| #1605 | 23        | fix(connectors): verify raw MCP before connecting                                   |
| #1652 | 18        | test(client,e2e): the audit's deferred guards are measured, not asserted (DOR-1816) |
| #1643 | **17**    | fix(client): a menu that is closing no longer eats your next click (DOR-1834)       |
| #1651 | 12        | fix(client): a closing dropdown list keeps your click (DOR-1835, DOR-1836)          |

The three PRs the ticket names as evidence are all here, and all worse than reported. #1598 took **21 hours** from open to merge (2026-09-05T19:26Z → 2026-09-06T16:09Z) against a repo p50 of **0.7h** (n=60 merged PRs; mean 5.1h, p90 17.4h). An ejection is not free: `should-arm-automerge.sh` condition 3 skips an already-armed PR, but an ejection **silently disarms auto-merge**, so each one costs a dequeue, a re-arm, and operator attention in between — and nothing reports it (`watch-prs.sh` header).

### 4.4 The shard-boundary flake class (DOR-1820, DOR-1834)

Sampling 14 failed `merge_group` runs and pulling the failing job names shows the failures are concentrated in shards 1 and 2 — which `browser-test.yml:168-173` predicts, since those are pure `chromium` (the app leg) while shard 3 carries the six test-mode projects:

```
browser-shard (1/3): Run the browser suite     ← in 12 of 14 sampled runs
browser-shard (2/3): Run the browser suite     ← in  8 of 14
browser-shard (3/3): Run the browser suite     ← in  2 of 14
browser-test:        Prove the browser suite actually executed  ← 1 of 14
```

This is a **measured constraint on every proposal below**: the suite already has a flake class that lives at shard boundaries, and `--shard` divides by test count, not duration, with no proof the three take equally long (the header says so explicitly at `:168-173`). Any option that _raises_ the shard count (Option E, and the sharding half of the recommendation) makes each shard shorter and the boundary count higher, so it must be judged against whether it amplifies DOR-1820/1834. §8 registers this as the primary uncertainty.

---

## 5) The Middle Grounds, Costed

### Option A — affected-only browser runs on PRs

**Verdict: reject.** Three independent measurements kill it.

1. **The metadata does not exist.** `manifest-curated.json` has `relatedCode` on **23 of ~87** addressable keys (26%), hand-curated, derived from nothing, and consumed today only by health dashboards. A selection mechanism reading it would silently run _nothing_ for 74% of the suite — which is worse than the pass-through, because it looks like coverage.
2. **Narrowing saves no boot cost.** `webServer` is global. Selecting one project still boots all six legs sequentially, ~2m24s, plus the turbo build. The floor for "run one spec" is roughly the floor for "run the suite minus its tests".
3. **The regression class is cross-package by construction.** `browser-test.yml:49-56` documents the motivating case — a changed string in `apps/client` breaking a locator in `apps/e2e`. Every honest affected-set for this suite is "apps/client + apps/server + apps/site + most of packages/", i.e. the whole tree. That argument has not weakened.

### Option B — labeled opt-in (`run-browser`) with auto-apply heuristics

**Verdict: reject as designed; one part is salvageable.** A label the author must remember is a gate that fires when it is least needed — the 2026-09-05 breakage came from UI-audit copy PRs (#1547, #1549, #1607) whose authors had no reason to suspect e2e drift. And **nothing in the repo auto-applies labels today**: the only automated label mutation is `claude-code-review.yml:1099` _removing_ `re-review`. Building auto-apply means new write permissions on a workflow that currently has none, to reconstruct information (`does this PR touch apps/client`) that a job can compute for itself in one `git diff`. The salvageable part is the _scoping heuristic_, which belongs inside the job — see §6 R1, and `site-build.yml`'s precedent of putting the scope decision inside the job rather than in a workflow-level `paths:` filter.

### Option C — extend `copy-spec-drift`'s static analysis to locator drift

**Verdict: accept as a small follow-up, not as the answer.** Locator usage across the 156 `.ts` files in `apps/e2e`:

| locator style             | occurrences | statically checkable?                                                                                                                                |
| ------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getByRole`               | 484         | **mostly no** — the accessible name is usually computed from children or copy, so this collapses back into copy drift, which DOR-1647 already covers |
| `.locator(` (CSS/generic) | 377         | no — arbitrary selectors                                                                                                                             |
| `getByTestId`             | 242         | **yes** — `data-testid="foo"` ↔ `getByTestId('foo')` is an exact-string join, no fuzzy overlap logic needed                                          |
| `getByText`               | 167         | already covered (it _is_ copy)                                                                                                                       |
| `aria-label`              | 54          | partly                                                                                                                                               |
| `getByLabel`              | 31          | partly                                                                                                                                               |

So the addressable new surface is the **242 `getByTestId` call sites**, joinable exactly, reusing `check-copy-spec-drift.ts`'s existing AST-walk infrastructure. That is a genuinely cheap ticket (~1 runner-minute, no browser). But scale it honestly against §3.4: the _existing_ static gate catches 3 in 211. A `testid` sibling covers a smaller slice than copy does. It is worth building; it is not a substitute for running the specs.

### Option D — nightly/scheduled full browser run against main

**Verdict: reject.** The repo has the precedent (`evals.yml`, daily 08:00Z; `codeql.yml`, Mondays) and there is no scheduled browser run today. But the arithmetic is against it: the queue already runs this suite **99 times a day** (§3.2). A nightly adds a 100th run of the same thing, and its detection latency is _up to 24 hours_ against a p50 open→merge time of **0.7 hours**. On 2026-09-05 a nightly firing at 08:00Z would have reported at 08:00 the following day — nine hours after the outage ended. A nightly canary is a good instrument for a repo that merges twice a week. At 42 merges a day it is dominated by every other option here.

### Option E — DOR-1731's shard pattern applied to a PR-leg smoke subset

**Verdict: reject the _subset_; keep the _sharding_.** `@smoke` is a real, pre-existing, well-adopted tag — but it covers **60 of 125 `test.describe` blocks (48%)**. A "smoke tier" here is half the suite, so it buys roughly half the wall time while leaving a 52% coverage hole that lands, as always, in the queue. Combined with the global `webServer` boot that a subset still pays in full, the saving is well under half. And it adds a permanent taxonomy-maintenance duty: every new spec must be judged smoke-or-not, with the failure mode (guessing "not") silently invisible until the queue reds. DOR-1731's _sharding_ insight is right and is adopted in §6; its application to a subset is not.

---

## 6) Recommendation

**Give the pull request a real browser answer, as a separate advisory job, sharded for wall time. Then teach the queue to stop refilling a trap.** Two changes, independent, in that priority order.

### R1 — `browser-pr`: the full suite, on the PR, advisory, 6-way sharded

Add a **new job**, `browser-pr`, to `browser-test.yml`, running on `pull_request` only. It runs the same suite the queue runs, with `--shard=i/6`.

**Why a new job name, not the existing one.** `browser-test` is the context string the merge-queue ruleset requires (`browser-test.yml:78-81`) — renaming it or changing what it means on `pull_request` risks the queue deadlock that PR #1246 measured. A separate name keeps the two verdicts separately readable and makes the change fully reversible by deleting one job. This is precisely `copy-spec-drift`'s precedent (`:565-569`).

**Why advisory is enough.** `should-arm-automerge.sh:86-121` condition 11 refuses to arm auto-merge while any check reports `bucket == fail`. A red `browser-pr` therefore stops `merge-tail` from arming that PR — the PR cannot reach the queue unattended. No branch-protection change, no operator gate, no risk of a never-reporting required check.

**Why six shards.** The header's own curve (`:152-157`): 3 shards → 17m, 6 shards → 11m. Minutes are free (§1(a)) and runner slots are not binding even at peak (§1(b)), so the only currency is the author's wall clock. 11 minutes sits under `test.yml`'s existing PR shards (8–13 min), so it does not become the critical path. **This is the single riskiest choice in the document** — more shards means more shard boundaries, and DOR-1820/1834 live there (§4.4). §8 U1 and the R1 execute ticket both require measuring before committing to six.

**Why full suite, not affected or smoke.** §5 A and E. The affected-set is the tree; the smoke tier is half the suite.

**Scoping.** Run it on every PR at first — the scope decision is a second-order optimization and getting it wrong reintroduces the hole. If a later measurement justifies scoping, put the decision **inside the job** (turbo `--affected` intersected with the app closure, plus explicit `docs/`-style content roots), never in a workflow-level `paths:` filter — `site-build.yml`'s header explains why a path-filtered workflow reports nothing at all.

**Cost:** ~66–70 runner-min per PR run (6 shards each re-paying the ~4m15s fixed cost), ~11 min wall, ~377 PR runs/week ⇒ **~25,000 runner-min/week added**, against ~23,500/week currently burned on failed queue builds. Expected net: **flat to negative**, since the queue's 56% failure rate is what the change attacks.

### R2 — a queue circuit-breaker in the arm decision

Teach `merge-tail.yml` + `should-arm-automerge.sh` one piece of **global** state: is the queue currently rejecting everything?

Concretely: `merge-tail.yml` fetches once per tick (not per PR) `gh api /repos/{owner}/{repo}/actions/workflows/browser-test.yml/runs?event=merge_group&per_page=N`, threads the last-N conclusions into each PR's payload, and `should-arm-automerge.sh` gains one condition — if ≥K of the last N `merge_group` runs failed, verdict `SKIP queue-unhealthy`. Place it **above** condition 11 so the reported reason names the real cause rather than the PR's own checks.

This does not fix a broken main. It stops the system from feeding 15 more PRs into a queue that is rejecting everything, which is what turned four stale specs into 967 ejections. The queue drains, someone fixes main, arming resumes on its own.

**It is cheap and it fits the existing idioms.** One extra API call per 10-minute tick. One new condition. One new line in `scripts/test-should-arm-automerge.sh`, whose harness (`check <name> <expected-verdict> <jq-mutation>` against a green fixture) is built for exactly this. The ejection-history field (`timelineItems(itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT])`) is available in the same GraphQL round trip `merge-tail.yml` already makes and `watch-prs.sh` already uses — a per-PR "ejected ≥M times" backstop is a natural second condition if the global one proves too blunt.

### Deliberately not recommended

- **A nightly canary (Option D).** Dominated at 42 merges/day. Say no explicitly so it is not re-proposed.
- **Affected-only selection (Option A).** 26% metadata coverage, no boot saving, cross-package regression class.
- **A quarantine list.** It would have to become a third self-policing list in `scripts/assert-browser-tests-executed.sh`, alongside `OPT_IN_SPECS`/`FILTERED_SPECS`, with staleness checked in both directions. That is buildable, but with R1 catching drift at PR time and R2 stopping the cascade, a quarantine's remaining job is "let a known-broken spec stay broken", which is a place broken specs go to die. Revisit only if R1+R2 land and a genuine flake still blocks the queue repeatedly.
- **Promoting anything to a required check.** Not needed (arming-refusal suffices) and not ours to do.

---

## 7) Execute-Ticket Sketches

| #   | Ticket                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Depends on           | Size |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---- |
| T1  | **Measure the shard curve before choosing N.** Run the suite at `--shard=i/6` on a throwaway branch's merge group (or `workflow_dispatch`) and record per-shard wall + failure distribution. Deliverable: the real 6-shard numbers, and a judgment on whether DOR-1820/1834 worsen. Blocks T2's shard count.                                                                                                                                                      | —                    | S    |
| T2  | **`browser-pr`: the PR gets a real browser answer.** New advisory job in `browser-test.yml`, `pull_request` only, `--shard=i/N` from T1, mirroring `browser-shard`'s cache/apt/build steps and its upload-on-failure steps. Update the workflow header — it is the repo's canonical account of this decision and must record that (a) the repo is public so minutes are free, (b) peak queue wait measured 199s not 15–40min, (c) the queue leg remains the gate. | T1                   | M    |
| T3  | **The arm decision learns whether the queue is healthy.** `merge-tail.yml` fetches recent `merge_group` `browser-test` conclusions once per tick; `should-arm-automerge.sh` gains `SKIP queue-unhealthy` above `SKIP failing-checks`; one fixture per branch in `scripts/test-should-arm-automerge.sh`. Calibrate K/N by replaying the 2026-09-05 window.                                                                                                         | — (parallel with T2) | M    |
| T4  | **`getByTestId` drift joins the copy gate.** Extend `check-copy-spec-drift.ts` (or add a sibling reusing its AST walk) to join `data-testid` literals removed from `COPY_ROOTS` against the 242 `getByTestId` call sites in `apps/e2e`. Exact-string join — no coverage thresholds needed. Pin fixtures alongside the existing suite.                                                                                                                             | —                    | S    |
| T5  | **Retire the stale premises in prose.** After T2 lands and has run a week, revisit whether `browser-test`'s merge-group leg can drop to 3 shards or whether the PR leg makes some queue reds redundant. Explicitly a _measurement_ ticket, not a change ticket.                                                                                                                                                                                                   | T2 + 1 week          | S    |

---

## 8) Uncertainty Register

| #   | Uncertainty                                                                                    | Why it matters                                                                                                                                                                                                                                                       | How to resolve                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | **Does 6-way sharding amplify the DOR-1820/1834 shard-boundary flake class?**                  | This is the recommendation's biggest risk. `--shard` divides by test count, not duration; shards 1–2 already carry most failures (§4.4). More boundaries could turn a 56% queue failure rate into a 56% _PR_ failure rate, which would be strictly worse than today. | T1 measures it directly before T2 commits. Fall back to 3 or 4 shards if the flake rate rises.                                                                                                                    |
| U2  | **What share of the 218 merge-group failures were genuine drift vs. flake?**                   | The 12,787-vs-13,429 comparison in §3.3 assumes most of that waste is preventable at PR time. If half were flakes, R1's payback halves.                                                                                                                              | Parse the uploaded `playwright-report-shard-*` artifacts (7-day retention, so this must be done soon) and classify failures by spec + assertion. Feasible; not done here.                                         |
| U3  | **Is the concurrency ceiling really 60?**                                                      | §1(b) rests on `plan.name: "team"`. The billing API endpoint returned HTTP 410 ("this endpoint has been moved"), so the seat/concurrency figure is inferred from the plan name plus the measured 0–199s waits, not read directly.                                    | The measured waits are the stronger evidence and already suffice; but confirm via the new billing API before citing "60" in the workflow header.                                                                  |
| U4  | **Does an ejection reliably disarm auto-merge, and does `merge-tail` re-arm within one tick?** | R2's value depends on the cascade being self-sustaining. If re-arming is already fast and cheap, the circuit-breaker matters less than R1.                                                                                                                           | `should-arm-automerge.sh` condition 3 skips already-armed PRs; whether an ejection clears `autoMergeRequest` is documented in memory but not measured here. Replay #1598's timeline against merge-tail's run log. |
| U5  | **Will `browser-pr` reds actually block arming, or will they be routed around?**               | The enforcement story is entirely `should-arm-automerge.sh` condition 11. If operators respond to a red advisory job by applying `hold`… they cannot — `hold` also skips arming. But they _can_ merge by hand.                                                       | Watch the first week after T2: count PRs merged with `browser-pr` red. If nonzero, the advisory framing is not working and the required-check conversation is owed to the operator.                               |
| U6  | **Does `webServer`'s global boot make a 6th shard disproportionately expensive?**              | Each added shard re-pays ~2m24s of sequential leg boot plus ~1m45s of setup. At 6 shards that is ~25 runner-minutes of pure fixed cost per run — 38% of the bill.                                                                                                    | T1's measurement answers it. If fixed cost dominates, the better lever is making `webServer` conditional on selected projects (a separate, larger ticket in `apps/e2e`).                                          |
| U7  | **Extrapolating weekly figures from a 94-hour drain window.**                                  | §3.2's per-week numbers assume this drain's velocity is typical. It is probably a high-water mark.                                                                                                                                                                   | Every conclusion here is a _ratio_ (PR cost vs. queue waste), and ratios survive a volume change. The absolute weekly figures should be re-read as "at drain velocity".                                           |

---

## 9) Open Decisions for SPECIFY

- **D1 — Shard count for `browser-pr`.** 3, 4, or 6. Resolved by T1 against U1. Default to 4 if the measurement is ambiguous: it holds wall time near 14 minutes with a third fewer boundaries than 6.
- **D2 — Does `browser-pr` run on every PR, or scoped?** Recommendation is every PR initially. If scoped later, the decision goes _inside_ the job.
- **D3 — K and N for the circuit-breaker.** Calibrate by replaying 2026-09-05. A first guess of "≥3 of the last 5 merge-group `browser-test` runs failed" would have tripped by 09-05 12:00Z and stayed tripped through 20:00Z, sparing roughly 100 builds.
- **D4 — Does the circuit-breaker consider `test` too, or only `browser-test`?** `test` reds at a comparable 22% (§4.2). Generalizing to "any required check failing repeatedly in the queue" is more useful and no harder.
- **D5 — Should `browser-pr` reuse `copy-spec-drift`'s advisory framing in its failure message?** A red advisory job that a human may legitimately override needs to say so in the log, or it reads as a broken gate.
