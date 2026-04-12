---
slug: settings-ui-ux-disambiguation
number: 236
created: 2026-04-12
status: ideation
---

# Settings UI/UX and Disambiguation

**Slug:** settings-ui-ux-disambiguation
**Author:** Claude Code
**Date:** 2026-04-12
**Branch:** preflight/settings-ui-ux-disambiguation

---

## Source Brief

File: `.temp/settings-ui-ux-and-disambiguation.md`

The goal is to clarify the language, iconography, UI/UX and DX between the various global and agent-specific settings interfaces. The user identified specific pain points around the gear icon ambiguity, the confusing "Manage agent" vs "Edit settings" context menu options, the lack of tooltips, and the desire for agent settings to be accessible from more natural entry points like the ChatInputContainer and AgentIdentity component.

---

## 1) Intent & Assumptions

- **Task brief:** Disambiguate and simplify the multiple overlapping settings surfaces in DorkOS — global settings, agent settings dialog, agent context menu, and session sidebar — into a coherent, intuitive system that follows world-class UX patterns.

- **Assumptions:**
  - The current multi-surface approach (separate agent settings dialog + session sidebar + global settings) creates genuine user confusion, not just cosmetic friction
  - Users think of an agent as a single entity and want one canonical place for "everything about this agent"
  - The extension system's documented gap ("no extensible slot for persistent right-side UI") should be addressed as part of this work
  - The existing `react-resizable-panels` and extension registry patterns are the right foundations to build on

- **Out of scope:**
  - Global settings dialog internal restructuring (tab overflow, left-nav layout) — already covered by existing research and specs
  - Extension API design for third-party right-panel contributions (Phase 2, after UX stabilizes)
  - Mobile-specific redesign (mobile follows existing Sheet fallback patterns)

---

## 2) Pre-reading Log

- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx`: Global settings dialog with 8 tabs (Appearance, Preferences, Status Bar, Server, Tools, Channels, Agents, Advanced). Uses `Settings2` icon.
- `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx`: Agent settings dialog with 4 tabs (Identity, Channels, Personality, Tools). Opened via `useAppStore.setAgentDialogOpen(true)`. Supports deep-linking via `?agent=identity&agentPath=...`.
- `apps/client/src/layers/features/dashboard-sidebar/ui/AgentContextMenu.tsx`: Context menu with Pin/Unpin, Manage agent (`ListTree` icon), Edit settings (`Settings` icon), New session (`Plus` icon).
- `apps/client/src/layers/features/dashboard-sidebar/ui/AgentListItem.tsx`: Dropdown menu (`...` button) mirrors context menu identically. Both call `onManage()` and `onEditSettings()`.
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`: Session management sidebar with tabs: Overview, Sessions, Schedules/Tasks, Connections. Opened by "Manage agent" navigating to `/session?dir=agentPath`.
- `apps/client/src/layers/features/session-list/ui/SidebarFooterBar.tsx`: Footer bar with Settings gear (no tooltip), Theme cycle, Devtools (dev-only), Tunnel status.
- `apps/client/src/layers/shared/model/sidebar-contributions.ts`: Registration for sidebar footer buttons via contribution system.
- `apps/client/src/layers/shared/model/extension-registry.ts`: Zustand-based extension registry with 8 contribution slots. No `rightpanel` slot exists. Built-in features dogfood the same API as third-party extensions.
- `apps/client/src/layers/features/canvas/ui/AgentCanvas.tsx`: Canvas as resizable right panel (desktop) or Sheet (mobile). Returns `null` when closed. Lives inside SessionPage's `PanelGroup`.
- `apps/client/src/layers/widgets/session/ui/SessionPage.tsx`: Only page with `PanelGroup` layout (chat + canvas). All other pages are single-column.
- `apps/client/src/AppShell.tsx`: Shared layout wrapper — `SidebarProvider` with Sidebar (left) + `SidebarInset` (header + `<Outlet />`). Each page owns its own content area layout.
- `apps/client/src/router.tsx`: 7 routes under AppShell — `/` (Dashboard), `/session`, `/agents`, `/tasks`, `/activity`, `/marketplace`, `/marketplace/sources`.
- `apps/client/src/layers/entities/agent/ui/AgentIdentity.tsx`: Presentation-only component (avatar + name + optional detail). Used in sidebar list items, chat input shortcuts, agent settings preview. Not currently an interactive entry point.
- `research/20260328_multi_panel_toggle_ux_patterns.md`: Comprehensive research on right-panel toggle patterns. Key findings: always-visible toggle button in header top-right, symmetric with left sidebar toggle, keyboard shortcut following VS Code convention (`⌥⌘B`). Cursor's saga of removing/restoring the toggle button is a cautionary tale.
- `research/20260311_tab_overflow_settings_navigation_patterns.md`: Left-sidebar two-column layout recommended for 6+ tabs.
- `research/20260310_switch_agent_via_identity_chip.md`: Establishes the AgentIdentity chip as an interactive element pattern.
- `packages/extension-api/src/extension-api.ts`: Public ExtensionAPI interface with `registerComponent`, `registerCommand`, `registerDialog`, `registerSettingsTab`, `openCanvas`, `isSlotAvailable`.

