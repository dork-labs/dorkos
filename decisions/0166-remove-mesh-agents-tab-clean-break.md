---
number: 166
title: Remove MeshPanel Agents Tab for Clean Separation
status: superseded
created: 2026-03-20
spec: agents-page
superseded-by: 247
---

# 0166. Remove MeshPanel Agents Tab for Clean Separation

## Status

Superseded by ADR-0247 (Consolidate Mesh Dialog to Agents Page) — the MeshPanel dialog this ADR reshaped was removed entirely; its remaining views moved to the /agents page.

## Context

With the introduction of a dedicated `/agents` page, the Agents tab in MeshPanel becomes redundant. Maintaining two agent list UIs creates confusion about which is the canonical surface and increases maintenance burden. The Mesh dialog serves a different purpose (topology, discovery, access control) than fleet management.

## Decision

Remove the Agents tab from MeshPanel entirely. MeshPanel becomes: Topology | Discovery | Denied | Access. The dedicated `/agents` page is the single agent management surface. The `AgentCard` component in `features/mesh/ui/` is preserved (used by topology interactions) but the inline `AgentsTab` and its inline `AgentCard` in MeshPanel are removed.

## Consequences

### Positive

- Single source of truth for agent management — no confusion about which UI to use
- Reduced maintenance — one agent list to maintain, not two
- MeshPanel becomes focused on its core domain (network topology, discovery, access control)
- Cleaner separation of concerns between mesh infrastructure and agent fleet management

### Negative

- Users who previously used the Mesh dialog for quick agent checks must navigate to `/agents` instead
- One more sidebar click for users who opened Mesh primarily for the Agents tab
