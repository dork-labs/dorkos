---
slug: dashboard-home-route
number: 154
created: 2026-03-20
status: ideation
---

# Dashboard Home Route & Navigation Restructure

**Slug:** dashboard-home-route
**Author:** Claude Code
**Date:** 2026-03-20
**Branch:** preflight/dashboard-home-route

---

## 1) Intent & Assumptions

- **Task brief:** Move the agent chat from `/` to `/session` and create a new dashboard at `/`. This introduces client-side routing (TanStack Router), replaces `nuqs` with TanStack Router's built-in search params, and restructures the app from a single-view SPA to a multi-view layout with shared sidebar/header shell.
- **Assumptions:**
  - The dashboard will be a calm, status-board-style "mission control" — not an analytics page or activity feed
  - First implementation is a **routing placeholder** — get the route structure right with a minimal dashboard page; full dashboard content is a follow-up spec
  - The embedded (Obsidian) mode is **not affected** — it continues rendering `<ChatPanel>` directly with no router
  - All existing session deep links (`?session=abc123&dir=/path`) continue to work at the new `/session` route
  - The sidebar, header, `DialogHost`, `CommandPaletteDialog`, and `Toaster` are shared across all routes
- **Out of scope:**
  - Full dashboard content/design (follow-up spec)
  - Server-side changes (API endpoints)
  - New data endpoints for dashboard aggregation
  - Wing/Loop integration
  - Mobile-specific dashboard layout

## 2) Pre-reading Log

- `apps/client/src/main.tsx`: Vite entry point. Uses `window.location.pathname.startsWith('/dev')` for dev playground routing. No general router. Wraps app in `NuqsAdapter`, `QueryClientProvider`, `TransportProvider`.
- `apps/client/src/App.tsx`: Root shell (268 lines). Two modes: embedded (overlay sidebar + ChatPanel) and standalone (SidebarProvider + header + ChatPanel). ChatPanel is hardcoded in `<main>` at lines 176 and 252. No route-based view switching.
- `apps/client/src/layers/features/session-list/ui/AgentSidebar.tsx`: Sidebar with three tabs (Sessions, Schedules, Connections). Session items set `activeSessionId` via nuqs.
- `apps/client/src/layers/entities/session/model/use-sessions.ts`: Session list hook using TanStack Query.
- `apps/client/src/layers/entities/session/model/use-session-status.ts`: Real-time session status via SSE.
- `apps/client/src/layers/shared/model/app-store.ts`: Zustand store for UI state (sidebar, dialogs, streaming indicators, preferences).
- `apps/client/src/dev/DevPlayground.tsx`: Dev playground uses pathname-based routing via `window.location.pathname` — reference pattern for simple routing.
- `contributing/project-structure.md`: FSD layer conventions, segment structure.
- `contributing/state-management.md`: Zustand vs TanStack Query decision guide.
- `.claude/rules/fsd-layers.md`: Layer import rules.
- `meta/dorkos-litepaper.md`: Console is described as "browser-based command center" — dashboard aligns with this vision.
- `meta/value-architecture-applied.md`: VL-03 (Multi-Session Command Center) explicitly calls for "glance at your browser tabs and instantly know: which agents are working, which are done, and which need your attention."
- `meta/personas/the-autonomous-builder.md`: Kai wants at-a-glance status of his agent team across 5 projects. "Mission control" mental model.
- `meta/personas/the-knowledge-architect.md`: Priya values quick orientation so she can dive into the right context fast.

## 3) Codebase Map

**Primary components/modules:**

- `apps/client/src/main.tsx` — Entry point, provider tree (NuqsAdapter, QueryClient, Transport)
- `apps/client/src/App.tsx` — Root shell with embedded/standalone modes, hardcoded ChatPanel
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — Main chat interface (will become route content)
- `apps/client/src/layers/features/session-list/ui/AgentSidebar.tsx` — Sidebar with session navigation
- `apps/client/src/layers/features/session-list/ui/SessionItem.tsx` — Individual session in sidebar (click handler sets nuqs param)
- `apps/client/src/layers/widgets/app-layout/ui/DialogHost.tsx` — Dialog manager (shared across routes)
- `apps/client/src/layers/features/command-palette/ui/CommandPaletteDialog.tsx` — Global Cmd+K
- `apps/client/src/layers/features/top-nav/ui/AgentIdentityChip.tsx` — Header agent chip
- `apps/client/src/layers/features/top-nav/ui/CommandPaletteTrigger.tsx` — Header palette trigger

**Shared dependencies (nuqs — to be replaced):**

- `apps/client/src/layers/entities/session/model/use-session-id.ts` — `useSessionId()` reads/writes `?session=` via nuqs
- `apps/client/src/layers/entities/session/model/use-directory-state.ts` — `useDirectoryState()` reads/writes `?dir=` via nuqs
- All components consuming these hooks (ChatPanel, AgentSidebar, SessionItem, AgentIdentityChip, StatusLine items, etc.)

**Data flow:**
URL params (`?session=`, `?dir=`) → nuqs hooks → TanStack Query (fetch session data) → React components

**Feature flags/config:** None directly affected.

**Potential blast radius:**

- Direct: `main.tsx`, `App.tsx`, nuqs hooks (`useSessionId`, `useDirectoryState`), all call sites
- Indirect: Any component importing from `@/layers/entities/session` that uses session ID or directory state
- Tests: All tests that mock nuqs or test URL param behavior
- Dev playground: Currently uses `window.location.pathname` — may need integration with TanStack Router or explicit exclusion

## 4) Root Cause Analysis

N/A — not a bug fix.

## 5) Research

Full research reports saved to:

- `research/20260320_dashboard_route_navigation_architecture.md` — Dashboard design patterns, route naming, content analysis, navigation architecture
- `research/20260320_tanstack_router_vs_react_router_v7.md` — Router comparison, nuqs compatibility, bundle analysis

### Potential Solutions

**1. TanStack Router + replace nuqs (SELECTED)**

- Description: Add `@tanstack/react-router` with Vite plugin. Replace nuqs entirely with TanStack Router's built-in `validateSearch` + `Route.useSearch()` for URL search params. Layout route at `/` with `<Outlet>`, child routes for dashboard and session.
- Pros:
  - Type-safe routes and search params — Zod schemas colocated with routes
  - Tighter TanStack ecosystem cohesion (already using Query + Virtual)
  - Eliminates nuqs dependency entirely — one fewer library
  - Search param schemas are the single source of truth (no drift between nuqs parsers and route expectations)
  - First-class TanStack Query loader integration available if needed later
- Cons:
  - Larger bundle (~45KB vs ~20KB for React Router)
  - Requires rewriting `useSessionId`, `useDirectoryState`, and all call sites
  - Learning curve for TanStack Router-specific patterns (file-based routes, search param validation)
  - Newer library with smaller ecosystem than React Router
- Complexity: Medium-High
- Maintenance: Low (once migrated, simpler than nuqs + separate router)

**2. React Router v7 + keep nuqs**

- Description: Add `react-router-dom` v7. Use `nuqs/adapters/react-router/v7`. Zero migration of existing hooks.
- Pros:
  - Zero migration risk — nuqs adapter is stable and first-class
  - Smaller bundle (~20KB)
  - Mature ecosystem, familiar to most React devs
- Cons:
  - Two URL state systems (React Router for path, nuqs for params)
  - No type-safe routes
  - nuqs remains an extra dependency
- Complexity: Low
- Maintenance: Medium (two systems to maintain)

**3. nuqs `?page=` parameter (no router library)**

- Description: Add a `?page=dashboard|session` nuqs param. Conditionally render DashboardPanel or ChatPanel.
- Pros: Simplest change, no new dependency
- Cons: No browser history, ugly URLs, not scalable, not bookmarkable
- Complexity: Very Low
- Maintenance: High (will need to be replaced with a real router eventually)

### Recommendation

**TanStack Router + replace nuqs.** The upfront cost is higher but the result is architecturally cleaner: one library for routing and URL state, type-safe throughout, and tighter ecosystem alignment. The nuqs replacement is bounded work (~half day) and eliminates a dependency.

## 6) Decisions

| #   | Decision             | Choice                                               | Rationale                                                                                                                                                                                    |
| --- | -------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Chat route path      | `/session`                                           | Matches internal model exactly (GET /api/sessions, useSessionId). Existing deep links work unchanged at new path. No collision with Relay's messaging concept.                               |
| 2   | Dashboard purpose    | Status board — calm mission control                  | Surfaces agent health, active sessions, actionable exceptions. Follows Vercel/Linear pattern. Feels calm when healthy, alerts when it isn't. Aligns with VL-03 value ladder and Kai persona. |
| 3   | Router library       | TanStack Router + replace nuqs                       | Type-safe routes and search params. Tighter TanStack ecosystem cohesion (already using Query + Virtual). Eliminates nuqs dependency. Search param schemas colocated with routes.             |
| 4   | Implementation scope | Placeholder — routing first, dashboard content later | Get the route structure, nuqs migration, and navigation wiring right. Dashboard page is a minimal welcome/status placeholder. Full dashboard content is a follow-up spec.                    |

### URL Structure

```
/                           → Dashboard (placeholder initially)
/session                    → New session prompt (no session selected)
/session?session=abc123     → Specific session (deep link)
/session?dir=/path/to/proj  → Session with directory context
/dev/*                      → Dev playground (existing, unchanged)
```

### Architecture Sketch

```
main.tsx
├── TanStack RouterProvider
│   └── Layout Route (AppShell)
│       ├── / → DashboardPage (placeholder)
│       └── /session → SessionPage (wraps ChatPanel)
│
├── Embedded mode branch (no router, unchanged)
│   └── App({ embedded: true }) → ChatPanel directly
```

### Key Migration Points

1. **Replace `nuqs`** — Rewrite `useSessionId()` and `useDirectoryState()` to use `Route.useSearch()` from TanStack Router
2. **Session navigation** — Sidebar session click handlers change from `setSessionId(id)` to `navigate({ to: '/session', search: { session: id, dir } })`
3. **Command palette** — "Open session" actions navigate to `/session?session=id`
4. **Dev playground** — Currently uses `window.location.pathname` — needs integration with or explicit exclusion from TanStack Router
5. **FSD placement** — `DashboardPage` at `layers/widgets/dashboard/`, `SessionPage` thin wrapper at `layers/widgets/session/` or app root

### Dashboard Content (Follow-Up Spec)

When the full dashboard is designed, it should follow this signal hierarchy:

**Tier 1 — Needs Attention** (shown only when non-empty):

- Pending tool approvals across active sessions
- Sessions stalled in `waiting` state for >30 minutes
- Dead letters in Relay
- Failed Pulse runs

**Tier 2 — Active Now:**

- Currently streaming sessions (agent name, activity, elapsed time)
- Running Pulse jobs
- Relay adapter health (status dots)
- Mesh agent count

**Tier 3 — System Status + Recent:**

- Sessions completed in last 24 hours
- Next scheduled Pulse run
- System version / server health

**Do NOT put on dashboard:** Full transcripts, config forms, topology graph, token usage, trend charts, message logs, cron editor.
