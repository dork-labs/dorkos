---
slug: agent-sidebar-redesign
number: 231
created: 2026-04-11
status: ideation
---

# Agent Sidebar Redesign

**Slug:** agent-sidebar-redesign
**Author:** Claude Code
**Date:** 2026-04-11
**Branch:** preflight/agent-sidebar-redesign

---

## 1) Intent & Assumptions

- **Task brief:** Redesign the dashboard sidebar's agent list to fix spatial instability (LRU reordering on every click), improve agent discoverability (only 7 of 22+ agents visible), add favorites/pinning, make the Session Sidebar's agent management features accessible, and add glanceable activity indicators on collapsed agents.
- **Assumptions:**
  - CMD+K remains the primary power-user search mechanism — no inline agent filter needed in the sidebar
  - The Session Sidebar is the right home for agent management but needs a better entry point
  - The "Search" nav item stays as a CMD+K discoverability affordance
  - 22 agents is the current scale; the design should work up to ~50 without requiring additional patterns (CMD+K covers beyond that)
  - Mobile support required — right-click patterns must have long-press + visible `...` button equivalents
  - The frecency algorithm (already in CMD+K) could inform future sidebar ordering, but alphabetical is the v1 default for maximum spatial stability
- **Out of scope:**
  - Custom sections/folders (Slack-style user-created groups)
  - Drag-to-reorder agents
  - Muting agents
  - Server-side persistence of pins (localStorage is sufficient for single-user tool)
  - Inline search/filter in the sidebar (CMD+K handles this)

---

## 2) Pre-reading Log

