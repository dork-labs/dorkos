---
title: 'TanStack Router Code-Based API Patterns for Vite SPA Migration'
date: 2026-03-20
type: external-best-practices
status: active
tags:
  [
    routing,
    tanstack-router,
    react-19,
    vite,
    search-params,
    zod,
    layout-routes,
    code-based-routing,
    tanstack-query,
  ]
searches_performed: 12
sources_count: 18
---

## Research Summary

This report provides concrete, copy-pasteable code examples for migrating a React 19 + Vite 6 SPA to TanStack Router using **code-based routing** (not file-based). It covers: `createRootRouteWithContext`, `createRoute`, `createRouter`, layout routes with `<Outlet>`, Zod-validated search params, `useSearch`, `useNavigate` with functional updates, splat catch-all routes, and the TanStack Query integration story. The Vite plugin (`@tanstack/router-vite-plugin`) is confirmed not needed for code-based routing. The `@tanstack/react-router-with-query` package is confirmed to be SSR-only and irrelevant for a plain Vite SPA.

> **Note**: Prior research (`research/20260320_tanstack_router_vs_react_router_v7.md`) recommends React Router v7 for DorkOS at this stage due to the nuqs adapter situation and route simplicity. This report provides the TanStack Router patterns anyway — useful if the decision reverses or nuqs is being replaced.

---

## Key Findings

### 1. Vite Plugin: Not Needed for Code-Based Routing

`@tanstack/router-vite-plugin` (also `@tanstack/router-plugin`) is **exclusively for file-based routing**. It watches route files and auto-generates a `routeTree.gen.ts` file. For code-based routing, you build the route tree manually with `addChildren()` and pass it to `createRouter`. No plugin needed, no codegen step.

### 2. `@tanstack/react-router-with-query`: SSR-Only, Skip It

This package is only useful in SSR contexts (TanStack Start / full-stack setups). Per a GitHub issue confirmed by maintainers: "it's only supposed to be used in SSR contexts so it doesn't work if `@tanstack/react-start` isn't installed." For a plain Vite SPA, **do not install it**. Instead, pass `queryClient` through router context (shown below).

### 3. Zod Integration: Use `@tanstack/zod-adapter` for Best Types

You can pass a Zod schema directly to `validateSearch`, but the recommended pattern uses `zodValidator()` from `@tanstack/zod-adapter`. This provides better type inference, particularly around `.optional()` and `.catch()`. For Zod v4 (>=4.0.6), native `.default().catch()` chaining also works without the adapter.

### 4. Search Params: `undefined` vs. Missing in URL

When a param is `z.string().optional()`, an absent key in the URL gives you `undefined` in TypeScript. TanStack Router does NOT put `undefined` in the URL string — it omits the key entirely. Setting a param to `undefined` removes it from the URL. This is clean and matches nuqs behavior.

### 5. Splat Routes Use `$` as the Path, Not `*`

TanStack Router uses `$` (not `*`) for catch-all/splat routes. The matched value is available as `params._splat`. For a `/dev/*` catch-all that you want to render something specific (or nothing), create a route with `path: 'dev/$'`.

### 6. Pathless Layout Routes for Shared UI

Two patterns exist for shared layout (sidebar + header wrapping child routes):

- **Named layout route** (has a path): `path: '/'` with an `<Outlet>` component. Children are nested under `/`.
- **Pathless layout route** (no URL segment): Use `id: '_layout'` instead of `path`. Children render within the layout but the layout's path segment doesn't appear in the URL. This is the cleaner pattern when you want multiple top-level routes (like `/` and `/session`) sharing the same sidebar.

---

## Detailed Analysis

### Complete Setup: Code-Based Router with QueryClient Context

