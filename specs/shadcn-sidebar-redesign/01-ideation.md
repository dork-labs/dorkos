---
slug: shadcn-sidebar-redesign
number: 86
created: 2026-03-03
status: ideation
---

# Shadcn Sidebar Redesign — Agent-Centric Sidebar with Glanceable Status

**Slug:** shadcn-sidebar-redesign
**Author:** Claude Code
**Date:** 2026-03-03
**Branch:** preflight/shadcn-sidebar-redesign

---

## 1) Intent & Assumptions

- **Task brief:** Replace the custom 392-line sidebar implementation with Shadcn's Sidebar component. Redesign the layout to give the agent identity header breathing room, add glanceable agent context chips (Pulse/Relay/Mesh status), lift all dialog ownership from SessionSidebar to App.tsx, and delete ~200 lines of custom mobile overlay/push animation code. The sidebar close button (currently compressing the agent header) moves to `SidebarInset` as a `SidebarTrigger`.
- **Assumptions:**
  - Shadcn Sidebar is fully compatible with React 19 + Tailwind v4 (confirmed by research)
  - The mobile breakpoint (768px) matches exactly between Shadcn and DorkOS's `useIsMobile()`
  - Zustand's `sidebarOpen` can drive `SidebarProvider` via controlled `open`/`onOpenChange` props
  - Agent context chips can use existing entity hooks (`usePulseEnabled`, `useActiveRunCount`, `useRelayEnabled`, `useRelayAdapters`, `useRegisteredAgents`)
  - The command palette (spec #85) is already implemented and mounted at App.tsx level
  - Embedded mode (Obsidian plugin) keeps its current custom overlay implementation unchanged
- **Out of scope:**
  - Collapsible icon-only rail mode (future iteration — Shadcn supports `collapsible="icon"` when ready)
  - Relay/Pulse/Mesh panel content redesigns
  - Agent persona editing flows
  - Mobile-native app considerations
  - Onboarding flow redesign (ProgressCard just moves to new footer location)

## 2) Pre-reading Log

- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`: 392-line monolith. Owns 7 dialog instances, onboarding overlay, Pulse notification toasts, tab badge logic, and all sidebar UI. Primary refactoring target.
- `apps/client/src/layers/features/session-list/ui/AgentHeader.tsx`: 133 lines. Shows agent identity with colored dot, emoji, name, description, path. Has separate agent/no-agent states. The `K Switch` button and gear icon compete with the sidebar close button on the same row — this is the core visual compression problem.
- `apps/client/src/layers/features/session-list/ui/SessionItem.tsx`: 176 lines. Expand/collapse session rows with motion animations. No changes needed.
- `apps/client/src/App.tsx`: 280 lines. Contains 3 separate sidebar implementations: embedded overlay (lines 89-169), standalone mobile overlay (lines 219-244), standalone desktop push (lines 246-256). All use motion.dev `AnimatePresence`. ~150 lines of sidebar layout code can be replaced by `SidebarProvider`.
- `apps/client/src/layers/shared/model/app-store.ts`: Zustand store already manages `sidebarOpen`, `settingsOpen`, `pulseOpen`, `relayOpen`, `meshOpen`, `pickerOpen`, `globalPaletteOpen`. All dialog state is already centralized here — only the JSX rendering is distributed in SessionSidebar.
- `apps/client/src/layers/shared/ui/`: 17 Shadcn primitives installed. No `sidebar.tsx` yet. `command.tsx` already present.
- `apps/client/components.json`: Shadcn config with `new-york` style, `@/layers/shared/ui` path alias.
- `apps/client/src/index.css`: CSS custom properties for neutral gray palette. Missing `--sidebar-*` variables required by Shadcn Sidebar.
- `apps/client/src/layers/entities/pulse/index.ts`: Exports `usePulseEnabled`, `useActiveRunCount`, `useCompletedRunBadge` — all needed for Pulse status chip.
- `apps/client/src/layers/entities/relay/index.ts`: Exports `useRelayEnabled`, `useRelayAdapters` — needed for Relay status chip.
- `apps/client/src/layers/entities/mesh/index.ts`: Exports `useRegisteredAgents`, `useMeshStatus` — needed for Mesh status chip.
- `contributing/design-system.md`: Sidebar width documented as 256px, but current implementation uses 320px (`w-80`). Motion timing: 200ms ease-out for enter/exit.
- `research/20260303_shadcn_sidebar_redesign.md`: Full research report covering Shadcn Sidebar API, Zustand integration, mobile Sheet behavior, Tailwind v4 compatibility, CSS variable requirements, and dialog lifting patterns.
- `specs/agent-centric-ux/01-ideation.md`: Parent spec (85) that established the agent-centric UX vision, command palette, and initial sidebar redesign direction. This spec (#86) focuses specifically on the Shadcn Sidebar migration and agent context chips.
- `meta/personas/the-autonomous-builder.md`: Kai — runs 10+ agents across 5 projects, needs quick agent switching and at-a-glance status. "I don't need another chatbot wrapper. I need my agents to work while I sleep and tell me what they did."
- `meta/personas/the-knowledge-architect.md`: Priya — values clean architecture and seamless cross-client sessions. "It just... stays out of the way."

## 3) Codebase Map

**Primary components/modules:**

| File                                                                 | Role                           | Change needed                                                                                |
| -------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `apps/client/src/layers/shared/ui/sidebar.tsx`                       | Shadcn Sidebar primitive (NEW) | Install via `pnpm dlx shadcn@latest add sidebar`                                             |
| `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` | Main sidebar component         | Major refactor — use SidebarHeader/Content/Footer, remove dialog ownership                   |
| `apps/client/src/layers/features/session-list/ui/AgentHeader.tsx`    | Agent identity header          | Refactor — remove close button from row, give header breathing room                          |
| `apps/client/src/layers/features/session-list/ui/SessionItem.tsx`    | Session list items             | Minor — wrap in SidebarMenuItem/SidebarMenuButton                                            |
| `apps/client/src/App.tsx`                                            | Root layout                    | Major — replace custom overlay/push layout with SidebarProvider, add DialogHost              |
| `apps/client/src/layers/shared/model/app-store.ts`                   | Zustand store                  | Minor — add `agentDialogOpen`/`setAgentDialogOpen` (currently local state in SessionSidebar) |
| `apps/client/src/index.css`                                          | CSS variables                  | Add `--sidebar-*` variable declarations                                                      |
| `contributing/design-system.md`                                      | Design system docs             | Update sidebar section                                                                       |

**New files to create:**

| File                                                                    | Role                                     |
| ----------------------------------------------------------------------- | ---------------------------------------- |
| `apps/client/src/layers/features/session-list/ui/AgentContextChips.tsx` | Glanceable Pulse/Relay/Mesh status chips |
| `apps/client/src/layers/features/session-list/ui/SidebarFooterBar.tsx`  | Footer with branding + settings + theme  |

**Shared dependencies:**

- `@/layers/shared/ui` — Sidebar\*, Tooltip, ResponsiveDialog (existing)
- `@/layers/shared/model` — app-store (Zustand), useIsMobile, useTheme
- `@/layers/shared/lib` — cn, shortenHomePath, groupSessionsByTime
- `@/layers/entities/pulse` — usePulseEnabled, useActiveRunCount, useCompletedRunBadge
- `@/layers/entities/relay` — useRelayEnabled, useRelayAdapters
- `@/layers/entities/mesh` — useRegisteredAgents, useMeshStatus
- `@/layers/entities/agent` — useCurrentAgent, useAgentVisual
- `@/layers/entities/session` — useSessions, useSessionId, useDirectoryState

**Data flow:**

```
App.tsx
├── SidebarProvider (open={sidebarOpen}, onOpenChange={setSidebarOpen})
│   ├── Sidebar (collapsible="offcanvas")
│   │   ├── SidebarHeader → AgentHeader + NewSession button
│   │   ├── SidebarContent → Session list (SidebarMenu + SidebarGroup)
│   │   └── SidebarFooter → AgentContextChips + SidebarFooterBar
│   └── SidebarInset
│       ├── header → SidebarTrigger (replaces floating PanelLeft button)
│       └── main → ChatPanel | ChatEmptyState
├── DialogHost (Settings, Pulse, Relay, Mesh, DirectoryPicker, AgentDialog)
├── CommandPaletteDialog (already here)
└── Toaster (already here)
```

**Potential blast radius:**

- Direct: ~8 files (SessionSidebar, AgentHeader, App.tsx, app-store, index.css, new chips, new footer)
- Indirect: ~3 files (embedded mode in App.tsx preserved, onboarding ProgressCard repositioned)
- Tests: ~3 test files (SessionSidebar.test.tsx, AgentHeader.test.tsx — simplified, SessionItem.test.tsx — minor)

## 5) Research

**From `research/20260303_shadcn_sidebar_redesign.md` (18 sources):**

### Potential Solutions

**1. Full Shadcn Sidebar Migration (Recommended)**

- Description: Replace the custom motion.dev layout with `SidebarProvider` + `Sidebar` + `SidebarInset` for the standalone path. Keep embedded mode unchanged. Controlled `open`/`onOpenChange` bridges to Zustand.
- Pros: Eliminates ~200 lines of custom sidebar/overlay code; free mobile Sheet with backdrop, swipe-to-close, auto-close-on-nav; built-in keyboard shortcut (Cmd+B); collapsible icon mode available for future; ARIA accessibility handled
- Cons: Requires `--sidebar-*` CSS variables in index.css; mobile/desktop state separation (minor Zustand update); SidebarProvider wraps most of App.tsx
- Complexity: Medium
- Maintenance: Low (Shadcn-maintained)

**2. Partial Migration (Menu Components Only)**

- Description: Keep App.tsx layout, use SidebarMenu/SidebarMenuItem inside SessionSidebar for consistent item styling
- Pros: Minimal layout disruption; motion animations preserved
- Cons: Still maintaining 392-line monolith; menu components are tightly coupled to SidebarProvider context (may not work standalone); doesn't fix the mobile overlay complexity
- Complexity: Low
- Maintenance: High (still custom overlay code)

**3. Shadcn Sheet for Mobile Only**

- Description: Keep desktop push sidebar, replace mobile overlay with Shadcn Sheet
- Pros: Gets native Sheet on mobile; desktop animation stays custom
- Cons: Bifurcated implementation; misses unified state management
- Complexity: Low-Medium
- Maintenance: Medium

### Key Research Findings

- **Controlled mode**: `SidebarProvider` accepts `open`/`onOpenChange` props for external state control. Zustand connects via `<SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>`.
- **Mobile/desktop state split**: Shadcn tracks `open` (desktop) and `openMobile` (mobile Sheet) separately. The simplest approach: only control desktop state via Zustand; let mobile Sheet state be internal to Shadcn.
- **Breakpoint match**: Shadcn uses `MOBILE_BREAKPOINT = 768` — exactly matches DorkOS's `useIsMobile()` at `max-width: 767px`.
- **CSS variables required**: `--sidebar-background`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-accent`, `--sidebar-border`, `--sidebar-ring` must be defined in `:root` and `.dark`. Calibrated to DorkOS's pure neutral gray palette.
- **Sidebar width**: Default is `16rem` (256px), customizable via `--sidebar-width` CSS property on SidebarProvider style prop. Current DorkOS uses 320px (`w-80`).
- **Built-in Cmd+B**: Shadcn Sidebar has a built-in `SIDEBAR_KEYBOARD_SHORTCUT = "b"` — the custom Cmd+B handler in App.tsx can be removed.
- **Embedded mode exception**: `SidebarProvider` requires `SidebarInset` as sibling to `Sidebar` — this DOM structure doesn't fit Obsidian's `ItemView` container. Keep embedded mode's custom overlay unchanged.
- **Dialog lifting**: Move all 7 dialogs to a `DialogHost` component rendered after `SidebarProvider` in App.tsx. Zustand already holds all open/close state — only JSX rendering moves.

### Recommendation

**Full Shadcn Sidebar Migration (Option 1)** for the standalone path, preserving embedded mode as-is. This gives the highest quality improvement for the lowest ongoing maintenance. The migration is safe because all state already lives in Zustand, and the Shadcn component handles the complex parts (mobile Sheet, keyboard nav, ARIA, responsive layout).

## 6) Decisions

| #   | Decision                  | Choice                                           | Rationale                                                                                                                                                      |
| --- | ------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sidebar component         | Shadcn Sidebar (full migration)                  | Battle-tested, handles mobile/desktop, built-in keyboard shortcuts, ARIA accessibility. Deletes ~200 lines of custom code.                                     |
| 2   | Dialog ownership          | Lift all to App.tsx `DialogHost`                 | Sidebar becomes pure navigation. Dialogs survive sidebar unmount on mobile. Zustand already has all state.                                                     |
| 3   | Agent context section     | Glanceable status chips in SidebarFooter         | iOS Control Center-inspired — compact, always visible, tappable to open full panels. Shows Pulse/Relay/Mesh status for current agent.                          |
| 4   | Sidebar trigger placement | `SidebarTrigger` in `SidebarInset` header        | Removes the close button from the agent header row, eliminating the compression problem. Standard Shadcn pattern.                                              |
| 5   | Embedded mode             | Keep custom overlay unchanged                    | Shadcn's DOM structure (SidebarInset as sibling) doesn't fit Obsidian's ItemView container. Separate code paths.                                               |
| 6   | Mobile state              | Let Shadcn own mobile Sheet state internally     | Desktop `sidebarOpen` connects to Zustand. Mobile Sheet state doesn't need persistence (resets each visit — correct UX). Simplest approach.                    |
| 7   | Sidebar width             | Keep 320px via `--sidebar-width: 20rem`          | Current width works well. Design system says 256px but 320px has been the shipped width.                                                                       |
| 8   | CSS integration           | Add `--sidebar-*` variables to `index.css`       | Required by Shadcn Sidebar. Calibrated to pure neutral gray palette. Sidebar background slightly different from main background for subtle visual distinction. |
| 9   | Keyboard shortcut         | Remove custom Cmd+B handler, use Shadcn built-in | Shadcn Sidebar has `SIDEBAR_KEYBOARD_SHORTCUT = "b"` built in. One fewer custom effect in App.tsx.                                                             |
