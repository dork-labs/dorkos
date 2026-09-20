# CI Steward: a self-monitoring, self-improving CI pipeline

**Status:** v4, 2026-09-19. SIGNED by the adversarial reviewer (Vesper, Fable) after eight rounds. Review files: `research/20260919_ci-pipeline-supporting/plan-review/`.
**Author:** orchestrator session `ci-research-sep`.
**Evidence base:** `research/20260919_ci-pipeline-deep-review.md` and its four reports (01 inventory, 02 timings, 03 benchmarks and methods, 04 change tracking).

## 0. What the operator asked for (2026-09-19)

1. **Merges stay fully autonomous.** No human approval before merge, ever. Quality has to come from the machine.
2. **Tracking and monitoring first**, before speed work.
3. CI documented **consistently and primarily for agents**, because agents will use it to improve the pipeline.
4. Pipeline **changes and performance tracked** so we can improve continuously.
5. Bundled as a **skill that can become a marketplace plugin**.
6. A **regular review** that decides whether each change worked.
7. **Self-testing, self-monitoring, self-improving.**
8. The pipeline must end up **much faster and much higher quality than average**.

## 1. The problem, in one paragraph

We change the pipeline about 13 times a week and document each change well, but we never check whether a change worked: 0 of about 94 changes had a planned post-rollout check, and 3 results found by accident contradicted their change. Nothing records pipeline performance, so every incident is re-measured from scratch and the same failure classes recur 3 to 15 times. The pipeline only ever grows (typecheck runs up to 7 times per change) because nothing puts a price on a gate. With merges fully autonomous, the pipeline is the only thing between an agent and `main`, so it must be fast, trustworthy, and able to keep itself that way with no human noticing drift.

## 2. Design principles

1. **Close the PDCA loop.** Every pipeline change is an experiment with a metric, a baseline, a target and a date. The "Check" is computed by code, never written by an LLM.
2. **Theory of Constraints picks the work**, by a fixed precedence (section 4.4), not by argument.
3. **Intent on `main`, observations on a data branch.** Hand-owned files (what we want) live on `main`. Machine-owned files (what happened) live on an append-only orphan branch. Nothing the system generates ever needs a PR.
4. **Docs that can't drift.** Facts that exist in the workflow YAML are generated from it, not copied. Anything checkable is checked by a step that runs on every PR and every merge group.
5. **Every gate has a price and a purpose.** Gates state what they catch; the collector measures what they cost and what they actually catch. New required machine time must fit a budget.
6. **Ratchets, enforced in-run.** Quality counts that must never silently drop are asserted inside the queue against high-water marks, at the moment of weakening, not a week later.
7. **The steward may change gates, never the steward or the judge.** Unattended changes are fenced off from the measurement code, the definitions, the review and the ratchets.
8. **Monitor the monitor.** Every automated part has a dead-man's switch that surfaces where agents look.
9. **Portable by construction.** One package with a stated dependency budget, one config file for repo specifics.
10. **Small and boring.** If a part does not change a decision, cut it.

## 3. Metrics, SLOs, targets

"Average" = CircleCI 2026 (70.8% main-branch success, 72-min recovery) and LinearB 2026 medians. "Elite" = the 10-minute build (XP, Fowler, Humble & Farley), Google's ~1.5% flaky test runs, DORA elite. Sources: `research/20260919_ci-pipeline-03-benchmarks-and-methods.md`.

**Every SLO has a `definition` block in `ci/slos.yaml`**: event source, population, exclusions, aggregation, window, minimum n, and one recorded fixture that pins its number. Populations exclude drafts and the system's own branches; Dependabot PRs are included. Windows are non-overlapping 7-day windows (so four weeks is four independent readings), plus a 28-day view for trend.

| SLO                   | Definition (short)                                                                                                                                                                  | Today (7d)                 | Floor at launch   | Objective                           | Named path to the objective                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pr-feedback`         | Per PR head SHA: first required run created to last required run completed, all green                                                                                               | p50 14.3, p90 38.6 min     | p90 40            | **p50 ≤ 7, p90 ≤ 12 min**           | turbo remote cache; affected-only PR typecheck/lint; review re-run scoped to the new diff        |
| `queue-build`         | Per queue build of a never-ejected PR: entry to merged                                                                                                                              | p50 30, p90 44-55 min      | p90 55            | **p50 ≤ 12, p90 ≤ 18 min**          | browser suite to ≥ 6 shards or faster; `credential-free-build` cut to build + boot; remote cache |
| `lead-time`           | PR opened to merged                                                                                                                                                                 | p50 58 min, p90 3.0 h      | p90 3 h           | **p50 ≤ 30, p90 ≤ 60 min**          | follows from the two above plus ~0 wasted builds; agents keep self-arming                        |
| `queue-green`         | Share of completed (not cancelled) queue builds with every required check green                                                                                                     | 75%                        | 75%               | **≥ 97%**                           | quarantine + the two flake metrics below                                                         |
| `flaky-test-runs`     | Retried-then-passed test executions / test executions (vitest flake reporter + Playwright retries; Playwright already runs `retries: 1` in CI, `apps/e2e/playwright.config.ts:301`) | not yet measured           | set after 2 weeks | **≤ 1.5%** (Google's per-run rate)  | quarantine lane; per-test tickets                                                                |
| `wasted-queue-builds` | Queue builds ejected for failed checks whose PR later merged with no new commit / all builds                                                                                        | ~17-21%                    | 20%               | **≤ 3%**                            | same                                                                                             |
| `main-green`          | Red episodes on `main` from push-to-main checks                                                                                                                                     | a few / 28d                | ≤ 3 / 28d         | **≤ 1 / 28d**, restore p90 < 30 min | retire push-main legs that re-test the queue's tree                                              |
| `local-commit`        | `git commit` hook wall time, p90                                                                                                                                                    | ~3.5 min                   | 3.5 min           | **≤ 20 s**                          | typecheck leaves pre-commit (stays at push and in CI)                                            |
| `local-push`          | `git push` hook wall time p90; share of hook runs killed                                                                                                                            | 10 min; 13-18%             | 10 min; 15%       | **≤ 2 min; 0%**                     | pre-push bounded to ~2 min, the rest left to CI                                                  |
| `headroom`            | Per job: p95 duration / `timeout-minutes`                                                                                                                                           | several ≥ 90% historically | ≤ 90%             | **≤ 60%**                           | measured timeouts instead of raised ones                                                         |
| `review-completes`    | Share of PR head SHAs whose review completed on the first attempt                                                                                                                   | ~93%                       | 90%               | **≥ 99%**                           | second credential path; re-dispatch                                                              |
| `review-recovery`     | p90 from an infra-failed review to a completed one                                                                                                                                  | n/a                        | 2 h               | **≤ 30 min**                        | merge-tail re-dispatch with backoff                                                              |

**First constraints.** Floors start at or near today, so nothing is in breach on day one. The constraint is ranked by distance from the **objective**, so the first ones are `pr-feedback`, `queue-build`, `wasted-queue-builds`, `local-push` and `local-commit`.

**Tracked, not targeted** (reported every week, never scored): `escaped` (fix PRs citing a regression from a PR merged ≤ 7 days earlier; a prose regex, too gameable to score), merged-to-released lead time (release is manual), job-minutes per merged PR, cache hit rate, reviewer runs and tokens per change, `review-red-rate` (tripwire under 4%, baseline 9.7%, section 5.3).

**Metric catalogue** (`ci/metrics.yaml`): every metric a hypothesis may name. Per gate: `duration_p50`, `duration_p90`, `failure_rate`, `retry_rate`, `real_catches`, `ejections_caused`. Per hook: `duration_p90`, `killed_share`. Queue-level: `batch_wasted_share`, `queue_wait`. Plus every SLO id. `/ci-record` offers only catalogue ids, so every hypothesis is computable by construction.

## 4. Architecture

```
main (hand-owned intent)                      ci-steward-data (orphan, machine-owned, append-only)
────────────────────────                      ─────────────────────────────────────────────────
ci/gates.yaml         {id, source, purpose}   latest.json          pointer: newest snapshot, report_ref
ci/slos.yaml          definitions+objectives  snapshots/YYYY-MM-DD.json  daily aggregates
ci/metrics.yaml       the catalogue           verdicts/<ledger-id>.json  computed verdicts
ci/ratchets.yaml      which ratchets exist    floors.json          current SLO floors
ci/required-checks.json  required contexts    hwm.json             per-package ratchet high-water marks
ci/steward-owned-paths.json  L4 fence         atlas.generated.json generated from YAML
ci/config.yaml        repo specifics          reports/YYYY-MM-DD.html  the daily report (+ index.html)
                                              reports/YYYY-Www.md  the Monday deep summary
                                              triggers.json        ranked improvement triggers
