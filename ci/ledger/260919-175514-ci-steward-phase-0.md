---
id: 260919-175514
title: 'CI Steward phase 0: census and ledger checks in typecheck, measured timeouts, one ruleset'
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
  - wf.scripts-test.fixtures
  - wf.scripts-test.harness
  - wf.desktop-release.build-macos
  - wf.desktop-release.build-windows
  - wf.desktop-release.verify-macos
  - wf.desktop-release.verify-windows
  - wf.desktop-release.publish-release
  - wf.update-homebrew.update-formula
  - wf.db-check.db-check
  - ruleset.required_status_checks
  - ruleset.bypass
  - ruleset.deletion
  - ruleset.non_fast_forward
prs: []
ratchet-release: []
field-changes:
  - {
      gate: wf.changelog-fragment-check.fragment-present,
      field: timeout-minutes,
      from: null,
      to: 10,
    }
  - {
      gate: wf.changelog-fragment-check.no-fragment-under-skip-label,
      field: timeout-minutes,
      from: null,
      to: 10,
    }
  - {
      gate: wf.operating-skills-version-check.version-outranks-base,
      field: timeout-minutes,
      from: null,
      to: 10,
    }
  - {
      gate: wf.db-check.db-check,
      field: required,
      from: 'classic branch protection',
      to: 'ruleset 19893973',
    }
---

Phase 0 of plans/ci-steward-plan.md: the foundation the later phases measure against. Hygiene,
because nothing here is expected to move a metric; it makes the pipeline's intent checkable.

**In the repo (this PR):**

- `packages/ci-steward` with `census`, `ledger-check` and `ledger-new`, and the `ci/` hand files.
- Three steps in the required `typecheck` job: the census and ledger validity on every event, and
  ledger coverage on pull_request only, advisory until its allowlist entry expires on 2026-09-27.
  No new required context.
- `timeout-minutes` on the 13 jobs that had none and had at least 5 runs in the last 30 days, each
  set to max(10, ceil(3 × p95)) of measured job durations: fragment-present 10,
  no-fragment-under-skip-label 10, version-outranks-base 10, openapi-fresh 10, merge-tail arm 10,
  scripts-test fixtures 10 and harness 13, desktop-release build-macos 56, build-windows 39,
  verify-macos 10, verify-windows 10, publish-release 10, update-homebrew update-formula 92.
  `claude.yml`'s job had no non-skipped run to measure, so it carries a `no-timeout` allowlist
  entry until 2026-10-19.

**On GitHub (operator-approved, applied by the orchestrator on 2026-09-19, recorded here because
no file shows them):**

- Ruleset 19893973 ("main: merge queue"): the admin bypass narrowed from `always` to
  `pull_request`, which closes direct pushes to main; `db-check` added as a required context and
  the `deletion` and `non_fast_forward` rules added; every required context pinned to the GitHub
  Actions app (integration 15368).
- Classic branch protection on main deleted, so the ruleset is the only source of required checks.
- Ruleset 23704437 created to keep the `ci-steward-data` branch append-only
  (`non_fast_forward` and `deletion`).

Revert the steps if the census proves slower than a few seconds or reds PRs on correct trees.
