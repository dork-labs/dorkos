---
id: 261123-224801
title: The evals workflow's rooms comment stops naming case counts
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Comment only; no step, trigger or gate changes. The comment above `Run rooms structural suite` in
`.github/workflows/evals.yml` said the run prints four cases and eight `skipped-wrong-tier` rows.
The rooms suite has grown well past that, so the comment now names no counts and points at the
run's own GATING line, which states how many cases gate.

Nothing to revert on: nothing runs differently.
