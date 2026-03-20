---
slug: dynamic-sidebar-content
number: 156
created: 2026-03-20
status: ideation
---

# Dynamic Route-Aware Sidebar & Header Content

**Slug:** dynamic-sidebar-content
**Author:** Claude Code
**Date:** 2026-03-20
**Branch:** preflight/dynamic-sidebar-content

---

## 1) Intent & Assumptions

- **Task brief:** Build a flexible system for route-aware sidebar and header content. The sidebar and header should show different content based on the current route (dashboard at `/` vs session at `/session`). The sidebar footer stays constant across all routes. Animated transitions smooth the switch between content variants. The system should be extensible beyond routes (context-based switching too).
- **Assumptions:**
  - Builds on spec 154 (dashboard-home-route) which established TanStack Router with `/` and `/session` routes and the pathless `_shell` layout route (AppShell)
  - The shadcn sidebar structure (`SidebarHeader`, `SidebarContent`, `SidebarFooter`) is preserved — only the body/content region becomes dynamic
  - The existing `AgentSidebar` component continues to own all session-route sidebar logic
  - Motion.dev (framer-motion fork) is the animation library for transitions
  - Embedded mode (Obsidian) is unaffected — no router, no dynamic switching
- **Out of scope:**
  - Full dashboard sidebar content design (placeholder only — follow-up spec)
  - Full dashboard header content design (placeholder only)
  - Mobile-specific sidebar layouts
  - Server-side changes or new API endpoints
  - Dev playground sidebar changes

## 2) Pre-reading Log

- `contributing/architecture.md`: Hexagonal architecture, Transport abstraction, SDK containment boundary
- `contributing/design-system.md`: Calm Tech philosophy, sidebar specs (320px CSS vars, tabbed views), animation timing (150-300ms), spring presets (sidebar active indicator: 280/32)
- `contributing/animations.md`: Motion.dev patterns, AnimatePresence for exits, spring presets for chat (320/28), `<MotionConfig reducedMotion="user">` wraps AppShell
- `contributing/project-structure.md`: FSD layer hierarchy, TanStack Router route structure, pathless layout route pattern
- `decisions/0157-pathless-layout-route-for-app-shell.md`: AppShell as id-based layout route, `<Outlet>` for child routes, sidebar/header/dialogs persist across route changes
- `specs/dashboard-home-route/02-specification.md`: Full routing spec — `/` (DashboardPage), `/session` (SessionPage), nuqs removed, TanStack Router search params
- `apps/client/src/AppShell.tsx`: Standalone app shell — renders SidebarProvider > Sidebar > AgentSidebar, header with AgentIdentityChip, `<Outlet>` for main content, DialogHost, CommandPaletteDialog, ShortcutsPanel, Toaster
- `apps/client/src/router.tsx`: Route definitions — rootRoute, appShellRoute (pathless `_shell`), indexRoute (`/`), sessionRoute (`/session`)
- `apps/client/src/layers/features/session-list/ui/AgentSidebar.tsx`: Primary sidebar content (~275 lines) — header (Dashboard link + New Session), SidebarTabRow, tab panels (SessionsView, SchedulesView, ConnectionsView), SidebarFooter with SidebarFooterBar
- `apps/client/src/layers/features/session-list/ui/SidebarFooterBar.tsx`: Footer with branding, theme cycle, settings, devtools toggle — route-agnostic
- `apps/client/src/layers/features/session-list/ui/SidebarTabRow.tsx`: Horizontal tab bar with sliding indicator (motion layoutId spring)
- `apps/client/src/layers/features/top-nav/ui/AgentIdentityChip.tsx`: Header agent name/emoji chip
- `apps/client/src/layers/shared/ui/sidebar.tsx`: Shadcn sidebar primitive — SidebarProvider, Sidebar, SidebarHeader, SidebarContent, SidebarFooter, SidebarMenu, SidebarRail
- `apps/client/src/layers/shared/model/app-store.ts`: Zustand store — `sidebarOpen`, `sidebarActiveTab`, `selectedCwd`, etc.

## 3) Codebase Map

**Primary Components/Modules:**

| Component             | Path                                                                   | Role                                                      |
| --------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| AppShell              | `apps/client/src/AppShell.tsx`                                         | Layout route component — sidebar, header, Outlet, dialogs |
| AgentSidebar          | `apps/client/src/layers/features/session-list/ui/AgentSidebar.tsx`     | Session-route sidebar: header, tabs, tab panels, footer   |
| SidebarFooterBar      | `apps/client/src/layers/features/session-list/ui/SidebarFooterBar.tsx` | Shared footer: branding, theme, settings                  |
| SidebarTabRow         | `apps/client/src/layers/features/session-list/ui/SidebarTabRow.tsx`    | Tab bar with sliding indicator                            |
| AgentIdentityChip     | `apps/client/src/layers/features/top-nav/ui/AgentIdentityChip.tsx`     | Header agent identity display                             |
| CommandPaletteTrigger | `apps/client/src/layers/features/top-nav/ui/CommandPaletteTrigger.tsx` | Header Cmd+K button                                       |
| DashboardPage         | `apps/client/src/layers/widgets/dashboard/ui/DashboardPage.tsx`        | Placeholder dashboard view                                |
| SessionPage           | `apps/client/src/layers/widgets/session/ui/SessionPage.tsx`            | Chat wrapper at `/session`                                |
| Router                | `apps/client/src/router.tsx`                                           | TanStack Router route tree                                |

**Shared Dependencies:**

| Dependency          | Usage                                                                  |
| ------------------- | ---------------------------------------------------------------------- |
| Zustand (app-store) | `sidebarOpen`, `sidebarActiveTab`, `selectedCwd`                       |
| TanStack Router     | `useRouterState`, `useLocation`, `useNavigate`                         |
| Motion.dev          | AnimatePresence, motion.div for transitions                            |
| Shadcn Sidebar      | SidebarProvider, Sidebar, SidebarContent, SidebarHeader, SidebarFooter |

