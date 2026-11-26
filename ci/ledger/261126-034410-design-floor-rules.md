---
id: 261126-034410
title: The design-token check refuses text under the floor, and raw icon sizes only fall (DOR-4944)
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

`contributing/design-review.md` named the floors and said a lint would make them real; nothing did. `scripts/check-design-tokens.ts` gains two rules in its existing shapes. `text-under-floor` is hard: a literal `text-[Npx]` under 12px fails, since a literal never grows on the phone and 12px is the phone's absolute floor (§2.2, `floors.json`). Its 10 uses are swapped for `text-3xs` or `text-2xs` in the same PR, so it starts at zero. `raw-icon-size` is a ratchet: per file, the icons (lucide imports, `<svg>`, `Icon`/`*Icon` tags, `x.icon`) sized with a numeric `size-N`, an `h-N w-N` pair or `size={N}`. It is seeded at 876 across 439 files. No pipeline metric: the other design-token ratchets have none, and the total is read from `baseline.json`.

To stay under 500 lines the gate's verdict functions (`compare`, `seedableRules`, `raisedAgainst`, `describe`) move to `scripts/design-tokens/compare.ts`, loaded by `main` the way the rule guard is. `RULE_HELPERS` is unchanged, so no existing rule's fingerprint moves.

Nothing measurable should move: one regex and one tag scan over files the check already reads, and the check still takes under half a second. Revert the icon rule if it counts things that are not icons often enough that a PR has to work around it.