---

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` — Global settings dialog (8 tabs)
- `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx` — Agent settings dialog (4 tabs)
- `apps/client/src/layers/features/dashboard-sidebar/ui/AgentContextMenu.tsx` — Right-click context menu on agents
- `apps/client/src/layers/features/dashboard-sidebar/ui/AgentListItem.tsx` — Agent list item with dropdown menu
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` — Session management sidebar
- `apps/client/src/layers/features/session-list/ui/SidebarFooterBar.tsx` — Sidebar footer with settings entry point
- `apps/client/src/layers/features/canvas/ui/AgentCanvas.tsx` — Canvas right panel (session-scoped)
- `apps/client/src/layers/widgets/session/ui/SessionPage.tsx` — Session page with PanelGroup
- `apps/client/src/AppShell.tsx` — Shared app layout (sidebar + header + outlet)
- `apps/client/src/layers/entities/agent/ui/AgentIdentity.tsx` — Agent identity display component
- `apps/client/src/layers/shared/model/extension-registry.ts` — Extension contribution registry

**Shared Dependencies:**

- `react-resizable-panels` — Used by canvas PanelGroup, will be used by shell-level right panel
- `apps/client/src/layers/shared/model/app-store-canvas.ts` — Zustand canvas state (open/closed, content, preferred width)
- `apps/client/src/layers/shared/model/sidebar-contributions.ts` — Sidebar footer button registration
- `@radix-ui/react-dialog` — Used by both settings and agent dialogs
- `lucide-react` — Icon library (Settings, ListTree, User, Radio, Sparkles, Wrench, etc.)

**Data Flow:**

```
User interaction (context menu / identity chip / keyboard shortcut / command palette)
  → Zustand store (right panel state: open/closed, active tab)
    → AppShell PanelGroup renders right panel
      → Agent Hub tab (configuration + activity views)
      → Canvas tab (session-scoped content)
      → Future extension tabs
```

**Feature Flags/Config:**

- None identified. Canvas open/closed state persisted per-session in localStorage.

**Potential Blast Radius:**

- **Direct:** AppShell.tsx (new PanelGroup), SessionPage.tsx (remove internal PanelGroup), AgentCanvas.tsx (becomes right-panel tab), AgentDialog.tsx (replaced by hub), SessionSidebar.tsx (absorbed into hub), AgentContextMenu.tsx (simplified), AgentListItem.tsx (simplified), SidebarFooterBar.tsx (tooltip changes), extension-registry.ts (new `rightpanel` slot)
- **Indirect:** All components that open the agent dialog or navigate to session sidebar (DashboardSidebar.tsx, command palette items, deep-link handlers)
- **Tests:** AgentDialog.test.tsx, AgentContextMenu.test.tsx, AgentListItem.test.tsx, SettingsDialog.test.tsx, SessionSidebar tests, canvas tests, e2e settings tests

---

## 4) Root Cause Analysis

_Not applicable — this is a UX improvement, not a bug fix._

---

## 5) Research

### Settings Navigation in World-Class Apps

- **Discord:** Gear icon bottom-left is permanently labeled "User Settings" (global). Server settings accessed by clicking server name — entry point is bound to the entity, not ambient chrome. The two never share the same trigger.
- **VS Code:** Gear icon bottom-left always opens global User Settings. Workspace settings accessible via Command Palette or explorer context menus. Structurally different surfaces with different entry points.
- **Slack:** Global settings behind avatar/profile — not a gear icon. Channel settings via channel header. Workspace settings via workspace name. Three distinct entry points, zero ambiguity.
- **Linear:** User settings in account avatar bottom-left. Project/team settings accessed by clicking team name. No shared icon between scopes.
- **Cursor:** Model/agent indicator in input bar is the settings gateway for current context. Established pattern for chat-adjacent settings access.

