---
id: 261128-034215
title: Security's path list covers report routing, helper-turn windows and the tool tier tables
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Reviews of #4585, #4589, #4594 and #4591 found files that decide security
outcomes but sat outside Security's path list:

- `services/rooms/handoff/outbox/`: which chat a spin-off's report reaches.
- `runtimes/claude-code/warm-ceiling.ts`, `sessions/persistent-dispatch.ts`,
  `sessions/dispatch/asks-between-turns.ts`: the power ceiling on helpers left
  running, and how their asks reach the person.
- `runtimes/claude-code/sessions/session-turn-windows.ts` and
  `sessions/frames/`, plus `services/session/runtime-turns/`: which turn a
  frame and its text belong to, and when the queue moves.
- `services/core/mcp-tool-tiers.ts` and `services/core/mcp-server.ts`: the
  tool tier table and the MCP server's composition.
- `runtimes/opencode/messaging/compaction-model.ts`: arms the project-plugin
  check before OpenCode compaction (DOR-5258, #4586).

The same entries are in the workflow, the fixture and Policy.swift, with a
parity row and a look-alike for each.
