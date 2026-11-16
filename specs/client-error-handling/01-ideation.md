---
slug: client-error-handling
number: 191
created: 2026-03-28
status: ideation
---

# Client Error Handling Improvements

**Slug:** client-error-handling
**Author:** Claude Code
**Date:** 2026-03-28
**Branch:** preflight/client-error-handling

---

## 1) Intent & Assumptions

- **Task brief:** The DorkOS client app has no error handling infrastructure. When something throws, users see either TanStack Router's ugly default error component (red box with raw stack trace), a completely white screen, or a bare unstyled `<div>404 — Page not found</div>`. We need to add proper, on-brand error handling at every layer, plus showcase the new components in the Dev Playground.
- **Assumptions:**
  - Error pages follow the Calm Tech design language — calm informational panels, not consumer app failure screens
  - No "Oops!", no emoji, no whimsical illustrations, no full-page red, no auto-redirect timers, no apologetic copy
  - Recovery actions are tiered: route-level errors get "Go to Dashboard" + "Retry", top-level crash gets "Reload DorkOS"
  - Stack traces are dev-only (behind collapsible `<details>`)
  - Existing inline chat error handling (TransportErrorBanner, ErrorPart) is untouched — this work covers the structural layers above that
  - `react-error-boundary` library is acceptable (provides `resetKeys`, hooks API, works with React 19)
- **Out of scope:**
  - Server-side error handling / API error response format changes
  - Chat-specific error states (ErrorPart, TransportErrorBanner — already handled per research/20260316\_\*.md)
  - Error telemetry/observability pipeline (Sentry, PostHog) — the `onCaughtError`/`onUncaughtError` hooks provide the extension point but wiring to a specific provider is separate work
  - Obsidian plugin (`App.tsx`) error boundaries — follow-up after standalone app is done

---

## 2) Pre-reading Log

- `apps/client/src/main.tsx`: No top-level ErrorBoundary. Root renders QueryClientProvider → TransportProvider → EventStreamProvider → ExtensionProvider → PasscodeGateWrapper → RouterProvider. No `onCaughtError`/`onUncaughtError` on `createRoot()`.
- `apps/client/src/router.tsx`: Root route has `notFoundComponent: () => <div>404 — Page not found</div>` (unstyled). No `errorComponent` or `defaultErrorComponent` on router or any route. Three routes: `/` (dashboard), `/session` (chat), `/agents` (fleet).
- `apps/client/src/AppShell.tsx`: Standalone app shell — sidebar, header, and `<Outlet />`. No error boundary wrapping the Outlet.
- `apps/client/src/layers/shared/lib/query-client.ts`: QueryClient with `staleTime` and `retry` only. No `QueryCache.onError`, no `MutationCache.onError`, no global error handling.
- `apps/client/src/dev/playground-config.ts`: Single source of truth for Dev Playground pages — `PAGE_CONFIGS[]` array. 10 pages currently. Adding a page requires: entry in `PAGE_CONFIGS`, sections in registry, page component, showcase file, and `PAGE_COMPONENTS` map entry.
- `apps/client/src/dev/DevPlayground.tsx`: Creates own QueryClient and transport, uses RouterProvider with memory history. `PAGE_COMPONENTS` map drives lazy page rendering.
- `apps/client/src/dev/playground-registry.ts`: Section definitions per page. Each section has `id`, `title`, `description`.
- `apps/client/src/layers/features/chat/ui/__tests__/TransportErrorBanner.test.tsx`: Existing inline error banner with AlertTriangle icon, heading, message, conditional retry button. Uses `destructive/5` bg and `destructive/30` border.
- `research/20260316_sdk_result_error_ux_patterns.md`: SDK emits four error subtypes. `ErrorPartSchema` and `ErrorCategorySchema` already in shared schemas. Client has inline error display in conversation.
- `research/20260316_error_categorization_retry.md`: Confirms `ErrorPart` is wired into `MessagePartSchema`. Chat-level errors are handled. Structural (app-level) errors are not.
- `contributing/design-system.md`: Calm Tech design language. Destructive palette defined. No error page patterns documented.

---

## 3) Codebase Map

**Primary Components/Modules:**