**Universal pattern:** Global settings trigger anchored to user identity or app brand. Per-entity settings anchored to the entity itself.

### Context Menu Best Practices

- **NN/G and Apple HIG converge:** Verb-first, destination-clear labels. "Manage" is one of the most overloaded words in product UX — avoid entirely.
- **Figma:** Right-click shows "Edit component", "Go to main component" — all verb-first, action-clear.
- **Linear:** Right-click shows "Copy issue ID", "Assign to...", "Change status" — every label tells you exactly what happens.

### The Agent Hub Pattern (Industry Convergence 2024-2025)

Every major platform managing AI agents (GitHub Agent HQ, Microsoft Dynamics Agent Hub, Dataiku Agent Hub) converged on a single "Agent Hub" surface combining configuration, activity history, connection management, and monitoring. This reflects a user mental model insight: users think of an agent as a single entity and want one place for everything about it.

### Extension Panel Systems

- **VS Code Secondary Sidebar:** Shell-level contribution point. Built-in views and extensions use the same API. Added in 2022, extension API stabilized 2025. Multi-container with activity bar icons.
- **Obsidian:** Right sidebar is a workspace leaf container. Plugins call `getRightLeaf()` at runtime. Multiple plugins coexist as tabs.
- **JetBrains:** Tool windows registered in plugin.xml with `anchor="right"`. Primary/secondary groups per side. All get buttons in the tool window bar.
- **Universal finding:** Every extensible app provides a right panel at the shell level. The pattern is left=navigation, right=contextual/auxiliary.

### Right-Panel Toggle UX (from existing internal research)

