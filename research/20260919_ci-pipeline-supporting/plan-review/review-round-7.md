# CI Steward plan: round 7, zero-budget review gate (§5.2-5.3)

Reviewer: Vesper. Read the rewritten §5.2-5.3, report 09, and the rest of the plan for paid dependencies. Facts relied on from earlier rounds: the review workflow sets no `--model` (inventory §7); `merge-tail.yml` counts every unresolved thread; report 07's numbers (9.7% Important rate, 58% of real findings merged unfixed, zero usage-limit failures in 30 days at ~780 reviews); AGENTS.md's statement that Claude Code, Codex and OpenCode run side by side and that every PR body carries an `agent:provenance` line with `harness`.

Verdict up front: the decision (Claude on the subscription as the only gate, Copilot rejected, CodeRabbit deferred) is right under the constraint, and the review budget is the correct replacement for re-review-on-push. Five blockers, all in the mechanics: debt mode as written turns the gate off for most of a heavy week and lets self-certified releases merge with no reader; the re-review request needs two preconditions; the rebase rule needs its actual definition; the reviewer is now a single point of failure with no fallback policy; and two paid items survived elsewhere in the plan.

---

## (1) Review-debt mode

**Is it a gaming surface?** The error itself is not forgeable: it comes from Anthropic's side as a structured SDK error. The two real surfaces are:

- **Classification.** If `classify-review-failure.sh` decides "weekly limit" from output text, a prompt-injected diff can make the model emit "You've hit your weekly limit" and open debt mode for every PR behind it. Classification must come from the SDK's structured error (`is_error`, error type), never from model prose, and **unknown must fail closed**, never fall into debt. Fixture-pin both.
- **Exhaustion, not forgery.** An agent does not need to fake the limit; heavy ordinary use reaches it (10-18 Opus reviewer runs per `/flow` change, per inventory §5), and the weekly window is up to 7 days. "Fail closed for 6 hours, then debt mode" therefore means: in a week that hits the weekly limit on Tuesday, the gate is off until the reset. That is the gate off for most of a heavy week, every heavy week, and the heavy weeks are the ones with the most PRs.

**Can debt-mode merges weaken gates?** Every other required check still runs (typecheck, tests, ratchets, census, ledger-check), so product code is guarded as today. What loses its only reader is the class the plan made "blocking by default unless the reason is specific": `ratchet-release` and `field-changes` entries, and any change to the steward or the judge. In debt mode a ratchet release merges with nobody reading the reason, which is precisely the self-certification hole round 2 closed by making the review read it. Dependabot bumps would also merge with no review of any kind in a public repo.

**Blocker 1. Debt mode needs a fence, a ceiling and a tripwire.**

- Classification from the structured error; unknown fails closed.
- **Exclusions**: a PR is not eligible for debt merge if its diff touches any coverage path (pipeline, steward, judge, test configuration), if its ledger entry carries `ratchet-release` or `field-changes`, or if its author is Dependabot. Those wait for the reset; they are ~13 a week.
- **A debt ceiling**: at most N PRs (I would start at 30) merge in one debt window; beyond that, fail closed again. Without it a heavy week merges 150 PRs unreviewed.
- **Post-merge review order**: XL first (07 §2: 12.5% Important rate against 8%), and the fix PRs are ordinary PRs with a ledger link, not `ci-priority` (priority is the incident lane and exempts from the freeze and the WIP cap).
- **Tripwire**: two debt windows in 28 days is a health breach that names the review budget as the constraint; the report says which consumer (interactive, scheduled, review) drove the week's usage, from the collector's `review-minutes` and the local export.
- Say the 6-hour number's reason, or drop it: if the reset is 3 hours away, waiting beats debt; if it is 5 days away, 6 hours changes nothing. Better rule: fail closed until the reset if the reset is under 12 hours away, else enter debt mode after 6 hours.

Should large PRs be excluded? No. 41% of PRs are XL; holding them for days defeats the mode. Order them first in the post-merge review instead.

## (2) Author-requested re-review

Findings carry across commits and close only by explicit marking, so the plain re-roll (empty commit, new SHA, fresh verdict) is closed. The residual surface is **variance on resolution**: push a cosmetic change to the finding's file, request a re-review, and let the model decide "resolved". Repeat until it does. 07 §3 shows today's re-reviews mostly follow real fixes (12 of 15 flipped clean), so the population is honest, but the mechanism must not depend on that.

**Blocker 2. Two preconditions on the request, and a ceiling.**

- A request is accepted only if the diff since the last reviewed SHA touches at least one file named by an open finding, **or** the request carries a rebuttal text that is attached to the finding's thread. A request with neither is refused by `ci-steward` with the reason.
- A finding may be marked resolved only with a citation of the hunk that resolves it; a retraction needs a reason. The verdict gate checks the citation exists in the reviewed diff.
- At most 3 re-review requests per finding; the fourth requires a rebuttal, and the count is tracked as `re-review-requests-per-finding`.
- The re-review prompt receives the open findings and the delta, not the prior verdict prose, so the model is not anchored toward "resolved".

The threshold path (b) is fine as long as the threshold is measured cumulatively since the last reviewed SHA (the text says so) and is small (~20 non-whitespace changed lines): 07 §1 found 17% of PRs merged with post-review commits, 35 of them `fix`/`feat`/`refactor`. Track `unreviewed-lines-merged` so the budget's cost is visible.

