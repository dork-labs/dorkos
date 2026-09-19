# CI Steward plan: adversarial review, round 1

Reviewer: Vesper. Plan under review: `plans/ci-steward-plan.md` (draft v1, 2026-09-19).
Everything below was checked against the repo at `main` = `9688d2db0` and read-only `gh api` calls made 2026-09-19. Where I cite a file:line I opened it.

Severity key: **blocker** = the plan as written does not deliver a stated goal (self-monitoring, self-testing, autonomy-safe) or will break the repo; **major** = a goal is at real risk or a cost is materially misstated; **minor** = worth fixing, would not block sign-off alone.

---

## Findings

### 1. [blocker] The census test does not run "on every PR". It runs on almost none of the PRs it exists for.

**Targets:** §4.1 ("runs in the existing `scripts` vitest project on every PR"), §4.7 row 1, §6 phase 0 exit gate.

**Evidence.**

- `scripts/vitest.config.ts:4-8`: "Vitest project for repo-root `scripts/`, which is not a pnpm workspace and so is not covered by any package's `test` task. Registered in the root `vitest.config.ts` project list and run by `pnpm test:scripts`."
- The only CI job that runs that project is `scripts-test.yml` job `harness`, last step `pnpm exec vitest run --config scripts/vitest.config.ts`.
- `scripts-test.yml:153-187` (`on.pull_request.paths`) lists exactly six workflow files by name (`scripts-test`, `claude-code-review`, `merge-tail`, `operating-skills-version-check`, `test`, `credential-free-build`). There is no `.github/workflows/**`, no `.claude/settings.json`, no `turbo.json`. A PR that edits `browser-test.yml`, `lint.yml`, `typecheck.yml`, `site-build.yml`, `db-check.yml`, `harness-windows.yml` or the hook wiring in `settings.json` (the exact PRs an atlas census exists to catch) never triggers it.
- `scripts-test.yml` has no `merge_group:` trigger and is not a required context (ruleset `19893973`, read live: `typecheck, fragment-present, no-fragment-under-skip-label, version-outranks-base, test, browser-test, lint, credential-free-build`). So even when it fires it only blocks merge-tail arming, and 647 of 779 PRs are armed by the agent at creation (02 §A2), never by merge-tail.
- `test.yml`'s PR shards run `turbo test --affected` (`test.yml:380`); the repo already documents that root-level files outside any package score as zero affected packages (`site-build.yml:149-162`, AGENTS.md CI section). A workflow-only PR runs zero tests there too.

**Consequence.** `agents-service-census.test.ts` is a good pattern, but it has the same hole: it is a `scripts/__tests__` test and it also only runs when `scripts-test.yml`'s path filter fires. The plan copies the pattern without noticing where it executes.

**Fix.** Do not create a new context (see finding 13 and Q3). Add the atlas census as a **step inside `typecheck.yml`** next to the five policy gates that already live there (`typecheck.yml:159-253`: banned-words, vocab-gate, boundary, NUL, dead-doc-paths). That job runs full on every PR and every merge group and is already required. If you want it as vitest rather than a shell/tsx step, it needs a home in a workspace package (Q4) so the queue's full `turbo test` reaches it, and you still need PR-time coverage because `--affected` cannot see root files.

### 2. [blocker] The §5 governance fix for the review-erasure hole is inert for 83% of PRs, and the ADR it proposes would record a gate that does not exist.

**Targets:** §5 bullet 1 ("make a missing or red review block arming in `should-arm-automerge.sh`").

**Evidence.**