- Always-visible toggle button in header top-right, symmetric with left sidebar toggle
- Keyboard shortcut following modifier convention (e.g., left=`⌘B`, right=`⌥⌘B`)
- Button must always render regardless of panel state (Cursor's removal/restoration saga is cautionary)
- Mobile: collapse to Sheet at 768px breakpoint
- State indicator: dot on toggle button when closed panel has active content

### Panel Conflict Resolution

Research across VS Code, Obsidian, JetBrains, and Chrome found: **design for multi-occupancy from the start.** Every app that started with single-occupancy expanded to multi-occupancy or created user frustration. Tabs within the right panel are the dominant resolution pattern.

### Steve Jobs / Jony Ive Design Philosophy

_"When you first start off trying to solve a problem, the first solutions you come up with are very complex, and most people stop there. But if you keep going, and live with the problem and peel more layers of the onion off, you can often times arrive at some very elegant and simple solutions."_

The simplest model: one agent, one place. The agent's face is the door to everything about the agent.

---

## 6) Decisions

| #   | Decision                               | Choice                                                | Rationale                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Unified Agent Hub vs separate surfaces | **Unified Agent Hub**                                 | The fragmented mental model (two surfaces for one entity) is the root cause of confusion, not the naming. Industry convergence on agent hubs confirms users want one canonical place per entity. Renaming only treats the symptom.                                                                                                                                                       |
| 2   | Surface type for the Agent Hub         | **Right panel (canvas area), side-by-side with chat** | The canvas already demonstrates this pattern — resizable panel beside chat via `react-resizable-panels`. Users can reference the conversation while configuring. Follows the user's own instinct from the brief.                                                                                                                                                                         |
| 3   | Right panel scope                      | **Shell-level (AppShell), not page-level**            | The extension registry has a documented gap: "no extensible slot for persistent right-side UI." A shell-level panel fills this gap, makes the hub available on all pages (not just SessionPage), and follows VS Code/Obsidian/JetBrains where the right panel is a shell-level construct. The canvas moves from SessionPage's PanelGroup to become a tab in the shell-level right panel. |
| 4   | Agent Hub and Canvas coexistence       | **Tabbed right panel (multi-occupancy)**              | Research found every app that started with single-occupancy expanded to multi-occupancy. Tabs allow Agent Hub, Canvas, and future extension panels to coexist. Tab bar can be minimal (icons only) and hidden when only one panel is registered.                                                                                                                                         |
| 5   | Agent Hub entry points                 | **Four entry points, one destination**                | AgentIdentity chip (primary discovery), context menu ("Agent profile"), keyboard shortcut, and command palette. Follows VS Code/Linear pattern: one canonical destination, many lightweight shortcuts.                                                                                                                                                                                   |
| 6   | Agent Hub internal organization        | **Grouped sections, 6 concise tabs**                  | Overview (identity + stats), Personality, Sessions, Channels (config + status merged), Tasks, Tools. Left-nav sidebar layout inside the hub (per existing tab overflow research). Merges related concepts (Channels + Connections) to stay at 6 tabs.                                                                                                                                    |
| 7   | Global settings disambiguation         | **Add "App" qualifier**                               | Gear icon tooltip → "App Settings". Dialog title → "App Settings". The word "App" is the scope signal that resolves the proximity-implies-scope confusion on session pages. Minimal change, outsized impact.                                                                                                                                                                             |
| 8   | Context menu simplification            | **"Agent profile" replaces both items**               | "Manage agent" + "Edit settings" collapse into single "Agent profile" entry. "Open agent" was rejected because it implies starting a conversation. "Agent profile" naturally encompasses both configuration and activity, matching LinkedIn/GitHub mental model.                                                                                                                         |

---

## 7) Proposed Architecture

### Shell-Level Right Panel

```
AppShell (revised)
├── Sidebar (left, unchanged)
└── SidebarInset
    ├── Header
    │   ├── [existing left content]
    │   └── Right Panel toggle button (top-right, always visible)
    └── PanelGroup (horizontal) ← NEW at AppShell level
        ├── Panel (Outlet — page content)
        │   ├── SessionPage (just ChatPanel, no internal PanelGroup)
        │   ├── DashboardPage (unchanged)
        │   ├── AgentsPage (unchanged)
        │   └── ...other pages
        └── RightPanel (conditionally rendered)
            ├── Tab bar (minimal icons, hidden when single tab)
            ├── Agent Hub tab
            │   ├── Left nav: Overview | Personality | Sessions | Channels | Tasks | Tools
            │   └── Content area for active section
            ├── Canvas tab (session-scoped, visible when on /session)
            └── Future extension tabs (via rightpanel contribution slot)
```

### Agent Hub Internal Layout

```
┌─────────────────────────────────────┐
│ Agent Avatar + Name        [×] Close│  ← Hub header
├──────────┬──────────────────────────┤
│ Overview │                          │
│ Personal.│   Active section         │
│ Sessions │   content area           │
│ Channels │                          │
│ Tasks    │                          │
│ Tools    │                          │
├──────────┴──────────────────────────┤
```

### Context Menu (Simplified)

```
Pin agent / Unpin agent
─────────────────────
Agent profile            → Opens Agent Hub in right panel
New session              → Creates new session with this agent
```

### Entry Points Map

```
AgentIdentity chip (anywhere)  ──→  Agent Hub (right panel)
Context menu: "Agent profile"  ──→  Agent Hub (right panel)
Keyboard shortcut (TBD)        ──→  Agent Hub (right panel)
Command palette: "Agent profile: [Name]" ──→ Agent Hub (right panel)
Gear icon (sidebar footer)     ──→  App Settings dialog (unchanged)
```

### Extension Registry Addition

New contribution slot: `rightpanel`

```typescript
interface RightPanelContribution {
  id: string;
  title: string;
  icon: LucideIcon;
  component: ComponentType;
  visibleWhen?: () => boolean; // e.g., canvas only on /session
  priority?: number;
}
```

Built-in contributions registered via `initializeExtensions()`:

- Agent Hub (priority 1, always visible)
- Canvas (priority 2, visible when on `/session` route)

---

## 8) Questions We're Not Asking (From Research)

These emerged from the research and are worth keeping in mind during specification:

1. **How does this scale as more agent settings are added?** The 6-tab hub with left-nav layout is forward-compatible for 8-10 tabs. Beyond that, consider grouping (Configure / Activity sections) or search within settings.

2. **Should settings be contextual?** The hub always shows settings for the agent currently selected in the sidebar. This makes "which agent am I editing?" irrelevant — the current context is always the scope.

3. **Configure once or configure often?** For power users who rapidly tweak personality to improve responses, the persistent right panel (vs. a dialog) is a significant UX improvement — they can tweak and immediately see results in the chat.

4. **Does the left sidebar conceptually belong to the agent or the workspace?** With the hub absorbing the session sidebar's content, the left sidebar becomes purely workspace-level navigation (all agents, global nav). This is a cleaner separation.

5. **Keyboard-first as the primary bet?** DorkOS users are developers. Command palette coverage of all settings actions may be more impactful than visual redesign for power users. Ensure every hub section is reachable via `Cmd+K`.
