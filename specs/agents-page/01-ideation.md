---
slug: agents-page
number: 157
created: 2026-03-20
status: ideation
---

# Agents Page — Dedicated Fleet Management at /agents

**Slug:** agents-page
**Author:** Claude Code
**Date:** 2026-03-20
**Branch:** preflight/agents-page

---

## 1) Intent & Assumptions

- **Task brief:** Add an "Agents" link to the DashboardSidebar navigating to a new `/agents` route. This page becomes the primary agent fleet management surface — listing registered agents with details, search/filter, discovery scanning (in a dialog), topology toggle (as a tab), and the ability to start or resume agent sessions. The MeshPanel dialog's Agents tab is removed; Mesh becomes focused on Topology, Discovery, and Access control.

- **Assumptions:**
  - Reuses existing `entities/mesh` TanStack Query hooks (`useRegisteredAgents`, `useTopology`, etc.) — no new API endpoints needed
  - All required server endpoints already exist (`/api/mesh/agents`, `/api/discovery/scan`, `/api/agents/resolve`)
  - The route-aware sidebar/header slot pattern (from `dynamic-sidebar-content` spec) is in place and working
  - The `/agents` route reuses `DashboardSidebar` with "Agents" highlighted as the active item
  - Agent count is in the 5–50 range for typical users (Kai runs 10–20 across 5 projects)
  - The page uses a dense list with expandable rows (not cards or table) per research findings

- **Out of scope:**
  - Agent creation/editing forms (existing `AgentDialog` handles this)
  - Relay binding configuration from the agents page
  - New API endpoints — reuse existing mesh/agent/discovery routes
  - Bulk agent operations (multi-select, batch unregister)
  - Agent performance metrics or token usage tracking
  - Mobile-specific layout (responsive but not mobile-first)

## 2) Pre-reading Log

