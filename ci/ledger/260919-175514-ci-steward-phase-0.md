---
id: 260919-175514
title: 'CI Steward phase 0: census and ledger checks in typecheck, measured timeouts, merge guard, one ruleset'
kind: hygiene
status: active
actor: agent
gates:
  - wf.typecheck.typecheck
  - wf.changelog-fragment-check.fragment-present
  - wf.changelog-fragment-check.no-fragment-under-skip-label
  - wf.operating-skills-version-check.version-outranks-base
  - wf.docs-openapi-check.openapi-fresh
  - wf.merge-tail.arm
  - wf.dependabot-lockfile-repair.repair-lockfile
  - wf.scripts-test.fixtures
  - wf.scripts-test.harness
  - wf.claude.claude
  - wf.desktop-release.build-macos
  - wf.desktop-release.build-windows
  - wf.desktop-release.verify-macos
  - wf.desktop-release.verify-windows
  - wf.desktop-release.publish-release
  - wf.update-homebrew.update-formula
  - wf.db-check.db-check
  - claude.PreToolUse.merge-guard
  - claude.PreToolUse.git-guard
  - claude.PreToolUse.process-guard
  - claude.PreToolUse.file-guard
  - ruleset.required_status_checks
  - ruleset.bypass
  - ruleset.deletion
  - ruleset.non_fast_forward
prs: []
ratchet-release: []
field-changes:
  - gate: wf.changelog-fragment-check.fragment-present
    field: timeout-minutes
    from: null
    to: 10
  - gate: wf.changelog-fragment-check.no-fragment-under-skip-label
    field: timeout-minutes
    from: null
    to: 10
  - gate: wf.operating-skills-version-check.version-outranks-base
    field: timeout-minutes
    from: null
    to: 10
  - gate: wf.db-check.db-check
    field: required
    from: 'classic branch protection'
    to: 'ruleset 19893973'
---

Phase 0 of plans/ci-steward-plan.md: the foundation the later phases measure against. Hygiene,
because nothing here is expected to move a metric; it makes the pipeline's intent checkable and
closes the admin-merge path.

**The engine and the checks:**

- `packages/ci-steward` with `census`, `ledger-check` and `ledger-new`, and the `ci/` hand files.
- Three steps in the required `typecheck` job: the census and ledger validity on every event, and
  ledger coverage on pull_request only, blocking from day one (operator decision: no trial week).
  No new required context. Coverage counts a new ledger entry, or an existing entry whose `prs:`
  gains a number; Dependabot PRs skip it, since Dependabot cannot write an entry.
- The census follows `needs:`: `continue-on-error` and step `if:`s in every job a required context
  depends on are checked, and an `always()` fan-in must read each needed job's result.

**Timeouts:** `timeout-minutes` on the 13 jobs that had none and had at least 5 runs in the last
30 days, each max(10, ceil(3 × p95)) of measured job durations: fragment-present 10,
no-fragment-under-skip-label 10, version-outranks-base 10, openapi-fresh 10, merge-tail arm 10,
scripts-test fixtures 10 and harness 13, desktop-release build-macos 56, build-windows 39,
verify-macos 10, verify-windows 10, publish-release 10, update-homebrew update-formula 92.
`claude.yml`'s job had no non-skipped run, so it gets 30 by analogy with the 25-minute automated
review (same action, same subscription) instead of an expiring exception.

**The PR author's side:**

- A new PreToolUse hook, `.claude/hooks/merge-guard.mjs`, registered in `.claude/settings.json`,
  refuses `gh pr merge --admin`, a REST PUT on `pulls/<n>/merge` and the `mergePullRequest`
  mutation, which merge around the queue on the admin account every agent runs as. Its fixtures
  run as a new `scripts-test.yml` step ("Merge-guard hook fixtures"); the shared parser
  `.claude/hooks/lib/shell-command.mjs` changed with it, so the other guards are in scope too.
- `watch-prs.sh` and the creating-pull-requests skill lose their harmful remedies: no empty
  commits, wait on the first ejection (`EJECTED_REPEAT` only on a second one with no change),
  `STALLED_IN_QUEUE` by queue age, `HELD_BY_LABEL`, `CANCELLED`, and a loud `WATCHER BLIND`
  when its `gh` calls keep failing. The skill's required-checks list is now generated from
  `ci/required-checks.json`.

**Credentials:**

- merge-tail and the Dependabot lockfile repair hold the `dorkos-merge-tail` GitHub App key (no
  Administration) instead of the admin PAT `MERGE_TAIL_TOKEN`; the old secret is deleted right
  after this merges, which makes "no admin credential in Actions" true. The app's client id and
  key are the secrets `MERGE_TAIL_APP_CLIENT_ID` and `MERGE_TAIL_APP_PRIVATE_KEY` (the client id is
  a secret because secrets are proven to reach Dependabot's `pull_request_target` runs).

**On GitHub (operator-approved, applied by the orchestrator on 2026-09-19, recorded here because
no file shows them):**

- Ruleset 19893973 ("main: merge queue"): the admin bypass narrowed from `always` to
  `pull_request`, which closes direct pushes to main; `db-check` added as a required context and
  the `deletion` and `non_fast_forward` rules added; every required context pinned to the GitHub
  Actions app (integration 15368).
- Classic branch protection on main deleted, so the ruleset is the only source of required checks.
- Ruleset 23704437 created to keep the `ci-steward-data` branch append-only
  (`non_fast_forward` and `deletion`).

Revert the steps if the census proves slower than a few seconds or reds PRs on correct trees;
revert the merge guard if it refuses `gh pr merge --auto`.
