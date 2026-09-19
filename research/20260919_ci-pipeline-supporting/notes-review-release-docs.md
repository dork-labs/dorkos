# Pre-PR review, release process, and CI docs: inventory

Read-only survey, 2026-09-19. Paths are relative to `the repo root` unless marked `MKT:` (= `marketplace/plugins/flow`) or `INST:` (= `dorkos/.dork/plugins/flow`, the gitignored installed copy of the flow plugin that DorkOS sessions actually load via `.claude/skills/flow__*` symlinks).

**Version skew to know first:** the installed plugin is **v0.5.0** (`INST:.claude-plugin/plugin.json`), the marketplace source is **v0.6.0** (`MKT:.claude-plugin/plugin.json`). `verifying-work/SKILL.md` differs between them (the rubric-missing announcement and the provenance wording are newer in MKT). `executing-specs` review sections match. The **config differs a lot**: INST ships `autonomy.default: "auto"`, every loop `enabled: true`, `perIssue: "sticky-session"`, and `bindings: {workhorse: opus, fast: sonnet}` (`INST:config/config.json:65,75-100,165,228-229`). MKT ships `manual`, every loop `enabled: false`, and no bindings (`MKT:config/config.json:75,85-112,204`). **So every doc that says "autonomous loop is `enabled: false` in v1" is false for this repo's installed copy.**

---

## 1. Repo skills and agents: review before a PR

### creating-pull-requests (`.agents/skills/creating-pull-requests/SKILL.md`, symlinked from `.claude/skills/`)

