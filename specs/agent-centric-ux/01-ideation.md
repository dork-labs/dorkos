---
slug: agent-centric-ux
number: 85
created: 2026-03-03
status: ideation
---

# Agent-Centric UX — Command Palette, Sidebar Redesign, Mesh Always-On

**Slug:** agent-centric-ux
**Author:** Claude Code
**Date:** 2026-03-03
**Branch:** preflight/agent-centric-ux

---

## 1) Intent & Assumptions

- **Task brief:** Redesign DorkOS UX to put agents at the center of everything. Three connected changes: (1) a global Command Palette (Cmd+K) using the Shadcn Command component for agent switching and feature access, (2) a full agent-centric sidebar redesign where agents are the primary organizational unit, and (3) making Mesh always-on so the agent registry is always available without a feature flag.
- **Assumptions:**
  - The Shadcn `Command` component is already installed at `layers/shared/ui/command.tsx` (confirmed)
  - The existing inline slash command palette (`features/commands/`) remains unchanged — the global palette is a separate feature
  - Mesh removal means removing the feature flag gate, not removing Mesh functionality
  - `useMeshAgentPaths()` (lightweight `{id, name, projectPath, icon?, color?}[]`) is the primary data source for the command palette agent list
  - Agent identity (`.dork/agent.json`) is already the canonical source of truth per ADR-0043