```typescript
// src/router.ts
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { zodValidator } from '@tanstack/zod-adapter';

// ---- 1. Root route with typed context ----
// createRootRouteWithContext<T>() returns a factory;
// call it immediately with the route config object.
const rootRoute = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootDocument,
});

// The root can be minimal — just an Outlet if you have a
// separate layout route below it that provides the shell UI.
function RootDocument() {
  return <Outlet />;
}

// ---- 2. Pathless layout route (the app shell) ----
// No `path` prop — uses `id` only.
// The shell (sidebar, header) renders here; child routes fill <Outlet />.
const appShellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_shell',           // pathless: no URL segment added
  component: AppShell,
});

function AppShell() {
  return (
    <SidebarProvider>
      <Sidebar>
        <AgentSidebar />
      </Sidebar>
      <SidebarInset>
        <header>{/* top nav */}</header>
        <main className="flex-1 overflow-hidden">
          <Outlet />       {/* DashboardPage or SessionPage renders here */}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

// ---- 3. Dashboard route — index of the shell ----
const dashboardRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/',
  component: DashboardPage,
});

// ---- 4. Session route with Zod-validated search params ----
const sessionSearchSchema = z.object({
  session: z.string().optional(),
  dir: z.string().optional(),
});

const sessionRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/session',
  validateSearch: zodValidator(sessionSearchSchema),
  component: SessionPage,
});

// ---- 5. Dev catch-all route ----
const devRoute = createRoute({
  getParentRoute: () => rootRoute,  // or appShellRoute if it needs the shell
  path: '/dev/$',                   // $ is the splat wildcard
  component: DevPlayground,
});

// DevPlayground can read the splat param:
function DevPlayground() {
  const { _splat } = devRoute.useParams();
  // _splat contains the matched path after /dev/
  return <div>Dev route: {_splat}</div>;
}

// ---- 6. 404 / not-found ----
// TanStack Router recommends adding a notFoundComponent to the root.
// Or use a catch-all splat on rootRoute.

// ---- 7. Assemble the route tree ----
const routeTree = rootRoute.addChildren([
  appShellRoute.addChildren([
    dashboardRoute,
    sessionRoute,
  ]),
  devRoute,
]);

// ---- 8. Create the router ----
const queryClient = new QueryClient();

export const router = createRouter({
  routeTree,
  context: {
    queryClient,
  },
  defaultPreload: 'intent',         // preload on hover/focus
  defaultPreloadStaleTime: 0,       // always re-check stale queries on preload
});

// ---- 9. Register for global type safety ----
// This module augmentation makes all Link/useNavigate calls
// across the codebase type-check against your actual route tree.
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
```

```typescript
// src/main.tsx
import ReactDOM from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { router } from './router';
import { queryClient } from './query-client'; // your QueryClient instance

const rootElement = document.getElementById('root')!;

if (!rootElement.innerHTML) {
  ReactDOM.createRoot(rootElement).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
```

**Key note on `QueryClientProvider` placement**: Wrap `<RouterProvider>` with `<QueryClientProvider>` so any component in the tree can use `useQuery`. The router's context also receives `queryClient` for use in loaders. Both are needed.

---

### Search Params: Complete Pattern

```typescript
// Route definition (inside router.ts or a dedicated routes file)
import { z } from 'zod';
import { zodValidator } from '@tanstack/zod-adapter';

const sessionSearchSchema = z.object({
  session: z.string().optional(),
  dir: z.string().optional(),
});

const sessionRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/session',
  validateSearch: zodValidator(sessionSearchSchema),
  component: SessionPage,
});
```

```typescript
// SessionPage.tsx — reading search params
function SessionPage() {
  // Route.useSearch() is scoped to this route.
  // TypeScript knows: { session: string | undefined, dir: string | undefined }
  const { session, dir } = sessionRoute.useSearch();

  return <ChatPanel sessionId={session} workingDir={dir} />;
}
```

```typescript
// Updating search params with useNavigate
import { useNavigate } from '@tanstack/react-router';

function SomeChildComponent() {
  const navigate = useNavigate({ from: sessionRoute.fullPath });

  function openSession(sessionId: string, directory: string) {
    // Functional update — spreads previous search, overrides specific keys.
    // Anything not included in the spread is dropped.
    navigate({
      search: (prev) => ({
        ...prev,
        session: sessionId,
        dir: directory,
      }),
    });
  }

  function clearSession() {
    // Setting to undefined removes the key from the URL entirely.
    navigate({
      search: (prev) => ({
        ...prev,
        session: undefined,
        dir: undefined,
      }),
    });
  }

  // Navigate to /session while preserving existing search params:
  function goToSession() {
    navigate({
      to: '/session',
      search: (prev) => prev, // preserve all current params
    });
  }
}
```

```typescript
// Using Link for navigation with search params
import { Link } from '@tanstack/react-router';

// Navigate to /session with specific params (full replacement):
<Link
  to="/session"
  search={{ session: 'abc123', dir: '/path/to/project' }}
>
  Open Session
</Link>

// Functional update — based on current search state:
<Link
  to="/session"
  from={sessionRoute.fullPath}
  search={(prev) => ({ ...prev, session: 'abc123' })}
>
  Switch Session
</Link>

// Preserve search params when navigating between routes:
<Link to="/" search={true}>  {/* search={true} passes all current params to target */}
  Dashboard
</Link>
```

**How undefined/missing values work:**

