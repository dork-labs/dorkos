---
id: 261118-141016
title: Pull requests into release/v* run the full gate and only take cherry-picks from main
kind: experiment
status: proposed
actor: agent
gates:
  - wf.release-branch-contents.release-branch-contents
  - wf.changelog-fragment-check.fragment-present
  - wf.changelog-fragment-check.no-fragment-under-skip-label
  - wf.test.test-shard-count
  - wf.test.test-shard
  - wf.test.test-binary
  - wf.test.community-pg
  - wf.test.test
  - wf.browser-test.browser-smoke
  - wf.browser-test.browser-shard
  - wf.browser-test.first-run
  - wf.browser-test.browser-test
  - wf.docs-openapi-check.openapi-fresh
  - wf.scripts-test.fixtures
prs: []
hypothesis:
  metric: 'gate.wf.changelog-fragment-check.fragment-present.failure_rate@pull_request'
  baseline: 0
  baseline_source: 'origin/ci-steward-data snapshots/2026-11-17.json, wf.changelog-fragment-check.fragment-present@pull_request: 192 success, 0 failure, 132 cancelled of 324 runs'
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4639 (issue 4 of the "Release branches" project, decision DOR-4636).
Releases move to short-lived `release/v<X.Y.Z>` branches cut from QA's pinned
main commit, so a release stops freezing the merge queue (DOR-4645 baseline:
1,208 freeze minutes over the 8 releases of Nov 12-18). Changes reach a
release branch only by pull request, and there is no queue behind it, so:

- **Full sweep on a release PR.** test.yml, browser-test.yml and
  docs-openapi-check.yml treat a pull request whose base starts with
  `release/` like `merge_group`: every suite on six shards, community-pg, the
  full browser matrix and first-run, unconditional OpenAPI regeneration. No
  shard plan, no no-code skip. `runs-on` is unchanged (no queue runner).
- **New `release-branch-contents` check.** The rule is DOR-4638's
  `packages/cli/scripts/release-branch/check-picks.ts` (one rule for the
  check and the publish): every commit in base..head is a `cherry-pick -x`
  of a main commit with a byte-exact equal patch (whitespace counts, unlike
  `git patch-id`), or a release commit touching only release metadata (no
  runnable code: config migrations, their hash fixture and
  agent-release-notes.ts land on main before the cut, Security). The workflow
  runs main's copy of that folder through main's
  scripts/ci/release-branch-contents.sh, which adds the branch shape, base and
  history checks, sanity checks on the rule's verdict and the summary table
  (the release-commit subject and VERSION are the rule's, as are
  source-before-cut and source-reverted-on-main). Hotfix publishing is off
  in DOR-4638 until tags are locked (DOR-4789); this check has no hotfix
  logic of its own.
  Until DOR-4638 is on main there is no check-picks.ts there and the check
  fails closed (exit 2). Its PR comes from `release-commit/vX.Y.Z`; release/*
  merges are rebase-only with no queue. Fixtures:
  scripts/test-release-branch-contents.sh, through the real check-picks.ts.
- **Fragments.** On a release base, `fragment-present` proves provenance with
  the same rule and then skips coverage (each pick passed coverage on its own
  main PR); `no-fragment-under-skip-label` skips (the label decides nothing
  there). Validity still runs.

Nothing changes for a pull request into main or for the merge queue, which is
what the hypothesis watches: fragment-present gained a step that is a no-op on
every base but `release/*`. No ruleset or setting changes here; the release/*
ruleset (DOR-4637) is Security's and lists the contexts in contributing/ci.md.

Revert if fragment-present or test reds a pull request into main because of
this change, or if a release PR passes `release-branch-contents` with a commit
that is not on main.
