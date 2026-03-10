---
number: 105
title: Header as Agent Identity Surface
status: draft
created: 2026-03-10
spec: update-top-nav
superseded-by: null
---

# 105. Header as Agent Identity Surface

## Status

Draft (auto-extracted from spec: update-top-nav)

## Context

The DorkOS standalone header is a 36px bar that previously contained only a sidebar toggle button. When the sidebar is closed, users have zero visibility into which agent is active. The agent identity display lives exclusively in the sidebar's `AgentHeader` component, which is only visible when the sidebar is open. For Kai (primary persona) who runs 10-20 agent sessions across 5 projects, glanceable agent identity is essential for context switching.

## Decision

Move agent identity from the sidebar-only `AgentHeader` to the always-visible top navigation header via a new `features/top-nav/` FSD module. The header becomes the canonical location for agent identity (color dot + name + config access). The sidebar's `AgentHeader` simplifies to a directory context display (path breadcrumb + palette shortcut), eliminating redundant identity display. The header also gains a command palette trigger icon for mouse-accessible `Cmd+K` discoverability.

## Consequences

### Positive

- Agent identity is always visible regardless of sidebar state
- Eliminates redundancy between header and sidebar agent displays
- Command palette becomes discoverable via visible icon (not just keyboard shortcut)
- The header serves as a "control surface" with ambient streaming indicators
- Follows the industry pattern seen in Linear (workspace identity), Warp (session name), and GitHub Desktop (repository dropdown)

### Negative

- The sidebar `AgentHeader` tests need updating after simplification
- Agent identity is now split across two modules (`features/top-nav/` for header, `entities/agent/` for data hooks), adding one more feature module to the codebase
- `color-mix()` CSS function has ~96% browser support — very old browsers won't see the tinted border (graceful degradation to standard border)
