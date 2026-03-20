---
slug: switch-agent-via-identity-chip
number: 115
created: 2026-03-10
status: ideation
---

# Switch Agent via Identity Chip Click

**Slug:** switch-agent-via-identity-chip
**Author:** Claude Code
**Date:** 2026-03-10
**Branch:** preflight/switch-agent-via-identity-chip

---

## 1) Intent & Assumptions

- **Task brief:** Make clicking the AgentIdentityChip in the header open the command palette pre-filtered to agents (via `@` prefix in search). Update the command palette to accept initial search text when opened programmatically. Clean up the sidebar: remove AgentHeader entirely, remove the "Switch" button, and add an "Edit Agent" icon to the sidebar footer that opens AgentDialog.
- **Assumptions:**
  - AgentIdentityChip and command palette already exist and are wired up (spec#112)
  - The command palette already supports `@` prefix for agent-only filtering via `usePaletteSearch`
  - The Zustand `app-store.ts` is the correct place for palette open state
  - AgentDialog already handles both create and edit flows
  - Since CWD is being removed from the sidebar, display it in the AgentDialog so it's still accessible
- **Out of scope:**
  - Changes to command palette filtering logic itself
  - Changes to agent switching mechanics
  - Changes to the command palette's visual design

## 2) Pre-reading Log

- `specs/update-top-nav/02-specification.md`: Spec for header redesign; AgentIdentityChip was implemented here, currently opens AgentDialog on click
- `specs/command-palette-10x/02-specification.md`: Command palette enhancements; already supports `@` prefix for agent-only mode
- `specs/agent-centric-ux/02-specification.md`: High-level agent-centric UX overview
- `apps/client/src/layers/features/top-nav/ui/AgentIdentityChip.tsx`: Currently calls `setAgentDialogOpen(true)` on click
- `apps/client/src/layers/features/command-palette/ui/CommandPaletteDialog.tsx`: Main palette dialog; reads search state, supports `@` prefix filtering
- `apps/client/src/layers/features/command-palette/model/use-global-palette.ts`: Zustand hook for palette open state; exposes `setGlobalPaletteOpen`
- `apps/client/src/layers/features/command-palette/model/use-palette-search.ts`: `parsePrefix()` extracts `@` or `>` prefix; Fuse.js fuzzy search
- `apps/client/src/layers/features/session-list/ui/AgentHeader.tsx`: Shows CWD path + "K Switch" button; both being removed
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`: Sidebar container with footer icons (Pulse, Relay, Mesh, Settings)
- `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx`: Modal dialog for agent configuration; needs CWD display added (since CWD is being removed from sidebar)
- `apps/client/src/layers/shared/model/app-store.ts`: Zustand store; has `globalPaletteOpen`, `agentDialogOpen` state
- `research/20260303_command_palette_agent_centric_ux.md`: Prior research on agent-centric command palette patterns
- `research/20260303_command_palette_10x_elevation.md`: Prior research on palette elevation patterns

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/client/src/layers/features/top-nav/ui/AgentIdentityChip.tsx` — Header chip showing active agent; click handler needs rewiring
  - `apps/client/src/layers/features/command-palette/ui/CommandPaletteDialog.tsx` — Main palette dialog; needs initial search support
  - `apps/client/src/layers/features/command-palette/model/use-global-palette.ts` — Palette open state (Zustand)
  - `apps/client/src/layers/features/session-list/ui/AgentHeader.tsx` — Sidebar header; being removed entirely
  - `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` — Sidebar container; footer gets Edit Agent icon
  - `apps/client/src/layers/shared/model/app-store.ts` — Global Zustand store; needs new state/action for initial search

- **Shared dependencies:**
  - `use-palette-search.ts` — Already parses `@` prefix; no changes needed
  - `app-store.ts` — Central state for dialog open/close coordination

- **Data flow:**
  AgentIdentityChip click → `openGlobalPaletteWithSearch('@')` → sets `globalPaletteInitialSearch` + opens palette → CommandPaletteDialog reads initial search → sets `search` state to `'@'` → `usePaletteSearch` parses prefix → filters to agents only

- **Feature flags/config:** None

- **Potential blast radius:**
  - Direct: 6 files (AgentIdentityChip, CommandPaletteDialog, app-store, AgentHeader, SessionSidebar, AgentDialog)
  - Indirect: App.tsx (remove AgentHeader import if it was used there — but it's used in SessionSidebar, not App.tsx)
  - Tests: ~5 test files need updates

## 4) Root Cause Analysis

N/A — not a bug fix.

## 5) Research

- **Potential solutions:**

  **1. Zustand store action**
  - Description: Add `globalPaletteInitialSearch` state, `openGlobalPaletteWithSearch(text)` action, and `clearPaletteInitialSearch()` to `app-store.ts`
  - Pros: Follows existing DorkOS patterns (store-first); clean cross-component communication; composable (any component can open palette with search); testable
  - Cons: Slightly more state to manage (but trivial)
  - Complexity: Low
  - Maintenance: Low

  **2. Custom event dispatch**
  - Description: Dispatch a `palette:open` CustomEvent with search payload; palette listens via `useEffect`
  - Pros: Decoupled; no store changes
  - Cons: Breaks DorkOS's store-first convention; harder to test; imperative pattern in a declarative codebase
  - Complexity: Low
  - Maintenance: Medium (event listeners are harder to trace)

  **3. Imperative ref/handle**
  - Description: Expose `forwardRef` + `useImperativeHandle` on CommandPaletteDialog with `open(search)` method
  - Pros: Direct API
  - Cons: Cannot cross FSD feature boundaries cleanly (ref would need to pass through App.tsx); violates unidirectional data flow; breaks the mounting pattern where palette is at app root
  - Complexity: Medium
  - Maintenance: High

- **Recommendation:** Approach 1 (Zustand store action). It follows existing patterns exactly — `app-store.ts` already manages `globalPaletteOpen` and coordinates dialog open/close. Adding `initialSearch` state is a natural extension. ~15 lines across 4 files.

## 6) Decisions

| #   | Decision                                                   | Choice                         | Rationale                                                                                                                                               |
| --- | ---------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What happens to AgentHeader after removing CWD and Switch? | Remove AgentHeader entirely    | Header info is redundant with AgentIdentityChip in top nav. Sidebar starts directly with New Session button + session list. Cleaner, less visual noise. |
| 2   | Where does the Edit Agent button go?                       | Icon in existing footer row    | Add a Pencil icon alongside Pulse, Relay, Mesh, Settings icons. Consistent with existing pattern, no layout changes needed.                             |
| 3   | Edit Agent button visibility when no agent?                | Always show, opens create flow | One entry point for both create and edit. When no agent exists, clicking opens AgentDialog in creation mode.                                            |
