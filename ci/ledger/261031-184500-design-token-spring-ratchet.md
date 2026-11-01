---
id: 261031-184500
title: Ratchet inline spring numbers, and let the baseline check seed a new rule
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

This stacks on the overshoot-curve PR. It adds a `spring-literal` ratchet to `scripts/check-design-tokens.ts` that counts `stiffness:` outside `shared/lib/motion.ts`, with 14 files seeded in `baseline.json` at what the check measures.

Seeding needs one narrow change to `--base`, which otherwise reads any new rule's first baseline as a raise from 0. A rule may seed only when its id is absent from the base's rule list, and no rule the base defined is missing or renamed on this tree. Its baseline must equal the measured count per file, never higher. Tests refuse a rename used to reseed, a seed above the measured count, a rule already in the base, and a removed rule.

`kind: hygiene` because no pipeline metric should move: the check reads text from git-listed files and takes under a second. Revert it if `--base` refuses a PR that did not touch the baseline.