- 02 §A2: "created to auto-merge armed (first)" median **0 min**, 647 of 779 PRs. Agents run `gh pr merge --auto` themselves at PR creation. Those PRs never pass through `merge-tail.yml` or `should-arm-automerge.sh`; GitHub's auto-merge waits only for the ruleset's required contexts.
- `scripts/should-arm-automerge.sh:77-121`: the rules check state, draft, labels, mergeability, review decision, threads and check buckets. No author check, no fork check, no "review posted" check. Fine for merge-tail, irrelevant to a self-armed PR.
- The `review` context is not required and never reports on `merge_group` (`claude-code-review.yml:1070-1071` per the inventory; the job's `if:` at `:259-266` excludes forks, drafts, `skip-review`).

**Consequence.** Editing `should-arm-automerge.sh` changes nothing about what merges. The ADR "machine gates are the only gates" would list the Claude review as a gate while it remains advisory for every self-armed PR. That is exactly the "gate that silently certifies nothing" class the 04 report counts eight instances of.

**Fix (pick one, write it in the ADR).**

- (a) Make `review` a required context. It then needs a `merge_group` leg, which can be a pass-through job (the same trick `browser-test` uses in the other direction, `browser-test.yml:542-544`), plus re-run on `synchronize` so a push cannot leave the head SHA without a `review` check. Watch the skip semantics: a job-level `if:` that evaluates false reports `skipped`, and skipped satisfies a required context (that is how `no-fragment-under-skip-label` passes today). So `skip-review` becomes a green pass-through, which is what you want, but a **fork PR would also pass by being skipped**, which is not. The job must run on forks and fail, not skip.
- (b) Agents stop self-arming; merge-tail becomes the single arming authority, and its rules gain "review verdict posted on the head SHA". Costs up to 10 min of latency per PR (cron), which eats a third of the `lead-time` p50 objective.
  Either way, the plan currently names a mechanism that cannot work. Also note for the ADR: no external PR has ever been opened (checked: all 6 non-operator PRs are `app/dependabot`), but nothing prevents one, and under (a) a fork PR would today get no review and, if green, would be armed by merge-tail with no human ever looking. Say what happens to fork PRs.

### 3. [blocker] The verdict is an LLM opinion that merges itself. "No LLM in the measurement path" (§7) is false where it matters.

**Targets:** §4.5 step 2 ("A verdict appended to every ledger entry ... `verified`, `failed`, `inconclusive`"), §7, §4.7 row "A metric goes silently null".

**Why it fails self-monitoring.** The whole system exists to answer "did the change work?". In the plan that answer is written by `claude-code-action` and lands in a PR labelled `skip-review` that merges autonomously. There is no check that the verdict matches the numbers. An LLM that writes `verified` for an entry whose metric moved the wrong way is not caught by anything until a human reads `ci/reviews/`. Under the operator's constraints (no human gate) that is never. §8's own success metric ("at least 90% of entries past `check_after` have a verdict within 7 days") rewards writing verdicts, not writing correct ones.

**Fix.** The **collector** computes the verdict deterministically from the entry's `hypothesis` block and the pulse: `verified` iff the metric crossed `target` in the check window with n ≥ minimum and no other `active`/`incident-fix` entry names the same SLO in that window; `failed` iff the window elapsed and it did not; else `inconclusive` with the named confounders or the sample size. The collector writes it (`ci/verdicts/<id>.json` or a machine section of the review). The ledger validity check rejects any `status: verified|failed` in a hand-edited entry that disagrees with the computed verdict. The LLM writes the narrative and the proposals. Now "prove the check can fail" (§4.7 row 5) has something to prove: the three past changes with accidental outcomes (#1391 held, #1135 partial, #1246 failed; 04 §1 tallies) are the fixture set.

### 4. [blocker] The ratchets are not measurable the way the plan says, and the version that is measurable is not the one written.

**Targets:** §3 ratchets ("count of test tasks executed in the queue, count of Playwright specs executed"), §4.6 ("The weekly reviewer re-checks every ratchet from live data").

**Evidence.**

- `scripts/assert-tests-executed.sh:82-116` (per inventory) counts **turbo tasks** and compares to the number of manifests with a `test` script. That number does not change when an agent adds `.skip` to 200 tests, deletes half a suite, or narrows `include`.
- `scripts/assert-browser-tests-executed.sh:1-40` asserts every `*.spec.ts` appears in the report and ran ≥1 non-skipped test. Again per-file, not per-test.
- Neither number is exposed by the Actions API. The vitest JSON report the queue writes (`test.yml:331`, `--outputFile.json=vitest-shard-report.json`) and the Playwright JSON report are artifacts with `retention-days: 7` (04 §4). A weekly collector reading "live data" cannot see them; a weekly collector reading artifacts sees at most the last 7 days and nothing older.

**Consequence.** The Goodhart guard (§2 principle 6) is the load-bearing safety property for autonomous pipeline changes, and as written it cannot detect the cheapest weakening (skips) and cannot be computed on the cadence claimed.

**Fix.** Ratchets are **in-run assertions against committed floors**, not weekly observations. `ci/ratchets.json` holds per-shard-union floors for tests passed, tests skipped (max), Playwright tests passed, required-context set, contexts-on-merge_group count. The queue's existing assert steps read the JSON reports they already have and fail the build when a floor is undercut. Lowering a floor is a diff to `ci/ratchets.json`, which the ledger coverage check refuses without a `ratchet-release:` entry. The weekly review only checks that the assert steps ran and passed (job-step conclusions are in the API). This is the only version that is measurable, deterministic, and enforced at the moment of weakening rather than a week later.

### 5. [major] The `flake` objective (≤ 1% of builds) is a mis-transposed benchmark and is unreachable by construction.

**Targets:** §3 row `flake`, and through it `queue-green ≥ 97%` and the constraint computation.

**Evidence.** 03 §7: Google's 1.5% is **per test run**, and Google's own data says 84% of post-submit pass-to-fail transitions are flakes even at that rate. A queue build here executes thousands of test runs across 4 vitest shards and 3 Playwright shards. At a per-test flake rate of 1.5% with `--retry=1`, the probability that a build contains at least one flaky failure is close to 1; per-build flake of 1% would require a per-test rate around 1e-5, two orders of magnitude better than Google. The floors-ratchet rule (§4.4 rule 3) would then chase an objective that never arrives, and "constraint = largest excess" would pin `flake` as the constraint forever.

**Fix.** Two metrics, stated at the right level:

- `flaky-test-runs`: retried-then-passed test runs / test runs, from the flake reporter (`scripts/vitest-flake-reporter.ts`) and Playwright's `retries` in the JSON report, uploaded as a tiny JSON per queue build (finding 4's mechanism). Objective ≤ 1.5% (the Google rate, labelled as such).
- `wasted-queue-builds`: builds ejected for failed checks that later re-passed unchanged / builds. Today ~17-21%. Objective stated with a derivation, e.g. ≤ 3%, which is what quarantine plus test-level retry can plausibly deliver.

