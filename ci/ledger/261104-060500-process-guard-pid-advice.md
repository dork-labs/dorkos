---
id: 261104-060500
title: Process guard advice finds PIDs without printing command arguments
kind: hygiene
status: proposed
actor: agent
gates: [wf.scripts-test.fixtures]
prs: []
ratchet-release: []
field-changes: []
---

The process guard recommended process discovery that prints full command lines.
MCP command arguments may contain secrets (DOR-3882). Both refusal messages now
recommend PID-only discovery and argument-free inspection. The testing rule and
fixtures use the same safe commands. New assertions check both refusal messages.
No kill decision, required check, timeout or permission changes.

CI status was read before editing: data through November 2 names headroom as the
constraint. This wording and fixture change makes no performance claim.
Revert or correct the advice if it prints arguments or suggests killing a process
the caller did not start; keep the existing kill protections.
