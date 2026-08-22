---
id: 260822-083228
title: One header row per page, with the fixed cluster owned by the shell
status: accepted
created: 2026-08-22
spec: one-bar-header
superseded-by: null
amends: null
---

# 260822-083228. One header row per page, with the fixed cluster owned by the shell

## Status

Accepted — shipped across PRs #1161, #1167, #1169, #1170, #1173, #1177 (DOR-1399).

## Context

The cockpit had four header grammars: a shared one-row bar on most pages, a bespoke breadcrumb on sessions, a stacked second identity row on channels, and a triple stack on Home; tabs came in three visual styles. Options considered were a pure single bar (Slack), a bar-plus-tab-rail (Linear/GitHub), and per-page targeted fixes.

## Decision

Every page gets exactly one 36px header row (the "One Bar"), composed as `identity · chips · fill · actions` by the page, with the fixed cluster — search, inbox bell, right-panel toggle — mounted by **AppShell** as a sibling *after* the route cross-fade (`BarFixedCluster`). A route bar's entire subtree is confined to the preceding sibling, so nothing can render past the cluster (invariant I1) and the cluster never re-mounts or flickers on navigation. All in-bar tabs use one component (`BarTabStrip`: links styled as tabs, scroll with edge fades on overflow). Truncation yields in a fixed order: topic first, chips compress to icons, tabs scroll, identity last. Pages that repeated their name as an in-page H1 keep only an `sr-only` h1 for the heading outline.

## Consequences

- Second and third header rows (RoomHeader, HomeTabBar's row, the Team pill/select switcher) were deleted; the name of a page appears visibly once.
- The cluster's position is a structural fact of the DOM, pinned by tests at both levels — future bars cannot violate I1 by construction, but any new shell layout must preserve the sibling ordering.
- State controls that appear mid-run (working chip, Stop) reserve their space while idle (`opacity-0` + `inert`) so activation never shifts layout (I3).
- Container queries, not viewport breakpoints, decide in-bar compression: bar width changes with the sidebar, not just the window.