### 6. [major] The SLO definitions cannot be computed identically two weeks running.

**Targets:** §3 table, §4.4 rule 1.

**Specific holes.**

- `pr-feedback`: per PR or per head SHA? The 02 report measured per SHA (`max(updated_at) - min(created_at)` of required runs, §B2). Per PR with several pushes, which SHA? Are drafts, Dependabot and steward PRs in the population?
- `queue-green`: cancelled/superseded builds (28 of 1,465 in 30d) in or out? A build red only because a PR ahead of it in an ALLGREEN batch was bad counts against which PR?
- `escaped`: "fix PRs citing a regression from a PR merged ≤ 7 days earlier" is a regex over PR-body prose (02 §E: "regression language"). Under autonomy this is trivially gamed by not writing the word, and it is noisy at n≈24/30d.
- `local-*`: "share at the agent tool ceiling" needs the transcript miner, which §4.3 demotes to a one-off; the wrapper cannot see a tool timeout.
- "Constraint = the SLO with the largest excess, measured in wait-hours" has no conversion for `queue-green`, `flake`, `escaped`, `headroom`, `main-green`. Five of ten SLOs cannot be ranked by the rule that picks the work.

**Fix.** `slos.yaml` carries a `definition` block per SLO: event source, population, exclusions, aggregation, minimum n; one recorded fixture per SLO that pins the number. Replace the single wait-hours rule with a precedence: ratchet violation > quality-SLO breach (in a fixed order) > speed-SLO constraint by wait-hours, with the four conversions written out (pr-feedback: Σ max(0, t − floor); queue-build: same; wasted-queue-builds: ejections × (2.1h − 26m) from 02 §A3; local-push: pushes × excess).

### 7. [major] Attribution is not possible on the plan's windows and cadence, and the plan's rules assume it is.

**Targets:** §4.5 (verdicts), §4.6 ("One `active` experiment per SLO at a time, so verdicts can be attributed"), §4.4 rule 3 ("four consecutive weeks").

**Evidence.** 04 §2: ~13 pipeline PRs a week, ~75% of them incident fixes. The plan requires `incident-fix` entries to state a hypothesis on an SLO (§4.2), so by week one several entries target the same SLO and "one active per SLO" is already violated by the incident stream, not by experiments. 04 §5 showed exactly this: W36→W38 improved sharply and nobody can say which of six changes did it. Separately, a 28-day rolling metric read weekly shares 75% of its data with the previous reading; "four consecutive weeks at `ok`" is about 1.3 independent observations, so the floor ratchet moves on autocorrelated noise.

**Fix.** Per-experiment before/after windows anchored on the merge timestamp (7d before, 7d or 14d after), computed by the collector on demand from the API (run metadata persists well past 28 days). Confounders = every other entry merged in the after-window that names the same gate or SLO; they are listed in the verdict, and the honest default is `inconclusive: confounded by [...]`. The floor ratchet uses four **non-overlapping** 7-day windows. Rewrite §8's target from "90% have a verdict" to "100% have a computed verdict; the share that is `inconclusive` is reported and expected to be high".