- `apps/client/src/layers/features/dashboard-sidebar/ui/DashboardSidebar.tsx`: MAX_AGENTS=8 hard cap, default agent first then LRU-ordered recent agents, deduplication and display name disambiguation logic
- `apps/client/src/layers/features/dashboard-sidebar/ui/AgentListItem.tsx`: Expandable agent row with border pulse animation, chevron toggle, session previews. Only shows expanded content when active AND expanded
- `apps/client/src/layers/features/dashboard-sidebar/ui/AgentSessionPreview.tsx`: Compact session row under expanded agent with relative time and border state
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`: Full agent management sidebar with Overview/Sessions/Schedules/Connections tabs. Only accessible via "Sessions" drill-down link (gated behind totalSessionCount > 3)
- `apps/client/src/layers/features/session-list/ui/SidebarTabRow.tsx`: Tab row with hidden pencil icon (muted, hover-reveal) for agent settings dialog
- `apps/client/src/layers/features/session-list/ui/SidebarAgentHeader.tsx`: ChevronLeft back-to-dashboard + agent name + New Session button
- `apps/client/src/layers/shared/model/app-store/app-store.ts`: `setSelectedCwd` implements LRU — prepends new entry, filters duplicates, slices to MAX_RECENT_CWDS=10. `sidebarLevel: 'dashboard' | 'session'` controls which sidebar renders
- `apps/client/src/layers/shared/lib/constants.ts`: MAX_RECENT_CWDS=10, STORAGE_KEYS.RECENT_CWDS='dorkos-recent-cwds'
- `apps/client/src/layers/features/command-palette/model/use-agent-frecency.ts`: Slack bucket-based frecency algorithm — scores agents by recency buckets (4h=100pts, 24h=80pts, 3d=60pts, etc.) multiplied by frequency. Currently only used in CMD+K, not sidebar
- `apps/client/src/layers/entities/session/model/session-chat-store.ts`: Zustand store with per-session `hasUnseenActivity` boolean, MAX_RETAINED_SESSIONS=20, LRU eviction. Activity state is transient (not persisted across page reload)
- `apps/client/src/layers/entities/session/model/use-agent-hottest-status.ts`: Aggregates activity across all sessions for an agent. Priority: idle < unseen < error < streaming < pendingApproval. Already used in AgentListItem for border color
- `apps/client/src/layers/entities/session/model/use-session-border-state.ts`: Individual session border state derivation with pulse animation support
- `apps/client/src/layers/entities/mesh/use-mesh-agent-paths.ts`: `useMeshAgentPaths()` calls `transport.listMeshAgentPaths()` — provides the full list of all discovered agents
- `apps/client/src/layers/features/agents-list/ui/AgentRow.tsx`: "Set as Default Agent" button with star icon already exists on the Agents fleet management page
- `specs/agent-centric-ux/02-specification.md`: Prior spec (implemented March 2026) for CMD+K palette, agent header redesign, mesh always-on — established patterns we build on
- `contributing/design-system.md`: Calm Tech design language — less decoration, readability-first, 100-300ms animation durations
- `research/20260303_shadcn_sidebar_redesign.md`: Documents SidebarMenuBadge and SidebarMenuAction patterns available in shadcn
- `research/20260310_sidebar_tabbed_views_ux.md`: Sidebar tab patterns research
- `research/20260322_agents_page_fleet_management_ux_deep_dive.md`: Fleet management UX research

---

## 3) Codebase Map

**Primary components/modules:**

| File                                                    | Role                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `features/dashboard-sidebar/ui/DashboardSidebar.tsx`    | Main sidebar — agent list ordering, MAX_AGENTS cap, session preview |
| `features/dashboard-sidebar/ui/AgentListItem.tsx`       | Expandable agent row — border state, chevron, session previews      |
| `features/dashboard-sidebar/ui/AgentSessionPreview.tsx` | Compact session row under expanded agent                            |
| `features/session-list/ui/SessionSidebar.tsx`           | Full agent management (Overview/Sessions/Schedules/Connections)     |
| `features/session-list/ui/SidebarTabRow.tsx`            | Tab row with pencil icon for agent settings                         |
| `features/command-palette/model/use-agent-frecency.ts`  | Frecency algorithm (Slack bucket scoring)                           |
| `entities/session/model/use-agent-hottest-status.ts`    | Aggregate activity status across agent's sessions                   |
| `entities/session/model/session-chat-store.ts`          | Per-session state including hasUnseenActivity                       |
| `entities/mesh/use-mesh-agent-paths.ts`                 | Full agent discovery from mesh                                      |
| `shared/model/app-store/app-store.ts`                   | selectedCwd, recentCwds (LRU), sidebarLevel                         |

**Shared dependencies:**

- `useAppStore` — global state (sidebar, session, preferences)
- `useTransport` — API layer (resolveAgents, listMeshAgentPaths, getConfig, setDefaultAgent)
- `useIsMobile` — responsive breakpoint hook
- `SidebarMenu/SidebarMenuItem/SidebarMenuButton` — shadcn sidebar primitives
- `SidebarMenuBadge` — badge component (available in shadcn install, not yet used in agent list)
- `SidebarMenuAction` — hover-reveal action button (available in shadcn, not yet used in agent list)
- `cn()` — class merging utility
- `motion/react` — animation (border pulse, expand/collapse)
- Radix `ContextMenu` — available via shadcn for right-click menus

**Data flow:**

```
Mesh discovery → useMeshAgentPaths() → all agent paths
                                          ↓
Config → defaultAgent                  recentCwds (localStorage)
              ↓                            ↓
         DashboardSidebar: builds agentPaths = [default, ...recent].slice(0, 8)
                                          ↓
                              useResolvedAgents(paths) → AgentManifest records
                                          ↓
                              AgentListItem × N (rendered)
                                          ↓
                    useAgentHottestStatus(sessionIds) → border color/pulse
```

**After redesign, data flow becomes:**

```
Mesh discovery → useMeshAgentPaths() → ALL agent paths
                                          ↓