- **Out of scope:**
  - Relay/Pulse UI redesign
  - Agent persona editing flows
  - Onboarding flow changes (though onboarding will need minor updates for always-on Mesh)
  - Mobile-native app considerations (this is mobile web only)
  - Multi-agent sidebar showing all agents simultaneously (that's a future iteration)

## 2) Pre-reading Log

- `apps/client/src/layers/shared/ui/command.tsx`: Shadcn Command component already installed. Exports Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut, CommandSeparator. Currently unused anywhere.
- `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`: Current directory picker — 255-line dialog with browse/recent views. Will be demoted to secondary role behind command palette.
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`: 407-line monolith. Handles session list, agent header, all panel/dialog state, feature icon footer. Primary target for redesign.
- `apps/client/src/layers/features/session-list/ui/AgentHeader.tsx`: 105 lines. Shows agent identity or directory breadcrumb. Entry point for picker. Will be significantly redesigned.
- `apps/client/src/layers/features/commands/ui/CommandPalette.tsx`: Existing inline slash command palette. Uses custom motion.div, NOT Shadcn Command. Triggered by `/` in chat input. Stays as-is.
- `apps/client/src/layers/features/chat/model/use-command-palette.ts`: State machine for inline slash palette. Trigger detection, fuzzy filtering, keyboard nav. Separate from global palette.
- `apps/client/src/layers/entities/mesh/model/use-mesh-agent-paths.ts`: Lightweight hook returning `{id, name, projectPath, icon?, color?}[]`. 30s stale time. Perfect for command palette agent list.
- `apps/client/src/layers/entities/mesh/model/use-mesh-config.ts`: `useMeshEnabled()` — thin wrapper calling `useFeatureEnabled('mesh')`. Will be simplified to always return true.
- `apps/server/src/services/mesh/mesh-state.ts`: Server-side feature flag module. Uses `createFeatureFlag()` factory. Will be removed or hard-coded to true.
- `apps/server/src/index.ts`: Lines 136-224 contain the Mesh conditional initialization block. Will become unconditional.
- `apps/server/src/env.ts`: `DORKOS_MESH_ENABLED` Zod-parsed env var. Will be removed.
- `apps/server/src/routes/config.ts`: Serializes `isMeshEnabled()` into GET `/api/config` response. Will always return true.
- `packages/shared/src/config-schema.ts`: `mesh.enabled` defaults to `true`. The `enabled` field will be removed (keep `scanRoots`).
- `apps/client/src/App.tsx`: Root layout. Mounts sidebar, chat panel, global keyboard shortcuts (Cmd+B for sidebar toggle). The global command palette will be mounted here.
- `apps/client/src/layers/shared/model/app-store.ts`: Zustand store with dialog open/close state. Will add `globalPaletteOpen` state.
- `contributing/keyboard-shortcuts.md`: Documents only Cmd+B and tool-approval shortcuts. No Cmd+K exists. Will need updating.
- `decisions/0043-file-canonical-source-of-truth-for-mesh-registry.md`: Filesystem is canonical, SQLite is derived index. Relevant for understanding why Mesh always-on is safe — the DB rebuilds from disk.
- `research/20260303_command_palette_agent_centric_ux.md`: Full research on command palette UX patterns, Shadcn Command API, sidebar redesign options, frecency algorithms. 28 sources analyzed.

## 3) Codebase Map

**Primary components/modules:**

| File                                                                 | Role                                          | Change needed                                                 |
| -------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| `apps/client/src/layers/shared/ui/command.tsx`                       | Shadcn Command primitive (cmdk)               | None — already installed                                      |
| `apps/client/src/layers/shared/ui/dialog.tsx`                        | Radix Dialog primitive                        | None — used by CommandDialog                                  |
| `apps/client/src/layers/shared/ui/responsive-dialog.tsx`             | Dialog (desktop) / Drawer (mobile) wrapper    | May wrap the command palette for mobile                       |
| `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` | Sidebar — sessions, agent header, panel state | Major redesign — agent-centric structure                      |
| `apps/client/src/layers/features/session-list/ui/AgentHeader.tsx`    | Sidebar agent identity header                 | Major redesign — prominent agent identity + switch affordance |
| `apps/client/src/layers/features/session-list/ui/SessionItem.tsx`    | Session row in sidebar                        | Minor — framed as "agent's session"                           |
| `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`               | Directory browser dialog                      | Demoted — escape hatch, not primary switching                 |
| `apps/client/src/App.tsx`                                            | Root layout + global keyboard shortcuts       | Mount global palette + Cmd+K handler                          |
| `apps/client/src/layers/shared/model/app-store.ts`                   | Zustand store                                 | Add `globalPaletteOpen` state                                 |
| `apps/client/src/layers/entities/mesh/`                              | Mesh entity hooks                             | Remove `useMeshEnabled()` gates                               |
| `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx`              | Mesh panel UI                                 | Remove disabled state gate                                    |
| `apps/server/src/index.ts`                                           | Server entrypoint — Mesh init                 | Remove conditional gate                                       |
| `apps/server/src/services/mesh/mesh-state.ts`                        | Feature flag module                           | Remove or hard-code true                                      |
| `apps/server/src/env.ts`                                             | Env var schema                                | Remove `DORKOS_MESH_ENABLED`                                  |
| `apps/server/src/routes/config.ts`                                   | Config API                                    | Always return `mesh.enabled: true`                            |
| `packages/shared/src/config-schema.ts`                               | Config Zod schema                             | Remove `mesh.enabled` field                                   |

**New files to create:**

| File                                                                          | Role                                      |
| ----------------------------------------------------------------------------- | ----------------------------------------- |
| `apps/client/src/layers/features/command-palette/ui/CommandPaletteDialog.tsx` | Global Cmd+K command palette dialog       |
| `apps/client/src/layers/features/command-palette/ui/AgentCommandItem.tsx`     | Agent result row with color, emoji, path  |
| `apps/client/src/layers/features/command-palette/model/use-global-palette.ts` | Open/close state + Cmd+K keyboard binding |
| `apps/client/src/layers/features/command-palette/model/use-agent-frecency.ts` | localStorage frecency tracking for agents |
| `apps/client/src/layers/features/command-palette/model/use-palette-items.ts`  | Assembles all command items from sources  |
| `apps/client/src/layers/features/command-palette/index.ts`                    | Barrel exports                            |

**Shared dependencies:**

- `@/layers/shared/ui` — Command, Dialog, ResponsiveDialog components
- `@/layers/shared/model` — app-store (Zustand), TransportContext, useIsMobile
- `@/layers/shared/lib` — cn, hashToHslColor, hashToEmoji, shortenHomePath
- `@/layers/entities/mesh` — useMeshAgentPaths, useRegisteredAgents
- `@/layers/entities/agent` — useCurrentAgent, useAgentVisual
- `@/layers/entities/command` — useCommands
- `@/layers/entities/session` — useSessions, useSessionId

**Data flow:**

```
Cmd+K (or mobile tap) → globalPaletteOpen = true → CommandPaletteDialog renders
  → useMeshAgentPaths() → agent list from SQLite registry
  → useCommands() → slash commands from .claude/commands/
  → static feature list (Pulse, Relay, Mesh, Settings)
  → frecency from localStorage → sorted display
User selects agent → setSelectedCwd(agent.projectPath) → sidebar/sessions update
```

**Potential blast radius:**

- Direct: ~20 files (new feature + sidebar + mesh flag removal + config)
- Indirect: ~10 files (components checking meshEnabled, tests mocking it)
- Tests: ~8 test files need updating (mesh hooks, MeshPanel, MeshStatsHeader, ConnectionsTab, env tests)

## 5) Research

**From `research/20260303_command_palette_agent_centric_ux.md` (28 sources):**

### Potential Solutions

**1. Shadcn CommandDialog Pattern (Recommended)**

- Description: Use the already-installed Shadcn Command component with CommandDialog wrapper. Mount at App.tsx level with global Cmd+K keyboard binding.
- Pros: Already installed and unused; handles fuzzy filtering, keyboard nav, focus trapping automatically; the industry-standard pattern (Linear, GitHub, Vercel all use cmdk)
- Cons: None significant — this is the obvious choice given the existing component
- Complexity: Low-Medium
- Maintenance: Low (Shadcn component is well-maintained)

**2. Custom Command Palette (Not Recommended)**

- Description: Build a custom palette from scratch using a Dialog + custom filtering
- Pros: Full control
- Cons: Significant effort for something cmdk already solves; the existing inline palette is already custom and mixing patterns adds confusion
- Complexity: High
- Maintenance: High

**3. Third-Party Command Palette Library (Not Recommended)**

- Description: Use kbar, react-command-palette, or similar
- Pros: Some have additional features (nested commands, breadcrumbs)
- Cons: Adds a dependency when cmdk is already installed; different styling paradigm from Shadcn; less control
- Complexity: Medium
- Maintenance: Medium

### Key Research Findings

- **Zero-query state is the most important design decision.** Never show an empty input with nothing else. Show frecency-sorted recent agents + quick actions.
- **`keywords` prop on CommandItem** enables matching agents by their cwd path, description, or persona — not just display name. Critical for agent discoverability.
- **Single `@` prefix for agent scoping** is the right balance for DorkOS. VS Code needs many prefixes for its breadth; DorkOS doesn't.
- **Frecency scoring**: `score = useCount / (1 + hoursSinceUse * 0.1)`. Store `{agentId, lastUsed, useCount}` in localStorage.
- **`forceMount` prop** on CommandGroup/CommandItem pins items (like the active agent) even when they don't match the search query.
- **`loop` prop** on Command wraps arrow key navigation at list edges — strongly recommended.
- **Cmd+K is the web standard** (Linear, Slack, Superhuman, GitHub, Vercel). Cmd+P is VS Code (file search) and conflicts with browser Print.
- **CommandDialog handles focus trapping, scroll lock, backdrop, Escape-to-close** via Radix Dialog. No custom overlay needed.

### Recommendation

**Use the Shadcn CommandDialog pattern with frecency-sorted agents as the primary content, the `@` prefix for agent-scoped search, and a new `features/command-palette/` FSD module mounted at the App.tsx level.** This is the lowest-risk, highest-quality approach given the existing component infrastructure.

## 6) Decisions

| #   | Decision                       | Choice                                          | Rationale                                                                                                                                                                                            |
| --- | ------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Mesh always-on                 | Remove feature flag entirely                    | Agents are central — the registry must always be available. ADR-0043 confirms the filesystem is canonical, so the SQLite index can always rebuild. Config default was already `true`.                |
| 2   | Mobile command palette trigger | Agent header tap opens palette as bottom drawer | Reuses existing touch point (users already tap the header area). No new permanent UI chrome. ResponsiveDialog pattern (Dialog desktop, Drawer mobile) already exists in the codebase.                |
| 3   | Sidebar redesign scope         | Full agent-centric redesign                     | Agent as primary organizational unit. Sessions are "this agent's conversations." Agent identity header is prominent with switch affordance. Matches the "agents at the center of everything" vision. |
| 4   | `@` prefix mode                | Yes, single `@` prefix for agents               | Natural "address to" metaphor. Low complexity — one prefix mode. Research confirms this is the sweet spot for DorkOS's scale vs. VS Code's many prefixes.                                            |
| 5   | FSD placement                  | New `features/command-palette/` module          | Separate from existing `features/commands/` (inline slash palette). Follows FSD rules — feature can import from entities and shared. Mounted at App.tsx level.                                       |
| 6   | Keyboard shortcut              | Cmd+K (Mac) / Ctrl+K (Windows/Linux)            | Industry standard for web tools. Existing Cmd+B (sidebar toggle) is the reference pattern for implementation. No current Cmd+K binding exists.                                                       |
| 7   | Zero-query state               | Frecency-sorted recent agents + quick actions   | Research unanimously recommends this over empty or full-list states. Personalized, fast for repeat actions. Uses localStorage for tracking.                                                          |
| 8   | Existing CommandPalette        | Keep as-is, separate concern                    | Inline slash palette in chat input serves a different purpose (contextual command completion). Two palettes, two triggers, two contexts. Research confirms this separation is correct.               |
| 9   | Directory picker fate          | Demoted to secondary role                       | Accessible from command palette "Browse filesystem..." action or settings. No longer the primary switching mechanism. Covers the 5% edge case of navigating to a new, unregistered directory.        |

### Change 1: Global Command Palette (Cmd+K)

**Architecture:**

- New `features/command-palette/` FSD module
- `CommandPaletteDialog` wraps Shadcn `CommandDialog` (Radix Dialog + cmdk)
- On mobile: uses `ResponsiveDialog` pattern — bottom Drawer instead of centered Dialog
- Mounted in `App.tsx` at the root level (accessible even with sidebar closed)
- `globalPaletteOpen` state in Zustand app-store

**Content groups (in order):**

| Group             | Source                                       | Behavior                                                                                                                       |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Recent Agents** | `useAgentFrecency()` + `useMeshAgentPaths()` | Shown in zero-query state. Top 5 frecency-sorted. Active agent pinned first with checkmark.                                    |
| **All Agents**    | `useMeshAgentPaths()`                        | Shown when searching or in `@` mode. Each shows: colored dot + emoji + name + abbreviated path. Active agent has `forceMount`. |
| **Features**      | Static list                                  | Pulse Scheduler, Relay Messaging, Mesh Network, Settings. Each shows icon + name + keyboard shortcut hint.                     |
| **Commands**      | `useCommands()`                              | Slash commands from `.claude/commands/`. Shows `/namespace:command` + description.                                             |
| **Quick Actions** | Static list                                  | New Session, Discover Agents, Browse Filesystem, Toggle Theme.                                                                 |

**`@` prefix mode:**

- When input starts with `@`, filter to agents-only group
- Strip `@` from the search term before filtering
- Show all registered agents (not just recent)
- Useful for large registries (10+ agents)

**Agent item design:**

```
[●] auth-service              ~/projects/auth-svc    ✓
     "Builds and deploys the auth API"
```

- Colored dot from `agent.color` or `hashToHslColor(agent.id)`
- Agent name (bold)
- Abbreviated cwd path (muted, right-aligned)
- Checkmark on active agent
- Optional description line (from agent manifest)
- `keywords` includes: cwd path, description, persona name

**Keyboard interactions:**

- `Cmd+K` / `Ctrl+K` — toggle palette open/close
- Arrow keys — navigate items (with `loop` wrapping)
- `Enter` — select item and close
- `Escape` — close palette
- Type to filter across all groups
- `@` prefix — scope to agents only

**Mobile interactions:**

- Tap agent header in sidebar → opens palette as bottom Drawer
- Same content groups and search behavior
- Touch-friendly item heights (minimum 44px tap targets)
- Search input auto-focuses with on-screen keyboard

### Change 2: Full Agent-Centric Sidebar Redesign

**Current sidebar structure:**

```
┌─────────────────────────┐
│ AgentHeader (small)     │  ← Agent identity or directory path
│ [+ New Chat]            │
├─────────────────────────┤
│ Session 1               │
│ Session 2               │  ← Sessions grouped by time
│ Session 3               │
├─────────────────────────┤
│ [Onboarding card]       │
├─────────────────────────┤
│ DorkOS │ ⚙️ 📡 🔷 ⏱️ 🎨 │  ← Footer with feature icons
└─────────────────────────┘
```

**Proposed agent-centric structure:**

```
┌─────────────────────────┐
│ ┌─────────────────────┐ │
│ │ [●] auth-service    │ │  ← Prominent agent identity
│ │     ~/projects/auth │ │     with color, emoji, name
│ │     [⌘K Switch]  [⚙]│ │     Switch opens palette; gear opens agent settings
│ └─────────────────────┘ │
├─────────────────────────┤
│ [+ New Session]         │  ← New session for THIS agent
├─────────────────────────┤
│ Sessions                │
│ ┌─────────────────────┐ │
│ │ Fix auth middleware  │ │  ← Sessions framed as agent's conversations
│ │ 2 hours ago          │ │
│ ├─────────────────────┤ │
│ │ Add rate limiting    │ │
│ │ Yesterday            │ │
│ └─────────────────────┘ │
├─────────────────────────┤
│ [Onboarding card]       │  ← If applicable
├─────────────────────────┤
│ DorkOS │ ⚙️ 📡 🔷 ⏱️ 🎨 │  ← Footer (unchanged)
└─────────────────────────┘
```

**Key changes from current:**

1. **Agent header is prominent.** The agent name, emoji, colored accent, and description are the first thing you see. Not a small line — a full card-like header element with visual weight.

2. **"Switch" affordance opens Cmd+K.** A subtle button showing `⌘K` (or tap target on mobile) opens the command palette scoped to agents. Replaces the directory picker as the primary switching mechanism.

3. **Sessions are subordinate to the agent.** The session list is explicitly "this agent's conversations." The mental model shifts from "sessions in a directory" to "conversations with this agent."

4. **Agent settings gear stays.** Opens the existing `AgentDialog` for persona, capabilities, connections configuration.

5. **No-agent state.** When the selected directory has no agent manifest, show a streamlined prompt: "No agent registered. Set up an agent or browse filesystem." with clear CTAs for both paths.

6. **The directory path is secondary.** Shown below the agent name as muted text. Not the primary identifier — the agent name is.

### Change 3: Mesh Always-On

**Server-side changes:**

| File                                          | Change                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/server/src/env.ts`                      | Remove `DORKOS_MESH_ENABLED` from Zod schema                                          |
| `apps/server/src/index.ts`                    | Remove `if (meshEnabled)` gates; always init MeshCore, mount routes, start reconciler |
| `apps/server/src/services/mesh/mesh-state.ts` | Delete file (or hard-code `isEnabled = () => true` for minimal diff)                  |
| `apps/server/src/routes/config.ts`            | Return `mesh: { enabled: true, scanRoots }` unconditionally                           |
| `packages/shared/src/config-schema.ts`        | Remove `mesh.enabled` field from schema (keep `scanRoots`)                            |
| `.env.example`                                | Remove `DORKOS_MESH_ENABLED` line                                                     |

**Client-side changes:**

| File                                            | Change                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `entities/mesh/model/use-mesh-config.ts`        | `useMeshEnabled()` returns `true` unconditionally (or remove hook entirely and update consumers) |
| `shared/model/use-feature-enabled.ts`           | Remove `'mesh'` from `Subsystem` union type                                                      |
| `features/session-list/ui/SessionSidebar.tsx`   | Remove mesh-disabled dimming/tooltip logic                                                       |
| `features/mesh/ui/MeshPanel.tsx`                | Remove `FeatureDisabledState` gate; always render panel body                                     |
| `features/mesh/ui/MeshStatsHeader.tsx`          | Remove `!meshEnabled` early return                                                               |
| `features/agent-settings/ui/ConnectionsTab.tsx` | Always show health data; remove "Enable Mesh" prompt                                             |

**Error handling:** MeshCore initialization can still fail (e.g., SQLite write errors). The existing error handling in `index.ts` (try/catch around init, `setMeshInitError()`) should remain for graceful degradation — just remove the "disabled by config" path.

**Test updates:** ~8 test files need updating to remove `useMeshEnabled` mocks and `DORKOS_MESH_ENABLED` assertions.
