# CI Steward plan v2: final adversarial pass, round 3

Reviewer: Vesper. Read `plans/ci-steward-plan.md` v2 fresh, whole file. Verified this round: `test.yml:331,493-502` (vitest JSON reports are written but only the derived `shard-files-N.txt` is uploaded), every workflow's `push:` trigger (all filtered to `main` or `v*` tags), `meta/harness-sync-capabilities.md:60,82` (rules: "drop — no path-scoped format" for Codex/OpenCode), `typecheck.yml:135` (default-depth checkout, no base fetch), `apps/e2e/playwright.config.ts:301` (`retries: CI ? 1 : 0`).

## Verdict

**SIGNED.** The architecture is sound, the four round-1 blockers and the twelve round-2 conditions are in the text, and nothing I found below changes a design decision. What follows are inconsistencies and gaps in the writing, one phase-ordering error, and a few lost items. The first three are text edits that would produce wrong behaviour if implemented literally, so fix them in the plan file before it lands; the rest are follow-ups the phase PRs can carry.

## Fix in the plan text before it lands (no design change)

### A. The fence contradicts the seeded experiments (§4.7 vs §6 seeds 5, 6, 7)

`ci/steward-owned-paths.json` is path-based (the coverage step compares paths), but §4.7 lists "the `typecheck.yml` steps and `lefthook.yml` wrapper lines that call it". A path fence cannot fence steps; it fences files. If the fence names `typecheck.yml` and `lefthook.yml`, the tick can never run seed 5 (affected-only PR typecheck/lint, an edit to `typecheck.yml`), seed 6 (pre-push bounded, `lefthook.yml`) or seed 7 (typecheck out of pre-commit, `lefthook.yml`), which are three of the top seven. If it does not name them, the tick can delete the census step.

Fix: fence by content, not path, for those two files. The census cannot check that it itself runs (if the step is removed, nothing runs), so the guard must be a different runner: `ratchet-assert` in the queue's `test` fan-in reads `typecheck.yml` and `lefthook.yml` from the merge-group tree and fails when the census/ledger-check steps or the wrapper lines are absent (a fixed-string presence check, pinned by fixture). Add "census step present" and "wrapper present" to `ci/ratchets.yaml` as content ratchets with no HWM. Keep `packages/ci-steward/**` and the other listed files path-fenced.

### B. Verdict ordering makes confounded misses `failed` (§4.4 Verdicts)

As written: `verified` if reached target with n ≥ min and no confounder; `failed` if it did not; `inconclusive` otherwise. A change that missed its target while three other entries touched the same gate is evaluated `failed` before `inconclusive` is reached. Reorder: `inconclusive` (confounded or n short) first, then `verified`, then `failed`. Add the fixture: #1246 with a same-week confounder must read `inconclusive`, not `failed`; without one, `failed`.

### C. "Day-one breaches" is self-contradicting, and the constraint is undefined when nothing breaches (§3, §4.4)

§3: "Day-one breaches (floor set at or near today, so these start `ok` ...)". They are not breaches; every floor in the table is at or above today's value, so day one has zero breaches and zero excess over floor. Precedence rule 3 ("the speed SLO with the most excess wait-hours") then returns nothing, and "the report names exactly one" has no answer on launch day, which is exactly when the seeded work needs ranking.

Fix: define excess in rule 3 against the **objective**, not the floor (Σ max(0, t − objective)); floors decide breach, objectives decide the constraint. Rename the §3 paragraph "First constraints" and drop "breaches". Also add `local-commit` to the conversions (it is in the table and in the first-constraints list, but §4.4 gives it no conversion) and place `headroom` somewhere in the precedence (today it can never be the constraint; a tripwire in rule 1 fits).

## Phase order and exit gates

### D. Retire classic branch protection in phase 0, not phase 2

§4.2: "The daily collector ... reconciles `ci/required-checks.json` against the live ruleset. Drift is a health breach. Classic branch protection is retired first (section 5)." §6 puts the retirement in phase 2 and the reconcile in phase 1. For the whole of phase 1 the ruleset lists 8 contexts and `required-checks.json` must list 9 (`db-check` is required only via classic protection, verified live), so every daily snapshot is unhealthy from the first run and phase 1's exit gate ("3 consecutive healthy daily snapshots") cannot pass. Move "move `db-check` into the ruleset; delete classic protection" to phase 0 (one admin action, no code), and add the data-branch ruleset there too, since the branch ruleset can be created before the branch exists and phase 1's first push should land under it.

