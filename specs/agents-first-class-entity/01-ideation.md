---
slug: agents-first-class-entity
number: 66
created: 2026-02-26
status: ideation
---

# Agents as First-Class Entity

**Slug:** agents-first-class-entity
**Author:** Claude Code
**Date:** 2026-02-26
**Branch:** preflight/agents-first-class-entity
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Elevate the Agent concept from a Mesh-only abstraction to a first-class entity throughout DorkOS. Agents should be the primary identity users see in the sidebar, directory picker, Pulse schedules, and everywhere else a raw directory path currently appears. Clicking an agent name should open a dedicated, world-class Agent Settings dialog covering identity, Mesh, Pulse, and Relay configuration.
- **Assumptions:**
  - Agent identity remains tied to a working directory (one `.dork/agent.json` per project dir)
  - The `.dork/agent.json` file remains the canonical source of truth (ADR 0043)
  - Unregistered directories (no agent config) must remain fully functional with zero degradation
  - The existing `?dir=` URL parameter architecture is preserved (not migrating to `?agent=`)
  - Mesh does not need to be enabled for agents to exist — the manifest file reader operates independently
- **Out of scope:**
  - Replacing directory-based navigation with agent-based navigation (`?agent=` URL params)
  - Agent capability enforcement (connecting `capabilities[]` to actual MCP tool access)
  - A2A interop via `toAgentCard()` conversion
  - Multi-agent sessions (one session, multiple agents)
  - Agent-to-agent communication patterns (handled by Relay)

## 2) Pre-reading Log

- `decisions/0024-dorkos-native-agent-manifest-format.md`: ADR establishing `.dork/agent.json` with DorkOS-native fields (id, name, description, runtime, capabilities, behavior, budget). Explicitly chose DorkOS format over A2A `.well-known/agent.json`.
- `decisions/0043-file-canonical-source-of-truth-for-mesh-registry.md`: ADR making `.dork/agent.json` the canonical source with SQLite as derived index. API updates write-through to file first.
- `packages/shared/src/mesh-schemas.ts`: Agent manifest Zod schema — already has id, name, description, runtime, capabilities, behavior, budget, namespace, registeredAt, registeredBy. Missing: persona, color, icon.
- `packages/mesh/src/manifest.ts`: `readManifest()`, `writeManifest()`, `removeManifest()` — atomic file I/O for `.dork/agent.json`. Currently only imported by Mesh package.
- `packages/mesh/src/agent-registry.ts`: `AgentRegistry` class backed by Drizzle ORM. Methods: upsert, get, getByPath, list, update, listWithHealth, getAggregateStats.
- `packages/mesh/src/mesh-core.ts`: `MeshCore` orchestrates discovery, registration, and lifecycle. Directories with existing `.dork/agent.json` are auto-imported during scans.
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`: Main sidebar component. Lines 167-186 show the directory breadcrumb area (FolderOpen icon + PathBreadcrumb). This is where the AgentHeader should go.
- `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`: Directory selection dialog with browse + recent views. Recent view (lines 191-207) shows only paths — no agent names or visual identity.
- `apps/client/src/layers/features/pulse/ui/ScheduleRow.tsx`: Schedule display shows name + cron description. CWD is only visible in the expanded RunHistoryPanel, not in the schedule row itself.
- `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx`: Schedule creation form with DirectoryPicker for CWD selection. Should show agent name when CWD has one.
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx`: 4-tab dialog (Appearance, Preferences, Status Bar, Server). Agent settings will be a separate dedicated dialog.
- `apps/client/src/layers/shared/lib/favicon-utils.ts`: Deterministic visual identity system — `fnv1aHash()` generates stable hashes, `hashToHslColor()` produces HSL colors, `hashToEmoji()` picks from a 30-emoji set. Currently hashes from CWD string. Agent overrides should take precedence.
- `apps/server/src/services/context-builder.ts`: `buildSystemPromptAppend(cwd)` gathers runtime context (env, git status). This is where agent persona injection will happen.
- `apps/server/src/services/core/mcp-tool-server.ts`: MCP tools for Mesh (lines 708-781) already expose agent operations. May need `agent_get_current` tool for Claude to know its own identity.
- `research/20260226_agents_first_class_entity.md`: Full research report covering agent identity schemas across LangGraph, CrewAI, Google A2A, GitHub Copilot, OpenCode. Key finding: DorkOS manifest is already more structured than most peers. Two gaps: visual identity and persona text.

## 3) Codebase Map

**Primary components/modules:**

