---
title: 'Agents as First-Class Entity in DorkOS'
date: 2026-02-26
type: internal-architecture
status: active
tags: [agents, identity, persona, manifest, dork-agent-json, mesh]
feature_slug: agents-first-class-entity
---

# Research: Agents as First-Class Entity in DorkOS

**Date**: 2026-02-26
**Slug**: agents-first-class-entity
**Mode**: Deep Research (12 tool calls)
**Researcher**: Research Expert Agent

---

## Research Summary

Across the agent framework ecosystem (LangGraph, CrewAI, AutoGen, Google A2A, GitHub Copilot custom agents, OpenCode), agent identity converges on a small set of shared primitives: a stable ID, a human-readable name, a description/role, a declared capability set, and a filesystem anchor. DorkOS already has all these pieces in `.dork/agent.json` and `AgentManifest`—but they are currently siloed inside Mesh. Elevating agents to a first-class product entity means making that manifest the primary navigation axis in the UI, the context frame for sessions, and the routing key for Pulse/Relay/Mesh, rather than a background registry entry.

---

## Key Findings

### 1. Agent Identity Schema: What the Ecosystem Has Converged On

Every mature framework treats agent identity as a small, stable core plus extensible metadata:

| Field               | CrewAI                      | Google A2A Agent Card         | GitHub Copilot Agents      | OpenCode Agents              | DorkOS AgentManifest       |
| ------------------- | --------------------------- | ----------------------------- | -------------------------- | ---------------------------- | -------------------------- |
| Stable ID           | implicit (name key)         | `id` (string)                 | filename                   | filename                     | `id` (ULID)                |
| Human name          | `role`                      | `name`                        | frontmatter `name`         | filename                     | `name`                     |
| Purpose description | `goal` + `backstory`        | `description`                 | frontmatter `description`  | frontmatter `description`    | `description`              |
| Capabilities/skills | `tools` list                | `skills[]` + `capabilities{}` | `tools` list               | `tools` list                 | `capabilities[]` (strings) |
| Runtime/model       | `llm` field                 | implied by endpoint           | `model` field              | `model` field                | `runtime` enum             |
| Behavior config     | `verbose`, `max_iter`, etc. | `extensions[]`                | instructions body          | permission                   | `behavior{}` + `budget{}`  |
| Filesystem anchor   | YAML file path              | `.well-known/agent.json`      | `.github/agents/{name}.md` | `.opencode/agents/{name}.md` | `.dork/agent.json`         |
| Visual identity     | none                        | none                          | none                       | none                         | none                       |

DorkOS's `AgentManifest` is already more structured than most peers. The two gaps vs. the ecosystem are:

- **No visual identity** (color, icon, emoji, avatar) — every tool that surfaces agents prominently in UI adds some visual differentiator
- **No human-authored system prompt / persona text** — CrewAI's `backstory`, Copilot's markdown body, OpenCode's markdown body all give the agent a narrative voice that users recognize

### 2. How the Ecosystem Surfaces Agent Identity in UI

**GitHub Copilot (VS Code)**
Agents are selected from a mode dropdown at the top of the chat panel (`Ask | Edit | Agent | {custom agent name}`). The agent name appears as the active context label. Switching agents is a single click. Custom agents show their configured name, not "Agent."

**OpenCode**
Tab key cycles through primary agents; `@name` invokes subagents inline. The current agent's name appears as a persistent label in the input area. Agents are defined as markdown files with YAML frontmatter so the filename is the agent's identity token.

**Windsurf (Cascade)**
The agent (Cascade) has a named, branded identity. The UI does not expose agent switching — there is exactly one agent per workspace and its name is always visible in the chat header. This trades flexibility for clarity.

**Cursor**
No persistent agent name in UI. Mode (Ask/Edit/Agent) is shown but the underlying model is what changes, not a named "agent." This is a notable weak point: users cannot easily differentiate between coding contexts.

**Microsoft Copilot Studio / Entra Agent ID**
Enterprise pattern: each agent gets an Entra identity (GUID), a display name, and appears in an "Agent Inventory" with status indicators (active/inactive/stale), creation date, and authentication mode. Governance-first model where agents are managed entities with audit trails.