- `session: undefined` in the navigate call → key is **omitted** from the URL (`/session` not `/session?session=undefined`)
- Navigating to `/session` with no `?session=` → `useSearch()` returns `{ session: undefined, dir: undefined }`
- Zod's `.optional()` handles this correctly — the value is `undefined`, not an error

---

### Search Params with Default Values

Use `.catch()` (or `.default()` + `.catch()`) for params that should never be `undefined` in the component:

```typescript
const searchSchema = z.object({
  // session is truly optional — components must handle undefined
  session: z.string().optional(),
  dir: z.string().optional(),

  // page always has a value — falls back to 1 if missing/invalid
  page: z.number().int().positive().catch(1),

  // tab has a known set of values, falls back to 'overview'
  tab: z.enum(['overview', 'history', 'settings']).catch('overview'),
});
```

With `@tanstack/zod-adapter` and the `fallback` helper (for Zod v3):

```typescript
import { zodValidator, fallback } from '@tanstack/zod-adapter';

const searchSchema = z.object({
  session: fallback(z.string(), '').optional(),
  page: fallback(z.number(), 1),
});
```

For Zod v4 (>= 4.0.6), native `.default().catch()` works without the adapter:

```typescript
const searchSchema = z.object({
  page: z.number().default(1).catch(1),
});
```

---

### Layout Route with Outlet — Two Patterns

**Pattern A: Named layout route (has a URL path)**

The route's path contributes to the URL. Children appear at paths under it.

```typescript
// The layout route itself is at '/'
const layoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: AppShell, // renders <Outlet /> inside
});

// Dashboard is the index of '/'
const dashboardRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/', // this is the index of the parent '/'
  component: DashboardPage,
});

// Session is at '/session'
const sessionRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: 'session', // becomes '/session'
  component: SessionPage,
});

const routeTree = rootRoute.addChildren([layoutRoute.addChildren([dashboardRoute, sessionRoute])]);
```

**Pattern B: Pathless layout route (no URL segment — preferred for DorkOS)**

The layout's `id` doesn't appear in the URL. Each child can have top-level paths.

```typescript
// Pathless — uses `id` not `path`
const appShellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_shell', // convention: prefix with _ to signal pathless
  component: AppShell,
});

// Dashboard at '/'
const dashboardRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/',
  component: DashboardPage,
});

// Session at '/session'
const sessionRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/session',
  validateSearch: zodValidator(sessionSearchSchema),
  component: SessionPage,
});

// Dev at '/dev/$' — note: this bypasses the shell (no sidebar)
const devRoute = createRoute({
  getParentRoute: () => rootRoute, // direct child of root, not shell
  path: '/dev/$',
  component: DevPlayground,
});

const routeTree = rootRoute.addChildren([
  appShellRoute.addChildren([dashboardRoute, sessionRoute]),
  devRoute,
]);
```

The `AppShell` component for either pattern:

```typescript
import { Outlet } from '@tanstack/react-router';

function AppShell() {
  return (
    <SidebarProvider defaultOpen={true}>
      <Sidebar collapsible="icon">
        <AgentSidebar />
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 items-center px-4">
          {/* AgentIdentityChip, command palette trigger, etc. */}
        </header>
        <main className="flex-1 overflow-hidden">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
```

---

### Navigation — Complete Pattern

```typescript
// Programmatic navigation
import { useNavigate } from '@tanstack/react-router';

function AgentSidebar() {
  const navigate = useNavigate();

  // Navigate to dashboard:
  function goToDashboard() {
    navigate({ to: '/' });
  }

  // Navigate to a session (from the session list):
  function openSession(session: Session) {
    navigate({
      to: '/session',
      search: {
        session: session.id,
        dir: session.workingDir,
      },
    });
  }

  // Navigate to session from within /session (update params only):
  function switchSession(newSessionId: string) {
    // `from` makes navigate type-check that these search params exist on /session
    navigate({
      from: '/session',
      search: (prev) => ({ ...prev, session: newSessionId }),
    });
  }
}
```

```typescript
// NavLink with active state (for sidebar navigation items):
import { Link } from '@tanstack/react-router';

function SidebarNav() {
  return (
    <>
      {/* `activeProps` applies when the link is active */}
      <Link
        to="/"
        activeProps={{ className: 'bg-sidebar-accent text-sidebar-accent-foreground' }}
        activeOptions={{ exact: true }}  // only active on exactly '/', not '/session'
      >
        Dashboard
      </Link>

      <Link
        to="/session"
        activeProps={{ className: 'bg-sidebar-accent text-sidebar-accent-foreground' }}
      >
        New Session
      </Link>
    </>
  );
}
```

