---
title: "Agent Tools Elevation — Per-Agent Config, UI Indicators, NL Orchestration, Agent-First Scheduling"
date: 2026-03-04
type: internal-architecture
status: active
tags: [agent-tools, mcp, per-agent-config, tool-acl, context-injection, scheduling, agent-manifest, sidebar-ui, orchestration]
feature_slug: agent-tools-elevation
searches_performed: 6
sources_count: 22
---

# Agent Tools Elevation

**Research depth:** Deep Research
**Prior research consulted:**
- `research/20260303_agent_tool_context_injection.md` — static XML context injection patterns (directly applicable to Goal 3)
- `research/mcp-tool-injection-patterns.md` — MCP tool architecture, `createDorkOsToolServer`, tool grouping by domain
- `research/20260218_agent-sdk-context-injection.md` — `systemPrompt.append`, SDK context mechanisms
- `research/20260226_agents_first_class_entity.md` — agent manifest schema evolution, `persona`, `color`, `icon` fields
- `research/20260303_command_palette_10x_elevation.md` — sidebar chip/status patterns, frecency, per-agent UI

---

## Research Summary

Four goals are analyzed: (1) per-agent tool enable/disable stored in manifest, (2) agent-scoped tool status chips in the sidebar, (3) natural language cross-tool orchestration via enhanced context injection, and (4) agent-based scheduling (resolving agent → CWD). The platform already has the infrastructure for all four — the work is integration and extension, not greenfield. The `AgentManifest` already has `capabilities[]` which is the right hook for per-tool config. The MCP tool server already groups tools by domain (`getCoreTools`, `getPulseTools`, etc.) which maps naturally to per-domain toggles. Context-builder already injects XML blocks. The Pulse schema already has `cwd` which can be augmented with `agentId`. No foundational rewrites needed.

---

## Key Findings

### 1. Per-Agent Tool Configuration

The `AgentManifest` currently has `capabilities: string[]` — an informational array. The tools in `createDorkOsToolServer` are grouped by domain (`getCoreTools`, `getPulseTools`, `getRelayTools`, `getAdapterTools`, `getBindingTools`, `getTraceTools`, `getMeshTools`). These two facts define the natural shape of a per-agent tool config.

**Best pattern: `enabledTools` map in the manifest, domain-keyed, defaulting to global feature-flag behavior.**

The industry pattern from MCP gateway research (Integrate.io, Traefik Hub, MintMCP) is: default-allow at the platform level, with per-agent/per-role overrides as an explicit opt-in. This is consistent with DorkOS's current model where all registered tools are available to all agents. The upgrade path is to add an opt-out mechanism per agent.

**Schema design (additive — backward-compatible):**

```typescript
// Zod schema addition to AgentManifestSchema
enabledToolGroups: z.object({
  pulse: z.boolean().optional(),    // undefined = inherit from server feature flag
  relay: z.boolean().optional(),    // undefined = inherit from isRelayEnabled()
  mesh: z.boolean().optional(),     // undefined = inherit (mesh is always-on)
  adapter: z.boolean().optional(),  // undefined = inherit
  binding: z.boolean().optional(),  // undefined = inherit
  trace: z.boolean().optional(),    // undefined = inherit
}).default({}).openapi({
  description: 'Per-domain tool group enable/disable. Undefined = use server feature flag default.',
})
```

This follows the "optional field with explicit default" pattern validated by JSON schema evolution best practices. Existing manifests without this field parse as `{}` (all groups inherit from server defaults). No migration needed.

**MCP server creation change**: `createDorkOsToolServer` takes `McpToolDeps`. It must also receive the agent manifest (or at least its `enabledToolGroups`). The MCP server is currently created once at startup — this conflicts with per-agent filtering. Two approaches:

- **Option A: Per-session MCP server creation** (dynamic composition). Create a tailored `createSdkMcpServer` per session using the agent's `enabledToolGroups` filter. Cons: `createSdkMcpServer` was designed for static registration; creating per-session servers risks resource leaks.
- **Option B: Single server + `allowedTools` filtering per session** (recommended). Create one MCP server with all tools registered. Per-session, pass `allowedTools` to the SDK `query()` call filtered by the agent's `enabledToolGroups`. This is idiomatic — `allowedTools` is explicitly designed for this use case.

**Implementation of Option B:**

```typescript
// In AgentManager.sendMessage(), after loading the session's agent manifest:
const manifest = await readManifest(effectiveCwd).catch(() => null);
const toolFilter = buildAllowedTools(manifest?.enabledToolGroups);

// toolFilter returns string[] like:
// ['mcp__dorkos__ping', 'mcp__dorkos__get_server_info', 'mcp__dorkos__mesh_*']
// based on which groups are enabled for this agent

sdkOptions.allowedTools = [
  ...(sdkOptions.allowedTools ?? []),
  ...toolFilter,
];
```

The `allowedTools` wildcard pattern `mcp__dorkos__mesh_*` covers all mesh tools. Each domain maps to a wildcard prefix:

| Domain group | `allowedTools` wildcard |
|---|---|
| Core | `mcp__dorkos__ping`, `mcp__dorkos__get_server_info`, `mcp__dorkos__get_session_count`, `mcp__dorkos__agent_get_current` |
| Pulse | `mcp__dorkos__list_schedules`, `mcp__dorkos__create_schedule`, etc. |
| Relay | `mcp__dorkos__relay_*` |
| Mesh | `mcp__dorkos__mesh_*` |
| Adapter | `mcp__dorkos__relay_list_adapters`, etc. |
| Binding | `mcp__dorkos__binding_*` |
| Trace | `mcp__dorkos__relay_get_trace`, `mcp__dorkos__relay_get_metrics` |

Core tools are always enabled (ping, get_server_info are diagnostic and harmless). Other groups are enabled unless explicitly disabled in the manifest.

**Security posture**: Default-allow at the platform level (consistent with current behavior). Per-agent opt-out. The `canUseTool` approval flow in `interactive-handlers.ts` provides the second gate for sensitive operations in `default` permission mode.

---

### 2. Agent-Scoped Tool Status UI Indicators

The sidebar currently shows `AgentContextChips` in `SessionSidebar`. These chips indicate connectivity status (Relay, Mesh) at the application level, not the per-agent level. Goal 2 is to make these chips reflect what tools are actually enabled for the *current agent*, not just whether the feature is globally enabled.

**Carbon Design System status indicator pattern**: The most relevant industry precedent is the Carbon Design System's pattern for status indicators in multi-entity UIs: "When multiple statuses are consolidated, use the highest-attention indicator to represent the group." Applied to DorkOS: an agent with Relay disabled should show the Relay chip as off/dimmed, even if the server's Relay feature flag is on.

**Progressive disclosure pattern (chip → tooltip → panel)**:

The chip shows a 3-state indicator:
- **Active**: tool group enabled for this agent and server feature flag is on
- **Disabled by agent**: tool group explicitly disabled in agent manifest (dimmed chip with strikethrough or muted color)
- **Disabled by server**: server feature flag is off for this group (chip hidden entirely — don't show a chip for a feature that isn't running)

This is the same pattern used by GitHub Copilot's agent capability indicators (green = on, gray = off, no icon = not applicable).

**Tooltip content on hover** (progressive disclosure):
```
Relay — enabled for this agent
3 active sessions using relay tools
Subject: relay.agent.{current-session-id}
```

Clicking the chip navigates to the relevant panel (Relay, Mesh, Pulse) with the current agent context pre-selected. This matches the "chip as navigation shortcut" pattern used by Vercel's project status indicators.

**Data flow for per-agent chips**:

```
useCurrentAgent(selectedCwd)     →  returns AgentManifest | null
  ↓
derive chip state:
  relayChipEnabled = isRelayEnabled() && (manifest?.enabledToolGroups?.relay !== false)
  meshChipEnabled = manifest?.enabledToolGroups?.mesh !== false
  pulseChipEnabled = isPulseEnabled() && (manifest?.enabledToolGroups?.pulse !== false)
  ↓
AgentContextChips receives derived booleans → renders chips
```

No new API calls needed — `useCurrentAgent()` already exists in `entities/agent/`. The derivation logic is pure boolean computation in the component.

**Sidebar placement**: The `AgentContextChips` component in `SessionSidebar` is the right location. The chips row already exists; the change is making chip state agent-aware rather than globally-aware.

---

### 3. Natural Language Cross-Tool Orchestration via Context Injection

The most recently completed research (`20260303_agent_tool_context_injection.md`) already contains the complete design for this goal. Key insights to extend it for the elevation feature:

**What's already specced**: Static `<relay_tools>` and `<mesh_tools>` XML blocks injected via `context-builder.ts`. These document subject naming conventions, workflow sequences, and cross-tool patterns.

**What this feature adds**: Making the injected context *agent-aware*. When an agent has specific tools disabled via `enabledToolGroups`, the context blocks should reflect that.

**Two approaches for agent-aware context injection:**

**Option A: Conditional block omission (recommended)**
If `enabledToolGroups.relay === false` for this agent, omit `<relay_tools>` from `buildSystemPromptAppend()`. The agent won't receive relay tool context because it won't have relay tools available. Keeps the context clean and prevents confusion.

**Option B: Blocks with caveats**
Always include blocks, but add a note when a domain is disabled: `<relay_tools>Note: Relay tools are disabled for this agent.</relay_tools>`. Useful for transparency but wastes tokens.

**Recommendation**: Option A. Omitting the block is the right behavior — don't document tools the agent can't use.

**Additional context that elevates orchestration**: The prior research identified the relay subject hierarchy as the most critical missing context. For the elevation feature, add *peer agent context* — a list of currently registered mesh agents and their relay addresses. This is what enables natural language like "ask the API agent to check the endpoint."

**Peer agent context block:**

```xml
<peer_agents>
Available agents on this machine:
- api-bot (relay.agent.{sessionId}) — REST API specialist for ~/projects/api
- test-runner (relay.agent.{sessionId}) — runs test suites for ~/projects/tests
Use mesh_list() for current agent registry, mesh_inspect(agentId) for relay endpoints.
</peer_agents>
```

**Token cost**: ~80-150 tokens for a list of 3-5 agents. Acceptable.

**Dynamic vs static for peer agents**: Unlike relay/mesh workflow docs (always static), peer agent data changes as agents register/unregister. Two options:

