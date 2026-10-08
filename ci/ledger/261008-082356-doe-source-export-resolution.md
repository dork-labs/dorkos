---
id: 261008-082356
title: Resolve Doe source exports in fresh CLI builds
kind: incident-fix
status: proposed
actor: agent
gates: [wf.cli-smoke-test.build-tarball, wf.test.community-packaged]
prs: [2687]
hypothesis:
  metric: 'gate.wf.cli-smoke-test.build-tarball.failure_rate@pull_request'
  baseline: 0
  baseline_source: 'origin/ci-steward-data snapshots/2026-10-06.json: 9 build-tarball pull-request runs, all successful; PR 2687 then reproduced a deterministic missing Doe dist failure locally and in run 37748589368'
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

The CLI source resolver reads a package's `types` entry but only its `default`
JavaScript export condition. Doe publishes `types` and `import`, so a fresh
checkout falls back to an absent `dist/` entry. A previously built Doe package
hides the defect locally. The packed community check reaches the same CLI build.

Resolve `import` when `default` is absent, keeping the existing source mapping
and bundle policy. A regression builds a temporary package with no compiled
files; the production CLI build is also run with Doe's dist removed.

The measured zero failure baseline is the ceiling: preserve successful fresh
builds after adding Doe. Revert if the source resolution changes an existing
package's bundle or causes a fresh build failure. No gate, timeout, retry,
required status, or quality floor changes.
