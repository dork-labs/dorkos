---
id: 261124-004043
title: contributing/ci.md and three script comments stop describing arming
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.queue-repeat-guard.door
prs: []
ratchet-release: []
field-changes: []
---

Follow-up to DOR-5124 (#4200), found by the docs chat's review: the guide still said the verify proof
gates arming, told people to re-arm, and named merge-tail.yml in the token paragraph and the steward
fence. Comment and message text only, plus the merging section now names all three sanctioned uses of
`gh pr merge --auto`. No behaviour changes.
