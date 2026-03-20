---
slug: sidebar-tabbed-views
number: 117
created: 2026-03-10
status: ideation
---

# Sidebar Tabbed Views — Sessions, Schedules, Connections

**Slug:** sidebar-tabbed-views
**Author:** Claude Code
**Date:** 2026-03-10
**Branch:** preflight/sidebar-tabbed-views

---

## 1) Intent & Assumptions

- **Task brief:** Evolve the sidebar from a single session list into a three-tab navigation system. The three views are Sessions (existing session list), Schedules (Pulse schedules for the current agent/cwd), and Connections (adapters, MCP servers, agent registry for the current agent/cwd). Views must persist state when hidden — no unmount/remount on tab switch.

- **Assumptions:**
  - The existing SessionSidebar component is the primary target; it already uses Shadcn Sidebar primitives
  - Sessions tab inherits the current sidebar content unchanged
  - Schedules and Connections show read-only summaries; full management stays in existing dialog panels (PulsePanel, RelayPanel, MeshPanel)
  - AgentContextChips are removed and replaced by tab badge indicators (numeric for Schedules, status dot for Connections)
  - Tab state persists in Zustand + localStorage so the active tab survives page reloads
  - Keyboard shortcuts (Cmd+1/2/3) are registered when the sidebar is open

- **Out of scope:**
  - Full inline CRUD for schedules or adapter management within the sidebar
  - Changes to the existing PulsePanel, RelayPanel, or MeshPanel dialogs
  - New API endpoints (all data available via existing entity hooks)
  - Mobile-specific tab behavior beyond responsive sizing
  - Changes to the top navigation bar

---

## 2) Pre-reading Log

- `specs/shadcn-sidebar-redesign/02-specification.md`: Completed spec that established the current Shadcn-based sidebar architecture. Foundation for this feature.
- `specs/agent-centric-ux/02-specification.md`: Parent spec for agent-centric design direction. Sessions, Schedules, Connections align with agent context model.
- `specs/pulse-ui-overhaul/02-specification.md`: Defines PulsePanel UI patterns, schedule card layouts, run status indicators.
- `specs/adapter-catalog-management/02-specification.md`: Defines adapter catalog UI, connection status patterns.
- `specs/mesh-panel-ux-overhaul/02-specification.md`: Defines MeshPanel agent roster, topology display.
- `contributing/design-system.md`: 8pt grid, `text-2xs` for labels, tab styling patterns (`px-3 py-1.5`), color tokens.
- `contributing/animations.md`: Motion library usage, 200ms normal timing, spring configs for layout transitions.
- `contributing/styling-theming.md`: Tailwind v4 patterns, dark mode, cn() utility.
- `contributing/state-management.md`: Zustand for UI state, TanStack Query for server state. Active tab is UI state (Zustand).
- `.claude/rules/fsd-layers.md`: Features can import from entities/shared; widgets from features/entities/shared. Session-list is a feature.
- `.claude/rules/components.md`: Use `cn()` for classes, `data-slot` for styling hooks, Shadcn patterns.
- `decisions/0009-calm-tech-notification-layers.md`: Non-intrusive status indicators, tooltip-first pattern.
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`: Current sidebar — uses SidebarContent, SidebarHeader, SidebarFooter, SidebarGroup, SidebarMenu.
- `apps/client/src/layers/features/session-list/ui/AgentContextChips.tsx`: Per-agent Pulse/Relay/Mesh status chips. Will be replaced by tab badges.
- `apps/client/src/layers/features/session-list/ui/SidebarFooterBar.tsx`: Footer with branding, settings, theme toggle. Unchanged.
- `apps/client/src/layers/features/session-list/ui/SessionItem.tsx`: Session row with expand/collapse. Unchanged.
- `apps/client/src/layers/shared/ui/sidebar.tsx`: Shadcn Sidebar primitives (SidebarProvider, Sidebar, SidebarContent, etc.).
- `apps/client/src/layers/shared/ui/tabs.tsx`: Shadcn Tabs primitive (Radix). Provides Tabs, TabsList, TabsTrigger, TabsContent.
- `apps/client/src/layers/shared/model/app-store.ts`: Zustand store with sidebarOpen, dialog flags. Target for sidebarActiveTab.
- `apps/client/src/layers/widgets/app-layout/ui/DialogHost.tsx`: Renders PulsePanel, RelayPanel, MeshPanel in dialogs. Unchanged.
- `apps/client/src/layers/entities/pulse/`: usePulseEnabled, useSchedules, useActiveRunCount hooks.
- `apps/client/src/layers/entities/relay/`: useRelayEnabled, useRelayAdapters hooks.
- `apps/client/src/layers/entities/mesh/`: useRegisteredAgents, useMeshStatus hooks.
- `meta/personas/the-autonomous-builder.md`: Kai — 10-20 sessions/week, wants glanceable agent status, dismisses "chatbot wrappers."
- `meta/personas/the-knowledge-architect.md`: Priya — flow preservation is core need, reads source code, keyboard-first.
- `meta/personas/the-prompt-dabbler.md`: Jordan (anti-persona) — expects hand-holding, wizards, full text labels. We explicitly don't serve this.
- `meta/brand-foundation.md`: "Confident. Minimal. Technical. Sharp." Control panel, not consumer app.
- `meta/value-architecture-applied.md`: Value streams map to agent capabilities; sidebar views surface the three pillars of agent operation.
- `meta/customer-voice.md`: "You can't observe what 20 agents are doing" — Schedules badge solves this at a glance.

---

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` — Main sidebar; refactor target for tab wrapper
- `apps/client/src/layers/features/session-list/ui/AgentContextChips.tsx` — Status chips; will be removed (replaced by tab badges)
- `apps/client/src/layers/shared/ui/tabs.tsx` — Shadcn Tabs primitives (Radix-based)
- `apps/client/src/layers/shared/ui/sidebar.tsx` — Shadcn Sidebar primitives
- `apps/client/src/layers/shared/model/app-store.ts` — Zustand store; add sidebarActiveTab

