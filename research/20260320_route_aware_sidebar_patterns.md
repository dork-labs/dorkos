---
title: 'Route-Aware Sidebar Patterns — TanStack Router, AnimatePresence, shadcn/ui'
date: 2026-03-20
type: internal-architecture
status: active
tags:
  [
    sidebar,
    routing,
    tanstack-router,
    animation,
    framer-motion,
    shadcn-ui,
    react-19,
    fsd,
    route-aware,
    layout-route,
  ]
feature_slug: null
searches_performed: 5
sources_count: 12
---

## Research Summary

This report evaluates five approaches for making the DorkOS sidebar content route-aware, so the dashboard (`/`) and session (`/session`) routes can show different sidebar body content while sharing the same `SidebarHeader`, `SidebarFooter`, and `SidebarRail`. The existing codebase already provides the key constraints: TanStack Router with a pathless `_shell` layout route, shadcn/ui Sidebar, motion/react (`AnimatePresence`, `motion.div`), and Zustand for UI state. The recommended approach is **Approach 2 — Route-Based Content Map in AppShell** using `useRouterState` to select a sidebar body component. This gives clean separation, zero FSD violations, easy extensibility, and works naturally with `AnimatePresence` cross-fade.

---

## Key Findings

### 1. The Problem Is Scoped to `<SidebarContent>`

The shadcn/ui `Sidebar` component has three structural slots: `<SidebarHeader>`, `<SidebarContent>`, and `<SidebarFooter>`. The current `AgentSidebar` fills all three, with the header containing the Dashboard and New Session buttons, the content containing the three-tab panel (Sessions/Schedules/Connections), and the footer containing `SidebarFooterBar` + onboarding progress card.

For route-aware sidebars, only the **`SidebarContent` zone** should be route-sensitive. The header and footer are app-level chrome that should remain stable across navigations. This scopes the problem considerably.

### 2. TanStack Router Provides `useRouterState` for Declarative Route Reading

TanStack Router exposes `useRouterState` (and the convenience `useLocation`) hooks that any component inside `<RouterProvider>` can call, including components inside the pathless layout route's component tree (i.e., `AppShell` and its children). There is no need to use `useMatch` or outlet context for simple content-switching decisions.

```typescript
import { useRouterState } from '@tanstack/react-router';

const pathname = useRouterState({ select: (s) => s.location.pathname });
// pathname is '/' | '/session' | string — reactive, triggers re-render on navigation
```

### 3. AnimatePresence + `motion/react` Pattern for Sidebar Content Transitions

The `motion` library used in DorkOS is a fork of Framer Motion (`motion/react`). The `AnimatePresence` component requires a stable `key` on children to detect mount/unmount events and trigger exit animations. For sidebar content transitions, the simplest reliable pattern is:

```tsx
<AnimatePresence mode="wait">
  <motion.div
    key={pathname} // pathname changes on navigation → triggers exit + enter
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.12 }}
  >
    {sidebarBodyForRoute}
  </motion.div>
</AnimatePresence>
```

This is a standalone cross-fade — not the complex `AnimatedOutlet` + context-cloning pattern required for full page transitions. Sidebar content is much simpler because the sidebar is not unmounted on navigation (the `_shell` layout route persists it).

### 4. Context/Provider Pattern Has Poor FSD Compatibility

A `SidebarContentProvider` that route components "push" into — a pattern used by some React apps — requires route page components (`DashboardPage`, `SessionPage`) to import and invoke sidebar context setters. This creates a downward dependency from `widgets` layer (the page components) into `features/session-list` (the sidebar), violating FSD rules or requiring the provider to live at `shared` layer (which would pollute shared with feature-specific knowledge).

### 5. Existing `AgentSidebar` Already Uses `useLocation` for Route Awareness

The existing `AgentSidebar.tsx` already calls `useLocation()` from TanStack Router to suppress auto-session-selection on the dashboard route:

```typescript
const routerLocation = useLocation();
// On the dashboard route, no session should be auto-selected.
if (routerLocation.pathname === '/') return;
```

This confirms that the sidebar component is already designed to be route-aware at the logic level. The remaining gap is making it **structurally** route-aware at the rendering level.

---

## Detailed Analysis

### Approach 1: Route-Level Sidebar Slots via Outlet Context

