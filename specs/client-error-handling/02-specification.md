---
slug: client-error-handling
number: 191
created: 2026-03-28
status: draft
authors: [Claude Code]
---

# Client Error Handling Improvements

## Status

Draft

## Overview

Add comprehensive, designed error handling to the DorkOS client at five structural levels — from React 19 telemetry hooks through TanStack Router/Query integration down to a catastrophic crash fallback — plus a Dev Playground showcase page. Replaces the current behavior where errors produce either TanStack Router's unstyled red error dump, a white screen, or a bare `<div>404 — Page not found</div>`.

## Background / Problem Statement

The DorkOS client has **zero error handling infrastructure**:

| Level                  | Current Behavior                     | Impact                                     |
| ---------------------- | ------------------------------------ | ------------------------------------------ |
| React error hooks      | Not wired                            | No telemetry on caught/uncaught errors     |
| TanStack Router errors | Default red stack trace dump         | Ugly, off-brand, exposes source paths      |
| 404 / Not Found        | `<div>404 — Page not found</div>`    | Unstyled, no navigation, no brand presence |
| TanStack Query errors  | Ad-hoc per-mutation `onError` toasts | No global telemetry, inconsistent UX       |
| Catastrophic crash     | White screen (production)            | Complete loss of UI, no recovery path      |

Every other surface in DorkOS follows the Calm Tech design language. Error states are the one place where the illusion breaks completely.

## Goals

- Ensure no user ever sees a white screen, raw stack trace, or unstyled error div
- Provide tiered recovery actions appropriate to each error severity
- Wire telemetry extension points for future observability (Sentry, PostHog)
- Maintain the Calm Tech aesthetic in all error states
- Showcase all error components in the Dev Playground for design iteration
- Zero regressions to existing chat-level error handling (TransportErrorBanner, ErrorPart)

## Non-Goals

- Server-side error handling or API error response format changes
- Chat-specific error states (ErrorPart, TransportErrorBanner — already handled)
- Wiring to a specific telemetry provider (Sentry, PostHog) — hooks provide the extension point only
- Obsidian plugin (`App.tsx`) error boundaries — follow-up work
- Per-route `notFoundComponent` implementations (structural 404 only; resource 404 pattern documented but deferred)
- Global `throwOnError` on QueryClient — remains opt-in per query

## Technical Dependencies

| Dependency               | Version  | Purpose                                                                                   |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------- |
| `react` / `react-dom`    | ^19.0.0  | `createRoot` error hooks (`onCaughtError`, `onUncaughtError`)                             |
| `react-error-boundary`   | latest   | **New dependency** — top-level ErrorBoundary with `resetKeys`, `FallbackProps`            |
| `@tanstack/react-router` | ^1.168.1 | `ErrorComponentProps`, `useRouter()`, `defaultErrorComponent`, `defaultNotFoundComponent` |
| `@tanstack/react-query`  | ^5.62.0  | `QueryCache`, `MutationCache` classes for global `onError`                                |
| `sonner`                 | ^2.0.7   | `toast.error()` for mutation error notifications                                          |
| `lucide-react`           | existing | `AlertTriangle`, `Search`, `RefreshCw`, `Home` icons                                      |

