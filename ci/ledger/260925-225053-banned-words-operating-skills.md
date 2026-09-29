---
id: 260925-225053
title: The banned-words guard reads the operating skills
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck, wf.scripts-test.harness]
prs: []
ratchet-release: []
field-changes: []
---

`packages/operating-skills` is prose seeded into every agent's
`.agents/skills/`, and an agent repeats it to the person it works for. Neither
vocabulary gate read it: `check-vocab-gate.ts` parses render positions in
`apps/*/src`, and `check-banned-words.sh` listed only READMEs, docs and blog
posts. A retired "cockpit" sat in `reading-activity.ts` on main because of it
(DOR-2068).

`check-banned-words.sh` now scans `packages/operating-skills/src/skills/*.ts`
and `tool-name-note.ts` as prose. Against main it goes red on that line; the
line is reworded in the same change. Two new fixture cases pin the new
surfaces, and every red fixture now has to name its seeded file: exit 1 alone
was not proof, because bash 3.2 also exits 1 on an empty file list, which is
what an unscanned tree produces. Both new cases failed that way before the
script change.

Hygiene, not an experiment: no gate timing or failure rate should move beyond
the one real hit. Revert, or mark the line `vocab-allow`, if the guard ever
fires on a legitimate technical use inside the package.