**Description:** The pathless `_shell` layout route (`AppShell`) passes a `setSidebarContent` function down via TanStack Router's `Outlet` context (using `context` prop on `createRoute`). Each child route's component calls this function during its `useEffect` to register its sidebar content. `AppShell` reads from its own state and renders whatever was registered.

```typescript
// In the _shell route:
const appShellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_shell',
  component: AppShell,
});

// AppShell passes context to Outlet children
function AppShell() {
  const [sidebarBody, setSidebarBody] = useState<ReactNode>(<AgentSidebar />);
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarContent>{sidebarBody}</SidebarContent>
      </Sidebar>
      <SidebarInset>
        <Outlet context={{ setSidebarBody }} />
      </SidebarInset>
    </SidebarProvider>
  );
}

// DashboardPage sets its preferred sidebar body on mount
function DashboardPage() {
  const { setSidebarBody } = useOutletContext<{ setSidebarBody: (c: ReactNode) => void }>();
  useEffect(() => {
    setSidebarBody(<DashboardSidebarContent />);
    return () => setSidebarBody(<AgentSidebar />);
  }, [setSidebarBody]);
  return <div>...</div>;
}
```

**Pros:**

- Route components fully control their sidebar
- Very flexible — each route can pass arbitrary content

**Cons:**

- `useEffect` sets state after render, causing a flash — `AppShell` renders with the old sidebar, then flips to the new one. Requires careful `useLayoutEffect` or default-state management.
- Route components must import `useOutletContext` and know about sidebar internals — a knowledge leak from pages into the layout shell.
- Fragile cleanup: if a route unmounts without cleanup (e.g., error boundary), the sidebar stays in the wrong state.
- The `context` prop on `createRoute` is for router context (loaders, queryClient), not outlet context. The outlet context API is `<Outlet context={...}>` — a separate, React-level mechanism. This conflation adds cognitive overhead.
- **FSD tension:** Page components (widgets layer) importing sidebar-specific context types from the shell couples layers undesirably.

**Complexity:** Medium
**Maintenance:** Medium-high (flash handling, cleanup discipline)

---

### Approach 2: Route-Based Content Map in AppShell (RECOMMENDED)

**Description:** `AppShell` reads the current pathname via `useRouterState` and uses a lookup map to select which sidebar body component to render. The map is co-located with `AppShell` since it owns the layout decision. The footer and header are static.

```typescript
// AppShell.tsx

import { useRouterState } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { AgentSidebar } from '@/layers/features/session-list';
import { DashboardSidebar } from '@/layers/features/mesh'; // hypothetical

// Route → sidebar body mapping
function useSidebarBody() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  switch (pathname) {
    case '/':
      return { key: 'dashboard', body: <DashboardSidebar /> };
    default:
      return { key: 'session', body: <AgentSidebar /> };
  }
}

// Inside AppShell render:
const { key, body } = useSidebarBody();

<Sidebar variant="floating">
  {/* Static header — always the same */}
  <SharedSidebarHeader />

  {/* Route-aware body with cross-fade transition */}
  <AnimatePresence mode="wait" initial={false}>
    <motion.div
      key={key}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {body}
    </motion.div>
  </AnimatePresence>

  {/* Static footer — always the same */}
  <SharedSidebarFooter />
</Sidebar>
```

**Pros:**

- Zero flash: sidebar renders the correct content synchronously on navigation
- `AppShell` is the single place that owns the route→sidebar mapping — one file to update when adding routes
- No inter-component knowledge leakage — pages don't know the sidebar exists
- `AnimatePresence` with `key` works cleanly for cross-fade without complex context-cloning
- FSD-compliant: `AppShell` (app-root level) can import from any layer
- Extensible to non-route logic: the hook `useSidebarBody` can read Zustand state, query params, feature flags — not just pathname
- Matches the existing pattern in `AgentSidebar` where route is already checked

**Cons:**

- All possible sidebar body components are imported in `AppShell` — as routes grow, this import list grows. Addressable with `React.lazy()` if needed.
- Route→sidebar mapping is implicit in code rather than declared in route config — acceptable at current scale (2 routes).

**Complexity:** Low
**Maintenance:** Low

---

### Approach 3: Context/Provider Pattern

**Description:** A `SidebarContentContext` is created at `shared` layer. `AppShell` reads from it and renders whatever is registered. Route components call `useSidebarContent` to register their preferred content.