- **Order:** review the _pushed branch_ before any PR exists. Steps: worktree + local gates → push, open nothing → reviewer checks out the branch → findings/fixes/convergence → squash to one commit + one fragment → then open the PR (`:19-30`).
- **Why (measured 2026-07-27/28):** merge churn, the changelog gate reddening on review-fix commits, an open PR "invites" someone else to arm auto-merge, and the automated review fires on open (`:32-44`).
- **Cost:** CI does not run until the PR opens. Mitigate with `pnpm verify` plus the local changelog gate, or open a **draft** when a runner-only check is the real gate (`:46-50`, `:136-145`).
- **Who reviews / how many rounds:** it does not name a reviewer agent or model and does not cap rounds. It says "Findings, fixes, convergence" (`:27`).
- **CI Claude review:** runs once on non-draft open or ready-for-review, **not** on push, again only when the `re-review` label is added. Nothing runs on a conflicting PR (`:196-205`). Labels: `skip-review`, `review:light`, `review:deep`, `re-review` (auto-cleared) (`:256-282`). `@claude take another look` also works (`:275`). Manual dispatch is `gh workflow run claude-code-review.yml -f pr=N` (`:229-254`).
- **What triggers a re-review:** only the `re-review` label, an `@claude` comment, or a manual dispatch. A rebase after a conflict needs a re-review, because the review never ran (`:221-223`; also `watch-prs.sh` header `CONFLICTING` → "re-arm auto-merge AND add the re-review label").
- **The review is non-blocking.** It is not a required check (`:674-678`).
- **Changelog habits:** `chore(`/`ci(` for commits that users won't see; curate the seeded stub in the same commit. Run the local gate `changelog_backfill.py --validate` then `--check` (`:66-122`).
- **Stale parts (they contradict ADR 260728-112203 and AGENTS.md's CI section):**
  - `:284-300` still describes "requires branches to be up to date" and uses `gh pr merge --auto --squash`. Strict is **off** (live: `strict:false`; ADR `:57`).
  - `:350-374` "An armed PR that is BEHIND stalls forever": this is obsolete under the queue (the ADR removed strict for exactly this reason).
  - `:376-379` "outside it nobody arms auto-merge unless you do": contradicts `merge-tail.yml` (AGENTS.md CI section; `:198-211` of orchestrating-parallel-work).
  - `:398` lists the required checks as `typecheck, fragment-present, no-fragment-under-skip-label, version-outranks-base`. Live classic protection (read via gh api 2026-09-19): `typecheck, fragment-present, no-fragment-under-skip-label, version-outranks-base, db-check, browser-test`, `enforce_admins: true`, `required_pull_request_reviews: null`. The **ruleset 19893973 "main: merge queue"** also requires `test, lint, credential-free-build`. AGENTS.md's CI section never mentions `db-check` or `credential-free-build` as required.
  - `:510` re-arms with `--squash`, which contradicts its own `:302-306` ("drop the strategy flag").

### requesting-code-review (`.claude/skills/requesting-code-review/SKILL.md`, a real dir, not in `.agents/`)

- Dispatch `subagent_type: "code-reviewer"` with WHAT_WAS_IMPLEMENTED / PLAN / BASE_SHA / HEAD_SHA / DESCRIPTION (`:39-49`). The reviewer never gets your session history (`:8`).
- **Mandatory:** after each batch in `/flow:execute` ("holistic batch-level review, **not per-task review**"), after a major feature, and before merging to main (`:14-18`, `:128-132`).
- Act on severity: Critical fix now, Important fix before continuing, Minor noted; push back with evidence (`:61-66`). Clean up review worktrees with `/worktree:prune` (`:68-95`).
- It sets no model and no round count. There is also a lightweight self-trace option (`:26-28`).
- **Contradiction:** the flow `executing-specs` skill does a **per-task** two-stage review (see §2). This skill says batch-level, not per-task.

### receiving-code-review (`.claude/skills/receiving-code-review/SKILL.md`)

- READ→UNDERSTAND→VERIFY→EVALUATE→RESPOND→IMPLEMENT (`:16-25`). No performative agreement (`:27-40`). Treat external feedback skeptically (`:71-91`). Check ADRs and contributing/ before accepting a pattern change (`:93-108`). Order: blocking, then simple, then complex, and test each one (`:122-133`). Reply in the GitHub thread (`:241-243`). It says nothing about the number of rounds or who reviews.

### verification-before-completion (`.agents/skills/verification-before-completion/SKILL.md`)

- Iron Law: no completion claim without fresh evidence (`:16-22`). Commands table: `pnpm test -- --run`, `pnpm vitest run <file>`, `pnpm lint`, `pnpm typecheck`, `pnpm build` (`:40-50`). Always applies before commit or PR (`:154-163`). Review is not covered. It does not mention `pnpm verify`, the repo's pre-PR loop-closer per AGENTS.md.

### code-reviewer agent (`.claude/agents/code-reviewer.md`)

- `model: inherit` (`:4`). So when it is dispatched without a model it runs on the caller's model, which is the exact case the flow skills warn against (`MKT:skills/verifying-work/SKILL.md:102-108`, `:382-383`).
- "Do not trust the report" (`:11-13`). Six-part process (`:15-80`). Severity output format with a "Ready to merge?" verdict (`:114-151`).
- Stale details: `:43` lists SDK confinement for `claude-agent-sdk` only (Codex and OpenCode are missing, per AGENTS.md Hard Rule 2). `:63` says "(`pnpm vitest run`)" as the fresh-evidence command, but AGENTS.md bans bare `vitest run` for full runs.
- It does **not** reference `REVIEW.md` (the rubric that flow's adversarial reviewer and orchestrating-parallel-work use).

### orchestrating-parallel-work, landing section (`.claude/skills/orchestrating-parallel-work/SKILL.md:105-270`)

- Per-batch chain: worktree → implement → verify locally (every test that renders a changed component, and drive the real UI) → **adversarial review before the PR opens by a _separate_ agent against `REVIEW.md`, with a brief that names failure modes** ("REVIEW.md → Failure modes worth hunting by name"). About 45 real defects were found pre-PR this way. **The reviewer re-verifies its own findings rather than accepting the fix report** (`:139-160`). Then finalize via creating-pull-requests (`:161-164`).
- Landing rules: check load-sensitivity before debugging a red test; `chore(`/`ci(` or curate the stub; format before every push; **verify armed-or-queued** (a queued PR reports `autoMergeRequest: null`); `merge-tail.yml` arms on a 10-minute tick (`:166-211`). Rebase to both intents, then run the full `pnpm test -- --run`, then re-push and re-request the review (`:212-226`). Test-merge by hand before the queue (`:227-236`).
- Cap about 4 live worktrees (`:135-137`). Continue veterans with SendMessage (`:247-249`).
- It names no model or round count. The agent table maps review to `code-reviewer` (`:285`).

### working-in-worktrees (`.claude/skills/working-in-worktrees/SKILL.md`)

- Nothing about review beyond: do the work, commit, push, open the PR from the worktree branch (`:141`), clean up after merge or sweep at session start (`:145-154`, which notes that review checkouts were 47 of the 107 swept worktrees). A native-worktree push uses `--no-verify` because there are no node_modules, "CI is the backstop" (`:164`). Pin `BASE=$(git rev-parse origin/main)` (`:64-79`).

### REVIEW.md (the rubric, 407 lines)

- Read by the CI workflow and by flow's adversarial reviewer (`MKT:config/config.json:176` `rubric: "REVIEW.md"`). Process (`:8-24`), "Failure modes worth hunting by name" (`:26`), nit cap (`:126`), do-not-report list (`:132`), dangling-reference sweep (`:160`), verification bar (`:372-376`).
- **Re-review convergence** (`:378-388`): re-reviews are explicit (label or `@claude`). Read the prior comments, review only the delta, and post only new or still-unaddressed Important findings.

### CI Claude review workflow (`.github/workflows/claude-code-review.yml`)

- Triggers: `pull_request` `[opened, ready_for_review, reopened, labeled]` plus `workflow_dispatch` (`:170-171`, `:195`). Job gate: same-repo, not draft, no `skip-review`, and on `labeled` only for `re-review` (`:260-265`).
- Turn budget: 50, or 100 when the PR changes more than 30 files (`:219-221`, `:530-546`). `claude_args` pins tools and max-turns only. **No `--model`**, so it runs on the action's default model under `CLAUDE_CODE_OAUTH_TOKEN` (`:824-829`).
- The check goes green only when the review posted a recognized verdict (DOR-1665) (`:548-560`).

---

## 2. /flow VERIFY stage and EXECUTE per-task review

### verifying-work (`MKT:skills/verifying-work/SKILL.md`; INST copy is v0.5.0 with minor wording differences)

1. **Correctness trace (self-review)**: trace every changed function (what it does, its callers and callees) and fix in place. "The only review you perform on your own work" (`:35-49`).
2. **Verification gate**: Iron Law. `pnpm vitest run [path]`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, plus a red→green symptom test, scaled to the change and package-filtered where possible (`:51-69`). **It does not name `pnpm verify`.**
3. **Structured code review, only when `review.adversarial` is false**: a fresh subagent. Advisory, non-blocking, no rubric (`:71-87`).
4. **Adversarial review before the PR exists** (default ON, and it **blocks**) (`:89-130`):
   - `review.reviewers` separate fresh agents, **default 1**, never the implementing context (`:97-101`).
   - **Model must be named**: `models.tiers.review` (default `workhorse`) resolved through `models.bindings`. It never inherits, and a failure falls sideways or down, never up (`:102-110`). This repo's INST config binds `workhorse → opus` (`INST:config/config.json:223,228`). The MKT `config.local.json` does too (`MKT:config/config.local.json:15-19`).
   - Inputs: the diff (base/head SHAs), the rubric (`REVIEW.md`), and the intent (the work item or the `03-tasks.json` task). **Not** the implementer's narrative (`:111-120`).
   - Multiple reviewers are reconciled by **union**: any blocking finding blocks unless rebutted (`:121-124`).
   - **Converge loop**: fix or rebut, re-review the updated diff, and **repeat until a pass returns nothing blocking**. There is no round cap (`:125-127`). Re-run the step-2 gate if code changed (`:128-130`).
   - Degradation (announced, never silent): the rubric is missing, the gate is off, or there is no second agent (so a fresh context gets diff, rubric and intent only) (`:132-164`).
5. **Proof bundle**: `selectEvidence` driven by the `evidence` config (ui: auto → GIF if interactive, WebM if unattended; logic: test-summary) (`:166-218`; `MKT:config/config.json:220-228`).
6. **Attach evidence + open the PR**: the PR is opened or updated from `templates/pr.md` with a **review-status line** (gate ran / skipped / degraded, against which rubric). `attachEvidence` goes to the tracker. The provenance stamp is once per run on the PR body. Choose the closing vs non-closing reference deliberately (`:220-337`).
   - **So the PR opens at step 6, after adversarial convergence and proof.**
7. **Human-review gate**: always on. Transition to In Review, `assignToHuman`, **stop/park**. REVIEW has no skill. "In v1 there is no approval detection": the human approves and merges, then runs `/flow:done` (`:339-358`).

- The `/flow:verify` command just loads the skill (`MKT:commands/verify.md:12-17`). `flow-drain` "carries it to its human-review gate" and stops there (`MKT:skills/flow-drain/SKILL.md:4,39-43`).

### Flow config relevant to review

| Key                                           | MKT source                                                                                                 | INST (what dorkos uses)                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `review.adversarial` / `rubric` / `reviewers` | true / REVIEW.md / 1 (`:174-178`)                                                                          | same (`:215-218`)                            |
| `models.tiers.review`                         | workhorse (`:200`)                                                                                         | workhorse (`:223`)                           |
| `models.bindings`                             | `{}` (`:204`), local `workhorse: opus, fast: sonnet` (`config.local.json:15-19`)                           | `workhorse: opus, fast: sonnet` (`:228-229`) |
| `stages.review.humanGate`                     | true (`:64-66`)                                                                                            | true (`:54-56`)                              |
| `gates.review`                                | mergeOnApproval, requireCiGreen, ciRetries 1, reapproveOnFunctionalChange, maxMergeAttempts 3 (`:157-167`) | same (`:149-156`)                            |
| `autonomy.default` / loops                    | manual / all false                                                                                         | **auto / all true** (`:65,75-100`)           |

- In `dorkos/`, no repo-level `.flow/config.json` exists. `.dork/flow/` holds only `flow-state.json`. The config that applies is INST's `config/config.json` (gitignored via `.gitignore:105 .dork/plugins/`) plus `config.local.json` (trackerAccount only).

### EXECUTE per-task review (`MKT:skills/executing-specs/SKILL.md`)

- **Step D: Two-Stage Review, per task** (`:343-370`): reviewers are the `review` class with the model named (`:347`).
  - Stage 1, spec compliance (did it do everything asked, nothing extra, no misread). Fix by continuing the implementer's worker, then re-review (`:349-357`).
  - Stage 2, code quality: a fresh reviewer (or the harness code-review agent) gets WHAT/PLAN/BASE/HEAD/DESCRIPTION. Critical or Important findings mean fix and re-review. The reviewer is never the implementer (`:359-368`). Stage 2 never runs before Stage 1 passes (`:370`).
  - Delegation policy: every worker names its model. Tiers: implementation, review and analysis on workhorse, mechanical on fast (`:33-57`).
- This contradicts requesting-code-review `:16` ("holistic batch-level review, not per-task").

---

## 3. How many review passes before merge (best estimate, typical /flow change)

Layers, in order:

1. **EXECUTE per-task two-stage review**: 2 reviewer dispatches per task, each re-run until clean (`executing-specs:343-370`). With a typical 3-6 task spec that is about 6-12 dispatches, plus maybe 1-3 re-reviews.
2. **VERIFY self correctness trace**: 1 pass, by the implementer (`verifying-work:35-49`).
3. **VERIFY adversarial loop**: 1 reviewer per round (`reviewers: 1`), Opus via `workhorse → opus`, loop until nothing blocks. Typical is 2-3 rounds. Evidence: the MEMORY index entry "worker+fresh-reviewer loop caught defects every round" (project_github_issues_1840_1841), and orchestrating-parallel-work's "reviewer re-verifies its own findings" (`:158-160`).
4. **CI Claude review**: 1 on open or ready (`claude-code-review.yml:170-171`). Plus 0-2 `re-review` passes when it posts findings. Unresolved inline threads block merge-tail arming (`should-arm-automerge.sh:112`), and a pending review check blocks it too (`:119`).
5. **Human**: procedurally required by flow (humanGate), but **not enforced by GitHub**. Live protection has `required_pull_request_reviews: null`, conversation resolution is off, and `merge-tail.yml` arms any green, unthreaded, unheld PR every 10 minutes (`should-arm-automerge.sh:1-23,86-121`; ADR 260728 `:115-118` admits "lands code without a human at the moment of merge"). Only a `hold` label, `CHANGES_REQUESTED`, or an unresolved thread stops it.

**Estimate:** about **5 distinct review layers**, and about **10-18 reviewer passes** for a multi-task spec (roughly 8 per-task + 1 self + 2-3 adversarial + 1-2 CI + 0-1 human). For a single-task or ad-hoc change it is about 4-6 passes (1 self + 2-3 adversarial + 1-2 CI). All of these except the CI review are Opus-tier when routed through flow (`workhorse → opus`). The CI review uses the action's default model.

---

## 4. Release: `/system:release` (`.claude/commands/system/release.md`)

1. **Pre-flight** (`:35-70`): the working dir must be clean (`:39-42`, **which says "commit or stash"; that contradicts Hard Rule 6's stash ban**). Must be on `main` with `git pull --ff-only` (`:45-50`). Main is push-protected and merges only via the queue, so work happens in a worktree → PR → tag the MERGED squash SHA → publish npm last (`:52-59`). Read `VERSION` and the last tag (`:61-70`).
   - Check 5, changelog completeness: a backstop, since the PR gate already enforces fragments; offers backfill (`:72-92`).
   - Check 6, config schema migration drift (conf migration keyed by version) (`:94-192`).
   - Check 7: `scripts/assert-migrations-current.sh` (Drizzle) (`:194-202`).
2. **Version analysis** (`:206-250`): explicit bump, or auto-detect via a `context-isolator` on **haiku** (`:214`).
3. **Curate + present** (`:254-296`): drop builder-only bullets and fixes to unreleased features (`:258-271`). **PATCH/MINOR proceed with no prompt. MAJOR asks** (`:281-296`). `--dry-run` stops here (`:279`).
4. **Harness maintenance** (`:300-313`): `/adr:review`, `/docs:reconcile`, stamp `docs/.last-reviewed` and `research/.last-curated`.
5. **Execute** (`:317-588`):
   - 6.1 check the tag does not exist. 6.2 write `VERSION`. 6.3 `npm version` in `packages/cli`, root, `apps/desktop`, `packages/cloud-api` (lockstep, pinned by `packaging.test.ts`) (`:319-354`).
   - 6.4 compile fragments → `## [X.Y.Z]` in `CHANGELOG.md`, `git rm` the fragments, refresh the link ref, 10-version cap into `changelog/archive/` (`:356-365`).
   - 6.5 sync `docs/changelog.mdx` and `docs/changelog-archive.mdx` (`:367-369`). 6.6 media freshness, shot selection, `capture:archive` (`:371-441`). 6.7 blog post `blog/dorkos-X-Y-Z.mdx` (`:443-474`).
   - 6.8 commit `chore(release): vX.Y.Z` on `release/vX.Y.Z` in `.claude/worktrees/release-vX.Y.Z`, `pnpm install`, push, `gh pr create --label skip-changelog`, `gh pr merge --auto` (`:476-498`). Do not tag yet. Blog images must use relative paths or the Vercel build 404s (`:500-506`).
   - 6.9 after the queue merges: `git tag -a vX.Y.Z <merged-squash-sha>`, push the tag. Check for stranded fragments (`git ls-tree vX.Y.Z changelog/unreleased/`) (`:508-528`).
   - 6.10 `pnpm run publish:cli` then `publish:cloud-api` (cloud-api is mandatory when changed). npm takes about 10-15 minutes to propagate, `publish-docker.yml` waits only about 5, so its first run fails (DOR-1606) (`:530-550`). Auth is a granular npm token (`:552-569`).
   - 6.11 `gh release create vX.Y.Z --draft` with narrative notes. **This is required**: `desktop-release.yml` is attach-only and fails if the draft never appears (`:571-588`).
6. **Report + feedback sweep** (`:592-610`): `/feedback:triage --sweep` is the only sanctioned trigger.

**Tag-driven automation** (all on `push: tags: ['v*']`):

- `desktop-release.yml:50-59`: builds signed and notarized macOS plus the unsigned Windows alpha, attaches them to the draft, and `publish-release` flips the draft to published when macOS passes. Windows has `continue-on-error` (release.md `:277`, `:588`).
- `publish-docker.yml:3-6`: `ghcr.io/dork-labs/dorkos:{version}` (release.md `:594`).
- `update-homebrew.yml:3-24`: the CLI formula on the tag, the desktop cask on `release: published`. **release.md never mentions Homebrew.**

**Site deploy to Vercel:**

- There is no deploy workflow in `.github/workflows/`. The site deploys through **Vercel's Git integration**. `apps/site/vercel.json`: `ignoreCommand: node scripts/ignore-build.mjs`, `buildCommand: pnpm db:migrate && pnpm exec turbo run build --filter=@dorkos/site`, and two hourly crons.
- `apps/site/scripts/ignore-build.mjs:6-30`: build if there is no previous SHA, if `docs/` or `blog/` changed, or otherwise per `turbo-ignore`.
- The site turbo `build` includes `docs/**` and `blog/**` inputs and keys on `VERCEL_ENV` (`apps/site/turbo.json`).
- Project `dorkos-web`, team `dopel` (`contributing/feedback-pipeline-ops.md:22`). Gotchas: env changes need a redeploy, and Vercel sometimes cancels the main auto-deploy (use `vercel redeploy <url>`) (`:69-76`).
- CI's `site-build.yml` exists because a Vercel-only build failure blocked production (`:1-13`). It is not a required check (AGENTS.md CI section).
- Note that the build command runs `pnpm db:migrate` against the deploy's DB.

**Ruleset admin bypass for the release push:** this is **not documented anywhere in the repo** (grepped contributing/, decisions/, .claude/commands, .claude/rules, .agents/skills, AGENTS.md). It lives only in auto-memory `project_v0640_release.md`: ruleset 19893973 got `bypass_actors: [{actor_id:5, RepositoryRole, always}]`, and classic `enforce_admins` had to be toggled off and on around the push. Live state confirms the bypass actor and `enforce_admins: true`. The current release.md avoids the need entirely by landing through a PR (`:52-59`, `:476-498`), so the bypass is now vestigial for releases.

---

## 5. ADRs

### 260728-112203: The merge queue replaces require-branches-up-to-date, and arming a merge is somebody's job (accepted)

- **Context:** on 2026-07-28, 6 of 9 PRs were green and armed but stuck, the oldest for 9 hours and 17 commits behind (`:21-25`). Two faults: nobody armed auto-merge, because ADR-0276's ladder only runs in autonomous mode (off) and the skill's `gh pr merge --auto` "is prose that nothing executes" (`:29-34`); and `strict=true` plus auto-merge never updates a branch (`:36-42`). `strict` was load-bearing for `operating-skills-version-check.yml` (`:44-49`).
- **Decision:**
  - The merge queue replaces `strict`, which goes false (`:53-58`). This is strictly stronger, since it re-runs on `merge_group.base_sha` (`:60-64`).
  - Every required check must report on `merge_group` (`:66-68`).
  - Policy checks (fragment coverage) are decided at PR time. Validity re-runs in the queue (`:70-75`).
  - `merge-tail.yml` arms finished PRs every 10 minutes, using `should-arm-automerge.sh` (affirmative), and never updates branches (`:77-82`).
  - **Batch size 1** (`:84-87`).
- **Consequences:**
  - Positive (`:91-100`): branch currency stops being work; the combined-tree class (#488/#489) becomes catchable; version-bump collisions fail in the queue.
  - Negative (`:102-118`): no `push: main` runs after a `GITHUB_TOKEN` merge (losing cache warming); `version-outranks-base` depends on the queue staying on; coverage is not re-checked at merge; **automated arming lands code without a human at the moment of merge**, which is why the fixture suite exists.
  - Note: the old `strict` comment was rewritten in the same change (`:122-124`).
- **Drift vs live:** the ruleset has `max_entries_to_merge: 5, max_entries_to_build: 5, min_entries_to_merge: 1, grouping ALLGREEN` (gh api), so the queue **can batch up to 5**, not "batch size 1".

### 0276: Auto-Merge on Approval, Guarded by a Recovery Ladder (accepted)

- Status note (2026-08-06 audit): the ladder shipped in the flow plugin behind autonomous mode. The in-repo arming mechanism is `merge-tail.yml` (`:14-16`).
- Context: an approval authorizes one state that can go stale (`:20`).
- Decision: on approval plus green CI, auto-merge, close, and tear down. At merge time, check mergeable, CI-green and functionally-unchanged. Mechanical failures (clean rebase, lockfile conflict, CI flake) get resolved and announced. Behavior-altering changes bounce or get re-approved. A circuit breaker stops runaway bouncing (`:24`).
- Consequences: a hands-off tail "without ever shipping unreviewed behavior", and drift forces re-approval (`:30-31`), but more merge-time logic and a careful mechanical/functional boundary (`:35-36`).
- Note: INST config has autonomy on (`auto`, loops enabled), so the ladder may actually be live in this repo's installed plugin. That contradicts both ADRs' "disabled in v1" premise.

### Other CI-related ADRs

| ADR                                                              | Status             | One line                                                                                                                         |
| ---------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `0004-monorepo-with-turborepo.md`                                | accepted           | Turborepo task graph. **Stale** (`:24` says npm workspaces, `@dorkos/web`, `@dorkos/roadmap`)                                    |
| `0041-lefthook-pre-commit-for-migration-enforcement.md`          | accepted           | Lefthook pre-commit runs `drizzle-kit generate` when schema files are staged; `prepare` installs hooks (`:20-22`)                |
| `0312-timestamp-identifiers-for-adrs-and-specs.md`               | accepted           | `YYMMDD-HHMMSS` ids to kill merge conflicts on `nextNumber` (`:30-36`)                                                           |
| `0313-defer-changelog-conflict-fix.md`                           | superseded         | Sentinel and `merge=union` rejected; deferred to fragments (`:14`, `:29-35`)                                                     |
| `260707-231641-changelog-fragments.md`                           | accepted           | One fragment per change in `changelog/unreleased/`; only `/system:release` writes CHANGELOG.md; 10-version cap (`:35-52`)        |
| `260725-133222-eval-isolation-and-cadence-are-infrastructure.md` | accepted           | Evals: per-PR only behind a `run-evals` label, nightly credential-free, credentialed runs by `workflow_dispatch` only (`:20-22`) |
| `0238-port-to-zod-cc-validator-with-weekly-sync-cron.md`         | accepted (amended) | The weekly CI sync cron was removed 2026-06-13 (`:14-18`)                                                                        |
| `0314-flow-plugin-delegates-id-allocation-to-host.md`            | accepted           | Flow delegates id/manifest allocation to host tooling (`:26-29`)                                                                 |
| `0276`, `260728-112203`                                          | accepted           | above                                                                                                                            |

There is no ADR for: the PR/merge_group test split and sharding, the full-lint required check (DOR-627), the pre-push format check (DOR-1839), `site-build`, or the Claude PR review workflow. Those live only in AGENTS.md and workflow headers.

---

## 6. Contributing docs on CI

**There is no dedicated CI, merge-queue, or lefthook guide in `contributing/`, and `contributing/INDEX.md` has no CI entry.** AGENTS.md's "## CI" section is the only consolidated CI doc. Scattered mentions:

| Doc                                          | What it says                                                                                                                                                                             | Stale vs AGENTS.md?                                                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser-testing.md:334,350`                 | `browser-test` is a pass-through on PRs, and shards run only in the queue, so copy changes surface there and eject the PR. The copy-check job is advisory but blocks merge-tail arming   | consistent. (`browser-test` **is** required in live protection; the advisory one is the copy job)                                                               |
| `harness-sync.md:96,243,309`                 | the queue's full sweep is decisive for cross-package guards; `harness-windows.yml` is advisory with `merge_group`; `pnpm verify` is affected-only, so `meta/` edits need a manual vitest | consistent                                                                                                                                                      |
| `boundary-guard.md:3,27,58`                  | `check-boundary.ts` runs in `typecheck` on `pull_request` and `merge_group`; the term list comes from the `BOUNDARY_TERMS` secret                                                        | consistent                                                                                                                                                      |
| `desktop-app-development.md:159,277,438,442` | `desktop-smoke.yml` runs on PRs touching `apps/desktop/**` and on main pushes; desktop rides `v*` tags                                                                                   | `:438` says the workflow "attaches... to the GitHub Release the command already created" but does not mention the draft/publish flip (release.md `:588`). Minor |
| `architecture.md:1096`                       | `cli-smoke-test.yml` "runs ... on every push to main"                                                                                                                                    | **incomplete**: it also runs on path-filtered PRs (`cli-smoke-test.yml:4-18`)                                                                                   |
| `docker-testing.md:5,15,109-111`             | CLI smoke on "every push to main"; the table says path-filtered                                                                                                                          | slightly inconsistent within itself                                                                                                                             |
| `marketplace-installs.md:632-634`            | "the repository has no test workflow in `.github/workflows/` at all"                                                                                                                     | **stale**: `test.yml` exists (pull_request + merge_group, sharded)                                                                                              |
| `environment-variables.md:32`                | `VITEST_MAX_WORKERS=2 pnpm verify` / `git push` on busy machines                                                                                                                         | consistent                                                                                                                                                      |
| `dependency-overrides.md:94`                 | a Playwright bump ejected #1855 from the queue twice                                                                                                                                     | consistent                                                                                                                                                      |
| `parallel-execution.md:303-315`              | points to orchestrating-parallel-work for landing                                                                                                                                        | consistent                                                                                                                                                      |
| `flow-engine.md:152-174`                     | ADR-0276's ladder runs only in the autonomous loop; with `enabled: false` nothing merges; `merge-tail.yml` fills the gap                                                                 | **contradicted by INST config** (autonomy auto, loops true)                                                                                                     |
| `room-repos.md:324`                          | mentions provenance and the merge queue in passing                                                                                                                                       | n/a                                                                                                                                                             |

AGENTS.md's CI section also omits things that are true live: required `db-check` and `credential-free-build`, and the queue batching up to 5.

`lefthook.yml` (for reference): pre-commit runs prettier on staged files, the db-migrations generator, dir-size, affected `turbo lint` and `turbo typecheck` with `TURBO_SCM_BASE=origin/main` (`:1-69`). Pre-push runs the formatting check (`scripts/pre-push-format-check.sh`) and affected tests (`:72-259`). `pnpm verify` = `test:scripts && lint:root && turbo typecheck lint --affected && turbo test --affected --concurrency=1` (`package.json:16`).

---

## 7. changelog/README.md: fragment rules and the gate

- One file per change under `changelog/unreleased/<YYMMDD-HHMMSS>-<slug>.md` (`:3-6`, `:30-41`). Rationale: 255 commits touched `[Unreleased]` in 3 months (`:10-15`).
- Body: optional `covers:` frontmatter, then Keep a Changelog headings. The 6 standard headings plus `### Note for people upgrading` are allowed. `--validate` rejects any other heading (`:43-58`).
- **`covers:`** (`:79-142`): items are an exact commit subject, a SHA (7-40 characters), or `"#PR"` (the whole PR, CI-only). The post-commit hook writes the subject. A squash `(#N)` suffix is ignored. A stale declaration falls back to word comparison. Do not claim ignored (`chore`/`docs`) commits. A malformed block fails outright.
- **The gate** (`.github/workflows/changelog-fragment-check.yml`), two required jobs:
  - `fragment-present`: **validity** (`--validate --changed-only`, no `skip-changelog` bypass, runs on PR and merge_group) (`:117-120`), plus **coverage** (`--check --changed-only --pr N`, PR-only, skipped under `skip-changelog`) (`:135-140`). On merge_group it only notes that coverage was decided at PR time (`:144-151`).
  - `no-fragment-under-skip-label`: fails if a `skip-changelog` PR adds a new fragment (`:178-258`).
  - README "who gets blamed": validity is scoped to fragments the PR touched, coverage to the PR's whole commit range (`:144-165`).
- Creation: the post-commit hook `.claude/git-hooks/changelog-populator.py` maps `feat`→Added, `fix`→Fixed, `refactor`/`perf`→Changed, and skips docs/style/test/build/ci/chore/Merge/Revert (`:167-176`). Builder-only work takes `skip-changelog` even as feat/fix (`:184-188`).
- **Seeded fragments** carry `<!-- dorkos-changelog:seeded … -->`. `--validate` fails on the marker with no bypass. Rewrite the bullet and delete the marker, or delete the fragment. This is an honor system: deleting only the marker defeats it (`:190-232`).
- Media embedding via absolute `dorkos.ai/product/...` URLs (`:234-256`). Note this conflicts with release.md `:501-504` for **blog** posts, where images must use relative paths; the README scope is fragments and release notes.
- At release: `/system:release` compiles in standard order Added…Security, drops intra-release fixes, strips `covers:`, writes `## [X.Y.Z]`, deletes the fragments, and keeps the 10-version cap (`:258-274`). **Gap:** neither this list nor release.md 6.4 (`:361`) says where `### Note for people upgrading` goes at compile time, although `--validate` accepts it.