Config → defaultAgent              pinnedAgents (localStorage, NEW)
              ↓                            ↓
         DashboardSidebar: builds agentPaths = [pinned] + [all alphabetical]
                                          ↓
                              useResolvedAgents(paths) → AgentManifest records
                                          ↓
                              AgentListItem × N (no cap, scrollable)
                                          ↓
                    useAgentHottestStatus → border + activity badge (NEW)
                    ContextMenu → pin/manage/edit/new session (NEW)
```

**Potential blast radius:**

- **Direct changes:** DashboardSidebar.tsx, AgentListItem.tsx, app-store.ts (remove LRU reorder from display logic), constants.ts (remove MAX_AGENTS or repurpose)
- **New files:** Context menu component, pinned agents store/hook, activity badge component
- **Indirect:** Session Sidebar navigation flow (sidebarLevel switching from context menu), command palette frecency (may want to record pins for frecency boost)
- **Tests:** DashboardSidebar.test.tsx, SessionItem.test.tsx, use-session-border-state.test.tsx, AgentListItem tests (new)

---

## 4) Root Cause Analysis

N/A — this is a UX redesign, not a bug fix.

---

## 5) Research

### Potential Solutions Analyzed

**1. Pinned Section + Stable Alphabetical Remainder (Slack-Inspired)**

- Pinned section at top (2-5 user-chosen agents, stable order), alphabetical below
- Pros: Eliminates LRU chaos, gives user control, matches Slack's proven model
- Cons: Requires pin persistence, pin affordance must be discoverable
- Complexity: Medium / Maintenance: Low

**2. User-Defined Custom Sections (Full Slack Model)**

- Named section headers ("Work", "Experimental"), drag agents into sections
- Pros: Maximum flexibility for power users
- Cons: Overkill at 22 agents (designed for 50+), high UI complexity
- Complexity: High / Maintenance: Medium

**3. Immutable Alphabetical Order + CMD+K Reliance**

- Pure alphabetical, no pinning, rely on CMD+K for navigation
- Pros: Zero implementation beyond removing LRU, maximum stability
- Cons: No way to promote important agents, no activity badges
- Complexity: Low / Maintenance: Low

**4. Activity-Sorted with Stable Sections (Linear Model)**

- "Active" section (agents with running sessions) + "All" section (alphabetical)
- Pros: Activity bubbles up without destroying main list stability
- Cons: Active section can get noisy, requires live session state
- Complexity: Medium / Maintenance: Medium

**5. Inline Activity Badges + Stable Order + Collapsible Groups (Discord Model)**

- Alphabetical with inline badges (dot, count, error), collapse by status/namespace
- Pros: Stable spatial memory, activity via badges not reordering
- Cons: Grouping adds discovery complexity, badge semantics must be clear
- Complexity: Medium / Maintenance: Low

**6. Hybrid: Pinned + Alphabetical + Activity Badges (Recommended)**

- Pinned section at top + full alphabetical roster below, both with activity badges
- Pros: Covers all five problems, familiar Slack mental model, CMD+K for scale
- Cons: Slightly more surface area than pure alphabetical
- Complexity: Medium / Maintenance: Low

### Key UX Principles from Research

1. **LRU resorting violates spatial memory** — NN/Group research: adaptive interfaces that restructure layouts break users' ability to build spatial memory. Users must visually scan every time instead of navigating by position.

2. **Stable order + activity badges is the correct pairing** — Discord model: items stay in user-defined order, badges carry activity signals. Users learn positions once; badges handle state changes.

3. **Badge semantics: dot vs count** — Dot (presence): "something happened." Count (quantity): "this many things need attention." Red/error (priority): "action required."

4. **Pinning should use a separate section, not inline stars** — Both Slack and Linear create a distinct "pinned" zone at the top, not just a bold star on the item. Creates clear spatial hierarchy.

5. **Right-click context menus for power-user actions** — Linear's 2024 sidebar: right-click to pin, hide, reorder. Discoverable for developers, keeps rows clean.

6. **Sidebar scalability threshold** — At 7-10 items, spatial memory works. At 15-20, grouping helps. At 30+, search is essential. DorkOS at 22 is in the "CMD+K essential, but primary list should show all with scroll" zone.

### Recommendation

**Approach 6: Hybrid Pinned + Alphabetical + Activity Badges.** This directly solves all five problems with medium complexity and low maintenance burden.

---

## 6) Decisions

| #   | Decision                                     | Choice                                                                                                                                    | Rationale                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | How should users pin/favorite agents?        | Right-click (desktop) + long-press (mobile) context menu, with `...` action button always visible on mobile and hover-revealed on desktop | Keeps agent rows clean on desktop. Radix ContextMenu supports both right-click and long-press natively. The `...` button ensures mobile discoverability. Context menu also houses other actions (manage, edit, new session) — single entry point for all agent actions |
| 2   | How should users access the Session Sidebar? | Context menu entry: "Manage agent" opens Session Sidebar, "Edit settings" opens agent settings dialog directly                            | Consolidates discoverability into the context menu pattern. Eliminates the current problem where Session Sidebar is unreachable for agents with <= 3 sessions. No need to gate access behind session count                                                             |
| 3   | How should we handle the 22+ agent overflow? | Show all agents, scrollable, no cap. Remove MAX_AGENTS=8                                                                                  | 22 agents in a scrollable list is not a scaling problem. Pinned section keeps important agents above the fold. CMD+K handles future scaling beyond 50+. Adding expand/collapse friction at 22 items is premature optimization                                          |

### Additional Resolved Decisions (from exploration/research convergence)

| #   | Decision                                | Choice                                                                                              | Rationale                                                                                                                                                                                                                                                              |
| --- | --------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | Ordering strategy for non-pinned agents | Alphabetical (stable)                                                                               | Research unanimously supports spatial stability. Frecency is excellent for CMD+K search ranking but wrong for a persistent sidebar list. Users build positional memory with alphabetical order                                                                         |
| 5   | Inline search/filter in sidebar?        | No — CMD+K handles this                                                                             | CMD+K already has fuzzy search with @-prefix for agents, frecency ranking, agent sub-menus. Adding inline filter creates visual confusion with the "Search" nav item and duplicates existing functionality                                                             |
| 6   | Activity badge design                   | Dot indicator using existing useAgentHottestStatus                                                  | Green dot = active session(s), amber dot = pending approval, red dot = error. Reuse existing hook which already aggregates status across sessions. Ship dot-only in v1, consider count badges in v2                                                                    |
| 7   | Pin persistence                         | Zustand + localStorage                                                                              | Same pattern as recentCwds, sidebarOpen, and other client preferences. No server-side sync needed for single-user tool                                                                                                                                                 |
| 8   | "Search" nav item                       | Keep as-is                                                                                          | Serves as CMD+K discoverability affordance, especially for users who don't know the keyboard shortcut                                                                                                                                                                  |
| 9   | Few-agents state (1-4 agents)           | Progressive disclosure: inline onboarding card when < 3 agents, text link when 3-4, nothing when 5+ | No empty section headers. Single agent = just the agent row + onboarding card inviting user to add more. Pinned section header only appears when pins exist. Mirrors Slack's empty-channel-list guidance                                                               |
| 10  | Easy agent addition                     | `+` button in "AGENTS" section header + inline "Add agent" prompt for sparse lists                  | `+` button opens menu: Create agent, Import project, Browse Dork Hub. Always visible regardless of agent count. Inline prompt provides softer onboarding for new users. Reuses existing CMD+K Quick Actions                                                            |
| 11  | Frecency implementation                 | Keep hand-rolled `use-agent-frecency.ts`, do not adopt a library                                    | Only npm library (`mixmaxhq/frecency`) is abandoned (2020), no TypeScript, no advantage over current 150-line implementation. Raycast, Slack, Firefox all hand-roll. If frecency logic is needed beyond CMD+K, extract `calcFrecencyScore` to `shared/lib/frecency.ts` |
