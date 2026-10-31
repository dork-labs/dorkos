---
id: 261031-163500
title: '@dorkos/ci-steward#test declares the files outside its package that its suites read'
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.test.test-shard
prs: []
ratchet-release: []
field-changes: []
---

DOR-3518, PR A of two. The CI Steward's census and canary tests read the real workflows, `ci/`,
`lefthook.yml`, the root `package.json`, `.claude/settings.json` and `.claude/hooks/`, the
`scripts/` those name, and `apps/e2e/playwright.config.ts`. None of that is in the package, and
turbo.json did not say so. This adds a `@dorkos/ci-steward#test` override that names them as
`inputs`, the way `@dorkos/server#test` and `@dorkos/harness#test` already do. A test pins the list
and checks every path exists.

What it changes: the suite's turbo hash, and so its cache key, now moves when any of those files
change, so a local turbo cache can no longer replay a green run of these suites across a workflow
or `ci/` edit. What it does not change on its own: `turbo test --affected`, which the pull request
leg runs, picks packages by changed files and ignores `inputs`, so a workflow-only pull request
still skips these suites until the hash-based selection in the stacked PR B lands. No gate's
behaviour moves, so there is no metric to score; revert if the override ever drops `^build` or the
cache flag the base task declares (the test checks both).
