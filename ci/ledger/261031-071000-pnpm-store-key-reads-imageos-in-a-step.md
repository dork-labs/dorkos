---
id: 261031-071000
title: The pnpm store key reads ImageOS in a step, since env.ImageOS was always empty
kind: incident-fix
status: proposed
actor: agent
gates:
  [
    wf.credential-free-build.credential-free-build,
    wf.test.test-shard,
    wf.test.community-pg,
    wf.browser-test.browser-shard,
    wf.browser-test.first-run,
  ]
prs: []
hypothesis:
  metric: gate.wf.credential-free-build.credential-free-build.ejections_caused
  baseline: 4
  baseline_source: 'same baseline as ledger 261031-012000 (merge_group runs 41145834553, 41145832965, 41145986003, 41145987309 on 2026-10-30), which this entry corrects: that fix never separated the images'
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

Ledgers 261030-001500 and 261031-012000 keyed the pnpm store on `${{ env.ImageOS }}`. That is always empty: the `env` context holds only variables a workflow, job or step sets, never the runner's own. So every key read `pnpm-store-Linux--X64-<lockfile>`, on every image, and the two fixes kept one shared store, the very thing they set out to split.

Evidence: #3341's `credential-free-build` run 41158979135 logged `Cache restored from key: pnpm-store-Linux--X64-826e14a7…` on `Image: ubuntu-24.04`. `gh cache list` showed one entry under that prefix, saved on main at 03:55Z. Both fixes went green only because that one store happened to be built on 24.04.

Now each `pnpm-store` step reads `$ImageOS` from its shell, writes it as the step's `image` output, and the key uses `steps.pnpm-store.outputs.image`. The step fails when `ImageOS` is unset (`${ImageOS:?…}`), so a missing image can never quietly become an empty key again. All six install jobs change: `credential-free-build`; `test-shard` and `community-pg` in `test.yml`; `browser-shard`, `first-run` and `copy-spec-drift` in `browser-test.yml`. `scripts/__tests__/credential-free-workflow.test.ts` now refuses `${{ env.ImageOS }}` in any of the three files.

The first run per image misses the cache and saves a fresh store under the new key.