### 8. [major] The weekly steward PR will conflict with agent PRs and then sit `DIRTY` forever.

**Targets:** §4.5 (the PR edits atlas `cost`, `slos.yaml` floors, and appends verdicts to existing ledger entries).

**Evidence.** `should-arm-automerge.sh:97`: `mergeStateStatus == "DIRTY"` → `SKIP conflicting`, on every tick. Agents adding a gate edit `atlas.yaml` (required by the census); `/ci:record` edits ledger entries; `status: proposed → active` edits the same entry the reviewer appends to. The steward PR is bot-opened with `skip-review`; nobody rebases it. Next Monday opens another. Memory: `reference_pr_watcher_gotchas.md`, "CONFLICTING PR = no CI, no review".

**Fix.** Split machine-owned from hand-owned files and never let both sides write one file: `cost` and per-gate stats live in the pulse JSON keyed by gate id (not in `atlas.yaml`); verdicts live in `ci/verdicts/<id>.json` written only by the collector; floors live in `ci/pulse/floors.json`. The workflow closes the previous unmerged steward PR before opening a new one, and fails if its own diff touches any hand-owned path.

### 9. [major] The pulse JSON will turn the required `lint` context red.

**Targets:** §4.3 ("writes `ci/pulse/YYYY-Www.json` ... plus `latest.json`").

**Evidence.** `lint.yml` runs `prettier --check .` (inventory §6.1). `.prettierignore` already carries a paragraph explaining that `JSON.stringify(x, null, 2)` output diverges from Prettier on short arrays (`.claude/scripts/docs-coverage-map.json` entry, "a ~590-line divergence"), and PR #1270 ("Capture writes Prettier-clean JSON", 04 August table) was this exact incident reddening `main`. A pulse snapshot is full of short numeric arrays (per-shard timings, histograms).

**Fix.** Either the collector formats its output with Prettier before writing, or `ci/pulse/` goes into `.prettierignore` with the standard byte-reproducibility note. Add a test that the committed snapshot round-trips.

### 10. [major] The cost claim in §8 omits the biggest cost: the steward PR's own CI and queue build.

**Targets:** §8 ("the weekly workflow under 30 runner-minutes and one review PR per week"), Q1.

**Evidence.** 02 §B3: a PR run plus a queue build is ~150 job-minutes and ~30 min of queue wall time (browser shards 3 × ~22 min, credential-free-build 26 min median), all of which run for a JSON-and-Markdown PR because the required workflows have no path filters (by design, so they can be required). That is 5× the number in §8, and it also takes a queue slot from real work every Monday.

**Fix.** See Q1: daily pulse pushed directly to a data branch (no PR, no queue, `contents: write` with `GITHUB_TOKEN` is fine because no ruleset covers that branch); one weekly PR to `main` carrying only the week's summary. Count that PR's queue build in §8 honestly.

### 11. [major] The local SLOs can never breach, and they are the wait the operator feels most.

**Targets:** §4.3 ("the weekly CI run reports local SLOs as 'not collected'"), §3 rows `local-commit`, `local-push`.

**Evidence.** Synthesis Q2: "The wait you probably feel most is not CI at all. It is agents stuck on `git push`: 13 to 18% of pushes hit the 10-minute tool ceiling." The plan's weekly review runs on GitHub, where the common-dir timings file does not exist, so `local-push` is permanently "not collected", never in breach, never the constraint.

**Fix.** The plan already has scheduled skills. Add `ci-local-pulse`, a DorkOS-scheduled skill on the operator's machine (Sunday) that reads the common-dir timings file and commits `ci/pulse/local-YYYY-Www.json` through a normal PR. The weekly review treats a missing local file as a **collector-health breach**, not as n/a. The tool-ceiling share still needs the transcript miner; keep it as the local skill's second input rather than a one-off.

### 12. [major] Agents will not discover the protocol in their normal flow. The repo already has the mechanism and the plan does not use it.

**Targets:** §4.1 ("AGENTS.md's long CI section shrinks to a 3-line pointer"), §2 principle 3, operator ask 3 (documented primarily for agents).

**Evidence.** `.claude/rules/` holds 13 path-scoped rules that load when an agent edits a matching file (`.claude/README.md:200-209`). Their `paths:` cover server, client, schemas, docs, changelog. **None** matches `.github/workflows/**`, `lefthook.yml`, `.claude/settings.json`, `.claude/hooks/**`, `turbo.json` or `scripts/assert-*.sh`. An agent editing a workflow today loads nothing about CI; after the plan it loads a 3-line pointer in AGENTS.md and must choose to open `ci/README.md`. Codex sessions load `.agents/` only.

