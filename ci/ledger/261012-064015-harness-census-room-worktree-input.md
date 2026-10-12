---
id: 261012-064015
title: Hash the room-worktree test the harness census now reads
kind: hygiene
status: active
actor: agent
gates: [wf.test.test-shard]
prs: [2772]
ratchet-release: []
field-changes: []
---

DOR-2460 points the harness capabilities census at one more test file, `apps/server/src/services/rooms/repo/__tests__/room-worktree-manager.test.ts`, whose legacy-plumbing test covers row TR-05. The census reads test titles from that file, so `@dorkos/harness#test` now lists it in its turbo `inputs`, the same way the other census roots are listed; otherwise a renamed title there would not re-run the census (`turbo-census-inputs.test.ts` enforces this). One input added, no gate, required check, retry or timeout changes. Revert together with the census root if TR-05 stops claiming that test.
