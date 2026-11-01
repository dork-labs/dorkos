---
id: 261101-232823
title: "The count rules' one allowed home moves with CountPill to packages/ui"
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

DOR-3635 moved `CountPill` and its caps from `apps/client/src/layers/shared/ui/count-pill.tsx` to `packages/ui/src/count-pill.tsx`, so the Space pages (which may import `@dork-labs/ui` but not the app's layers) draw the real pill instead of a copy. The gate already scans `packages/ui/src`, so the moved file tripped `local-count-cap` and `hand-rolled-count`. Both rules' `except` now name `packages/ui/src/count-pill.tsx` in place of the old app path; nothing else in either rule changed, and `badge.tsx` and `TouchChip` stay allowed as before. The old app path is now a re-export with no pill of its own, so it leaves the allowlist: a pill rebuilt there is refused again, and the gate's tests say so. Each rule is still at zero, so no baseline entry.

The `except` change is a rule change to the rule guard (DOR-3557), so the PR needs a fresh `guard-rule-change` label from Security. Same job, same cost (text only, under a second). Revert by pointing both `except` patterns back at the app path, which only makes sense if the pill moves back.