| File                                                                 | Role                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| `packages/shared/src/mesh-schemas.ts`                                | Agent manifest Zod schema (lines 45-60)                   |
| `packages/mesh/src/manifest.ts`                                      | `.dork/agent.json` file I/O (read/write/remove)           |
| `packages/mesh/src/agent-registry.ts`                                | SQLite-backed registry with Drizzle ORM                   |
| `packages/mesh/src/mesh-core.ts`                                     | Discovery + registration orchestration                    |
| `packages/db/src/schema/mesh.ts`                                     | DB schema: `agents` + `agentDenials` tables               |
| `apps/server/src/routes/mesh.ts`                                     | REST endpoints for agent CRUD                             |
| `apps/server/src/services/context-builder.ts`                        | System prompt context injection                           |
| `apps/server/src/services/core/mcp-tool-server.ts`                   | MCP tools exposed to Claude sessions                      |
| `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` | Sidebar with directory breadcrumb                         |
| `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`               | Directory selection dialog                                |
| `apps/client/src/layers/features/pulse/ui/ScheduleRow.tsx`           | Pulse schedule display                                    |
| `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx`  | Schedule creation form                                    |
| `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx`     | Settings dialog (4 tabs)                                  |
| `apps/client/src/layers/shared/lib/favicon-utils.ts`                 | Deterministic color/emoji from CWD hash                   |
| `apps/client/src/layers/entities/mesh/`                              | 14 mesh entity hooks                                      |
| `apps/client/src/layers/features/mesh/ui/`                           | Mesh UI components (RegisterAgentDialog, AgentCard, etc.) |

**Shared dependencies:**

- `@dorkos/shared/mesh-schemas` — Zod schemas used by server + client
- `@/layers/shared/lib/favicon-utils` — Deterministic hash-to-color/emoji
- `@/layers/shared/model/app-store` — Zustand store holding `selectedCwd`, `recentCwds`
- `@/layers/entities/session` — `useDirectoryState()` hook for current CWD

**Data flow:**

```
.dork/agent.json (filesystem)
  → readManifest() (packages/mesh/src/manifest.ts)
  → AgentRegistry.upsert() (packages/mesh/src/agent-registry.ts) [derived index]
  → GET /api/mesh/agents (apps/server/src/routes/mesh.ts)
  → useRegisteredAgents() (apps/client/src/layers/entities/mesh/)
  → UI components
```

For the new flow (agent identity in sidebar):

```
selectedCwd (Zustand/URL)
  → GET /api/mesh/agents?path={cwd} [new endpoint or use existing getByPath]
  → useCurrentAgent(cwd) [new hook in entities/agent/]
  → AgentHeader component (sidebar)
  → AgentDialog component (on click)
```

**Feature flags/config:**

- `DORKOS_MESH_ENABLED` controls Mesh feature. Agent identity should work WITHOUT Mesh enabled — the manifest file can be read directly without the registry.
- Need to decide: does the agent entity layer depend on Mesh being enabled, or does it read `.dork/agent.json` independently?

**Potential blast radius:**

- Direct changes: ~15 files (schema, context-builder, new entity layer, sidebar, directory picker, pulse components, new Agent dialog)
- Indirect: favicon-utils (override logic), app-store (agent state), transport interface (new endpoints)
- Tests: ~8 test files need updates or creation

## 4) Root Cause Analysis

N/A — not a bug fix.

## 5) Research

Full research report: `research/20260226_agents_first_class_entity.md`

**Potential solutions:**

**1. Agent as Directory Alias (Minimal Lift)**

- Show agent name instead of path everywhere; no schema changes, no behavior changes
- Pros: Ship fast, no breaking changes, incremental
- Cons: Agents remain second-class; no persona injection; misses the core opportunity
- Complexity: Low | Maintenance: Low

**2. Agent as First-Class Session Context (Medium Lift) — SELECTED**

- Agent owns a working directory, has display identity + persona, is the context frame for sessions
- Pros: Strong UX improvement, persona injection makes agents meaningfully different from folders, unregistered dirs still work, aligns with GitHub Copilot/OpenCode/Windsurf patterns
- Cons: New FSD entity layer, schema extensions, context-builder dependency on manifest reader
- Complexity: Medium | Maintenance: Medium

**3. Agents as Navigation Axis (High Lift)**

- Replace `?dir=` with `?agent=`, agent-centric sidebar, all features scoped to agents
- Pros: Most coherent long-term vision
- Cons: High risk, breaks `?dir=` woven through transport/sessions/Pulse/boundary checks, forces migration
- Complexity: High | Maintenance: High
- **Deferred** — right direction but not for beta

**4. Agent Profile UI (Orthogonal) — INCLUDED with #2**