**Data Flow:**

```
AppShell (pathless _shell layout route)
  ├── Header: SidebarTrigger + [route-dependent header content]
  ├── SidebarProvider
  │    └── Sidebar
  │         ├── [route-dependent sidebar body — AnimatePresence cross-fade]
  │         │    ├── Dashboard route: DashboardSidebar (placeholder)
  │         │    └── Session route: AgentSidebar (current behavior)
  │         └── SidebarFooter: SidebarFooterBar (always rendered, static)
  ├── Main: <Outlet /> (DashboardPage or SessionPage)
  └── Overlays: DialogHost, CommandPaletteDialog, ShortcutsPanel, Toaster
```

**Feature Flags/Config:**

| Flag                                       | Impact                                                |
| ------------------------------------------ | ----------------------------------------------------- |
| `pulseToolEnabled`                         | Controls SchedulesView tab visibility in AgentSidebar |
| Embedded mode (`getPlatform().isEmbedded`) | Bypasses router entirely — no dynamic switching       |

**Potential Blast Radius:**

- **Direct changes:** AppShell.tsx (sidebar + header switching), AgentSidebar.tsx (extract footer to shell level)
- **New files:** DashboardSidebar component, DashboardHeader component (both placeholders)
- **Indirect:** SidebarFooterBar rendering location moves from inside AgentSidebar to AppShell
- **Tests:** AppShell tests (if any), AgentSidebar tests (footer extraction), new tests for switching logic
- **No changes needed:** Router.tsx, SessionPage, DashboardPage, SidebarTabRow, individual tab views

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

## 5) Research

Research report saved to: `research/20260320_route_aware_sidebar_patterns.md`

**Five approaches evaluated:**

**1. Outlet Context (Route-Provided Sidebar)**

- Description: Each route provides sidebar content via TanStack Router's Outlet context; AppShell reads and renders it
- Pros: Routes own their sidebar, co-located
- Cons: Flash risk on render (context not available until route mounts), cleanup discipline, FSD knowledge leak from widgets into shell
- Complexity: Medium | Maintenance: Medium

**2. Content Map / Switch Hook in AppShell (Recommended)**

- Description: A private `useSidebarBody()` hook in AppShell reads `useRouterState` pathname and returns the matching sidebar component via a switch statement
- Pros: Synchronous render (no flash), single place to update, FSD-compliant (AppShell is app-level orchestration), naturally extensible (can read Zustand, feature flags, query params alongside route), trivial AnimatePresence integration
- Cons: AppShell needs to import all sidebar variants (mitigated by lazy loading for future heavy sidebars)
- Complexity: Low | Maintenance: Low

**3. Context/Provider Pattern (SidebarContentProvider)**

- Description: A provider wraps the app; route components call `setSidebarContent()` on mount
- Pros: Decoupled from router
- Cons: Flash risk (sidebar empty until route mounts and calls setter), provider in shared layer is anti-pattern, extra React context
- Complexity: Medium | Maintenance: Medium

**4. Switch Inside AgentSidebar**

- Description: AgentSidebar reads the route and conditionally renders different content
- Pros: Minimal structural change, already partially done (auto-select skips dashboard)
- Cons: Creates a god component, cross-feature coupling grows as routes grow, violates single responsibility
- Complexity: Low | Maintenance: High (long-term)

**5. Compound Route Components (sidebar + main exported together)**

- Description: Each route module exports both a page component and a sidebar component; router config references both via `staticData` or `meta`
- Pros: Strong co-location
- Cons: Requires `as any` on TanStack Router meta fields (not typed for ReactNode), overkill for 2 routes
- Complexity: High | Maintenance: Medium

**Animation research findings:**

- TanStack Router's AnimatedOutlet pattern (clone router context during exit) is needed for **main content** route transitions but is **NOT needed for sidebar** — the sidebar persists across routes (pathless layout route)
- A simple `AnimatePresence` + `key` cross-fade at 100ms is correct and sufficient for sidebar content switching
- The existing `<MotionConfig reducedMotion="user">` in AppShell handles accessibility automatically
- Spring presets not needed for cross-fade — linear opacity transition is more appropriate

**Recommendation:** Approach 2 — Content Map / Switch Hook. It's the simplest, most FSD-compliant, and most extensible. The hook is private to AppShell, the AnimatePresence wrapper is trivial, and adding new route-based or context-based sidebars is a one-line addition to the switch.

## 6) Decisions

| #   | Decision                  | Choice                                          | Rationale                                                                                                                                                                        |
| --- | ------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Dashboard sidebar content | Minimal placeholder                             | Keeps this spec focused on the dynamic switching system. Full dashboard sidebar is a follow-up. Just a branded header + navigation.                                              |
| 2   | Header changes per route  | Same dynamic system                             | Apply the same route-aware switch pattern to the header. Dashboard shows title/breadcrumb, session keeps AgentIdentityChip + CommandPaletteTrigger.                              |
| 3   | Animation style           | Quick cross-fade (100ms)                        | Subtle, fast, consistent with Calm Tech. Research confirms AnimatePresence + key cross-fade is cleanest for persistent sidebar shells. No complex router context cloning needed. |
| 4   | Implementation approach   | Content Map / Switch Hook                       | Recommended by research. Synchronous render, no flash, single update point, FSD-compliant, extensible to non-route contexts.                                                     |
| 5   | Footer handling           | Static in AppShell, extracted from AgentSidebar | SidebarFooterBar moves from inside AgentSidebar to AppShell — rendered once, outside the AnimatePresence, so it never animates on route change.                                  |