### E. Phase 1 depends on an artifact the queue does not upload

HWM ingestion (§4.6) and `flaky-test-runs` (§3) read "the queue's vitest and Playwright JSON reports (artifacts, 7-day retention)". `test.yml:331` writes `vitest-shard-report.json` per package, but `:493-502` uploads only the derived `shard-files-N.txt`. Playwright's reports are uploaded (browser shards). Phase 1 must add a `vitest-shard-report-N` artifact upload to the queue shards (retention 7 is fine; the collector runs daily), and that is itself a pipeline PR needing a ledger entry, which is a nice first real entry. The `test` fan-in job also needs those reports downloaded for `ratchet-assert` in phase 2; it already downloads `shard-files-*`, so extend the pattern.

### F. Coverage flip timing is stated twice, differently

§4.3: coverage "runs with `continue-on-error` for week one only; that allowlist entry expires by date." §6 phase 2: "ledger coverage flipped to blocking". If the allowlist expiry makes the census fail once the date passes, coverage is effectively blocking seven days after phase 0 lands, whatever phase the repo is in; phase 2's "flip" is then a no-op or, if phase 1 takes longer than a week, the census goes red mid-phase-1 with nobody planning for it. Pick one: either the expiry is the flip (say so in phase 0's row and delete it from phase 2), or the allowlist has no expiry and phase 2 removes it. I prefer the expiry: it is the mechanism §4.2 already demands for every `continue-on-error`.

### G. Phase 0 baselines have no `latest.json` to read

`/ci:record` "fills `baseline` from `latest.json`", which exists from phase 1. Phase 0 seeds `proposed` entries and three backfilled fixtures. Say that phase-0 baselines are hand-copied from the 02 report with a `baseline_source: research/20260919_ci-pipeline-02-timings.md` field, and that `/ci:record` refuses to run without `latest.json` rather than writing an empty baseline.

## Lost from v1, or stated without a mechanism

### H. The gate budget has no mechanism

