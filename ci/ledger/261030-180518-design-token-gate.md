---
id: 261030-180518
title: 'A design-token gate in the typecheck job: scrims and z-indexes are tokens, literals may only fall'
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

UI overhaul Phase 1 turned colours, scrims and the stacking order into tokens. `scripts/check-design-tokens.ts` keeps them that way: a black scrim class, or a literal z-index in `packages/ui/src`, may not exist; raw palette classes, pure white and black, and stray focus rings are held per file to `scripts/design-tokens/baseline.json`, where a count may only fall.

It rides the `typecheck` job, which is required, unfiltered and reports on `merge_group`, so there is no new required check. It reads text with no parser and takes under a second, so no timing metric can see it. Its measure is the baseline's total on `main`, which should fall as Phase 2 sweeps.

Revert or rework if conflicts in `baseline.json` between concurrent PRs become a regular cause of DIRTY PRs.
