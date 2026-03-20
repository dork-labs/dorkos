---
title: 'TanStack Router vs React Router v7 for DorkOS SPA Routing'
date: 2026-03-20
type: external-best-practices
status: active
tags: [routing, tanstack-router, react-router, nuqs, spa, react-19, search-params, tanstack-query]
searches_performed: 14
sources_count: 22
---

## Research Summary

TanStack Router and React Router v7 are both valid choices for DorkOS's greenfield router addition, but they optimize for different things. TanStack Router delivers first-class type-safe search params, tighter TanStack Query integration, and a more principled SPA-first design — all at the cost of a larger bundle (~45KB minified vs ~20KB for React Router), a more involved setup, and an experimental nuqs adapter with real limitations. React Router v7 is leaner, battle-tested, has an explicit and stable nuqs adapter (`nuqs/adapters/react-router/v7`), and requires zero new paradigms for someone already using React Router idioms. For DorkOS's specific situation — 2–5 routes, existing TanStack ecosystem familiarity, and nuqs in production — **TanStack Router is the stronger long-term choice**, but only if the team is willing to migrate away from nuqs for URL state. If nuqs must be preserved as-is, React Router v7 is the pragmatic default with zero friction.

---

## Key Findings

### 1. Bundle Size: React Router v7 Wins Significantly (~20KB vs ~45KB Minified)

React Router v7 (`react-router` package) comes in at approximately **20KB minified**, with a gzipped size that multiple sources report as under 10KB in practice. TanStack Router (`@tanstack/react-router`) is approximately **45KB minified** — more than double. The BetterStack comparison (2025) confirms this gap.

However, the gap is partly theoretical for DorkOS: both libraries support code splitting, and DorkOS has 2–5 routes — not enough routes for code splitting to make a meaningful difference either way. The 25KB additional cost of TanStack Router is a real but small tax on a SPA that will already ship hundreds of KBs of React, TanStack Query, and shadcn/ui.

**Verdict**: React Router v7 wins on bundle size, but the margin is unlikely to be user-perceptible for DorkOS's use case.

### 2. React 19 Support: Both Libraries Support It

- **TanStack Router**: Explicitly supports React 18.x and 19.x per official documentation. The peer dependency is `react >= 18`, and the library has been tested with React 19 APIs including concurrent features. Active release cadence (version 1.167.5 as of March 2026, published daily).
- **React Router v7**: Released December 2024 with explicit React 19 support. The Remix blog states it "smoothly bridges the gap between React 18 and 19" and supports `React.use` as an alternative to the `<Await>` component. Fully React 19 compatible.

**Verdict**: Both work with React 19. No meaningful distinction here.

### 3. nuqs Compatibility: React Router v7 Wins Clearly

This is the most consequential practical difference for DorkOS right now.

**React Router v7 + nuqs:**

- Official, stable, first-class adapter: `nuqs/adapters/react-router/v7`
- Zero limitations on supported types — all parsers work including `parseAsJson`, custom parsers, arrays of objects
- Drop-in: wrap the app in `<NuqsAdapter>` in `main.tsx`, all existing hooks (`useSessionId`, `useDirectoryState`) continue working unchanged
- The adapter for v6 is deprecated; v7 is the current supported version
- **Zero migration risk for existing nuqs usage**

**TanStack Router + nuqs:**

