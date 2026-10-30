---
id: 261030-001500
title: The browser suite keeps its own pnpm store, keyed on the runner image
kind: incident-fix
status: proposed
actor: agent
gates: [wf.browser-test.browser-shard, wf.browser-test.first-run]
prs: []
hypothesis:
  metric: gate.wf.browser-test.browser-shard.ejections_caused
  baseline: 2
  baseline_source: 'merge_group runs 40969273284 (#3194, 22:53Z) and 40974091542 (#3245, 23:34Z) on 2026-10-29: every shard and first-run died at boot with "Failed to load native module: pty.node"'
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

The three pnpm installs in `browser-test.yml` (browser-shard, first-run, copy-spec-drift) no longer use setup-node's `cache: pnpm`. They restore and save their own store with `actions/cache`, keyed on `ImageOS` as well as OS, arch and lockfile.

Why: setup-node keys the pnpm store on OS + arch + lockfile hash only, so every Linux workflow in a run shares one entry, and the first job to finish saves it. pnpm keeps native build output in the store. node-pty 1.1.0 has no linux-x64 prebuild, so it is compiled at install. Since ledger 261027-053504 pinned this file to `ubuntu-24.04`, the rest of CI runs on `ubuntu-latest` = 26.04. When a 26.04 job saves first, the 24.04 shards get a `pty.node` they cannot load. node-pty reports only its last probe (`prebuilds/linux-x64`), so the error reads as a missing file.

Evidence: both failing runs restored a store that `db-check` saved on `Image: ubuntu-26.04` (22:27:50Z on #3194's queue ref, 23:36:43Z on #3245's). Green runs (#3251's 40972875642) restored one saved by `copy-spec-drift` on `ubuntu-24.04`. Neither install compiled node-pty; both took it from the store. The cache key and the Node version (24.22.1) were the same in both.

Revert, back to `cache: pnpm`, together with the 24.04 pin, once the browser suite runs on the same image as everything else.
