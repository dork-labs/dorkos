---
number: 95
title: Use layoutId Shared Element for Sidebar Active Session Indicator
status: archived
created: 2026-03-09
spec: chat-microinteractions-polish
superseded-by: null
---

# 95. Use layoutId Shared Element for Sidebar Active Session Indicator

## Status

Draft (auto-extracted from spec: chat-microinteractions-polish)

## Context

The DorkOS sidebar displays a list of sessions. The active session is indicated by a `bg-secondary` CSS class on the active row. When the user switches sessions, each `SessionItem` independently toggles its background class — N items independently transitioning. This produces no cross-item motion and lacks the physical continuity that premium list interfaces provide.

Alternative evaluated: keep CSS `transition-colors duration-150` on each item's background class. Simpler but produces independent per-item fades with no cross-item relationship.

## Decision

Use a single absolutely-positioned `motion.div` with `layoutId="active-session-bg"` that renders only on the active `SessionItem`. Motion.dev's FLIP-based layout animation automatically slides this single DOM element between positions as the active session changes, driven by spring physics (`stiffness: 280, damping: 32`).

This matches the pattern used by Linear, Notion, and Vercel for list selection indicators — a hallmark of premium interface design.

## Consequences

### Positive

- Single animated element instead of N background toggles — simpler visual behavior
- Spring-powered motion creates physical continuity between old and new active rows
- Crosses session time-group boundaries correctly since all groups share the same scrollable container
- Zero additional network or state cost

### Negative

- Requires `position: relative` on each `SessionItem` wrapper and `z-index` layering (content above the sliding bg)
- `SidebarContent` (Shadcn component) needs a `layout` prop; if it does not forward non-standard props, a workaround is required
- If the session list scrolls while switching, FLIP calculations may produce unexpected paths — needs manual verification