- `contributing/architecture.md`: Hexagonal Transport architecture; router context with QueryClient; AppShell slot pattern
- `contributing/project-structure.md`: FSD layer organization; widget → feature → entity → shared hierarchy
- `decisions/0154-adopt-tanstack-router-for-client-routing.md`: TanStack Router with code-based routes; pathless `_shell` layout; Zod search params
- `.claude/rules/fsd-layers.md`: Unidirectional imports enforced by ESLint; cross-feature UI composition allowed, cross-feature hooks forbidden
- `.claude/rules/agent-storage.md`: File-first write-through (ADR-0043); `.dork/agent.json` is canonical source
- `meta/personas/the-autonomous-builder.md`: Kai — senior dev, 10-20 sessions/week across 5 projects, wants fleet oversight
- `meta/archive/personas/the-knowledge-architect.md`: Priya — staff architect, flow preservation is key, reads source code
- `apps/client/src/router.tsx`: Current routes: `/` (DashboardPage), `/session` (SessionPage), pathless `_shell` layout
- `apps/client/src/AppShell.tsx`: Slot hooks dispatch on pathname for sidebar/header; AnimatePresence cross-fade
- `apps/client/src/layers/features/dashboard-sidebar/ui/DashboardSidebar.tsx`: Menu items: Dashboard, Sessions; "Agent overview coming soon" placeholder
- `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx`: 5 tabs (Topology, Discovery, Agents, Denied, Access); Mode A/B pattern; 314 lines
- `apps/client/src/layers/features/mesh/ui/AgentCard.tsx`: Agent name, runtime badge, capabilities, unregister button
- `apps/client/src/layers/features/mesh/ui/DiscoveryView.tsx`: Scan roots, depth control, candidate registration
- `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx`: React Flow graph, lazy-loaded with Suspense
- `apps/client/src/layers/features/mesh/ui/MeshEmptyState.tsx`: Reusable empty state component (icon, headline, description, action)
- `apps/client/src/layers/entities/mesh/index.ts`: Exported hooks — useRegisteredAgents, useTopology, useMeshStatus, useRegisterAgent, useUnregisterAgent, useMeshAgentHealth, etc.
- `apps/client/src/layers/entities/discovery/index.ts`: useDiscoveryStore (Zustand), useDiscoveryScan, CandidateCard
- `apps/client/src/layers/entities/session/model/use-session-id.ts`: Dual-mode navigation — standalone uses `navigate({ to: '/session', search: { session: id } })`
- `apps/server/src/routes/agents.ts`: GET /api/mesh/agents, POST /api/agents, PATCH /api/agents/current
- `apps/server/src/routes/mesh.ts`: POST /api/discovery/scan (SSE streaming), POST /api/mesh/topology
- `research/20260226_agents_first_class_entity.md`: Recommends agents as first-class session context; dedicated navigation
- `research/20260225_mesh_panel_ux_overhaul.md`: Empty state = onboarding moment; Mode A/B pattern
- `research/20260320_agents_page_ux_patterns.md`: Dense list layout, tab-based topology, instant inline filtering, direct session launch

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx` — Current agent management hub (dialog-based); Agents tab to be removed
  - `apps/client/src/layers/features/mesh/ui/AgentCard.tsx` — Agent display component (needs enhancement for list row)
  - `apps/client/src/layers/features/mesh/ui/DiscoveryView.tsx` — Discovery scanner UI (reuse in dialog)
  - `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx` — Lazy-loaded graph (reuse as tab)
  - `apps/client/src/layers/features/mesh/ui/MeshEmptyState.tsx` — Reusable empty state
  - `apps/client/src/layers/features/mesh/ui/MeshStatsHeader.tsx` — Stats summary strip
  - `apps/client/src/layers/features/dashboard-sidebar/ui/DashboardSidebar.tsx` — Sidebar to add "Agents" link
  - `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx` — Full agent settings modal
  - `apps/client/src/AppShell.tsx` — Slot hooks to update for `/agents` route
  - `apps/client/src/router.tsx` — Route tree to add `/agents`

- **Shared dependencies:**
  - `layers/shared/ui/` — Shadcn primitives (Button, Badge, Tabs, Input, Collapsible, ScrollArea)
  - `layers/shared/lib/transport/` — HttpTransport for API calls
  - `motion/react` — AnimatePresence, motion.div for transitions
  - TanStack Router — `createRoute`, `useNavigate`, `useRouterState`
  - TanStack Query — via entity hooks

- **Data flow:**
  - DashboardSidebar click → `navigate({ to: '/agents' })` → AppShell slot renders DashboardSidebar + AgentsHeader
  - AgentsPage → `useRegisteredAgents()` → renders dense list
  - "Scan for Agents" → opens DiscoveryDialog → `useDiscoveryScan()` → register candidates → refetch agents
  - "Start Session" → session picker popover → `navigate({ to: '/session', search: { session, dir } })`
  - Topology tab → lazy-loads `TopologyGraph` component

- **Feature flags/config:** None needed — agents always available when mesh is enabled

- **Potential blast radius:**
  - Direct: ~8 files (new page, new route, sidebar update, AppShell slot, MeshPanel Agents tab removal)
  - Indirect: MeshPanel tests (remove Agents tab tests), DashboardSidebar tests (add Agents link)
  - E2E: May need to update mesh test fixtures if they depend on Agents tab

## 5) Research

### Potential Solutions

**1. Dense List with Expandable Rows (Recommended)**

- Vertical list of agent rows (~56px collapsed, ~120px expanded). Each row: health dot + name + runtime badge + project path + session count + capability badges (max 3) + last-active timestamp + "Start Session" button. Chevron expand reveals full details.
- Pros: Fast vertical scan, progressive disclosure, graceful at any width, used by Linear/GitHub/Vercel/Railway
- Cons: Slightly less visual differentiation than cards (mitigated by health dot color)
- Complexity: Low
- Maintenance: Low

**2. Card Grid**

- 2–3 columns of cards, each ~180px tall with agent info and actions
- Pros: Visual differentiation, natural for mouse interaction
- Cons: Wastes vertical space, poor scan speed for named items, breaks at narrow widths
- Complexity: Medium
- Maintenance: Medium

**3. Data Table**

- Full sortable/filterable table with columns: Name, Status, Runtime, Project, Last Active, Sessions, Actions
- Pros: Maximum information density, column-level comparison
- Cons: Overkill for 5–50 items, no progressive disclosure, high implementation complexity
- Complexity: High
- Maintenance: High

### Topology Integration

**Tab within the page (Recommended):** Two tabs — "Agents" (list) and "Topology" (graph). Consistent with existing MeshPanel architecture. Full viewport per view. State persists across tab switches. Used by Headlamp (Kubernetes), Kiali, Datadog.

**Split pane:** Both views compete for viewport. Neither has enough space. Topology needs full width to be useful.

**Overlay/modal:** Breaks flow, Calm Tech principle rejects modals for persistent navigational views.

### Filter UX

**Instant inline filter (Recommended):** Text input for instant name/description filter + status chips (Active/Inactive/Stale) + namespace dropdown (conditional on >1 namespace). All client-side, zero API calls at this scale.

### Session Launch

**Active session popover (Recommended):** When agent has active sessions, clicking "Start Session" shows a small popover listing active sessions with "Resume" links plus a "New Session" button. When no active sessions, directly navigates to `/session?dir={agent.projectPath}`.

### Agent Row Information Hierarchy

**Always visible (collapsed row):**

- Agent name + health/status dot (green=active, amber=inactive, gray=stale)
- Runtime badge (claude-code)
- Project path (truncated)
- Active sessions count (if > 0)
- Capabilities (top 2-3 badges, "+N more" for overflow)
- Last active timestamp (relative: "2m ago", "1h ago", "Mar 15")
- "Start Session" button

**On expansion:**

- Full description
- All capabilities
- Behavior config (response mode, escalation threshold)
- Budget limits (hops, rate limit)
- Registration date + registeredBy
- Namespace
- Edit button (opens AgentDialog) + Unregister button

### What Kai and Priya Need

**Kai (primary — fleet operator):**

- At-a-glance fleet health: which agents are active, which are stale?
- Quick session launch from any agent without switching to the sidebar
- Discovery scanning when adding new projects
- "I run 10 agents across 5 projects" — namespace grouping helps when >1 namespace
- Session count per agent — "How busy is this agent?"

**Priya (secondary — architect):**

- Cross-client session visibility — sessions started from /agents appear everywhere
- Clean, unfussy UI that respects cognitive load
- Topology view for understanding agent relationships across namespaces
- Full agent details on expansion for architecture review

### Recommendation

**Dense list with expandable rows** as the primary layout, **tab-based topology** toggle, **instant inline filtering**, and **session popover** for launch. The Agents page becomes the primary fleet management surface; MeshPanel's Agents tab is removed (Mesh dialog focuses on Topology + Discovery + Access).

## 6) Decisions

| #   | Decision                            | Choice                                                | Rationale                                                                                                                              |
| --- | ----------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sidebar for /agents route           | Reuse DashboardSidebar with "Agents" highlighted      | Agents is a peer of Dashboard and Sessions in main nav. Consistent, simple, no new sidebar pattern.                                    |
| 2   | MeshPanel Agents tab                | Remove entirely                                       | Clean break — Mesh dialog becomes Topology + Discovery + Access. Avoids maintaining two agent list UIs.                                |
| 3   | Session launch with active sessions | Show active sessions popover, offer "New" or "Resume" | Kai runs 10-20 sessions — likely wants to resume existing rather than start fresh every time. Respects his workflow.                   |
| 4   | Layout approach                     | Dense list with expandable rows                       | Research consensus: fast scan, progressive disclosure, used by Linear/GitHub/Vercel. Cards waste space, tables overkill at 5-50 scale. |
| 5   | Topology integration                | Tab within the agents page                            | Consistent with existing MeshPanel tab architecture. Full viewport per view. Industry standard (Headlamp, Kiali).                      |
| 6   | Filter UX                           | Instant inline filter + status chips                  | Client-side, zero API calls at 5-50 scale. Text input + Active/Inactive/Stale chips + conditional namespace dropdown.                  |

## 7) Relationship to Dashboard-Content Spec

The `dashboard-content` spec (specs/dashboard-content/02-specification.md) is a prerequisite that builds the dashboard at `/`. Key interactions:

- **Sidebar navigation:** Dashboard-content designs DashboardSidebar with two nav items (Dashboard, Sessions) plus a "Recent Agents" section (up to 8 MRU agents). The agents page adds "Agents" as a third nav item — additive, not conflicting. Final sidebar: Dashboard | Sessions | Agents + Recent Agents section.
- **Mesh system status card:** Dashboard includes a Mesh card showing total agent count + offline count. This card should link to `/agents` (not open the Mesh dialog), giving the agents page a natural entry point from the dashboard.
- **No overlap:** Dashboard-content explicitly excludes agent management, topology, and discovery. The agents page fills that gap.
- **Shared patterns:** Same design system — status dots, agent visual hooks (emoji + color), card-interactive hover states, stagger animations, `useResolvedAgents()` hook.
- **MeshPanel Agents tab removal:** Dashboard-content doesn't address where agent management lives after MeshPanel changes. The agents page is the answer to that gap.
