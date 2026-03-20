---
title: Connections Sidebar — Agent Filtering and List Caps
---

# Connections Sidebar: Agent Filtering and List Caps

**Date:** 2026-03-12
**Status:** Approved
**Scope:** `apps/client/src/layers/features/session-list/ui/ConnectionsView.tsx`

## Problem

The Connections tab sidebar shows all registered Mesh agents with no filtering and no length cap. Users with large Mesh registries see every agent regardless of relevance, and the MCP servers list can grow unbounded. Neither list accounts for the currently selected agent's context.

## Goals

1. Filter the agents list to only show agents the currently selected agent can reach
2. Cap the agents list at 3 visible items with an overflow link
3. Cap the MCP servers list at 4 visible items with an overflow link

## Non-Goals

- Changes to the Adapters section
- Changes to the DorkOS tools (Pulse, Relay, Mesh) rows
- New API endpoints or hooks
- Changes to any file outside `ConnectionsView.tsx`

## Design

### Agent Filtering

Use the existing `useAgentAccess(agentId, enabled)` hook (exported from `@/layers/entities/mesh`) to fetch agents reachable by the currently selected agent.

**Behavior by state:**

| State                                           | Visible agents                                     |
| ----------------------------------------------- | -------------------------------------------------- |
| No agent selected (`agentId` is null/undefined) | All registered agents, unfiltered                  |
| Agent selected, access query loading            | All registered agents (avoids flicker)             |
| Agent selected, access query resolved           | Only agents present in the access response         |
| Agent selected, access query error              | All registered agents (fail open, not fail closed) |
| Mesh disabled                                   | Section hidden (unchanged)                         |

The filtered list is then sliced by the cap.

`visibleAgents` is derived in a `useMemo` with dependencies `[agents, agentId, accessData]`.

### Agents Cap

Constant `AGENT_CAP = 3`. The filtered list is sliced to `agents.slice(0, AGENT_CAP)`. If the filtered list exceeds 3, a `+ N more reachable →` inline button appears below the list and calls `setMeshOpen(true)`. The existing `Open Mesh →` footer link is retained regardless.

### MCP Servers Cap

Constant `MCP_CAP = 4`. `mcpServers` is sliced to `mcpServers.slice(0, MCP_CAP)`. If the full list exceeds 4, a `+ N more servers →` inline button appears below the MCP items and calls `setAgentDialogOpen(true)`. The existing `Edit capabilities →` footer link is retained regardless.

### Overflow Link Text

- Agents: `+ {N} more {N === 1 ? 'agent' : 'agents'} reachable →`
- MCP servers: `+ {N} more {N === 1 ? 'server' : 'servers'} →`

### Overflow Link Styling

Overflow links match the exact styling of the existing footer links: `text-xs text-muted-foreground hover:text-foreground transition-colors` — consistent with `Open Mesh →`, `Open Relay →`, and `Edit capabilities →`.

## Implementation

### File

`apps/client/src/layers/features/session-list/ui/ConnectionsView.tsx`

### Changes

1. Import `useAgentAccess` from `@/layers/entities/mesh`
2. Add call: `const { data: accessData } = useAgentAccess(agentId ?? '', meshEnabled && !!agentId)`
3. Derive `visibleAgents` via `useMemo`: filter `agents` by `accessData?.agents` when `agentId` is set and access data has loaded; otherwise use `agents` as-is
4. Add constants `AGENT_CAP = 3` and `MCP_CAP = 4`
5. Slice `visibleAgents` and `mcpServers` by their caps in the render
6. Render overflow buttons conditionally when the original list exceeds the cap

### No New Files

All changes are contained within `ConnectionsView.tsx`. No new hooks, no new API routes, no schema changes.

## Testing

Add new cases to the existing `ConnectionsView.test.tsx`. Assert:

- With no `agentId`: all agents render (up to cap 3), no overflow link when ≤ 3
- With no `agentId` and > 3 agents: first 3 render, overflow link shows correct count
- With `agentId` set and access query resolved: only reachable agents render (up to cap 3)
- With `agentId` set and access query loading: all agents render (up to cap 3) during load
- With `agentId` set and access query errored: all agents render (fail open)
- MCP cap: ≤ 4 servers — no overflow link; > 4 — overflow link shows correct count
