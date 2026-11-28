---
id: 261127-194421
title: Security's path list covers the owner-scoped stores moved out of routes
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4923 (#4494) moved two route files' database logic into services:
`services/core/runtime-seam/session-location-store.ts`, whose queries are
filtered to the person who owns each session location, and
`services/core/runtime-seam/person-draft-settings.ts`, which writes the
person's draft settings. Their routes are on the list, so these move with
them. The same entry is in the workflow, the fixture and Policy.swift, with a
parity row and a look-alike for each.