ci/ledger/<id>.md     one per change          local/<clone>/YYYY-MM-DD.json  local hook aggregates
packages/ci-steward/  the engine
.claude/rules/ci-pipeline.md   discovery      (GITHUB_TOKEN pushes; ruleset: no force-push, no delete)
contributing/ci.md    the guide
```

### 4.1 The engine: `packages/ci-steward`

- A workspace package, so turbo's `typecheck`, `lint`, `test` and knip reach it, and the queue's full `test` runs its tests.
- **Dependency budget:** node built-ins, `zod`, `yaml`; GitHub access only through the `gh` CLI via `child_process`. It runs with `node --experimental-strip-types`, like the flow plugin. A test pins the budget and asserts no import from the rest of the monorepo; everything repo-specific comes from `ci/config.yaml`.
- `now` and the window are explicit inputs everywhere; every fixture pins them. There are no literal-date time bombs.
- **Subcommands:** `census`, `ledger-check`, `collect`, `verdicts`, `triage`, `ratchet-assert`, `report` (the Monday deep summary), `daily-report`, `status`, `local-export`.

### 4.2 Gates, the census and the atlas (docs that can't drift)

- `ci/gates.yaml` is hand-owned and holds only `{id, source, purpose}` for every gate: Claude hooks, lefthook commands, workflow jobs, ruleset settings.
- `ci-steward census` generates the rest from the real YAML (triggers, "reports on" events, required, timeout, retries, shards, invoked scripts) and fails when:
  - a gate exists in YAML but not in `gates.yaml`, or the reverse;
  - a job has no `timeout-minutes`;
  - **deadlock invariant:** a context in `ci/required-checks.json` has no job of that exact name, or its workflow lacks `pull_request` or `merge_group`, or has a `paths:` filter, or a job-level `if:` can't be satisfied on both events (mutation-tested with a planted `paths:` filter on a fixture copy of `lint.yml`);
  - a required job, or any job it needs, contains `continue-on-error` or a step-level `if:` that is not on the allowlist with a reason (built in phase 0; an expiry is optional and marks a temporary exception, because an expired entry reds every PR at once);
  - an `always()` fan-in does not read `needs.<job>.result` for every job it needs.
- **Where it runs:** as a step in `typecheck.yml`, which is required and runs in full on every PR and every merge group. The five policy gates already live there (`typecheck.yml:159-253`). No new required context, so there is no deadlock exposure. (`scripts-test.yml` is path-filtered to six workflows and never runs on `merge_group`, so it could not host this.)
- The daily collector generates `atlas.generated.json` on the data branch and reconciles `ci/required-checks.json` against the live ruleset. Drift is a health breach. Classic branch protection is retired first (section 5), so the ruleset is the only source.
- **Real catches, derived rather than hand-filled:** a queue ejection for failed checks followed by a new commit before re-queue is a real catch, attributed to the failing job. This answers "which gates catch real bugs" every week.

### 4.3 The ledger

`ci/ledger/<timestamp-id>-<slug>.md`, one file per change (fragments never conflict; ids from `.claude/scripts/id.ts`).

```yaml
---
id: 260919-143012
title: Quarantine flaky browser specs out of the blocking lane
kind: experiment # experiment | incident-fix | hygiene
status: active # HAND states only: proposed | active | withdrawn | reverted
actor: agent # agent | ci-improve-tick
gates: [queue.browser-shard]
prs: [1931]
hypothesis: # required unless kind: hygiene
  metric: gate.queue.browser-shard.failure_rate # a catalogue id, narrowest that can move
  slo: wasted-queue-builds # optional secondary; reported, not used for the verdict
  baseline: 0.17 # copied by /ci-record from latest.json
  target: 0.05
  after_days: 14 # after-window length, anchored on the merge time
