# Client Error Handling — Implementation Tasks

**Spec:** `specs/client-error-handling/02-specification.md`
**Generated:** 2026-03-28
**Mode:** Full (3 phases, 12 tasks)

---

## Phase 1: Core Error Components

Three new component files with co-located tests, plus barrel export update.

| ID  | Task                                           | Size   | Dependencies  | Parallel |
| --- | ---------------------------------------------- | ------ | ------------- | -------- |
| 1.1 | Create RouteErrorFallback component with tests | medium | —             | 1.2, 1.3 |
| 1.2 | Create NotFoundFallback component with tests   | small  | —             | 1.1, 1.3 |
| 1.3 | Create AppCrashFallback component with tests   | medium | —             | 1.1, 1.2 |
| 1.4 | Export error components from shared/ui barrel  | small  | 1.1, 1.2, 1.3 | —        |

**Parallel opportunity:** Tasks 1.1, 1.2, and 1.3 are fully independent and can execute concurrently. Task 1.4 is a quick barrel update that gates on all three.

### 1.1 — Create RouteErrorFallback component with tests

**New files:**

- `apps/client/src/layers/shared/ui/route-error-fallback.tsx`
- `apps/client/src/layers/shared/ui/__tests__/route-error-fallback.test.tsx`

Route-level error fallback rendering inside the app shell. Uses `router.invalidate()` for retry (not `reset()` — see TanStack/router#2539). Displays AlertTriangle icon, "Something went wrong" heading, error message, collapsible stack trace (dev only), Retry button, and Go to Dashboard button. Uses shadcn Button and Tailwind since the app shell context is intact.

7 test cases: renders error message, renders heading, renders Retry button, renders Go to Dashboard, calls `router.invalidate()` on Retry click, shows stack trace in dev mode, hides stack trace in production.

### 1.2 — Create NotFoundFallback component with tests

**New files:**

- `apps/client/src/layers/shared/ui/not-found-fallback.tsx`
- `apps/client/src/layers/shared/ui/__tests__/not-found-fallback.test.tsx`

Structural 404 fallback. Renders Search icon, "Page not found" heading, description, and Go to Dashboard link using TanStack Router's `Link` component with `Button asChild`.

4 test cases: renders heading, renders description, renders dashboard link pointing to "/", renders Search icon.

### 1.3 — Create AppCrashFallback component with tests

**New files:**

- `apps/client/src/layers/shared/ui/app-crash-fallback.tsx`
- `apps/client/src/layers/shared/ui/__tests__/app-crash-fallback.test.tsx`

Last-resort crash fallback. **Critical constraint: ZERO `className` props — inline styles only.** Only import is `type { FallbackProps }` (type-only, erased at compile). Dark background (#09090b), monospace font, "Reload DorkOS" button calling `window.location.reload()`.

6 test cases: renders error message, renders Reload button, calls `window.location.reload()`, shows stack trace in dev mode, hides stack trace in production, **renders with zero `className` attributes on any element** (validates the no-Tailwind constraint).

### 1.4 — Export error components from shared/ui barrel

**Modified file:** `apps/client/src/layers/shared/ui/index.ts`

Add three exports: `RouteErrorFallback`, `NotFoundFallback`, `AppCrashFallback`.

---

## Phase 2: Wire Into App

Three modified files plus one new dependency.

| ID  | Task                                                                | Size   | Dependencies  | Parallel |
| --- | ------------------------------------------------------------------- | ------ | ------------- | -------- |
| 2.1 | Add react-error-boundary dependency                                 | small  | —             | 2.3      |
| 2.2 | Wire createRoot hooks + ErrorBoundary in main.tsx                   | medium | 1.3, 1.4, 2.1 | —        |
| 2.3 | Wire defaultErrorComponent + defaultNotFoundComponent in router.tsx | medium | 1.1, 1.2, 1.4 | 2.1      |
| 2.4 | Add QueryCache/MutationCache error handlers to query-client.ts      | medium | 1.4           | —        |

**Parallel opportunity:** Tasks 2.1 and 2.3 can run concurrently. Task 2.2 depends on 2.1 (needs the package installed). Task 2.4 is independent of 2.1/2.2/2.3 but needs barrel exports (1.4).

### 2.1 — Add react-error-boundary dependency

**Command:** `pnpm --filter @dorkos/client add react-error-boundary`

Provides `ErrorBoundary` component for `main.tsx` and `FallbackProps` type for `AppCrashFallback`.

### 2.2 — Wire createRoot hooks + ErrorBoundary in main.tsx

**Modified file:** `apps/client/src/main.tsx`

Two changes:

1. Add `onCaughtError` and `onUncaughtError` options to `createRoot()` — telemetry-only hooks logging with `[dorkos:caught]` / `[dorkos:uncaught]` prefixes.
2. Wrap `<Root />` in `<ErrorBoundary FallbackComponent={AppCrashFallback}>` inside `<React.StrictMode>`.

Import `AppCrashFallback` directly from its file path (not the barrel) to minimize the critical error path dependencies.

### 2.3 — Wire defaultErrorComponent + defaultNotFoundComponent in router.tsx

**Modified file:** `apps/client/src/router.tsx`

Three changes:

1. Import `RouteErrorFallback` and `NotFoundFallback` from `@/layers/shared/ui`.
2. Replace root route's inline `notFoundComponent: () => <div>404 — Page not found</div>` with `notFoundComponent: NotFoundFallback`.
3. Add `defaultErrorComponent: RouteErrorFallback` and `defaultNotFoundComponent: NotFoundFallback` to `createRouter()`.

### 2.4 — Add QueryCache/MutationCache error handlers to query-client.ts

**Modified file:** `apps/client/src/layers/shared/lib/query-client.ts`

Replace the plain `QueryClient` construction with one that has `QueryCache({ onError })` and `MutationCache({ onError })`. Query errors log `[dorkos:query-error]` and optionally show toast via `meta.showToastOnError`. Mutation errors log `[dorkos:mutation-error]` and always show a generic toast via `sonner`.

---

## Phase 3: Dev Playground

Five new files and three modified files.

| ID  | Task                                                            | Size   | Dependencies  | Parallel |
| --- | --------------------------------------------------------------- | ------ | ------------- | -------- |
| 3.1 | Create error-states-sections.ts                                 | small  | —             | 3.2, 3.3 |
| 3.2 | Create ErrorStateShowcases.tsx                                  | large  | 1.1–1.4, 2.1  | 3.1, 3.3 |
| 3.3 | Create ErrorStatesPage.tsx                                      | small  | 3.1, 3.2      | 3.1, 3.2 |
| 3.4 | Wire into playground-config, playground-registry, DevPlayground | medium | 3.1, 3.2, 3.3 | —        |

**Parallel opportunity:** Tasks 3.1, 3.2, and 3.3 can be developed concurrently (3.3 is trivial once 3.1 and 3.2 exist). Task 3.4 is the wiring step that depends on all three.

### 3.1 — Create error-states-sections.ts

**New file:** `apps/client/src/dev/sections/error-states-sections.ts`

Four `PlaygroundSection` entries: route-error-fallback, not-found-fallback, app-crash-fallback, error-toasts. All with `page: 'error-states'` and `category: 'Error States'`.

### 3.2 — Create ErrorStateShowcases.tsx

**New file:** `apps/client/src/dev/showcases/ErrorStateShowcases.tsx`

Four showcase sections:

1. **Route Error Fallback** — Interactive toggle with `ErrorBoundary` + `resetKeys` for error/recovery cycle demo.
2. **Not Found Fallback** — Static render in bordered container.
3. **App Crash Fallback** — Static render with explanatory note about inline-styles-only constraint.
4. **Error Toasts** — Buttons triggering `toast.error()` with different configurations.

Includes cross-reference note pointing to Chat page for `TransportErrorBanner` and `ErrorMessageBlock`.

### 3.3 — Create ErrorStatesPage.tsx

**New file:** `apps/client/src/dev/pages/ErrorStatesPage.tsx`

Standard page component wrapping `ErrorStateShowcases` in `PlaygroundPageLayout`. Follows the exact pattern of `TopologyPage.tsx`.

### 3.4 — Wire into playground-config, playground-registry, DevPlayground

**Modified files:**

- `apps/client/src/dev/playground-registry.ts` — Add `'error-states'` to `Page` type, export and spread `ERROR_STATES_SECTIONS`.
- `apps/client/src/dev/playground-config.ts` — Add `AlertTriangle` import, `ERROR_STATES_SECTIONS` import, and `PageConfig` entry in `design-system` group.
- `apps/client/src/dev/DevPlayground.tsx` — Add `ErrorStatesPage` import and `PAGE_COMPONENTS` entry.

---

## Summary

| Metric                    | Count |
| ------------------------- | ----- |
| Total tasks               | 12    |
| Phase 1 (Core Components) | 4     |
| Phase 2 (Wire Into App)   | 4     |
| Phase 3 (Dev Playground)  | 4     |
| New files                 | 8     |
| Modified files            | 7     |
| Max parallel (Phase 1)    | 3     |
| Max parallel (Phase 2)    | 2     |
| Max parallel (Phase 3)    | 3     |
