---
number: 34
title: Allow Any Principal to Author ACL Rules
status: accepted
created: 2026-02-25
spec: mesh-network-topology
superseded-by: null
---

# 34. Allow Any Principal to Author ACL Rules

## Status

Accepted

Amended by [261006-235240](261006-235240-one-message-system.md) (one message system; 2026-10-06 vision reset): retires access rules as something to author at all. Anyone in a space may message anyone once Relay merges into conversations; until then rules stay an opt-in firewall (261006-225605) and this still governs who may write them.

## Context

Mesh topology access rules control which project namespaces can communicate. The research recommended human-only authorship (with optional agent-proposal-then-approve queue) to prevent agents from self-granting cross-project access. However, for the current single-user context, maximum autonomy was preferred to minimize configuration friction and enable fully autonomous agent networks.

## Decision

Allow any principal (human or agent) to create and modify cross-namespace ACL rules directly, with no approval queue. Both the HTTP API (`PUT /api/mesh/topology/access`), MCP tools, and client UI can author rules. This prioritizes operational simplicity and autonomous agent capability over defense-in-depth.

## Consequences

### Positive

- Maximum autonomy — agents can negotiate cross-project access without human intervention
- Simpler implementation — no approval queue, pending state, or notification system needed
- Enables fully autonomous multi-project agent networks

### Negative

- A compromised agent could open cross-project access, creating a lateral movement vector
- No audit trail distinguishing human-authored from agent-authored rules
- May need to be tightened to human-only or approval-gated in multi-user deployments
