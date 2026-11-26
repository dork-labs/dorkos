---
id: 261126-081553
title: Security's path list covers the front-door capability doors
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4978 (A1). Two `services/core/` folders hold capability doors on the
front-door side: `session-relay-doors/` (chat from the web: its reads, Pause,
End and Unlink) and `runtime-doors/` (the runtime setup reads). Neither was on
Security's list. On Security's call, `SECURITY_PATH_PATTERN` (workflow,
reference fixture and `Policy.swift`) gains both, and the parity test gets a
row for each, with a look-alike that stays off. This only widens which PRs
need Security's review. No job, timing or trigger changes, so nothing
measurable should move.
