---
id: 261126-170500
title: Security's path list covers the chat reads folder
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4978 (A1). The new folder `apps/server/src/services/session/reads/` holds
the chat reads on the capability mount, including who may read a chat. It was
not on Security's list. On Security's call, `SECURITY_PATH_PATTERN` (workflow,
reference fixture and `Policy.swift`) gains it beside the other named session
folders, and the parity test gets a row with a look-alike that stays off. This
only widens which PRs need Security's review. No job, timing or trigger
changes, so nothing measurable should move.