- Standalone Agent Settings dialog for viewing/editing `.dork/agent.json`
- Pros: Makes invisible visible, directly useful, ships incrementally
- Cons: Alone, doesn't change how agents are perceived in daily use
- Complexity: Low-Medium | Maintenance: Low

**Industry patterns:**

- GitHub Copilot: Agent name in mode dropdown, file-based config in `.github/agents/`
- OpenCode: Tab key cycles agents, `@name` invokes subagents, markdown files with YAML frontmatter
- Windsurf: Single named agent (Cascade) per workspace, always visible in chat header
- CrewAI: Role + goal + backstory injected into system prompt — closest to persona injection
- Microsoft Design for Agents: "Agent status is clearly visible at all times"

**Recommendation:** Approach 2 + 4 (Agent as First-Class Session Context + Agent Profile Dialog)

## 6) Decisions

| #   | Decision                         | Choice                                        | Rationale                                                                                                                                                                                                                                                  |
| --- | -------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Agent Settings UX                | Dedicated Agent Dialog                        | A new standalone dialog with tabs for Identity, Mesh, Pulse, and Relay config. Richer than a Settings tab; focused on the agent rather than app preferences. Opened by clicking agent name in sidebar.                                                     |
| 2   | Agent visual identity            | Deterministic color + emoji, user-overridable | Reuse existing `hashToHslColor()` / `hashToEmoji()` from `favicon-utils.ts`, hashing from agent ID (not CWD). If user overrides color/icon in agent config, the override is used everywhere — sidebar, Pulse, tab title, favicon.                          |
| 3   | Unregistered directory treatment | Graceful fallback + gentle CTA                | Dirs without `.dork/agent.json` show current folder path exactly as today. A subtle "+ Agent" text link or small icon next to the path lets users initialize an agent. Fully functional, zero degradation, non-pushy.                                      |
| 4   | Persona injection                | Auto-inject with per-agent toggle             | When a session's CWD has `.dork/agent.json` with a `persona` field, inject it into the system prompt via `context-builder.ts`. A `personaEnabled` boolean field (default `true`) on the manifest gives users control. The agent "knows" its name and role. |

---

## Additional Design Exploration

### Agent Settings Dialog — World-Class Experience

The Agent Dialog is the centerpiece of this feature. When a user clicks the agent name in the sidebar, this dialog opens. It should feel like a comprehensive control center for the agent's identity and behavior across all DorkOS subsystems.

**Proposed tab structure:**

#### Tab 1: Identity

- **Name** — editable text field (writes to `.dork/agent.json` name)
- **Description** — multiline text (writes to description field)
- **Color** — color picker or preset palette; shows current deterministic color as default
- **Icon/Emoji** — emoji picker; shows current deterministic emoji as default
- **Runtime** — dropdown (claude-code, cursor, codex, other)
- **Working directory** — read-only display of the agent's CWD with a copy button

#### Tab 2: Persona

- **System prompt** — rich textarea for the agent's persona text (writes to `persona` field)
- **Persona enabled** — toggle switch (writes to `personaEnabled` field)
- **Preview** — shows what the agent identity XML block looks like when injected
- Guidance text: "This text is appended to Claude Code's system prompt for every session in this directory. Use it to define the agent's expertise, constraints, and personality."

#### Tab 3: Capabilities

- **Capabilities** — tag/chip editor for capability strings (writes to `capabilities[]`)
- **Namespace** — text field for mesh namespace grouping
- **Behavior** — response mode dropdown (always, direct-only, mention-only, silent)
- **Budget** — max hops per message, max calls per hour
- This tab surfaces Mesh config in agent-centric language — no "Mesh" branding needed

#### Tab 4: Connections

- **Pulse schedules** — list of schedules linked to this agent's CWD, with quick links to edit
- **Relay endpoints** — list of Relay endpoints registered for this agent
- **Mesh health** — health status, last seen, heartbeat info
- Read-mostly view with links to full Pulse/Relay/Mesh panels for deeper management

### Sidebar AgentHeader Component

When `useCurrentAgent()` returns an agent for the current CWD:

```
[colored dot] [emoji] Agent Name                    [gear icon]
              Short description text...
```

- Colored dot uses agent's color (deterministic from ID, or user override)
- Emoji uses agent's icon (deterministic from ID, or user override)
- Clicking the name/description area opens the Agent Dialog
- Gear icon also opens the Agent Dialog (alternative affordance)
- The current directory path is shown in a smaller line below, or in a tooltip

When no agent is registered:

```
[folder icon] /path/to/project                     [+ Agent]
```

