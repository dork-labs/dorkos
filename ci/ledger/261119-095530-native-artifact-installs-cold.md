---
id: 261119-095530
title: the native release artifact build installs cold, with no dependency cache restored or saved
kind: experiment
status: proposed
actor: agent
gates:
  - wf.browser-native-release-artifact.build-darwin
  - wf.browser-native-release-artifact.verify-linux-handoff
prs: []
hypothesis:
  metric: 'tracked.cache-hit-rate'
  baseline: null
  baseline_source: 'Run 44489506177 (the v0.137.0 publish), build-darwin job 135441256435: setup-node got `cache: pnpm` (08:40:11Z), found no cache (08:40:13Z, 2048 packages downloaded), then its post step saved node-cache-macOS-arm64-pnpm-98c89d42d0851acd9f1cc09f5e583a0a6ae8a5dc225ba67df0f33d78b66308a2 (08:43:23Z). verify-linux-handoff had the same input.'
  target: 0.8
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4772. DOR-4695 (#3944, ledger 261118-130500) made the tag-run release jobs install cold but
missed `browser-native-release-artifact.yml`, the run `pnpm publish:cli` dispatches to build the
Mac CLI and native assets that ship in `dorkos`. Both its jobs still passed `cache: pnpm` to
`actions/setup-node`. In the v0.137.0 publish the restore missed, so the cold-install check
passed, but the post step saved a cache the next release's build could restore.

Both jobs now pass no `cache:` input and set `package-manager-cache: false`. With setup-node
v7.1.0 (now pinned by SHA, as in DOR-4695), that means no restore and no post-step save; the
second input keeps its automatic caching off even if package.json's `packageManager` ever names
npm. `pnpm install --frozen-lockfile` fetches from the registry and checks every package
against pnpm-lock.yaml's integrity hashes. The cost is one cold install per job per release.

The saved key above is deleted separately, before the next publish, by the coordinator with
Security's OK. The four non-release workflows that still cache pnpm are follow-ups on the
ticket, not this change.

Expected on the next native run: neither job's log shows a cache restore or a `Cache saved`
line, and no new `node-cache-*` entry appears for it. Revert only with Security's OK.