- **Embed current registry snapshot at session start**: Call `meshCore.listAgents()` inside `buildSystemPromptAppend()` and format as the `<peer_agents>` block. This is a one-time async call per session, not per message.
- **Instruct agent to call `mesh_list()` when needed**: Keep context block static ("use mesh_list() to find available agents") and let the agent pull live data via the MCP tool.

**Recommendation**: Hybrid. The `<peer_agents>` block lists agents *at session start* (best effort, may be stale after an hour). The instruction to call `mesh_list()` covers the dynamic case. This matches how Claude Code injects `<git_status>` — accurate at session start, not live-updating.

**Workflow recipes in context**: Beyond subject hierarchy docs, add short "recipes" for common multi-tool workflows:

```xml
<relay_tools>
...existing subject hierarchy content...

Workflow: Query another agent
1. mesh_list() to find available agents
2. mesh_inspect(agentId) to get their relay endpoint
3. relay_register_endpoint(subject="relay.agent.{mySessionId}") so they can reply
4. relay_send(subject="relay.agent.{their-sessionId}", payload={task}, replyTo="relay.agent.{mySessionId}")
5. relay_inbox(endpoint_subject="relay.agent.{mySessionId}") to check for reply
</relay_tools>
```

This recipe is 5 numbered steps covering 5 distinct tool calls. Without this, the agent must reason through the sequence from scratch on every orchestration attempt.

---

### 4. Agent-First Scheduling (Agent → CWD Resolution)

Currently `PulseSchedule` has:
- `cwd: string | null` — the working directory where the scheduled agent runs

Goal: Allow scheduling by agent identity rather than by CWD path. The agent's registered CWD (`projectPath` in `AgentManifest`) is the resolved working directory.

**Schema change (backward-compatible additive):**

```typescript
// In shared types / DB schema, add to PulseSchedule:
agentId: z.string().optional()  // ULID of a registered Mesh agent
// cwd remains — when agentId is set, cwd is derived from the agent's projectPath
// when agentId is not set, cwd is used directly (backward compatible)
```

**Resolution logic in SchedulerService.executeRun()**:

```typescript
async function resolveEffectiveCwd(schedule: PulseSchedule): Promise<string> {
  if (schedule.agentId) {
    const agent = await meshCore.getAgent(schedule.agentId);
    if (!agent) throw new Error(`Agent ${schedule.agentId} not found — schedule ${schedule.id} cannot run`);
    return agent.projectPath;
  }
  return schedule.cwd ?? defaultCwd;
}
```

**Agent picker UX patterns** (from automation tool research):

n8n uses `@AgentName` mentions for agent selection in workflows. GitHub Actions uses environment dropdowns (select from a named list). Linear uses entity pickers (type-ahead search from a list of projects). Zapier uses "account" selectors (pre-connected integration identities).

For DorkOS's `CreateScheduleDialog`, the agent picker pattern from Linear and n8n is most applicable:

```
Schedule runs in: [Agent Picker ▾]
  ○ Agent (recommended)   [backend-bot — ~/projects/api    ▾]
  ○ Directory             [/path/to/project]
```

The agent picker is a combobox (`shadcn/ui` Select or Combobox) populated from `useRegisteredAgents()`. When "Agent" is selected, the displayed agent name replaces the raw CWD path in the schedule row in `PulsePanel`.

**Migration strategy for existing schedules**: Existing schedules have `agentId: null`. They continue to resolve via `cwd` unchanged. If a user opens an existing schedule in the edit dialog and the `cwd` matches a registered agent's `projectPath`, the UI can offer "Link to agent: [agent-name]?" as a soft nudge — not forced.

**Display in PulsePanel schedule rows:**

```
[●] backend-bot                    daily at 02:00   Last run: 3h ago   ● active
    Run tests and review changes

[folder] ~/projects/legacy-app     weekly Sun       Last run: 2d ago   ● active
    Old CWD-based schedule
```

Agent-linked schedules show the colored agent dot + name. CWD-based schedules show the folder icon + path. This distinction is immediately scannable.

**Agent-linked schedule benefits**: If an agent's `projectPath` changes (e.g., the project is moved), the schedule follows the agent ID rather than breaking on a stale path. The agent registry becomes the single source of truth for path resolution.

---

## Detailed Analysis

### Goal 1: Per-Agent Tool Config — Full Implementation Design

#### Schema Layer

**`AgentManifest` (packages/shared/src/mesh-schemas.ts)**:

```typescript
export const EnabledToolGroupsSchema = z.object({
  pulse: z.boolean().optional(),
  relay: z.boolean().optional(),
  mesh: z.boolean().optional(),
  adapter: z.boolean().optional(),
  binding: z.boolean().optional(),
  trace: z.boolean().optional(),
}).default({}).openapi('EnabledToolGroups');

// Add to AgentManifestSchema:
enabledToolGroups: EnabledToolGroupsSchema,
```

**`UpdateAgentRequestSchema` (same file)**:

```typescript
// Add to UpdateAgentRequestSchema:
enabledToolGroups: EnabledToolGroupsSchema.optional(),
```

No DB migration needed — `enabledToolGroups` is stored in `.dork/agent.json` (the manifest file), not in the SQLite table. The file-first pattern (ADR-0043) means this field is available immediately after writing, without schema migration.