| File                                                | Role                                                  |
| --------------------------------------------------- | ----------------------------------------------------- |
| `apps/client/src/main.tsx`                          | App entry point, provider tree, `createRoot()`        |
| `apps/client/src/router.tsx`                        | TanStack Router config, route tree, notFoundComponent |
| `apps/client/src/AppShell.tsx`                      | Standalone layout shell (sidebar + header + Outlet)   |
| `apps/client/src/layers/shared/lib/query-client.ts` | QueryClient singleton                                 |
| `apps/client/src/dev/playground-config.ts`          | Dev Playground page registry                          |
| `apps/client/src/dev/playground-registry.ts`        | Dev Playground section definitions                    |
| `apps/client/src/dev/DevPlayground.tsx`             | Dev Playground entry component                        |

**Shared Dependencies:**

- Shadcn UI primitives: `Button`, `Alert`, `AlertDialog` in `layers/shared/ui/`
- Lucide icons: `AlertTriangle`, `Search`, `RefreshCw`, `Home`
- Sonner toast: `toast.error()` pattern used across mutation `onError` callbacks
- `cn()` utility for class merging
- Destructive palette: `border-destructive/30`, `bg-destructive/5`, `text-destructive`

**Data Flow:**

```
Error thrown in component tree
  → React propagates to nearest ErrorBoundary
    → TanStack Router errorComponent (route-level) ← DOES NOT EXIST
      → Top-level ErrorBoundary (app-level) ← DOES NOT EXIST
        → React default error (white screen) ← CURRENT BEHAVIOR
```

**Feature Flags/Config:** None relevant.

**Potential Blast Radius:**

| Category  | Files                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| New files | ~6 (error boundary component, route error component, not-found component, crash fallback, dev playground page + showcase) |
| Modified  | 3 (main.tsx, router.tsx, query-client.ts)                                                                                 |
| Dev-only  | 3 (playground-config.ts, playground-registry.ts, DevPlayground.tsx)                                                       |
| Tests     | ~3 new test files                                                                                                         |

---

## 4) Root Cause Analysis

N/A — this is a feature gap, not a bug.

---

## 5) Research

### Level 1: React 19 createRoot Error Hooks (Telemetry)

Wire `onCaughtError` and `onUncaughtError` in `main.tsx` as options to `createRoot()`. These are telemetry-only hooks — they fire at the end of React's error propagation and render no UI. React 19 change: error logs are no longer duplicated across sibling components.

- **Pros:** Centralized, correct semantics, zero render impact, provides future extension point for Sentry/PostHog
- **Cons:** React 19 only (confirmed for DorkOS — not a concern)

### Level 2: Top-Level Error Boundary (Catastrophic Crash)

Wrap `<RouterProvider>` in `<ErrorBoundary>` with a bare-bones `AppCrashFallback`. **Critical constraint:** The crash fallback must have **zero imports from the app bundle** — no shadcn, no Tailwind context, no router. If context providers crashed, any dependency on them will also crash. Use inline styles only.

`react-error-boundary` library is the right choice over native class components — provides `resetKeys`, `useErrorBoundary()` hook, and `onReset` callback. No React 19 compatibility issues.

- **Pros:** Catches provider-level crashes, zero-dependency fallback, maximum reliability
- **Cons:** Should trigger extremely rarely; if frequent, deeper bug exists

### Level 3: TanStack Router Route-Level Error Components

Set `defaultErrorComponent` and `defaultNotFoundComponent` on `createRouter()`. These render **inside the app shell** (sidebar stays visible), providing the primary user-visible error recovery surface.

