---
slug: agents-page-10x-redesign
number: 167
created: 2026-03-22
status: ideation
---

# Agents Page 10x Redesign

**Slug:** agents-page-10x-redesign
**Author:** Claude Code
**Date:** 2026-03-22
**Branch:** preflight/agents-page-10x-redesign

---

## 1) Intent & Assumptions

- **Task brief:** Redesign the `/agents` page from a functional data table into a world-class fleet management surface. Transform the AgentRow from a wall of noise (8-9 visual elements competing equally) into a clean two-line card. Add fleet-level health awareness, color-coded filters, relative timestamps, smooth animations, and responsive behavior. The page should feel like mission control for your agent fleet.
- **Assumptions:**
  - No backend/API changes needed — all data is already available via `useTopology()` and `useMeshStatus()`
  - The topology graph (ReactFlow) stays as-is — this redesign focuses on the list view, filter bar, empty state, page structure, and micro-interactions
  - Existing animation conventions from `contributing/animations.md` apply
  - The `relativeTime()` utility from `features/mesh/lib/relative-time.ts` is reusable
  - The `AlertDialog` pattern from `shared/ui/` is the standard for destructive actions
- **Out of scope:**
  - Keyboard navigation (j/k to move between agents, Enter/Escape for expand/collapse)
  - Bulk actions and multi-select
  - Drag-and-drop reordering or grouping
  - Backend changes to the mesh/topology API
  - TopologyGraph visual changes (covered by spec #122)
  - Sidebar "Recent Agents" redesign (separate concern)

## 2) Pre-reading Log

- `apps/client/src/layers/widgets/agents/ui/AgentsPage.tsx`: Top-level orchestrator. Mode A/B split with AnimatePresence. Tabs for Agents/Topology. LazyTopologyGraph via React.lazy.
- `apps/client/src/layers/features/agents-list/ui/AgentRow.tsx`: 214 lines. Collapsed state has 8-9 elements in one horizontal line. Expanded state is a flat text dump. lastActive rendered as raw ISO string. Inline confirmUnregister boolean pattern.
- `apps/client/src/layers/features/agents-list/ui/AgentFilterBar.tsx`: Status chips as plain buttons, no color coding, no counts. Missing `unreachable` status. Search input fixed at `w-48`.
- `apps/client/src/layers/features/agents-list/ui/AgentsList.tsx`: Stagger animation on entrance. Namespace grouping. No empty state when filters match zero agents.
- `apps/client/src/layers/features/agents-list/ui/SessionLaunchPopover.tsx`: Smart zero-session vs multi-session branching.
- `apps/client/src/layers/features/top-nav/ui/AgentsHeader.tsx`: "Scan for Agents" button + CommandPaletteTrigger. No view switcher.
- `apps/client/src/layers/features/mesh/ui/MeshStatsHeader.tsx`: Existing fleet health bar — shows active/inactive/stale counts with colored dots. Not barrel-exported.
- `apps/client/src/layers/features/mesh/lib/relative-time.ts`: `relativeTime(iso | null)` → "just now", "Ns ago", "Nm ago", "Nh ago", "Nd ago", "Never". Pure function, no auto-refresh.
- `apps/client/src/layers/entities/mesh/model/use-mesh-topology.ts`: Primary data source. Returns `TopologyView` with `namespaces[].agents: TopologyAgent[]`. 30s staleTime/refetchInterval.
- `apps/client/src/layers/entities/mesh/model/use-mesh-status.ts`: Returns `MeshStatus` with `totalAgents`, `activeCount`, `inactiveCount`, `staleCount`, `unreachableCount`. 30s poll.
- `apps/client/src/layers/shared/ui/alert-dialog.tsx`: Radix AlertDialog with focus trap, keyboard Escape, ARIA roles. Used by RestartDialog and ResetDialog.
- `contributing/animations.md`: Height collapse pattern (`height: 0 ↔ 'auto'`), stagger children, fade+slide entrances, spring presets, reduced motion via MotionConfig.
- `contributing/design-system.md`: 8pt grid, card radius 16px, button radius 10px, animation 100-300ms, shadow utilities.
- `research/20260320_agents_page_ux_patterns.md`: Dense list with expandable rows wins for 5-50 agents. 52-56px collapsed row.
- `research/20260322_agents_page_fleet_management_ux_deep_dive.md`: New research — fleet health bars, responsive patterns, micro-interactions, ghost rows empty state.

## 3) Codebase Map

**Primary components/modules:**

- `widgets/agents/ui/AgentsPage.tsx` — Page orchestrator, Mode A/B, view switching
- `features/agents-list/ui/AgentRow.tsx` — Expandable agent row (major redesign)
- `features/agents-list/ui/AgentFilterBar.tsx` — Filter controls (color-coded chips + counts)
- `features/agents-list/ui/AgentsList.tsx` — List container (fleet health bar, empty filter state)
- `features/agents-list/ui/SessionLaunchPopover.tsx` — Session launch action (minor responsive tweaks)
- `features/top-nav/ui/AgentsHeader.tsx` — Page header (add view switcher tabs)
- `features/mesh/ui/DiscoveryView.tsx` — Mode A empty state (ghost rows overlay)
- `features/mesh/ui/TopologyGraph.tsx` — Lazy-loaded graph (no changes, just wiring)
- `features/mesh/ui/MeshStatsHeader.tsx` — Reference for fleet health pattern

**Shared dependencies:**

- `shared/ui/alert-dialog` — For unregister confirmation
- `shared/ui/badge`, `shared/ui/button`, `shared/ui/collapsible`, `shared/ui/scroll-area`
- `shared/model/use-is-mobile` — Responsive breakpoint hook
- `shared/lib/cn` — Class merging
- `features/mesh/lib/relative-time` — Timestamp formatting
- `entities/mesh/` — `useTopology()`, `useMeshStatus()`, `useUnregisterAgent()`
- `entities/session/` — `useSessions()` for session counts
- `motion/react` — AnimatePresence, motion.div

**Data flow:**

```
useTopology() → topology.namespaces[].agents → AgentsPage (flatten)
                                                  ├── FleetHealthBar ← useMeshStatus()
                                                  ├── AgentFilterBar ← local filterState
                                                  ├── AgentsList ← filtered agents
                                                  │   └── AgentRow × N
                                                  │       ├── relativeTime(lastSeenAt)
                                                  │       ├── SessionLaunchPopover ← useSessions()
                                                  │       └── UnregisterAgentDialog ← useUnregisterAgent()
                                                  └── TopologyGraph (lazy, separate view)
```

**Feature flags/config:** None — Mesh is always-on when agents exist.

**Potential blast radius:**

- Direct: 6 files modified, 2-3 new files created
- Indirect: 4 test files need updates
- Zero backend changes

## 4) Root Cause Analysis

N/A — this is a UX redesign, not a bug fix.

## 5) Research

### Potential Solutions

**1. Incremental Polish (Low complexity)**

- Fix the raw timestamp bug, add color to filter chips, extract AlertDialog
- Pros: Minimal risk, fast to ship
- Cons: Doesn't address the fundamental density problem in AgentRow; still feels like a data table

**2. Full AgentRow Restructure + Fleet Health Bar (Medium complexity) — RECOMMENDED**

- Two-line card layout, fleet health summary, color-coded filters with counts, ghost rows empty state, smooth expand animations, responsive breakpoints
- Pros: Addresses all 12 recommendations; transforms the page from database table to mission control; responsive from the start
- Cons: Larger change surface, more tests to update
- Complexity: Medium
- Maintenance: Low (uses existing patterns: AlertDialog, relativeTime, motion conventions)

**3. Full Rewrite with Custom Card Component Library (High complexity)**

- Build a custom `AgentCard` component system with multiple display modes (compact/default/expanded), custom animation framework, virtual scrolling
- Pros: Maximum flexibility, could support future features (drag-and-drop, bulk selection)
- Cons: Over-engineered for 5-50 agents; virtual scrolling unnecessary at this scale; custom animation system conflicts with existing motion patterns
- Complexity: High
- Maintenance: High

### Security Considerations

- No new API endpoints or data exposure
- AlertDialog for destructive actions (unregister) is a security improvement over the current inline confirmation

### Performance Considerations

- `useMeshStatus()` adds one additional polling query (30s interval) — negligible
- Ghost rows empty state uses CSS only (no additional JS)
- Height animations use `will-change: height` implicitly via motion — GPU-composited
- `tabular-nums` on health bar counts prevents layout jitter during polls

### Recommendation

**Recommended Approach:** Full AgentRow Restructure + Fleet Health Bar (Option 2)

**Rationale:** This hits the sweet spot — every recommendation from the review is addressed using existing codebase patterns (AlertDialog, relativeTime, motion conventions, useIsMobile). No new dependencies needed. The two-line card layout is the single highest-impact change (resolves the information density crisis), and the fleet health bar provides the situational awareness that's completely missing today.

**Caveats:**

- The ghost rows empty state requires care to not look like a loading skeleton — dashed borders and opacity differentiate it
- The clickable health summary bar adds a second way to filter (in addition to chips) — clear visual feedback is needed to show which filter is active

## 6) Decisions

| #   | Decision                         | Choice                                                                               | Rationale                                                                                                                                                                             |
| --- | -------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Health summary bar behavior      | Clickable counts that activate status filters + separate filter chips remain visible | Grafana pattern — reduces clicks from 2 to 1 for the most common fleet-check action. Filter chips remain as secondary confirmation of active filter state.                            |
| 2   | View switcher (List vs Topology) | Keep text tabs, move to header                                                       | Text labels ("Agents" / "Topology") are clearer than icons for an infrequent toggle. Moving to header frees content space for the fleet health bar and filter row.                    |
| 3   | Mode A empty state               | Ghost rows + scan CTA                                                                | 3 dimmed placeholder rows showing the two-line card layout, with centered overlay "Scan for Agents" button. Shows what's possible, has ambient visual life, exactly one path forward. |
| 4   | Mobile filter behavior (<640px)  | Search + single "Filter" dropdown                                                    | Status chips collapse into a single "Filter" dropdown button. Search input remains visible. Health summary shows as compact single-line. Minimum 44px touch targets.                  |

### Component Breakdown

**Modified files:**

| File                 | Changes                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AgentRow.tsx`       | Two-line card layout (Line 1: health dot + name + runtime + relative time; Line 2: path + session count). Capabilities removed from collapsed. Motion height expand/collapse. AlertDialog replaces inline confirm. |
| `AgentFilterBar.tsx` | Color-coded status chips with counts. Add `unreachable` status. Flexible search input width. Responsive: collapses to search + dropdown on mobile.                                                                 |
| `AgentsList.tsx`     | Fleet health summary bar above filters. Empty filter state ("No agents match your filters" + clear button). Fix stagger to not re-trigger on filter changes.                                                       |
| `AgentsPage.tsx`     | View mode state (`list` / `topology`). AnimatePresence crossfade between views. Remove Tabs wrapper. Ghost rows Mode A.                                                                                            |
| `AgentsHeader.tsx`   | Text tab switcher (Agents / Topology) moved here. Receives `viewMode` + `onViewModeChange` props.                                                                                                                  |

**New files:**

| File                        | Layer                   | Purpose                                                 |
| --------------------------- | ----------------------- | ------------------------------------------------------- |
| `UnregisterAgentDialog.tsx` | features/agents-list/ui | Extracted AlertDialog for unregister confirmation       |
| `FleetHealthBar.tsx`        | features/agents-list/ui | Clickable health summary counts using `useMeshStatus()` |
| `AgentGhostRows.tsx`        | features/agents-list/ui | Ghost placeholder rows for Mode A empty state           |
| `AgentEmptyFilterState.tsx` | features/agents-list/ui | "No agents match" state with clear-filters action       |

### Visual Design Spec

**Collapsed AgentRow (two-line card):**

```
┌─────────────────────────────────────────────────────────┐
│  ● Agent Name           claude-code        3m ago       │
│    ~/projects/my-app    2 active       [Start Session]  │
└─────────────────────────────────────────────────────────┘
```

- Line 1: health dot (colored) + name (font-medium) + runtime badge (secondary) + relative time (muted, ml-auto)
- Line 2: truncated path (mono, muted) + session count badge (outline, if > 0) + SessionLaunchPopover (right-aligned)
- Chevron at far right spanning both lines
- `hover:bg-accent/50`, `rounded-xl`, `border`, `px-4 py-3`

**Fleet Health Summary Bar:**

```
● 8 Active   ◐ 2 Inactive   ○ 1 Stale                    11 agents
```

- Each count is clickable → activates that status filter
- Active count: emerald-500 dot
- Inactive: amber-500 dot
- Stale: muted dot
- Unreachable: red-500 dot (only shown when count > 0)
- `tabular-nums` on all counts
- Total count right-aligned, muted

**Ghost Rows (Mode A):**

```
┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
│  ●  ████████████            ████              ████      │ opacity-20
│     ████████████████        ██████                      │ dashed border
└ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
           [  Scan for Agents  ]  ← centered overlay
```

- 3 rows with `border-dashed opacity-20`
- Skeleton-like bars matching the two-line card layout
- Centered overlay with scan button
- Subtle stagger entrance animation

**Expanded AgentRow:**

```
┌─────────────────────────────────────────────────────────┐
│  ● Agent Name           claude-code        3m ago     ▲ │
│    ~/projects/my-app    2 active       [Start Session]  │
│─────────────────────────────────────────────────────────│
│  Description text goes here...                          │
│                                                         │
│  Capabilities    code-review  testing  deployment       │
│  Response Mode   autonomous                             │
│  Budget          max 5 hops · 20 calls/hr               │
│  Namespace       default                                │
│  Registered      Mar 22 by claude-code                  │
│                                                         │
│  [Edit]  [Unregister]                                   │
└─────────────────────────────────────────────────────────┘
```

- Smooth height animation (`motion.div`, `height: 0 ↔ 'auto'`, 200ms)
- Config data in a two-column label/value layout
- Capabilities shown as badges
- Registration info at bottom, smallest text
- Unregister opens AlertDialog

**Mobile Layout (<640px):**

```
┌───────────────────────────┐
│ ● 8  ◐ 2  ○ 1       11   │  ← compact health bar
├───────────────────────────┤
│ [🔍 Filter agents...] [⊕] │  ← search + filter dropdown
├───────────────────────────┤
│  ● Agent Name              │
│    claude-code    3m ago   │
│    ~/projects/my-app       │
│    2 active  [Start] [▼]  │
└───────────────────────────┘
```

- Health bar: dots + counts only, no labels
- Filter bar: search expands, chips collapse into dropdown
- AgentRow: stacks vertically, 3-4 lines
- Touch targets: minimum 44px

### Animation Inventory

| Element               | Animation                                | Duration                     | Pattern                                    |
| --------------------- | ---------------------------------------- | ---------------------------- | ------------------------------------------ |
| Mode A ↔ Mode B       | `AnimatePresence mode="wait"`, opacity   | 200ms                        | Existing                                   |
| List ↔ Topology       | `AnimatePresence mode="wait"`, opacity   | 150ms                        | New                                        |
| AgentRow entrance     | `staggerChildren: 0.04`, opacity + y:8→0 | 150ms                        | Existing (fix to not re-trigger on filter) |
| AgentRow expand       | `height: 0 ↔ 'auto'`, opacity            | 200ms, ease `[0, 0, 0.2, 1]` | New (from animations.md pattern)           |
| AgentRow hover        | `hover:bg-accent/50`                     | CSS transition-colors        | Existing                                   |
| Health dot pulse      | CSS `@keyframes`, box-shadow             | 2s loop                      | New                                        |
| Ghost rows entrance   | `staggerChildren: 0.1`, opacity 0→0.2    | 300ms                        | New                                        |
| Fleet health bar      | `tabular-nums` (no animation)            | —                            | New                                        |
| Filter results change | `AnimatePresence`, opacity + height exit | 150ms                        | New                                        |
| Empty filter state    | Fade + y:20→0                            | 300ms                        | From animations.md                         |