**Fix.** `.claude/rules/ci-pipeline.md` with `paths:` covering every gate source, holding the change protocol in ~20 lines (hypothesis required, `/ci:record`, ratchet-release, deadlock invariant) and a pointer to the guide. Project it to `.agents/` per `syncing-agent-skills`. Put the long guide at `contributing/ci.md`, where `contributing/INDEX.md`, the docs coverage map and `/docs:status` already track staleness (04 §3 item 10 notes the guide is missing from exactly there); `ci/README.md` becomes a short pointer.

### 13. [major] The census does not encode the one invariant every past deadlock violated.

**Targets:** §4.1 census assertions (missing gate, stale gate, no timeout, no `catches`); §4.6 ("The census test blocks undocumented gates"); Q3.

**Evidence.** 04 §2 "Required-check / merge_group deadlock": #570, #581, #1246 (same day), #1464's design note (#1246 sat unqueueable 15h), #1655. ADR 260728-112203: "A required check that never reports on a merge group blocks the queue forever." The plan's census checks documentation, not the deadlock property.

**Fix.** The census asserts, for every context in the ruleset's `required_status_checks` (a committed list, reconciled weekly against the live ruleset): a job with that exact name exists; its workflow's `on:` has both `pull_request` and `merge_group`; the workflow has no `paths:` filter on either; any job-level `if:` is satisfiable on both events. Mutation-test it by planting a `paths:` filter on `lint.yml` in a fixture. This is the test that makes an autonomous `/ci:improve` safe to run unattended, and it is cheaper than everything else in §4.1.

### 14. [major] The plugin seam is thinner than stated.

**Targets:** §4.3 ("The code has no imports from the rest of the monorepo ... extraction to a plugin is a move, not a rewrite"), §4.8, Q4.

**Evidence.** `marketplace/plugins/flow/package.json`: the shipped runtime is TS run via `node --experimental-strip-types` with exactly one dependency (`zod`); `.dork/manifest.json` `layers: ["commands", "skills", "hooks"]`. A plugin cannot install a workflow file, a vitest test, a `.prettierignore` entry, a `.claude/rules` file or a `typecheck.yml` step; `/ci:init` would write them once and they drift from the plugin thereafter. "No imports from the monorepo" is necessary but not the constraint that matters: the engine must not use `octokit`, `tsx`, `yaml`-with-native-bits, or anything not carriable by a plugin. GitHub access should go through the `gh` CLI (present on runners and on every agent machine, and what `merge-tail.yml` already uses).

**Fix.** State the dependency budget now (node built-ins, `gh` via child_process, `zod`, maybe `yaml`). Make the engine a workspace package (Q4) whose test asserts that budget. Accept that the workflow, the typecheck step, the rule file and the census are **scaffolded** by `/ci:init` and version-stamped, the way `@dorkos/operating-skills` seeds and re-seeds with `OPERATING_SKILLS_VERSION`.

### 15. [major] Fixture tests on rolling windows are time bombs unless `now` is injected.

**Targets:** §4.7 row "Collector logic is wrong (fixture tests with recorded API responses)".

**Evidence.** Memory `project_notification_system_programme_shipped.md`: "literal-date fixture time bombs". A test that feeds recorded runs from 2026-09 into a "28-day rolling" computation relative to `Date.now()` passes today and returns n=0 in November.

**Fix.** The collector takes `now` and the window as explicit inputs; every fixture pins them; `latest.json` records `generated_at` and `window`.

### 16. [major] The steward job as described gives the LLM step access to the PAT.

**Targets:** §4.5 ("same auth and hardening as the existing PR reviewer ... opens one PR using the `MERGE_TAIL_TOKEN` PAT").

**Evidence.** `claude-code-review.yml:76-86` (header): the review job's threat model is that any code path the model can invoke "leaks CLAUDE_CODE_OAUTH_TOKEN and the OIDC App token". That job holds no PAT on purpose. `MERGE_TAIL_TOKEN` is `repo`-scoped (`merge-tail.yml:115`). Putting it in the same job's `env` as the model step exposes it to `Bash`.

**Fix.** Two jobs: the model job has `contents: read`, no PAT, and uploads its proposed diff as an artifact; a second job with the PAT applies the artifact, enforces the path allowlist (`ci/**` only, machine-owned set per finding 8), and opens the PR.

