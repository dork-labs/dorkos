---
number: 211
title: Use react-error-boundary Over Native Class Components
status: accepted
created: 2026-03-28
spec: client-error-handling
superseded-by: null
---

# 211. Use react-error-boundary Over Native Class Components

## Status

Accepted

## Context

React error boundaries require class components with `getDerivedStateFromError` and `componentDidCatch`. In a React 19 codebase that uses exclusively function components, we need to decide between writing a native class component or using the `react-error-boundary` library.

## Decision

Use `react-error-boundary` for the top-level ErrorBoundary instead of a native React class component.

The library provides: `resetKeys` (auto-reset when a value changes, e.g., route pathname), `useErrorBoundary()` hook (trigger boundary programmatically from async event handlers), `FallbackProps` type, and `onReset` callback. These features would require significant boilerplate to implement natively.

## Consequences

### Positive

- `resetKeys` enables auto-reset on route changes without manual wiring
- `useErrorBoundary()` hook allows programmatic error throwing from async code
- Well-maintained, small bundle size, React 19 compatible
- Avoids introducing the only class component in the codebase

### Negative

- New external dependency (though small and stable)
- Another API surface to learn for contributors
