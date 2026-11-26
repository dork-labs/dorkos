---
id: 261126-001517
title: 'The design-token check refuses a bare focus: class (DOR-4939)'
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

`.claude/rules/components.md` says focus styles use `focus-visible:`, never a bare `focus:`, so a mouse click does not draw a ring. Nothing enforced it, and 9 uses had crept in. `scripts/check-design-tokens.ts` gains one hard rule, `bare-focus`, in the same shape as its other hard rules: a `focus:` utility in a className string fails. The 9 uses are swept in the same PR, so the rule starts at zero and there is no ratchet.

Nothing measurable should move: one more regex over the files the check already reads. Revert if it flags a real `focus:` need it cannot express (none found: text fields show focus on a click under `focus-visible:`).