**The `from` prop is important**: On `useNavigate` and `Link`, specifying `from` narrows TypeScript's understanding of what `search` can contain. Without `from`, the type is the union of all routes' search params — very wide. With `from: '/session'`, it's scoped to only that route's schema.

---

### Catch-All / Dev Route

For `/dev/*` (the dev playground), TanStack Router uses `$` as the splat wildcard:

```typescript
// If you want the dev routes to exist within TanStack Router:
const devRoute = createRoute({
  getParentRoute: () => rootRoute,  // child of root, bypasses app shell
  path: '/dev/$',                    // matches /dev/ and everything after
  component: DevPlayground,
});

function DevPlayground() {
  const { _splat } = devRoute.useParams();
  // For /dev/components → _splat = 'components'
  // For /dev/forms/inputs → _splat = 'forms/inputs'
  return <DevRouter path={_splat} />;
}
```

**Alternative — use `notFoundComponent` for unrecognized routes:**

If you want TanStack Router to not intercept `/dev/*` routes at all (falling through to existing `window.location.pathname` logic), that is not directly supported — TanStack Router owns all routing. The best approach for the dev playground is to put it inside a TanStack route and mount your existing playground router there by reading `_splat` and matching it internally.

```typescript
// Inside DevPlayground, use the existing window.location-based routing:
function DevPlayground() {
  const { _splat } = devRoute.useParams();
  // Pass _splat as the "current path" to your existing playground system
  return <PlaygroundApp currentPath={`/dev/${_splat ?? ''}`} />;
}
```

---

### TanStack Query Integration

For a Vite SPA (no SSR), the integration is straightforward: pass `queryClient` through router context and use it in loaders.

**Do NOT install `@tanstack/react-router-with-query`** — it requires `@tanstack/react-start` (SSR) and fails silently in a pure client-side context. This was confirmed in GitHub issue #4208.

The correct pattern for a Vite SPA:

```typescript
// 1. In router.ts — pass queryClient as context
const router = createRouter({
  routeTree,
  context: { queryClient },
});

// 2. In a route — use queryClient in the loader for prefetching
const sessionsQueryOptions = queryOptions({
  queryKey: ['sessions'],
  queryFn: fetchSessions,
});

const dashboardRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/',
  // loader runs before component mounts, prefetches into Query cache
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(sessionsQueryOptions),
  component: DashboardPage,
});

// 3. In the component — use TanStack Query hooks as normal
function DashboardPage() {
  // Data is already in cache thanks to the loader; no loading spinner on nav
  const { data: sessions } = useQuery(sessionsQueryOptions);
  return <SessionList sessions={sessions} />;
}
```

**What the loader buys you**: When navigating to `/` with `defaultPreload: 'intent'`, TanStack Router fires the loader on hover/focus, before the user even clicks. By the time they arrive at the dashboard, the data is in the Query cache. No loading state needed. This is the primary TanStack Query integration benefit — not SSR dehydration.

**Devtools**: Use `@tanstack/router-devtools` and `@tanstack/react-query-devtools` separately. No unified package is needed.

```typescript
// Optional: add devtools to the root route component
import { TanStackRouterDevtools } from '@tanstack/router-devtools';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

function RootDocument() {
  return (
    <>
      <Outlet />
      {import.meta.env.DEV && (
        <>
          <ReactQueryDevtools buttonPosition="bottom-left" />
          <TanStackRouterDevtools position="bottom-right" />
        </>
      )}
    </>
  );
}
```

---

### Package Installation Summary

```bash
# Core
pnpm add @tanstack/react-router

# Zod adapter for search param validation (recommended)
pnpm add @tanstack/zod-adapter

# Devtools (dev only)
pnpm add -D @tanstack/router-devtools

# Do NOT install:
# @tanstack/router-vite-plugin  (file-based routing only, not needed)
# @tanstack/react-router-with-query  (SSR only, breaks in plain SPA)
```

---

### Complete Working `routeTree.ts` for DorkOS