#### Server Layer

**New utility function `buildAllowedTools(manifest, deps)`** (new file `apps/server/src/services/core/tool-filter.ts` or inline in `agent-manager.ts`):

```typescript
/**
 * Build the allowedTools list for a session based on agent manifest tool group config.
 * Returns undefined if all tools should be allowed (no filtering needed).
 */
export function buildAgentAllowedTools(
  enabledToolGroups: Record<string, boolean | undefined> | undefined,
  deps: { relayEnabled: boolean; pulseEnabled: boolean }
): string[] | undefined {
  // If no tool group config, no filtering (all available tools per feature flags)
  if (!enabledToolGroups || Object.keys(enabledToolGroups).length === 0) {
    return undefined;
  }

  const allowed: string[] = [
    // Core tools always allowed
    'mcp__dorkos__ping',
    'mcp__dorkos__get_server_info',
    'mcp__dorkos__get_session_count',
    'mcp__dorkos__agent_get_current',
  ];

  if (enabledToolGroups.pulse !== false && deps.pulseEnabled) {
    allowed.push(
      'mcp__dorkos__list_schedules',
      'mcp__dorkos__create_schedule',
      'mcp__dorkos__update_schedule',
      'mcp__dorkos__delete_schedule',
      'mcp__dorkos__get_run_history',
    );
  }

  if (enabledToolGroups.relay !== false && deps.relayEnabled) {
    allowed.push(
      'mcp__dorkos__relay_send',
      'mcp__dorkos__relay_inbox',
      'mcp__dorkos__relay_list_endpoints',
      'mcp__dorkos__relay_register_endpoint',
    );
  }

  if (enabledToolGroups.mesh !== false) {
    allowed.push(
      'mcp__dorkos__mesh_discover',
      'mcp__dorkos__mesh_register',
      'mcp__dorkos__mesh_list',
      'mcp__dorkos__mesh_deny',
      'mcp__dorkos__mesh_unregister',
      'mcp__dorkos__mesh_status',
      'mcp__dorkos__mesh_inspect',
      'mcp__dorkos__mesh_query_topology',
    );
  }

  if (enabledToolGroups.adapter !== false && deps.relayEnabled) {
    allowed.push(
      'mcp__dorkos__relay_list_adapters',
      'mcp__dorkos__relay_enable_adapter',
      'mcp__dorkos__relay_disable_adapter',
      'mcp__dorkos__relay_reload_adapters',
    );
  }

  if (enabledToolGroups.binding !== false && deps.relayEnabled) {
    allowed.push(
      'mcp__dorkos__binding_list',
      'mcp__dorkos__binding_create',
      'mcp__dorkos__binding_delete',
    );
  }

  if (enabledToolGroups.trace !== false && deps.relayEnabled) {
    allowed.push(
      'mcp__dorkos__relay_get_trace',
      'mcp__dorkos__relay_get_metrics',
    );
  }

  return allowed;
}
```

**In `AgentManager.sendMessage()`**: After `effectiveCwd` is resolved and before `query()` is called, load the manifest and apply the filter:

```typescript
// Load agent manifest for tool filtering (non-blocking — failure allows all tools)
const manifest = await readManifest(effectiveCwd).catch(() => null);
const agentAllowedTools = buildAgentAllowedTools(
  manifest?.enabledToolGroups,
  { relayEnabled: isRelayEnabled(), pulseEnabled: isPulseEnabled() }
);

if (agentAllowedTools) {
  sdkOptions.allowedTools = [
    ...(sdkOptions.allowedTools ?? []),
    ...agentAllowedTools,
  ];
}
```

Note: `readManifest` is a disk read that may fail (no `.dork/agent.json`). The `catch(() => null)` pattern is correct — failure means no agent manifest, which means all tools are available (the existing behavior).

#### UI Layer: Agent Settings Dialog — Tool Group Toggles

The `AgentDialog` in `features/agent-settings/` currently has Identity, Persona, Capabilities, and Connections tabs. Add a **Tools tab** (or rename Capabilities to Tools):

```
[Identity] [Persona] [Tools] [Connections]
```

**Tools tab content:**

```
Tool Groups
─────────────────────────────────────────────

○ Core Tools                     Always enabled
  ping, server info, session count, agent identity

[■] Pulse (Scheduling)           Enabled
  Create and manage scheduled agent runs

[■] Relay (Messaging)            Enabled
  Send messages, check inbox, register endpoints

[■] Mesh (Discovery)             Enabled
  Discover, register, and query agents

[■] Relay Adapters               Enabled
  Manage Slack, Telegram, and other adapters

[■] Bindings                     Enabled
  Configure adapter-to-agent routing

[■] Trace (Observability)        Enabled
  Query message delivery traces and metrics

─────────────────────────────────────────────
Disabled tool groups are excluded from this
agent's sessions but remain available globally.
```

Shadcn `Switch` components for each group. Core tools are non-interactive (always on). Server-disabled features (e.g., Relay when `DORKOS_RELAY_ENABLED=false`) are shown as grayed out with a tooltip: "Disabled globally by server configuration."

