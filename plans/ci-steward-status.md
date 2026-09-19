# CI Steward: status and handoff

**As of 2026-09-19, phase 0 in review.** Read this first after a context compaction or in a new session. It holds everything that otherwise lives only in the conversation.

## 1. Where things stand

- **Research and plan: done.** `plans/ci-steward-plan.md` v4 was signed by the adversarial reviewer (Vesper, on Fable) after 8 rounds, and merged in #1927.
- **Phase 0: built and in review** on branch `ci-steward-phase0` (Linear DOR-2148). It holds:
  - `packages/ci-steward` (`census`, `ledger-check`, `ledger-new`; root aliases `pnpm ci:census`, `pnpm ci:ledger-check`, `pnpm ci:ledger-new`) and the `ci/` hand files;
  - three steps in the required `typecheck` job (census, ledger validity, ledger coverage);
  - 3 backfilled fixture entries (#1135, #1246, #1391), the 14 seeded proposals and the phase-0 hygiene entry in `ci/ledger/`;
  - measured `timeout-minutes` on every job that had none;
  - `contributing/ci.md`, `.claude/rules/ci-pipeline.md`, the `stewarding-ci-pipeline` skill, the de-staled `creating-pull-requests` skill and watcher, the merge guard hook, and two ADRs.
  - An adversarial review (Rivet) ran; its findings are fixed on the branch.
- **Phase 1 onward: not started.**

## 2. Tracking

- Linear project "CI Steward": https://linear.app/dorkspace/project/ci-steward-6b7f91e53865
- Umbrella DOR-2147. Phases: DOR-2148 (0), DOR-2149 (1), DOR-2150 (1b), DOR-2151 (2), DOR-2152 (3), DOR-2153 (4), DOR-2154 (5).
- The 14 real defects the Claude review found on `main`: filed as DOR-2130 to DOR-2142.
- GitHub and npm information issues: DOR-2143 to DOR-2145. Commands-to-skills migration: DOR-2146.

## 3. GitHub changes applied (2026-09-19, operator-approved)

- **Ruleset 19893973** ("main: merge queue"): bypass narrowed from `always` to `pull_request`; `db-check` added as a required context; `deletion` and `non_fast_forward` added; all nine required contexts pinned to the GitHub Actions app (integration 15368). The list is `ci/required-checks.json`.
- **Classic branch protection on `main`: deleted.** The ruleset is the only source of required checks.
- **Ruleset 23704437** keeps `ci-steward-data` append-only (no deletion, no force-push).
- **Ruleset 23705388** makes tags matching `ci-steward-data/**` permanent (the weekly backup tags).
- **GitHub App `dorkos-merge-tail`** (app id 5003041) replaces the admin PAT `MERGE_TAIL_TOKEN` in `merge-tail.yml` and `dependabot-lockfile-repair.yml`. Permissions: `contents` and `pull_requests` write; `checks`, `statuses` and `metadata` read; no Administration, no actions. Secrets: `MERGE_TAIL_APP_CLIENT_ID` (a secret rather than a variable because secrets are proven to reach Dependabot's `pull_request_target` runs) and `MERGE_TAIL_APP_PRIVATE_KEY`. The old `MERGE_TAIL_TOKEN` secret is deleted right after the phase-0 PR merges.

## 4. Operator decisions (binding)

From the research phase:

1. **Merges stay fully autonomous.** No human approval before merge, ever. Quality has to come from machine gates.
2. **Tracking and monitoring come first**, before speed work.
3. **Targets:** CI "much faster and much higher quality than average" (elite, not average).
4. **The system:** self-testing, self-monitoring, self-improving. Docs are written for agents first. It ships as a skill that can later become a marketplace plugin.
5. **Zero budget.** No Anthropic API key for the AI review (it keeps running on the operator's Claude subscription token); Copilot review is a hard no if it could cost more than $100 a month; no paid infrastructure.
6. **The adversarial reviewer** is a resumable Fable agent, an explicit exception to the standing "subagents Sonnet/Opus, never Fable" rule.
7. **Style:** short, plain answers, 2 options at most with a recommendation; decide autonomously except for spend, access or irreversible actions.

Added during phase 0 (2026-09-19):

8. **Everything takes effect as soon as possible.** Ledger coverage blocks from day one; the 7-day warn-only trial was dropped.
9. **Skills, not commands.** `.claude/commands` is legacy. User entry points are skills in `.agents/skills/` with `disable-model-invocation: true`, named with a hyphen: `/ci-status`, `/ci-pulse`, `/ci-record`, `/ci-improve`, `/ci-incident`, `/ci-break-glass`. Each wraps a `pnpm ci:<verb>` engine command. Never plan `.claude/commands/ci/`.
10. **`ci-improve-tick` and `ci-local-export` are DorkOS scheduled skills** (a `schedule:` block in the skill's frontmatter, `docs/guides/task-scheduler.mdx`), never GitHub crons. Each parks as "Waiting for approval" until the operator approves it on the Schedules page, at Full autonomy, because it runs Bash and agent-proposed schedules are clamped (DOR-2100). `ci-improve-tick` starts at `enabled: false` until the L4 gate. The daily collector stays a GitHub Actions cron: it is machine-only and must run while the laptop sleeps.
11. **Data-branch safeguards** (plan §4.4): permanent backup tags under ruleset 23705388, a weekly `ci-steward-data/YYYY-Www` tag from phase 1, a collector that refuses to recreate a missing branch (it alerts; restore from the newest tag), a daily health check of the branch and both rulesets, and branch-cleanup sweeps that skip `ci-steward-data`.

## 5. Waiting on the operator

- Delete the old `MERGE_TAIL_TOKEN` secret right after the phase-0 PR merges.
- Phase 0's two token exit gates: a REST merge of a blocked PR with the app token is refused, and a merge group the app token enqueues receives check runs.
- Optional, free: apply to Anthropic's Claude for Open Source program.

## 6. Next steps

- Land phase 0 (DOR-2148) through the merge queue.
- Then phase 1 (DOR-2149), per `plans/ci-steward-plan.md` §6: `collect`, `verdicts`, `report`, the daily workflow, the data branch and its safeguards, the local wrapper and `ci-local-export`, the SessionStart line, `/ci-status` and `/ci-pulse`.
- Follow-ups to carry into the phase PRs: the plan's lists "Follow-ups carried into the phase PRs (from round 3)", "Follow-ups from round 5" and "Follow-ups from round 7".

## 7. The design in ten lines

1. **Intent on `main`, observations on a data branch.** Hand files are `ci/` plus `ci/ledger/`. Machine output goes to the orphan branch `ci-steward-data`. The system opens no PRs of its own.
2. **Engine:** `packages/ci-steward` (node built-ins, `zod`, `yaml`, and `gh` through `child_process`).
3. **Checks without new required contexts:** the census (docs can't drift, deadlock invariant) and the ledger checks run as steps in `typecheck.yml`.
4. **Deterministic judging:** verdicts, SLO floors and the constraint ranking are computed by code, never by an LLM.
5. **Ratchets:** per-package high-water marks, asserted in the queue.
6. **The fence:** `/ci-improve` may change gates, never the steward or the judge.
7. **Incident mode (§4.9):**
   - a sentinel (local owner plus an Actions fallback);
   - RED only on a targeted canary, runner starvation or a red `main`;
   - held and priority state in `queue-state.json`, **never labels**;
   - quarantine only for tests classified flaky from data;
   - break-glass merges through the REST endpoint, fenced by server-side detection and auto-revert.
8. **The PR author's side (§4.10):** one per-PR classifier, one arming path (`ci-steward arm`), the WIP cap, `HANDED_OFF`, and no "push an empty commit".
9. **The AI review gate (§5):**
   - an always-running `review-gate` job that we own; findings carry across commits;
   - a review budget (≤ 1.5 reviews per merged PR);
   - session limit: fail closed; weekly limit: 6 h, then capped review-debt mode;
   - the reviewer loses Bash.
10. **Speed seeds**, including Vercel Remote Cache (free since Dec 2024).

## 8. Facts verified during the work (don't re-derive)

- **Ruleset 19893973:**
  - SQUASH, ALLGREEN, `max_entries_to_build` 5, `max_entries_to_merge` 5, `check_response_timeout` 120 min;
  - 9 required contexts since 2026-09-19 (`db-check` moved in from the deleted classic protection);
  - bypass is admin with `pull_request` (was `always`); it targets `~DEFAULT_BRANCH` only.
- **Plan and capacity:** the org plan is **Team**, not Free, so the "20-job cap" notes are stale. The limit is 60 concurrent jobs (macOS 5). 52 concurrent were measured with no waiting.
- **Claude review behaviour:**
  - The check is green whenever a verdict is posted, even with "N important" findings (`claude-code-review.yml:963`).
  - It never runs on push.
  - It shows ~92% precision, but only 42% of Important findings get fixed.
- **GitHub mechanics:**
  - A skipped job satisfies a required context.
  - Label events re-run the required `changelog-fragment-check`.
  - Disabling auto-merge does not dequeue a PR.
  - A jump needs admin, rebuilds every group, and still runs the full suite.
  - Use `PUT /pulls/{n}/merge` for bypass merges; `gh pr merge --admin` has bugs.
  - Copilot review only comments, never blocks, and bills the PR author.
  - CodeRabbit posts `success` with "Review rate limited".
  - GitHub Models was retired on 2026-07-30.
- **Queue history:** the queue never held more than 9 PRs in 30 days. The 23-open-PR jam of 08-23 was in the runner line.
- **Homebrew publishing** has failed 25 of 25 runs (`HOMEBREW_TAP_TOKEN` unset).
- **The Actions cache** sits at its 10 GB cap.

## 9. File index

| What                                                                                                                          | Where                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| The plan (v4, signed)                                                                                                         | `plans/ci-steward-plan.md`                                                                    |
| This status file                                                                                                              | `plans/ci-steward-status.md`                                                                  |
| Research synthesis (the 6 questions)                                                                                          | `research/20260919_ci-pipeline-deep-review.md`                                                |
| Detailed reports 01-04                                                                                                        | `research/20260919_ci-pipeline-0{1..4}-*.md`                                                  |
| Reports 05-09: queue emergency mechanics, AI review options, Claude review effectiveness, PR skill review, zero-budget review | `research/20260919_ci-pipeline-supporting/0{5..9}-*.md`                                       |
| Adversarial review rounds 1-8                                                                                                 | `research/20260919_ci-pipeline-supporting/plan-review/`                                       |
| Scripts behind every number                                                                                                   | `research/20260919_ci-pipeline-supporting/scripts/` (review analysis under `scripts/review/`) |
| Linear and PR lists used for change tracking (may mention non-public work, so kept out of the public repo)                    | `.temp/ci-steward/` in the main checkout (gitignored, local only)                             |
| Operator memory notes                                                                                                         | `project_ci_pipeline_deep_review_20260919.md`, `feedback_zero_budget_ci.md`                   |

## 10. Resuming the adversarial reviewer

The reviewer "Vesper" ran as a Fable subagent in session `ci-research-sep`. Its whole position is recoverable from the 8 round files. For a new round, spawn a fresh Fable agent: point it at `plans/ci-steward-plan.md`, all of `plan-review/`, and the research reports, and tell it it is continuing as Vesper.