### 17. [minor] The SessionStart staleness line will false-alarm in old worktrees and stay silent when it should not.

**Targets:** §4.7 rows "dead cron" and "experiment never gets a verdict".

**Evidence.** Worktrees are cut from `origin/main` at creation and routinely live for days; `ci/pulse/latest.json` in the working tree is as old as the branch base. Reading it gives a false "pulse is 9 days old" in every stale worktree. `session-maintenance.sh:6-7` contract: "<500ms total, at most 5 lines, prints NOTHING when everything is healthy"; it already has five checks, so two more lines can breach the cap in a bad week.

**Fix.** Read `origin/main:ci/pulse/latest.json` with `git cat-file -p` (no network; the shared common dir is fetched constantly by other sessions, and if `origin/main` is missing, stay silent). Merge the two new lines into one. Drop the "verdict overdue" line: with computed verdicts (finding 3) nothing can be overdue.

### 18. [minor] The atlas copies facts that already live in the YAML, then checks the copy. That is a drift source by design.

**Targets:** §4.1 atlas schema (`runs_on`, `required`, `timeout_min`, `paths_affected`, `evidence_of_catch`).

**Fix.** Generate `ci/atlas.generated.json` from the workflows, `lefthook.yml` and `settings.json` (the census then asserts it is up to date, the way `docs-coverage-map.mjs --check` works). Hand-maintain only `ci/gates.yaml`: `{id, source, purpose}`. Cut `paths_affected` (nobody will keep it true) and `evidence_of_catch` (nobody will fill it). Derive "real catches" instead: a `failed_checks` ejection followed by a new commit before re-queue is a real catch, attributable to the failing job from the run data (02 §A3 already classifies the inverse). That gives the research's Q5.1 ("which gates catch real bugs") for free every week.

Also: the example says `browser-test` `runs_on: [merge_group]`, but the context reports on `pull_request` too (pass-through). The census needs "reports on" for finding 13; model both.

### 19. [minor] Backfill 10 past changes → backfill 3, and use them as fixtures.

**Targets:** §6 phase 0.

**Fix.** #1391 (held), #1135 (held partially), #1246 (failed) are the only past changes with a quantified hypothesis and an accidental measurement. They are the verdict engine's "prove the check can fail" set. Seven more retro entries are prose nobody will read.

### 20. [minor] `main-green` objective 0 is not realistic for what it measures.

**Targets:** §3 row `main-green`.

**Evidence.** Push-to-main checks are CLI smoke (5 jobs, hits npm), Desktop Smoke on macOS, scripts-test, db-check (02 §E: docs-openapi-check red for 19.4h max). None gates anything. §5 retires only `db-check`'s duplicate.

**Fix.** Either retire the push-main legs that re-test the queue's tree (the ADR already argues they are redundant) and keep `main-green` for what remains, or set the objective to ≤ 1 per 28d.

### 21. [minor] `skip-review` on Dependabot PRs means zero review of any kind on dependency bumps that merge autonomously in a public repo.

**Targets:** §5 bullet 1.

**Fix.** Fix the classifier's "non-human actor" verdict so the review runs and passes on bot authorship, rather than skipping it. The `maintaining-dependencies` skill treats red Dependabot PRs as needing judgment; an unreviewed green one is the riskier case.

### 22. [minor] Five SLOs breach on day one; say so, and say what the Gate budget does while cost is null.

**Targets:** §3 floors vs "Today (7d)", §4.4 rule 2.

**Evidence.** `queue-build` floor 45 vs 44-55; `pr-feedback` 30 vs 38.6; `flake` 10% vs 15-20%; `queue-green` 85% vs 75%; `local-push` 5 min vs 10 min. Rule 2 then applies from day one, while atlas `cost` is "filled by the pulse, not by hand" and the check is "advisory until the pulse has four weeks of cost data". An advisory check that prints nothing actionable is a check nobody reads.

**Fix.** State the day-one breach list in the plan. Define the advisory output (a PR comment with the before/after cost sum) and the flip date.

### 23. [minor] Two objectives have no seeded path.

**Targets:** §3 `local-commit p90 ≤ 20 s`, §6 phase 4 seeds.

**Evidence.** `lefthook.yml:16-70`: pre-commit runs `turbo lint --affected` and `turbo typecheck --affected` with `dependsOn ^build`; 04 #1467 measured 103 s for a one-line CLI commit after the affected fix. 20 s p90 means typecheck leaves pre-commit. No seed says that.

