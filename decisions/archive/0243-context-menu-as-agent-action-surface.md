---
number: 243
title: Context Menu as Unified Agent Action Surface
status: draft
created: 2026-04-11
spec: agent-sidebar-redesign
superseded-by: null
---

# 243. Context Menu as Unified Agent Action Surface

## Status

Draft (auto-extracted from spec: agent-sidebar-redesign)

## Context

Agent management actions (edit settings, view all sessions, manage connections) were scattered across the UI: the pencil icon was hidden in the Session Sidebar's tab row, the "Sessions" drill-down was gated behind agents having >3 sessions, and there was no way to pin/favorite agents. The Session Sidebar — which contains Overview, Sessions, Schedules, and Connections tabs — was completely unreachable for agents with fewer than 4 sessions. Users had to discover multiple entry points for related actions.

## Decision

Add a Radix ContextMenu on each agent row in the dashboard sidebar as the single, unified entry point for all agent actions: Pin/Unpin, Manage agent (opens Session Sidebar), Edit settings (opens agent dialog), and New session. On desktop, the menu is triggered by right-click. On mobile, it uses long-press (native Radix behavior) plus an always-visible `...` action button using the existing `SidebarMenuAction` pattern. This consolidates discoverability into one interaction pattern and eliminates the session-count gate for Session Sidebar access.

## Consequences

### Positive

- All agent actions discoverable from a single right-click / long-press
- Session Sidebar accessible for all agents regardless of session count
- Agent settings dialog reachable without navigating away from dashboard
- Mobile users have a visible `...` button (not reliant on discovering long-press)
- Pattern extends naturally if new agent actions are added in future

### Negative

- Right-click is not discoverable without prior knowledge (mitigated by `...` button on mobile and by convention among developer tools)
- Context menu is a power-user pattern; very new users may not discover it immediately
