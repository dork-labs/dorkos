---
id: 261126-014225
title: Security's path list covers lib/http/agent-identity-header.ts (DOR-4922)
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4922 moves the pure agent-identity header check (`presentsAgentIdentity`) out of `middleware/agent-identity.ts`, so services can use it without importing middleware. It is trust code, so its new home, `apps/server/src/lib/http/agent-identity-header.ts`, joins `SECURITY_PATH_PATTERN` with a match row. At Security's request, two paths the change makes trust-deciding join too: `apps/server/src/services/core/streams/` (the upgrade router authorizes WebSocket and stream upgrades) and `apps/server/src/startup/upgrade-guards.ts` (it wires those guards in), each with a row in `security-paths-check.test.mjs`. One path added and nothing removed, so Security's gate sees the same code it saw before the move. Nothing measurable should move.
