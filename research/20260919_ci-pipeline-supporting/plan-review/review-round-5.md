# CI Steward plan: round 5 (§4.9 rewrite, §5 review gate, §4.10 author's side)

Reviewer: Vesper. Read §4.9, §4.10, §5, §6-9 of the plan fresh, plus reports 06, 07 and 08. Everything cited below is from those texts or from facts verified in earlier rounds (ruleset bypass actors, `changelog-fragment-check.yml` label triggers, `merge-tail.yml` thread counting, the review workflow's job-level `if:`).

## Round-4 conditions: met?

| #   | Condition                                                                                                                                    | Status                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Server-side fence: detector, auto-revert, counter from `main`, `bypass_mode: pull_request`                                                   | met (§4.9 L3)                                                                                                                        |
| 2   | Gates never the judge, with pure-revert and expiring-allowlist escapes                                                                       | met; exclusion list misses `merge-tail.yml`, `should-arm-automerge.sh`, the rule file and the guide, which §4.7 fences (follow-up 3) |
| 3   | RED only from canary, starvation, red `main`; stall/backlog AMBER-only; L3 only under canary or starvation for the red job's gate            | met; "the red job's gate" is undefined under starvation, which has no red job (follow-up 1)                                          |
| 4   | Quarantine classified from data, re-quarantine needs a release, size/age ratchet, vitest file-level                                          | met, but the RED exception reintroduces the rejected gate switch (blocker 7)                                                         |
| 5   | Timeline, split SLOs, targeted canary, cancel `gh-readonly-queue/*` runs, first re-queued PR as canary, 2-then-all, `detect-time` from onset | met                                                                                                                                  |
| 6   | Jump, ruleset edits, dispatch cut; canary legs listed                                                                                        | met; the five legs carry more than the row says (follow-up 4)                                                                        |
| 7   | HELD outranks, local state file, backoff, sentinel-owned `ci-hold`                                                                           | met, but the label mechanism itself is the problem (blocker 1)                                                                       |
| 8   | Phase 0 measures REST-merge refusal                                                                                                          | met; a second measurement is missing (blocker 5)                                                                                     |

## Blockers

Each is a one-paragraph edit. None changes the architecture.

### 1. Labels as the freeze mechanism start ~40 required-check runs at the worst moment and can satisfy a required context with a skipped run

§4.9 freezes with the `ci-hold` label; §4.10 says "the jobs that trigger on label events (`changelog-fragment-check`, the review) ignore these two labels". `changelog-fragment-check.yml` runs on `labeled` and `unlabeled` and `fragment-present` is required (verified round 1). "Ignore" in a workflow means a job-level `if:`, and a job-level `if:` that is false posts a **skipped** check run on the head SHA, which satisfies the requirement. Report 08 §6.5-6.6 names exactly this: a red `fragment-present` on a PR can be superseded by a skipped one when `ci-hold` is applied, and the plan's own §5.3 rejects the same mechanism for the review ("a skipped reviewer job can never satisfy the requirement"). Labelling 20 PRs at freeze and unlabelling them at release is ~40 runs of a required workflow while runners are the constraint.

**Fix.** Hold and priority state live in `queue-state.json` (per-PR entries: held since, signal, wave), which §4.10's classifier, `ci-steward arm` and `should-arm` already read. No labels are applied or removed by the sentinel. If a human-visible marker is wanted, it is a PR comment, not a label. `should-arm` reads the state file (fetched by the merge-tail tick) instead of a label.

### 2. RED cannot close when nothing needs merging

§4.9 hysteresis: "RED → RECOVERING needs the fix merged." Two of the three RED signals need no fix: runner starvation clears on its own, and a targeted-canary red from an outside outage (npm, apt, a GitHub incident) clears when the outage does. As written, 20 held PRs stay held until someone merges something called a fix, which invites a nominal pipeline PR to unblock them.

**Fix.** RED → RECOVERING also when the targeted canary, re-dispatched every 30 minutes while RED, passes, or when starvation has been absent for 15 minutes. The incident record says which exit fired.

### 3. The Copilot "advisory" trial blocks arming through the thread rule

§5.2 turns on Copilot with "review new pushes". Copilot posts inline review threads. `merge-tail.yml:179-182` counts every unresolved thread, outdated or not, and `should-arm-automerge.sh` returns `SKIP unresolved-threads` on any; §4.10's classifier keeps that rule. Report 06 §1 says Copilot auto-resolves its own threads only when it re-reviews and finds them addressed. So for four weeks every PR Copilot comments on is not armable by merge-tail until an agent resolves or fixes Copilot's advisory findings. The trial changes `lead-time` for the population it is measuring, and its own "flagged code was changed" metric is inflated by agents resolving threads to get armed.

**Fix.** During the trial, threads authored by `copilot-pull-request-reviewer[bot]` are excluded from the unresolved count in `should-arm`, the classifier and `review-gate`. Say so in the ledger entry as a known confound, and fixture-pin it.

### 4. The cost the operator is asked to approve is the pre-change number

§5.3 asks the operator to "approve the move to an API key for the review (about $850 a month)". Report 07 §6 measures $800-850 a month for **one review per PR** (median $0.85 × ~689 first verdicts, plus failed runs at $1.65). §5.3 also re-reviews on every push. Report 06 assumes 2-4 reviews per PR (1,600-3,200 a month); commits per PR are median 2, p90 8-13 (02 §A4). Scoping to the delta lowers tokens per re-review but a review still spends turns reading context, and the turn cap is being raised. The honest range is $1,700-3,500 a month before the trial, plus the turn-budget increase. §5.1 also says making the review blocking "costs nothing new", which the API-key move contradicts.

**Fix.** State the range with its derivation, name the two levers that bound it (re-review only when the delta touches an open finding's file or exceeds N lines; a per-PR review budget), and record the measured per-review cost as a tracked metric from phase 2 week one. Delete "costs nothing new".

### 5. Phase 0's exit gate does not prove the new token can enqueue without jamming the queue

The plan replaces the admin PAT with a GitHub App or fine-grained PAT and measures that a REST merge is refused. It does not measure the failure that actually happened here: a merge group enqueued by a token whose events trigger no workflows gets zero check runs and blocks the queue until the 120-minute timeout (#581, memory `project_merge_queue_cutover_20260728`; research 05 Q3). A GitHub App installation token normally triggers workflows, but "normally" is what #581 assumed.

**Fix.** Add to phase 0's exit gate: one PR armed with the new token enters the queue and its merge group receives check runs, observed before the token is used by merge-tail.

### 6. §4.10's engine pieces are in no phase

`ci-steward arm`, the per-PR classifier, the WIP cap and `HANDED_OFF` appear in §4.10 and §5.4 ("one arming authority"), and §4.9's freeze depends on the guard and the classifier reading `queue-state.json`. The phase table lists skill updates by phase but never delivers the classifier or `arm`. Report 08 §3 asks for the watcher fixes in phase 0 and the arming path by 1b.

**Fix.** Phase 0: the classifier with the round-08 fixes (1.10-1.14) and the parity fixture against `should-arm`; phase 1b: `ci-steward arm`, the WIP cap, `HELD`/`PRIORITY`/`AWAITING_ARM_SLOT`, the watcher shim; phase 2: `REVIEW_*` and `RATCHET` states. Exit gates gain "the watcher fixtures for the phase's new states pass" (08 §6.13).

### 7. The RED quarantine exception is the gate switch §4.9 v1 rejected

"During RED, an unclassified entry is allowed only for the job the canary showed red." A targeted canary red on `main` HEAD is, by construction, a deterministic failure on `main` with no PR involved. Quarantining that test makes the red job pass for every held PR, wave 1 goes green, RECOVERING closes, and 20 PRs merge over a broken `main` with nothing fixed. That is the "data-branch switch that makes a required gate pass" the earlier draft explicitly refused, arriving through the most common trigger.

**Fix.** The RED exception applies only when the canary itself was flaky: the dispatch retries the failing job once, and an unclassified quarantine is allowed only if the retry passed. A canary that fails twice is a real break and quarantine is refused; the lane is L2 or L3.

## Non-blocking follow-ups

1. **Starvation and L3.** Condition 1 says the diff "touches the red job's gate"; starvation has no red job. Define: under starvation-RED, L3 diffs may touch only triggers, concurrency or `shed-first` membership of non-required workflows.
2. **Auto-revert when the local sentinel is asleep.** Break-glass is local-only, so an unsanctioned merge came from the local machine, but the machine can sleep afterwards. If the local sentinel has not reverted within 15 minutes, the Actions tick opens the mechanical revert as a `ci-priority` PR and notifies.
3. **Break-glass exclusions** should include everything §4.7 fences: `merge-tail.yml`, `should-arm-automerge.sh`, `.claude/rules/ci-pipeline.md`, `contributing/ci.md`.
4. **The five canary legs are more than a trigger.** Each required workflow has several `if: github.event_name == 'merge_group'` steps (verified: `test.yml:330,409,444`, `browser-test.yml:141,550,556`); a `job` input that runs one shard must skip `assert-shard-union`; every new step-level `if:` needs a census allowlist entry; and `main-green` must exclude `workflow_dispatch` runs or every canary red counts as a red episode.
5. **`review-gate` on `merge_group`** "re-reads the verdict for each PR's head SHA". The `merge_group` payload carries no PR identity; ADR 260728-112203 refused to put a policy gate on the queue ref string for exactly this reason and decided fragment coverage at PR time. The second parent of each merge-group commit is derivable from git, but the simpler and consistent design is the ADR's own: a PR cannot enqueue until `review-gate` is green on its head, and neither label nor diff can change afterwards, so `merge_group` is a pass-through. Say which, and amend the ADR if it is the former.
6. **Finding closure.** "A later reviewed diff touches its lines and the re-review marks it resolved" needs line mapping across commits. Close findings only by explicit re-review marking (resolved or retracted by id); never by a line heuristic.
7. **`skip-review`.** With `review-gate` always running, say what the label does: retire it, or make the gate report "not reviewed" (red). Silence here re-opens the skip hole for one label.
8. **The read-only `gh` helper** runs today through `Bash(bash .../review-gh.sh:*)`. Removing Bash removes it; it becomes an MCP tool or the reviewer loses PR metadata.
9. **Copilot can gate, in one narrow way.** Report 06 §1: with the 2026-09-01 preview, an admin can let Copilot's approval count toward a required-approvals rule. The table's "no" is right for "request changes" and for a status check, but the plan should name and reject this route (it inverts to "Copilot must approve", dismissed on every push, no rubric, unmeasured precision) so the decision survives the operator asking.
10. **Trial pass criterion.** "Copilot finds real defects Claude missed on at least 3% of PRs" is ~24 unique real defects a month against Claude's ~76 Important findings; a high bar that predetermines "turn it off". Use a relative bar (unique real catches ≥ 25% of Claude's real catches over the same PRs) and make the monthly sample read the primary measure, since 07 §3 shows "code was changed" misses 43% of real findings.
11. **"Instead" argument.** Add the security asymmetry: the self-hosted gate is the thing with the incident history (Clinejection, Comment and Control); Copilot has no token surface. The decision still holds because Copilot cannot block and under autonomous merges blocking is the whole point, but the plan should say it weighed that.
12. **`ci-priority` preconditions.** Anyone can run `/ci:incident fix`; under AMBER, priority exempts a PR from the WIP cap. Require `kind: incident-fix` and a pipeline-only diff, checked by `ci-steward arm`.
13. **Deterministic ejections.** Ratchet, census and ledger failures never pass on retry; `ci-steward arm` must not re-arm a PR whose last ejection is classified deterministic until a new commit lands (08 §6.11).
14. **Per-PR states to the data branch** so the weekly report measures how often agents hit each state and how long it lasts (08 §6.12).
15. **Coverage paths** gain `.agents/skills/creating-pull-requests/**` (08 §3.5).
16. **§7 "No auto-revert"** now contradicts §4.9. Reword: no auto-revert on a `failed` verdict; unsanctioned or red break-glass commits are the one exception.
17. **Codex agents** have no PreToolUse hooks, so they can still raw-arm; state that the WIP cap binds them only through merge-tail and the classifier's advice.

## Decision

Not signed yet. The seven blockers are each a paragraph, and none reopens a decision I have already accepted; I will sign on a delta showing those seven edits without another full pass. Follow-ups 1-17 can ride the phase PRs.
