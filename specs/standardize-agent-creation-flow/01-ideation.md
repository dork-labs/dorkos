---
slug: standardize-agent-creation-flow
number: 232
created: 2026-04-11
status: ideation
---

# Standardize Agent Creation Flow

**Slug:** standardize-agent-creation-flow
**Author:** Claude Code
**Date:** 2026-04-11
**Branch:** preflight/standardize-agent-creation-flow

---

## 1) Intent & Assumptions

- **Task brief:** Standardize and improve the agent creation flow across the entire DorkOS client. Currently agents can be created via 5+ entry points using inconsistent mechanisms — two different dialog systems, two different hooks, and a separate discovery dialog. The goal is a single, unified three-tab creation dialog used everywhere (except onboarding, which keeps its own UI but converges on the same underlying API).
- **Assumptions:**
  - The existing `CreateAgentDialog` is the foundation to evolve, not replace from scratch
  - The existing `DiscoveryView` component is reusable as-is for the Import tab
  - The server-side `createAgentWorkspace()` pipeline is solid and doesn't need changes
  - Marketplace templates replace built-in templates as the canonical template source
  - Onboarding's `useInitAgent` hook should converge onto `useCreateAgent` or share the same server endpoint
- **Out of scope:**
  - Onboarding UI redesign (keeps its own flow)
  - Agent settings/editing dialog changes
  - Server-side agent creation pipeline changes
  - CLI/MCP tool creation paths

## 2) Pre-reading Log

- `apps/client/src/layers/features/agent-creation/ui/CreateAgentDialog.tsx`: Current creation dialog — name, directory, collapsible template picker, collapsible personality sliders. Uses `useAgentCreationStore` (Zustand) for open/close.
- `apps/client/src/layers/features/agent-creation/ui/TemplatePicker.tsx`: Three-source template picker (built-in, Dork Hub marketplace, custom GitHub URL). Built-in to be removed.
- `apps/client/src/layers/features/agent-creation/model/use-create-agent.ts`: TanStack Query mutation hook → `transport.createAgent(opts)`. Full creation pipeline.
- `apps/client/src/layers/features/agent-creation/model/use-template-catalog.ts`: Fetches built-in templates via `transport.getTemplates()`. To be deleted with built-in templates.
- `apps/client/src/layers/features/top-nav/ui/AgentsHeader.tsx`: Two buttons — "New Agent" (opens CreateAgentDialog) and "Search for Projects" (opens separate ResponsiveDialog with DiscoveryView). After this work: single button opens unified dialog.
- `apps/client/src/layers/features/mesh/ui/DiscoveryView.tsx`: Self-contained discovery/import component. Has `fullBleed` prop for layout flexibility. Manages own scan state, root paths, progressive results, bulk import. Will be reused as Import tab content.
- `apps/client/src/layers/features/dashboard-sidebar/ui/AddAgentMenu.tsx`: Popover with "Create agent" option. Currently calls `setAgentDialogOpen(true)` — **bug**: opens editing dialog, not creation dialog.
- `apps/client/src/layers/features/session-list/ui/SidebarTabRow.tsx`: + button calls `setAgentDialogOpen(true)` — same bug as AddAgentMenu.
- `apps/client/src/layers/features/command-palette/model/palette-contributions.ts`: "Create agent" command. Correctly uses `useAgentCreationStore.getState().open()`.
- `apps/client/src/layers/features/command-palette/model/use-palette-actions.ts`: Handler for create agent action. Already wired correctly.
- `apps/client/src/layers/shared/model/agent-creation-store.ts`: Zustand store `{ isOpen, open(), close() }`. Used by CreateAgentDialog for visibility.
- `apps/client/src/layers/shared/model/app-store/app-store-panels.ts`: `setAgentDialogOpen()` controls the **editing** dialog (AgentDialog), not creation. Source of the sidebar/session list bug.
- `apps/client/src/layers/features/onboarding/ui/NoAgentsFound.tsx`: Creates first agent during onboarding using `useInitAgent()` — different, simpler hook than `useCreateAgent()`.
- `apps/client/src/layers/entities/agent/model/use-init-agent.ts`: Simpler creation hook used only by onboarding. Calls `transport.initAgent(path, name, description, runtime)`.
- `apps/server/src/services/core/agent-creator.ts`: Server-side `createAgentWorkspace()` — validates, creates directory, optionally clones template, scaffolds `.dork/` with `agent.json`, `SOUL.md`, `NOPE.md`.
- `apps/server/src/routes/agents.ts`: POST `/api/agents` (init existing dir) and POST `/api/agents/create` (full pipeline with mkdir).
- `specs/agent-creation-and-templates/`: Prior spec covering creation pipeline, naming conventions, template system.

## 3) Codebase Map

**Primary Components/Modules:**

| File                                                      | Role                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| `features/agent-creation/ui/CreateAgentDialog.tsx`        | Main creation dialog (to be redesigned with tabs)                   |
| `features/agent-creation/ui/TemplatePicker.tsx`           | Template picker (to be simplified: marketplace only + advanced URL) |
| `features/agent-creation/model/use-create-agent.ts`       | Creation mutation hook (keep)                                       |
| `features/agent-creation/model/store.ts`                  | Re-exports from shared layer (keep)                                 |
| `features/agent-creation/model/use-template-catalog.ts`   | Built-in template catalog hook (delete)                             |
| `features/mesh/ui/DiscoveryView.tsx`                      | Discovery/import view (reuse as Import tab)                         |
| `features/top-nav/ui/AgentsHeader.tsx`                    | Page header with action buttons (simplify to single button)         |
| `features/dashboard-sidebar/ui/AddAgentMenu.tsx`          | Sidebar + menu (fix: wire to creation store)                        |
| `features/session-list/ui/SidebarTabRow.tsx`              | Session sidebar + button (fix: wire to creation store)              |
| `features/command-palette/model/palette-contributions.ts` | Cmd+K create action (already correct)                               |

