---
id: 261116-114302
title: the heavy-run slot leaves the root, so a root package.json edit no longer changes every build hash
kind: experiment
status: proposed
actor: agent
gates:
  - wf.test.test-shard
prs: []
hypothesis:
  metric: 'tracked.cache-hit-rate'
  baseline: 0
  baseline_source: 'turbo build cache hits in merge-queue test shards: runs 43822808186 and 43832945817 logged "Cached: 0 cached, 49 total", and so did 43788991004, 43790299474 and 43794818748, which had restored the canary entry (ledger 261116-091832). The collector reads restore-step hits, not turbo task hits, so read "Cached: N cached" in queue shard logs beside it.'
  target: 0.8
  after_days: 7
ratchet-release: []
field-changes: []
---

DOR-4536, the second limit ledger 261116-091832 named (DOR-4190 B1). Every `build`, `test`,
`typecheck` and `lint` task, and the package overrides of them, depended on the root task
`//#heavy-slot` (#3368, DOR-3274 Phase 2). turbo always hashes the root `package.json` and
`turbo.json` into a root task, whatever its `inputs` say, and each dependent folds that hash into
its own. So every edit to the root `package.json` (21 on `main` from 2026-11-09 to 11-16) changed
every build hash: the canary's restored entry replayed nothing, and every local turbo cache
missed on every root edit.

The change: the slot is now `@dorkos/heavy-slot#slot`, the `slot` script of a private,
dependency-free workspace package `packages/heavy-slot` (`node ../../scripts/heavy-turbo-slot.mjs`).
Its turbo hash covers only its own `package.json` and `$TURBO_ROOT$/scripts/heavy-turbo-slot.mjs`.
Behaviour is unchanged: `cache: false`, the same `passThroughEnv` (`CI`, `DORKOS_HEAVY_*`), a bare
`turbo build` locally still takes a host-wide slot for the turbo process's life, and it is still a
no-op under CI, `DORKOS_HEAVY_LOCK=0`, `DORKOS_HEAVY_SLOT_HELD` and on Windows. The process chain
under turbo (turbo, then pnpm, then the script's node) is the one the root task had, and
`findTurbo` found the turbo pid in a real `turbo run slot` run. The root `heavy-slot` script is
gone. `scripts/__tests__/heavy-turbo-slot.test.ts` pins the new task name and inputs and refuses a
root `//#…` slot.

Measured with `turbo run build --dry=json` (turbo 2.10.13), `@dorkos/icons#build`:

- `origin/main` (1f86df2d1b): `e260bd08008d85c8`; one added root script made it
  `1b8327d334890d31`; an unrelated `zz-dummy` task added to `turbo.json` made it
  `cfe560b5dc900afe`.
- This change: `e7bcf514e0e2f648` with the root script added, with it removed, and with the
  `turbo.json` dummy task. `@dorkos/server#build` stayed `7b7556052bcdbfed` the same way.

Expected: queue shards that restore a canary entry log `Cached: N cached` with N most of the 49
build tasks even when the root `package.json` changed since that canary. A lockfile change still
misses the packages whose resolved dependencies moved, and the global hash (`globalDependencies`,
global env) still invalidates everything. This shares its gate and window with 261115-201939 and
261116-091832, so the computed verdict may come out `inconclusive` for confounding. Revert if a
bare local `turbo build` stops taking a slot (no holder listed in `/tmp/dorkos-heavy-locks-<uid>`
while it runs), or if a queue shard fails "Prove the suite actually executed" on a replayed task.
