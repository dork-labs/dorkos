---
number: 210
title: Five-Level Error Boundary Hierarchy for Client App
status: accepted
created: 2026-03-28
spec: client-error-handling
superseded-by: null
---

# 210. Five-Level Error Boundary Hierarchy for Client App

## Status

Accepted

## Context

The DorkOS client has zero error handling infrastructure. Errors produce either TanStack Router's default red stack trace dump, a white screen, or a bare unstyled `<div>404</div>`. Every other surface follows the Calm Tech design language — error states are the one place where the illusion breaks.

We need a layered approach because different error severities require different recovery strategies: a route component crash should show a retry button inside the existing layout, while a provider-level crash requires a full page reload.

## Decision

Implement a five-level error handling hierarchy with strict separation of concerns:

1. **React 19 createRoot hooks** (`onCaughtError`, `onUncaughtError`) — telemetry only, no UI
2. **TanStack Router defaults** (`defaultErrorComponent`, `defaultNotFoundComponent`) — styled fallbacks inside the app shell
3. **TanStack Query globals** (`QueryCache.onError`, `MutationCache.onError`) — console telemetry + optional toast
4. **Top-level ErrorBoundary** (`react-error-boundary` wrapping `<Root />`) — inline-styles-only crash fallback
5. **Two-tier 404 strategy** — structural (router default) + resource (deferred per-route `throw notFound()`)

Recovery actions are tiered: route errors get "Retry" + "Go to Dashboard"; catastrophic crashes get "Reload DorkOS".

## Consequences

### Positive

- No user ever sees a white screen, raw stack trace, or unstyled error div
- Error states match the Calm Tech design language
- Telemetry hooks provide extension points for future Sentry/PostHog wiring
- Route-level errors auto-clear on navigation (TanStack Router reset key)
- AppCrashFallback works even if Tailwind CSS fails to load (inline styles only)

### Negative

- `react-error-boundary` is a new dependency (small, well-maintained)
- `MutationCache.onError` may produce duplicate toasts with existing per-mutation handlers in rare cases
- `router.invalidate()` re-runs all active loaders when retrying (acceptable for error recovery, but worth noting)
- AppCrashFallback cannot use the design system — it must be styled with inline CSS to be reliable
