---
slug: dashboard-content
number: 147
created: 2026-03-20
status: ideation
---

# Dashboard Content — Mission Control for Your Agent Workforce

**Slug:** dashboard-content
**Author:** Claude Code
**Date:** 2026-03-20
**Branch:** preflight/dashboard-content

---

## 1) Intent & Assumptions

- **Task brief:** Design and build the content for the DorkOS dashboard — the main content area, sidebar, and header at the `/` route. The dashboard is a calm, glanceable mission control where a single person operating an AI agent workforce understands the state of everything in 3 seconds. It answers: (1) Does anything need my attention? (2) What is active? (3) Is the system healthy? (4) What happened while I was away?
- **Assumptions:**
  - The dashboard route, AppShell, and route-aware sidebar/header slot system already exist (specs 154, 156 implemented)
  - `DashboardSidebar`, `DashboardHeader`, and `DashboardPage` are live placeholder components ready to fill
  - All entity hooks for sessions, Pulse, Relay, Mesh, agents, and tunnel exist and provide the data we need
  - No new server API endpoints are required for v1 — all data is available through existing entity hooks
  - The dashboard serves both the "morning coffee" use case (Kai waking up to see what his overnight agents did) and the "mid-work check-in" use case (quick glance between sessions)
- **Out of scope:**
  - AI-generated briefing summaries (requires agent calls — future evolution)
  - Loop integration (not built yet)
  - Wing memory visualization (not built yet)
  - Cross-machine mesh view
  - Command center / wall-display mode
  - Replay / time-lapse feature
  - User-customizable widget grid (DorkOS presents an opinionated, curated view)
  - Token usage, cost metrics, or historical trend charts (analytics, not operations)
  - Session transcript excerpts (detail belongs in `/session`)
  - Configuration forms or adapter setup (belongs in subsystem panels)
  - Mesh topology graph (belongs in Mesh panel)

---

## 2) Pre-reading Log

### Project Docs & Specs

- `specs/dashboard-content/00-brainstorm.md`: Wide-ranging brainstorm exploring dashboard header, sidebar, main content, empty states, delight moments, killer features, and Jobs/Ive design philosophy
- `specs/dynamic-sidebar-content/02-specification.md`: Just implemented — created the route-aware sidebar/header slot system with `useSidebarSlot()` / `useHeaderSlot()` in AppShell, cross-fade animation, `DashboardSidebar` / `DashboardHeader` / `SessionSidebar` / `SessionHeader` components
- `specs/dashboard-home-route/01-ideation.md`: Prior spec that established the signal hierarchy: Tier 1 (Needs Attention), Tier 2 (Active Now), Tier 3 (System Status + Recent)
- `contributing/design-system.md`: Calm Tech design language — 8pt grid, status dots (`size-2 rounded-full`), color semantics, `shadow-soft`/`shadow-elevated`, `card-interactive` utility, typography scale
- `contributing/animations.md`: Motion library patterns — fade+slide entrance, stagger lists (limit 8 items), height collapse, module-scope variants
- `contributing/data-fetching.md`: TanStack Query patterns, conditional polling via `refetchInterval`
- `contributing/styling-theming.md`: Tailwind v4, dark mode, Shadcn new-york style
- `contributing/project-structure.md`: FSD layer rules — `shared ← entities ← features ← widgets`

### Research

- `research/20260320_dashboard_content_design_patterns.md`: Comprehensive research covering Vercel's dashboard redesign (status over analytics), GitHub Copilot Mission Control (centralized task list, inline steering), PatternFly card taxonomy (5 card types), calm technology principles (periphery vs. center), activity feed patterns, empty state design (NNGroup), sparkline guidance, anti-patterns

### Current Code