```typescript
// layers/shared/model/sidebar-content-context.ts
const SidebarContentContext = createContext<{
  content: ReactNode;
  setContent: (c: ReactNode) => void;
} | null>(null);

// AppShell wraps everything in the provider
function AppShell() {
  const [content, setContent] = useState<ReactNode>(<AgentSidebar />);
  return (
    <SidebarContentContext.Provider value={{ content, setContent }}>
      {/* ...sidebar uses content... */}
    </SidebarContentContext.Provider>
  );
}

// Route component registers its sidebar content
function DashboardPage() {
  const { setContent } = useSidebarContent();
  useLayoutEffect(() => {
    setContent(<DashboardSidebar />);
    return () => setContent(<AgentSidebar />);
  }, [setContent]);
  return <div>...</div>;
}
```

**Pros:**

- Maximum flexibility — content can be set from anywhere in the tree
- Route components feel "self-contained" — they declare their own sidebar requirements

**Cons:**

- The `useLayoutEffect` pattern still has a potential one-frame flash before the layout effect fires
- Cleanup discipline is essential — if you forget the return function, navigating away leaves the wrong sidebar
- FSD violation risk: `DashboardPage` is at `widgets` layer; `SidebarContentContext` must be in `shared` to be importable from `widgets`. Putting sidebar-specific context in `shared` is an anti-pattern (shared has no feature knowledge).
- The provider-in-shell approach creates circular concerns: the shell renders the sidebar, but the sidebar content is decided by children of the shell. This inverts control in a way that is hard to reason about.
- Adds a new context / indirection that Approach 2 avoids entirely

**Complexity:** Medium
**Maintenance:** Medium (cleanup discipline, context placement)

---

### Approach 4: `useMatch` / `useRouterState` Pattern with Switch in Sidebar

**Description:** The current `AgentSidebar` component reads `useLocation()` and conditionally adjusts its own rendering. For route-aware _structure_ changes (not just logic changes), the sidebar itself uses a router hook to switch which content it renders.

This is nearly identical to Approach 2, except the route-switching logic lives inside `AgentSidebar` rather than `AppShell`.

```typescript
// AgentSidebar.tsx
const pathname = useRouterState({ select: (s) => s.location.pathname });
const isDashboard = pathname === '/';

// Render different SidebarContent based on route
<SidebarContent>
  {isDashboard ? <DashboardView /> : <SessionView />}
</SidebarContent>
```

**Pros:**

- Minimal changes — the sidebar already does this for auto-select logic
- All sidebar logic stays in one file

**Cons:**

- `AgentSidebar` becomes a large switch statement as routes grow — a single file doing too many jobs
- `AgentSidebar` would need to import `DashboardSidebar` content, coupling two feature domains in one component
- FSD: `AgentSidebar` is in `features/session-list` — it should not import mesh/dashboard-specific UI from sibling features' UI

**Complexity:** Very Low (for now)
**Maintenance:** Medium-high (god component grows, feature coupling)

---

### Approach 5: Compound Route Components (sidebar + main exported together)

**Description:** Each route module exports both a `Page` component (main content) and a `SidebarPanel` component. The route definition config includes both. The layout route reads the matched route's `sidebarPanel` and renders it.

```typescript
// router.tsx
const dashboardRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/',
  component: DashboardPage,
  // Custom meta — not a built-in TanStack Router concept
  meta: { sidebarPanel: DashboardSidebarPanel },
});

// AppShell reads the meta
function AppShell() {
  const matches = useMatches();
  const currentMatch = matches.find(m => m.routeId === 'current-leaf');
  const SidebarPanel = (currentMatch?.options as any).meta?.sidebarPanel ?? AgentSidebar;
  return (
    <Sidebar>
      <SidebarPanel />
    </Sidebar>
  );
}
```

**Pros:**

- Route configuration is the single source of truth for both page and sidebar
- Self-documenting — looking at a route definition tells you everything about that view

**Cons:**

- TanStack Router does not have a first-class `meta.sidebarPanel` concept — this requires `as any` casting or non-standard extensions, losing type safety
- The `useMatches` + leaf-match extraction is awkward and fragile
- Overkill for 2 routes; the complexity is only justified for 10+ routes
- Route definitions become larger and harder to read