**Key UX pattern across all tools**: The most effective tools always show a named agent in the active context area (chat header or input label). The second most common pattern is a switcher or tab to change active agents. The least common — but most aspirational — is a workspace that feels "owned by" a specific agent (Windsurf's Cascade approach).

### 3. Agent Registry Patterns: Centralized vs. Local

The academic literature (arxiv 2508.03095) identifies five registry approaches:

1. **MCP Registry** — centralized publication of JSON descriptors, public marketplace model
2. **Google A2A Agent Cards** — decentralized self-describing JSON at `.well-known/agent-card.json`, HTTP discovery
3. **AGNTCY ADS** — distributed DHT (IPFS Kademlia), federated semantic routing
4. **Microsoft Entra Agent ID** — enterprise SaaS directory with policy and zero-trust
5. **NANDA Index** — cryptographically verifiable privacy-preserving facts

For a **developer tool** operating locally, none of these fully apply. The relevant patterns are:

- **Project-local config file** (`.dork/agent.json`, `.github/agents/*.md`, `.opencode/agents/*.md`): The agent config lives inside the project directory it governs. This is the dominant pattern for developer tools. It enables `git` versioning, per-repo overrides, and zero network dependency.
- **Global user registry** (`~/.config/opencode/agents/`, `~/.dork/config.json`): System-wide agents that apply everywhere. Good for personal defaults.
- **Server-side index** (DorkOS Mesh SQLite): Derived from scanning project dirs. Provides query, health, and topology views.

DorkOS already has all three tiers. The gap is that the project-local file (`.dork/agent.json`) is currently write-only from the UI — users register via Mesh but cannot see the manifest as a first-class UI object tied to their working directory.

### 4. Agent Capabilities and Permissions: Best Practices

From WorkOS, Cerbos, and AWS Bedrock AgentCore research:

- **Principle of least privilege**: Agents should declare narrow scopes (`database.read` not `database.*`). Default-deny is the safe posture.
- **Capability strings as declarations**: The ecosystem uses string arrays for capability declarations (`capabilities: ["code-review", "test-generation"]`). These are informational/routing hints, not enforced permissions. Enforcement happens at the tool level.
- **Tool selection as identity**: In GitHub Copilot and OpenCode, the tool list IS the agent identity. The same base model with different tool access behaves as a completely different agent. DorkOS's `capabilities[]` array currently holds informational strings — connecting these to actual tool access (which MCP servers are available) would be a meaningful upgrade.
- **Budget as a safety boundary**: DorkOS already has `budget.maxHopsPerMessage` and `budget.maxCallsPerHour`. This is more sophisticated than most peers.

### 5. Navigation and Information Architecture

The core tension for DorkOS is: **is a "working directory" also an "agent"?**

Currently:

- `?dir=` URL param tracks the working directory (the path Claude Code runs in)
- `AgentManifest` tracks the registered agent for that directory
- Sessions are grouped under a directory, not an agent

The industry is moving toward agent-centric navigation. The strongest signal: GitHub Copilot custom agents let organizations define named agents that embody "your team's workflows, conventions, and unique needs" — the agent is the unit of identity, not the repository. When users switch agents, they're switching intent and context, not just file paths.

**What this means for DorkOS's information architecture:**

- The sidebar header currently shows `FolderOpen + PathBreadcrumb`. This should optionally show an agent name + description when the directory has a `.dork/agent.json`.
- Sessions should be conceptually grouped under an agent, not a raw directory path.
- The "New chat" button implicitly creates a session with the current agent. This should be explicit: "New chat with [Agent Name]."
- Pulse schedules currently have a CWD. If the CWD has an agent, the schedule should show the agent name, not the raw path.

---

## Detailed Analysis

### Approach 1: Agent as Directory Alias (Minimal Lift)

**What it is**: Keep all current architecture. When a directory has a `.dork/agent.json`, display the agent's name and description in the UI instead of the raw path. The directory is still the primary entity; the agent manifest is surface-level display metadata.

**Implementation scope**:

- `SessionSidebar`: When `selectedCwd` maps to a registered agent, show agent name + optional description badge instead of PathBreadcrumb
- `PulsePanel`: Show agent name alongside (or instead of) CWD in schedule rows
- `session-list`: Group sessions under agent name header when applicable
- No schema changes, no new entities, no routing changes

**What changes for users**:

- Directories with agent configs feel more intentional — they have names
- Still falls back to raw path for unregistered directories
- No behavioral changes — agents are still Mesh concepts, just visually promoted

**Pros**:

- Minimal risk, ship fast
- No breaking changes to session or Pulse architecture
- Incremental: can layer on more identity features afterward
- Consistent with how Vercel/Replit show project names over git paths

**Cons**:

- Directory is still the primary navigation axis; agents are second-class
- Does not address the deeper question of "starting a session with an agent"
- The agent context (name, description, system prompt) is not injected into sessions
- Misses the opportunity to make "an agent" feel meaningfully different from "a folder"

---

### Approach 2: Agent as First-Class Session Context (Medium Lift)

**What it is**: An agent is a named entity that owns a working directory, has display identity (name, description, optional color/icon), and is the context frame for sessions. When you open DorkOS to a directory that has a `.dork/agent.json`, you are "talking to" that agent. Sessions belong to agents, not just directories.

**Implementation scope**:

- `AgentManifest` schema gains: `persona` (optional freeform system prompt append), `color` (optional hex/CSS color for visual differentiation), `icon` (optional emoji or named icon)
- Server: `context-builder.ts` injects agent persona into `systemPrompt.append` when the session's CWD has a registered agent
- Client: New `entities/agent/` FSD layer with `useCurrentAgent()` hook that reads agent for the current `selectedCwd`
- `SessionSidebar` header becomes an "Agent Header" — shows agent name, description, color/icon, with a click to switch agents (which switches the directory)
- `SessionItem` shows a small agent badge or colored dot
- `PulsePanel` / `CreateScheduleDialog`: agent selector instead of directory picker for schedule ownership
- Mesh stays as the registry backend — agents just get elevated in the UI layer

**What changes for users**:

- Opening a directory with an agent config feels like "switching to that agent"
- Chat sessions have the agent's persona in context — the agent "knows" it is `my-api-bot` working in `~/projects/api`
- The sidebar communicates "you are currently talking to X" clearly
- Pulse schedules show "Run every day: backend-bot" not "Run every day: /home/dorian/projects/api"

**Pros**:

- Strong UX improvement without re-architecting sessions
- Persona injection is a direct feature add to `context-builder.ts` — low complexity
- Unregistered directories still work exactly as today (graceful degradation)
- Aligns with GitHub Copilot, OpenCode, and Windsurf patterns
- Agent color/icon makes the multi-project developer workflow significantly more scannable

**Cons**:

- Requires Zod schema extension (new fields in `AgentManifest`)
- Requires a new client-side entity layer (`entities/agent/`)
- `context-builder.ts` now has a new dependency on the Mesh registry
- Adds complexity to the sidebar (agent header is richer than directory breadcrumb)
- Must handle the "no agent configured" state gracefully everywhere

---

### Approach 3: Agents as First-Class Navigation Axis (High Lift)

**What it is**: Agents replace directories as the primary navigation concept. The URL param shifts from `?dir=` to `?agent=` (or the agent implicitly carries the directory). The sidebar lists agents, not directories. A directory without an agent config prompts you to create one. Sessions, Pulse schedules, and Relay endpoints are all scoped to agents.

**Implementation scope**:

- New `AgentStore` (Zustand) as the primary navigation state, replacing or wrapping `DirectoryState`
- URL params: `?agent={agentId}` replaces `?dir=`; agent implies CWD
- `SessionSidebar` becomes `AgentSidebar` — top section is an agent picker, bottom section is sessions for that agent
- Unregistered directories either prompt to register an agent OR show under a "Workspace" catch-all
- Pulse, Relay, Mesh, Settings all become agent-scoped panels
- The `+` button creates a new session for the current agent (not just a session in a directory)
- Agent creation wizard integrated into onboarding

**What changes for users**:

- Users navigate by agent identity, not by filesystem path
- "Starting DorkOS on a new project" = "creating an agent" as the first step
- Agents become the organizing principle across the entire product

**Pros**:

- The most coherent product vision — agents are truly first-class
- Aligns with the DorkOS litepaper vision of being an "OS layer for agents"
- Creates a stronger mental model: you work WITH agents, not IN directories

**Cons**:

- High complexity and risk — `?dir=` is woven through transport, sessions, Pulse, and server boundary checks
- Requires migration path for existing users with sessions tied to raw directory paths
- Forces unregistered directories into a degraded state (no agent = no session?)
- Not appropriate for beta — breaking change to core navigation patterns
- The Obsidian plugin also depends on CWD as primary anchor

---

### Approach 4: Agent Profile as Standalone Config UI (Orthogonal)

**What it is**: Instead of changing navigation, add a first-class Agent Profile section to Settings or as a sidebar panel. Users can view, create, and edit agent configs (`.dork/agent.json`) directly from the UI. The agent profile shows: name, description, capabilities, persona text, color, icon. This makes the manifest file a visible, editable object rather than an invisible background file.

**Implementation scope**:

- New `AgentProfilePanel` component (could live in Settings or as a new sidebar icon)
- CRUD UI for `AgentManifest` fields including new `persona`, `color`, `icon` fields
- "Initialize agent for this directory" one-click setup for directories without `.dork/agent.json`
- Read/write via new API endpoint (or extend existing Mesh PATCH endpoint)
- The profile applies to the current working directory

**What changes for users**:

- Agents are no longer just Mesh registry abstractions — they have a visible, editable profile
- Users understand what `.dork/agent.json` is and why it exists
- Can set persona/instructions per-project without knowing JSON
- Works as a complement to any of Approaches 1-3, not a replacement

**Pros**:

- Makes the invisible visible — the biggest current gap is that users don't know `.dork/agent.json` exists
- Low navigation risk — doesn't change `?dir=` or session architecture
- Directly useful: the persona text field lets Claude Code sessions know their context
- Can be shipped incrementally as a new Settings tab

**Cons**:

- Does not change how agents are perceived in day-to-day use (sidebar, session list)
- Risk of being a "settings graveyard" — powerful but hard to discover
- Doesn't address the UX pattern of "knowing who you're talking to"

---

## Recommendation for DorkOS (Beta Product)

**Primary recommendation: Approach 2 (Agent as First-Class Session Context), with Approach 4 bundled in.**

The reasoning:

1. **The core UX gap is "knowing who you're talking to."** The sidebar today shows a folder icon and a path. If a user has `.dork/agent.json` in their project, they should see a named agent with a colored indicator, not `/Users/dorian/projects/api`. This is a high-signal, low-risk change.

2. **Persona injection is the biggest product value add.** When Claude Code starts a session in a directory with an agent config, it should receive the agent's persona in its system prompt context. A backend API agent named "api-bot" with `persona: "You are an expert in this project's REST API layer..."` will behave more precisely than a generic Claude Code session. This is achievable by extending `context-builder.ts` to read the local `.dork/agent.json` — a focused, low-risk addition.

3. **Add `persona`, `color`, `icon` to `AgentManifest`.** These three fields unlock everything else without breaking the current schema. `persona` is a freeform string injected into context. `color` is a CSS color string for visual differentiation. `icon` is an optional emoji or named Lucide icon. The `UpdateAgentRequest` endpoint can expose these for editing.

4. **Create `entities/agent/` FSD layer** with `useCurrentAgent()` — a hook that returns the registered agent for the current `selectedCwd`, using TanStack Query against the Mesh API. This becomes the data source for all agent-aware UI components without coupling features to each other.

5. **Agent Profile UI via Settings + sidebar header.** The sidebar breadcrumb area should check `useCurrentAgent()` and render an `AgentHeader` component (name, color dot, description) when an agent is configured. A new "Agent" tab in Settings (or a gear icon on the AgentHeader) opens the `AgentProfilePanel` for viewing/editing the config.

6. **Pulse integration**: `CreateScheduleDialog` should show the agent name when the selected CWD has a registered agent, and schedule rows in `PulsePanel` should render agent name + color badge instead of raw paths.

**What to defer:**

- Approach 3 (agent as navigation axis / `?agent=` URL params) — high risk, right direction, but not for beta
- Agent capability enforcement (connecting `capabilities[]` to actual MCP tool access) — design first, build later
- A2A interop via `toAgentCard()` — useful eventually, not urgent

### Concrete Schema Changes

```typescript
// AgentManifest additions
export const AgentManifestSchema = z.object({
  // ...existing fields...
  persona: z.string().max(2000).optional(), // System prompt append for sessions
  color: z.string().optional(), // CSS color string (e.g. "#6366f1")
  icon: z.string().optional(), // Emoji or Lucide icon name
});

// UpdateAgentRequest additions
export const UpdateAgentRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  persona: z.string().max(2000).optional(), // new
  color: z.string().optional(), // new
  icon: z.string().optional(), // new
});
```

### Concrete `context-builder.ts` Change

```typescript
// In buildSystemPromptAppend(cwd):
const agentManifest = await readManifest(cwd).catch(() => null);
if (agentManifest?.persona) {
  blocks.push(`<agent_persona>\n${agentManifest.persona}\n</agent_persona>`);
}
if (agentManifest) {
  blocks.push(`<agent_identity>
Name: ${agentManifest.name}
ID: ${agentManifest.id}
Capabilities: ${agentManifest.capabilities.join(', ') || 'none declared'}
</agent_identity>`);
}
```

### New FSD Module

```
layers/entities/agent/
├── model/
│   ├── use-current-agent.ts   # TanStack Query for agent at selectedCwd
│   └── use-agent-by-id.ts     # Query by agent ID
├── index.ts
```

### UX Pattern: AgentHeader in Sidebar

When `useCurrentAgent()` returns an agent:

```
[●] backend-bot                              [gear]
    REST API specialist for this project
```

- `●` is the agent's `color` (or a deterministic color derived from agent ID)
- Clicking `[gear]` opens AgentProfilePanel
- Clicking the name/description shows agent details

When no agent is registered for the current directory:

```
[folder] /path/to/project                   [+ Agent]
```

- `[+ Agent]` opens a "Create agent for this directory" flow (populates name from dirname, description blank, writes `.dork/agent.json`)

---

## Sources & Evidence

- "Agent Card is a JSON metadata document published by an A2A Server, describing its identity, capabilities, skills, service endpoint, and authentication requirements" — [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/) (2025)
- "The role, goal, and backstory are incorporated into the system prompt sent to the model" — [CrewAI Agent Concepts](https://docs.crewai.com/en/concepts/agents) (2025)
- "Define agent specializations that act like focused teammates, using prompts and tool selections unique to your workflow" — [GitHub Copilot Custom Agents Changelog](https://github.blog/changelog/2025-10-28-custom-agents-for-github-copilot/) (Oct 2025)
- Custom agents placed in `.github/agents` directory with file-based configuration — [GitHub Copilot Custom Agents](https://github.blog/changelog/2025-10-28-custom-agents-for-github-copilot/)
- "You can switch between agents during a session or invoke them with the `@` mention" — [OpenCode Agents Docs](https://opencode.ai/docs/agents/)
- "Agents' associated knowledge, tools/skills, and connections with people and other agents are transparent and customizable" — [Microsoft UX Design for Agents](https://microsoft.design/articles/ux-design-for-agents/)
- "Agent status, or what the agent is doing, is clearly visible at all times" — [Microsoft UX Design for Agents](https://microsoft.design/articles/ux-design-for-agents/)
- Five prominent registry approaches analyzed: MCP Registry, A2A Agent Cards, AGNTCY ADS, Microsoft Entra Agent ID, NANDA Index — [Evolution of AI Agent Registry Solutions](https://arxiv.org/abs/2508.03095) (2025)
- "Agents should be granted only the minimum set of permissions necessary to do their job" — [AI Agent Access Control - WorkOS](https://workos.com/blog/ai-agent-access-control)
- DorkOS ADR 24: Use DorkOS-Native Agent Manifest at `.dork/agent.json` — internal decision, `decisions/0024-dorkos-native-agent-manifest-format.md`
- DorkOS ADR 43: File as canonical source of truth for Mesh registry — `decisions/0043-file-canonical-source-of-truth-for-mesh-registry.md`

---

## Research Gaps and Limitations

- No direct UX case studies for "agent-first navigation" (replacing directory navigation) in an existing developer tool — this pattern is emerging but not yet documented in production products
- OpenCode's full agent config format was only partially available; the interaction between global and project-local agents at the UI level was not documented
- No data on whether developers prefer named agents or prefer the simplicity of directory paths — user research would be needed to validate the recommendation
- GitHub Copilot's full technical schema for custom agent frontmatter fields was not publicly documented in the sources reviewed

---

## Contradictions and Disputes

- **CrewAI** treats role/goal/backstory as mandatory for every agent (agents are always named personas). **GitHub Copilot** and **OpenCode** treat agent names as optional — the "default" agent has no special name. DorkOS must decide: is an unnamed directory (no `.dork/agent.json`) a degraded state, or fully valid? The recommendation is "fully valid, with a gentle nudge to add one."
- **Google A2A** says agent identity is best expressed at an HTTP endpoint level with cryptographic signing. **DorkOS ADR 24** correctly argues this doesn't apply to local filesystem agents. These are not in conflict — they serve different deployment models.
- **Approach 3** (full agent-as-navigation-axis) is the most coherent long-term vision but conflicts with the existing `?dir=` architecture which is woven through server boundary validation, Obsidian plugin CWD resolution, and session storage paths. This is not a dispute — it is a genuine migration challenge that defers the full vision.

---

## Search Methodology

- Number of searches performed: 12 (7 web searches + 5 web fetches)
- Number of codebase reads: 5 key files
- Most productive search terms: "agent card specification JSON", "CrewAI agent config schema", "GitHub Copilot custom agents", "OpenCode agents docs"
- Primary information sources: A2A Protocol spec, CrewAI docs, GitHub Copilot changelog, OpenCode docs, Microsoft Design for Agents, arxiv agent registry paper
- Codebase sources: `packages/shared/src/mesh-schemas.ts`, `packages/mesh/src/manifest.ts`, `decisions/0024-*.md`, `decisions/0043-*.md`, `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`