## Detailed Design

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  createRoot({ onCaughtError, onUncaughtError })         │  Level 1: Telemetry
│  ┌───────────────────────────────────────────────────┐  │
│  │  <ErrorBoundary fallback={AppCrashFallback}>      │  ��  Level 4: Catastrophic
│  │  ��────────────────────────���────────────────────┐  │  │
│  │  │  <QueryClientProvider>                      │  │  │
���  │  │  ┌───────────────────────────────────────┐  │  │  │
│  │  │  │  <RouterProvider>                     │  │  │  │
│  │  │  │  ┌─────────────────────────────────┐  │  │  │  │
│  │  │  │  │  AppShell (sidebar + header)    │  │  │  │  │
│  │  │  │  │  ┌───────────────────────────┐  │  │  │  │  │
│  │  │  │  │  │  <Outlet />               │  │  │  │  │  │
│  │  │  │  │  │  defaultErrorComponent    │  │  │  │  │  │  Level 2: Route errors
│  │  ��  │  │  │  defaultNotFoundComponent │  │  │  ��  │  │  Level 5: 404 pages
│  │  │  │  │  └───────────────────────────┘  │  │  │  │  │
│  │  │  │  └──────────────────────────────���──┘  │  │  │  │
│  │  │  └───────────────────────────────────────┘  │  │  │
│  │  │  QueryCache.onError / MutationCache.onError │  │  │  Level 3: Query errors
│  │  └───────────────────���───────────────────────────┘  │
│  └─────────────────────────────────────────────────────┘│
└────────────���─────────────────────────��──────────────────┘
```

### Level 1: React 19 createRoot Error Hooks

**File:** `apps/client/src/main.tsx`

Add `onCaughtError` and `onUncaughtError` options to `createRoot()`. These are telemetry-only hooks — they render no UI. They fire at the end of React's error propagation.

```typescript
ReactDOM.createRoot(document.getElementById('root')!, {
  onCaughtError: (error, errorInfo) => {
    // Fires when an ErrorBoundary catches — fallback UI is already showing
    console.error('[dorkos:caught]', error, errorInfo.componentStack);
  },
  onUncaughtError: (error, errorInfo) => {
    // Fires when no ErrorBoundary caught it — full app crash
    console.error('[dorkos:uncaught]', error, errorInfo.componentStack);
  },
}).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
```

**React 19 behavior note:** Unlike React 18, React 19 bails out after the first throw per boundary — no duplicated error logs across sibling components.

### Level 2: TanStack Router Default Error + NotFound Components

#### RouteErrorFallback

**File:** `apps/client/src/layers/shared/ui/route-error-fallback.tsx`

Renders inside the app shell (sidebar stays visible). Uses shadcn Button and Tailwind since the app shell context is intact.

```typescript
import { useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { Button } from './button';

/**
 * Default error fallback for route-level errors.
 *
 * Renders inside the app shell — sidebar and header remain visible.
 * Uses `router.invalidate()` for retry (not `reset()`) because `reset()`
 * does not re-run loaders. See TanStack/router#2539.
 */
export function RouteErrorFallback({ error }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <AlertTriangle className="text-muted-foreground size-10" />
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-foreground text-lg font-semibold">Something went wrong</h2>
        <p className="text-muted-foreground max-w-md text-sm">{error.message}</p>
      </div>

      {import.meta.env.DEV && error.stack && (
        <details className="border-border/50 max-w-2xl rounded-md border px-4 py-2">
          <summary className="text-muted-foreground cursor-pointer text-xs">
            Stack trace (dev only)
          </summary>
          <pre className="text-muted-foreground mt-2 overflow-x-auto text-xs whitespace-pre-wrap">
            {error.stack}
          </pre>
        </details>
      )}

      <div className="flex gap-3">
        <Button variant="outline" size="sm" onClick={() => router.invalidate()}>
          Retry
        </Button>
        <Button variant="ghost" size="sm" onClick={() => router.navigate({ to: '/' })}>
          Go to Dashboard
        </Button>
      </div>
    </div>
  );
}
```

#### NotFoundFallback

**File:** `apps/client/src/layers/shared/ui/not-found-fallback.tsx`

```typescript
import { Link } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { Button } from './button';

/** Default 404 fallback for routes that don't match. */
export function NotFoundFallback() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <Search className="text-muted-foreground size-10" />
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-foreground text-lg font-semibold">Page not found</h2>
        <p className="text-muted-foreground max-w-md text-sm">
          The page you're looking for doesn't exist.
        </p>
      </div>
      <Button variant="outline" size="sm" asChild>
        <Link to="/">Go to Dashboard</Link>
      </Button>
    </div>
  );
}
```

#### Router Integration

**File:** `apps/client/src/router.tsx`

```typescript
import { RouteErrorFallback } from '@/layers/shared/ui';
import { NotFoundFallback } from '@/layers/shared/ui';

// Update root route — replace bare <div>
const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  notFoundComponent: NotFoundFallback,
});

// Add defaults to createRouter
export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    defaultErrorComponent: RouteErrorFallback,
    defaultNotFoundComponent: NotFoundFallback,
  });
}
```

**Auto-reset behavior:** TanStack Router's internal `CatchBoundary` uses `router.state.loadedAt` as a reset key — the error boundary clears automatically when any new navigation completes.

### Level 3: TanStack Query Global Error Handling

**File:** `apps/client/src/layers/shared/lib/query-client.ts`

```typescript
import { QueryClient, QueryCache, MutationCache } from '@tanstack/react-query';
import { toast } from 'sonner';
import { QUERY_TIMING } from './constants';

