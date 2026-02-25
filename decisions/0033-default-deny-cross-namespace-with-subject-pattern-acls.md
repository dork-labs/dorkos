---
number: 33
title: Use Default-Deny Cross-Namespace with Subject-Pattern ACLs
status: draft
created: 2026-02-25
spec: mesh-network-topology
superseded-by: null
---

# 33. Use Default-Deny Cross-Namespace with Subject-Pattern ACLs

## Status

Draft (auto-extracted from spec: mesh-network-topology)

## Context

Mesh needs to enforce isolation between agent namespaces while allowing free communication within the same namespace. The access control rules must integrate with Relay's existing `AccessControl` engine which uses NATS-style subject pattern matching (ADR 0011). Options ranged from flat namespace-to-namespace rules to fine-grained agent-to-agent or capability-gated ABAC approaches.

## Decision

Use namespace-to-namespace access rules expressed as NATS-style subject patterns. When an agent is registered, Mesh writes two Relay access rules: a same-namespace allow rule at priority 100 (`relay.agent.{ns}.* → relay.agent.{ns}.*`) and a cross-namespace deny rule at priority 10 (`relay.agent.{ns}.* → relay.agent.>`). Cross-project access is granted by adding explicit allow rules at priority 50. This reuses the ADR 0011 subject-matching infrastructure already in Relay and follows OWASP BOLA principles (invisible boundaries return 404, not 403).

## Consequences

### Positive

- Reuses existing Relay AccessControl engine — no new policy evaluation logic needed
- Simple mental model: "project A can talk to project B" via a single rule
- Default-deny is secure by default — new namespaces are isolated automatically
- Can be refined to agent-level granularity later by adding higher-priority rules

### Negative

- Coarse granularity — all agents in a namespace share the same access profile
- Rule count grows with cross-namespace allowances (though typically small)
- Priority-based evaluation requires careful ordering to avoid unexpected behavior