**Save behavior**: PATCH to `PATCH /api/agents/current` with `{ enabledToolGroups: { relay: false } }`. File-first write-through updates `.dork/agent.json` immediately.

---

### Goal 2: Sidebar Tool Status Chips — Implementation Design

**Current `AgentContextChips` component** reads global feature flags. The change is to make it read the intersection of global feature flags + current agent's `enabledToolGroups`.

**New hook** (or extend `useCurrentAgent`):

```typescript
// entities/agent/model/use-agent-tool-status.ts
export function useAgentToolStatus() {
  const { data: agent } = useCurrentAgent();
  const relayEnabled = useRelayEnabled();
  const pulseEnabled = usePulseEnabled();

  return {
    relay: relayEnabled && agent?.enabledToolGroups?.relay !== false,
    pulse: pulseEnabled && agent?.enabledToolGroups?.pulse !== false,
    mesh: agent?.enabledToolGroups?.mesh !== false,  // mesh is always-on
    adapter: relayEnabled && agent?.enabledToolGroups?.adapter !== false,
    binding: relayEnabled && agent?.enabledToolGroups?.binding !== false,
    trace: relayEnabled && agent?.enabledToolGroups?.trace !== false,
    // reason for disabled state (for tooltip)
    relayDisabledReason: !relayEnabled ? 'server' : agent?.enabledToolGroups?.relay === false ? 'agent' : null,
  };
}
```

**AgentContextChips chip states:**

| State | Visual | Tooltip |
|---|---|---|
| `enabled` (global + agent) | Colored chip, normal opacity | "Relay — enabled for {agent-name}" |
| `disabled-by-agent` | Muted chip, `line-through` label or `[off]` suffix | "Relay — disabled for this agent" |
| `disabled-by-server` | Chip hidden | — |

The chip being hidden when server-disabled is cleaner than showing a permanently-grayed indicator. When a user is confused why they don't see a Relay chip, they check Settings (which already shows the global feature flags).

**Three-dot overflow for extra chip metadata**: On hover, a minimal badge appears on the chip showing active tool usage count:

```
[Relay ●3]  ← 3 relay tool calls in this session
```

This is already a common pattern in VS Code's status bar items and Vercel's deployment indicators.

---

### Goal 3: Natural Language Orchestration — Full Context Block Design

**Extension to `buildSystemPromptAppend()` in `context-builder.ts`:**

```typescript
export async function buildSystemPromptAppend(cwd: string): Promise<string> {
  const manifest = await readManifest(cwd).catch(() => null);

  const [envResult, gitResult, agentResult, relayResult, meshResult, peerResult] =
    await Promise.allSettled([
      buildEnvBlock(cwd),
      buildGitBlock(cwd),
      buildAgentBlock(cwd, manifest),
      buildRelayToolsBlock(manifest),      // now manifest-aware
      buildMeshToolsBlock(manifest),       // now manifest-aware
      buildPeerAgentsBlock(meshCore),      // new
    ]);

  return [envResult, gitResult, agentResult, relayResult, meshResult, peerResult]
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => (r as PromiseFulfilledResult<string>).value)
    .join('\n\n');
}
```

**Agent-aware relay tools block:**

```typescript
function buildRelayToolsBlock(manifest: AgentManifest | null): string {
  if (!isRelayEnabled()) return '';
  if (manifest?.enabledToolGroups?.relay === false) return '';  // agent opted out

  return `<relay_tools>
DorkOS Relay lets agents exchange messages via a pub/sub subject hierarchy.

Subject conventions:
  relay.agent.{sessionId}          — address a specific Claude Code session
  relay.human.console.{clientId}  — reach a human in the DorkOS UI
  relay.system.console            — system broadcast
  relay.system.pulse.{scheduleId} — Pulse scheduler events

Workflow: Query another agent
1. mesh_list() to find available agents and their session IDs
2. mesh_inspect(agentId) to get their relay endpoint
3. relay_register_endpoint(subject="relay.agent.{mySessionId}") to enable replies
4. relay_send(subject="relay.agent.{their-sessionId}", payload={task}, replyTo="relay.agent.{mySessionId}")
5. relay_inbox(endpoint_subject="relay.agent.{mySessionId}") to check for reply

Error codes: RELAY_DISABLED, ACCESS_DENIED, INVALID_SUBJECT, ENDPOINT_NOT_FOUND
</relay_tools>`;
}
```

**Peer agents block (new, requires `meshCore` in context-builder dependencies):**

```typescript
async function buildPeerAgentsBlock(meshCore: MeshCore | null): Promise<string> {
  if (!meshCore) return '';

  try {
    const agents = await meshCore.listAgents({ limit: 10 });
    if (agents.length === 0) return '';

    const lines = agents
      .map((a) => `- ${a.name} (${a.projectPath}) — ${a.description || 'no description'}`)
      .join('\n');

    return `<peer_agents>
Registered agents on this machine (use mesh_list() for live data):
${lines}

To contact a peer agent: mesh_inspect(agentId) gets their relay endpoint, then relay_send to that subject.
</peer_agents>`;
  } catch {
    return '';
  }
}
```

**Dependency injection change**: `buildSystemPromptAppend` needs access to `meshCore`. Currently it is a standalone async function that only takes `cwd`. Options:

- **Option A**: Add `meshCore` as a parameter to `buildSystemPromptAppend(cwd, meshCore?)`. Callers pass it in.
- **Option B**: Import `meshCore` singleton from a module (same pattern as `isRelayEnabled()` imports `relay-state.ts`).

Option B is simpler and consistent with the existing pattern for relay state. Add a `mesh-state.ts` export for `getMeshCore()`.

---

### Goal 4: Agent-First Scheduling — Full Implementation Design

#### DB Schema (packages/db)

Add `agentId` column to `pulseSchedules` table:

```typescript
// packages/db/src/schema.ts — pulseSchedules table
agentId: text('agent_id'),  // nullable — null = use cwd-based resolution
```

This is a nullable column addition — backward-compatible at the SQLite level (existing rows get `NULL`). One Drizzle migration file needed.

#### Shared Types (packages/shared)

```typescript
// In PulseSchedule type (CreateScheduleInput schema)
agentId: z.string().optional(),  // ULID of registered Mesh agent
```

#### Server: SchedulerService

```typescript
// In SchedulerService.executeRun():
private async resolveEffectiveCwd(schedule: PulseSchedule): Promise<string> {
  if (schedule.agentId && this.meshCore) {
    const agent = this.meshCore.getAgent(schedule.agentId);
    if (agent?.projectPath) {
      return agent.projectPath;
    }
    this.logger.warn({ scheduleId: schedule.id, agentId: schedule.agentId },
      'Agent not found for schedule — falling back to cwd');
  }
  return schedule.cwd ?? this.defaultCwd;
}
```

Graceful degradation: if the agent is not found (deleted from registry), falls back to the stored CWD. This prevents schedules from breaking silently when an agent is unregistered.

#### Client: CreateScheduleDialog Changes

**Agent picker vs directory picker toggle:**

```tsx
// State
const [scheduleTarget, setScheduleTarget] = useState<'agent' | 'directory'>('agent');
const { data: agents } = useRegisteredAgents();

// Form section
<RadioGroup value={scheduleTarget} onValueChange={setScheduleTarget}>
  <RadioGroupItem value="agent">Run for agent</RadioGroupItem>
  <RadioGroupItem value="directory">Run in directory</RadioGroupItem>
</RadioGroup>

{scheduleTarget === 'agent' && (
  <AgentCombobox
    agents={agents ?? []}
    value={selectedAgentId}
    onValueChange={setSelectedAgentId}
  />
)}

{scheduleTarget === 'directory' && (
  <DirectoryPicker value={cwd} onChange={setCwd} />
)}
```

**`AgentCombobox` component**: A shadcn Command-based combobox showing agent name + colored dot + project path. Uses `useRegisteredAgents()` data. Searches by name or path. Follows the same pattern as `DirectoryPicker` but for agents.

**Schedule row in PulsePanel:**

```tsx
// ScheduleRow enhancement
const agentForSchedule = schedule.agentId
  ? agents?.find((a) => a.id === schedule.agentId)
  : null;

// Display
{agentForSchedule ? (
  <div className="flex items-center gap-1.5">
    <AgentDot color={agentForSchedule.color} />
    <span className="font-medium">{agentForSchedule.name}</span>
  </div>
) : (
  <div className="flex items-center gap-1.5">
    <FolderOpen className="size-3.5 text-muted-foreground" />
    <span className="font-mono text-sm">{schedule.cwd ?? 'default'}</span>
  </div>
)}
```

---

## Potential Solutions Summary

### Goal 1: Per-Agent Tool Enable/Disable

| Solution | Approach | Risk | Effort |
|---|---|---|---|
| **A (Recommended)** | `enabledToolGroups` in manifest + `allowedTools` per session | Low | Medium |
| B | Dynamic MCP server per session | High (resource leaks) | High |
| C | Tool-level boolean flags in manifest | Low (but verbose schema) | Medium |

**Recommendation**: Solution A. `allowedTools` is the SDK's intended mechanism for per-session tool filtering. The manifest field is purely a data store — the filter is computed per session by `agent-manager.ts`.

### Goal 2: Agent-Scoped UI Indicators

| Solution | Approach | Risk | Effort |
|---|---|---|---|
| **A (Recommended)** | `useAgentToolStatus()` hook + chip 3-state | Low | Low |
| B | Per-chip tooltip showing manifest state | Low | Low |
| C | Full tool status panel in agent settings only | Low | Low |

**Recommendation**: Solution A as the primary (chip state), with Solution C as the secondary (full tool toggles in the AgentDialog Tools tab).

### Goal 3: Natural Language Orchestration

| Solution | Approach | Risk | Effort |
|---|---|---|---|
| **A (Recommended)** | Agent-aware context blocks + peer agents block | Low | Low |
| B | MCP resource endpoint for tool docs | Low | Medium |
| C | Extended tool descriptions only | Low | Very Low |

**Recommendation**: Solution A, extending `context-builder.ts` to be manifest-aware and adding the `<peer_agents>` block. Solution C is already implemented (tool descriptions exist) — it's the system prompt context blocks that are the gap.

### Goal 4: Agent-First Scheduling

