---
number: 32
title: Use Hybrid Filesystem + Manifest Namespace Derivation
status: draft
created: 2026-02-25
spec: mesh-network-topology
superseded-by: null
---

# 32. Use Hybrid Filesystem + Manifest Namespace Derivation

## Status

Draft (auto-extracted from spec: mesh-network-topology)

## Context

Mesh needs to determine which "project namespace" each agent belongs to for access control isolation. The litepaper states "default-allow within a project, default-deny across projects" but doesn't define the project boundary. Three approaches were considered: pure filesystem derivation, pure manifest declaration, and a hybrid of both. Container orchestration systems (Kubernetes, Docker Compose) use topology-derived namespaces with override capability.

## Decision

Use hybrid filesystem-derived namespaces with optional manifest override. The default namespace is computed from the first path segment after the scan root (e.g., `~/projects/dorkos/core` discovered from `~/projects` yields namespace `dorkos`). An optional `namespace` field in `.dork/agent.json` overrides the derived value. The operator confirms the namespace at registration time. This mirrors Kubernetes topology-derived namespaces and Docker Compose's `COMPOSE_PROJECT_NAME` override pattern.

## Consequences

### Positive

- Zero-config for the common case — agents in the same project directory tree share a namespace automatically
- Escape hatch via manifest override when directory structure doesn't match logical project boundaries
- Namespace is anchored to filesystem topology, preventing spoofing from manifest alone

### Negative

- Requires storing `scan_root` per agent in the registry to make derivation reproducible
- Directory renames change the namespace (agents must be re-registered)
- Multi-root scans could produce surprising namespace assignments if roots overlap
