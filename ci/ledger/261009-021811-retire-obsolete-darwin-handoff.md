---
id: 261009-021811
title: Retire the obsolete Mac observer release handoff
kind: hygiene
status: proposed
actor: agent
gates: [wf.cli-smoke-test.build-tarball]
prs: [2686]
ratchet-release: []
field-changes: []
---

Remove the manually dispatched observer artifact producer and its dependent Linux handoff job, plus the release command's dispatch/download/old attestation route. They no longer describe the VM graph. Neither job is required or runs on PR/merge-group; removing them changes no required status, retry, timeout, shard or quality floor. Remove their two census entries and mark their already-merged historical ledger entry reverted without rewriting its original body.

The release command retains exact clean version/tag/commit binding, fresh trusted-main ancestry checks before original build/packing/publication, normal prepublish checks and retained package receipt. It accepts only the fixed empty VM release selection; a future nonempty candidate requires genuine publisher integration rather than a copied metadata bypass. No signed release asset is invented and no catalogue is enabled. Existing non-Darwin CLI native artifact builder/import/verifier sources and callers remain unchanged.

Keep the existing tag/ancestry controls, replace obsolete dispatch controls with fixed empty-selection and retired-route regression checks. Root must execute types/lint, scoped tests, census and ledger coverage after adoption; no workflow was run by the source author. Revert if release selection can become active from candidate data or if source/tag/main checks are bypassed. No performance baseline or computed verdict is claimed for this correctness hygiene.
