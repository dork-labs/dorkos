---
id: 261111-193622
title: 'Browser legs skip the build CI already ran'
kind: experiment
status: proposed
actor: agent
gates: [wf.browser-test.browser-shard]
prs: []
hypothesis:
  metric: 'gate.wf.browser-test.browser-shard.duration_p90@merge_group'
  baseline: 29.5
  baseline_source: 'browser-shard jobs of the 12 newest green merge_group browser-test.yml runs to 2026-11-11 (43077554931 … 42936497104), n=72, p50 25.38 min, p90 29.48 min'
  target: 24.5
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4190, cleanup phase 4. Every browser shard spends 6 to 8 minutes starting its server legs before the first test (run 43007007159: tests began at +392 s on shard 3, +8.3 min on shard 1). Playwright starts the legs one after another, and three of them run `turbo run build` first: the two API legs (`@dorkos/server`) and the production leg (`@dorkos/server` + `@dorkos/client`). The workflow has already built exactly those packages in its own step ("Build what the webServer legs boot from"), and the legs' builds were meant to be cache replays (the production leg's comment says so). They are not: on shard 3 every task missed the cache, costing 96 s and 110 s on the API legs and about 150 s on the production leg's client. A local `turbo run build --dry=json` with each leg's env gives the same hashes as the step, so the miss comes from something in the CI suite step's environment, not from the source.

The change does not chase the hash. Under `CI`, `apps/e2e/playwright.config.ts` drops a leg's `turbo run build` when the build step's outputs are already on disk (`apps/server/dist/index.js`, and `apps/client/dist/index.html` for the production leg). Locally nothing changes: there is no build step, and a dist from an older checkout would boot stale code. A CI job without the step finds no outputs and builds as before. No workflow file changes (they are frozen until DOR-4030), and no test is removed or skipped. The API legs boot from source (`tsx src/index.ts`); their build only ever produced workspace-dependency dists, which the step built.

Expected saving is about 4 to 6 minutes of every shard's boot, so the shard p90 should fall from 29.5 to 24.5 minutes or lower. The same change speeds the four PR `@smoke` shards, whose build step covers the same packages.

Revert if any shard fails to boot or a spec fails because a leg ran against output the build step did not produce, or if the p90 does not move by at least 3 minutes after 14 days (then the boot time is somewhere else and this explanation is wrong).