| Solution | Approach | Risk | Effort |
|---|---|---|---|
| **A (Recommended)** | `agentId` optional field + graceful fallback | Low | Medium |
| B | Replace CWD with agent entirely | High (breaks existing schedules) | High |
| C | Agent display alias with CWD unchanged | Low | Low |

**Recommendation**: Solution A. Additive optional field — backward compatible by design. Existing CWD-based schedules are untouched.

---

## Security Considerations

1. **Tool group enforcement is defense-in-depth, not a security boundary.** The `allowedTools` filter in the SDK prevents disabled tools from being called. However, the agent's capability to perform the same underlying actions via other means (Bash, file tools) is unchanged. Per-agent tool config is about workflow clarity and noise reduction, not hard security isolation.

2. **`enabledToolGroups` is user-authored data.** It is read from `.dork/agent.json` on disk, which is user-controlled. Never treat this as a security boundary that prevents privilege escalation. The `canUseTool` approval flow is the security gate.

3. **`readManifest` in `sendMessage()`** reads from disk on every session start. The path is `${effectiveCwd}/.dork/agent.json`. The `effectiveCwd` is already boundary-validated by the server. No new attack surface introduced.

4. **Peer agent context block** includes agent names and project paths. These are user-owned data on the same machine. No cross-user or cross-network exposure risk in the local-first deployment model.

5. **Agent ID in PulseSchedule** is stored as a ULID string in the DB. Resolved via Mesh registry. If a malicious actor injects a fake agent ID into a schedule, the resolution fallback (graceful degradation to CWD) prevents silent execution in an unintended directory — but the server should validate that the resolved `projectPath` is within the configured boundary.

---

## Performance Considerations

1. **`readManifest` per session start**: One disk read (`~/.dork/agent.json` or `{cwd}/.dork/agent.json`). Negligible cost — file is small (<1KB), read at session start, not per message. Already done in `context-builder.ts` for `buildAgentBlock`.

2. **`buildPeerAgentsBlock` with `meshCore.listAgents()`**: One DB query against the Mesh SQLite index at session start. Limit to 10 agents to prevent bloated context. Already fast (SQLite, indexed by `projectPath`).

3. **`allowedTools` list length**: The full tool list for a session with all groups enabled is ~25 tool names. At ~20 characters each, this is 500 bytes added to the SDK options object per session. No meaningful overhead.

4. **Chip state computation** in `useAgentToolStatus()` is pure boolean logic on already-fetched data. Zero additional network requests.

5. **Agent picker in `CreateScheduleDialog`**: Uses `useRegisteredAgents()` which is already fetched by other Mesh components. TanStack Query deduplication means no extra network calls.

---

## Overall Recommendation and Sequencing

**Sequencing by impact/effort ratio:**

### Phase 1: Context Injection Enhancement (1-2 days)
*Highest impact, builds on already-specced work*

Extend `context-builder.ts` to:
- Add agent-awareness to `buildRelayToolsBlock()` and `buildMeshToolsBlock()` (skip blocks if agent has opted out)
- Add `buildPeerAgentsBlock()` with `meshCore.listAgents()` at session start
- Add workflow recipes to relay block

Files: `apps/server/src/services/core/context-builder.ts` (modify)

### Phase 2: Per-Agent Tool Config Schema + Server Filtering (2-3 days)
*Unlocks the UI work, defines the contract*

- Add `enabledToolGroups` to `AgentManifestSchema` and `UpdateAgentRequestSchema`
- Add `buildAgentAllowedTools()` utility
- Extend `agent-manager.ts` to load manifest and apply `allowedTools` filter per session
- Unit tests for the filter logic

Files: `packages/shared/src/mesh-schemas.ts`, new `apps/server/src/services/core/tool-filter.ts`, `apps/server/src/services/core/agent-manager.ts`

### Phase 3: UI — Agent Settings Tools Tab (1-2 days)
*User-facing control for Phase 2*

- Add Tools tab to `AgentDialog`
- Toggle switches per domain group
- Wire to PATCH `/api/agents/current`

Files: `apps/client/src/layers/features/agent-settings/ui/ToolsTab.tsx` (new), `AgentDialog.tsx` (modify)

### Phase 4: Sidebar Tool Status Chips (1 day)
*Glanceable per-agent status*

- Add `useAgentToolStatus()` hook to `entities/agent/`
- Update `AgentContextChips` to use hook instead of global feature flags
- Add 3-state chip rendering (enabled / disabled-by-agent / hidden)

Files: `entities/agent/model/use-agent-tool-status.ts` (new), `features/session-list/ui/AgentContextChips.tsx` (modify)

### Phase 5: Agent-First Scheduling (2-3 days)
*Completes the agent-identity vision*

- Add `agentId` column to DB schema + Drizzle migration
- Add `agentId` to `PulseSchedule` shared type
- Update `SchedulerService.executeRun()` with agent resolution
- Add `AgentCombobox` component
- Update `CreateScheduleDialog` with agent/directory picker toggle
- Update `ScheduleRow` to display agent name + color dot when `agentId` set

Files: `packages/db/src/schema.ts`, migration file, `packages/shared/src/types.ts`, `apps/server/src/services/pulse/scheduler-service.ts`, `apps/client/src/layers/features/pulse/ui/` (multiple)

**Total estimated effort**: 7-11 days of focused implementation, assuming the research phase is complete.

