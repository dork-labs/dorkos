---
slug: dashboard-home-route
number: 154
status: draft
created: 2026-03-20
---

# Dashboard Home Route & Navigation Restructure

**Status:** Draft
**Authors:** Claude Code, 2026-03-20
**Spec Number:** 154
**Branch:** preflight/dashboard-home-route
**Ideation:** `specs/dashboard-home-route/01-ideation.md`

---

## Overview

Introduce TanStack Router to the DorkOS client and restructure the app from a single-view SPA to a multi-view layout. The agent chat moves from `/` to `/session`, and a new placeholder dashboard appears at `/`. The nuqs dependency is removed entirely — search params (`?session=`, `?dir=`) are replaced with TanStack Router's built-in `validateSearch` + `Route.useSearch()`.

This is a **routing-first** change. The dashboard page is a minimal placeholder; full dashboard content is a follow-up spec.

## Background / Problem Statement

The DorkOS client currently has no router. The entire app renders `<ChatPanel>` at `/` with URL state managed by nuqs (`?session=`, `?dir=`). This works for a single-view app but blocks the product's evolution toward a multi-view "mission control" experience described in the litepaper (VL-03: Multi-Session Command Center).

Key problems with the current architecture:

1. **No route-based navigation** — Cannot add dashboard, settings, or other views without a router
2. **Two URL state systems** — nuqs handles search params, but there's no path-based routing. The dev playground uses raw `window.location.pathname`
3. **No browser history for views** — Back/forward only works for search param changes, not view navigation
4. **Ecosystem fragmentation** — Already using TanStack Query and Virtual, but URL state uses a separate library (nuqs)

## Goals

- Add TanStack Router with code-based route definitions
- Create route structure: `/` (dashboard), `/session` (chat), `/dev/*` (playground)
- Replace nuqs entirely with TanStack Router search params
- Maintain identical behavior for embedded (Obsidian) mode — no router
- Preserve all existing deep link patterns at the new `/session` route
- Enable browser back/forward between dashboard and session views

## Non-Goals

- Full dashboard content/design (follow-up spec)
- Server-side changes or new API endpoints
- New data endpoints for dashboard aggregation
- Mobile-specific dashboard layout
- File-based routing (using code-based routes for control)
- Integrating the dev playground into TanStack Router (stays as-is)
- Wing/Loop integration

## Technical Dependencies

| Package                           | Version                      | Purpose                                     |
| --------------------------------- | ---------------------------- | ------------------------------------------- |
| `@tanstack/react-router`          | `^1.x` (latest stable)       | Core router                                 |
| `@tanstack/react-router-devtools` | `^1.x`                       | Dev-only route inspector                    |
| `@tanstack/zod-adapter`           | `^1.x`                       | Zod schema integration for `validateSearch` |
| `zod`                             | `^4.3.6` (already installed) | Search param validation                     |

**Removed:** `nuqs` (`^2.8.8`)

**Not needed:** `@tanstack/react-router-with-query` (SSR-only, not applicable to Vite SPA), `@tanstack/router-vite-plugin` (file-based routing only, we use code-based).

## Detailed Design

### 1. Route Architecture

```
main.tsx
├── /dev/* → DevPlayground (before router, unchanged)
├── RouterProvider
│   └── rootRoute (minimal — just <Outlet>)
│       └── _shell (pathless layout — AppShell with sidebar/header)
│           ├── / → indexRoute (DashboardPage placeholder)
│           └── /session → sessionRoute (SessionPage wraps ChatPanel)
│
└── Embedded mode branch (no router, unchanged)
    └── App({ embedded: true }) → ChatPanel directly
```

### 2. Route Definitions (`apps/client/src/router.ts`)

New file at app level (not in FSD layers — routes are app-level orchestration).

