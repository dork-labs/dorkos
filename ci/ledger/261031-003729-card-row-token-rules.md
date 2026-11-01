---
id: 261031-003729
title: 'The design-token gate learns four hard rules for cards and rows'
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

UI overhaul Phase 2 (cards and rows, PR A) took the border off `Card` and `FieldCard`, the rules out of `FieldCardContent`, and `ring-2` off the row focus and selection marks. `scripts/check-design-tokens.ts` keeps them gone with four hard rules: `divide-y` in `shared/ui/` (except `table.tsx`), a `className` with a border on `<FieldCard>`, a border in the `Card` and `FieldCard` base classes, and `ring-2` as a selected or focused row mark (except the topology canvas, `features/mesh/ui/`). Each was at zero when it landed, so no baseline entry. Rules gain an optional `except` pattern for the two allowlists.

Same job, same cost (text only, under a second). Revert a rule if it starts flagging a sanctioned use the allowlist can't name.