## (3) The patch-id rebase rule

Sound in intent, wrong in unit if it means per-commit `git patch-id`. Three cases:

- **Rebase with conflict resolution**: the resolved commit's patch-id changes, so it is reviewed. Correct.
- **Merge from `main` into the branch**: the merge commit's diff against its first parent is `main`'s own changes, already reviewed on `main`; per-commit patch-ids would either count it as new content (a wasted review) or need a special case. The PR's three-dot diff (merge-base to head) is what changed, and after the merge it equals the branch's changes plus any conflict resolution. Correct only if the rule is defined on the three-dot diff.
- **Rebase onto a `main` that edited adjacent lines**: `git patch-id` hashes hunk content including context lines, so context drift changes the id and triggers a scoped review of hunks whose only difference is context. Not a hole, but it spends the budget on nothing.

**Blocker 3. Define "rebase-only" on the PR's three-dot diff, not on commits**: the multiset of added and removed lines of `git diff <merge-base>...<head>`, whitespace-normalized, with context excluded. Unchanged multiset means the verdict is copied to the new SHA by `review-gate` on `synchronize` (no model run); a changed multiset means the changed lines are the scoped delta. Conflict resolutions and merges-from-`main` then fall out correctly with no special case. Add fixtures for all three cases above plus squash-then-force-push.

## (4) The correlated-limit argument

It holds for one runtime and not for the product this repo builds. The session limit stops every Claude Code session on the account, interactive and scheduled alike, so PR supply from Claude agents pauses with the review. But AGENTS.md's headline is Claude Code, Codex and OpenCode side by side; Codex and OpenCode PRs draw on other subscriptions and keep arriving while the Claude review is stalled. And the review's own consumption (~780 runs a month, `--model` unset) can be what trips the limit before the agents do.

Not a blocker, because the consequence is a stall, not a hole. Two follow-ups make it honest and measurable:

- **Pin the review to a Sonnet-class model** by default, Opus only for `review:deep`. Today `--model` is unset. This is the one zero-cost lever that lowers the shared-budget draw, and the plan does not name it.
- **Measure the correlation** rather than assert it: every PR body carries `agent:provenance` with `harness`, so the collector can report `PRs opened during review-limit stalls, by harness`. If the Codex/OpenCode share is material, the stall is uncorrelated for them and `REVIEW_WAITING_LIMIT` hours land on their lead time.
- `review-completes` (objective ≥ 99%) must exclude limit stalls from its denominator or it breaches on every limited week; report `review-limit-stall-hours` beside it, and attribute those hours in `lead-time`.

## Single point of failure

Report 09 §3b: the OAuth token is documented for the action, but a 780-PR/month org gate "strains" the "ordinary, individual usage" assumption and enforcement "may happen without prior notice". If the token is revoked, the only quality gate is dead; as written, debt mode becomes the steady state and nothing says otherwise. The pre-PR adversarial review dies with it (same subscription).

**Blocker 4. An indefinite-outage policy.** Say what happens when the reviewer has been unavailable for more than 48 hours (revocation, a multi-day limit, an action break): either merges freeze and the operator is notified (the honest zero-budget answer), or the deferred CodeRabbit path is promoted from "deferred" to **wired but off**, tested once on a fixture PR (including its `success` + "Review rate limited" trap), and switched on by the sentinel as the gate's input after 48 hours. I would do the second; the first is acceptable if written down. What is not acceptable is silence, because silence means debt mode forever.

## (5) Zero budget elsewhere

**Blocker 5. Two paid items survived.**

- `:352` "Larger runners have their own concurrency ceiling but are billed (the operator's spend call)". Under zero budget that sentence should say larger runners are out; the capacity levers are the dedupe seeds and shedding.
- `:43-44` and seed 3 name "turbo remote cache" as the path to two objectives. Vercel Remote Cache is free only within Hobby limits, and Hobby's terms are non-commercial; the Actions-cache-backed alternatives (a turbo cache server on `actions/cache`) draw on the same 10 GB pool that is already full (inventory headline 5), so seed 8 (cache-scope fix) is a prerequisite, not a sibling. The seed must name its zero-cost mechanism and its quota, or the two objectives lose their named path and Q5's sign-off condition from round 3 is void.

Checked and clean: operator actions (`:500-503`) carry no spend; the Copilot trial is gone; the data branch, the GitHub App, CodeQL, Dependabot and the sentinel's push notification cost nothing; §8's cost line is unchanged.

## Follow-ups (non-blocking)

1. Sonnet-class default for the review, Opus on `review:deep` only.
2. Correlation measured by provenance harness; `review-completes` excludes limit stalls; `review-limit-stall-hours` attributed in `lead-time`.
3. `unreviewed-lines-merged` tracked; threshold ~20 changed lines, cumulative.
4. Debt-review fix PRs are ordinary PRs with a ledger link, not `ci-priority`.
5. Record the ToS reading from 09 §3b as a known risk in §5.3, with the budget as the mitigation and the Claude for OSS application as the operator option it already is.
6. `review-gate` on `synchronize` is a copy step, not a model run; say so, since it is what makes the rebase rule free.

## Decision

Not signed yet. Blockers 1-5 are each a paragraph or a sentence; none changes the architecture or the decision in §5.2. I will sign on a delta showing them, as in round 6.