```typescript
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { zodValidator } from '@tanstack/zod-adapter';

// ── Router context ──────────────────────────────────────────
interface RouterContext {
  queryClient: QueryClient;
}

// ── Root route (minimal — just Outlet) ──────────────────────
const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  notFoundComponent: () => <div>404 — Page not found</div>,
});

// ── Pathless layout route (app shell) ───────────────────────
// Uses `id` not `path` — no URL segment added.
// Sidebar, header, dialogs, toaster render here.
const appShellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_shell',
  component: AppShell,
});

// ── Search param schema ─────────────────────────────────────
const sessionSearchSchema = z.object({
  session: z.string().optional(),
  dir: z.string().optional(),
});

export type SessionSearch = z.infer<typeof sessionSearchSchema>;

// ── Dashboard at / ──────────────────────────────────────────
const indexRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/',
  component: DashboardPage,
});

// ── Session/chat at /session ────────────────────────────────
const sessionRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/session',
  validateSearch: zodValidator(sessionSearchSchema),
  component: SessionPage,
});

// ── Route tree ──────────────────────────────────────────────
const routeTree = rootRoute.addChildren([
  appShellRoute.addChildren([indexRoute, sessionRoute]),
]);

// ── Router factory ──────────────────────────────────────────
export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
  });
}

// ── Type registration ───────────────────────────────────────
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
```

**Key design decisions:**

