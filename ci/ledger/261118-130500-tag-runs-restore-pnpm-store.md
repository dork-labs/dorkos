---
id: 261118-130500
title: tag-triggered release runs install cold, with no dependency cache restored or saved
kind: experiment
status: proposed
actor: agent
gates:
  - wf.desktop-release.build-macos
  - wf.desktop-release.build-windows
  - wf.publish-community.build-and-publish
prs: [3938, 3944]
hypothesis:
  metric: 'tracked.cache-hit-rate'
  baseline: null
  baseline_source: 'gh api actions/caches, 2026-11-18 12:50Z: 12.21 GB in 123 entries against the 10 GB budget. On refs/tags/v0.136.0, created 06:18-06:25Z by the release: node-cache-Linux-x64-pnpm 735 MB, node-cache-Windows-x64-pnpm 695 MB, node-cache-macOS-arm64-pnpm 687 MB (setup-node cache: pnpm), plus 98 buildkit-blob entries (4.75 GB) that #3910 already stops for the next release.'
  target: 0.8
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4635 (Actions cache under 10 GB), second slice after #3910, and DOR-4695 option (a). It
also covers the `desktop-release.yml` tag-ref save named in DOR-4628.

`desktop-release.yml` (build-macos, build-windows) and `publish-community.yml` run on tag pushes
and used `actions/setup-node`'s `cache: pnpm`. That restores and, on a miss, saves the pnpm store
in the tag's own scope. GitHub lets a run restore only from its own ref and the default branch,
so the next release never reads what this one saved. v0.136.0 left about 2.1 GB of
`node-cache-*` across three OSes, on top of the Docker layers #3910 removes from future
releases. Over 10 GB, GitHub evicts least-recently-used entries first, and those are main's.

The first version of this change restored main's `pnpm-store-*` entry instead. On Security's
review, these three installs now use no dependency cache at all, because release jobs hold
signing and publish credentials. `pnpm install --frozen-lockfile` fetches from the registry and
checks every package against pnpm-lock.yaml's integrity hashes. The cost is one cold install per
job per release, about a minute or two. `actions/setup-node` is pinned by SHA (v7.1.0) in both
files.

Expected after the next release: no `node-cache-*` entry on any `refs/tags/*` ref, and no
release job restoring any Actions cache. Watch the three gates' durations: one cold install
each is the expected cost. Revert only with Security's OK.