/**
 * Application-wide QueryClient singleton.
 *
 * Error handling strategy:
 * - QueryCache.onError: Logs all query errors for telemetry. Shows toast only
 *   when the query opts in via `meta.showToastOnError`.
 * - MutationCache.onError: Shows a generic toast for all failed mutations.
 *   Individual mutations can override with their own `onError` callback.
 *
 * throwOnError is NOT set globally — it's opt-in per query:
 * - Background/polling queries: never throw (stale data > crashed page)
 * - Critical page content: use throwOnError + QueryErrorResetBoundary
 * - Optional widget data: handle isError inline in the component
 */
export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      console.error('[dorkos:query-error]', {
        queryKey: query.queryKey,
        error: error.message,
      });
      if (query.meta?.showToastOnError) {
        toast.error((query.meta.errorLabel as string) ?? 'Failed to load data');
      }
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      console.error('[dorkos:mutation-error]', { error: error.message });
      toast.error('Action failed. Please try again.');
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: QUERY_TIMING.DEFAULT_STALE_TIME_MS,
      retry: QUERY_TIMING.DEFAULT_RETRY,
    },
  },
});
```

**Interaction with existing mutation `onError` callbacks:** TanStack Query v5 calls `MutationCache.onError` first, then the mutation-level `onError`. Existing per-mutation handlers (e.g., in `ScheduleRow.tsx`, `RunHistoryPanel.tsx`) will continue to work. The global handler provides a safety net for mutations that don't define their own.

**Note:** Some existing mutations already show specific toast messages. The global handler will fire in addition. This is acceptable — if a mutation wants to suppress the global toast, it can set `meta.skipGlobalToast: true` and the handler can check for it. However, for the initial implementation, we accept the possibility of a duplicate toast in rare cases rather than adding complexity.

### Level 4: Top-Level Error Boundary

#### AppCrashFallback

**File:** `apps/client/src/layers/shared/ui/app-crash-fallback.tsx`

**Critical constraint:** This file has ZERO imports from the app bundle — no shadcn, no Tailwind, no router, no context. If context providers crashed, any dependency on them will also crash. Inline styles only.

```typescript
import type { FallbackProps } from 'react-error-boundary';

/**
 * Last-resort crash fallback for catastrophic errors.
 *
 * Uses inline styles only — no shadcn, no Tailwind, no app context.
 * If providers crashed, any dependency on them would also crash.
 * The only recovery action is a full page reload.
 */
