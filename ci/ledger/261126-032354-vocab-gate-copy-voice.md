---
id: 261126-032354
title: The vocab gate bans app-copy voice words and generic button labels (waves 9-11)
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

The app-copy rules ("never we, I, please, sorry", "buttons are never OK, Yes,
No, Submit or Confirm") were stated as musts and checked by nobody
(DOR-4943). Three waves in `scripts/vocab-gate/banned-terms.json` now enforce
them, with three optional wave fields the gate learned for it: `roots` (path
prefixes), `caseSensitive` (so "I" is the pronoun and "i.e." is not) and
`"match": "button-label"` (the word must be a button's whole label,
`scripts/vocab-gate/button-label.ts`).

The waves cover `apps/client/src` only. Against the base they report 14 hits
(4 "we", 5 "I", 5 button labels), seeded as 13 `contains`-scoped allowlist
entries, so the gate starts green and the list only shrinks.

Hygiene, not an experiment: one more pass of the same parser walk, no gate
timing or failure rate should move. Revert a wave, or narrow it with a scoped
allowlist entry, if it fires on text that is not copy.