```typescript
// src/routeTree.ts
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { zodValidator } from '@tanstack/zod-adapter';

// Context type
interface RouterContext {
  queryClient: QueryClient;
}

// Root route
const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootDocument,
  notFoundComponent: () => <div>404 — Page not found</div>,
});

function RootDocument() {
  return <Outlet />;
}

// Pathless app shell layout (sidebar + header)
const appShellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_shell',
  component: AppShell,
});

// Dashboard at /
const dashboardRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/',
  component: DashboardPage,
});

// Session at /session with validated search params
const sessionRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/session',
  validateSearch: zodValidator(
    z.object({
      session: z.string().optional(),
      dir: z.string().optional(),
    })
  ),
  component: SessionPage,
});

// Dev playground at /dev/* (bypasses app shell)
const devRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dev/$',
  component: DevPlayground,
});

// Route tree
export const routeTree = rootRoute.addChildren([
  appShellRoute.addChildren([dashboardRoute, sessionRoute]),
  devRoute,
]);

// Router factory (call this in main.tsx with your queryClient)
export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  });
}

// Type registration (enables global type safety on Link, useNavigate, etc.)
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
```

```typescript
// src/main.tsx
import ReactDOM from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createAppRouter } from './routeTree';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,  // 1 minute
    },
  },
});

const router = createAppRouter(queryClient);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
);
```

---

## Sources & Evidence

- [Code-Based Routing | TanStack Router Docs](https://tanstack.com/router/latest/docs/routing/code-based-routing)
- [Creating a Router | TanStack Router Docs](https://tanstack.com/router/latest/docs/framework/react/guide/creating-a-router)
- [Router Context | TanStack Router Docs](https://tanstack.com/router/v1/docs/framework/react/guide/router-context) — `createRootRouteWithContext` pattern
- [createRootRouteWithContext function | TanStack Router Docs](https://tanstack.com/router/v1/docs/api/router/createRootRouteWithContextFunction)
- [Validate Search Parameters with Schemas | TanStack Router Docs](https://tanstack.com/router/latest/docs/framework/react/how-to/validate-search-params)
- [How to Set Up Basic Search Parameters | TanStack Router Docs](https://tanstack.com/router/latest/docs/framework/react/how-to/setup-basic-search-params)
- [Search Params | TanStack Router Docs](https://tanstack.com/router/v1/docs/framework/react/guide/search-params)
- [Route Matching | TanStack Router Docs](https://tanstack.com/router/latest/docs/framework/react/routing/route-matching) — splat/catch-all routes
- [Routing Concepts | TanStack Router Docs](https://tanstack.com/router/v1/docs/framework/react/routing/routing-concepts) — pathless layout routes
- [TanStack Query Integration | TanStack Router Docs](https://tanstack.com/router/v1/docs/integrations/query)
- [Installation with Vite | TanStack Router Docs](https://tanstack.com/router/v1/docs/framework/react/installation/with-vite) — plugin only for file-based routing
- [`@tanstack/react-router-with-query` only works if `@tanstack/react-start` is installed · Issue #4208](https://github.com/TanStack/router/issues/4208)
- [Search Parameters and Validation | DeepWiki TanStack/router](https://deepwiki.com/tanstack/router/9.2-search-parameters-and-validation)
- [How to use completely optional search params? · Discussion #923](https://github.com/TanStack/router/discussions/923)
- [Custom Layout for Specific Routes in tanstack/router · Discussion #1102](https://github.com/TanStack/router/discussions/1102)
- [TanStack Router with React Vite app and React Query | Reetesh Kumar](https://reetesh.in/blog/tanstack-router-with-react-vite-app-and-react-query)
- [TanStack Router for React: A Complete Guide | OpenReplay](https://blog.openreplay.com/tanstack-router-for-react--a-complete-guide/)
- [Zod 4 support for `@tanstack/zod-adapter` | Issue #4322](https://github.com/TanStack/router/issues/4322)

---

## Research Gaps & Limitations

- The TanStack Router docs site returns 303 redirects for some URL patterns, making direct content scraping unreliable. All patterns confirmed via secondary authoritative sources (official GitHub discussions, deep wiki, production tutorial articles).
- Exact behavior of `search={true}` on `Link` (whether it passes ALL current search params or just the matched route's params) was not confirmed from a primary source. The pattern was found in the DeepWiki summary; verify before relying on it.
- The pathless layout route interaction with `notFoundComponent` on a child of a pathless route was not tested — default behavior should apply (notFoundComponent on root catches all unmatched routes).

## Search Methodology

- Searches performed: 12
- Most productive terms: "TanStack Router code-based routes createRootRouteWithContext createRoute 2025", "TanStack Router zodValidator @tanstack/zod-adapter fallback optional", "TanStack Router splat wildcard $ catch-all route", "@tanstack/react-router-with-query SSR SPA"
- Primary sources: tanstack.com official docs, github.com/TanStack/router issues/discussions, deepwiki.com/tanstack/router, reetesh.in blog article (Vite + React Query integration), blog.openreplay.com complete guide