**Shared Dependencies:**

- `shared/model/agent-creation-store.ts` — Zustand store for dialog visibility
- `shared/ui/` — Dialog, Tabs, Button, Input, Label, Collapsible components
- `entities/agent/` — TraitSliders (removed from dialog), useInitAgent (onboarding convergence)
- `entities/mesh/` — useMeshScanRoots, useRegisteredAgents, useRegisterAgent
- `entities/discovery/` — useDiscoveryScan, useDiscoveryStore, CandidateCard, BulkAddBar, etc.
- `@dorkos/shared/validation` — validateAgentName
- `@dorkos/shared/mesh-schemas` — DiscoveryCandidate type

**Data Flow:**
User opens dialog (any entry point) → `useAgentCreationStore.open()` → CreateAgentDialog renders → User picks tab (New/Template/Import) → Tab-specific form → Submit → `useCreateAgent.mutate()` or `useRegisterAgent.mutate()` → Server creates/registers agent → Dialog closes → Agent list refreshes

**Feature Flags/Config:**

- `config.agents.defaultDirectory` — default location for new agents (from server config)

**Potential Blast Radius:**

- Direct: CreateAgentDialog, TemplatePicker, AgentsHeader, AddAgentMenu, SidebarTabRow (5 files)
- Indirect: DiscoveryView (embedded, not changed), command palette (already correct), tests for all modified components
- Deletions: use-template-catalog.ts, built-in template server code

## 4) Root Cause Analysis

N/A — this is a feature improvement, not a bug fix. (Though two bugs will be fixed as part of this work: AddAgentMenu and SidebarTabRow opening the wrong dialog.)

## 5) Research

### Multi-Path Creation Dialogs

**1. Three-Tab Dialog (GitHub Desktop / Vercel pattern)**

- Description: Tabs at top ("New Agent", "From Template", "Discover & Import"), form content swaps per tab. Path selection is the first interaction.
- Pros: Clear mental model, one dialog for everything, tabs are discoverable, familiar pattern
- Cons: Dialog may feel wide/tall to accommodate all three tab contents
- Complexity: Medium
- Maintenance: Low (single component)

**2. Card Selection → Form (Xcode / JetBrains pattern)**

- Description: First screen shows 3 cards describing each path. Clicking a card transitions to the path-specific form. Two-step flow.
- Pros: Very clear path selection, each form gets full dialog space
- Cons: Extra click, animation complexity, back-button needed
- Complexity: High
- Maintenance: Medium

**3. Primary Path + Secondary Links (Linear pattern)**

- Description: Dialog opens to "New Agent" by default. "From template" and "Import" are text links, not tabs. Quick creation is the default.
- Pros: Fastest for the common case (create from scratch), minimal UI
- Cons: Template and Import paths are less discoverable, may feel buried
- Complexity: Low
- Maintenance: Low

**Recommendation:** Three-tab dialog. It balances discoverability of all three paths with simplicity. The tab pattern is well-established in the DorkOS codebase and Shadcn UI.

### Template Picker Design

- Marketplace templates shown as compact cards: name, one-line description, key tools
- "Blank" or default template always first in the list
- No search for < 15 templates; category filter pills for 15-30
- Custom GitHub URL in Advanced disclosure below the picker grid

### Directory/Location Picker

- Default to `~/dork/agents/{name}` auto-updating as name changes
- Show resolved absolute path in muted text below input
- Browse button for native OS file picker
- Real-time `.dork` conflict detection (debounced 300ms stat check):
  - No `.dork` found: "New directory — will be created"
  - `.dork` found: "Existing project detected — Import instead?" with fast-path link to Import tab
  - Path exists, no `.dork`: "Directory exists, will create new project inside"
  - Permission denied / invalid: prevent submission

### Calm Tech Principles Applied

- Default path (New Agent tab, default location) requires zero decisions beyond a name
- Template and Import are accessible but not forced
- Dialog never asks a question the system can answer (conflict detection is automatic)
- Primary action is always "Create" — never "Next"
- Create fast, configure later (personality deferred to settings)

## 6) Decisions

| #   | Decision                          | Choice                                           | Rationale                                                                                                                                                                 |
| --- | --------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Personality sliders               | Remove from creation dialog                      | Configure post-creation in agent settings. Creation stays minimal — name + location + path choice. Follows Vercel/Linear "create fast, configure later" pattern.          |
| 2   | Sidebar/session + button behavior | Open unified creation dialog                     | Consistent experience everywhere. Fixes current bug where these entry points open the editing dialog instead. All entry points → `useAgentCreationStore.open()`.          |
| 3   | Onboarding alignment              | Own UI, same underlying API/hooks                | Onboarding keeps its guided narrative flow but should converge `useInitAgent` onto the same `useCreateAgent` hook or shared server endpoint. No UI changes to onboarding. |
| 4   | Discover & Import placement       | Unified as third tab in creation dialog          | Reuse `DiscoveryView` component as-is. Delete separate discovery dialog from AgentsHeader. Single button, single dialog. Net fewer components.                            |
| 5   | Template sources                  | Marketplace only + Advanced custom URL           | Delete built-in templates (code and server endpoint). Marketplace is the canonical template source. Custom GitHub URL moved to Advanced disclosure for power users.       |
| 6   | Dialog structure                  | Three-tab pattern                                | Tabs: "New Agent", "From Template", "Import". Clear path selection, familiar pattern, single component.                                                                   |
| 7   | Conflict detection                | Real-time inline validation with adopt fast-path | When user types a path with existing `.dork`, offer one-click switch to Import tab. Conflict is an affordance, not an error.                                              |