- Experimental adapter added in nuqs 2.5 (2025)
- **Known limitation**: Only "trivial" state types work for type-safe linking — string-based parsers, number, boolean, and JSON. The `urlKeys` shorthand feature is unsupported.
- **Active bug (as of early 2026)**: `parseAsJson` and custom parsers for arrays of objects serialize incorrectly to `[object Object]`, causing parsing errors. (GitHub issue #1127)
- The nuqs maintainer explicitly recommends: "TanStack Router already has great APIs for type-safe URL state management. The adapter serves mainly as a compatibility layer — it's best for importing components that use nuqs rather than building new applications with nuqs as the primary URL state manager."
- **nuqs does not cover TanStack Start** at all

**Verdict**: React Router v7 wins decisively on nuqs compatibility. TanStack Router's nuqs adapter is experimental with real bugs affecting the exact use case DorkOS has (`?session=abc123`, `?dir=/path/to/project`).

### 4. TanStack Router's Search Params — The Potential nuqs Replacement

TanStack Router's built-in search params are the real counter-argument to the nuqs limitation. The design philosophy (articulated on the TanStack blog in "Search Params Are State") is that search params are application state — and the router should own their schema, validation, and typing, not a separate library.

**How it works:**

```typescript
// Define search params in the route definition
export const Route = createFileRoute('/session')({
  validateSearch: z.object({
    session: z.string().optional(),
    dir: z.string().optional(),
  }),
});

// Read them (fully typed — TypeScript knows session is string | undefined)
function SessionPage() {
  const { session, dir } = Route.useSearch();
  return <ChatPanel sessionId={session} dir={dir} />;
}

// Update them
const navigate = useNavigate({ from: Route.fullPath });
navigate({ search: (prev) => ({ ...prev, session: newSessionId }) });
```

**Key properties:**

- Schema defined once per route — no drift between definition and usage
- Integrated with Zod, Valibot, or manual validation functions
- Type inference flows from the schema; no manual types needed
- `useSearch()` is scoped to the route — child routes inherit parent schemas
- Works with `useNavigate` for updates — supports functional updates (`prev => ...`)
- Deep-link compatible — same URL format as nuqs produces

**The migration cost**: Every hook that currently uses `nuqs` (`useSessionId`, `useDirectoryState`) would need to be rewritten to use `Route.useSearch()` instead. This is not a one-liner — it requires refactoring hooks and potentially restructuring how components access URL state (since `Route.useSearch()` is route-scoped, not globally available).

**Verdict**: TanStack Router's search params are technically superior to nuqs for new code. The migration from nuqs to TanStack Router search params is real work but not enormous for 2-3 params. The question is whether the team wants to do it.

### 5. TanStack Query Integration: TanStack Router Wins

Because DorkOS already uses TanStack Query v5, this is a meaningful consideration.

**TanStack Router + TanStack Query:**

- Route loaders can call `queryClient.ensureQueryData()` to prefetch data before the route renders
- Loaders run in parallel for all matching routes — data is in flight before components mount
- Type-safe: the loader's return type flows through to components
- Official integration package: `@tanstack/router-with-query` provides a unified devtools experience
- Query dehydration/rehydration for SSR (not relevant for DorkOS, but available)

```typescript
export const Route = createFileRoute('/session')({
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(sessionsQuery()),
  component: SessionPage,
});
```

**React Router v7 + TanStack Query:**

- React Router v7 loaders can also prefetch Query data using `queryClient.prefetchQuery()`
- Works, but requires manual wiring — there is no official React Router/TanStack Query integration package
- The TanStack Query docs explicitly document this pattern but it's a convention, not a first-class API
- No type inference from loader → component (you have to re-declare types)

**For DorkOS specifically**: DorkOS loads sessions via TanStack Query hooks inside components already. The router loader pattern would be most useful if sessions were loaded before the route renders — an optimization, not a necessity. For 2–5 routes where the primary data is already reactive via SSE, the loader integration advantage is real but not transformative.

**Verdict**: TanStack Router wins for TanStack Query integration, but the advantage is modest for DorkOS's current data loading architecture.

### 6. Learning Curve: React Router v7 Wins for Existing Users

- **React Router v7**: Familiar patterns — `createBrowserRouter`, `RouterProvider`, `<Outlet>`, `<Link>`, `useNavigate`. Anyone who has used React Router v6 can adopt v7 in hours. The data router pattern (loaders/actions) is optional — the team can ignore it initially.
- **TanStack Router**: More involved initial setup. Requires understanding file-based routing conventions OR the code-based router, the `createRootRoute`/`createRoute`/`createRouter` APIs, the `validateSearch` pattern for search params, and the `RouterProvider` + `QueryClient` context wiring. The tooling (Vite plugin for code generation) adds another layer. The payoff is real but the ramp-up is a half-day to a full day of learning.

The DorkOS team already uses TanStack Query v5, which means the TanStack mental model is partially familiar. This reduces — but does not eliminate — the learning curve gap.

**Verdict**: React Router v7 wins on learning curve. TanStack Router requires more upfront investment.

### 7. Future Direction

**React Router v7 / Remix trajectory:**
React Router v7 merged Remix's framework-mode features (loaders, actions, file-based routing) directly into the library. The Remix brand continues separately for "what comes next" (beyond React). The library is actively maintained by Shopify (via Remix acquisition) and React Router itself has massive adoption. SPA-mode (library mode, not framework mode) is fully supported and stable.

**Note**: React Router v7 now has three modes — declarative routing (traditional SPA), data router mode, and full framework mode. For DorkOS, only declarative + data router mode is relevant. The framework mode complexity does not apply.

**TanStack Router trajectory:**
Tanner Linsley and the TanStack team are pushing TanStack Router as the TypeScript-first routing future. TanStack Start (the full-stack framework built on TanStack Router) is in active development. The library is gaining adoption rapidly, with patterns.dev recommending it for "React Stack Patterns 2026." Active release cadence (daily releases as of March 2026).

**Verdict**: Both libraries have strong futures. React Router v7 has deeper adoption and institutional backing; TanStack Router has stronger TypeScript momentum and is better aligned with the direction the TanStack ecosystem is heading.

---

## Detailed Analysis

### The nuqs Decision Is the Pivotal Fork

The choice between these two routers is, in practice, a choice about what to do with `nuqs`. DorkOS uses nuqs for `?session=` and `?dir=` URL state. Those two hooks (`useSessionId`, `useDirectoryState`) touch every session interaction in the app.

**Path A: Keep nuqs → Use React Router v7**

- `nuqs/adapters/react-router/v7` is stable, full-featured, and officially maintained
- Zero migration of existing hooks
- Zero risk of the `[object Object]` serialization bug
- Recommended setup: wrap `<RouterProvider>` in `<NuqsAdapter>` in `main.tsx`, done

**Path B: Replace nuqs with TanStack Router search params → Use TanStack Router**

- Migration effort: rewrite `useSessionId` and `useDirectoryState` to use `Route.useSearch()`
- These hooks are used in many components — the refactor touches multiple files
- End result is architecturally cleaner: URL state schema lives next to the route definition
- TanStack Router's type inference for search params is meaningfully better than nuqs
- No experimental adapter risk

**Path C: Keep nuqs + Use TanStack Router (not recommended)**

- Experimental adapter with known bugs for complex types
- The nuqs maintainer explicitly recommends against this for new apps
- Creates two competing URL state systems in the same codebase

The research strongly suggests that Path C should be avoided. The choice is between Path A (React Router, keep nuqs) and Path B (TanStack Router, replace nuqs).

### What Code-Split Benefits Actually Look Like for 2-5 Routes

TanStack Router's automatic code splitting is frequently cited as a bundle-size advantage, but for 2-5 routes this is mostly irrelevant:

- The dashboard (`/`) loads first on every visit — it will always be in the initial bundle
- The session page (`/session`) is the second most common route — users navigate to it immediately
- With 2 primary routes, there is virtually nothing to split

TanStack Router does support lazy routes (`lazyRouteComponent`), and so does React Router v7 (`React.lazy` + `Suspense` or the `lazy` route property). Both handle code splitting equally well. The "automatic" splitting advantage of TanStack Router applies primarily to file-based routing with the Vite plugin — which adds its own complexity overhead.

### The Embedded Mode Constraint

DorkOS has an embedded mode (Obsidian plugin) that must not use a router. Both libraries handle this identically: the embedded path in `App.tsx` renders `<ChatPanel>` directly, never touches the router, and the standalone path uses `RouterProvider`. This constraint does not favor either library.

### Real-World Setup Comparison

**React Router v7 setup for DorkOS (standalone path):**

```typescript
// main.tsx
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { NuqsAdapter } from 'nuqs/adapters/react-router/v7';

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'session', element: <SessionPage /> },
    ],
  },
]);

<NuqsAdapter>
  <RouterProvider router={router} />
</NuqsAdapter>
```

All existing nuqs hooks (`useSessionId`, `useDirectoryState`) work unchanged. This is a ~30-line change to `main.tsx` and `App.tsx`.

**TanStack Router setup for DorkOS (standalone path):**

```typescript
// routeTree.ts
import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: AppShell,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
});

const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/session',
  validateSearch: z.object({
    session: z.string().optional(),
    dir: z.string().optional(),
  }),
  component: SessionPage,
});

const routeTree = rootRoute.addChildren([dashboardRoute, sessionRoute]);
const router = createRouter({ routeTree, context: { queryClient } });

// main.tsx
<RouterProvider router={router} />
```

Then in `SessionPage`, replace nuqs hooks:

```typescript
// Before (nuqs):
const [sessionId] = useSessionId(); // reads ?session=
const [dir] = useDirectoryState(); // reads ?dir=

// After (TanStack Router):
const { session: sessionId, dir } = sessionRoute.useSearch();
```

This requires updating `useSessionId` and `useDirectoryState` hooks throughout the codebase, plus any component that calls them — or creating thin adapter hooks that delegate to `Route.useSearch()`.

---

## Recommendation

### The Clear Choice for DorkOS: **React Router v7**

After thorough analysis, React Router v7 is the correct choice for DorkOS at this stage, for the following specific reasons:

**1. The nuqs situation is disqualifying for TanStack Router right now.**
The TanStack Router nuqs adapter is experimental, has a known active bug with complex types, and the nuqs maintainer explicitly recommends against it for new application code. DorkOS uses nuqs for `?session=` and `?dir=` params that are threaded through many components. The React Router v7 adapter is stable, full-featured, and zero-friction.

**2. The routing requirements are genuinely simple.**
2-5 routes, shared layout, no deeply nested route trees, no concurrent data loading from multiple routes, no SSR. The features that make TanStack Router worth its complexity — route-level type-safe search params schemas, parallel loader prefetching, devtools integration — are real but marginal for this use case. React Router v7's simpler API is not a limitation here; it is sufficient.

**3. TanStack Query integration is already good with React Router v7.**
The pattern of calling `queryClient.prefetchQuery()` inside a React Router loader is well-documented and widely used. For DorkOS's current architecture (reactive hooks + SSE, not loader-driven data fetching), this is not a meaningful differentiator.

**4. Existing research already landed here.**
The `20260320_dashboard_route_navigation_architecture.md` research report (same day) independently arrived at React Router v7 as the correct choice after studying the routing architecture needs. This report corroborates that finding and adds more specificity around the nuqs tradeoffs.

**5. The bundle size penalty is not worth it for 2 routes.**
TanStack Router adds ~25KB over React Router v7. For a tool whose primary users (Kai, Priya) are developers who care about loading speed, this is not worth it for the marginal feature set improvement at this route count.

### When to Revisit

Revisit TanStack Router when:

- The route count exceeds ~10 and route-level type safety starts to matter for preventing bugs
- The team is ready to replace nuqs entirely with TanStack Router's search params (a clean architectural win, but real migration cost)
- TanStack Router's nuqs adapter stabilizes and the known bugs are resolved
- DorkOS adopts TanStack Start for SSR/RSC in the future (which would make TanStack Router the natural choice)

### Implementation Notes (React Router v7)

Follow the architecture documented in `research/20260320_dashboard_route_navigation_architecture.md`:

1. Add `react-router-dom` (v7) to `apps/client`
2. Wrap `<RouterProvider>` with `<NuqsAdapter>` from `nuqs/adapters/react-router/v7` in `main.tsx`
3. Use `createBrowserRouter` with a single layout route at `/` wrapping `<AppShell>`
4. Dashboard at `{ index: true }`, session at `{ path: 'session' }`
5. `<Outlet>` in the `<main>` area of `AppShell` (renamed from current `App.tsx` standalone branch)
6. All existing nuqs hooks work unchanged — zero migration required

---

## Sources & Evidence

- [TanStack Router vs React Router — Better Stack Community](https://betterstack.com/community/comparisons/tanstack-router-vs-react-router/) — bundle sizes (~20KB vs ~45KB), feature comparison
- [Comparison — TanStack Router vs React Router — TanStack Docs](https://tanstack.com/router/latest/docs/framework/react/comparison) — official feature matrix
- [nuqs Adapters Documentation](https://nuqs.dev/docs/adapters) — React Router v7 adapter (stable), TanStack Router adapter (experimental)
- [Support for TanStack Router — nuqs Discussion #943](https://github.com/47ng/nuqs/discussions/943) — history of TanStack Router adapter request
- [TanStack Router nuqs adapter PR #953](https://github.com/47ng/nuqs/pull/953) — implementation of TanStack Router adapter
- [nuqs bug #1127 — TanStack Router adapter: arrays of objects serialize as [object Object]](https://github.com/47ng/nuqs/issues/1127) — active bug with complex types
- [nuqs 2.5 release notes](https://nuqs.dev/blog/nuqs-2.5) — experimental TanStack Router support added
- [Search Params Are State — TanStack Blog](https://tanstack.com/blog/search-params-are-state) — TanStack's philosophy on search params ownership
- [TanStack Router Search Params Guide — Leonardo Montini](https://leonardomontini.dev/tanstack-router-query-params/) — code examples for validateSearch, useSearch, useNavigate
- [Search Params | TanStack Router Docs](https://tanstack.com/router/v1/docs/framework/react/guide/search-params) — official search params documentation
- [TanStack Query Integration | TanStack Router Docs](https://tanstack.com/router/latest/docs/integrations/query) — official TQ integration guide
- [Loading Data with TanStack Router + React Query — Frontend Masters](https://frontendmasters.com/blog/tanstack-router-data-loading-2/) — loader + ensureQueryData pattern
- [TanStack Router is one of the most powerful options for SPA — Medium](https://medium.com/@yasui-edu0834/tanstack-router-is-one-of-the-most-powerful-options-for-spa-development-tanstack-query-cc7ecdc73550) — TanStack Router + Query synergy analysis
- [Merging Remix and React Router — Remix Blog](https://remix.run/blog/merging-remix-and-react-router) — React Router v7 origin and Remix merger
- [React Router v7 — Remix Blog](https://remix.run/blog/react-router-v7) — official v7 release notes and React 19 support
- [React Stack Patterns 2026 — patterns.dev](https://www.patterns.dev/react/react-2026/) — TanStack Router recommendation for 2026 stack
- [TanStack Router — npm](https://www.npmjs.com/package/@tanstack/react-router) — peer dependencies: react >=18, >=19 both supported
- [TanStack Router GitHub](https://github.com/TanStack/router) — active development, daily releases
- [TanStack Router: The Future of React Routing in 2025 — DEV Community](https://dev.to/rigalpatel001/tanstack-router-the-future-of-react-routing-in-2025-421p) — adoption and learning curve assessment
- [Optimizing Data Loading with React Router and TanStack Query — daniiel.dev](https://www.daniiel.dev/blog/combining-react-router-with-tanstack-query/) — React Router v7 + TanStack Query prefetch pattern

---

## Research Gaps & Limitations

- Exact gzipped bundle sizes for both routers in the same measurement context were not obtainable (Bundlephobia returned errors). The 20KB / 45KB figures (minified, not gzipped) come from the Better Stack comparison article; real gzipped sizes are likely 7-16KB respectively.
- TanStack Router peer dependency requirements were confirmed as "react >=18 OR >=19" via documentation, not the raw package.json. The exact version floor was not pinned from a primary source.
- The nuqs bug (#1127) with TanStack Router arrays-of-objects was confirmed as "open as of early 2026" but the exact resolution status at the time of reading may differ. Check the issue before making a final decision.
- TanStack Router's file-based routing mode (with the Vite plugin and codegen) was not evaluated — this report covers code-based routing only, which is more appropriate for DorkOS's small route count.

## Contradictions & Disputes

- Several SEO-optimized comparison articles claim TanStack Router's bundle size overhead is "offset by automatic optimizations" and results in "30-40% better perceived load times." This is not credible for a 2-5 route SPA and should be ignored.
- Some sources suggest TanStack Router has a "steep" learning curve; others (especially those already in the TanStack ecosystem) characterize it as "moderate." For DorkOS, given existing TanStack Query familiarity, it is best characterized as moderate — a half-day investment.

## Search Methodology

- Searches performed: 14
- Most productive terms: "nuqs TanStack Router adapter compatibility 2025", "TanStack Router search params defineSearchParams useSearch example code", "React Router v7 future direction Remix merger framework mode SPA mode"
- Primary sources: tanstack.com docs, nuqs.dev docs, github.com/47ng/nuqs, betterstack.com comparison, leonardomontini.dev, frontendmasters.com