**Fix.** Add "pre-commit drops typecheck (kept at pre-push/CI)" to the seeds or drop the objective to ~60 s.

### 24. [minor] Coverage-check path set is underspecified.

**Targets:** §4.2 ("a PR whose diff touches any path in `atlas` sources or `config.yaml` pipeline paths").

**Evidence.** Gates invoke scripts: `scripts/assert-tests-executed.sh`, `should-arm-automerge.sh`, `pre-push-watchdog.sh`, `run-credential-free.sh`. A change to one of those is a pipeline change with no workflow diff.

**Fix.** Path set = atlas sources ∪ every script a gate invokes (derivable from the generated atlas) ∪ `ci/ratchets.json` ∪ `turbo.json`.

### 25. [minor] Public-repo hygiene for the new artifacts.

**Targets:** §4.1 `catches` prose, §6 phase 0 backfill, §6 phase 5 exit gate ("installs and runs in a second repo (a private sibling ...)").

**Fix.** The atlas entry for the boundary gate must describe purpose, not terms. Backfilled entries cite only public PRs. The phase-5 gate can be met in `marketplace`; do not make a private-repo install a stated exit criterion in a public plan.

### 26. [minor] `ci/README.md` as the agent guide sits outside the repo's guide tooling.

Covered in finding 12. `contributing/ci.md` is the home the 04 report asked for and the one `/docs:status` watches.

---

## (a) Answers to the five open questions

**Q1. Weekly vs daily.** Daily pulse, weekly review, and the daily data must not go through the queue. Push each day's snapshot directly to a `ci-pulse` data branch (`GITHUB_TOKEN`, `contents: write`; no ruleset applies there). That gives a dead-man's switch that fires within a day instead of nine, day-level windows for the per-experiment attribution in finding 7, and zero queue cost. The Monday review PR to `main` carries `ci/pulse/latest.json`, the week file and the review; that is the one queue build per week. Agents and `/ci:record` read `latest.json` from the tree; the collector reads the series from the branch. Local timings come from the operator's machine via a scheduled DorkOS skill (finding 11).

**Q2. `ci/changes/` vs `audits/runs/ci/`.** `ci/`. The audits convention (`audits/README.md`) is charter + lenses + dated runs for periodic audits; a per-change experiment ledger is neither a charter nor a run, and splitting the system across two roots buys only a nod to a convention. The sentence you cite ("the run-log ledger is the tracker of record") is about untracked audit findings, and it holds for `ci/` just as well. Two adjustments: the **guide** goes to `contributing/ci.md` (finding 12), and if you want the audits convention honoured, the weekly review is the nearest thing to a run and could be `ci/reviews/` with the same `<date>` naming.

**Q3. Required after one advisory week?** Not as a new context. Put coverage and validity as **steps inside `typecheck.yml`**, which is already required on both events and is where this repo puts diff-scoped policy gates (five of them, `typecheck.yml:159-253`). Coverage runs under `if: github.event_name == 'pull_request'`; validity runs on both. The advisory week is `continue-on-error: true` on the coverage step, flipped by a one-line PR. This has zero deadlock exposure, is required from day one, and costs seconds. The fragment check is its own context only because it needs `labeled`/`unlabeled` events; the ledger check does not. If it ever must become its own context, finding 13's invariant test is the gate for that PR.

**Q4. Engine seam.** A workspace package, `packages/ci-steward`, not `scripts/` and not the skill directory. `scripts/` is not a workspace (`scripts/vitest.config.ts:4`), its tests run only behind a path filter in an advisory workflow (finding 1), and its deps land in the root `package.json`. The skill directory carries no tests. A package gets `typecheck`, `lint`, `test` and knip through turbo, runs in the queue's full `test` (required), has its own `package.json` where the plugin dependency budget (finding 14) is asserted by a test, and the plugin either vendors its `dist` or runs the TS with `--experimental-strip-types` as flow does. The seam test is "imports only node built-ins plus the allowlisted deps, reads everything repo-specific from `ci/config.yaml`, shells out to `gh`".

**Q5. Are the objectives realistic?** Per row:

