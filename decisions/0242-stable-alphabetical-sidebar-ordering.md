---
number: 242
title: Stable Alphabetical Ordering for Agent Sidebar
status: draft
created: 2026-04-11
spec: agent-sidebar-redesign
superseded-by: null
---

# 242. Stable Alphabetical Ordering for Agent Sidebar

## Status

Draft (auto-extracted from spec: agent-sidebar-redesign)

## Context

The dashboard sidebar's agent list was ordered by LRU (least recently used) — every time a user clicked an agent, `setSelectedCwd` prepended it to `recentCwds`, causing the entire visible list to reshuffle. This violated spatial memory principles: users could not build positional muscle memory because agent positions changed on every interaction. NN/Group research confirms that adaptive interfaces that restructure layouts break users' ability to navigate by position. The project also had a `MAX_AGENTS=8` cap, hiding 14+ agents from a 22-agent fleet.

## Decision

Replace LRU display ordering with stable alphabetical ordering by agent directory name. The `recentCwds` array continues to exist for internal tracking (CMD+K frecency, session restoration), but the sidebar display list is derived from `useMeshAgentPaths()` sorted alphabetically — completely decoupled from access recency. A separate "Pinned" section at the top allows users to promote important agents without affecting the alphabetical order of the main list. The `MAX_AGENTS` cap is removed; all discovered agents are shown in a scrollable list.

## Consequences

### Positive

- Users build spatial memory — agents are always in the same position
- All agents are visible — no hidden agents behind an arbitrary cap
- CMD+K frecency remains the power-user recency-based navigation tool
- Pinned section gives users explicit control over what they see first

### Negative

- Recently-used agents no longer surface automatically at the top of the sidebar (users must pin them or use CMD+K)
- Sort by path segment (not resolved display name) may produce slightly unexpected order when agents have custom names different from their directory
