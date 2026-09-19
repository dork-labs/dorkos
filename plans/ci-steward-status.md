# CI Steward: status and handoff

**As of 2026-09-19 (session `ci-research-sep`).** Read this first after a context compaction or in a new session. It holds everything that otherwise lives only in the conversation.

## 1. Where things stand

- **Research: done.** The CI, review and merge pipeline was measured and compared to industry numbers.
- **Plan: done and signed.** `plans/ci-steward-plan.md` v4 was signed by the adversarial reviewer (Vesper, on Fable) after 8 rounds.
- **Implementation: not started.** Nothing is built.
- **Committed on branch `docs/ci-steward-research`** (worktree `dorkos-wt/ci-steward-research`, docs-only PR). It is removed from the `main` checkout. If the PR hasn't merged yet, read the files from that branch or worktree.

## 2. Operator decisions (2026-09-19, binding)

1. **Merges stay fully autonomous.** No human approval before merge, ever. Quality has to come from machine gates.
2. **Tracking and monitoring come first**, before speed work.
3. **Targets:** CI "much faster and much higher quality than average" (elite, not average).
4. **The system:** self-testing, self-monitoring, self-improving. Docs are written for agents first. It ships as a skill that can later become a marketplace plugin.
5. **Zero budget.** DorkOS is open source with no revenue.
   - **No Anthropic API key** for the AI review. It keeps running on the operator's existing Claude subscription token.
   - The operator wrote: "We can not cover the costs of AI reviews using a subscription key." That was read as "keep the subscription, no API key", and not contradicted. Confirm if in doubt.
   - **Copilot review is a hard no if it could cost more than $100 a month.** A cap must be a guarantee.
   - Result: no Copilot, and no paid infrastructure (larger runners, managed review).
6. **The adversarial reviewer:** the operator asked for a resumable **Fable** agent to review plans. This is an explicit exception to the standing "subagents Sonnet/Opus, never Fable" rule.
7. **Style:** the operator wants ELI5 answers: short, plain words, 2 options at most with a recommendation. They also want most work done autonomously ("decide, don't ask", except for spend, access or irreversible actions).

## 3. Waiting on the operator

1. **Approval to change GitHub settings with their admin `gh` session** (phase 0):
   - replace `MERGE_TAIL_TOKEN` (a `repo`-scoped admin PAT, so Actions can probably edit the ruleset today) with a GitHub App or a fine-grained token that has no Administration permission;
   - narrow the ruleset `bypass_mode` from `always` to `pull_request`;
   - retire classic branch protection (move `db-check` into the ruleset);
   - add a ruleset on `ci-steward-data` that allows no force-push and no deletion.
2. **Go / no-go on starting phase 0** (offered, not yet answered).
3. **Filing the 14 real defects** the Claude review found that are still on `main` (offered, not yet answered). The list is in `research/20260919_ci-pipeline-supporting/07-claude-review-effectiveness.md` (the table near line 92):
   - #1893, #1570, #1779 (2), #1150, #1318, #1153 (2), #1462, #1638, #1229, #1146, #1173, #1507, #1676, #1791;
   - re-verify each on current `main` before filing.
4. **Optional, free:** apply to Anthropic's Claude for Open Source program (6 months of Max 20x). The repo doesn't qualify on stars; the operator might through 100+ merged PRs in other repos.

## 4. Next steps (once approved)

**Phase 0**, per `plans/ci-steward-plan.md` §6. Do it in a worktree, one or two PRs:

- the GitHub setting changes above;
- the `ci/` hand files, `gates.yaml`, `packages/ci-steward` with `census` and `ledger-check` as steps in `typecheck.yml`;
- `.claude/rules/ci-pipeline.md`, `contributing/ci.md`, the AGENTS.md pointer;
- ADRs: "merges are fully autonomous", and "pipeline changes carry a hypothesis";
- 3 backfilled fixture ledger entries: #1391, #1135, #1246;
- seeded `proposed` entries;
- the `creating-pull-requests` skill de-staled.

**Phase 0 exit gates** (all must pass):

- the census fails on each planted drift;
- a REST merge with the new token is refused;
- a merge group enqueued by the new token receives check runs.

**Follow-ups to carry into the phase PRs:** the plan has lists at "Follow-ups carried into the phase PRs (from round 3)", "Follow-ups from round 5" and "Follow-ups from round 7".

Use `/system:update` conventions for harness components: the skill `stewarding-ci-pipeline` is canonical in `.agents/skills/`, and the commands go in `.claude/commands/ci/`.

## 5. The design in ten lines

1. **Intent on `main`, observations on a data branch.** Hand files are `ci/` plus `ci/ledger/`. Machine output goes to the orphan branch `ci-steward-data`. The system opens no PRs of its own.
2. **Engine:** `packages/ci-steward` (node built-ins, `zod`, `yaml`, and `gh` through `child_process`).
3. **Checks without new required contexts:** the census (docs can't drift, deadlock invariant) and the ledger checks run as steps in `typecheck.yml`.
4. **Deterministic judging:** verdicts, SLO floors and the constraint ranking are computed by code, never by an LLM.
5. **Ratchets:** per-package high-water marks, asserted in the queue.
6. **The fence:** `/ci:improve` may change gates, never the steward or the judge.
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

## 6. Facts verified during the work (don't re-derive)

- **Ruleset 19893973:**
  - SQUASH, ALLGREEN, `max_entries_to_build` 5, `max_entries_to_merge` 5, `check_response_timeout` 120 min;
  - 8 required contexts, plus `db-check` via classic protection (`enforce_admins` on, which blocks admin bypass);
  - bypass is admin with `always`; the only ruleset, it targets `~DEFAULT_BRANCH` only.
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

## 7. File index

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

## 8. Resuming the adversarial reviewer

The reviewer "Vesper" ran as a Fable subagent in session `ci-research-sep`. Its whole position is recoverable from the 8 round files. For a new round, spawn a fresh Fable agent: point it at `plans/ci-steward-plan.md`, all of `plan-review/`, and the research reports, and tell it it is continuing as Vesper.