- `flake ≤ 1%` of builds: no, mis-transposed (finding 5). Redefine.
- `pr-feedback p90 ≤ 12`: only with turbo remote cache plus affected-only PR typecheck/lint (today's PR shards are 9.4 min median, 15.6 p90, on affected-only already). Credible; name the two seeds as its path.
- `queue-build p50 ≤ 12`: browser suite step is 18.4 min per shard at 3 shards and credential-free-build is 26 min median. Needs ≥ 6 browser shards or a faster suite, credential-free gutted to build + boot, and a remote cache. Credible but it is three seeds, not one; state the shard math.
- `lead-time p50 ≤ 30`: follows from the two above plus zero ejections, if agents keep self-arming (merge-tail's 10-min cron would eat a third of it).
- `local-commit p90 ≤ 20 s`: only by removing typecheck from pre-commit (finding 23).
- `local-push p90 ≤ 2 min; 0%`: only with seed 5 (bounded pre-push). Fine.
- `escaped ≤ 1%`: keep as a tracked metric, not an objective an autonomous agent is scored on (finding 6).
- `main-green 0`: change to ≤ 1 or retire the push-main legs (finding 20).
- `queue-green ≥ 97%`, `headroom ≤ 60%`: fine once `flake` is redefined.

## (b) If I were designing this from scratch

The architecture is mostly right; the parts that are wrong are the ones where an LLM judges and then merges its own judgment, and the parts that copy a fact and check the copy. The 90% version:

1. **`packages/ci-steward`**: a deterministic collector + verdict engine. Daily to a data branch. Computes every SLO with a written definition, per-experiment before/after windows, real-catch attribution per gate, and verdicts. Outputs Prettier-clean JSON.
2. **`ci/ledger/<id>.md`** fragments with a hypothesis; coverage and validity as steps in `typecheck.yml`; `ci/ratchets.json` enforced in-run by the assert scripts that already exist.
3. **`ci/gates.yaml`** `{id, source, purpose}` only; everything else generated from the YAML and checked up to date in the same `typecheck.yml` step, including the deadlock invariant.
4. **`.claude/rules/ci-pipeline.md`** as the discovery surface; `contributing/ci.md` as the guide.
5. **Weekly**: a deterministic Markdown report the workflow commits (machine-owned files only, one PR, auto-merged). No LLM in that PR.
6. **The LLM** runs on demand or on schedule as `/ci:improve`: reads the report, writes proposals as ledger entries and implements the top one in a worktree, and that PR goes through the normal pre-PR adversarial review like every other change. The LLM never lands anything with `skip-review`.
7. **Floors** move by a deterministic rule on non-overlapping windows, applied by the collector, not by the model.

What that cuts from the plan: the weekly `skip-review` LLM PR, hand-maintained atlas fields, `evidence_of_catch`, the SessionStart verdict-overdue line, the wait-hours rule for non-time SLOs, the "never more than five proposed" bookkeeping, and seven of ten backfill entries.

## (c) What I need to see changed to sign off

1. Census and ledger checks run as steps in `typecheck.yml` (or another mechanism proven to execute on every PR and every merge group); the plan stops claiming `scripts-test` gives that. (Findings 1, 13; Q3.)
2. §5 names a review gate that actually binds self-armed PRs, and says what happens to fork PRs. (Finding 2.)
3. Verdicts are computed by the collector; the LLM cannot write `verified`/`failed`; the three past changes are its fixtures. (Findings 3, 19.)
4. Ratchets are in-run assertions against committed floors, including tests passed and skipped; the weekly review only confirms the assert steps ran. (Finding 4.)
5. `flake` redefined at test-run level with the per-build cost metric beside it; every SLO gets a `definition` block and a fixture; the constraint rule is a precedence, not wait-hours for everything. (Findings 5, 6.)
6. Per-experiment anchored windows, confounders named, honest `inconclusive`, floors on non-overlapping windows; §8 rewritten accordingly. (Finding 7.)
7. Machine-owned / hand-owned file split, stale steward PR closed before a new one opens, PAT isolated from the model job, path allowlist enforced. (Findings 8, 16.)
8. Prettier-clean pulse output or a `.prettierignore` entry, with a round-trip test. (Finding 9.)
9. Daily pulse to a data branch; §8 counts the weekly PR's queue build. (Finding 10; Q1.)
10. Local timings reach the review via a scheduled local skill, and their absence is a health breach. (Finding 11.)
11. `.claude/rules/ci-pipeline.md` and `contributing/ci.md` replace `ci/README.md` as the agent-facing surfaces. (Finding 12.)
12. `packages/ci-steward` with a stated dependency budget and a test for it. (Finding 14; Q4.)
13. `now` injected into the collector. (Finding 15.)
14. Objectives table amended per Q5, with a named seed for every objective that needs a path.

Minor findings 17 to 26 I would accept as follow-ups if the plan lists them.