- Exactly as today, but with a subtle "+ Agent" text button
- Clicking "+ Agent" opens a quick creation flow:
  1. Pre-populates name from directory basename (e.g., `my-project`)
  2. Writes `.dork/agent.json` with deterministic ID, name, empty description
  3. Opens the Agent Dialog for further customization

### DirectoryPicker Enhancements

**Recent view:**

- Each recent directory that has a `.dork/agent.json` shows: `[colored dot] [emoji] Agent Name` instead of the raw path
- The path is shown as secondary text below the agent name
- Unregistered directories show the folder icon + path as today
- Visual distinction makes it instantly clear which directories are "agents" vs plain folders

**Browse view:**

- When navigating into a directory with `.dork/agent.json`, show the agent name in the breadcrumb area
- The "Select" button could say "Select" for plain dirs, "Open Agent" for agent dirs (optional polish)

### Pulse Integration

**Schedule rows:**

- When a schedule's CWD has a registered agent, show `[colored dot] Agent Name` instead of (or alongside) the schedule name
- The CWD path becomes secondary info, visible on hover or in the expanded detail

**Create/Edit Schedule Dialog:**

- The DirectoryPicker already handles agent display (see above)
- After selecting a dir with an agent, show the agent name prominently in the form
- Consider: agent name as part of the schedule display name default

### Context Builder — Persona Injection

In `buildSystemPromptAppend(cwd)`:

```xml
<agent_identity>
Name: backend-bot
ID: 01HQ3K4M7NXYZ
Description: REST API specialist for the backend project
Capabilities: code-review, api-design, test-generation
</agent_identity>

<agent_persona>
You are backend-bot, an expert in this project's REST API layer.
You specialize in Express route handlers, middleware, and OpenAPI documentation.
Always validate request bodies with Zod schemas and return proper error responses.
</agent_persona>
```

The persona block is only included when `personaEnabled` is true (default). The identity block is always included when a manifest exists, since it's informational.

### Schema Changes

**AgentManifest additions:**

- `persona: z.string().max(4000).optional()` — System prompt text
- `personaEnabled: z.boolean().default(true)` — Toggle for persona injection
- `color: z.string().optional()` — CSS color override (e.g., "#6366f1")
- `icon: z.string().optional()` — Emoji override

**UpdateAgentRequest additions:**

- Same four new fields added as optional

**New API endpoints (or extensions):**

- `GET /api/agents/current?path={cwd}` — Get agent for a CWD (works without Mesh enabled)
- Or extend existing: `GET /api/mesh/agents?path={cwd}` — already possible via `getByPath`

### New FSD Entity Layer

```
layers/entities/agent/
├── model/
│   ├── use-current-agent.ts    # TanStack Query: agent for selectedCwd
│   ├── use-agent-by-id.ts      # TanStack Query: agent by ULID
│   └── use-agent-visual.ts     # Deterministic color/emoji with override logic
├── index.ts                    # Public API: useCurrentAgent, useAgentById, useAgentVisual
```

`useCurrentAgent(cwd)` fetches the agent manifest for the given CWD. Returns `null` for unregistered directories. Uses TanStack Query with a long staleTime (agent config changes infrequently).

`useAgentVisual(agent)` returns `{ color, emoji }` — uses agent's overrides if present, falls back to deterministic hash from agent ID. This hook is the single source for all visual identity rendering.

### Independence from Mesh Feature Flag

Critical design decision: the agent entity layer should work WITHOUT `DORKOS_MESH_ENABLED`. The simplest approach:

- Server adds a lightweight `GET /api/agents/current?path={cwd}` endpoint that reads `.dork/agent.json` directly via `readManifest()` from `packages/mesh/src/manifest.ts`
- This endpoint is always available (not behind the Mesh feature flag)
- The manifest reader has zero dependencies on Mesh/registry/SQLite — it's pure file I/O
- When Mesh IS enabled, the existing registry endpoints provide richer data (health, topology, etc.)

This means: even if a user has only the base DorkOS (no Mesh, no Relay, no Pulse), they can still name their agents, set personas, and get visual identity in the sidebar.

### Tab Title / Favicon Integration

The existing `hashToHslColor(cwd)` and `hashToEmoji(cwd)` in `favicon-utils.ts` hash from the CWD string. With agents:

1. If agent exists and has `color` override → use that color
2. If agent exists (no override) → hash from `agent.id` (stable across CWD changes)
3. If no agent → hash from CWD (current behavior)

Same logic for emoji via `icon` field.

The tab title currently shows `(badge) DorkOS`. With agents, it could show `[emoji] Agent Name — DorkOS` or `[emoji] DorkOS` (keeping it simple). The emoji in the title already comes from CWD hash — agent override naturally flows through.