- `apps/client/src/layers/widgets/dashboard/ui/DashboardPage.tsx`: Placeholder — centered text "DorkOS / Mission control for your agents"
- `apps/client/src/layers/features/dashboard-sidebar/ui/DashboardSidebar.tsx`: Placeholder — Dashboard/Sessions nav links + "Agent overview coming soon"
- `apps/client/src/layers/features/top-nav/ui/DashboardHeader.tsx`: Placeholder — "Dashboard" label + `CommandPaletteTrigger`
- `apps/client/src/AppShell.tsx`: Route-aware slot system with AnimatePresence cross-fades, static footer
- `apps/client/src/layers/entities/session/index.ts`: `useSessions()`, `useSessionStatus()`
- `apps/client/src/layers/entities/pulse/index.ts`: `useSchedules()`, `useRuns()`, `useActiveRunCount()`, `usePulseEnabled()`, `useCompletedRunBadge()`
- `apps/client/src/layers/entities/relay/index.ts`: `useRelayAdapters()`, `useAggregatedDeadLetters()`, `useDeliveryMetrics()`, `useRelayEnabled()`
- `apps/client/src/layers/entities/mesh/index.ts`: `useMeshStatus()`, `useRegisteredAgents()`, `useMeshEnabled()`
- `apps/client/src/layers/entities/agent/index.ts`: `useCurrentAgent()`, `useResolvedAgents()`, `useAgentVisual()`, `useAgentToolStatus()`
- `apps/client/src/layers/entities/tunnel/index.ts`: `useTunnelStatus()`
- `apps/client/src/layers/shared/model/app-store.ts`: `recentCwds`, `isStreaming`, dialog openers, `openGlobalPaletteWithSearch()`

### Existing UI Patterns to Follow

- **Status dots**: `size-2 rounded-full` with `bg-green-500` / `bg-amber-500` / `bg-red-500` / `animate-pulse` for active
- **Section labels**: `text-2xs text-muted-foreground/70 font-medium tracking-wider uppercase`
- **Empty states**: Centered text with muted color (`text-muted-foreground/60 text-sm`) or full ghost-preview with CTA button
- **Agent identity**: `useAgentVisual()` → `{ color, emoji }`, used in `AgentIdentityChip`
- **Health aggregation**: `useConnectionsStatus()` returns `'ok' | 'partial' | 'error' | 'none'` from relay + mesh caches
- **Relay health bar**: `RelayHealthBar` with `computeHealthState()` — reusable pattern
- **Animation variants**: Module-scope `sectionVisibilityVariants` with height 0↔auto, opacity 0↔1 (from `ConnectionsView`)
- **Stagger animation**: variants with `staggerChildren: 0.04`, limit to first 8 items

---

## 3) Codebase Map

**Primary components/modules (to create or modify):**

| File                                                 | Action           | Role                                                |
| ---------------------------------------------------- | ---------------- | --------------------------------------------------- |
| `widgets/dashboard/ui/DashboardPage.tsx`             | Replace entirely | Main dashboard — composes the four content sections |
| `features/dashboard-sidebar/ui/DashboardSidebar.tsx` | Replace entirely | Navigation links + recent agents list               |
| `features/top-nav/ui/DashboardHeader.tsx`            | Augment          | Add system health dot + quick action buttons        |

**New feature modules to create:**

| Feature                         | Layer    | Purpose                                                                               |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `features/dashboard-attention/` | features | "Needs Attention" section — derives attention items from sessions, Pulse, Relay, Mesh |
| `features/dashboard-sessions/`  | features | Active session cards grid                                                             |
| `features/dashboard-status/`    | features | System status row (Pulse, Relay, Mesh, Activity sparkline)                            |
| `features/dashboard-activity/`  | features | Recent activity feed — time-grouped event list                                        |

**Shared dependencies (already exist):**

- All entity hooks (session, pulse, relay, mesh, agent, tunnel)
- shadcn components: `Badge`, `Skeleton`, `ScrollArea`, `Tooltip`, `Button`, `Separator`
- `useAppStore` (Zustand) for `recentCwds`, dialog openers
- `motion/react` for entrance animations
- `useNavigate` from TanStack Router for navigation

**Data flow:**

```
Entity hooks (TanStack Query) → Feature hooks (derive/aggregate) → Feature UI → Widget composition (DashboardPage)
```

