---
number: 197
title: UiActionDispatcher as Plain Function Outside React Component Tree
status: draft
created: 2026-03-26
spec: ext-platform-01-agent-ui-control
superseded-by: null
---

# 0197. UiActionDispatcher as Plain Function Outside React Component Tree

## Status

Draft (auto-extracted from spec: ext-platform-01-agent-ui-control)

## Context

UI action dispatch logic was scattered across `use-palette-actions.ts` (React hook coupled to command palette), individual `useAppStore` setters, and `router.navigate()`. No unified dispatch interface existed. The new dispatcher must be callable from the SSE stream event handler, which operates outside the React component tree (it runs in a callback, not a component).

## Decision

Implement `executeUiCommand()` as a plain function (not a React hook) in `layers/shared/lib/ui-action-dispatcher.ts`. It takes a `DispatcherContext` object (Zustand store reference, theme setter, optional callbacks) and a `UiCommand`, then executes it. The command palette, keyboard shortcuts, and stream event handler all call this same function.

## Consequences

### Positive

- Callable from any context: React components, SSE event handlers, keyboard shortcut handlers
- Single source of truth for UI action execution — no duplicated dispatch logic
- Pure side-effect function with exhaustive switch — TypeScript catches missing action handlers at compile time
- Testable in isolation (unit tests with mock store, no React rendering needed)

### Negative

- Requires a `DispatcherContext` object to be constructed by callers — slightly more ceremony than direct `useAppStore` calls
- Cannot use React hooks internally (e.g., can't use `useNavigate`) — must receive all capabilities via context
- Refactoring the command palette to delegate is a medium-risk change (existing tests must pass unchanged)