---

## Research Gaps and Limitations

- **`allowedTools` wildcard behavior with prefixes** (e.g., `mcp__dorkos__relay_*`): The SDK docs show wildcard syntax but the exact prefix matching semantics (prefix vs exact token match) are not fully documented. May require testing to confirm `relay_*` covers all relay tools vs needing exact names.
- **`meshCore.listAgents()` in `context-builder.ts`**: Requires injecting `meshCore` as a dependency into the context builder. Currently, `buildSystemPromptAppend` is a standalone function that only takes `cwd`. The dependency injection pattern (import singleton vs parameter) needs a decision.
- **Agent-picked schedule fallback behavior**: When an agent is unregistered mid-schedule, should the run (a) proceed with the last-known CWD, (b) fail with a clear error, or (c) be auto-disabled? The recommendation (fallback to stored CWD) is pragmatic but may not be the best long-term UX.
- **No empirical data on token impact of `<peer_agents>` block**: The 80-150 token estimate for a 5-agent list is theoretical. Actual Claude behavior change from peer agent context injection is untested in DorkOS's sessions.

---

## Contradictions and Disputes

- **Default-allow vs default-deny for tool groups**: MCP gateway industry practice favors default-deny with explicit grants (zero-trust). DorkOS's existing model is default-allow (all tools available). The recommendation maintains default-allow for backward compatibility and simplicity, with per-agent opt-out. This is a deliberate deviation from enterprise MCP gateway patterns — justifiable because DorkOS is a developer tool, not an enterprise gateway.
- **Static vs dynamic peer agent context**: The recommendation to embed a static snapshot at session start contradicts strict freshness requirements. In a long-running session (2+ hours), the peer agent list may become stale. The `mesh_list()` instruction covers this case, but agents may not think to refresh. Acceptable tradeoff for the session-start approach — the alternative (dynamic injection via `UserPromptSubmit` hook) is more complex and the hook `additionalContext` bug (GitHub issue #14281) makes it unreliable.

---

## Sources and Evidence

Prior DorkOS research (all highly relevant, directly cited above):
- `research/20260303_agent_tool_context_injection.md` — XML block structure, token budgets, static vs dynamic injection decision
- `research/mcp-tool-injection-patterns.md` — MCP architecture, `createSdkMcpServer`, tool grouping by domain, `allowedTools` wildcard syntax
- `research/20260218_agent-sdk-context-injection.md` — `systemPrompt.append`, SDK option shapes, hook-based injection limitations
- `research/20260226_agents_first_class_entity.md` — agent manifest schema evolution, `enabledToolGroups` predecessor (`capabilities[]`), agent-first navigation vision
- `research/20260303_command_palette_10x_elevation.md` — sidebar chip/status patterns, progressive disclosure, 3-state indicators

External sources:
- [MCP Gateways and AI Agent Security Tools 2026 — Integrate.io](https://www.integrate.io/blog/best-mcp-gateways-and-ai-agent-security-tools/) — default-allow vs default-deny patterns, per-agent ACL industry practice
- [Traefik Hub Triple Gate Pattern — MintMCP Blog](https://www.mintmcp.com/blog/enterprise-ai-infrastructure-mcp) — Task-Based Access Control (TBAC) for dynamic agent authorization
- [Carbon Design System Status Indicator Pattern](https://carbondesignsystem.com/patterns/status-indicator-pattern/) — "highest-attention consolidation" for multi-entity status chips; 3-state indicator design
- [Schema Evolution and Compatibility — Confluent](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html) — additive optional field migration is the standard backward-compatible pattern
- [Evolving JSON Schemas — Creek Service](https://www.creekservice.org/articles/2024/01/08/json-schema-evolution-part-1.html) — producing schemas vs consuming schemas; open content model for consuming
- [n8n Agent @mentions pattern](https://n8n.io/workflows/3473-scalable-multi-agent-chat-using-mentions/) — agent selection by name mention in scheduling contexts
- [Zapier Agents Pods architecture](https://www.nocodefinder.com/blog-posts/zapier-agents-guide) — functional agent grouping and entity selection in scheduling/automation UIs
- DorkOS codebase: `apps/server/src/services/core/mcp-tools/index.ts` — existing tool grouping structure (getCoreTools, getPulseTools, etc.)
- DorkOS codebase: `packages/shared/src/mesh-schemas.ts` — current AgentManifest schema (already has `capabilities[]`, `persona`, `color`, `icon`)
- DorkOS codebase: `apps/server/src/services/pulse/pulse-store.ts` — current PulseSchedule schema with `cwd: string | null`

---

## Search Methodology

- Searches performed: 6 WebSearch calls
- Prior research consumed before external search: 5 reports (all directly on-point, reduced need for external research significantly)
- Most productive external search terms: "per-agent tool access control MCP multi-agent platform 2025", "JSON schema optional field migration backward compatibility additive change"
- Primary external sources: MCP gateway comparison articles (Integrate.io, MintMCP), Carbon Design System, Confluent schema evolution docs, Creek Service schema evolution
- Codebase reads: 7 source files (`mcp-tools/index.ts`, `mcp-tools/types.ts`, `mesh-schemas.ts`, `pulse-store.ts`, `specs/manifest.json`, etc.)
