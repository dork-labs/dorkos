---
id: 261102-020445
title: Security gate covers the code that decides who a turn or a schedule runs as
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-3640 showed that whoever picks a session's folder or a schedule's target picks who it runs as. The code that decides that (the session launch service, the scheduled-task service, agent identity, the external MCP tools, and the `session_start` and `tasks_*` tools) sat outside `SECURITY_PATH_PATTERN`. So #3417 and #3418 could have merged without Security's label.

`security-gate` now treats those folders as security paths, and the pattern's reviewed copies (`fixtures/security-path-pattern.regex`, `tools/security-approve/Policy.swift`) move with it. No required check, shard, retry or timeout changes. More PRs will wait for Security's label; that is the point.

Revert, or narrow a path, if Security rules a path does not decide identity or power.