- Sessions: `useSessions()` → filter active → `ActiveSessionsSection`
- Pulse: `useSchedules()` + `useRuns()` → aggregate status → `SubsystemCard`
- Relay: `useRelayAdapters()` + `useAggregatedDeadLetters()` → health state → `SubsystemCard`
- Mesh: `useMeshStatus()` + `useRegisteredAgents()` → agent count + offline count → `SubsystemCard`
- Attention: combine failed runs + dead letters + stalled sessions → `NeedsAttentionSection`
- Activity: combine session events + Pulse runs + Relay messages → time-grouped feed

**Potential blast radius:**

- Direct: 3 existing files (DashboardPage, DashboardSidebar, DashboardHeader)
- New: ~12-15 new files across 4 feature modules
- Indirect: None — dashboard consumes existing entity hooks without modifying them
- Tests: New test files for each feature module + updated dashboard widget tests

---

## 5) Research

### Potential Solutions

**1. Calm Status Board (Recommended)**

- Description: Four-section layout — Needs Attention (conditional), Active Sessions, System Status row, Recent Activity feed. Follows calm technology principles: neutral when healthy, color for exceptions. Typography-driven, minimal chrome.
- Pros:
  - Directly answers the 3-second state assessment goal
  - Aligns with Vercel, Linear, and GitHub Copilot Mission Control patterns
  - All data available through existing entity hooks — no new server APIs
  - Clean empty states double as onboarding
  - Progressive disclosure — summary on dashboard, detail in subsystem panels
- Cons:
  - Four sections is ambitious for v1
  - Activity feed requires aggregating events from multiple entity sources
  - No new server endpoint for unified event stream — activity feed must be client-side aggregated
- Complexity: Medium-High
- Maintenance: Low — entity hooks are stable, dashboard is read-only

**2. Minimal Card Grid**

- Description: Just system status cards (Pulse, Relay, Mesh) + active session list. No attention zone, no activity feed. Focused on "is the system running?"
- Pros:
  - Simplest to build
  - Clear, focused scope
  - Easy to test
- Cons:
  - Doesn't serve the "morning coffee" use case
  - No sense of what happened while you were away
  - Misses the most impactful feature (Needs Attention)
- Complexity: Low
- Maintenance: Low

**3. Natural Language Dashboard**

- Description: AI-generated briefing at the top, with structured data below. "While you were away, 3 agents ran..."
- Pros:
  - Most emotionally compelling — feels like a chief of staff
  - Differentiator — nobody else does this
- Cons:
  - Requires an agent call on every dashboard load (cost, latency)
  - Generated text quality is unpredictable
  - Adds complexity that doesn't serve the 3-second scan goal
  - Can be added later as an enhancement to approach 1
- Complexity: High
- Maintenance: Medium (prompt engineering, model dependency)

### Recommendation

**Approach 1: Calm Status Board.** It delivers the full mission control experience, uses only existing data sources, and follows proven patterns from the best developer tool dashboards. The activity feed is the most complex piece but provides the highest emotional value ("what happened while I was away"). Natural language briefings can be layered on top in a future iteration.

---

## 6) Decisions

| #   | Decision                  | Choice                           | Rationale                                                                                                                                                                                   |
| --- | ------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Dashboard sidebar content | Navigation links + recent agents | User decision: sidebar shows nav items (Dashboard/Sessions) plus most recently used agents, giving quick access to switch between agent contexts                                            |
| 2   | V1 scope                  | All 4 sections                   | User decision: build Needs Attention, Active Sessions, System Status, and Recent Activity. Entity hooks already exist for all data — the investment is in UI composition, not data plumbing |
| 3   | Dashboard header          | Add health dot + quick actions   | User decision: single aggregate health dot (green/amber/red) plus quick action buttons (New Session, Trigger Schedule). Keeps header functional without crowding                            |
| 4   | Healthy status color      | Neutral gray                     | User decision: calm tech principle — silence = healthy. Reserve color for exceptions (amber/red). Healthy state uses `text-muted-foreground` and neutral dots, not persistent green         |