- **`createRootRouteWithContext`** injects `QueryClient` into router context — enables route loaders to prefetch data (for future dashboard content)
- **Pathless layout route** (`id: '_shell'`) wraps the shared UI without adding a URL segment — both `/` and `/session` share the shell without path nesting
- **`z.string().optional()`** — `undefined` means "absent from URL"; TanStack Router omits the key entirely (clean URLs)
- **`notFoundComponent`** on root catches unrecognized routes
- **`defaultPreload: 'intent'`** fires loaders on hover/focus for instant navigation
- **Not installed:** `@tanstack/react-router-with-query` (SSR-only, confirmed in GitHub issue #4208), `@tanstack/router-vite-plugin` (file-based routing only)

### 3. Entry Point Changes (`apps/client/src/main.tsx`)

```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createAppRouter } from './router';
import { HttpTransport, QUERY_TIMING } from '@/layers/shared/lib';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import './index.css';

// Dev playground — lazy-loaded, tree-shaken from production
const DevPlayground = import.meta.env.DEV
  ? React.lazy(() => import('./dev/DevPlayground'))
  : null;

function DevtoolsToggle() {
  const open = useAppStore((s) => s.devtoolsOpen);
  if (!open) return null;
  const ReactQueryDevtools = React.lazy(() =>
    import('@tanstack/react-query-devtools').then(m => ({ default: m.ReactQueryDevtools }))
  );
  return (
    <React.Suspense fallback={null}>
      <ReactQueryDevtools initialIsOpen />
    </React.Suspense>
  );
}

function Root() {
  // Dev playground renders outside router (unchanged)
  if (window.location.pathname.startsWith('/dev') && DevPlayground) {
    return (
      <React.Suspense fallback={null}>
        <DevPlayground />
      </React.Suspense>
    );
  }

  // NuqsAdapter removed — replaced by RouterProvider
  const router = createAppRouter(queryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <RouterProvider router={router} />
      </TransportProvider>
      {import.meta.env.DEV && <DevtoolsToggle />}
    </QueryClientProvider>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: QUERY_TIMING.DEFAULT_STALE_TIME_MS,
      retry: QUERY_TIMING.DEFAULT_RETRY,
    },
  },
});

const transport = new HttpTransport('/api');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
```

### 4. App Shell Extraction (`apps/client/src/AppShell.tsx`)

Extract the standalone mode shell from `App.tsx` into a new `AppShell` component that uses `<Outlet>` instead of hardcoded `<ChatPanel>`:

```typescript
import { Outlet } from '@tanstack/react-router';
// ... existing imports from App.tsx (minus ChatPanel)

/**
 * Standalone app shell — shared layout for all routed views.
 * Renders sidebar, header, dialogs, and an Outlet for route content.
 */
export function AppShell() {
  // ... existing standalone mode logic from App.tsx
  // (sidebar, header, onboarding, favicon, document title, etc.)

  return (
    <TooltipProvider>
      <MotionConfig reducedMotion="user">
        {/* ... onboarding gate, same as current */}
        <SidebarProvider ...>
          <Sidebar variant="floating">
            <AgentSidebar />
          </Sidebar>
          <SidebarInset>
            <header>
              {/* ... same header as current */}
            </header>
            <main className="flex-1 overflow-hidden">
              <Outlet />  {/* ← Was: <ChatPanel sessionId={activeSessionId} ... /> */}
            </main>
          </SidebarInset>
        </SidebarProvider>
        <DialogHost />
        <CommandPaletteDialog />
        <ShortcutsPanel />
        <Toaster />
      </MotionConfig>
    </TooltipProvider>
  );
}
```

**`App.tsx` retains** the embedded mode branch only — it becomes the entry point for `DirectTransport` (Obsidian) where no router is used. The standalone mode code moves to `AppShell.tsx`.

### 5. nuqs Hook Replacements

#### 5.1 `useSessionId` → TanStack Router search params

**File:** `apps/client/src/layers/entities/session/model/use-session-id.ts`

The hook maintains its existing public API: `[string | null, (id: string | null) => void]`. Internal implementation changes from nuqs to TanStack Router.

```typescript
import { useNavigate } from '@tanstack/react-router';
import { getPlatform } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { useSessionSearch } from './use-session-search';

/**
 * Dual-mode session ID hook.
 *
 * - **Standalone (web):** reads `?session=` from TanStack Router search params.
 *   Setter navigates to `/session?session=<id>` with history push.
 * - **Embedded (Obsidian):** reads/writes Zustand store directly.
 */
export function useSessionId(): [string | null, (id: string | null) => void] {
  const platform = getPlatform();

  // Embedded: Zustand store (always subscribed for rules of hooks)
  const storeId = useAppStore((s) => s.sessionId);
  const setStoreId = useAppStore((s) => s.setSessionId);

  // Standalone: TanStack Router search params
  const search = useSessionSearch();
  const navigate = useNavigate();

  if (platform.isEmbedded) {
    return [storeId, setStoreId];
  }

  const setSessionId = (id: string | null) => {
    navigate({
      to: '/session',
      search: (prev) => ({
        ...prev,
        session: id ?? undefined,
      }),
    });
  };

  return [search.session ?? null, setSessionId];
}
```

**Design note:** The setter navigates to `/session` because viewing a session implies being on the session route. If the user is on the dashboard and clicks a session, they navigate to `/session?session=abc`.

#### 5.2 `useDirectoryState` → TanStack Router search params

**File:** `apps/client/src/layers/entities/session/model/use-directory-state.ts`

Same dual-mode pattern. Preserves the URL→Zustand sync, `preserveSession` option, and fallback behavior.

```typescript
import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { getPlatform } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { useSessionSearch } from './use-session-search';
import { useSessionId } from './use-session-id';

export interface SetDirOptions {
  preserveSession?: boolean;
}

/**
 * Dual-mode working-directory hook.
 *
 * - **Standalone (web):** `?dir=` from TanStack Router search params.
 * - **Embedded (Obsidian):** Zustand store.
 */
export function useDirectoryState(): [
  string | null,
  (dir: string | null, opts?: SetDirOptions) => void,
] {
  const platform = getPlatform();
  const storeDir = useAppStore((s) => s.selectedCwd);
  const setStoreDir = useAppStore((s) => s.setSelectedCwd);
  const search = useSessionSearch();
  const navigate = useNavigate();
  const [, setSessionId] = useSessionId();

  const urlDir = search.dir ?? null;

  // Sync URL → Zustand on initial load (standalone only)
  useEffect(() => {
    if (!platform.isEmbedded && urlDir && urlDir !== storeDir) {
      setStoreDir(urlDir);
    }
  }, [urlDir]); // eslint-disable-line react-hooks/exhaustive-deps

  if (platform.isEmbedded) {
    return [
      storeDir,
      (dir, opts) => {
        if (dir) {
          setStoreDir(dir);
          if (!opts?.preserveSession) setSessionId(null);
        }
      },
    ];
  }

  return [
    urlDir ?? storeDir,
    (dir, opts) => {
      if (dir) {
        navigate({
          search: (prev) => ({ ...prev, dir }),
        });
        setStoreDir(dir);
        if (!opts?.preserveSession) setSessionId(null);
      } else {
        navigate({
          search: (prev) => ({ ...prev, dir: undefined }),
        });
      }
    },
  ];
}
```

#### 5.3 Shared Search Helper (`use-session-search.ts`)

New file to safely read session route search params from any route:

```typescript
import { useSearch } from '@tanstack/react-router';
import type { SessionSearch } from '@/router';

/**
 * Read session search params safely from any route.
 * Returns empty object if not on the session route.
 */
export function useSessionSearch(): Partial<SessionSearch> {
  try {
    return useSearch({ from: '/session' });
  } catch {
    // Not on session route — return empty
    return {};
  }
}
```

**Alternative approach:** Use `useSearch({ strict: false })` from the root route if search params are defined there. This is a decision to make during implementation — the spec supports either approach. The `strict: false` approach avoids try/catch but requires search params on the root route.

### 6. New Page Components

#### 6.1 `DashboardPage` — Minimal Placeholder

**File:** `apps/client/src/layers/widgets/dashboard/ui/DashboardPage.tsx`

```typescript
/**
 * Dashboard placeholder — minimal status overview.
 * Full dashboard content is a follow-up spec.
 */
export function DashboardPage() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          DorkOS
        </h1>
        <p className="text-muted-foreground text-sm">
          Mission control for your agents
        </p>
      </div>
    </div>
  );
}
```

**FSD placement:** `layers/widgets/dashboard/` — widget layer, since it composes features and entities.

#### 6.2 `SessionPage` — Thin Wrapper

**File:** `apps/client/src/layers/widgets/session/ui/SessionPage.tsx`

```typescript
import { ChatPanel } from '@/layers/features/chat';
import { useSessionId } from '@/layers/entities/session';

/**
 * Session route page — wraps ChatPanel with route-derived session ID.
 * Identical behavior to the previous root view.
 */
export function SessionPage() {
  const [activeSessionId] = useSessionId();

  return (
    <ChatPanel
      sessionId={activeSessionId}
    />
  );
}
```

**Note:** `transformContent` prop from the old `App` was only used in embedded mode. `SessionPage` doesn't need it.

### 7. Navigation Wiring

#### 7.1 Sidebar Session Clicks

**File:** `apps/client/src/layers/features/session-list/ui/SessionItem.tsx`

Currently calls `setSessionId(id)` via nuqs. After migration, `useSessionId()`'s setter already navigates to `/session?session=id`, so **no changes needed in SessionItem** — the hook abstraction preserves the call site.

However, `AgentSidebar.tsx` needs navigation links for Dashboard and New Session:

```typescript
import { Link } from '@tanstack/react-router';

// In the sidebar header or tab area:
<Link to="/" className={cn(/* active styles */)}>
  Dashboard
</Link>
<Link to="/session" className={cn(/* active styles */)}>
  New Session
</Link>
```

#### 7.2 Command Palette

**File:** `apps/client/src/layers/features/command-palette/model/use-palette-actions.ts`

The `handleAgentSelect` function currently calls `setDir(agent.projectPath)`. Since `useDirectoryState()`'s setter now navigates internally, **no changes needed** if the palette is used from the session route.

For explicit navigation actions (e.g., "Go to Dashboard"), add:

```typescript
import { useNavigate } from '@tanstack/react-router';

const navigate = useNavigate();

// "Go to Dashboard" palette action
{ label: 'Dashboard', action: () => navigate({ to: '/' }) }
```

#### 7.3 Other Consumers

These files import `useSessionId` or `useDirectoryState` but only use the getter/setter API:

| File                     | Change Needed                                            |
| ------------------------ | -------------------------------------------------------- |
| `ChatPanel.tsx`          | None — hook API unchanged                                |
| `ChatInputContainer.tsx` | None — reads `selectedCwd`                               |
| `MeshPanel.tsx`          | None — calls `setDir()`                                  |
| `RunHistoryPanel.tsx`    | None — calls `setActiveSession()` and `setSelectedCwd()` |
| `TunnelDialog.tsx`       | None — reads `activeSessionId`                           |
| `DialogHost.tsx`         | None — reads/writes directory state                      |
| `useSessions.ts`         | None — reads `activeSessionId`                           |

**Zero consumer-level changes** needed beyond the hook internals, the sidebar nav links, and the command palette dashboard action.

### 8. `App.tsx` After Refactor

`App.tsx` shrinks to handle only the embedded mode branch:

```typescript
import { ChatPanel } from '@/layers/features/chat';
import { useSessionId } from '@/layers/entities/session';
// ... embedded-specific imports

interface AppProps {
  transformContent?: (content: string) => string | Promise<string>;
  embedded?: boolean;
}

/**
 * Root application component.
 *
 * - Embedded mode (Obsidian): Renders ChatPanel directly, no router.
 * - Standalone mode: Handled by AppShell via TanStack Router.
 */
export function App({ transformContent, embedded }: AppProps = {}) {
  if (!embedded) {
    // Standalone mode is now handled by RouterProvider → AppShell
    // This branch should not be reached in standalone mode.
    return null;
  }

  // ... existing embedded mode code (lines 114-186 of current App.tsx)
}
```

### 9. Dev Playground Integration

The dev playground currently renders **before** the router check in `main.tsx` (via `window.location.pathname.startsWith('/dev')`). This pattern is preserved — the dev playground exits the render tree before `RouterProvider` is reached.

**No changes to dev playground routing.** It continues using `window.location.pathname` and `history.pushState` internally. This is intentional: the dev playground is a development tool, not a user-facing route.

### 10. Vite SPA Fallback

Vite's dev server needs to serve `index.html` for all routes. Update `vite.config.ts` if not already configured:

```typescript
export default defineConfig({
  // ... existing config
  server: {
    // Already handled by Vite's default SPA behavior
  },
});
```

For production, the server's static file middleware (or CDN) must serve `index.html` for `/`, `/session`, and any other client routes. The Express server in `apps/server` likely needs a catch-all route for HTML5 history mode if it serves the client build.

## User Experience

### Navigation Flow

1. **User opens DorkOS** → Lands on `/` → Sees dashboard placeholder
2. **User clicks a session in sidebar** → Navigates to `/session?session=abc123` → Sees chat
3. **User presses browser Back** → Returns to `/` → Sees dashboard
4. **User opens a deep link** `/session?session=abc123&dir=/path` → Lands directly in chat with correct session
5. **User uses command palette** → "Go to Dashboard" → Navigates to `/`

### Embedded Mode (Obsidian)

Zero changes. Embedded mode never enters the router. The `App` component renders `<ChatPanel>` directly with Zustand state. Obsidian users see no difference.

## Testing Strategy

### Unit Tests — Hook Migration

**`use-session-id.test.ts`** — Verify dual-mode behavior:

- Standalone mode: reads `?session=` from router search, setter navigates to `/session?session=id`
- Embedded mode: reads/writes Zustand store
- Setting `null` removes the `session` param from URL

**`use-directory-state.test.ts`** — Verify dual-mode behavior:

- Standalone mode: reads `?dir=` from router, setter updates URL and syncs to Zustand
- `preserveSession: true` does not clear session
- Fallback to Zustand when `?dir=` is absent

**Mock approach:** Instead of mocking `nuqs`, tests mock TanStack Router's `useSearch` and `useNavigate`:

```typescript
import { createMemoryRouter } from '@tanstack/react-router';

// Create a test router with the session route
const testRouter = createMemoryRouter({
  routeTree,
  initialEntries: ['/session?session=test-123&dir=/my/project'],
});

function Wrapper({ children }) {
  return <RouterProvider router={testRouter}>{children}</RouterProvider>;
}
```

### Unit Tests — Consumer Components

All 11 existing test files that mock `useSessionId` or `useDirectoryState` at the hook level (e.g., `vi.mock('@/layers/entities/session/model/use-session-id')`) need **no changes** — they mock the hook itself, not nuqs.

The 1 test file that mocks nuqs directly (`use-directory-state.test.tsx`) needs updating to mock TanStack Router instead.

### Integration Tests — Route Navigation

New test file: `apps/client/src/__tests__/routing.test.tsx`

```typescript
describe('Route Navigation', () => {
  it('renders DashboardPage at /', async () => {
    // Create router with initial entry at '/'
    // Verify DashboardPage content renders
  });

  it('renders SessionPage at /session', async () => {
    // Create router with initial entry at '/session'
    // Verify ChatPanel renders
  });

  it('passes search params to SessionPage', async () => {
    // Create router at '/session?session=abc&dir=/path'
    // Verify useSessionId returns 'abc'
    // Verify useDirectoryState returns '/path'
  });

  it('navigates from dashboard to session on sidebar click', async () => {
    // Start at '/', click session in sidebar
    // Verify URL changes to '/session?session=...'
  });

  it('supports browser back/forward', async () => {
    // Navigate / → /session → back
    // Verify URL returns to /
  });
});
```

### E2E Tests

Update `apps/e2e/tests/chat/send-message.spec.ts` to navigate to `/session` instead of `/`:

```typescript
// Before:
await page.goto('/');

// After:
await page.goto('/session');
```

## Performance Considerations

- **Bundle size:** TanStack Router adds ~45KB (gzipped ~12KB). Offset partially by removing nuqs (~8KB). Net increase ~4KB gzipped — acceptable.
- **Route-level code splitting:** `DashboardPage` and `SessionPage` can be lazy-loaded via dynamic `import()` in route definitions. This means the chat code doesn't load until the user navigates to `/session` (or vice versa for the dashboard).
- **No additional network requests:** Route transitions are client-side only. No server round-trips for navigation.
- **TanStack Router devtools:** Lazy-loaded in dev mode only, tree-shaken from production.

## Security Considerations

- **Search param validation:** Zod schemas validate `?session=` and `?dir=` before they reach application code. Invalid values are caught at the route level.
- **No new attack surface:** Client-side routing doesn't expose new server endpoints. The existing API remains unchanged.
- **Directory traversal:** The `?dir=` param is validated by the server when used in API calls (existing behavior, unchanged).

## Documentation

- Update `contributing/architecture.md` to document the route structure
- Update `contributing/state-management.md` to document TanStack Router search params replacing nuqs
- Update `CLAUDE.md` to mention TanStack Router in the client section (replace nuqs reference)
- Update `contributing/project-structure.md` to document `router.ts`, `AppShell.tsx`, and new widget directories

## Implementation Phases

### Phase 1: Foundation — Router Setup & nuqs Replacement

1. Install `@tanstack/react-router`, `@tanstack/zod-adapter`, `@tanstack/react-router-devtools`
2. Create `router.ts` with route tree (root, index, session routes)
3. Create `AppShell.tsx` — extract standalone mode from `App.tsx`, replace `<ChatPanel>` with `<Outlet>`
4. Refactor `App.tsx` — keep embedded branch only
5. Update `main.tsx` — replace `NuqsAdapter` with `RouterProvider`
6. Rewrite `useSessionId` and `useDirectoryState` — nuqs → TanStack Router
7. Create `useSessionSearch` helper
8. Remove `nuqs` from `package.json`

### Phase 2: Pages & Navigation

1. Create `DashboardPage` placeholder (widget layer)
2. Create `SessionPage` wrapper (widget layer)
3. Add Dashboard/New Session nav links to `AgentSidebar`
4. Add "Go to Dashboard" action to command palette
5. Verify all 10 consumer components work without changes

### Phase 3: Testing & Cleanup

1. Update `use-directory-state.test.tsx` — mock TanStack Router instead of nuqs
2. Create `routing.test.tsx` — integration tests for route navigation
3. Update E2E tests to navigate to `/session` instead of `/`
4. Verify all 11 existing test files pass unchanged (they mock at hook level)
5. Remove any remaining nuqs references from codebase
6. Update documentation (architecture, state management, CLAUDE.md)

## Open Questions

1. ~~**Search params on root vs session route**~~ (RESOLVED)
   **Answer:** Define on the session route only. Use `useSearch({ from: '/session', strict: false })` which returns `undefined` when not on the session route — handled by `?? null` fallback in hooks. No try/catch needed.

2. ~~**Redirect `/` → `/session` when session param present**~~ (RESOLVED)
   **Answer:** Yes. Add a `beforeLoad` redirect on the index route that checks for `?session=` in the URL and redirects to `/session?session=...`. This preserves backward compatibility for old bookmarks.

3. ~~**`transformContent` prop**~~ (RESOLVED)
   **Answer:** Only used in embedded (Obsidian) mode. `SessionPage` does not need it. The prop stays in `App.tsx`'s embedded branch only.

## Related ADRs

- ADR-0043: Agent Storage (file-first write-through) — not directly affected but referenced in ideation
- New ADRs to be extracted: Router library choice, nuqs replacement rationale

## References

- `specs/dashboard-home-route/01-ideation.md` — Full ideation with research and decisions
- `research/20260320_dashboard_route_navigation_architecture.md` — Dashboard design patterns
- `research/20260320_tanstack_router_vs_react_router_v7.md` — Router comparison
- `meta/value-architecture-applied.md` — VL-03 (Multi-Session Command Center)
- `meta/personas/the-autonomous-builder.md` — Kai's at-a-glance needs
- `meta/personas/the-knowledge-architect.md` — Priya's quick orientation needs
- `research/20260320_tanstack_router_code_patterns.md` — TanStack Router code patterns for DorkOS
- [TanStack Router docs — Code-based routing](https://tanstack.com/router/latest/docs/routing/code-based-routing)
- [TanStack Router docs — Search params](https://tanstack.com/router/latest/docs/guide/search-params)
