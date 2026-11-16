---
id: 261116-035326
title: CLI Smoke runs for every package the CLI bundles
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.cli-smoke-test.build-tarball
prs: []
ratchet-release: []
field-changes: []
---

`cli-smoke-test.yml`'s `pull_request` path filter listed `packages/cli`,
`packages/shared`, `apps/server` and `apps/client`. The tarball bundles more
than that: esbuild inlines every workspace package in the CLI's closure (its own
workspace deps, then each one's `dependencies`, recursively), which is 22
packages. A PR touching only one of the other 18 got no CLI Smoke run and no
tarball. QA found it on #3812, a `packages/db` change.

The filter now lists the whole closure, and the comment above it says how to
recompute it. `push` to `main` has no path filter and is unchanged. The job is
not required, so the filter does not touch the deadlock invariant.

Cost: PRs that touch only one of those 18 packages now run the smoke jobs. Most
PRs that touch them also touch `apps/server`, which already ran it, so the
added runs are few. It is `hygiene`: there is no measured count of escapes this
filter caused, so no hypothesis to state.

Revert only with a check that derives the filter from the workspace graph, so
it cannot drift again.