**Shared Dependencies:**

- `@/layers/shared/ui` — Tabs, Sidebar, Badge, Tooltip components
- `@/layers/shared/model` — app-store (Zustand)
- `@/layers/entities/pulse` — useSchedules, useActiveRunCount, usePulseEnabled
- `@/layers/entities/relay` — useRelayAdapters, useRelayEnabled
- `@/layers/entities/mesh` — useRegisteredAgents, useMeshStatus
- `motion` — Layout animations, spring transitions
- `lucide-react` — MessageSquare, Clock, Plug2 icons

**Data Flow:**

- Tab state: User click / keyboard shortcut → Zustand `setSidebarActiveTab` → CSS hidden toggle on view containers → localStorage persistence
- Sessions: useDirectoryState → useSessions → SidebarMenu items (existing, unchanged)
- Schedules: useSchedules → compact ScheduleItem list → "Open Pulse" button → setPulseOpen dialog
- Connections: useRelayAdapters + useRegisteredAgents → compact adapter/agent rows → "Open Relay/Mesh" buttons → dialog

**Feature Flags/Config:**

- `usePulseEnabled()` — Schedules tab only visible when Pulse feature is enabled
- `useRelayEnabled()` — Connections tab adapters section only when Relay is enabled
- Mesh agents section always visible (agents are core)

**Potential Blast Radius:**

- Direct: 3 files modified (SessionSidebar, app-store, session-list barrel), 2 new files (SchedulesTab, ConnectionsTab)
- Removed: AgentContextChips (1 file + 1 test file)
- Tests: 3 test files need updates, 2 new test files
- Indirect: Zero — DialogHost, PulsePanel, RelayPanel, MeshPanel all unchanged

---

## 4) Root Cause Analysis

_Not applicable — this is a new feature, not a bug fix._

---

## 5) Research

### Persona-Driven UX Analysis

**Kai (Primary — The Autonomous Builder):**

- Lives in the Sessions view; checks constantly, navigates by feel. Scroll position continuity is critical.
- Tabs to Schedules to see "2 active runs" confirmed, returns to Sessions in under 3 seconds — without losing scroll position.
- His core frustration ("You can't observe what 20 agents are doing") is addressed by the Schedules badge showing active run count at a glance.
- Delight moment: discovering `Cmd+2` in the tooltip, never needing to reach for the mouse again.

**Priya (Secondary — The Knowledge Architect):**

- Flow preservation is her emotional core. A tab switch that destroys scroll position or resets state costs her 15 minutes of mental reconstruction.
- She reads source code. If she saw conditional rendering (`{activeTab === 'sessions' && <SessionsView />}`) destroying view state, she would lose trust immediately.
- The CSS `hidden` approach (views always mounted, visibility toggled) must be the implementation — not a shortcut that looks correct but silently resets state.

**Anti-Persona (Jordan — The Prompt Dabbler):**

- Would expect full text labels, setup wizards inside each tab, tooltips explaining what "Pulse" means.
- We explicitly don't do this. Icon-only tabs (with ARIA labels for accessibility, not hand-holding), no onboarding copy, no wizard flows.

### Potential Solutions

**1. Icon-Only Horizontal Tabs (Selected)**

