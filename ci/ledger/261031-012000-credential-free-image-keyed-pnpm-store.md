---
id: 261031-012000
title: credential-free-build keeps its own pnpm store, keyed on the runner image
kind: incident-fix
status: proposed
actor: agent
gates: [wf.credential-free-build.credential-free-build]
prs: []
hypothesis:
  metric: gate.wf.credential-free-build.credential-free-build.ejections_caused
  baseline: 4
  baseline_source: 'merge_group runs 41145834553, 41145832965, 41145986003 and 41145987309 on 2026-10-30 (23:40Z-23:41Z): each boot probe died with "Missing dependency: ./prebuilds/linux-x64//pty.node" on Image ubuntu-24.04'
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

`credential-free-build.yml` no longer uses setup-node's `cache: pnpm`. It restores and saves its own store with `actions/cache`, keyed on `ImageOS` as well as OS, arch and lockfile. Same fix as ledger 261030-001500 for the browser suite.

Why: setup-node keys the pnpm store on OS + arch + lockfile hash only, so every Linux job shares one entry. pnpm keeps native build output in the store, and node-pty 1.1.0 has no linux-x64 prebuild, so it is compiled at install. This job runs on `ubuntu-latest`. The shared store (saved 2026-10-30 12:53Z on main) was built on 26.04. From 23:39Z, `ubuntu-latest` began giving this job 24.04 runners, which cannot load that `pty.node`. node-pty reports only its last probe (`prebuilds/linux-x64/`), so the error reads as a missing file; the doubled slash is node-pty's own path join.

Evidence: every green run up to 23:35Z (41136786605, 41145136246, 41145353740) logged `Image: ubuntu-26.04`; every red one from 23:39Z (41145731794, 41145829415, 41145987309) logged `Image: ubuntu-24.04`. The red ones include a PR branch with none of that evening's merges. Lockfile, node-pty 1.1.0 and Node 24.22.1 were the same in both.

Revert, back to `cache: pnpm`, once every Linux job runs on one image.