**Complexity:** Medium-high
**Maintenance:** Medium (custom meta fields need documentation and discipline)

---

## Animation Considerations

### The Correct AnimatePresence Pattern for Sidebar Content

Because the sidebar itself is **not** unmounted on navigation (the `_shell` route persists it), the full `AnimatedOutlet` + router-context-cloning technique used for full-page route transitions is **not needed**. Sidebar content transitions are simpler:

```tsx
// Inside AppShell, wrapping the route-dependent sidebar body only

<AnimatePresence mode="wait" initial={false}>
  <motion.div
    key={sidebarKey} // changes when route changes
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.1, ease: 'easeInOut' }}
    className="flex min-h-0 flex-1 flex-col"
  >
    {sidebarBodyContent}
  </motion.div>
</AnimatePresence>
```

**`mode="wait"`**: Exits the old content fully before entering the new. This prevents both sidebar bodies from being visible simultaneously during the transition — appropriate for a narrow sidebar.

**`initial={false}`**: Skips the enter animation on first mount. On page load, the sidebar should appear instantly; only navigations should animate.

**Key strategy**: Use the route path string as the key (`'dashboard'` vs `'session'`). This is more stable than `location.pathname` directly if future routes share a sidebar body (e.g., two sub-routes under `/session` sharing the session sidebar — both would use key `'session'`).