**Critical gotcha:** Use `router.invalidate()` (not `reset()`) in error components when errors come from loaders. `reset()` alone does not re-run the loader — it immediately re-triggers the boundary. (GitHub TanStack/router#2539.)

Auto-reset on navigation: TanStack Router uses `router.state.loadedAt` as a reset key — the error boundary clears automatically on new navigation.

- **Pros:** Handles most runtime errors, layout-preserving, auto-clears on navigation
- **Cons:** `router.invalidate()` re-runs all active loaders (acceptable for error recovery)

### Level 4: TanStack Query Global Error Handling

Two independent mechanisms:

1. **`QueryCache.onError` / `MutationCache.onError`** — always fires, for telemetry + optional toast. Use `query.meta` to control toast behavior per-query.
2. **`throwOnError` + `QueryErrorResetBoundary`** — for critical page data that should trigger the route error boundary rather than showing inline error state.

Decision guide: background/polling queries → never throw; critical page content → throw with `QueryErrorResetBoundary`; optional widget data → handle `isError` in component; mutations → global `MutationCache.onError` toast.

- **Pros:** Separates telemetry (always-on) from UX (opt-in per query)
- **Cons:** `QueryErrorResetBoundary` is easy to forget without it retrying immediately re-throws

### Level 5: 404 / Not Found Pages

Two distinct scenarios: **structural 404** (URL matches no route, e.g. `/whaaat`) and **resource 404** (route matches but entity doesn't exist, e.g. `/session?session=nonexistent`).

- Root route `notFoundComponent: GlobalNotFound` — structural 404s with full app shell
- Route-level `notFoundComponent` + `throw notFound()` in loaders — resource 404s within the route's layout

Copy/tone: "Session not found" + specific context, not "Oops!" or "404 Error". Muted icon, outline button to navigate away.

### Dev Playground Showcase

Controlled throw component pattern with `resetKeys` to toggle error boundaries on/off. Show all variants side-by-side: `DefaultRouteError`, `GlobalNotFound`, `AppCrashFallback`, and reference to existing `TransportErrorBanner` + `ErrorMessageBlock`.

### Security Considerations

- Never display `error.stack` in production — reveals source paths. Use `error.message` only; stack behind dev-only `<details>`.
- Never log error details to external analytics if they may contain user content or credentials.
- `AppCrashFallback` must not call any API if the crash happened during an auth/API call.

### Performance Considerations

- ErrorBoundary has zero overhead when no error occurs — `getDerivedStateFromError` only activates on throw.
- Keep `QueryErrorResetBoundary` scope narrow (per page, not app-wide).
- `AppCrashFallback` must have zero app bundle imports to avoid cascading failures.

---

## 6) Decisions

| #   | Decision                  | Choice                                                                          | Rationale                                                                                                                                                                                 |
| --- | ------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Recovery action tiering   | Route errors → "Go to Dashboard" + "Retry"; Top-level crash → "Reload DorkOS"   | Route errors preserve the app shell so navigation works. Catastrophic crashes have no React tree left — only a full reload is safe. Matches Linear/Vercel Dashboard patterns.             |
| 2   | Error boundary library    | `react-error-boundary` (not native class component)                             | Provides `resetKeys` (auto-reset on route change), `useErrorBoundary()` hook (programmatic trigger from async handlers), and `onReset` callback. Active maintenance, React 19 compatible. |
| 3   | Crash fallback styling    | Inline styles only, zero app bundle imports                                     | If context providers crashed, any shadcn/Tailwind dependency in the fallback will also crash. Inline styles are the only guaranteed-safe approach for the outermost boundary.             |
| 4   | Router error retry method | `router.invalidate()` not `reset()`                                             | `reset()` alone does not re-run loaders — it immediately re-triggers the boundary on loader errors. `router.invalidate()` re-runs loaders AND resets the boundary. (TanStack/router#2539) |
| 5   | Stack trace visibility    | Dev-only behind collapsible `<details>`                                         | Production users see `error.message` only. Dev mode shows full stack in a collapsed section. Security best practice — no source paths in production.                                      |
| 6   | 404 strategy              | Two-tier: structural (GlobalNotFound) + resource (per-route notFoundComponent)  | Structural 404s render at root with app shell. Resource 404s render within the specific route's layout (e.g., session sidebar stays visible).                                             |
| 7   | Query error strategy      | Global `onError` for telemetry + toast; opt-in `throwOnError` for critical data | Background/polling queries should never crash the page. Critical page data (session content) should trigger the route error boundary for a designed recovery experience.                  |
| 8   | Design tone               | Calm informational panel — muted icons, technical copy, outline buttons         | No "Oops!", emoji, whimsical illustrations, or apologetic copy. DorkOS is mission control — errors are informational, not emotional.                                                      |

### Implementation Priority (Lowest Risk First)

1. `createRoot({ onCaughtError, onUncaughtError })` — telemetry wiring, no user-visible change
2. `defaultErrorComponent` + `defaultNotFoundComponent` on router — styled fallbacks, zero per-route config
3. Root route `notFoundComponent: GlobalNotFound` for structural 404s
4. `QueryCache.onError` + `MutationCache.onError` for global telemetry + toast
5. Top-level `ErrorBoundary` in `main.tsx` with `AppCrashFallback`
6. Dev Playground error components page

### Relevant Prior Research

- `research/20260316_sdk_result_error_ux_patterns.md` — SDK error subtypes, inline error display in conversation
- `research/20260316_error_categorization_retry.md` — ErrorPart/ErrorCategory schemas, chat-level error handling
- `research/20260328_react_error_handling_spa_best_practices.md` — React 19 error boundaries, TanStack Router/Query patterns (written by research agent)
