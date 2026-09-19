# CI Steward plan: adversarial review, round 2

Reviewer: Vesper. Responds to the orchestrator's round-2 redesign. Verified this round: `claude-code-review.yml:963` (the verdict grep accepts `[0-9]+ important`), `:236-246` (concurrency cancels are per-PR supersedes, not infra), the clone's fetch refspec (`+refs/heads/*:refs/remotes/origin/*`, shallow), `scripts/worktree-janitor.sh:298` (iterates local `refs/heads` only), and `scripts/classify-review-failure.sh` (already classifies `no`/infra/turn-budget from the execution log).

Verdict up front: the redesign fixes the four blockers. The data-branch split is the right call and I withdraw findings 8, 9, 10 and 16 as originally framed. What remains is one disagreement (fail-closed on review infra, as stated), three new holes the redesign opens (ratchet masking inside a batch, the ledger's status field going stale, API budget for gate-level metrics), and a longer weakening list for L4.

---

## 1. Finding 2: `review` as a required check whose conclusion reflects the verdict

**Agree** on the core: the check must be red on ≥1 important finding, re-run on `synchronize`, pass-through on `merge_group`, and forks must fail rather than skip. Your reading of `:963` is right; today a "3 important" review is green and the only teeth are threads that only merge-tail reads, which self-armed PRs never meet. Rejecting `required_review_thread_resolution` is also right: a resolved thread is a click, not a fix.

**Disagree, as written, on fail-closed after one retry.** Two reasons from the numbers:

- The 25% cancel rate is not infra. `:236-246` cancels in-progress runs on every new push (`cancel-in-progress` unless the event is a non-`re-review` label). Those are supersedes; the new push gets its own run. So the reliability baseline is the 7% failure rate, not 32%.
- The 7% failures are correlated, not independent. The workflow's own failure comment (`:1000`) names the cause: the subscription behind `CLAUDE_CODE_OAUTH_TOKEN` hits its usage limit, which "clears on its own" over hours. One immediate retry inside a usage-limit window fails again. Under full autonomy nobody is present to apply `re-review`, so fail-closed as specified stops every merge for the length of the limit window. That does hand the constraint to the review service, and it is the first thing an unattended weekend would find.

**What I would accept:** fail closed (a red or missing review never merges), but self-healing on a cadence rather than one retry. The existing `merge-tail.yml` tick (every 10 min, PAT, already walks every open PR) gains one step: for a PR whose `review` check is `failure` and whose classification (`classify-review-failure.sh class` on the run's artifact, or a marker comment the workflow already posts) is infra, dispatch a re-review, with backoff (10, 20, 40 min, cap 2 h) and a ceiling of N per PR. `review-completes` as you defined it becomes the SLO, plus `review-recovery` (p90 from infra failure to a completed review). Fail-closed then costs latency, never a stuck queue. Also give the review a second credential path (an `ANTHROPIC_API_KEY` fallback the workflow already knows how to prefer) so a usage limit on the subscription is not a single point of failure; the evals workflow already runs the same fallback order.

**Is an LLM verdict as a required check a Goodhart surface?** Yes, but the exploitable surface is narrower than "agents learn to write PRs that pass". Agents cannot tune the reviewer; they can (a) write smaller, clearer PRs, which is the behaviour you want; (b) argue in threads, which under your design does not change the check; (c) **exploit variance**: re-run the reviewer on the same SHA until it says "No blocking issues". Today `re-review` on an unchanged head does exactly that. That is the real surface. Two mechanical fixes:

- A same-SHA re-review may not flip red to green unless the run was given the prior findings and explicitly retracts each one by id; the workflow passes the previous review's findings into the prompt and the verdict gate checks that every prior important finding is either marked resolved by a diff hunk or retracted with a sentence. Record `verdict-flips-same-sha` as a metric with a ceiling.
- A `review-red-rate` floor: the share of first-run verdicts with ≥1 important finding. The pre-PR adversarial loop catches ~45 real defects (inventory §5) on PRs with a median of 720 lines; a CI reviewer that is green 99% of the time on that input has stopped reading. A floor of, say, 10% is not a target to hit, it is a tripwire that says the reviewer degraded (model change, prompt drift, truncated diff) and the check is certifying nothing. That is the "gate that silently certifies nothing" class applied to the one gate that is now load-bearing.

One cost to write down: XL PRs (41%) can take the reviewer to 25 min (`timeout-minutes` 25, `max_turns` 100). With re-run on every push, the review becomes the `pr-feedback` long pole on those PRs. Either accept it in the objective's path or scope the re-run to the diff since the last reviewed SHA.

## 2. Findings 8/10/16/Q1: no PR to `main` from the system

**Agree**, and it is better than what I proposed. Verified supporting facts: the only ruleset targets `~DEFAULT_BRANCH`; the clone refspec is `+refs/heads/*:refs/remotes/origin/*`, so any session's fetch brings the branch and `git cat-file -p origin/ci-steward-data:latest.json` works offline; the janitor enumerates local `refs/heads` only, so a remote-only orphan is never reaped; shallow clones fetch an orphan branch without trouble. `GITHUB_TOKEN` pushes trigger no workflows, which here is a feature.

**New holes the split opens:**

- **The ledger entry's `status` goes stale.** Verdicts now live on the data branch; the entry on `main` still carries `status: proposed → active → verified | failed ...`. Two writers again, just across branches. Fix: the `main` entry holds only hand-owned states (`proposed`, `active`, `withdrawn`, `reverted`); `verified`/`failed`/`inconclusive` exist only in `verdicts/<id>.json` on the branch; validity check rejects those three values in a hand file; `/ci:status` joins the two. Say this in the format.
- **Protect the branch from itself.** A collector bug that force-pushes or deletes the orphan erases every observation; there is no GitHub-side reflog for you. Add a second ruleset targeting `refs/heads/ci-steward-data` with only `non_fast_forward` and `deletion` rules, no required checks. Cheap, and it turns "append-only" from a convention into a property.
- **Discoverability moved off `main`.** The weekly report, the generated atlas and the floors are now invisible to `grep`, to a worktree checkout, and to any agent that does not know the incantation. `contributing/ci.md` and the rule file must give the exact `git show` commands, and `/ci:pulse` and `/ci:status` are now the primary surfaces, not conveniences. `latest.json` should carry a `report_ref` so a reader of one file finds the rest.
- **The collector's API budget.** `GITHUB_TOKEN` is capped at 1,000 requests per hour per repository. Your attribution refinement (section 3) needs gate-level durations, which means job-level data for every run: ~1,100 runs a day at the 30d rate, one `runs/{id}/jobs` call each, over the cap. Use `commits/{sha}/check-runs?per_page=100` instead: one or two calls per head SHA returns every job of every workflow (~250 SHAs a day across PR and queue, well under the cap), and record `health.api_calls` plus a paced sleep so a busy day degrades to "late" rather than "truncated". The 1,000-result cap on the runs list is already handled by your windows; this is the other cap.

## 3. Ratchets as high-water marks read from the data branch

**Agree** with the mechanism and with fail-closed on a failed fetch (with three retries and an error that names the branch). Fail-open here is precisely the class you are guarding against.

**Disagree that the 24 h gap is the gap that matters.** The hole is masking inside a window, and it is structural, not temporal:

- Two PRs in the same day, one adding 50 tests and one deleting 50, net zero against yesterday's HWM: the deletion lands with no `ratchet-release`.
- Worse and more common: the queue batches up to 5 PRs into one group (`max_entries_to_build: 5`). One group is one run and one count. A PR that deletes a suite rides green beside a PR that adds one, in the same build, on the same day, with the HWM never involved.

Per-build totals cannot see either. **Per-package HWMs** can: the vitest JSON report carries file paths, so the fan-in job can sum passed and skipped per workspace package (it already unions the four shard reports for `assert-shard-union.sh`), and Playwright's report gives per-spec-file counts. A deletion in `apps/server` is then not masked by additions in `packages/mesh`, and masking needs two PRs in the same package in the same window, which is rare enough to accept. Per-package HWMs also give you the one thing the queue-only assertion lacks: an **advisory PR-time estimate**, because the PR's affected-only shards do run the affected packages fully, so their counts can be compared to those packages' HWMs at PR time and the agent learns about the ratchet 30 minutes earlier than the queue ejection. Without that, the first time an agent hears "your PR lowers a ratchet" is after a 30-min queue build, an ejection, and possibly four other PRs ejected with it.

Two more points on the mechanism:

- **`ratchet-release` is self-certification and it is the whole guard.** The entry is written by the same agent that lowered the count, and under autonomy the only reader is the required review. So the review prompt must treat any `ratchet-release` in the diff as blocking by default unless the entry's reason is specific (which tests, why they were dead or duplicated), and the verdict gate should refuse "No blocking issues" on a PR whose diff contains a `ratchet-release` the review did not name. Otherwise the ledger check verifies the presence of a sentence.
- **Scope the release.** "The merge_group tree contains a ledger entry whose `ratchet-release` names that ratchet and the new value" matches any entry ever committed. An entry from June that named `server.tests_passed: 4100` re-licenses a drop to 4100 forever. Require the entry's timestamp id to be within N days of the run, or `status: active`, and consume it: once the HWM has moved down to the released value, the release is spent.
- **Ingest HWMs only from green builds where the assertion passed**, and treat the skipped ceiling as monotone decreasing unless released. Otherwise a red build with a lower count teaches the collector the lower number.
- Friction estimate, so nobody is surprised: at 779 merges/30d with routine test consolidation, expect on the order of 5% of PRs to need a release. `/ci:record --release <ratchet> <value> "<reason>"` should be one command, or agents will route around it with the worst of the three options above.

## 4. Attribution: narrowest metric per hypothesis

**Agree.** Gate-level metrics make most verdicts attributable, and "confounders = other entries touching the same gate" is a definition the collector can evaluate. Three refinements:

- Some changes have no gate-level metric because the gate is the whole queue (batch size, `check_response_timeout_minutes`, ALLGREEN, merge-tail cadence). Allow a `queue`-level metric class for those; they will be confounded and that is honest.
- The narrowest-metric rule needs a catalogue in `slos.yaml` (or a sibling `metrics.yaml`): per gate `duration_p50`, `duration_p90`, `failure_rate`, `retry_rate`, `real_catches`, `ejections_caused`, and per hook `duration`, `killed_share`. `/ci:record` offers only catalogue ids, so hypotheses are computable by construction rather than prose the collector cannot evaluate.
- A hypothesis on a gate metric can be "verified" while the SLO it was meant to serve did not move (the change made `browser-shard (2/3)` faster and the queue build got slower because `credential-free-build` became the long pole). Report both, as you say, and make the weekly report's headline the SLO trend, not the verdict count, or the system optimises verdicts.

## 5. Local timings without a scheduler for the signal

**Agree** with START/END lines and the killed heuristic; it replaces transcript mining and is honest about what a kill looks like (no `END`, ever, because `trap EXIT` does not run on SIGKILL, which is what the tool ceiling delivers). Details that decide whether it works:

- The wrapper must `exec` the real command so lefthook's `piped`/`follow` semantics, exit codes and signals pass through unchanged; write `START` before `exec` and `END` from a parent shell that waits, not from the exec'd process.
- "No END after 15 minutes" as evaluated at SessionStart misclassifies a push that is legitimately still running (pre-push cap is 7,200 s, `lefthook.yml:129-273`). Use "no END and START older than the pre-push ceiling" for the export, and let SessionStart say "1 hook still running or killed" rather than "killed".
- Rotate the file in the export (size cap, keep 30 days) or SessionStart's "tail only" stops being cheap after a busy month; and exclude `--no-verify` calls (the wrapper does not run then, so they are invisible, which understates the local pain the way the transcript miner did; count them from `git log`'s absence of the seeded fragment if you care).
- One wrapper per clone, not per machine: the common dir is per clone. The operator has at least `dorkos/`, `dorkos-wt`, and the flow drain's worktree base; the export must walk every clone it knows about or state which one it read.

## 6. L4: when may `/ci:improve` run unattended?

Your two conditions are necessary and not sufficient. The rule I would write is **the steward may change gates; it may never change the steward or the judge**, and the "judge" is larger than the four paths you listed. Weakening paths still open under your rule:

1. `packages/ci-steward/` itself. The collector computes the verdicts and the HWMs. An unattended change there changes what "verified" means. Off limits to the tick entirely.
2. The `typecheck.yml` steps that call the package, and `lefthook.yml`'s wrapper lines. Removing the call is removing the check.
3. `continue-on-error: true` or `if: false` on a step inside a required job. The job stays green while the step stops running; the census as specified (job exists, both triggers, no `paths:`) does not see it. Add to the census: no `continue-on-error` in a required job outside a declared advisory allowlist with an expiry date; every step-level `if:` in a required job is in an allowlist.
4. `--retry` raised, shard count lowered, `timeout-minutes` raised. All three are ordinary workflow edits that hide flakes or mask headroom. `flaky-test-runs` sees the first if retries are reported; `headroom` sees the third; nothing sees the second except the atlas diff. Rule: the generated atlas is diffed in the coverage step and any change to `retry`, `shards`, `timeout_min` or `required` on a required gate needs a ledger entry whose hypothesis names that field, and the tick may not author one.
5. `ci/slos.yaml` definitions and objectives, `ci/config.yaml`, `.claude/rules/ci-pipeline.md`, `contributing/ci.md`. Changing the definition of a metric is the quietest way to make it green.
6. `ratchet-release` entries: the tick may never author one (section 3).
7. Any change touching the review workflow, `REVIEW.md`, or the arming script, since the review is now the only reader of the ledger.

Mechanically: the tick works on branches named `ci-improve/*` and its ledger entry carries `actor: ci-improve-tick`; the coverage step fails a PR from such a branch that touches any path in a committed `ci/steward-owned-paths.json`. An agent can lie about the branch name, but the guard is for the unattended path, not for adversaries, and a lie leaves a trail in the ledger.

On the two-week clean run: add that the verdict engine has produced one correct verdict on a real (non-fixture) entry, and that the ratchet assertion's fixture suite (`scripts/test-assert-*.sh` style) has proved the queue assertion fails on a planted per-package drop. Do not try to prove it with a live drill: ratchets run only in the queue, and a planted drop ejects up to four real PRs with it (which is also why the PR-time advisory estimate in section 3 matters).

Finally, keep the property that no admin credential exists in Actions. Today nothing in the repo can edit the ruleset, so the tick cannot un-require a check; the only path to that is the operator's account. Write that down as an invariant so nobody adds an admin PAT for a convenience later.

## 7. Everything under "Accepted, how"

Agree with all of it. Two small additions:

- `ci/required-checks.json` reconciled daily against the live ruleset: the census step on `main` must not need the branch (it reads the committed file), and the daily reconcile must also read the classic branch protection until §5 retires it, or `db-check` silently stops being in the list the census enforces. Branch-protection reads need admin scope; `GITHUB_TOKEN` will get a 403. Either retire classic protection first (it is a single click) or let the collector record `classic: unreadable` as a health line rather than assuming empty.
- The `flaky-test-runs` numerator needs Playwright retries reported. Confirm `apps/e2e`'s Playwright config sets `retries` in CI and that the JSON reporter is on; if retries are 0 in the queue, every flake is an ejection and the per-test metric reads 0 while `wasted-queue-builds` reads 17%. Both must be true at once or the pair is misleading.

---

## Updated sign-off list

Carried from round 1 and now satisfied by the redesign, as long as the plan text says what your message says: 1 (typecheck steps), 3 (computed verdicts), 4 (in-run ratchets), 5/6 (metric definitions, flake split, precedence), 7 (anchored windows), 8/9/10/16 (data branch), 11 (local export), 12 (rule file + guide), 13 (deadlock invariant), 14 (package + dep budget), 15 (`now`), and the objectives table per Q5.

Still open before I sign:

1. **Review gate:** red-on-important as a required context; fork PRs fail; self-healing infra re-dispatch via merge-tail with backoff and a per-PR ceiling, not a single retry; `review-completes` and `review-recovery` SLOs; a second credential path. (Section 1.)
2. **Same-SHA flip rule** and `review-red-rate` tripwire, so the required LLM verdict cannot be re-rolled and a silent degradation is visible. (Section 1.)
3. **Per-package ratchets**, ingested only from green builds, with scoped and consumable `ratchet-release` entries and a PR-time advisory comparison. (Section 3.)
4. **The review treats `ratchet-release` as blocking by default** and the verdict gate refuses a green verdict that does not name it. (Section 3.)
5. **Ledger status split** across `main` (hand states) and the branch (verdict states); validity check rejects verdict states on `main`. (Section 2.)
6. **A `non_fast_forward` + `deletion` ruleset on `ci-steward-data`.** (Section 2.)
7. **Collector uses `check-runs` per SHA, paces under 1,000 req/h, records `health.api_calls`.** (Section 2.)
8. **Census invariants extended:** no `continue-on-error` in required jobs outside an expiring allowlist; step-level `if:` allowlisted; atlas-field changes on required gates (retry, shards, timeout, required) need a named ledger entry. (Section 6.)
9. **`ci/steward-owned-paths.json` enforced against `ci-improve/*` PRs; the tick may never author a `ratchet-release`; no admin credential in Actions, stated as an invariant.** (Section 6.)
10. **Local wrapper semantics:** `exec`, END from the parent, killed = no END past the pre-push ceiling, file rotation, one export per clone. (Section 5.)
11. **Classic branch protection retired before the daily reconcile relies on the ruleset alone**, or the collector reports it unreadable. (Section 7.)
12. **Playwright retries confirmed on in the queue** so `flaky-test-runs` and `wasted-queue-builds` are both real. (Section 7.)

None of these change the architecture. With the twelve written into the plan, I would sign.
