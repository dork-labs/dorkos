# CI workflows, set B: review, merge tail, release, Dependabot, desktop, evals

Repo: `dorkos` at `main` 9688d2db0, read 2026-09-19. Paths are relative to the repo root, cited as `file:line`.
Live evidence comes from read-only `gh run list` / `gh api` / `gh secret list` (names only).

---

## 0. Top findings (verified)

1. **`update-homebrew.yml` has failed on every release for at least 2 months.** All 24 `push` runs and the 1 `release` run in the history failed. The failing step is "Checkout tap repository": `##[error]Input required and not supplied: token`, because `secrets.HOMEBREW_TAP_TOKEN` (`update-homebrew.yml:90`) is **not set**. `gh secret list` shows no such secret. So neither the CLI formula nor the desktop cask in `dork-labs/homebrew-dorkos` gets bumped automatically. Latest failure: v0.75.1, 2026-09-14.
2. **The `release: published` path in update-homebrew can never fire from the normal release flow.** `desktop-release.yml` `publish-release` flips the draft with `GH_TOKEN: secrets.GITHUB_TOKEN` (`desktop-release.yml:463,471`). GitHub creates no workflow runs for events that `GITHUB_TOKEN` causes, and merge-tail's own header documents that rule (`merge-tail.yml:25-32`). So the cask-bump trigger (`update-homebrew.yml:10-13,18-19`) is dead by design, and the header's "release-published run is the one that lands the cask bump" (`update-homebrew.yml:108-109`) does not hold. Only one `release`-event run exists in history (v0.49.0, 2026-07-14), which was probably a hand publish. Fixing the token alone will NOT fix the cask.
3. **The `review` check stops gating merge-tail after the next push.** The review does not run on `synchronize` (`claude-code-review.yml:168-171`), and its check-run is attached to the PR head SHA at the time it ran. After a push, the new head has no `review` check-run at all. It is not red and not pending, so `should-arm-automerge.sh` never sees it. Measured: the final head SHAs of merged PRs #1917, #1918, #1919, #1922 and #1923 have **zero** `review` check-runs, and Dependabot PR #1856's red review sits on 5d013c96 while its head is 56007b58 (pushed by lockfile-repair). A red review therefore blocks arming only until someone pushes. Unresolved inline threads are the only lasting review signal merge-tail reads.
4. **Claude review fails on every Dependabot PR.** The action refuses the run with `Workflow initiated by non-human actor: dependabot (type: Bot). Add bot to allowed_bots list` (run 34852304867, PR #1856). The job `if` (`claude-code-review.yml:259-266`) admits Dependabot because it is a same-repo PR, not a draft, and has no `skip-review`. There are also no Dependabot-scoped secrets (`gh secret list --app dependabot` is empty), so the OAuth token would be empty anyway. Result: a red `review` plus a "review never started" comment on each Dependabot PR, which lockfile-repair's push then erases (see finding 3). Dependabot PRs get `review:light` (`dependabot.yml:139-141`), not `skip-review`.
5. **No model is pinned anywhere.** Neither `claude_args` block passes `--model` (`claude-code-review.yml:824-829`, `claude.yml:62-64`). Both run `anthropics/claude-code-action@v1`, a floating major tag (`claude-code-review.yml:584`, `claude.yml:56`), so the model and action behavior move with upstream.
6. **Several jobs have no `timeout-minutes`, so GitHub's 6-hour default applies:** `claude.yml` (`claude`), `merge-tail.yml` (`arm`, which runs every 10 minutes and serializes behind itself because `cancel-in-progress: false`), all five `desktop-release.yml` jobs (including macOS notarization), and `update-homebrew.yml`. `publish-docker.yml:26` explicitly added a timeout after a v0.52.0 QEMU hang burned hours. The same hazard is unguarded in the jobs listed above.
7. **`ANTHROPIC_API_KEY` is not a repo secret.** The evals credentialed job falls back to `CLAUDE_CODE_OAUTH_TOKEN` (`evals.yml:183-191`), so dispatched evals draw on the same subscription as PR review and `@claude`.
8. No workflow in this set uses a turbo remote cache (`TURBO_TOKEN`/`TURBO_TEAM` never appear). `desktop-renderer.yml:112` states "there is no remote turbo cache in CI". Caching is limited to `setup-node cache: pnpm` and buildx `type=gha` in publish-docker.

---

## 1. claude-code-review.yml (1133 lines)

**Purpose (header `:3-11`)**: automated inline PR review. It runs on demand rather than on every push. It is the "auto" half; `claude.yml` is the interactive half.

### Triggers

| Trigger             | Detail                                                                                                                                                       | Cite                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `pull_request`      | types `opened, ready_for_review, reopened, labeled`. **No `synchronize`**, so pushes never review                                                            | `:170-171`, rationale `:168-169` |
| `workflow_dispatch` | input `pr` (string, required). A manual review of any open same-repo PR, meant as the escape hatch for conflicted PRs and for testing edits to this workflow | `:195-200`, rationale `:173-194` |
| `merge_group`       | **none**. The `review` check "is not a required check and must never report on `merge_group`"                                                                | `:1070-1071`                     |

### Concurrency

- `group: claude-review-${{ pull_request.number || inputs.pr }}` (`:241`)
- `cancel-in-progress: ${{ event.action != 'labeled' || label.name == 're-review' }}` (`:242`). A label other than `re-review` does not cancel an in-flight review. Without that rule, opening a PR with a `review:*` label let the `labeled` run cancel the `opened` run and then skip (this happened on PRs #142 and #161, `:223-232`). A dispatch evaluates to true, so it cancels an in-flight automatic review (`:233-239`).
- Observed: opening a PR with N labels yields one review plus N skipped or cancelled runs. That matches GitHub's rule that only one pending run is kept per group.

### Permissions (`:244-248`)

`contents: read`, `pull-requests: write`, `issues: read`, `id-token: write` (the OIDC token mints the action's App token with contents/PR/issues write, `:86-87`, `:855-856`).

### Workflow env (`:204-221`)

`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`, `DEFAULT_BRANCH` (the trust anchor), `REVIEW_MAX_TURNS_DEFAULT: '50'`, `REVIEW_MAX_TURNS_LARGE: '100'`, `REVIEW_LARGE_PR_FILE_THRESHOLD: '30'`.

### Job `review` (check context name: **`review`**, confirmed via the check-runs API)

- `if` (`:259-266`): `workflow_dispatch` OR (same-repo head AND `draft == false` AND no `skip-review` label AND (event is not `labeled` OR the label is `re-review`)).
  - **Draft handling**: drafts are skipped. The review fires on `ready_for_review`. Dispatch ignores draft and `skip-review` (`:192-194`).
  - **Fork PRs**: skipped on `pull_request`. Refused on dispatch in the "Resolve target PR" step (`:305-311`).
- `runs-on: ubuntu-latest` (`:267`), `timeout-minutes: 25` (`:272`). The timeout bounds a runaway session if `--max-turns` is not honored.
- No cache, no artifacts, no pnpm install.

### Steps

| #   | Step                                        | Behavior                                                                                                                                                                                                                                                                                           | Cite         |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1   | Resolve target PR                           | Validates that the dispatch input is numeric and refuses fork heads. Outputs `number`                                                                                                                                                                                                              | `:284-313`   |
| 2   | Checkout                                    | `actions/checkout@v7`, `fetch-depth: 0`. The ref is the PR merge ref on `pull_request` and `refs/pull/N/head` on dispatch                                                                                                                                                                          | `:315-324`   |
| 3   | Revert PR-authored agent config             | **Dispatch only.** Deletes and then restores from `origin/$DEFAULT_BRANCH`: `.claude .mcp.json .claude.json .gitmodules .ripgreprc CLAUDE.md CLAUDE.local.md .husky`. It mirrors the action's own SENSITIVE_PATHS restore, which fires only in a PR context. Fails closed without a default branch | `:326-428`   |
| 4   | Materialize the trusted review helper       | `git show origin/main:scripts/review-gh.sh` goes to `$RUNNER_TEMP/trusted/`, then `chmod 0500`. On failure it posts a PR comment and exits 1. A PR that adds or renames the helper cannot review itself (a bootstrap limitation)                                                                   | `:469-515`   |
| 5   | Record review start time                    | The timestamp cutoff for the verdict probe                                                                                                                                                                                                                                                         | `:523-525`   |
| 6   | Count changed files                         | `changedFiles > 30` sets max_turns to 100, otherwise 50. Degrades to 50 on error                                                                                                                                                                                                                   | `:530-547`   |
| 7   | **Claude Code review**                      | `anthropics/claude-code-action@v1`, `continue-on-error: true`, auth `claude_code_oauth_token: secrets.CLAUDE_CODE_OAUTH_TOKEN`. Env: `REVIEW_REPO`, `REVIEW_PR`, `GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`                                                                                              | `:581-829`   |
| 8   | Verify the review result and posted verdict | `if: always() && review.outcome != 'skipped'`. Runs the trusted `classify-review-failure.sh` taken from main and probes for a bot comment in the window                                                                                                                                            | `:880-1052`  |
| 9   | Decide the check                            | `if: always()`. Red by default; green only when `STANDS == yes` and the outcome is success or failure                                                                                                                                                                                              | `:1080-1102` |
| 10  | Clear re-review label                       | `if: always() && (dispatch OR labeled re-review)`. Removes `re-review`                                                                                                                                                                                                                             | `:1114-1133` |

### claude_args (`:824-829`), the whole reviewer capability surface

```
--tools "Bash,Read,Grep,Glob"
--allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(bash ${{ runner.temp }}/trusted/review-gh.sh:*),Read,Grep,Glob"
--disallowedTools "Read(//proc/**),Read(//sys/**),Read(//etc/**),Read(~/.claude/**),Read(~/.config/**),Read(~/.ssh/**)"
--setting-sources user
--max-turns ${{ steps.pr-size.outputs.max_turns }}
```

- **Model**: none specified. The default comes from action and CLI.
- **max-turns**: 50, or 100 when more than 30 files changed (`:215-221`, `:540-546`).
- `--tools` excludes Agent and task/scheduling tools. The reason: three reviews exited while spawned sub-reviewers were still running (DOR-1948, `:743-752`).
- `--setting-sources user` stops the checkout's `.claude/settings.json` and `.mcp.json` hooks from running. It also drops the repo's own Read deny list (`:717-741`). The double slash in `//etc/**` is load-bearing (`:800-806`).
- The whole block, including the flags, is pinned by `scripts/test-review-classifier.sh` (`:47-53`, `:754-758`).

### Prompt (`:618-716`)

- One-shot review, with no subagents or background work (`:625-628`).
- GitHub access goes only through `review-gh.sh diff|view|summary|inline` (`:630-644`). There is no `gh`, `git`, `grep` or `ls`.
- "Read REVIEW.md and AGENTS.md at the repository root and apply them in full" (`:652-658`). Hard Rule violations are Important.
- **Label intensity** (`:660-666`): the model reads the labels itself via `review-gh.sh view labels`. `review:light` means only Important findings, with no nits and no deletion sweep. `review:deep` means exhaustive, tracing every caller. The workflow itself never branches on `review:*`. Those labels only change prompt behavior, and applying one does not trigger a run (`:254-255`).
- **Re-review detection** (`:667-672`): the model looks for its own prior summary comment. If it finds one, it treats the run as a re-review and posts only new or unaddressed Important findings, with no fresh nits.
- **Inline findings**: on `pull_request` the model uses the `mcp__github_inline_comment__create_inline_comment` tool (`confirmed: true`). On dispatch it uses `review-gh.sh inline`, which POSTs to `repos/$repo/pulls/$pr/comments` (`scripts/review-gh.sh:119`). Both create **review threads**.
- **Summary**: a one-line tally ("1 important, 3 nits") or "No blocking issues found", posted via `review-gh.sh summary`, which runs `gh pr comment` (`scripts/review-gh.sh:90`) (`:712-716`).

### Does it block merge?

- **It never submits a GitHub review** (neither APPROVE nor REQUEST_CHANGES): "Only post GitHub comments" (`:714`). So `reviewDecision` is never set by the bot.
- **The `review` check is not required** (`:1070-1071`). It is PR-only and does not report on merge_group.
- **It gates merge-tail indirectly in two ways:**
  1. A red `review` check makes `should-arm-automerge.sh` return `SKIP failing-checks`. The comment at `:559-560` says "a finished review became a red check that merge-tail will not arm a PR with". **Caveat, from finding 3:** this holds only while the head SHA is unchanged. After any push the check-run no longer exists on the head.
  2. Unresolved inline review threads give `SKIP unresolved-threads` (`merge-tail.yml:179-183`, `should-arm-automerge.sh:112`). This signal persists across pushes.
- **What green means** (`:139-156`). Both conditions must hold: (1) the result message says the review finished cleanly (classifier class `completed`), and (2) a verdict-shaped **bot** comment exists that was created after `SINCE`, matching the regex `[0-9]+ important|[0-9]+ nits?|No blocking issues|No factual issues` (`:959-965`). The action's exit code is an input, never proof on its own. A clean review that overshot `--max-turns` stays green (PR #1409, `:554-560`). Residual gap: any bot's comment in the window satisfies condition (2) (`:940-947`).
- **Failure comments** (`:998-1052`) are worded per class (`no`, `max_turns`, `died`, `completed`, `*`). Each says it is not a finding about the code and invites the `re-review` label.

### Known limitations stated in the file

- A PR with merge conflicts gets **no run at all**, because GitHub cannot build the merge ref (DOR-457, `:114-124`). Workaround: dispatch.
- A PR that edits this workflow cannot review itself. The action's workflow-validation guard skips the review, and the gate turns red (`:126-132`, `:176-191`).
- The step `env:` map is not fenced by the harness. Treat edits to it as security-relevant (`:103-112`).

### Cost controls

- No `synchronize` trigger, plus the label-driven re-review (`:3-8`).
- Turn caps of 50/100, scaled by size (`:215-221`).
- A 25-minute job timeout (`:272`).
- The `skip-review` label.
- `review:light` narrows scope. Dependabot PRs carry it by default (`dependabot.yml:139-141`).
- Auth goes through a subscription OAuth token rather than per-token API billing (`:13-17`).

### Observed (last 30 runs)

14 success, 9 skipped, 4 cancelled, 2 failure, 1 dispatch success.

---

## 2. REVIEW.md structure (407 lines)

1. **How to review (process)** `:8-24`: get the diff and file list via the harness helper, trace callers outward, verify every finding with a file:line, then rank and cap.
2. **Failure modes worth hunting by name** `:26-94`: trusted region interpolating untrusted strings; declared/validated/documented/unreachable; inert where it ships [shell]; a comment is a claim; a fix that makes things worse; semantic conflict without markers [shell]; a clean auto-merge composing two correct changes into a bug [shell]; environment false-reds. Hunts that need a shell must be posted as 🟡 with the exact command, because the CI reviewer has no shell (`:33-37`).
3. **What Important (🔴) means** `:96-124`: logic bugs, security, and Hard Rule violations (FSD, SDK confinement, the os.homedir ban with 6 carve-outs, marketplace rollback). Architecture and style are 🟡 at most.
4. **Cap the nits** `:126-130`: at most 5 🟡. If everything is a nit, the summary opens "No blocking issues."
5. **Do not report** `:132-139`: anything lint, prettier, tsc or knip already catches; generated files (`pnpm-lock.yaml`, `docs/api/**`, `apps/server/src/core-extensions/**`).
6. **Always check** `:141-158`: TSDoc accuracy, `runtimeRegistry.getDefault()`, Transport rather than fetch, tests present, dead code, the UI state/a11y/token bar.
7. **Dangling-reference sweep** `:160-199`: for deletions and renames, including changed user-visible strings (PR #575), across multiple token forms. Grep descends into dot-dirs.
8. **Conventions** `:201-211`: changelog fragments rather than direct CHANGELOG.md edits; comment drift; manifest consistency.
9. **Path-specific focus** `:213-226`: runtimes, client layers, tests, config migrations, docs.
10. **A passing test is not evidence** `:228-295`: revert the fix and confirm the tests go red; bound-vs-exact assertions; wrong-subject assertions; zero-subject passes; literal-list guards; mock-only selectors; mutation runs with no baseline; run browser tests for UI.
11. **Cross the seam** `:297-333`: drive the real thing. Calibration note: the automated review returned "0 important, 0 nits" on PRs that had real defects.
12. **Recovery paths** `:335-370`: `typeof` is not validation; multi-step repairs must be all-or-nothing.
13. **Verification bar** `:372-376`.
14. **Re-review convergence** `:378-388`.
15. **Review controls (labels)** `:390-401`: `skip-review`, `review:light`, `review:deep`, `re-review` (auto-cleared).
16. **Summary shape** `:403-407`: a one-line tally first. "No factual issues found" is accepted, and the verdict regex also accepts it (`claude-code-review.yml:963`).

Note: REVIEW.md `:380-382` says re-reviews also happen "via `@claude`". That is a separate workflow (`claude.yml`) with a different prompt, which only appends REVIEW.md via the system prompt.

---

## 3. claude.yml (64 lines)

- **Triggers** `:14-20`: `issue_comment: [created]`, `pull_request_review_comment: [created]`, `pull_request_review: [submitted]`. No merge_group, no concurrency group, no timeout (6-hour default).
- **Gate** `:36-47`: author_association is OWNER, MEMBER or COLLABORATOR (on the comment or the review) AND the body contains `@claude`. The stated reason: comment events run in the base context with secrets even for fork PRs (`:9-12`).
- **Permissions** `:25-29`: `contents: write`, `pull-requests: write`, `issues: write`, `id-token: write`. Claude can push fixes.
- **Job `claude`**: `ubuntu-latest`, checkout `fetch-depth: 0`, `anthropics/claude-code-action@v1`, `claude_code_oauth_token`. `claude_args`: `--max-turns 30` plus `--append-system-prompt "...apply the conventions in REVIEW.md and AGENTS.md..."` (`:62-64`).
- **No model pinned.** No `--setting-sources`, `--tools` or allow-list hardening, unlike the auto-review. It relies on the action's PR-context config restore and the write-access gate.
- Observed: every one of the last 30 runs was `skipped`. Each comment on any issue or PR spins up a run that skips, which is Actions-list noise only.

---

## 4. merge-tail.yml (278 lines) + should-arm-automerge.sh (129 lines)

### Workflow

- **Why** `:3-11`: nothing else arms auto-merge, because the flow plugin's ladder sits behind disabled Pulse mode.
- **Triggers**: `schedule: '*/10 * * * *'`, **every 10 minutes** (`:48-51`). `workflow_dispatch` with a boolean `dry_run` (`:52-57`). No PR, push or merge_group triggers.
- **Concurrency** `:60-62`: group `merge-tail`, `cancel-in-progress: false`. Ticks queue rather than overlap.
- **Permissions** `:75-78`: `contents: read` (deliberately, so the default token _cannot_ enqueue and jam the queue), `pull-requests: write`, `checks: read`.
- **Job `arm`**: `ubuntu-latest`, **no timeout-minutes**, checkout (for the script only).
- **Token** `:91-92`: `GH_TOKEN: secrets.MERGE_TAIL_TOKEN || github.token`. `MERGE_TAIL_TOKEN` **is set** (per `gh secret list`).
- **Safety stop** `:119-137`: if a merge queue is configured on `main` (or its state is unreadable) and there is no PAT, the job exits 1 with a step summary. The reason: a merge group created by GITHUB_TOKEN receives zero checks and blocks the whole queue (verified PR #581 vs #583).
- **Loop** `:146-241`: `gh pr list --state open --limit 100` (a silent cap of 100 PRs). For each PR:
  - `gh pr view --json number,state,isDraft,mergeStateStatus,autoMergeRequest,reviewDecision,labels` (`:156-161`). A read failure gives `SKIP could-not-read-pr`.
  - `gh pr checks --json name,bucket` (`:166-167`). Unparseable output becomes `[]`, which then produces `SKIP no-checks`.
  - GraphQL `mergeQueueEntry{position state}` + `reviewThreads(last:100){isResolved}` (`:174-180`). **`last:100` means a PR with more than 100 threads only has its last 100 counted.** An unreadable queue entry or thread count gives SKIP (`:186-193`).
  - The payload is assembled with `jq -s` from files (`:195-197`) and passed to `./scripts/should-arm-automerge.sh` (`:199`).
  - ARM runs **`gh pr merge --auto --squash "$pr"`** (`:215`). `--squash` is ignored under a queue (`:211-214`). Under a queue with the PAT, this enqueues.
  - Arm failures: `not accessible` / `HTTP 403` count as `perm_denied` and produce `::error`; anything else is `ARM FAILED` (`:218-240`).
- **Summary and exit** `:258-278`: armed/skipped/failed counts go to the step summary. **The job exits 1 only when `perm_denied > 0`.** An `if` is used deliberately, because an `&&`-chain under `bash -e` returned 1 (`:252-257`).
- **Self-healing / queue-drop recovery**: there is **no explicit re-arm logic**. The 10-minute poll is the recovery mechanism: if the queue drops a PR (queue entry gone, autoMergeRequest null) and it is still green, the next tick re-arms it. `already-queued` stops re-arming PRs that are already in the queue (`should-arm-automerge.sh:90-95`).
- **Known cost** `:25-45`: merges armed with GITHUB_TOKEN do not fire `push: main` workflows. The PAT now changes that attribution.
- Observed: the last 30 runs all succeeded. The latest tick saw 1 open PR, `#1925 -> SKIP already-queued`.

### Arming criteria (`should-arm-automerge.sh:77-121`), evaluated in this order; the first match wins

| Order | Condition                                                                                          | Verdict                                |
| ----- | -------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1     | `state != OPEN`                                                                                    | `SKIP not-open`                        |
| 2     | `isDraft`                                                                                          | `SKIP draft`                           |
| 3     | `autoMergeRequest != null`                                                                         | `SKIP already-armed`                   |
| 4     | `mergeQueueEntry != null`                                                                          | `SKIP already-queued`                  |
| 5     | label in `hold, do-not-merge, "do not merge", wip, blocked` (case-insensitive; objects or strings) | `SKIP held-by-label` (`:75`, `:96-97`) |
| 6     | `mergeStateStatus == DIRTY`                                                                        | `SKIP conflicting`                     |
| 7     | `mergeStateStatus` is `UNKNOWN` or empty                                                           | `SKIP mergeability-unknown`            |
| 8     | `reviewDecision == CHANGES_REQUESTED`                                                              | `SKIP changes-requested`               |
| 9     | `unresolvedThreads > 0`                                                                            | `SKIP unresolved-threads`              |
| 10    | zero checks                                                                                        | `SKIP no-checks`                       |
| 11    | any bucket `fail`                                                                                  | `SKIP failing-checks`                  |
| 12    | any bucket `cancel`                                                                                | `SKIP cancelled-checks`                |
| 13    | any bucket `pending`                                                                               | `SKIP checks-in-flight`                |
| else  |                                                                                                    | `ARM`                                  |

- `skipping` buckets are fine. `BEHIND` is fine. An empty `reviewDecision` (no human review) still arms (fixture `:103`). **There is no requirement that a Claude review ran or posted a verdict.**
- Unparseable input gives `SKIP unreadable-payload` with exit 2 (`:68-71`, `:124-127`).
- Design: "affirmative, not permissive"; unknown means SKIP (`:19-23`).

### Fixture suite `scripts/test-should-arm-automerge.sh` (132 lines)

The green baseline fixture (`:34-53`) is mutated one field per case (`:55-65`). There are 27 cases: fully green gives ARM; closed, merged, draft, armed, queued, queued+armed; hold label as object, string, mixed case and among others; an unrelated label still ARMs; DIRTY, UNKNOWN, absent mergeability; changes requested; unresolved threads; no review decision gives ARM; fail, cancel, pending, no checks; all-skipped gives ARM; fail outranks pending; hold outranks failure; `{}` gives not-open; garbage gives exit 2 (`:69-128`). The `GATE=` override lets a candidate rewrite run against the same fixtures (`:14-16`). It runs in `scripts-test.yml:314`.

---

## 5. scripts/assert-tests-executed.sh (119 lines)

- **What it asserts** (`:16-24`), reading turbo's `--summarize` run summary (`.turbo/runs/<id>.json`, the newest by default, `:55-63`):
  1. every `task == "test"` entry has `cache.status == "MISS"`, so nothing was replayed (`:98-109`);
  2. the count of `test` tasks **equals** the number of `apps/*/package.json` + `packages/*/package.json` files declaring `scripts.test` (`:82-92`, `:111-116`). This catches a stray `--filter`, a dropped package, or tasks skipped by a failed dependency.
     It also fails on a missing summary, an unreadable summary, or zero test-bearing packages (`:65-69`, `:90-96`).
- **Why** (`:4-14`): turbo caches `test`, and a full cache hit prints "N successful ... FULL TURBO" in ~280ms and exits 0 having run no tests. `--filter=<typo>` also exits 0 with zero tasks. It deliberately avoids `--force`, because forcing is a policy nothing notices when removed, it discards the `^build` cache, and it would not catch zero tasks (`:26-30`).
- **Limitation, stated honestly** (`:75-81`): the globs are hard-coded to `apps/*` and `packages/*`. A third workspace glob would make `expected < executed` and fail loudly, not silently.
- **Where it runs**: `test.yml:408-410`, `if: success() && github.event_name == 'merge_group'`, per shard. The PR leg is affected-only and has no summary (`test.yml:337-342`, `:399-406`). A per-shard vitest zero-file collection is caught instead by `assert-shard-union.sh` in the fan-in (`test.yml:620-623`).
- **Fixtures** `scripts/test-assert-tests-executed.sh` (161 lines): hermetic temp workspaces via `WORKSPACE_ROOT`, with 9 cases (all-MISS passes; a package without a test script is not counted; all-HIT, one-HIT, short run, empty run, missing summary, malformed summary and bare workspace are all refused). A HIT `build` task is included in every fixture to prove that only `test` tasks are judged (`:87-89`). `ASSERT=` override. Runs in `scripts-test.yml:283`.

---

## 6. Release path

### How the pieces chain

```
/system:release: bump, commit, push tag vX.Y.Z (Phase 6.10), create DRAFT GitHub Release (Phase 6.11), npm publish
        |
        | push tag v*  (fans out, in parallel; no workflow_run chaining anywhere)
        +--> desktop-release.yml    build-macos, build-windows -> attach to draft -> verify-* -> publish-release (draft=false, via GITHUB_TOKEN)
        +--> publish-docker.yml     wait for npm -> buildx amd64+arm64 -> GHCR + attestation -> mirror to Docker Hub
        +--> update-homebrew.yml    wait for npm -> formula (+ cask if the dmg exists) -> push to tap   [FAILS: no HOMEBREW_TAP_TOKEN]
                                     release:published trigger never fires, because publish-release uses GITHUB_TOKEN
```

### desktop-release.yml (472 lines), workflow name "Desktop Release"

- **Triggers**: `push: tags: ['v*']` (`:51-53`); `workflow_dispatch` with a boolean `dry_run` (`:54-59`). No concurrency group, no merge_group. **No job has timeout-minutes.**
- **Header** (`:3-48`): attach-only to the draft that `/system:release` created. It never creates a release or rewrites notes. Gating is asymmetric: macOS gates publish; Windows is `continue-on-error`.

| Job               | runs-on                                                                          | needs         | Key points                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Cite       |
| ----------------- | -------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `build-macos`     | `macos-latest`                                                                   | none          | perms `contents: write`; pnpm + `setup-node cache: pnpm`; `turbo build --filter=@dorkos/desktop`; `rebuild-natives.ts`; electron-builder `--mac --arm64 --publish never`, unsigned if `!vars.APPLE_DEVELOPER_CONFIGURED`, otherwise signed+notarized with `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `vars.APPLE_TEAM_ID`; uploads artifact `DorkOS-macOS-arm64` (dmg/zip/blockmap); on a tag and not dry_run, polls up to 30 × 20s (~10 min) for the release, then `gh release upload --clobber` dmg, zip, blockmap and `latest-mac.yml` | `:69-183`  |
| `build-windows`   | `windows-2022` (pinned because node-gyp does not detect VS 18 on windows-latest) | none          | `continue-on-error: true`; same build; electron-builder `--win --x64`, **unsigned**; artifact `DorkOS-windows-x64` (exe, latest.yml, blockmap); same attach poll                                                                                                                                                                                                                                                                                                                                                                                                          | `:185-304` |
| `verify-macos`    | `macos-latest`                                                                   | build-macos   | downloads the artifact; `hdiutil attach`; `codesign --verify --deep --strict`; `spctl --assess` only when `APPLE_DEVELOPER_CONFIGURED == 'true'`                                                                                                                                                                                                                                                                                                                                                                                                                          | `:309-369` |
| `verify-windows`  | `windows-latest`                                                                 | build-windows | `continue-on-error: true`; silent `/S` install with a 180s wait; asserts `%LOCALAPPDATA%\Programs\DorkOS\DorkOS.exe` exists                                                                                                                                                                                                                                                                                                                                                                                                                                               | `:371-432` |
| `publish-release` | `ubuntu-latest`                                                                  | all four      | `if: always() && !cancelled() && tag && !dry_run && build-macos == success && verify-macos == success`; `gh release edit --draft=false` using **GITHUB_TOKEN**                                                                                                                                                                                                                                                                                                                                                                                                            | `:434-472` |

- `APPLE_DEVELOPER_CONFIGURED` is `true` (per `gh variable list`), so the signed path is live.
- Order nuance: attach happens in the build jobs **before** verify, so a broken dmg is attached to the draft but the release is never published (`:306-308`).
- Observed (last 30): 22 push success, 2 push failure, 1 cancelled, 4 dispatch cancelled, 1 dispatch success.

### publish-docker.yml (169 lines), "Publish Docker Image"

- **Triggers**: `push: tags: ['v*']`, `workflow_dispatch` (`:3-6`). No concurrency group.
- Env: `REGISTRY: ghcr.io`, `IMAGE_NAME: dork-labs/dorkos` (`:8-14`).
- **`build-and-push`**: `ubuntu-latest`, `timeout-minutes: 75` (30 min npm wait plus 45 min headroom; the v0.52.0 QEMU deadlock, `:19-26`). Perms: `contents: read`, `packages: write`, `attestations: write`, `id-token: write`. Steps: GHCR login with GITHUB_TOKEN; QEMU; buildx; version from the tag; `bash scripts/wait-for-npm.sh <ver>` (DOR-1606); metadata tags `semver {{version}}`, `{{major}}.{{minor}}`, `sha`, `latest=auto`; `docker/build-push-action@v7` with target `runtime`, `linux/amd64,linux/arm64`, build-args `INSTALL_MODE=npm`, `DORKOS_VERSION`, **cache `type=gha` mode=max** (`:82-83`); `actions/attest-build-provenance@v4` pushed to the registry (`:85-90`).
  - **It builds from the published npm package, not the checkout** (`INSTALL_MODE=npm`), which is why it waits for npm.
  - Under `workflow_dispatch`, `GITHUB_REF_NAME` is a branch name (e.g. `main`), so the version is `main` and wait-for-npm is asked for `main`. The dispatch path looks broken or unused (inference, not run).
- **`mirror-docker-hub`**: `needs: build-and-push`, `if: vars.DOCKERHUB_MIRROR == 'true'` (**set to true**), `timeout-minutes: 15`. It copies the manifest with `docker buildx imagetools create` to `vars.DOCKERHUB_IMAGE || 'dorkai/dorkos'` (`:112-169`). The `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets exist.
- Observed (last 30): 26 success, 4 failure (v0.74.0, v0.64.0, v0.63.0 ×2).

### update-homebrew.yml (170 lines), "Update Homebrew Formula"

- **Triggers** `:16-24`: `push: tags: ['v*']`; `release: types: [published]`; `workflow_dispatch` with an optional `version` input. No concurrency group, no timeout.
- Design (`:4-13`): the tag run bumps the formula as soon as possible (the cask is skipped because the dmg is not attached yet). The release-published run was meant to land the cask. **See finding 2: that run never happens under the current release flow.**
- **Job `update-formula`** (`:33-170`): the version comes from the tag, the release tag, the input, or `npm view dorkos version`. A sparse checkout pulls `scripts/wait-for-npm.sh` and waits (push/release only). The npm tarball SHA256 is computed with curl. It checks out `dork-labs/homebrew-dorkos` with `secrets.HOMEBREW_TAP_TOKEN` (**unset, so every run fails here**), then `sed`s `Formula/dorkos.rb`. The cask update is skipped if `Casks/dorkos-desktop.rb` is absent or the release has no `DorkOS-<v>-arm64.dmg`. The commit is idempotent (`git diff --cached --quiet` means a no-op), then `git push`.
- Observed: 24 push failures and 1 release failure, with **zero successes** in the retained history.

---

## 7. Dependabot

### .github/dependabot.yml (153 lines)

| Ecosystem               | Schedule                                | Groups                                                                                         | Ignores                                                                                                                                                                                                                                                                                 | Limits / labels                                                                     |
| ----------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `npm` at `/`            | **weekly, Monday 06:00 UTC** (`:47-51`) | `npm-minor-and-patch`: pattern `*`, update-types minor+patch. One PR for everything (`:66-72`) | all semver-major (`:104-105`); SDK families `@anthropic-ai/claude-agent-sdk*`, `@anthropic-ai/sdk`, `@openai/codex*`, `@opencode-ai/*` (`:112-124`); known-bad `better-auth >=1.7.3` and `@better-auth/api-key >=1.7.3` (DOR-2036), `@playwright/test >=1.63.0` (DOR-2037) (`:130-135`) | `open-pull-requests-limit: 5`; labels `skip-changelog`, `review:light` (`:138-141`) |
| `github-actions` at `/` | **monthly** (`:145-146`)                | `actions`: pattern `*`                                                                         | none                                                                                                                                                                                                                                                                                    | labels `skip-changelog`, `review:light` (`:151-153`)                                |

- Rules (`:73-101`): every ignore names a **whole family** (trailing `*`), never one member. PR #1407 half-bumped platform siblings. This is pinned by `scripts/__tests__/dependabot-lockstep-families.test.ts`. The esbuild and ngrok lockstep families stay together because of the single catch-all group (`:53-65`).
- Security updates are a repo setting and are not rate-limited, but they only cover direct deps. Transitive CVEs need pnpm overrides via `/app:upgrade` (`:35-42`).
- Majors go through `/app:upgrade`; SDKs go through the `upgrading-runtime-dependencies` skill (`:9-20`).
- **Interaction gaps**: `review:light` is not `skip-review`, so the Claude review runs and fails on the bot actor (finding 4). `codeql.yml` is scheduled Monday 06:30 to follow the 06:00 Dependabot run (`codeql.yml:20-22`).
- Observed: the last 4 Dependabot PRs are #1856 CLOSED, #1847 CLOSED, #1577 MERGED, #1407 MERGED. #1856 had red `test`, `typecheck`, `harness-windows`, `packaged-runtime` and `renderer-defines` checks.

### dependabot-lockfile-repair.yml (212 lines)

- **Problem** (`:5-12`): Dependabot drops the lockfile `overrides:` block (~40 entries, including CVE pins), so every job dies with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` (DOR-1644). The earlier Prettier repair was removed in favor of `.prettierignore` (DOR-1715, `:24-34`).
- **Trigger** `:125-129`: `pull_request_target`, types `opened, synchronize, reopened`, paths `pnpm-lock.yaml`. `pull_request_target` is required because Dependabot-triggered `pull_request` runs get no secrets and a read-only token (`:36-46`).
- **Concurrency** `:134-136`: `dependabot-lockfile-repair-${{ pr.number }}`, cancel-in-progress true.
- **Permissions**: `contents: write` (`:138-139`).
- **Job `repair-lockfile`**: `if: github.event.pull_request.user.login == 'dependabot[bot]'` (`:148`); `ubuntu-latest`; `timeout-minutes: 5`.
  1. Fails with an `::error` if `MERGE_TAIL_TOKEN` is empty (`:152-157`).
  2. Checks out the **PR head SHA** with `MERGE_TAIL_TOKEN` (`:162-165`).
  3. pnpm plus setup-node 24, **no pnpm cache** (`:167-171`).
  4. Runs `pnpm install --lockfile-only --no-frozen-lockfile --ignore-scripts` (`:184-185`). This is a resolver run only: no node_modules and no lifecycle scripts.
  5. If `pnpm-lock.yaml` changed, it commits as github-actions[bot] and runs `git push origin HEAD:${HEAD_REF}` (`:187-212`).
- **Threat model** (`:48-93`): nothing the PR authored is executed. The actor gate is what bounds the resolver's reach (no `.npmrc` or `git+` deps from Dependabot).
- **Why the PAT** (`:95-111`): a GITHUB_TOKEN push would not re-trigger PR checks.
- **Idempotent** (`:113-116`): the second run, triggered by its own push, finds no diff.
- **Side effect worth noting**: this push moves the PR head, which strips the (red) `review` check-run from the head SHA (finding 3).
- Observed (last 30): 26 skipped (non-Dependabot PRs touching the lockfile), 4 success.

---

## 8. codeql.yml (44 lines)

- **Triggers**: `schedule: '30 6 * * 1'`, **weekly, Monday 06:30 UTC**; `workflow_dispatch` (`:18-23`). No PR, push or merge_group. It is not required (`:15-17`).
- **Design** (`:6-13`): schedule-only by choice. Per-PR CodeQL would add 10+ minutes to every PR, and findings so far number zero. Revisit if a real injection bug appears.
- Permissions: `contents: read`, `security-events: write` (`:25-27`).
- **Job `analyze`**: `ubuntu-latest`, `timeout-minutes: 90`, checkout, `github/codeql-action/init@v4` with `languages: javascript-typescript`, `build-mode: none`, then `analyze@v4` (`:29-44`). No concurrency group.
- Observed: 3 schedule successes and 1 dispatch success.

---

## 9. desktop-renderer.yml (166 lines), "Desktop Renderer"

- **Why** (`:7-32`): v0.63.0 shipped a renderer with an unsubstituted `__APP_VERSION__`, which gave a black window (DOR-1448). A client-only PR that touches neither `apps/desktop/**` nor the lockfile had no pre-merge renderer build.
- **Triggers**: `pull_request` with paths `apps/client/**`, `apps/desktop/**` and this workflow file (`:85-89`); `workflow_dispatch`. **No merge_group**, deliberately. It is not required and cannot be, because of its path filter (`:50-61`). `packages/**` is not covered (`:65-74`).
- **Concurrency** `:101-103`: `desktop-renderer-${{ github.ref }}`, cancel true.
- Perms: `contents: read`.
- **Job `renderer-defines`**: `ubuntu-latest`, `timeout-minutes: 20`. Steps: pnpm, `setup-node cache: pnpm`, install; `turbo build --filter=@dorkos/desktop^...` (deps only); `electron-vite build` in `apps/desktop`; `tsx scripts/check-renderer-defines.ts`, which throws if `dist/renderer` has no JS (`:109-166`). "No remote turbo cache in CI" (`:112`).
- Observed: 30 of 30 PR runs succeeded.

## 10. desktop-smoke.yml (157 lines), "Desktop Smoke"

- **Why** (`:7-16`): launches the packaged app and probes `/api/health` plus a clean shutdown. Real-launch defects were invisible to other gates.
- **Triggers** (asymmetric, `:18-46`):
  - `pull_request` paths: `apps/desktop/**`, `pnpm-lock.yaml`, this file (`:53-57`);
  - `push` to `main` with paths `apps/desktop/**`, `apps/server/**`, `apps/client/**`, `packages/**`, `pnpm-lock.yaml`, this file (`:58-66`);
  - `workflow_dispatch`. **No merge_group.**
- **Note:** since merges now go through the queue via the PAT-armed merge-tail, `push: main` runs do fire again (observed: 16 push successes in the last 30 runs).
- **Concurrency** `:86-88`: `desktop-smoke-${{ github.ref }}`, cancel only on pull_request. Pushes share the ref group, so a quick double merge can drop a pending run. That was a deliberate choice to protect scarce macOS runners (DOR-637 revert, `:75-85`).
- Perms: `contents: read`.
- **Job `packaged-runtime`**: `macos-latest`, `timeout-minutes: 30`. It is a single job so the Electron-ABI native rebuild never meets a test run (`:94-100`). Steps: pnpm, `cache: pnpm`, install; `turbo build --filter=@dorkos/desktop`; `rebuild-natives.ts`; electron-builder `--mac --arm64 --dir` with `CSC_IDENTITY_AUTO_DISCOVERY=false`; `tsx scripts/smoke-packaged.ts` (`:101-157`).
- Observed: 16 push successes, 12 PR successes, 2 PR runs cancelled.

## 11. evals.yml (267 lines), "Evals"

- **Triggers**: `pull_request` types `opened, synchronize, reopened, labeled` (no paths, because "the label IS the filter", `:36-43`); `schedule: '0 8 * * *'`, **daily at 08:00 UTC** (`:44-46`); `workflow_dispatch` with inputs `suite` (default `core`) and `budget_usd` (**required**, default `'3'`, because an empty value once became a NaN ceiling that removed the cap, `:47-60`). No merge_group.
- **Concurrency** `:64-66`: `evals-${{ ref }}-${{ event_name }}`, cancel only on PRs.
- Perms: `contents: read`.
- **Job `structural`**, named "Structural suite (test-mode)": `if` schedule OR (PR with the `run-evals` label) (`:81-84`); `ubuntu-latest`; `timeout-minutes: 20`. Steps: `setup-node cache: pnpm`; `pnpm turbo build --filter=@dorkos/evals...`; `evals --suite core --tier test-mode`; `evals --suite rooms --tier test-mode`; uploads artifact `eval-results-structural-<run_id>` (results.json and logs, 14-day retention). Only 1 core case (`widget-round-trip`) gates today (`:112-117`).
- **Job `credentialed`**, named "Credentialed suite (claude-code-cheap)": `if: workflow_dispatch` (`:159`); `ubuntu-latest`; `timeout-minutes: 45`. A step resolves which pinned secret to use, `ANTHROPIC_API_KEY` first and then `CLAUDE_CODE_OAUTH_TOKEN`; with neither, it emits a notice and stays green (`:180-195`). It runs `--tier claude-code-cheap --isolation child-process --budget "$BUDGET_USD"`, with the inputs passed via env to avoid injection (`:230-246`). Artifact `eval-results-credentialed-<run_id>` (results, jsonl, logs, 30-day retention).
- The `real-provider` tier deliberately has no job (`:28-33`).
- **Per-PR spend**: none. The per-PR run is test-mode only.
- Observed: 3 schedule successes, 26 PR runs skipped (no label), 1 cancelled.

## 12. harness-windows.yml (317 lines)

- **Why** (`:6-37`): the harness engine's Windows junction and dir-symlink branch had never been executed (DOR-1883, DOR-1855; the AP-06 and J-10 contract rows).
- **Triggers**: `pull_request` (no paths), **`merge_group`**, `workflow_dispatch` (`:62-65`). **It reports on merge_group**, so it is ready to be promoted to a required check with only a branch-protection change (`:55-57`).
- **Status** (`:39-42`): advisory, not required, but a red here blocks merge-tail arming. The scope decision is made inside the job rather than with a `paths:` filter, so the context always reports (`:44-53`).
- **Concurrency** `:76-78`: `harness-windows-${{ github.ref }}`, cancel on pull_request only. Merge-group refs are unique.
- Perms: `contents: read`.
- **Job `harness-windows`** (the single producer of the context, `:84-88`): `windows-latest` (deliberately not the 2022 pin, since nothing native is compiled, `:89-96`); `timeout-minutes: 30`; `defaults.run.shell: bash`. Steps:
  - `git config --global core.symlinks true` plus a `mklink` probe (`:141-154`);
  - checkout `fetch-depth: 0`; pnpm; `cache: pnpm`; install;
  - a capability-report node script (file, dir and junction links; junction readlink text; the committed symlink state) (`:190-217`);
  - **scope** (PR only): `TURBO_SCM_BASE=<base.sha> turbo run test --filter=@dorkos/harness --filter=dorkos --affected --dry=json`, with the count parsed by node. A change to this workflow file forces a run (`:237-261`);
  - `turbo build --filter=dorkos^...` (`:282-284`);
  - `pnpm vitest run packages/harness` (`:305-307`) and `pnpm vitest run packages/cli/src/__tests__/harness-sync` (`:309-311`), one filter per step so a filter matching nothing fails;
  - a "Nothing ... can reach" echo when out of scope (`:315-317`).
    Build and test are unconditional on merge_group and dispatch.
- Observed: 12 merge_group successes and 18 pull_request successes.

---

## 13. Cross-cutting table

| Workflow                   | Check context(s)                                                          | PR                                | merge_group | push                          | schedule        | dispatch            | Concurrency (cancel) | Timeout   |
| -------------------------- | ------------------------------------------------------------------------- | --------------------------------- | ----------- | ----------------------------- | --------------- | ------------------- | -------------------- | --------- |
| claude-code-review         | `review`                                                                  | opened/ready/reopened/labeled     | no          | no                            | no              | yes (`pr`)          | per-PR (conditional) | 25        |
| claude                     | `claude`                                                                  | via comment events                | no          | no                            | no              | no                  | none                 | none (6h) |
| merge-tail                 | `arm`                                                                     | no                                | no          | no                            | every 10 min    | yes (`dry_run`)     | `merge-tail` (false) | none (6h) |
| codeql                     | `analyze`                                                                 | no                                | no          | no                            | Mon 06:30 UTC   | yes                 | none                 | 90        |
| dependabot-lockfile-repair | `repair-lockfile`                                                         | `pull_request_target` on lockfile | no          | no                            | no              | no                  | per-PR (true)        | 5         |
| desktop-release            | build-macos, build-windows, verify-macos, verify-windows, publish-release | no                                | no          | tags `v*`                     | no              | yes (`dry_run`)     | none                 | none (6h) |
| desktop-renderer           | `renderer-defines`                                                        | paths client/desktop              | no          | no                            | no              | yes                 | ref (true)           | 20        |
| desktop-smoke              | `packaged-runtime`                                                        | paths desktop/lockfile            | no          | main, wide paths              | no              | yes                 | ref (PR only)        | 30        |
| evals                      | "Structural suite (test-mode)", "Credentialed suite (claude-code-cheap)"  | label `run-evals`                 | no          | no                            | daily 08:00 UTC | yes (suite, budget) | ref+event (PR only)  | 20 / 45   |
| harness-windows            | `harness-windows`                                                         | all                               | **yes**     | no                            | no              | yes                 | ref (PR only)        | 30        |
| publish-docker             | build-and-push, mirror-docker-hub                                         | no                                | no          | tags `v*`                     | no              | yes                 | none                 | 75 / 15   |
| update-homebrew            | `update-formula`                                                          | no                                | no          | tags `v*` + release published | no              | yes (`version`)     | none                 | none (6h) |

Label vocabulary across this set:

- `skip-review`, `review:light`, `review:deep`, `re-review`: the Claude review.
- `hold`, `do-not-merge`, `do not merge`, `wip`, `blocked`: merge-tail holds.
- `run-evals`: evals.
- `skip-changelog`: Dependabot default, consumed by changelog-fragment-check (out of scope here).