**Transition duration**: 100-120ms (matching DorkOS's `TIMING.FAST` constants). Sidebar content transitions should be faster than page transitions — they're secondary chrome, not primary content.

**What NOT to animate:**

- The `SidebarHeader` and `SidebarFooter` — these are static and should never animate. Only the body between them cross-fades.
- Width or height changes — these cause layout shifts and are expensive. The sidebar dimensions stay constant.
- Slide animations — sliding left/right in a sidebar is disorienting. Cross-fade is the correct motion.

### Existing `MotionConfig reducedMotion="user"` is Already in AppShell

`AppShell` already wraps everything in `<MotionConfig reducedMotion="user">`, which means the sidebar animation will automatically respect the user's OS "Reduce Motion" preference with zero additional work.

---

## Extensibility: Beyond Route-Based Switching

The `useSidebarBody` hook pattern (Approach 2) is naturally extensible to non-route logic:

```typescript
function useSidebarBody() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const focusMode = useAppStore((s) => s.focusMode);
  const selectedCwd = useAppStore((s) => s.selectedCwd);

  // Future: focus mode shows a minimal sidebar
  if (focusMode) return { key: 'focus', body: <FocusSidebar /> };

  // Route-based switching
  switch (pathname) {
    case '/':
      return { key: 'dashboard', body: <DashboardSidebar /> };
    default:
      return { key: 'session', body: <AgentSidebar /> };
  }
}
```

This keeps the switching logic centralized and easy to test without needing to simulate routes.

---

## Current Architecture: What Changes, What Stays

Based on reading `AppShell.tsx` and `AgentSidebar.tsx`:

**What stays unchanged:**

- `SidebarProvider`, `SidebarInset`, `SidebarTrigger` — all in `AppShell`, unaffected
- `SidebarFooter` content (`SidebarFooterBar`, `ProgressCard`) — always shown
- `SidebarHeader` content (Dashboard button, New Session button) — stays in `AgentSidebar` or promoted to a shared header component
- `SidebarRail` — always present
- All tab-switching logic within `AgentSidebar` (Sessions/Schedules/Connections tabs) — unchanged

**What changes:**

- `AppShell.tsx` gains a `useSidebarBody()` hook and wraps the sidebar body in `AnimatePresence`
- `AppShell.tsx` changes `<AgentSidebar />` inside `<Sidebar>` to `<SharedSidebarHeader />{animatedBody}<SharedSidebarFooter />`
- `AgentSidebar.tsx` is refactored to export only its `SidebarContent` + tab sections (the middle part), with header and footer extracted

**Alternatively** (simpler first step): Keep `AgentSidebar` as a monolith but wrap it in an `AnimatePresence` at the `AppShell` level so that when the route changes and a _different_ sidebar body is shown for the dashboard, the switch is animated. For the near term (only 2 routes, where the dashboard may show the same sidebar), this is a no-op that adds the infrastructure for when different sidebars are needed.

---

## shadcn/ui Sidebar Integration

The shadcn `Sidebar` component accepts children freely — there is no API constraint on what goes inside `SidebarContent`. `AnimatePresence` wrapping inside `SidebarContent` is fully compatible. The `SidebarContent` component is just a `div` with scroll overflow, so wrapping its contents with `motion.div` is straightforward:

```tsx
<Sidebar variant="floating">
  <SidebarHeader>...</SidebarHeader>
  <SidebarContent className="!overflow-hidden">
    {/* AnimatePresence lives here */}
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={sidebarKey} ...>
        {/* Route-specific content */}
      </motion.div>
    </AnimatePresence>
  </SidebarContent>
  <SidebarFooter>...</SidebarFooter>
  <SidebarRail />
</Sidebar>
```

Note `!overflow-hidden` on `SidebarContent` — this is already present in the current code to prevent scroll during tab transitions. It's also needed for `AnimatePresence` exit animations, which briefly render both old and new content simultaneously.

---

## FSD Architecture Compatibility

| Approach                      | FSD Verdict            | Notes                                                              |
| ----------------------------- | ---------------------- | ------------------------------------------------------------------ |
| 1 — Outlet Context            | Acceptable but awkward | Outlet context types must be co-located with shell, not in a layer |
| 2 — Content Map in AppShell   | Fully compliant        | AppShell is app-root, can import from any layer                    |
| 3 — Context/Provider          | Risky                  | Sidebar context in `shared` violates shared's purpose              |
| 4 — Switch in Sidebar         | Acceptable short-term  | Creates god component, feature coupling over time                  |
| 5 — Compound Route Components | Acceptable             | Non-standard meta fields need wrapping type                        |

---

## Security Considerations

- No security implications specific to this pattern. The sidebar displays read-only navigation UI; it does not process user input beyond button clicks.
- Animated components do not create additional attack surface. The `motion.div` wrapper has no event listeners beyond standard React ones.

---

## Performance Considerations

- **`useRouterState` re-renders**: The selector `(s) => s.location.pathname` only triggers re-renders when the pathname changes, not on every router state update (pending, etc.). This is efficient.
- **`AnimatePresence` during transition**: Briefly mounts both old and new sidebar content during the exit animation (~100ms). The DOM impact is negligible — sidebar content is lightweight compared to the chat panel.
- **No lazy loading needed at current scale**: With 2 routes, both sidebar body components can be eagerly imported. If routes grow to 10+, `React.lazy()` on the non-default sidebar bodies would be worthwhile.
- **CSS `!overflow-hidden`** on `SidebarContent` during transition prevents layout reflow from animated opacity changes.

---

## Comparison Table

| Criterion                | Approach 1 (Outlet Context) | Approach 2 (Content Map) | Approach 3 (Provider) | Approach 4 (Switch in Sidebar) | Approach 5 (Compound Routes) |
| ------------------------ | --------------------------- | ------------------------ | --------------------- | ------------------------------ | ---------------------------- |
| Simplicity               | Medium                      | **High**                 | Medium                | **Very High**                  | Low                          |
| Type Safety              | Medium                      | **High**                 | Medium                | High                           | Low (meta field)             |
| Animation Friendly       | Low (flash risk)            | **High**                 | Low (flash risk)      | High                           | Medium                       |
| FSD Compatible           | Acceptable                  | **Fully**                | Risky                 | Acceptable                     | Acceptable                   |
| Extensible Beyond Routes | Low                         | **High**                 | High                  | Low                            | Low                          |
| shadcn/ui Integration    | Neutral                     | **Clean**                | Neutral               | Clean                          | Neutral                      |
| Maintenance              | Medium-high                 | **Low**                  | Medium                | Medium-high                    | Medium                       |

---

## Recommendation

**Recommended Approach: Approach 2 — Route-Based Content Map in AppShell**

**Implementation plan:**

1. Add a `useSidebarBody()` hook inside `AppShell.tsx` (or as a private helper within the file):

```typescript
function useSidebarBody(): { key: string; body: ReactNode } {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  switch (pathname) {
    case '/':
      // Dashboard: for now, same AgentSidebar (future: DashboardSidebar)
      return { key: 'session', body: <AgentSidebar /> };
    default:
      return { key: 'session', body: <AgentSidebar /> };
  }
}
```

Start with both routes returning the same content and key — this establishes the infrastructure without visible change. When a distinct dashboard sidebar is designed, flip the `'/'` case.

2. Wrap the sidebar body in `AnimatePresence` in `AppShell.tsx`:

```tsx
const { key: sidebarBodyKey, body: sidebarBody } = useSidebarBody();

<Sidebar variant="floating">
  <AnimatePresence mode="wait" initial={false}>
    <motion.div
      key={sidebarBodyKey}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.1 }}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {sidebarBody}
    </motion.div>
  </AnimatePresence>
</Sidebar>;
```

3. When a dedicated dashboard sidebar is created, add `DashboardSidebar` as the component for the `'/'` case and give it a distinct key (`'dashboard'`).

**Caveats:**

- The existing `AgentSidebar` renders its own `SidebarHeader` and `SidebarFooter`. If these should be _static_ (not animating on route changes), refactor `AgentSidebar` to export only its content section, and move header/footer up to `AppShell`. This is the cleaner long-term structure. For the near-term, wrapping the entire `<AgentSidebar>` in the animated div is acceptable because both routes use the same sidebar (same key, no animation triggered).
- TanStack Router's `useRouterState` is called inside `AppShell` which is the `_shell` layout route's component — this is inside `<RouterProvider>` and works correctly.

---

## Research Gaps & Limitations

- The `AnimatedOutlet` context-cloning pattern (for full page route transitions) was investigated but is specifically relevant to page-level transitions, not sidebar-level transitions. The simpler `AnimatePresence` + key pattern is sufficient for sidebar content.
- The exact moment TanStack Router's `useRouterState` updates (before or after paint) was not tested in this codebase. If there is a one-frame flash with Approach 2, wrapping the `useSidebarBody` call in a `useTransition` (React 19) deferral may help.
- React `<Activity>` component (React 19.2) was investigated for tab state preservation in the sidebar (see `research/20260310_sidebar_tabbed_views_ux.md`) but is not directly applicable here — the existing CSS `hidden` pattern already handles tab state.

---

## Sources & Evidence

- [TanStack Router: How to Integrate Framer Motion](https://tanstack.com/router/latest/docs/framework/react/how-to/integrate-framer-motion) — official guide
- [Page Transitions/Animations Using Framer Motion · TanStack/router Discussion #823](https://github.com/TanStack/router/discussions/823) — `AnimatedOutlet` + context-cloning pattern for full-page transitions
- [Compatibility with Framer Motion? · TanStack/router Discussion #576](https://github.com/TanStack/router/discussions/576) — early compatibility confirmation
- [Framer Motion example skips exit animations · Issue #2635](https://github.com/TanStack/router/issues/2635) — known exit animation issue, keying workaround
- [Animating URL-Based Modals in TanStack Router](https://klapacz.dev/blog/0003-tanstack-router-animated-modals/) — `useRouterState` for animation keying
- [TanStack Router Code-Based API Patterns](research/20260320_tanstack_router_code_patterns.md) — internal, pathless layout route patterns
- [Dashboard Route Navigation Architecture](research/20260320_dashboard_route_navigation_architecture.md) — internal, route structure for DorkOS
- [Shadcn Sidebar Redesign Research](research/20260303_shadcn_sidebar_redesign.md) — internal, SidebarContent slot structure
- [Sidebar Tabbed Views UX Research](research/20260310_sidebar_tabbed_views_ux.md) — internal, CSS `hidden` tab persistence pattern
- [ADR-0157: Use Pathless Layout Route for Shared App Shell](decisions/0157-pathless-layout-route-for-app-shell.md) — internal
- [React TanStack Router With Framer Motion Example (StackBlitz)](https://stackblitz.com/github/tanstack/router/tree/main/examples/react/with-framer-motion)

---

## Search Methodology

- Searches performed: 5
- Most productive terms: "TanStack Router route-aware sidebar AnimatePresence content transition 2025", "TanStack Router framer motion AnimatePresence useRouterState location.key sidebar"
- Relied heavily on existing internal research (`research/20260320_tanstack_router_code_patterns.md`, `research/20260303_shadcn_sidebar_redesign.md`, `research/20260310_sidebar_tabbed_views_ux.md`) which already covered the foundational patterns
- New external research focused specifically on AnimatePresence + TanStack Router transition patterns
