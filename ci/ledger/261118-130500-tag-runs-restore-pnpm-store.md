---
id: 261118-130500
title: tag-triggered release runs restore main's pnpm store instead of saving their own
kind: experiment
status: proposed
actor: agent
gates:
  - wf.desktop-release.build-macos
  - wf.desktop-release.build-windows
  - wf.publish-community.build-and-publish
prs: []
hypothesis:
  metric: 'tracked.cache-hit-rate'
  baseline: null
  baseline_source: 'gh api actions/caches, 2026-11-18 12:50Z: 12.21 GB in 123 entries against the 10 GB budget. On refs/tags/v0.136.0, created 06:18-06:25Z by the release: node-cache-Linux-x64-pnpm 735 MB, node-cache-Windows-x64-pnpm 695 MB, node-cache-macOS-arm64-pnpm 687 MB (setup-node cache: pnpm), plus 98 buildkit-blob entries (4.75 GB) that #3910 already stops for the next release.'
  target: 0.8
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4635 (Actions cache under 10 GB), second slice after #3910. It also covers the
`desktop-release.yml` tag-ref save that DOR-4628 names.

`desktop-release.yml` (build-macos, build-windows) and `publish-community.yml` run on tag pushes
and used `actions/setup-node`'s `cache: pnpm`. That restores and, on a miss, saves the pnpm store
in the tag's own scope. GitHub lets a run restore only from its own ref and the default branch,
so the next release never reads what this one saved. v0.136.0 left about 2.1 GB of
`node-cache-*` across three OSes, on top of the Docker layers #3910 removes from future releases.
Over 10 GB, GitHub evicts least-recently-used entries first, and those are main's.

Each of the three installs now restores `pnpm-store-<os>-<ImageOS>-<arch>-<lockfile>`, the key
main's own runs save (test.yml test-shard, typecheck, lint, harness-windows weekly). A tag can
read main's scope, and nothing here saves. A miss installs from the registry, as a first
release attempt mostly did before (no `node-cache-*` entry existed on main for Linux or Windows).
The step that finds the store runs with `shell: bash` so `${ImageOS:?}` works on the Windows
runner.

Expected after the next release: no `node-cache-*` entry on any `refs/tags/*` ref. Watch the
three gates' durations for an install-time regression on a lockfile that main hasn't saved yet.
Revert if a release install regularly runs slower than before.
