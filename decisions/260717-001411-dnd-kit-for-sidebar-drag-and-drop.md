---
id: 260717-001411
title: Adopt dnd-kit for sidebar drag-and-drop with a mandatory non-drag path for every operation
status: accepted
created: 2026-07-17
spec: agent-sidebar-organization
superseded-by: null
---

# 260717-001411. Adopt dnd-kit for sidebar drag-and-drop with a mandatory non-drag path for every operation

## Status

Accepted

## Context

Agent grouping needs drag-and-drop (drag agents between groups, into Pinned, reorder groups) and the repo has no drag-and-drop library anywhere. WCAG 2.2 §2.5.7 (Level AA, 2023) makes pointer-drag-only reordering a conformance failure — every drag operation needs a single-pointer and/or keyboard alternative. The 2026 React ecosystem consensus for accessible list dnd is `@dnd-kit` (~6KB core, maintained, `KeyboardSensor` implements the Space/arrows/Space/Esc protocol with ARIA live-region announcements); Atlassian's `pragmatic-drag-and-drop` is the headless alternative for teams building every layer themselves.

## Decision

We will adopt `@dnd-kit/core` + `@dnd-kit/sortable` in `apps/client` as the repo's drag-and-drop library, starting with the sidebar. `PointerSensor` uses an 8px activation distance so click/expand still wins; `KeyboardSensor` and per-operation ARIA announcements ship from day one. As a standing rule, every drag operation must also be reachable without dragging — in the sidebar, the row/header context menus ("Move to group", "Pin", sort controls) are that path, and they double as the mobile interaction (touch drag is disabled in the Sheet). Drop semantics live in a pure reducer (`use-sidebar-dnd.ts`) so they are unit-testable without synthetic pointer events.

## Consequences

### Positive

- Accessibility is built in, not bolted on — WCAG 2.2 §2.5.7 satisfied by construction
- One blessed library for future dnd needs (kanban boards, task reordering) instead of per-feature choices
- Reducer-level semantics keep dnd testable in jsdom

### Negative

- New client dependency (~10KB gzipped with sortable preset)
- The menu path must be maintained in feature parity with drag semantics — a drift risk mitigated by the unified menu-items component and its parity test