ratchet-release: [] # [{ratchet, package, value, reason}], scoped: see 4.6
floor-release: [] # [{slo, stat, value, reason}]: the only way a floor loosens (follow-up I, phase 1)
field-changes: [] # required when a required gate's retry/shards/timeout/required changes
---
Why, what was tried, what would make us revert. Short.
```

- `verified`, `partial`, `failed` and `inconclusive` exist only in `verdicts/<id>.json` on the data branch. The validity check rejects them on `main`. `/ci-status` joins the two.
- **Coverage check** (a `typecheck.yml` step, PR only; validity runs on PR and merge group): a PR touching any gate source, any script a gate invokes (from the generated atlas), `turbo.json`, `lefthook.yml`, `.claude/settings.json` or any `ci/` hand file must add a ledger entry (or add its PR number to an existing entry's `prs:`). On failure it prints the exact scaffold command. **It blocks from day one** (operator decision, 2026-09-19): the 7-day `continue-on-error` trial was dropped, and with it any expiry used as a switch. Dependabot PRs are exempt in the step's `if:`, because Dependabot cannot write an entry.
- `/ci-record` writes the entry and fills `baseline` from `latest.json`. `/ci-record --release <ratchet> <package> <value> "<reason>"` writes a ratchet release in one command, so agents have no reason to route around it.
- `proposed` entries are the pipeline's experiment backlog. The tracker of record is the ledger; Linear mirroring is optional.

### 4.4 Collect, verdicts, floors, constraint (all deterministic)

A daily scheduled workflow (`ci-steward.yml`, 05:00 UTC, plus `workflow_dispatch`) runs `collect`, then `verdicts`, then `report` (Mondays), and pushes to `ci-steward-data` with `GITHUB_TOKEN`. That push triggers no workflows, which is the intent. The collector stays a GitHub Actions cron, not a DorkOS scheduled skill: it is machine-only work and must run while the operator's laptop sleeps.

- **Data-branch safeguards** (the branch is the only copy of the history):
  - ruleset 23704437 keeps `ci-steward-data` append-only (no deletion, no force-push);
  - ruleset 23705388 makes tags matching `ci-steward-data/**` permanent;
  - phase 1 adds a weekly backup tag `ci-steward-data/YYYY-Www` on the branch tip;
  - the collector **refuses to recreate** a missing data branch: it alerts, and a person restores it from the newest backup tag;
  - the daily health check verifies the branch exists and both rulesets (23704437, 23705388) are present and unchanged;
  - branch-cleanup sweeps (worktree reapers, stale-branch deletes) skip `ci-steward-data`.

- **Collect:**
  - Actions runs, fetched in windows under the 1,000-result cap and asserted against `total_count`.
  - Job data per head SHA via `commits/{sha}/check-runs` (~250 SHAs a day, not ~1,100 `runs/{id}/jobs` calls), paced under `GITHUB_TOKEN`'s 1,000 requests an hour. A busy day degrades to "late", never "truncated". `health.api_calls` is recorded.
  - PR timelines (queue add and remove with reasons, auto-merge), releases, cache usage, the ruleset, and the queue's vitest and Playwright JSON reports (artifacts, 7-day retention is enough at a daily cadence).
- **Health block** in every snapshot: pages fetched vs `total_count`, n per metric vs its minimum, API calls, series gaps, the age of each clone's local export, ruleset reconcile. Any failure makes the workflow red and the snapshot is marked unhealthy.
- **Verdicts:** for each ledger entry whose after-window has closed:
  - compute the hypothesis metric over a 7-day before-window and an `after_days` after-window, both anchored on the merge time (of the entry's last merged PR) and cut at that instant: samples that carry a time (durations, waits) are cut exactly, and metrics kept as daily counts (failure and retry rates, catches, SLO shares) read only the whole days inside each window (phase 1: cutting at midnight instead flipped #1246 from `partial` to `verified`, so the instant matters);
  - first `inconclusive`, if there are confounders (other entries touching the same gate in the after-window) or n is below the minimum, naming which;
  - otherwise `verified` if it reached `target`;
  - otherwise `partial` if it moved at least halfway from the baseline toward the target (added in phase 1: "held partly" needed a name, and halfway is the smallest rule that separates real movement from noise without a tuned threshold). The baseline is the before-window's own reading when it has enough data, else the ledger's `baseline` (a gate that did not exist before the change);
  - otherwise `failed`.

  The SLO movement is reported beside every verdict. A gate that got faster while its SLO got worse is visible. Fixtures: #1391, #1135 and #1246, the only past changes with a quantified hypothesis and a measured outcome, recorded from the API in phase 1 (`packages/ci-steward/src/__tests__/fixtures/real-verdict-inputs.json`).

  **What the recorded data said (phase 1, 2026-09-19), against what this plan expected:** #1135 is `partial` as expected (43 to 18.5 min against 17). #1391 is `partial`, not held: on the queue leg (its metric now names `@merge_group`, because from #1646 the same shards also run affected-only on PRs) the shards' p50 is 12.2 min against a 10-minute target (26 to 12.2, 86% of the way). #1246 is `partial`, not failed: its recorded metric, queue wait, fell from 41.6 to 33.0 min against a target of 30, while its SLO, wasted-queue-builds, went from 3.7% to 19.3%, which the verdict reports beside it. The expectation read the incident, not the hypothesis's metric; the engine reads the metric, which is the point. With a planted same-week confounder #1246 is `inconclusive`, and against the whole ledger #1135 and #1246 are both `inconclusive` (#1246 changed `browser-test` inside #1135's window; #1391 changed `test` inside #1246's).

- **Floors** move by rule: when an SLO is `met` or `ok` for 4 consecutive non-overlapping 7-day windows, its floor tightens halfway to the objective. Floors never loosen without a ledger entry.
- **Constraint precedence** (the report names exactly one):
  1. a ratchet violation, a collector health failure, or a `headroom` breach (a job near its timeout is a tripwire);
  2. a quality SLO breach, in fixed order: `queue-green`, `wasted-queue-builds`, `flaky-test-runs`, `main-green`, `review-completes`;
  3. the speed SLO with the most excess wait-hours, measured against its **objective** (floors decide breach; objectives decide the constraint).

  Conversions:
  - `pr-feedback`, `queue-build`, `lead-time` and `local-commit`: Σ max(0, t − objective) over the population;
  - `wasted-queue-builds`: wasted builds × (median ejected queue time − median clean queue time), measured each week;
  - `local-push`: Σ max(0, t − objective) + killed runs × the tool ceiling.

- **Daily report** (`reports/YYYY-MM-DD.html`, deterministic, no LLM, plus `reports/index.html`): the pipeline is still rough, so the reporting and triage cadence is daily, not weekly. A traffic-light headline first, then the constraint with the number behind it, the SLO table with a 7-day trend arrow and an inline-SVG sparkline off the daily series, the open triggers, yesterday's merges, ejections, red spells, wasted builds and job minutes, the live experiments with their verdicts, and the collector's health. It renders from `packages/ci-steward/templates/report.html`, whose CSS is inline, so the page restyles without an engine change, and every interpolated value is escaped because pull request titles and API error text reach it. `pnpm ci:report [--day] [--open]` builds it locally into a temp path and pushes nothing.

  **What stays weekly, and why.** The statistics do not move with the cadence: SLO windows are still non-overlapping 7 days, floors still tighten only after 4 consecutive met-or-ok windows, and a verdict still waits for its whole after-window. Daily is when the numbers are _read_, not the window they are read over. GitHub throttles scheduled workflows by hours (measured: p50 2.7 h late), which is fine for a daily report, and nothing in the job may depend on the hour it actually runs.

- **Improvement triggers** (`ci-steward triage` → `triggers.json`, after `verdicts`): a ranked list computed from the data alone, no LLM. Ten rules, each with its threshold in `ci/config.yaml`'s `triage:` block, which the fence covers so an unattended tick cannot move its own goalposts: an SLO under its floor (red for quality, amber for speed); the constraint changing; a verdict of `failed` or `partial`; a gate's `failure_rate` at 1.5x the previous 7 days with a minimum n; a gate's `duration_p90` up 25% week over week, or job minutes per merged PR up 20%; the same job causing 3 or more failed-checks ejections in 7 days; any red episode on `main` (always red); a job at or above 90% of its timeout at p95; a collector health failure on any of the last 3 days; and a stale ledger entry (an `active` experiment 7 days past its window with no verdict, or a `proposed` entry older than 30 days nobody picked up). Each carries what fired with its numbers, the gate or SLO it belongs to, a suggested next step, whether a matching `proposed` entry already exists, and the day it first fired, so it is stateful enough not to nag; the report says when one has been open a long time. **Triggers open no PR and touch nothing on `main`**: phase 3's `ci-improve` consumes them, and until then a person or an orchestrating agent reads them, in the report, in `/ci-status`, or at SessionStart when one is red.

- **Weekly deep summary** (`reports/YYYY-Www.md`, deterministic, no LLM): the Monday view, week over week. The headline is the SLO trend, not the verdict count. It also shows the constraint, verdicts issued, ratchets, real catches per gate, the tracked metrics and health. Agents keep reading this and the JSON, not the HTML.
- **Dead-man's switch:** `session-maintenance.sh` reads `origin/ci-steward-data:latest.json` with `git cat-file` (no network, silent if the ref is absent). It prints one `[Harness]` line when the snapshot is over 2 days old, health failed, or a local SLO is breached. That keeps the line inside the existing contract of at most 5 lines, under 500 ms, silent when healthy.

### 4.5 Local timings

- **The wrapper:** every lefthook command runs through `ci-steward` time-wrap, which `exec`s the real command so exit codes, signals and piped semantics pass through.
  - A parent shell writes `START` before the command and `END` after it returns, to `$(git rev-parse --git-common-dir)/ci-steward/local-timings.jsonl`. That file is shared by every worktree of the clone.
  - A `START` with no `END`, older than the pre-push ceiling, counts as **killed** (the agent tool ceiling delivers SIGKILL, so no `END` is ever written).
  - SessionStart reports a younger unmatched `START` as "running or killed", never as "killed".
- **The daily local export:** `local-export` runs on the operator's machine as the DorkOS scheduled skill `ci-local-export`: a skill in `.agents/skills/` with a `schedule:` block in its frontmatter (`docs/guides/task-scheduler.mdx`), never a GitHub cron, because the data it reads lives only on this machine.
  - It lands on the Schedules page as **Waiting for approval** and runs only once the operator approves it.
  - It runs Bash, and agent-proposed schedules are clamped below that (DOR-2100), so the operator approves it at **Full autonomy**.
  - It walks every clone listed in the local config and pushes aggregates to `local/<clone>/`.
  - It rotates the file (30 days, size cap).
  - An export older than 3 days is a collector health breach in the report.
- **Known blind spot:** `--no-verify` runs are invisible to the wrapper; the report says so.

### 4.6 Ratchets (quality under full autonomy)

`ci/ratchets.yaml` names the ratchets. The values are high-water marks in `hwm.json` on the data branch, **per workspace package**:

- vitest tests passed, and tests skipped (a ceiling);
- Playwright tests passed per spec file;
- the required-context set;
- the count of required contexts reporting on `merge_group`.

**Enforced in-run.** The queue's `test` and `browser-test` fan-in jobs (which already union the shard reports for `assert-shard-union.sh`) run `ratchet-assert`:

- they fetch `ci-steward-data` with `--depth=1` (3 retries, then **fail closed** with an error naming the branch);
- they compare per-package counts to the HWMs;
- they fail on a drop, unless the merge-group tree contains a **valid release**: an entry whose `ratchet-release` names that ratchet, package and value, whose id is at most 14 days old, and which has not been consumed.

Per-package marks mean a deletion in one package can't be masked by additions in another, even inside one 5-PR batch.

- **A PR-time advisory** runs the same comparison for the packages the PR's affected-only shards ran and comments before the queue. The agent learns about a ratchet 30 minutes before an ejection, not after.
- **HWM ingestion:** the collector raises marks only from green queue builds where the assertion passed. The skipped-ceiling mark only moves down. A consumed release lowers the mark once and is then spent.
- **Releases are self-certified, so the review treats them as blocking by default** (section 5). Expect about 5% of PRs to need one; the one-command `/ci-record --release` keeps that cheap.

### 4.7 Improve: autonomous changes, fenced

`/ci-improve` takes the top `proposed` entry for the current constraint and implements it in a worktree on a `ci-improve/*` branch, with `actor: ci-improve-tick`. The PR goes through the normal pre-PR adversarial review and the required review like any other. It can be run on demand (the `/ci-improve` skill), by `/flow` drain, or unattended as `ci-improve-tick`: a DorkOS scheduled skill (a `schedule:` block in its `SKILL.md` frontmatter, per `docs/guides/task-scheduler.mdx`), never a GitHub cron. It ships with `enabled: false` until the L4 gate below passes; even then it waits on the Schedules page as **Waiting for approval** until the operator approves it, at **Full autonomy**, because it runs Bash and agent-proposed schedules are clamped (DOR-2100).

**The fence** (the steward may change gates, never the steward or the judge). The coverage step fails a `ci-improve/*` PR that touches any path in `ci/steward-owned-paths.json`:

- `packages/ci-steward/**`
- `ci/slos.yaml`, `ci/metrics.yaml`, `ci/ratchets.yaml`, `ci/required-checks.json`, `ci/steward-owned-paths.json`, `ci/config.yaml`
- `.claude/rules/ci-pipeline.md`, `contributing/ci.md`
- `claude-code-review.yml`, `REVIEW.md`, `scripts/should-arm-automerge.sh`, `merge-tail.yml`

`typecheck.yml` and `lefthook.yml` are **not** path-fenced, because seeds 5, 6 and 7 must edit them. They are fenced **by content** instead: `ci/ratchets.yaml` includes two content ratchets, "census and ledger-check steps present in `typecheck.yml`" and "time-wrap present on every lefthook command". `ratchet-assert` in the queue's `test` fan-in checks both against the merge-group tree with a fixed-string check pinned by fixtures. The census cannot guard its own removal; a different runner has to.

The tick may never author a `ratchet-release` or a `field-changes` entry, and it may run one `active` experiment per gate at a time. The branch name is a guard for the unattended path, not against an adversary; a false name still leaves a ledger trail.

**The L4 gate** (before `ci-improve-tick` is enabled), all of:

- the census, deadlock invariant, ratchet assertions and verdict engine have run clean for 2 consecutive weeks;
- the verdict engine has produced one correct verdict on a real, non-fixture entry;
- the ratchet assertion's fixture suite has proved it fails on a planted per-package drop. This is fixtures only; a live drill would eject real PRs batched with it.

**Invariant, written in `contributing/ci.md` and the ADR:** no admin credential exists in GitHub Actions. Nothing automated can edit the ruleset, so no automated change can un-require a check.

### 4.8 Discovery for agents

- `.claude/rules/ci-pipeline.md`, with `paths:` covering every gate source, every invoked script, `turbo.json`, `lefthook.yml`, `.claude/settings.json` and `ci/**`. It holds the change protocol in about 20 lines: hypothesis, `/ci-record`, releases, the deadlock invariant, the fence, and the exact `git show origin/ci-steward-data:...` commands. It is projected to `.agents/` per `syncing-agent-skills`.
- `contributing/ci.md` is the full guide, tracked by `contributing/INDEX.md`, the docs coverage map and `/docs:status`.
- AGENTS.md's CI section shrinks to a short pointer, which also reduces always-loaded context.
- The skill `stewarding-ci-pipeline` (canonical in `.agents/skills/`) holds the method: PDCA, precedence, SLOs, ratchets, the fence, how to write a narrow hypothesis, and this repo's anti-patterns.
- **User entry points are skills, not commands.** Claude Code folded commands into skills, and `.claude/commands` is legacy, so nothing goes in `.claude/commands/ci/`. Each entry point is a skill in `.agents/skills/` with `disable-model-invocation: true`, named with a hyphen (project skills cannot use a colon), and each wraps one `pnpm ci:<verb>` engine command:
  - `/ci-status` is the primary surface: SLO table, constraint, open experiments with their computed verdicts, health.
  - `/ci-pulse` collects now, including local timings.
  - `/ci-record` writes a ledger entry or a release.
  - `/ci-improve` implements the top proposal.
  - `/ci-incident` and `/ci-break-glass` are the incident levers (§4.9).

### 4.9 Incident mode: when CI itself is broken or backed up

The loop above runs daily. This section is for **right now**: CI is broken or slow, PRs are stacking up, and a pipeline fix has to land fast. GitHub mechanics: `research/20260919_ci-pipeline-supporting/05-queue-emergency-mechanics.md`. Review: round 4 in `plan-review/`.

**The honest claim.**

- Today, "days" is possible: #1246 took 14 h and #1391 took 30.5 h, although the median CI PR merged in 51 minutes.
- With this section, the **fix** reaches `main` minutes after it is written (L3), and the **backlog** drains in about two queue cycles after that.
- End to end, that makes it an afternoon, not days. Only the speed seeds make the drain itself fast. The throughput floor is about 8.5 PRs/h at today's cycle time.

**Why "jump the fix to the top" is not enough.** Four things slow a CI fix today; a jump addresses only the first:

1. **Queue order.** A jump also needs admin, destroys up to 5 healthy groups, and still waits for the fix's own full suite (30-55 min).
2. **The fix's own PR checks must pass before it may enter the queue.** If they are the broken thing, it can't enqueue (#1246 was refused exactly this way).
3. **Runner starvation.** On 08-23 there were 23 open PRs while the queue never held more than 9. The jam was in the runner line, and GitHub has no runner priority (Team plan: 60 concurrent jobs).
4. **Admin bypass is blocked** by classic protection's `enforce_admins` until phase 0 retires it.

**Timeline target** (a systemic failure, 20 PRs armed):

| Step                             | Target                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------- |
| Onset → first group fails        | one suite (30-55 min today)                                                     |
| First ejection → RED             | one targeted canary (the failing job only, on `main` HEAD: 5-25 min) + one tick |
| RED → frozen and shed            | ≤ 2 min                                                                         |
| Fix written                      | agent or operator time                                                          |
| Fix → on `main` via L3           | ≤ 10 min                                                                        |
| On `main` → first held PR merged | one queue cycle                                                                 |
| → every held PR merged           | about two cycles                                                                |

**Levels of response:**

| Level | What                                                                                                          | Admin?      |
| ----- | ------------------------------------------------------------------------------------------------------------- | ----------- |
| L0    | Detect, freeze intake, shed load, stand the watchers down                                                     | no          |
| L1    | Quarantine a test that data has classified as flaky; re-run infra failures                                    | no          |
| L2    | Priority fix PR: exempt from the freeze and re-armed first; it is first in an emptied queue by construction   | no          |
| L3    | Break-glass: a mechanically bounded merge outside the queue, backed by a server-side detector and auto-revert | yes (local) |

Cut after review: **jump** (under RED the queue is empty, so it gains nothing; under AMBER it destroys healthy groups), **queue-setting edits as a lever** (effect on in-flight groups undocumented), a **post-merge full-suite dispatch** (the first released PR's queue build is the canary), and **2-5-all waves** (now 2, then all).

**L0: the sentinel.** `ci-steward sentinel` is deterministic and runs in two places:

- the local watchdog, every 5 min on the operator's machine;
- the `merge-tail.yml` tick in Actions. **Measured 2026-09-19:** its `*/10` cron is throttled by GitHub to a median gap of 162 min (p90 305, max 748; about 7 runs a day over 200 runs). So the Actions fallback cannot be trusted for anything faster than hours, which confirms this plan's doubt about it: the local DorkOS-scheduled owner is the primary, and the fallback only covers a machine that sleeps for a long time. Proposal 260919-204500 makes merge-tail event-driven.

It queries `check-runs` for the last hour itself (the daily snapshot is too stale). Every transition carries its observation timestamp and inputs. A transition older than the current state is a no-op. On a write conflict it re-evaluates rather than overwrites. **Destructive actions have one owner:** the local sentinel while its heartbeat is under 15 min old, the Actions tick otherwise. An asleep machine degrades to L0 + L1 plus L2 (no break-glass), and the plan says so.

`queue-state.json` is its own file on the data branch, separate from `latest.json`, and is mirrored to a local state file.

- **Signals and what each may open:**
  - **AMBER** (manufacturable, so it only stops new arming):
    - the same required job fails in 2+ groups;
    - the queue is non-empty and nothing has merged for 90 min;
    - armed-unmerged PRs exceed 2 h of throughput.
  - **RED** (only unmanufacturable signals):
    - a **targeted canary** is red on `main` HEAD;
    - **runner starvation** (≥ 10 jobs waiting > 10 min);
    - red `main`.

  The first failed-checks ejection of a required job dispatches the targeted canary for that job. That needs a `workflow_dispatch` leg, with a `job` input, in each required workflow. These five pipeline PRs are listed in 1b.

- **Hysteresis:**
  - RED → RECOVERING needs one of: the fix merged; a re-dispatched targeted canary passing (an outside outage that cleared); or 15 minutes with no starvation (a starvation RED).
  - RECOVERING → GREEN needs wave 1 merged.
  - Re-opening RED needs a fresh canary-red and a 30-min cooldown.
  - More than 3 REDs in 24 h holds AMBER and notifies the operator instead of cycling.
- **On RED, automatically:**
  - freeze: record every non-priority PR as held in `queue-state.json` (no labels: label events re-run `changelog-fragment-check`, which is required, and a job-level `if:` that skips posts a _skipped_ run that satisfies a required context); disable auto-merge; explicitly dequeue;
  - cancel every run on `gh-readonly-queue/main/*` refs, because GitHub does not document cancelling orphaned group runs and ours never cancel queue refs;
  - cancel the PR-level runs of held PRs and the `shed-first` advisory workflows;
  - tell everyone: a DorkOS push notification (on by default), the SessionStart line, and an incident record.
- **Guard for self-armed PRs.** A PreToolUse guard refuses `gh pr merge --auto` on a held PR while the state is RED. It reads the local state file only (no fetch), and fails **open** with a warning when that file is over 15 min old: arming into a broken queue costs an ejection, not data. `ci-steward arm` (4.10) and merge-tail also refuse held PRs, reading the same state.
- **Watchers.**
  - `watch-prs.sh` gains `HELD(incident)`, which **outranks** EJECTED and FAILING in `classify()`, because under RED a held PR is also ejected and failing, and those remedies ("re-arm", "push an empty commit") are exactly the load the freeze exists to stop.
  - Its remedy is "do nothing; the sentinel re-arms you".
  - It reads the local state file and backs off its polling during an incident. Twenty watchers at 60 s is about 2,400 API calls an hour.
- **Recovery.** The sentinel releases held PRs in two waves: 2, then all, oldest first. It re-arms them itself, so agents never re-arm 20 at once.

**L1: quarantine, classified from data.**

- A quarantine entry on the data branch is honoured **only** for a test the collector has classified flaky from data: it failed and then passed on the same merge-group SHA at least twice in 14 days, from the flake reporter and Playwright retries.
- Queue jobs and `ratchet-assert` ignore unclassified entries.
- During RED, an unclassified entry is allowed only for the job the canary showed red **and only when the canary's own retry passed** (so the failure is proven non-deterministic). A canary that is red on retry means `main` is broken: quarantine is refused and the lane is L2/L3. It expires when the breaker closes.
- Re-quarantining after expiry needs a ledger entry with a `ratchet-release`.
- Quarantine size (≤ 10) and days-in-quarantine are a ratchet from phase 1b.
- **Mechanism:**
  - Playwright quarantines per test (`grepInvert`).
  - Vitest can only quarantine per file (`exclude`). A quarantined shared file can empty a package's suite, so `assert-shard-union.sh` must know about quarantined files, or the lever ejects its own build.

**L2: the priority fix PR.** `/ci-incident fix <pr>` marks the PR priority in `queue-state.json` (no label), only if it carries a `kind: incident-fix` ledger entry and a pipeline-only diff, checked by `ci-steward arm`. The PR is exempt from the freeze and its PR checks are re-run first, which is possible now that shedding freed the runners. The sentinel arms it first. With the queue emptied, it is at the front by construction, with no jump and no admin. Today that is about 55-80 min (PR checks, including `credential-free-build`'s ~25 min serial leg, plus one queue build), and the speed seeds shrink it.

**L3: break-glass.** `/ci-break-glass <pr>` merges through the REST endpoint (`PUT .../pulls/{n}/merge`, squash). That is the **paved road**. A PreToolUse guard refuses bare admin merges, but every agent runs as the admin account and a script file walks past a guard. So the guard is a convenience, not the fence.

- **The fence is server-side, observed after the fact:**
  - The sentinel and collector detect any commit on `main` with no merge-queue provenance (a `MergedEvent` with no `AddedToMergeQueueEvent`).
  - An out-of-queue merge that doesn't meet the conditions below (no qualifying RED at the time, or a missing ledger entry) is **reverted automatically**.
  - The 2-per-24h counter is derived from `main`'s history, never from the writable data branch.
  - `bypass_mode` narrows from `always` to `pull_request`, which closes direct pushes.
- **Conditions:**
  1. RED from a targeted canary or starvation, and the diff touches the red job's gate.
  2. **Gates, never the judge.** Excluded:
     - `packages/ci-steward/**`
     - the `ci/` policy files
     - the assert scripts
     - test-runner configuration (`retries`, `testIgnore`, `grepInvert`, `passWithNoTests`, shard setup)
     - `claude-code-review.yml` and `REVIEW.md`
     - any product source

     There are two escapes for when the judge itself is what broke. **(a)** A pure revert of the last commit touching those paths; the inverse diff is generated mechanically and its equality checked. **(b)** An expiring `continue-on-error` allowlist entry (≤ 48 h) on the steward step, which the census already models.

  3. The verification set passes locally (≤ 5 min): actionlint on the changed workflows, the census, ledger-check, the atlas diff against `atlas.generated.json` (the PR-only coverage step never runs on a direct merge), and the tests and typecheck of the touched scripts and packages.
  4. A ledger entry exists with `kind: incident-fix`, `break-glass: true`, a hypothesis, and `field-changes` when the atlas diff shows one.
- **After the merge:** the first released PR's queue build must be fully green, or the break-glass commit is reverted automatically by its mechanically generated inverse. "Red on something the fix touched" is too fuzzy to be the rule.

**Credential fix (phase 0).**

- `MERGE_TAIL_TOKEN` is a `repo`-scoped PAT from the admin account (`merge-tail.yml:43,115`). It can very likely edit the ruleset, so the invariant "no admin credential in Actions" is false today.
- Replace it with a GitHub App (preferred: its own identity, so bot actions are distinguishable from agents on every timeline event) or a fine-grained PAT, with contents, pull-requests and actions write and **no Administration**.
- Phase 0's exit gate measures two things: a REST merge of a blocked PR with the new token is **refused**, and a merge group the new token enqueues **receives check runs** (the #581 class: groups created by `GITHUB_TOKEN` get no checks and jam the queue).

**Prevention and capacity.**

- A WIP cap: AMBER stops new arming; in GREEN, arming is allowed while armed-unmerged PRs < K = throughput × target lead time (about 8).
- The dedupe seeds cut jobs per PR, so the 60-job cap serves more PRs.
- Paid capacity (larger runners, third-party runners) is out: zero budget. Capacity comes from fewer jobs per PR and the shared cache.
- actionlint and the census at PR time catch a broken CI change before it reaches the queue.

**Incident SLOs:**

| SLO             | Definition                                                 | Objective                        |
| --------------- | ---------------------------------------------------------- | -------------------------------- |
| `detect-time`   | Onset (the first failed build of the systemic cause) → RED | ≤ one suite + 15 min             |
| `unblock-time`  | RED → first held PR merged                                 | p90 ≤ 60 min                     |
| `drain-time`    | RED → last held PR merged                                  | tracked; the speed seeds move it |
| `fix-lead-time` | priority PR from open to merged                            | ≤ 20 min after the speed seeds   |

Also tracked: break-glass count (from `main`'s history), out-of-queue merges that were auto-reverted, quarantine size, held-PR hours, and false REDs.

### 4.10 The PR author's side: one classifier, one arming path, a watcher that helps

Evidence: `research/20260919_ci-pipeline-supporting/08-pr-skill-review.md`.

The `creating-pull-requests` skill and `watch-prs.sh` are how every agent experiences CI, and today they are partly wrong and partly harmful at scale:

- **Stale advice.**
  - The skill still describes the pre-queue "up to date" rule and recommends `gh pr update-branch`, which now just re-runs 19-25 jobs per PR.
  - It lists 4 required checks; there are 9.
  - The command it gives for checking required checks reads only classic protection.
- **Harmful remedies.**
  - FAILING says "push an empty commit". Twenty agents doing that is about 400-500 jobs against a 60-job pool, and it makes every flaky ejection look like a real catch in the metrics.
  - For EJECTED on failed checks, 85% re-pass with no change, so the right first response is to wait for the re-queue. A failure counts as real only on the second ejection by the same job with no change in between.
  - `UNARMED_CLEAN` tells agents to merge directly without reading labels, which would bypass `hold`, held state and the WIP cap.
- **Broken states.**
  - `STALLED_IN_QUEUE` can never fire, because `gh pr checks` does not return queue runs.
  - The watcher and merge-tail disagree on cancelled checks, outdated threads, drafts and holds.
  - A watcher whose `gh` calls fail goes silent.

**Design:**

- **One per-PR classifier** in `packages/ci-steward` (node built-ins only, runnable from a fresh worktree, inside the fence) is the single source of truth for "what state is this PR in, and who acts". `watch-prs.sh` becomes a thin wrapper around it. `should-arm-automerge.sh`'s decision and the sentinel both call it. The skill's state table is generated from it. A fixture test forces the watcher and merge-tail to agree on every case.
- **Every state names who acts** (the agent, the sentinel, nobody yet) and gives exact remedy text and an exit code. The report proposes 28 states. The key additions:
  - `HELD(incident)`, top precedence;
  - `WAITING_FOR_SLOT` (the WIP cap);
  - `PRIORITY`;
  - `REVIEW_RED(open findings: ids)`, with the remedy "fix or rebut each id; a new commit alone does nothing";
  - `RATCHET_ADVISORY` / `RATCHET_RED`, with the remedy `/ci-record --release`;
  - `HANDED_OFF`: queued and green, so stop watching. This saves agent turns and API budget.
- **One arming path.**
  - Agents call `ci-steward arm <pr>`, which applies the WIP cap, holds and the freeze, and then arms.
  - A PreToolUse guard refuses raw `gh pr merge --auto` and `--admin`. That guard is the paved road, not the fence.
  - PRs still running their checks don't count against the WIP cap: a PR takes a slot only once its checks are green. That resolves the clash between the cap and arming at creation.
- **Held and priority are sentinel-owned state in `queue-state.json`, never labels.** A label would re-run the required `changelog-fragment-check` on every held PR, and a skipped label-triggered run can satisfy a required context. The classifier reads the state file; nothing else can set it.
- **Watching costs budget.** The watcher backs off with PR age and during incidents. It stops at `HANDED_OFF`. All watchers share one API budget, so the classifier batches queries per repo, not per PR.
- **Skill updates by phase:**
  - **Phase 0:** remove the pre-queue advice; the correct required list, generated from `ci/required-checks.json`; a ledger step for pipeline PRs (`/ci-record`).
  - **Phase 1:** `/ci-status` as the first stop; push-timeout guidance (bounded pre-push, and what to do after a killed push).
  - **Phase 1b:** held, priority and slot states.
  - **Phase 2:** review-gate states; ratchet states; forks are adopted onto a same-repo branch.

## 5. The AI review gate and governance (fully autonomous merges)

ADR: **"Merges are fully autonomous; machine gates are the only gates."** Evidence for this section:

- `07-claude-review-effectiveness.md`: our own review, measured.
- `06-ai-review-options.md`: every alternative, including Copilot.

Both are in `research/20260919_ci-pipeline-supporting/`.

### 5.1 What the measurements say

- **Our Claude review is precise but toothless.**
  - 9.7% of first reviews raise at least one Important finding.
  - In a sample of 26 findings, 24 were real defects: about 92% precision.
  - Only 42% of Important findings were fixed before merge. 43% merged untouched, and none of those threads got a reply.
  - On PRs already armed for auto-merge, the fix rate falls to 31%. Of the sampled findings, 14 real defects are on `main` now (e.g. #1893, lost font weight on every assistant message; #1779, a scheduler lock that can deadlock).
  - Making the existing review **blocking** is the largest single quality gain available.
- **Coverage leaks.**
  - Only 64% of merged PRs were reviewed on their final commit.
  - 3% lost the review to a label race: the `opened` run is cancelled while queued, and the label runs skip.
  - 9% of started runs die on the 50-turn cap.
  - Dependabot PRs always fail.
- **Its misses are not reviewer misses.** Of 12 traced escapes, the review saw the defective code in 10 and flagged 1. Most were layout, CSS, Electron timing or wrong assumptions about outside tools. No diff reviewer from any vendor catches those well. They are a testing gap (visual and runtime checks), recorded as a seeded experiment, not a reason to change reviewers.
- **The pre-PR adversarial review doesn't lower the CI review's hit rate** (10.3% on PRs that mention one vs 8.8% on PRs that don't). Both layers stay. The per-task review count in the `/flow` pre-PR loop is a candidate to trim later, measured by the same catch data.

### 5.2 Decision: keep Claude, on the existing subscription, as the only gate

**Operator constraint (2026-09-19): zero budget.** DorkOS is open source with no revenue.

- No Anthropic API key.
- Copilot is a hard no if it could cost more than $100 a month, and the cap must be a guarantee.

Evidence for the options: reports 06 and 09 in `research/20260919_ci-pipeline-supporting/`.

| Option                                                          | Can it block?                                                                                     | Cost for ~780 PRs a month                                                                                                                                                                                                                                           | Verdict                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Our Claude review on the operator's subscription, made blocking | yes, through our own `review-gate`                                                                | $0 extra, but it draws on the same 5-hour and weekly limits as the operator's agents                                                                                                                                                                                | **the gate**                                                                     |
| Copilot code review                                             | no (COMMENT reviews; its check means "ran", not "found something")                                | $39-780 a month even once per PR on Lite. A hard org cap exists ("Stop usage when budget limit is reached", off by default), but at $100 it runs out mid-month and has reported overshoot. It bills the PR author's personal plan, which is untested for org repos. | **no**: can't gate, can't cover the volume under the cap                         |
| CodeRabbit (free for public repos)                              | only through a parsable review; when rate-limited it posts **success** with "Review rate limited" | $0, but 1-10 reviews per developer per hour, and every PR here has the same author                                                                                                                                                                                  | deferred; a zero-cost second opinion only if the Claude gate proves insufficient |
| Anthropic managed review, API key, Bugbot, Greptile             | varies                                                                                            | all paid; we qualify for no open-source program (9 stars)                                                                                                                                                                                                           | no                                                                               |
| PR-Agent (MIT) plus a free model tier                           | parsable                                                                                          | $0 in money; free tiers are small (OpenRouter free: 1,000 requests a day after a one-time $10) and Gemini's free tier trains on the input                                                                                                                           | deferred; same condition as CodeRabbit                                           |

**Why this is enough for now.** The measured problem is not the reviewer: it finds real defects with about 92% precision. The problem is that 58% of its real findings merge unfixed because the check can't block. Making it block fixes that at no cost. A second opinion from a different model family is still valuable in principle, but no zero-cost option can cover our volume reliably. It is recorded as a `proposed` ledger experiment that runs only if the blocking gate's escape data shows a class a second reviewer would catch.

**Operator option (free, not required):** the Claude for Open Source program grants 6 months of Max 20x. The repo doesn't qualify on stars, but a maintainer with 100+ merged PRs in other repositories might. Applying would widen the subscription limits the gate draws on.

### 5.3 The gate, re-designed

- **We own the required check.** A new always-running job, `review-gate`, is the required context. The reviewer jobs never are. This removes both skip hazards:
  - a skipped reviewer job, from a label event or the label race, can never satisfy the requirement;
  - a fork PR can't pass by being skipped: `review-gate` runs and fails with the reason `fork`.

  On `merge_group`, `review-gate` is a named pass-through, consistent with ADR 260728-112203: a PR can't enter the queue until `review-gate` is green on its head, and nothing can change its diff after that.

- **Red on an open Important finding.**
  - Findings are recorded per PR with stable ids and **carry across commits** until they are closed.
  - A finding closes only by explicit re-review marking, resolved or retracted by id with a reason. There is no line-mapping heuristic.
  - A trivial new commit does nothing to an open finding, which closes the "push an empty commit to re-roll" hole.
  - Same-SHA re-reviews may not flip red to green except by retraction (`verdict-flips-same-sha` is tracked).
- **Review budget, not re-review on every push.** The subscription is shared with the agents that write the code, so review volume is a budget to protect, not multiply. Today there are ~780 reviews a month with zero usage-limit failures in 30 days.
  - One full review when the PR opens, in parallel with CI (as today).
  - A re-review happens only when (a) the author asks for one after addressing open findings, through `ci-steward` rather than a label. The request must either touch an open finding's file or carry a written rebuttal. A resolution must cite the resolving hunk. There are at most 3 requests per finding. The prompt gets the open findings plus the delta, never the prior verdict's prose, so variance can't be farmed by cosmetic pushes; or (b) the diff since the last reviewed SHA changes more than a threshold of non-rebase lines. It is scoped to that diff plus the open findings.
  - A rebase-only push keeps the verdict. "Rebase-only" means the multiset of +/- lines of the three-dot diff (`merge-base..head`) is unchanged after whitespace normalization. Per-commit `git patch-id` is the wrong unit: it mishandles merges from `main` and counts context lines. Conflict resolutions and merges therefore count as changes when they alter the PR's own lines, and are free otherwise. There are fixtures for plain rebase, merge-from-main, conflict resolution and whitespace-only changes.
  - A force-push that changes content triggers a scoped review of the changed hunks.
  - `reviews-per-merged-PR` and `review-minutes` join the tracked metrics. Objective: at most 1.5 reviews per merged PR.
- **Reliability fixes, from the measurements:**
  - Fix the label race: dedupe by head SHA instead of cancelling queued runs.
  - Raise and scale the turn budget. The median run uses 32.5 turns and the p90 run 49, against a cap of 50.
  - Fix Dependabot by adding the bot to the action's allowed-actors list.
- **Fail closed, heal on a cadence.**
  - A missing or red gate never merges.
  - The sentinel's tick re-dispatches infra-classified failures, backing off 10, 20, 40 minutes up to 2 hours, with a per-PR ceiling.
  - Measured by `review-completes` and `review-recovery`.
- **Credentials: the operator's subscription OAuth token stays** (operator decision; no API key). Using it in Actions is documented and supported. Its limits are shared with the agents.
- **When the subscription limit is hit** (classified from the error: "session limit" or "weekly limit"):
  - **Session limit (5-hour window):** fail closed. The PR's state becomes `REVIEW_WAITING_LIMIT` with the reset time, the watcher's remedy is "do nothing; the review retries at HH:MM", and the sentinel re-dispatches right after the reset. This costs little: the same limit usually pauses the agents that produce PRs, so the stall and the PR supply are correlated.
  - **Weekly limit:** fail closed for 6 hours, then enter **review-debt mode** so the project doesn't stop for days. Merges proceed. Each PR merged in debt is recorded on the data branch and reviewed after the merge, as soon as the limit resets. Every Important finding from a debt review becomes an ordinary fix PR with a ledger entry. The sentinel reports debt mode as AMBER, and `review-debt-prs` is tracked. This is weaker than a pre-merge gate, but stronger than today, where 58% of findings are ignored.
  - **Classification comes from the structured error the action or SDK returns, never from model or log prose**, because an injected diff could print "You've hit your weekly limit". An unknown error fails closed.
  - **Excluded from debt merges** (they wait for a real review):
    - any PR touching coverage-check paths (pipeline, steward, judge);
    - any PR carrying a `ratchet-release`, `floor-release` or `field-changes` entry;
    - Dependabot PRs.
  - **A debt ceiling** of 30 PRs per window: beyond it, fail closed and notify. Large PRs are not excluded (41% are XL); the post-merge review order is XL first.
  - Debt findings become ordinary fix PRs with ledger entries, not priority PRs.
  - The wait is reset-aware: the reset time from the error decides the wait, and 6 hours is only the default when none is given.
  - Two debt windows in 28 days is a collector health breach, so a gate that is off for most of every heavy week becomes visible.
- **If the subscription token stops working for more than 48 hours** (revoked, or the OAuth pattern enforced against "without notice", per report 09):
  - Debt mode must not quietly become the steady state. The sentinel escalates to RED-level notification.
  - Debt mode's ceiling holds.
  - CodeRabbit (free for public repos) is wired but switched off in advance as the fallback reviewer input, so the gate can read its review state. A rate-limited CodeRabbit reports `success` with "Review rate limited"; the gate treats that as **not reviewed**, never as a pass.
  - The operator is told the gate is degraded and why.
- **Hardening.** Two 2026 incidents (Clinejection, Comment and Control) exploited `claude-code-action` with Bash enabled on public repos. So:
  - the reviewer loses `Bash` (`Read`, `Grep`, `Glob` and a read-only `gh` helper only);
  - the model job holds no write token, and a separate job posts the results;
  - PR titles and bodies go in as quoted data, never as instructions;
  - `pull_request` only, never `pull_request_target`.
- **`skip-review` is retired:** with `review-gate` always running, a skip label would re-open the skip hole.
- **The read-only `gh` helper** (`review-gh.sh`, today reached through Bash) becomes an MCP tool, so removing Bash keeps PR metadata.
- **`review-red-rate` tripwire,** re-based on the measurement: under **4%** of first reviews with an Important finding over 2 non-overlapping weeks is a health breach. The baseline is 9.7%, so the old 10% line would have fired constantly.
- **`ratchet-release` and `field-changes` entries are blocking by default** unless the reason is specific.

### 5.4 Other governance

- **Retire classic branch protection** (move `db-check` into the ruleset) and **protect the data branch** (a ruleset with `non_fast_forward` and `deletion` only).
- **Align the `/flow` config and docs:** autonomy on is the intent.
- **One arming authority.** Every actor that arms or re-runs goes through `ci-steward arm` (4.10), so the WIP cap, held state and the freeze bind them all. That covers agents, merge-tail, the flow plugin's recovery ladder, `/app:upgrade` and `claude.yml`.

**Operator actions** (access and accounts only; no spend):

1. Confirm the ruleset edits. The orchestrator can apply them with the operator's `gh` admin session.
2. Optionally apply to Claude for Open Source.

## 6. Rollout

Each phase is one or two PRs, and each phase records itself in the ledger. A phase starts only when the previous exit gate passes.

Tracked in Linear: project "CI Steward" (https://linear.app/dorkspace/project/ci-steward-6b7f91e53865), umbrella DOR-2147, one issue per phase (column below).

| Phase                 | Linear   | Delivers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Exit gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Foundation**     | DOR-2148 | creating-pull-requests skill de-staled (required list generated from `ci/required-checks.json`, pre-queue advice removed, ledger step); `MERGE_TAIL_TOKEN` replaced by the GitHub App `dorkos-merge-tail` (no Administration) (exit gate: a REST merge of a blocked PR with it is refused); ruleset `bypass_mode` narrowed to `pull_request`; the guard on bare `--admin` merges; classic branch protection retired (`db-check` moved into the ruleset) and the `ci-steward-data` ruleset created (admin actions, before phase 1's reconcile can be healthy); `ci/` hand files, `gates.yaml` for every current gate, `packages/ci-steward` with `census` and `ledger-check` as `typecheck.yml` steps, the rule file, `contributing/ci.md`, AGENTS.md pointer, ADRs (autonomous merges; pipeline changes carry hypotheses), 3 backfilled fixture entries, seeded `proposed` entries | census proven to fail on each planted drift (missing gate, `paths:` on a required workflow, missing timeout, `continue-on-error`)                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **1. Observe**        | DOR-2149 | `collect`, `verdicts`, `triage`, the daily HTML report + index, the Monday deep summary (`report`), daily workflow (a GitHub Actions cron), data branch with its safeguards (weekly backup tag `ci-steward-data/YYYY-Www` under ruleset 23705388, the collector refuses to recreate a missing branch, the daily health check verifies the branch and rulesets 23704437 and 23705388, cleanup sweeps skip it), local wrapper and the `ci-local-export` DorkOS scheduled skill (approved by the operator at Full autonomy), SessionStart line, `/ci-status`, `/ci-pulse`                                                                                                                                                                                                                                                                                                             | 3 consecutive healthy daily snapshots; a planted truncation turns the run red; fixture verdicts pinned to recorded data. The "#1391 held, #1135 partial, #1246 failed" expectation was eyeballed from the incidents; the computed verdicts are authoritative, and they are partial, partial, partial (§4.4). The adversarial review (Plumb, 2026-09-19) recomputed all three by hand and agreed, and agreed that the live collector will publish #1135 and #1246 as `inconclusive`, because each is confounded by the next change to the same gate |
| **1b. Incident mode** | DOR-2150 | the per-PR classifier in `packages/ci-steward` with `watch-prs.sh` as a thin wrapper and merge-tail calling it; `ci-steward arm` + guard + WIP cap (green PRs only) + `HANDED_OFF`; targeted-canary `workflow_dispatch` legs in the five required workflows (five ledgered PRs); sentinel (local owner + Actions fallback) detect-only; `queue-state.json`; `watch-prs.sh` HELD event with top precedence; quarantine classified from data (+ `assert-shard-union.sh` awareness); `/ci-incident`; `/ci-break-glass`; out-of-queue merge detector + auto-revert; after one week detect-only with no false RED, automatic freeze and shed switch on                                                                                                                                                                                                                                  | watcher fixtures agree with merge-tail on every case, and the no-empty-commit / wait-on-first-ejection remedies are pinned; replayed 08-23 and W36 timelines: RED only from canary or starvation, never from stall alone, at most N REDs in W36; a planted systemic failure opens RED in a dry run; one break-glass rehearsal on a no-op pipeline PR; a planted unsanctioned out-of-queue merge is auto-reverted in a sandbox fixture                                                                                                              |
| **2. Enforce**        | DOR-2151 | (only after 1b is live, because these gates add new ways to stall the queue) ratchet assertions plus the PR advisory, the `review-gate` job and the review-gate watcher states (`REVIEW_RED`, ratchet states), section 5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | every pipeline PR that week has an entry; a planted per-package drop fails in fixtures; review red-on-important proven on a fixture PR                                                                                                                                                                                                                                                                                                                                                                                                             |
| **3. Improve**        | DOR-2152 | `/ci-improve` (a skill), `ci-improve-tick` (a DorkOS scheduled skill, `enabled: false` until the L4 gate, then approved by the operator at Full autonomy), the fence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | the L4 gate in 4.7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **4. Speed program**  | DOR-2153 | the loop works the constraint through the seeded experiments, read off the daily report and its triggers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | SLOs trend to objective                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **5. Plugin**         | DOR-2154 | move `packages/ci-steward`, the skills (entry points and scheduled skills) to `dork-labs/marketplace/plugins/ci-steward/`; `/ci-init` scaffolds the `ci/` files, rule, guide, workflow and typecheck steps, version-stamped like `@dorkos/operating-skills`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | installs and runs in the `marketplace` repo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Seeded `proposed` experiments**, in constraint order:

1. Quarantine lane for flaky browser specs (shards 1 and 2 first).
2. `credential-free-build` stops re-running unit suites, keeping build, typecheck and boot.
3. Turbo remote cache via **Vercel Remote Cache**, free on all plans since Dec 2024 under fair use, with no Vercel hosting required (the site already deploys there). The fallback, an Actions-cache-backed cache, is not viable until seed 8 frees the full 10 GB pool.
4. Browser suite to 6 shards.
5. Affected-only PR typecheck and lint, and one prettier check.
6. Pre-push bounded to ~2 min.
7. Typecheck out of pre-commit.
8. Cache-scope fix for Windows pnpm and Playwright.
9. The six CI-only checks added to `pnpm verify`.
10. Retire push-main legs that re-test the queue's tree.
11. Homebrew token, and a release-publishing token that triggers the cask.
12. The review gate made blocking (5.3). This is the largest measured quality gain: 58% of real Important findings merged unfixed.
13. A zero-cost second-opinion reviewer (CodeRabbit or PR-Agent), only if the escape data shows a class a second model family would catch (5.2).
14. Visual and runtime checks for the escape classes the review can't see: layout, CSS, Electron timing.

## 7. What we deliberately do not do

- **No dashboard product, no observability vendor.** The data branch plus `/ci-status` is the dashboard. Metric ids follow OpenTelemetry CI/CD naming where one exists.
- **No LLM in measurement or judgment.** Verdicts, floors, ratchets and the report are code. The LLM proposes and implements, through the same review as every change.
- **No auto-revert on a `failed` verdict.** It leads the report, and the next improvement run decides with the numbers in front of it. The one exception is §4.9: unsanctioned or red break-glass commits are reverted automatically.
- **No team surveys** (SPACE, DX Core 4). There is one human.
- **No live fire drills in the queue.** Fixtures prove the gates can fail.

## 8. The system's own hypothesis

Ledger entry for CI Steward itself, verdict computed 4 weeks after phase 2 exits:

- 100% of pipeline-touching PRs have a ledger entry.
- 100% of entries past their window have a computed verdict. The `inconclusive` share is reported and expected to be high at first.
- Zero days with a missing or unhealthy snapshot.
- At least two SLOs moved from their floor toward their objective.
- **Cost:** under 15 runner-minutes a day for the collector, and zero queue builds (the system opens no PRs of its own).

If it misses, the report says so, and the next proposal simplifies the system rather than growing it.

## 9. Resolved questions

| Question              | Answer                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cadence               | Daily deterministic collection, triage and HTML report to the data branch; the Markdown report is the Monday deep summary. SLO windows stay 7 days. No PR, ever. |
| Location              | `ci/` on `main` for intent, `ci-steward-data` for observations. The guide is `contributing/ci.md`.                                                               |
| New required context? | No. Census and ledger checks are steps in `typecheck.yml`. Coverage blocks from day one (the trial week was dropped on 2026-09-19).                              |
| Engine seam           | `packages/ci-steward`, with a tested dependency budget; `/ci-init` scaffolds what a plugin cannot install.                                                       |
| Objectives            | Amended per the review. Every objective names its path. `flake` is split. `escaped` is tracked, not scored. `main-green` is ≤ 1 per 28 days.                     |

## Follow-ups from round 5 (non-blocking, carried into the phase PRs)

1. **Starvation and L3.** Starvation-RED has no red job, so an L3 diff under starvation may touch only the triggers, concurrency or `shed-first` membership of non-required workflows.
2. **Auto-revert when the machine sleeps.** If the local sentinel has not reverted an unsanctioned merge within 15 minutes, the Actions tick opens the mechanical revert as a priority PR and notifies.
3. **Break-glass exclusions** also cover everything §4.7 fences: `merge-tail.yml`, `should-arm-automerge.sh`, `.claude/rules/ci-pipeline.md`, `contributing/ci.md`.
4. **Canary legs are more than a trigger.** Each needs merge-group-only steps skipped (`assert-shard-union` for a single shard) and census allowlist entries for the new step-level `if:`s. `main-green` must exclude `workflow_dispatch` runs.
5. **Deterministic ejections** (ratchet, census, ledger) are never re-armed without a new commit.
6. **Per-PR states go to the data branch,** so the report measures how often agents hit each state and for how long.
7. **Coverage paths** include `.agents/skills/creating-pull-requests/**`.
8. **Codex agents have no PreToolUse hooks.** The WIP cap binds them only through merge-tail and the classifier's advice; say so in the skill.

## Follow-ups from round 7 (non-blocking)

1. Pin the reviewer's model, Sonnet by default, so the review draws less of the shared limit. Escalate only XL PRs.
2. Measure how often review-limit stalls coincide with PR supply, using the `harness` field of `agent:provenance`. Codex and OpenCode PRs keep arriving while a Claude limit stalls the review.
3. Exclude limit stalls from `review-completes` so the SLO measures infrastructure, not the quota.

## Review log

- **Round 1 (Vesper):** 26 findings, 4 blockers:
  - the census would not run on most PRs;
  - the review fix would bind only merge-tail-armed PRs, 17% of the total;
  - verdicts were LLM opinions that merged themselves;
  - ratchets could not be measured as written.

  All four were accepted.

- **Round 2 (orchestrator):** proposed the `main` / data-branch split (no system PRs), red-on-important review, gate-level hypotheses and START/END local timing. Pushed back that a required review as proposed would only certify "a review ran".
- **Round 2 (Vesper):** accepted the split and withdrew findings 8, 9, 10 and 16. It then:
  - disagreed with fail-closed after one retry, because usage-limit failures are correlated;
  - added the same-SHA re-roll rule, the red-rate tripwire, per-package ratchets with scoped releases, the ledger status split, a data-branch ruleset and `check-runs` API pacing;
  - extended the census (`continue-on-error`, step `if:`, field changes) and the fence.

  All 12 conditions are written into v2 above. Item 12 (Playwright retries on in CI) was verified already true.

- **Round 3 (Vesper): SIGNED**, with 19 non-blocking follow-ups. The five marked "fix before landing" are applied above:
  - A: fence `typecheck.yml` and `lefthook.yml` by content, not path;
  - B: `inconclusive` is evaluated before `failed`;
  - C: the constraint is ranked against objectives, with `local-commit` and `headroom` placed;
  - D: classic protection retirement and the data-branch ruleset moved to phase 0;
  - F: the coverage flip is the allowlist expiry. (Superseded 2026-09-19: coverage blocks from day one, with no flip.)

## Follow-ups carried into the phase PRs (from round 3)

- **Phase 0:**
  - G: phase-0 baselines are hand-copied with `baseline_source:`; `/ci-record` refuses to run without `latest.json`.
  - J: rules don't project to Codex, so the 20-line protocol also lives in the skill; AGENTS.md keeps a pointer plus two must-know sentences (hypothesis required; releases block by default).
  - K: the coverage step gets the fragment check's "determine the base" step (`typecheck.yml` checks out at depth 1).
  - M: the deadlock invariant also requires `pull_request.types`, if present, to include `synchronize`.
  - Q: `contributing/ci.md` documents "ledger release first, ruleset edit second".
- **Phase 1:**
  - E: queue shards upload `vitest-shard-report-N` artifacts, and the fan-in downloads them. _Phase 1: the upload is done (queue leg, `continue-on-error` allowlisted, the collector samples it for flaky-test-runs); the fan-in download moves to phase 2 with `ratchet-assert`, its only reader, because a download nothing reads only adds a way for the required `test` job to fail._
  - H: the PR advisory reports the required-path minutes a PR adds (gate budget). _Moved to phase 2, with the ratchet advisory it shares a comment with._
  - I: `floor-release` ledger field. _Done in phase 1._
  - O: both data-branch writers fetch, rebase and retry. _Done in phase 1 (`publish` in `packages/ci-steward/src/data-branch.ts`)._
  - P: the time-wrap is POSIX shell, not node. _Done in phase 1 (`packages/ci-steward/bin/time-wrap.sh`, sourced, tested under dash, bash and ksh)._
- **Phase 2:**
  - L: fork PRs fail in a deterministic first step classified `fork`, never `infra`; `pull_request` only, never `pull_request_target`.
  - N: a force-push, or a non-ancestor base, triggers a full review.
  - R: release age is checked at queue time; `/ci-record --release` can re-stamp an entry.
  - S: wording fixes.
- **Round 4 (Vesper), incident mode:** rebuilt the timeline. The claim became "the fix lands in minutes; the backlog drains in about two cycles". It also required:
  - a server-side fence;
  - break-glass may change gates, never the judge;
  - RED only from signals an agent can't manufacture;
  - quarantine classified from data;
  - cutting jump, ruleset edits and the post-merge dispatch.

  All eight conditions were applied.

- **Round 5 (Vesper), incident v2 + AI review gate + PR author's side:** seven blockers:
  - label-based freeze;
  - RED that could not close without a merge;
  - the Copilot trial blocking arming;
  - understated cost;
  - the #581 exit gate;
  - §4.10 pieces placed in no phase;
  - the RED quarantine exception.

  All seven were fixed.

- **Round 6 (Vesper): SIGNED v3.** The one wording fix (cost range in the options table and the operator action) is applied.
- **Round 7 (Vesper), zero-budget constraint:** the operator ruled out an API key and any Copilot cost that could exceed $100 a month. Vesper found five blockers:
  - debt-mode classification and exclusions;
  - re-review variance farming;
  - the patch-id unit;
  - token loss as a single point of failure;
  - paid infrastructure still in the plan.

  All five were fixed.

- **Round 8 (Vesper): SIGNED v4.** The one wording fix (debt findings become ordinary fix PRs) is applied.
