---
id: 260912-025252
title: The ui capability domain gives every runtime the same canvas and browser seat
status: proposed
created: 2026-09-12
spec: canvas-agent-seat
superseded-by: null
amends: null
---

# 260912-025252. The ui capability domain gives every runtime the same canvas and browser seat

## Status

Proposed (extracted from spec `canvas-agent-seat`).

## Context

`control_ui`, `get_ui_state` and the three `browser_*` tools are hand-registered in
`claude-code/mcp-tools/`, and `register-from-definitions.ts:30-50` already records the consequence as a
stated fact: they reach neither the external `/mcp` server nor the loopback `dorkos` server that Codex
and OpenCode are injected with. So a Codex member of a room cannot see a console error and a
claude-code member can. In a product whose headline is one place for every agent you run, that is a
hidden pecking order, and it gets worse with every verb added to the seat. Rooms already solved the
same problem the other way: `rooms.read_canvas` is a capability with `servers: ['in-session',
'external']`, and the in-session surface is exactly what the loopback server registers
(`agent-runtime-server.ts:23-41`), with the calling session taken from the verified principal rather
than from an argument.

## Decision

We will declare a `ui` capability domain in `services/session/ui-capabilities.ts` holding every canvas
and browser verb — the five that exist and the nine this spec adds — each with
`servers: ['in-session']`, each handler keyed on `context.sessionId`. The claude-code hand
registrations are deleted and their handlers moved, so there is one implementation, one description and
one input schema per verb. `servers: ['in-session']` is what now keeps these tools off `/mcp`, which is
what the deleted paragraph used to guarantee by omission; a test asserts it directly.

## Consequences

### Positive

- Claude Code, Codex and OpenCode get the same tools with the same names, and a new runtime inherits
  the whole domain by being injected with the loopback server — it owes this seat no code.
- One implementation per verb instead of a hand registration and a capability drifting apart.
- The "these five stay off `/mcp`" property becomes a checked assertion rather than a comment about
  which table has fewer entries.
- Tier, approval and gate handling come from the registry, which already enforces them.

### Negative

- The move reds four count guards at once — the in-session tool census, the deferred count, the
  hand-registered census and `MCP_TOOL_TIERS`'s keys — and each has to be re-derived rather than
  patched to green.
- A capability's handler context carries a session id only on the in-session surface, so the whole
  domain is unreachable from any surface that has none, and each verb must refuse that case by name.
- `MCP_TOOL_TIERS` and the capability definitions become two places a tier can live, which is already
  true but becomes true of five more tools.
