---
id: 261010-194954
title: Drop the banned-words carve-out for the retired cockpit shot key
kind: hygiene
status: active
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

DOR-2762 renames the live product shot `cockpit` to `team-room`, so `scripts/check-banned-words.sh` no longer needs to exempt `id="cockpit"` in docs prose. The carve-out for `cockpit-light.png` stays, because the frozen archives and the release posts that embed them keep that file name. One test case in `scripts/test-check-banned-words.sh` flips from "allowed" to "flagged". No gate, required check, retry or timeout changes. Revert if a live docs page still needs to embed the old key.
