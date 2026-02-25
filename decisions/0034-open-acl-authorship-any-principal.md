---
number: 34
title: Allow Any Principal to Author ACL Rules
status: draft
created: 2026-02-25
spec: mesh-network-topology
superseded-by: null
---

# 34. Allow Any Principal to Author ACL Rules

## Status

Draft (auto-extracted from spec: mesh-network-topology)

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
