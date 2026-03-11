---
number: 107
title: Use CSS Hidden Toggle for Sidebar View Persistence
status: draft
created: 2026-03-10
spec: sidebar-tabbed-views
superseded-by: null
---

# 107. Use CSS Hidden Toggle for Sidebar View Persistence

## Status

Draft (auto-extracted from spec: sidebar-tabbed-views)

## Context

The sidebar is evolving from a single session list to a three-tab navigation (Sessions, Schedules, Connections). When users switch tabs, the previously active view must retain its full state — scroll position, expanded items, React component state, and TanStack Query cache. Destroying and recreating views on tab switch would cost Priya 15 minutes of mental reconstruction and frustrate Kai's rapid tab-check-return workflow.

Three approaches were evaluated: conditional rendering (`{activeTab === 'x' && <View />}`), Radix Tabs (`TabsContent` with `forceMount`), and CSS `hidden` class toggling.

## Decision

Use Tailwind's `hidden` class (`display: none`) to toggle view visibility. All three views are mounted simultaneously; the inactive views get `className={cn(activeTab !== 'sessions' && 'hidden')}`. No unmount/remount occurs on tab switch.

We chose this over Radix Tabs because Radix's `TabsContent` unmounts inactive content by default, and `forceMount` still requires manual visibility management. A custom tab row with proper ARIA attributes (`role="tablist"`, `role="tab"`, `role="tabpanel"`) provides the same accessibility guarantees with full control over persistence behavior.

## Consequences

### Positive

- Zero state loss on tab switch — scroll position, expanded items, and React state preserved automatically
- No re-fetch cost — TanStack Query caches remain warm
- Simple implementation — one `cn()` call per view, no wrapper components
- Standard pattern — `display: none` is well-understood and has zero layout cost for hidden elements
- Clear migration path to React 19.2's `<Activity>` component when available

### Negative

- Hidden views still re-render on React state changes (negligible for read-only summary components)
- All three views mount on initial sidebar render, adding ~3 lightweight components to the initial tree
- Effects in hidden views continue running (polling queries) — mitigated by feature flag gating that prevents API calls when features are disabled