- Description: Three icons (MessageSquare, Clock, Plug2) in a compact horizontal row between SidebarHeader and content area. Sliding animated indicator. Badge overlays.
- Pros: Minimal space, control-panel aesthetic, supports badge counts, matches brand voice
- Cons: Icons must be immediately recognizable; tooltips needed for accessibility
- Complexity: Low
- Maintenance: Low

**2. Vertical Activity Bar (VS Code Style)**

- Description: Narrow icon column on the left edge of the sidebar, content area to the right.
- Pros: Established developer pattern, infinitely extensible for more views
- Cons: Creates two-column sidebar, reduces content width to ~250px, overkill for 3 views
- Complexity: High
- Maintenance: Medium

**3. Text Tab Bar**

- Description: Full text labels in a horizontal TabsList.
- Pros: Maximum clarity, zero learning curve, uses Shadcn Tabs as-is
- Cons: Consumer-app aesthetic, tight on narrow sidebar widths, would attract anti-persona
- Complexity: Low
- Maintenance: Low

**4. Segmented Control**

- Description: Compact pill-style toggle (iOS-style).
- Pros: Tight, modern feel
- Cons: Semantically implies variants of the same content, not distinct views; requires abbreviations
- Complexity: Low
- Maintenance: Low

### State Persistence Approach

**CSS `hidden` toggle** — Three views mounted simultaneously. Active view visible, others get `className="hidden"`. Scroll position preserved automatically because DOM stays in place. Zero unmount/remount cost.

```tsx
<div className={cn(activeTab !== 'sessions' && 'hidden')}>
  <SessionsView />
</div>
```

**Future migration path:** React 19.2's `<Activity>` component is the canonical answer — it preserves state, hides DOM, and cleans up Effects when hidden (preventing zombie fetches). Migrate when confirmed in the project's React version.

### Delight Opportunities

1. **Live run indicator:** Pulsing ring on the Schedules badge when a run is actively executing — like a recording indicator. Kai immediately reads this as "something is happening right now."
2. **Badge clear animation:** Badge number shrinks and fades as Kai navigates into the Schedules tab. Communicates "acknowledged."
3. **Hover tooltip with summary:** Hovering the Connections tab shows "Relay: 2 connected. Mesh: 4 agents" without clicking. Glanceable system state.
4. **Keyboard shortcut in tooltip:** "Schedules Cmd+2" — the shortcut is discoverable inline, not in docs.
5. **First-open stagger:** On first navigation to Schedules or Connections, items stagger in (40ms per item, first 5 only). Subsequent visits: instant. The view feels alive on first encounter.
6. **Sliding active indicator:** `layoutId` animated underline slides between tabs with spring `stiffness: 280, damping: 32` — matches existing sidebar active patterns.

### Recommendation

**Icon-only horizontal tabs** with CSS `hidden` state persistence, tab badges replacing AgentContextChips, read-only summaries with dialog bridges, and Cmd+1/2/3 keyboard shortcuts.

This approach is minimal, fits the control-panel brand voice, and respects both Kai's glanceability need and Priya's flow preservation requirement. The read-only summary approach ships fast while maintaining clear escape hatches to full management dialogs.

---

## 6) Decisions

| #   | Decision               | Choice                      | Rationale                                                                                                                                                                                                                                                                               |
| --- | ---------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tab visual style       | Icon-only horizontal tabs   | Minimal space, control-panel aesthetic. Icons (MessageSquare, Clock, Plug2) with tooltips showing label + keyboard shortcut. Avoids consumer-app text tabs that would attract the anti-persona.                                                                                         |
| 2   | AgentContextChips fate | Replace with tab badges     | Tab badges now carry the same information — numeric active run count on Schedules, semantic status dot on Connections. Eliminates redundancy and tightens the sidebar.                                                                                                                  |
| 3   | View content depth     | Read-only summaries         | Schedules shows compact upcoming/active runs. Connections shows adapter health + agent roster. Full management stays in existing dialog panels, opened via bridge buttons. Lower complexity, ships faster, keeps sidebar lightweight.                                                   |
| 4   | Keyboard shortcuts     | Cmd+1/2/3 when sidebar open | Registered when sidebar is open. Shown in tab tooltips for discoverability. Matches VS Code, browser, and terminal patterns. Respects Priya's keyboard-first flow.                                                                                                                      |
| 5   | Rename SessionSidebar  | AgentSidebar                | The sidebar now shows more than sessions — it shows schedules, connections, and other agent context. `AgentSidebar` reflects the agent-centric UX direction (spec #85) and that all content is scoped to the current agent/cwd. Rename the component, file, test file, and all imports. |