Principle 5: "New required machine time must fit a budget." v1 §4.4 rule 2 had a mechanism (compare atlas cost sums before and after, advisory until four weeks of data). v2 has the principle and nothing that enforces it. Either drop the sentence from principle 5 or add it to the PR-time advisory (§4.6 already fetches the branch at PR time; the advisory comment can include "this PR adds gate X at p50 N min to the required path" from `atlas.generated.json` plus the snapshot's per-gate durations). Advisory is fine; a principle with no reader is not.

### I. Floors "never loosen without a ledger entry", but the ledger has no field for it

§4.4. `ratchet-release` and `field-changes` are the only release fields (§4.3). Add `floor-release: [{slo, value, reason}]` with the same scoping rules as ratchet releases, consumed by the collector.

### J. `.claude/rules/ci-pipeline.md` cannot be projected to Codex

§4.8: "It is projected to `.agents/` per `syncing-agent-skills`." `meta/harness-sync-capabilities.md:60,82`: path-scoped rules are Claude Code native and "drop — no path-scoped format" for Codex, OpenCode and Gemini; the engine does not project rules at all yet. Codex sessions will see only the AGENTS.md pointer and the skill. Either accept that (say the protocol's 20 lines also live in the `stewarding-ci-pipeline` skill, which Codex does load) or keep a short protocol block in AGENTS.md rather than shrinking it to a pointer. I would do the former and keep AGENTS.md at a pointer plus the two sentences an agent must never miss (hypothesis required; releases are blocking by default).

## Smaller corrections

### K. The coverage step needs a base to diff against

`typecheck.yml:135` checks out at default depth 1 with no base fetch. The coverage step diffs PR head against base; copy the "Determine the base to diff against" step from `changelog-fragment-check.yml` (merge_group base_sha, else merge-base against `origin/<base_ref>` with `--depth=200`). Implementation detail, but it is the difference between a check that works and one that reports "no changed files" and passes.

### L. Fork PRs and secrets

§5: "Fork PRs run and fail; they never skip." On `pull_request` from a fork GitHub withholds secrets, so the review action step would fail anyway, but it would fail as an infra failure that merge-tail then tries to re-dispatch with backoff (§5). Put a deterministic first step "fail on fork" that posts why and marks the run so the classifier reports `fork`, not `infra`. And keep the workflow on `pull_request`, never `pull_request_target`, which is the only way a fork could reach the token.

### M. `types:` belongs in the deadlock invariant

A required workflow whose `pull_request.types` omits `synchronize` never re-reports on a new head SHA; the PR cannot queue, which is not the queue deadlock but the same symptom. The review workflow is exactly this today (`opened, ready_for_review, reopened, labeled`). Add "`pull_request.types`, if present, includes `synchronize`" to the invariant, and "fixture: a required workflow with `types: [opened]`".

### N. Scoped re-review needs a full-review trigger

§5: re-run "scoped to the diff since the last reviewed SHA plus the prior findings". A force-push rewrites history, so "diff since last reviewed SHA" is undefined or misleading. Rule: a `HEAD_REF_FORCE_PUSHED_EVENT` or a diff whose base is not an ancestor triggers a full review. Also state that scoping is a quality trade the `review-red-rate` tripwire watches.

### O. Two writers on the data branch

The daily CI collector and the operator-machine local export both push to `ci-steward-data`. A race gives one of them a non-fast-forward rejection. Both need fetch, rebase, retry (three attempts). `non_fast_forward` in the branch ruleset is what makes the loser retry rather than clobber, which is the point, so this is a line in the engine, not a design change.

### P. The wrapper's own cost

§4.5: the wrapper is `ci-steward time-wrap`, i.e. a node process with `--experimental-strip-types`, per lefthook command. Pre-commit runs five commands; five extra node starts is a noticeable slice of a 20-second `local-commit` objective. Make the wrapper a POSIX shell script that writes START/END with `date +%s` (macOS `date` has no `%N`; second resolution is enough for a p90 in minutes) and reserve node for `local-export`.

### Q. Ratchet on the required-context set and hand ruleset edits

§4.6 lists "the required-context set" as an HWM ratchet asserted in-run. A ruleset edit is an admin click, not a PR, so the day the operator removes a context by hand every queue build fails until a release entry lands. That is the intended guard, but it must be in `contributing/ci.md` as a procedure: ledger entry with the release first, ruleset edit second. Otherwise the first time it happens looks like an outage.

### R. Release age is measured from the entry id

§4.6: a valid release "whose id is at most 14 days old". A PR that waits 15 days to merge invalidates its own release at the moment it enters the queue. Say that the age is checked at queue time and that `/ci:record --release` can re-stamp an entry (new id, old content), so the fix is one command rather than a puzzle.

### S. Wording

- §5 "fix the classifier's non-human actor refusal": the refusal is in the review prompt/verdict, not in `classify-review-failure.sh`, which classifies how a run ended. Say "the review's non-human-actor refusal".
- §4.6 "per workspace package" then "Playwright tests passed per spec file": say "per package for vitest, per spec file for Playwright" once, in the definition.
- §3 `wasted-queue-builds` "/ all builds" should say "/ completed builds", matching `queue-green`'s exclusion of cancelled builds.

## What I checked and found sound

- Section-to-condition mapping: all twelve round-2 items are present where the message says, and each is stated as a mechanism, not a principle. The re-roll rule, red-rate tripwire, per-package HWMs, scoped and consumed releases, status split, branch ruleset, check-runs pacing, census extensions, fence, wrapper semantics, classic retirement, Playwright retries: all there.
- Phase 0 has no dependency on phase 1 data except the baselines (G), and the census's mutation tests are fixtures, so phase 0's exit gate is self-contained.
- Phase 2's ratchet assertion depends on phase 1's HWMs, which depend on (E); with (E) in phase 1 the order holds.
- §8's cost claim is now honest: no system PRs, so no queue builds; 15 runner-minutes a day for the collector is plausible at ~250 check-runs calls plus artifact downloads.
- The local export's push cannot trigger any workflow (every `push:` trigger is filtered to `main` or `v*`), so "that push triggers no workflows" holds for both writers.
- The dead-man's switch reads `origin/ci-steward-data` from the shared common dir; the fetch refspec brings it; the janitor cannot reap it.
- The 17% queue browser failure rate being failures-after-one-retry is correctly noted in the `flaky-test-runs` definition; it means the per-test flake rate will read low and `wasted-queue-builds` will read high, which is the honest pair.

## Follow-ups, ranked

Before the plan file lands: A, B, C, D, F (five text edits, one of them a phase-table move).
Phase 0 PRs: G, J, K, M, Q (docs and invariant wording).
Phase 1 PRs: E, H, I, O, P.
Phase 2 PRs: L, N, R, S.

None of these reopens a decision. SIGNED.
