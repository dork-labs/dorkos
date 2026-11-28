---
id: 261128-023428
title: Security's main path list names the startup step that wires the tasks tools' reach (C9a part 2)
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

C9a part 2 (DOR-5482) turns the five tasks tools into capabilities in
`services/tasks/agent-tools/` (already on the list). They reach audit, marks,
notices, Mesh lookups, the time zone and the untrusted-text fence through
`AgentToolDeps.tasksReach`, which `startup/task-tool-reach.ts` wires at boot;
unwired, every tasks tool refuses. That file joins the main list in
`security-gate.yml`'s `SECURITY_PATH_PATTERN`, its regex fixture and
`Policy.swift`, with a parity row and a look-alike that stays off. The rest of
part 2's ledger notes extend 261127-232656 (part 1). Revert only with the
conversion itself.