export function AppCrashFallback({ error }: FallbackProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100dvh',
        padding: '2rem',
        backgroundColor: '#09090b',
        color: '#d4d4d8',
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      }}
    >
      <p style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem' }}>
        DorkOS encountered an unexpected error.
      </p>
      <p style={{ fontSize: '0.75rem', opacity: 0.6, maxWidth: '32rem', textAlign: 'center' }}>
        {error.message}
      </p>

      {import.meta.env.DEV && error.stack && (
        <details
          style={{
            marginTop: '1rem',
            maxWidth: '48rem',
            width: '100%',
            border: '1px solid #27272a',
            borderRadius: '0.375rem',
            padding: '0.5rem 1rem',
          }}
        >
          <summary
            style={{ fontSize: '0.75rem', cursor: 'pointer', opacity: 0.5 }}
          >
            Stack trace (dev only)
          </summary>
          <pre
            style={{
              fontSize: '0.625rem',
              opacity: 0.4,
              marginTop: '0.5rem',
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {error.stack}
          </pre>
        </details>
      )}

      <button
        onClick={() => window.location.reload()}
        style={{
          marginTop: '1.5rem',
          padding: '0.5rem 1rem',
          fontSize: '0.875rem',
          backgroundColor: 'transparent',
          color: '#d4d4d8',
          border: '1px solid #3f3f46',
          borderRadius: '0.375rem',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
        onMouseOver={(e) => {
          (e.target as HTMLButtonElement).style.backgroundColor = '#18181b';
        }}
        onMouseOut={(e) => {
          (e.target as HTMLButtonElement).style.backgroundColor = 'transparent';
        }}
      >
        Reload DorkOS
      </button>
    </div>
  );
}
```

#### Integration in main.tsx

```typescript
import { ErrorBoundary } from 'react-error-boundary';
import { AppCrashFallback } from '@/layers/shared/ui/app-crash-fallback';

// Wrap Root in ErrorBoundary
ReactDOM.createRoot(document.getElementById('root')!, {
  onCaughtError: (error, errorInfo) => {
    console.error('[dorkos:caught]', error, errorInfo.componentStack);
  },
  onUncaughtError: (error, errorInfo) => {
    console.error('[dorkos:uncaught]', error, errorInfo.componentStack);
  },
}).render(
  <React.StrictMode>
    <ErrorBoundary FallbackComponent={AppCrashFallback}>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>
);
```

### Level 5: 404 Pages (Two-Tier Strategy)

**Structural 404** (URL matches no route): Handled by `defaultNotFoundComponent: NotFoundFallback` on the router and `notFoundComponent: NotFoundFallback` on the root route (both from Level 2).

**Resource 404** (route matches but entity doesn't exist): Deferred. The pattern for future implementation:

```typescript
// Example: in a route loader
loader: async ({ search }) => {
  const session = await loadSession(search.session);
  if (!session) throw notFound(); // renders defaultNotFoundComponent
  return session;
};
```

For now, the `defaultNotFoundComponent` catches all `notFound()` throws. Per-route `notFoundComponent` overrides (e.g., a session-specific "Session not found" message) are future work.

### Dev Playground: Error States Page

#### Page Configuration

**File:** `apps/client/src/dev/playground-config.ts`

Add to `PAGE_CONFIGS[]`:

```typescript
{
  id: 'error-states',
  label: 'Error States',
  description: 'Error boundaries, 404 pages, crash fallbacks, and toast notifications.',
  icon: AlertTriangle,
  group: 'design-system',
  sections: ERROR_STATES_SECTIONS,
  path: 'error-states',
}
```

#### Section Registry

**File:** `apps/client/src/dev/sections/error-states-sections.ts`

```typescript
import type { PlaygroundSection } from '../playground-registry';

export const ERROR_STATES_SECTIONS: PlaygroundSection[] = [
  {
    id: 'route-error-fallback',
    title: 'Route Error Fallback',
    page: 'error-states',
    category: 'Error States',
    keywords: ['error', 'boundary', 'crash', 'route', 'fallback', 'retry'],
  },
  {
    id: 'not-found-fallback',
    title: 'Not Found Fallback',
    page: 'error-states',
    category: 'Error States',
    keywords: ['404', 'not found', 'missing', 'page'],
  },
  {
    id: 'app-crash-fallback',
    title: 'App Crash Fallback',
    page: 'error-states',
    category: 'Error States',
    keywords: ['crash', 'fatal', 'reload', 'catastrophic', 'inline styles'],
  },
  {
    id: 'error-toasts',
    title: 'Error Toasts',
    page: 'error-states',
    category: 'Error States',
    keywords: ['toast', 'notification', 'mutation', 'query', 'sonner'],
  },
];
```

#### Showcase Components

**File:** `apps/client/src/dev/showcases/ErrorStateShowcases.tsx`

Uses the `PlaygroundSection` + `ShowcaseDemo` + `ShowcaseLabel` pattern established by other showcases.

Key showcase sections:

1. **Route Error Fallback** — Uses a controlled throw component with `ErrorBoundary` and `resetKeys` to toggle the error on/off:

   ```typescript
   function ErrorTrigger({ shouldThrow }: { shouldThrow: boolean }) {
     if (shouldThrow) throw new Error('Controlled showcase error');
     return <p className="text-muted-foreground text-sm">No error — component is healthy.</p>;
   }
   ```

   Toggle button flips `shouldThrow`, and `resetKeys={[shouldThrow]}` auto-resets the boundary.

2. **Not Found Fallback** — Static render of `NotFoundFallback` in a bordered container.

3. **App Crash Fallback** — Static render of `AppCrashFallback` in a bordered container, with a note explaining the inline-styles-only constraint.

4. **Error Toasts** — Buttons that trigger `toast.error()` calls with different configurations (basic, with description, with action).

5. **Cross-reference note** — Text pointing to the Chat page for `TransportErrorBanner` and `ErrorMessageBlock` demos.

#### Page Component

**File:** `apps/client/src/dev/pages/ErrorStatesPage.tsx`

Follows the same pattern as other page components (e.g., `FormsPage.tsx`), receiving `onNavigate` as a prop, rendering the `ErrorStateShowcases` component.

#### DevPlayground.tsx Integration

Add to imports and `PAGE_COMPONENTS` map:

```typescript
import ErrorStatesPage from './pages/ErrorStatesPage';

const PAGE_COMPONENTS: Record<string, React.ComponentType<PlaygroundPageProps>> = {
  // ... existing entries
  'error-states': ErrorStatesPage,
};
```

### File Organization Summary

```
apps/client/src/
├��─ main.tsx                                    # MODIFY: createRoot hooks + ErrorBoundary
├── router.tsx                                  # MODIFY: defaultErrorComponent, defaultNotFoundComponent
├── layers/shared/
│   ├── ui/
│   ��   ├── route-error-fallback.tsx           # NEW: Styled route error
│   │   ├── not-found-fallback.tsx             # NEW: Styled 404
│   │   ├── app-crash-fallback.tsx             # NEW: Inline-styles crash fallback
│   │   ├── index.ts                           # MODIFY: Export new components
│   │   └���─ __tests__/
│   │       ├── route-error-fallback.test.tsx   # NEW
│   │       ├── not-found-fallback.test.tsx     # NEW
│   │       └── app-crash-fallback.test.tsx     # NEW
│   └── lib/
│       └── query-client.ts                    # MODIFY: Add QueryCache/MutationCache
├── dev/
│   ├── DevPlayground.tsx                      # MODIFY: Add to PAGE_COMPONENTS
│   ├── playground-config.ts                   # MODIFY: Add PageConfig entry
│   ├── playground-registry.ts                 # MODIFY: Import + spread sections
│   ├── sections/
│   │   └── error-states-sections.ts           # NEW: Section definitions
│   ├── pages/
│   │   └── ErrorStatesPage.tsx                # NEW: Page component
│   └── showcases/
│       └── ErrorStateShowcases.tsx            # NEW: Showcase demos
└── package.json                               # MODIFY: Add react-error-boundary
```

### Barrel Export Updates

**File:** `apps/client/src/layers/shared/ui/index.ts`

Add:

```typescript
export { RouteErrorFallback } from './route-error-fallback';
export { NotFoundFallback } from './not-found-fallback';
export { AppCrashFallback } from './app-crash-fallback';
```

## User Experience

### Route Error (Most Common)

When a page component throws during render or a loader fails:

1. The app shell (sidebar, header) remains visible and functional
2. The `<Outlet />` area shows `RouteErrorFallback`:
   - Muted AlertTriangle icon (not red, not alarming)
   - "Something went wrong" heading
   - Error message in muted text
   - "Retry" button → calls `router.invalidate()` to re-run loaders and re-render
   - "Go to Dashboard" link → navigates to `/`
3. Navigating to any other route automatically clears the error
4. In dev mode: a collapsible stack trace is available

### 404 / Page Not Found

When a user navigates to a URL that doesn't match any route:

1. The app shell remains visible
2. The content area shows `NotFoundFallback`:
   - Search icon
   - "Page not found" heading
   - "Go to Dashboard" link

### Catastrophic Crash

When a provider (Transport, EventStream, etc.) or the router itself crashes:

1. The entire app is replaced by `AppCrashFallback`
2. Dark background, monospace text — matches the DorkOS aesthetic
3. Error message displayed
4. "Reload DorkOS" button → `window.location.reload()`
5. This should be extremely rare

### Query/Mutation Errors

- Failed queries: logged to console; toast shown only if the query opts in
- Failed mutations: global toast notification ("Action failed. Please try again.")
- Individual mutations can still override with their own error handling

## Testing Strategy

### RouteErrorFallback Tests

**File:** `apps/client/src/layers/shared/ui/__tests__/route-error-fallback.test.tsx`

```
- renders error message from error prop
- renders "Something went wrong" heading
- renders Retry button
- renders "Go to Dashboard" link
- calls router.invalidate() when Retry is clicked (mock useRouter)
- shows stack trace in dev mode (mock import.meta.env.DEV = true)
- hides stack trace in production mode (mock import.meta.env.DEV = false)
```

**Mocking:** Mock `useRouter` from `@tanstack/react-router` to spy on `invalidate()` calls. Provide error object via props matching `ErrorComponentProps`.

### NotFoundFallback Tests

**File:** `apps/client/src/layers/shared/ui/__tests__/not-found-fallback.test.tsx`

```
- renders "Page not found" heading
- renders "Go to Dashboard" link pointing to "/"
- renders Search icon
```

### AppCrashFallback Tests

**File:** `apps/client/src/layers/shared/ui/__tests__/app-crash-fallback.test.tsx`

```
- renders error message from error prop
- renders "Reload DorkOS" button
- calls window.location.reload() when button is clicked
- shows stack trace in dev mode
- hides stack trace in production mode
- renders with inline styles only (no className attributes on any element)
```

**Critical test:** Verify that `AppCrashFallback` uses zero `className` props — this validates the "no Tailwind dependency" constraint.

### Integration Tests (Manual)

- Start dev server, navigate to `/nonexistent-route` → `NotFoundFallback` renders inside app shell
- Temporarily add `throw new Error('test')` to a route component → `RouteErrorFallback` renders, Retry works
- Dev Playground `/dev/error-states` → all showcases render correctly

## Performance Considerations

- `ErrorBoundary` has zero overhead when no error occurs — `getDerivedStateFromError` only activates on throw
- `QueryCache.onError` / `MutationCache.onError` are lightweight callbacks — no overhead on successful queries
- `AppCrashFallback` has zero bundle dependencies beyond `react-error-boundary` types
- No new runtime code executes in the happy path

## Security Considerations

- **Stack traces hidden in production:** `error.stack` is only rendered when `import.meta.env.DEV === true`. Production users see `error.message` only. This prevents exposing source file paths and code structure.
- **No sensitive data in error telemetry:** Console logs use structured `[dorkos:*]` prefixes for easy filtering. Error messages may contain user content — future telemetry wiring should sanitize before sending externally.
- **AppCrashFallback safety:** Does not call any API or emit network requests. If the crash happened during an auth flow, no credentials are at risk.

## Documentation

- `contributing/design-system.md` — Add "Error States" section documenting the component hierarchy and design patterns
- Component TSDoc on all three fallback components
- Inline code comments in `query-client.ts` documenting the error handling decision guide

## Implementation Phases

### Phase 1: Core Error Components (3 new files)

1. Create `route-error-fallback.tsx` with `RouteErrorFallback`
2. Create `not-found-fallback.tsx` with `NotFoundFallback`
3. Create `app-crash-fallback.tsx` with `AppCrashFallback`
4. Export all three from `layers/shared/ui/index.ts`
5. Write tests for all three components

### Phase 2: Wire Into App (3 modified files)

1. `main.tsx`: Add `createRoot` error hooks + wrap `<Root />` in `<ErrorBoundary>`
2. `router.tsx`: Add `defaultErrorComponent`, `defaultNotFoundComponent`; update root route `notFoundComponent`
3. `query-client.ts`: Add `QueryCache({ onError })` and `MutationCache({ onError })`
4. `package.json`: Add `react-error-boundary` dependency

### Phase 3: Dev Playground (5 new + 3 modified files)

1. Create `sections/error-states-sections.ts`
2. Create `showcases/ErrorStateShowcases.tsx`
3. Create `pages/ErrorStatesPage.tsx`
4. Update `playground-config.ts`: Add PageConfig entry
5. Update `playground-registry.ts`: Import + spread sections, add to `Page` type
6. Update `DevPlayground.tsx`: Add to `PAGE_COMPONENTS` map

## Open Questions

None — all decisions resolved during ideation (see Section 6 of `specs/client-error-handling/01-ideation.md`).

## Related ADRs

- **ADR-0009**: Calm tech notification layers — establishes the toast/notification patterns that inform the mutation error toast approach
- **ADR-0143**: Use retry depth over circuit breaker for SDK errors — informs the retry strategy (relevant context, not directly constraining)
- **ADR-0154**: Adopt TanStack Router for client routing — establishes the routing layer we're adding error components to

## References

- [TanStack Router Error Handling](https://tanstack.com/router/latest/docs/framework/react/guide/not-found-errors)
- [TanStack Router #2539 — reset() does not retry loaders](https://github.com/TanStack/router/issues/2539)
- [react-error-boundary](https://github.com/bvaughn/react-error-boundary)
- [React 19 Error Boundary Changes](https://react.dev/blog/2024/12/05/react-19)
- [TanStack Query v5 QueryCache/MutationCache](https://tanstack.com/query/v5/docs/reference/QueryCache)
- `specs/client-error-handling/01-ideation.md` — Ideation document with full research and 8 resolved decisions
- `research/20260316_sdk_result_error_ux_patterns.md` — SDK error subtypes (adjacent work)
- `research/20260316_error_categorization_retry.md` — ErrorPart/ErrorCategory schemas (adjacent work)
