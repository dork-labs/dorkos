# Agent Tools Elevation

**Status:** Draft
**Authors:** Claude Code, 2026-03-04
**Spec:** #89
**Ideation:** `specs/agent-tools-elevation/01-ideation.md`
**Research:** `research/20260304_agent_tools_elevation.md`

---

## Overview

Evolve DorkOS's agent-tool management from global-only toggles into a per-agent tool system. Four interconnected goals delivered in five phases:

1. **Per-agent tool enable/disable** stored in agent manifests with global defaults
2. **Agent-scoped sidebar indicators** showing per-agent tool status
3. **Natural language cross-tool orchestration** via enhanced, agent-aware context injection
4. **Agent-first Pulse scheduling** (agent identity instead of raw CWD paths)

All changes are backward-compatible. Existing manifests without `enabledToolGroups` inherit global defaults. Existing CWD-based schedules continue working unchanged.

---

## Background / Problem Statement

Spec #88 (Agent Tool Context Injection) introduced global config toggles (`agentContext.relayTools`, `meshTools`, `adapterTools`) that gate XML context blocks and are editable in a `ContextTab` inside `AgentDialog`. However:

- **Toggles are global, not per-agent.** All agents share the same tool configuration. An API specialist agent gets the same Pulse/Relay/Mesh tools as a test runner agent, cluttering their tool palette.
- **Sidebar chips reflect global state.** `AgentContextChips` reads feature flags, not per-agent config. Switching agents doesn't change chip state.
- **Context injection is static.** No workflow recipes, no peer agent awareness. Agents can't naturally discover or communicate with peers.
- **Pulse scheduling is CWD-based.** Schedules reference raw directory paths. If a project moves, the schedule breaks. No link between a schedule and the agent that should run it.
- **Agent unregister has no cascading effects.** Removing an agent from Mesh leaves orphaned Pulse schedules pointing at stale CWDs.

---

## Goals

- Per-agent tool domain toggles (pulse, relay, mesh, adapter) persisted in `.dork/agent.json`
- Dual gating: MCP `allowedTools` filter + context block omission, always in sync
- Agent-scoped sidebar chips with 3-state rendering (enabled / disabled-by-agent / hidden)
- Peer agents context block injected at session start for natural cross-agent orchestration
- Agent-first Pulse scheduling with agent picker UI
- Cascade on agent unregister: auto-disable linked schedules, fail runs with error
- Global defaults relocated from AgentDialog's ContextTab to SettingsDialog's new Tools tab

---

## Non-Goals

- Per-tool granularity (only per-domain: Pulse, Relay, Mesh, Adapter)
- Relay core protocol changes
- Mesh protocol or topology changes
- New adapter types
- Obsidian plugin changes
- Marketing site or documentation changes
- Hard security isolation (tool filtering is defense-in-depth, not a security boundary)

---

## Technical Dependencies

| Dependency                              | Version | Purpose                               |
| --------------------------------------- | ------- | ------------------------------------- |
| `@anthropic-ai/claude-code` (Agent SDK) | Current | `allowedTools` option in `query()`    |
| `better-sqlite3`                        | Current | `agentId` column in `pulse_schedules` |
| `drizzle-orm`                           | Current | Schema migration for new column       |
| `zod`                                   | Current | Schema extensions                     |
| `shadcn/ui` (Switch, Select, Tooltip)   | Current | Tool toggle UI, agent picker          |

No new external dependencies required. All libraries are already in the monorepo.

---

## Related ADRs

- **ADR-0043**: Agent storage file-first write-through. All manifest mutations write to disk first, then update DB.
- **ADR-0050**: Agent routes always mounted. `/api/agents` independent of Mesh.
- **ADR-0051**: Agent identity/persona injection via context builder.
- **ADR-0062**: Mesh always-on (no feature flag).
- **ADR-0068**: Static XML tool context injection. Zero-cost co-located blocks.
- **ADR-0069**: `agentContext` config toggles. Dual gating (feature flag AND config toggle).

---

## Detailed Design

### 1. Schema Changes

#### 1.1 `EnabledToolGroupsSchema` (packages/shared/src/mesh-schemas.ts)

New Zod schema for per-agent tool domain toggles:

```typescript
export const EnabledToolGroupsSchema = z
  .object({
    pulse: z.boolean().optional(),
    relay: z.boolean().optional(),
    mesh: z.boolean().optional(),
    adapter: z.boolean().optional(),
  })
  .default({})
  .openapi('EnabledToolGroups', {
    description:
      'Per-domain tool group enable/disable. undefined = inherit global default. ' +
      'Binding tools follow adapter toggle. Trace tools follow relay toggle.',
  });
```

Add to `AgentManifestSchema`:

```typescript
enabledToolGroups: EnabledToolGroupsSchema,
```

Add to `UpdateAgentRequestSchema` (currently uses `.pick().partial()`):

```typescript
// Add enabledToolGroups to the pick set
export const UpdateAgentRequestSchema = AgentManifestSchema.pick({
  name: true,
  description: true,
  capabilities: true,
  persona: true,
  personaEnabled: true,
  color: true,
  icon: true,
  enabledToolGroups: true, // NEW
}).partial();
```

**Implicit grouping rules:**

- `adapter: false` also disables Binding tools (`binding_list`, `binding_create`, `binding_delete`)
- `relay: false` also disables Trace tools (`relay_get_trace`, `relay_get_metrics`)
- Core tools (`ping`, `get_server_info`, `get_session_count`, `agent_get_current`) are always enabled

**Backward compatibility:** `enabledToolGroups` has `.default({})`. Existing manifests without the field parse as `{}`, which means all groups inherit global defaults. No migration needed.

#### 1.2 `pulseTools` in Global Config (packages/shared/src/config-schema.ts)

Add `pulseTools` to the `agentContext` section for parity:

```typescript
agentContext: z.object({
  relayTools: z.boolean().default(true),
  meshTools: z.boolean().default(true),
  adapterTools: z.boolean().default(true),
  pulseTools: z.boolean().default(true),  // NEW
}).default(() => ({
  relayTools: true,
  meshTools: true,
  adapterTools: true,
  pulseTools: true,
})),
```

#### 1.3 `agentId` in PulseSchedule (packages/db/src/schema/pulse.ts)

Add nullable `agentId` column to `pulse_schedules`:

```typescript
agentId: text('agent_id'),  // nullable — null = CWD-based resolution
```

Drizzle migration: `ALTER TABLE pulse_schedules ADD COLUMN agent_id TEXT`. Existing rows get `NULL`.

Add to the shared Zod schema for Pulse schedules:

```typescript
// In CreateScheduleInputSchema
agentId: z.string().optional(),

// In PulseScheduleSchema
agentId: z.string().nullable().default(null),
```

---

### 2. Server: Tool Filtering

#### 2.1 Tool Config Resolution

New file: `apps/server/src/services/core/tool-filter.ts`

```typescript
import type { EnabledToolGroups } from '@dorkos/shared/mesh-schemas';

interface ToolFilterDeps {
  relayEnabled: boolean;
  pulseEnabled: boolean;
  globalConfig: {
    pulseTools: boolean;
    relayTools: boolean;
    meshTools: boolean;
    adapterTools: boolean;
  };
}

/**
 * Resolve effective tool config by merging per-agent overrides with global defaults.
 * Per-agent `undefined` inherits global default. Explicit `true`/`false` overrides.
 */
export function resolveToolConfig(
  agentConfig: EnabledToolGroups | undefined,
  deps: ToolFilterDeps
): ResolvedToolConfig {
  const agent = agentConfig ?? {};
  return {
    pulse: (agent.pulse ?? deps.globalConfig.pulseTools) && deps.pulseEnabled,
    relay: (agent.relay ?? deps.globalConfig.relayTools) && deps.relayEnabled,
    mesh: agent.mesh ?? deps.globalConfig.meshTools,
    adapter: (agent.adapter ?? deps.globalConfig.adapterTools) && deps.relayEnabled,
  };
}

export interface ResolvedToolConfig {
  pulse: boolean;
  relay: boolean;
  mesh: boolean;
  adapter: boolean;
}
```

#### 2.2 MCP `allowedTools` Builder

Same file (`tool-filter.ts`):

```typescript
const CORE_TOOLS = [
  'mcp__dorkos__ping',
  'mcp__dorkos__get_server_info',
  'mcp__dorkos__get_session_count',
  'mcp__dorkos__agent_get_current',
] as const;

const PULSE_TOOLS = [
  'mcp__dorkos__list_schedules',
  'mcp__dorkos__create_schedule',
  'mcp__dorkos__update_schedule',
  'mcp__dorkos__delete_schedule',
  'mcp__dorkos__get_run_history',
] as const;

const RELAY_TOOLS = [
  'mcp__dorkos__relay_send',
  'mcp__dorkos__relay_inbox',
  'mcp__dorkos__relay_list_endpoints',
  'mcp__dorkos__relay_register_endpoint',
] as const;

const MESH_TOOLS = [
  'mcp__dorkos__mesh_discover',
  'mcp__dorkos__mesh_register',
  'mcp__dorkos__mesh_list',
  'mcp__dorkos__mesh_deny',
  'mcp__dorkos__mesh_unregister',
  'mcp__dorkos__mesh_status',
  'mcp__dorkos__mesh_inspect',
  'mcp__dorkos__mesh_query_topology',
] as const;

const ADAPTER_TOOLS = [
  'mcp__dorkos__relay_list_adapters',
  'mcp__dorkos__relay_enable_adapter',
  'mcp__dorkos__relay_disable_adapter',
  'mcp__dorkos__relay_reload_adapters',
] as const;

// Binding follows adapter
const BINDING_TOOLS = [
  'mcp__dorkos__binding_list',
  'mcp__dorkos__binding_create',
  'mcp__dorkos__binding_delete',
] as const;

// Trace follows relay
const TRACE_TOOLS = ['mcp__dorkos__relay_get_trace', 'mcp__dorkos__relay_get_metrics'] as const;

/**
 * Build the allowedTools list for an SDK session based on resolved tool config.
 * Returns undefined if all domains are enabled (no filtering needed).
 */
export function buildAllowedTools(config: ResolvedToolConfig): string[] | undefined {
  // If everything is enabled, return undefined (no filtering)
  if (config.pulse && config.relay && config.mesh && config.adapter) {
    return undefined;
  }

  const allowed: string[] = [...CORE_TOOLS];

  if (config.pulse) allowed.push(...PULSE_TOOLS);
  if (config.relay) {
    allowed.push(...RELAY_TOOLS);
    allowed.push(...TRACE_TOOLS);
  }
  if (config.mesh) allowed.push(...MESH_TOOLS);
  if (config.adapter) {
    allowed.push(...ADAPTER_TOOLS);
    allowed.push(...BINDING_TOOLS);
  }

  return allowed;
}
```

#### 2.3 Agent Manager Integration

In `apps/server/src/services/core/agent-manager.ts`, modify `sendMessage()`:

```typescript
// After effectiveCwd is resolved, before building SDK options:
const manifest = await readManifest(effectiveCwd).catch(() => null);

const globalConfig = configManager.get('agentContext') ?? {
  pulseTools: true,
  relayTools: true,
  meshTools: true,
  adapterTools: true,
};

const toolConfig = resolveToolConfig(manifest?.enabledToolGroups, {
  relayEnabled: isRelayEnabled(),
  pulseEnabled: isPulseEnabled(),
  globalConfig,
});

// Pass toolConfig to context builder
const baseAppend = await buildSystemPromptAppend(effectiveCwd, this.meshCore, toolConfig);

// Apply MCP allowedTools filter
const allowedTools = buildAllowedTools(toolConfig);
if (allowedTools) {
  sdkOptions.allowedTools = [...(sdkOptions.allowedTools ?? []), ...allowedTools];
}
```

The `manifest` is already loaded by `buildAgentBlock()` inside `buildSystemPromptAppend`. To avoid a redundant disk read, pass the loaded manifest through or accept the double-read (file is <1KB, cached by OS). The cleaner approach is to load it once in `sendMessage()` and pass it to the context builder.

---

### 3. Server: Context Builder Enhancement

#### 3.1 Signature Change

`buildSystemPromptAppend` gains two optional parameters:

```typescript
export async function buildSystemPromptAppend(
  cwd: string,
  meshCore?: MeshCore | null,
  toolConfig?: ResolvedToolConfig
): Promise<string>;
```

Existing callers that pass only `cwd` continue to work (all tools enabled by default).

#### 3.2 Agent-Aware Block Gating

Replace global config reads with `toolConfig` parameter:

```typescript
function buildRelayToolsBlock(toolConfig?: ResolvedToolConfig): string {
  // If toolConfig provided, use it. Otherwise fall back to global config check.
  if (toolConfig) {
    if (!toolConfig.relay) return '';
  } else {
    if (!isRelayEnabled()) return '';
    const config = configManager.get('agentContext');
    if (config?.relayTools === false) return '';
  }
  return RELAY_TOOLS_CONTEXT;
}
```

Same pattern for `buildMeshToolsBlock` and `buildAdapterToolsBlock`. Add new `buildPulseToolsBlock`:

```typescript
function buildPulseToolsBlock(toolConfig?: ResolvedToolConfig): string {
  if (toolConfig) {
    if (!toolConfig.pulse) return '';
  } else {
    if (!isPulseEnabled()) return '';
    const config = configManager.get('agentContext');
    if (config?.pulseTools === false) return '';
  }
  return PULSE_TOOLS_CONTEXT;
}
```

#### 3.3 Pulse Tools Context Block (New)

New static constant:

```typescript
const PULSE_TOOLS_CONTEXT = `<pulse_tools>
DorkOS Pulse lets you create and manage scheduled agent runs.

Available tools:
  list_schedules() — list all configured schedules
  create_schedule(name, cron, prompt, ...) — create a new schedule (enters pending_approval)
  update_schedule(id, ...) — modify schedule settings
  delete_schedule(id) — remove a schedule
  get_run_history(scheduleId) — view past run results

Schedules can target a specific agent (by agentId) or a directory (by cwd).
Agent-linked schedules automatically resolve the agent's project path at run time.
</pulse_tools>`;
```

#### 3.4 Workflow Recipes in Relay Block

Extend `RELAY_TOOLS_CONTEXT` with a workflow recipe:

```typescript
const RELAY_TOOLS_CONTEXT = `<relay_tools>
DorkOS Relay lets agents exchange messages via a pub/sub subject hierarchy.

Subject conventions:
  relay.agent.{sessionId}          - address a specific Claude Code session
  relay.human.console.{clientId}   - reach a human in the DorkOS UI
  relay.system.console             - system broadcast
  relay.system.pulse.{scheduleId}  - Pulse scheduler events

Workflow: Query another agent
1. mesh_list() to find available agents and their session IDs
2. mesh_inspect(agentId) to get their relay endpoint
3. relay_register_endpoint(subject="relay.agent.{mySessionId}") to enable replies
4. relay_send(subject="relay.agent.{theirSessionId}", payload={task}, replyTo="relay.agent.{mySessionId}")
5. relay_inbox(endpoint_subject="relay.agent.{mySessionId}") to check for reply

Error codes: RELAY_DISABLED, ACCESS_DENIED, INVALID_SUBJECT, ENDPOINT_NOT_FOUND
</relay_tools>`;
```

#### 3.5 Peer Agents Block (New)

```typescript
async function buildPeerAgentsBlock(meshCore: MeshCore | null | undefined): Promise<string> {
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

To contact a peer: mesh_inspect(agentId) for relay endpoint, then relay_send() to that subject.
</peer_agents>`;
  } catch {
    return '';
  }
}
```

#### 3.6 Updated `buildSystemPromptAppend` Assembly

```typescript
export async function buildSystemPromptAppend(
  cwd: string,
  meshCore?: MeshCore | null,
  toolConfig?: ResolvedToolConfig
): Promise<string> {
  const manifest = await readManifest(cwd).catch(() => null);

  const results = await Promise.allSettled([
    buildEnvBlock(cwd),
    buildGitBlock(cwd),
    buildAgentBlock(cwd, manifest),
    buildRelayToolsBlock(toolConfig),
    buildMeshToolsBlock(toolConfig),
    buildAdapterToolsBlock(toolConfig),
    buildPulseToolsBlock(toolConfig),
    buildPeerAgentsBlock(meshCore),
  ]);

  return results
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => (r as PromiseFulfilledResult<string>).value)
    .join('\n\n');
}
```

---

### 4. Server: Agent-First Pulse Scheduling

#### 4.1 CWD Resolution via Agent

In `apps/server/src/services/pulse/scheduler-service.ts`:

```typescript
private async resolveEffectiveCwd(schedule: PulseSchedule): Promise<string> {
  if (schedule.agentId && this.meshCore) {
    const agent = this.meshCore.get(schedule.agentId);
    if (!agent?.projectPath) {
      throw new Error(
        `Agent ${schedule.agentId} not found in registry — schedule ${schedule.id} cannot run. ` +
        'The agent may have been unregistered. Re-link the schedule to a valid agent or directory.'
      );
    }
    return agent.projectPath;
  }
  return schedule.cwd ?? this.defaultCwd;
}
```

In `executeRunDirect` and `executeRunViaRelay`, replace `schedule.cwd ?? undefined` with:

```typescript
const effectiveCwd = await this.resolveEffectiveCwd(schedule);
```

Wrap in try/catch — if resolution throws, record a failed run with the error message.

#### 4.2 Cascade on Agent Unregister

When an agent is unregistered from Mesh, disable all linked Pulse schedules.

**New method on PulseStore** (`apps/server/src/services/pulse/pulse-store.ts`):

```typescript
/**
 * Disable all schedules linked to a specific agent ID.
 * Returns the count of disabled schedules.
 */
disableSchedulesByAgentId(agentId: string): number {
  const stmt = this.db.prepare(`
    UPDATE pulse_schedules
    SET enabled = 0, status = 'paused', updated_at = ?
    WHERE agent_id = ? AND enabled = 1
  `);
  const result = stmt.run(new Date().toISOString(), agentId);
  return result.changes;
}
```

**Wire into Mesh unregister flow.** In the Mesh unregister handler (both MCP tool and HTTP route), after removing the agent:

```typescript
// In meshCore.unregister() or in the route handler after meshCore.unregister():
if (pulseStore) {
  const disabledCount = pulseStore.disableSchedulesByAgentId(agentId);
  if (disabledCount > 0) {
    logger.info({ agentId, disabledCount }, 'Disabled Pulse schedules for unregistered agent');
  }
}
```

The cleanest integration point is to add a `onAgentUnregistered` callback to `MeshCore` or to wire this in the route/MCP handler that calls `meshCore.unregister()`. Since there are two callsites (HTTP route in `routes/mesh.ts` and MCP tool in `mesh-tools.ts`), a callback on MeshCore is preferred to avoid duplication:

```typescript
// In MeshCore constructor or init
this.onUnregister = async (agentId: string) => {
  if (this.pulseStore) {
    this.pulseStore.disableSchedulesByAgentId(agentId);
  }
  // Future: also clean up Relay endpoints, bindings, etc.
};
```

#### 4.3 Route Changes

`POST /api/pulse/schedules` and `PATCH /api/pulse/schedules/:id` accept optional `agentId` field. Validation: if `agentId` is provided, verify the agent exists in Mesh registry before creating/updating. Return 400 if agent not found.

`GET /api/pulse/schedules` response includes `agentId: string | null` for each schedule.

---

### 5. Client: Capabilities Tab Tool Toggles

#### 5.1 Merge Tool Toggles into CapabilitiesTab

Add a "Tool Groups" section to the existing `CapabilitiesTab` (`apps/client/src/layers/features/agent-settings/ui/CapabilitiesTab.tsx`):

```
[Existing sections: Capabilities tags, Namespace, Response Mode, Budget]

─── Tool Groups ─────────────────────────────────

Core Tools                          Always enabled
  ping, server info, agent identity

[Switch] Pulse (Scheduling)         Inherited ✓
  Create and manage scheduled agent runs

[Switch] Relay (Messaging)          Overridden: Off
  Send messages, check inbox, register endpoints

[Switch] Mesh (Discovery)           Inherited ✓
  Discover, register, and query agents

[Switch] Relay Adapters             Inherited ✓
  Manage Slack, Telegram, and other adapters

─────────────────────────────────────────────────
Disabled groups exclude tools from this agent's
sessions. Global defaults are in Settings > Tools.
```

Each `Switch` has three visual states:

- **Inherited (enabled):** Switch on, muted label "Inherited" — agent has no override, global default is `true`
- **Inherited (disabled):** Switch off, muted label "Inherited" — agent has no override, global default is `false`
- **Overridden:** Switch on/off, label "Overridden: On/Off" — agent manifest has an explicit value

A "Reset to default" button appears next to overridden toggles, which sets the field back to `undefined` (deletes the key from `enabledToolGroups`).

Server-disabled features (e.g., Relay when `DORKOS_RELAY_ENABLED=false`) show the Switch disabled with a tooltip: "Disabled globally by server configuration."

**Save behavior:** Calls `onUpdate({ enabledToolGroups: { ...current, [domain]: value } })` which flows through `useUpdateAgent` → PATCH `/api/agents/current`.

#### 5.2 New Hook: `useAgentContextConfig` Extension

The existing `useAgentContextConfig()` hook reads/writes global config. It remains as-is for the SettingsDialog Tools tab. The CapabilitiesTab reads global config (via the same hook) to display "Inherited" state, and reads/writes per-agent config via the existing `onUpdate` prop.

---

### 6. Client: SettingsDialog Tools Tab

#### 6.1 Relocate Global Defaults

Move the `ContextTab` content from `AgentDialog` to `SettingsDialog` as a 6th tab named "Tools":

```
[Appearance] [Preferences] [Status Bar] [Server] [Tools] [Advanced]
```

The tab content is the same as the current `ContextTab`: switches for `relayTools`, `meshTools`, `adapterTools`, plus the new `pulseTools`. Each switch shows a collapsible preview of the XML block that gets injected.

**Remove** the `context` tab from `AgentDialog` (reducing from 5 tabs to 4: Identity, Persona, Capabilities, Connections).

#### 6.2 Grid Layout Update

`AgentDialog` tabs go from `grid-cols-5` to `grid-cols-4`. `SettingsDialog` tabs go from `grid-cols-5` to `grid-cols-6` (or use a scrollable tab bar if width is constrained).

---

### 7. Client: Sidebar Tool Status Chips

#### 7.1 `useAgentToolStatus` Hook

New file: `apps/client/src/layers/entities/agent/model/use-agent-tool-status.ts`

```typescript
export type ChipState = 'enabled' | 'disabled-by-agent' | 'disabled-by-server';

export interface AgentToolStatus {
  pulse: ChipState;
  relay: ChipState;
  mesh: ChipState;
  adapter: ChipState;
}

export function useAgentToolStatus(projectPath: string): AgentToolStatus {
  const { data: agent } = useCurrentAgent(projectPath);
  const relayEnabled = useRelayEnabled();
  const pulseEnabled = usePulseEnabled();

  return useMemo(() => {
    const groups = agent?.enabledToolGroups ?? {};

    return {
      pulse: !pulseEnabled
        ? 'disabled-by-server'
        : groups.pulse === false
          ? 'disabled-by-agent'
          : 'enabled',
      relay: !relayEnabled
        ? 'disabled-by-server'
        : groups.relay === false
          ? 'disabled-by-agent'
          : 'enabled',
      mesh: groups.mesh === false ? 'disabled-by-agent' : 'enabled',
      adapter: !relayEnabled
        ? 'disabled-by-server'
        : groups.adapter === false
          ? 'disabled-by-agent'
          : 'enabled',
    };
  }, [agent, relayEnabled, pulseEnabled]);
}
```

Export from `entities/agent/index.ts`.

#### 7.2 `AgentContextChips` Update

Replace current global feature-flag reads with `useAgentToolStatus(projectPath)`:

| ChipState            | Rendering                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `enabled`            | Colored chip, normal opacity. Tooltip: "Pulse — enabled for {agent.name}"                                      |
| `disabled-by-agent`  | Muted chip, reduced opacity (0.4), strikethrough or `[off]` suffix. Tooltip: "Pulse — disabled for this agent" |
| `disabled-by-server` | Chip hidden entirely                                                                                           |

Active run counts (Pulse) and agent counts (Mesh) continue to render as badges on `enabled` chips.

---

### 8. Client: Agent-First Pulse Scheduling

#### 8.1 CreateScheduleDialog — Agent/Directory Toggle

Add a radio group above the CWD picker:

```tsx
<RadioGroup value={scheduleTarget} onValueChange={setScheduleTarget}>
  <RadioGroupItem value="agent">Run for agent</RadioGroupItem>
  <RadioGroupItem value="directory">Run in directory</RadioGroupItem>
</RadioGroup>;

{
  scheduleTarget === 'agent' && (
    <AgentCombobox
      agents={agents ?? []}
      value={selectedAgentId}
      onValueChange={setSelectedAgentId}
    />
  );
}

{
  scheduleTarget === 'directory' && <DirectoryPicker value={cwd} onChange={setCwd} />;
}
```

When `scheduleTarget === 'agent'`, the form payload includes `agentId` and omits `cwd`. When `scheduleTarget === 'directory'`, the form payload includes `cwd` and omits `agentId`.

Default: `'agent'` if there are registered agents, `'directory'` otherwise.

#### 8.2 AgentCombobox Component

New component in `features/pulse/ui/AgentCombobox.tsx`. Uses shadcn `Command` (combobox pattern):

- Lists agents from `useRegisteredAgents()`
- Each item shows: color dot, icon emoji, agent name, project path in muted text
- Searchable by name or path
- Follows same UX pattern as `DirectoryPicker`

#### 8.3 ScheduleRow Enhancement

When `schedule.agentId` is set and resolved:

```tsx
{
  agentForSchedule ? (
    <div className="flex items-center gap-1.5">
      <span className="size-2.5 rounded-full" style={{ backgroundColor: agentForSchedule.color }} />
      {agentForSchedule.icon && <span>{agentForSchedule.icon}</span>}
      <span className="font-medium">{agentForSchedule.name}</span>
    </div>
  ) : schedule.agentId ? (
    // Agent ID exists but agent not found (unregistered)
    <div className="text-destructive flex items-center gap-1.5">
      <AlertCircle className="size-3.5" />
      <span className="text-sm">Agent not found</span>
    </div>
  ) : (
    <div className="flex items-center gap-1.5">
      <FolderOpen className="text-muted-foreground size-3.5" />
      <span className="font-mono text-sm">{schedule.cwd ?? 'default'}</span>
    </div>
  );
}
```

---

## Data Flow Diagrams

### Per-Session Tool Resolution

```
sendMessage(sessionId, content, opts)
  │
  ├─ effectiveCwd = opts.cwd || session.cwd || this.cwd
  │
  ├─ manifest = readManifest(effectiveCwd)  // .dork/agent.json or null
  │
  ├─ globalConfig = configManager.get('agentContext')
  │
  ├─ toolConfig = resolveToolConfig(manifest?.enabledToolGroups, {
  │     relayEnabled, pulseEnabled, globalConfig
  │   })
  │   // Result: { pulse: bool, relay: bool, mesh: bool, adapter: bool }
  │
  ├─ systemPromptAppend = buildSystemPromptAppend(cwd, meshCore, toolConfig)
  │   // Only includes XML blocks for enabled domains
  │   // Includes <peer_agents> if meshCore provided
  │
  ├─ allowedTools = buildAllowedTools(toolConfig)
  │   // undefined if all enabled, or string[] of allowed tool names
  │
  └─ query({ systemPrompt: { append }, allowedTools, mcpServers })
```

### Agent Unregister Cascade

```
meshCore.unregister(agentId)
  │
  ├─ Delete .dork/agent.json
  ├─ Remove from SQLite agents table
  │
  └─ onUnregister callback:
      ├─ pulseStore.disableSchedulesByAgentId(agentId)
      │   // SET enabled=0, status='paused' WHERE agent_id=?
      └─ Log: "Disabled N Pulse schedules for unregistered agent"
```

---

## User Experience

### Agent Settings — Capabilities Tab

The Capabilities tab gains a "Tool Groups" section at the bottom. Each domain toggle (Pulse, Relay, Mesh, Adapter) shows:

- Current state (inherited from global default or explicitly overridden)
- Whether the server-level feature is available
- A reset button to clear per-agent override

### Settings Dialog — Tools Tab

Global tool defaults move from AgentDialog to SettingsDialog. This is where users configure the default behavior for all agents. Per-agent overrides in the Capabilities tab take precedence.

### Sidebar Chips

Chips now reflect the current agent's tool state. Switching between sessions/agents updates the chips. Hovering shows a tooltip explaining why a tool is enabled or disabled.

### Pulse Scheduling

Creating a schedule offers "Run for agent" (preferred) or "Run in directory" (legacy). Agent-linked schedules display the agent's name and color in the schedule list. If an agent is unregistered, its schedules are auto-disabled and the schedule row shows a warning.

---

## Testing Strategy

### Unit Tests

#### `tool-filter.test.ts`

- `resolveToolConfig` with all fields undefined returns global defaults
- `resolveToolConfig` with explicit `false` overrides global `true`
- `resolveToolConfig` respects feature flag intersection (relay: true in agent, but relayEnabled=false → false)
- `buildAllowedTools` returns undefined when all domains enabled
- `buildAllowedTools` excludes Pulse tools when pulse=false
- `buildAllowedTools` excludes Binding tools when adapter=false (implicit grouping)
- `buildAllowedTools` excludes Trace tools when relay=false (implicit grouping)
- `buildAllowedTools` always includes Core tools

#### `context-builder.test.ts` (extend existing)

- `buildSystemPromptAppend` with toolConfig.relay=false omits `<relay_tools>` block
- `buildSystemPromptAppend` with toolConfig.mesh=false omits `<mesh_tools>` block
- `buildPeerAgentsBlock` with empty agent list returns empty string
- `buildPeerAgentsBlock` with 3 agents returns formatted XML block
- `buildPeerAgentsBlock` with meshCore=null returns empty string
- `buildPulseToolsBlock` with toolConfig.pulse=false returns empty string
- Backward compat: `buildSystemPromptAppend(cwd)` with no extra args works as before

#### `agent-manager.test.ts` (extend existing)

- `sendMessage` loads manifest and applies allowedTools when enabledToolGroups present
- `sendMessage` passes no allowedTools when manifest has no enabledToolGroups
- `sendMessage` passes toolConfig to buildSystemPromptAppend

#### `pulse-store.test.ts` (extend existing)

- `disableSchedulesByAgentId` disables matching schedules
- `disableSchedulesByAgentId` returns 0 when no matches
- `disableSchedulesByAgentId` only affects enabled schedules (doesn't re-disable already disabled)
- CRUD with `agentId` field works correctly

#### `scheduler-service.test.ts` (extend existing)

- `resolveEffectiveCwd` with agentId resolves via meshCore
- `resolveEffectiveCwd` with unknown agentId throws error
- `resolveEffectiveCwd` without agentId falls back to schedule.cwd
- `executeRun` records failed run when agent resolution throws

### Component Tests

#### `CapabilitiesTab.test.tsx` (extend existing)

- Renders tool group toggles section
- Toggle calls onUpdate with enabledToolGroups
- Shows "Inherited" label when agent has no override
- Shows "Overridden" label when agent has explicit value
- Disables toggle when server feature is off
- Reset button clears override

#### `AgentContextChips.test.tsx` (extend existing)

- Renders enabled chip when tool status is 'enabled'
- Renders muted chip when tool status is 'disabled-by-agent'
- Hides chip when tool status is 'disabled-by-server'
- Tooltip shows correct reason text

#### `CreateScheduleDialog.test.tsx` (extend existing)

- Shows agent/directory radio toggle
- Agent picker appears when "Run for agent" selected
- Directory picker appears when "Run in directory" selected
- Submits agentId when agent target selected
- Submits cwd when directory target selected

#### `ScheduleRow.test.tsx` (extend existing)

- Shows agent name and color dot when agentId resolved
- Shows warning when agentId set but agent not found
- Shows folder icon and CWD path when no agentId

### Hook Tests

#### `use-agent-tool-status.test.ts`

- Returns 'enabled' when feature flag on and agent has no override
- Returns 'disabled-by-agent' when agent explicitly disables
- Returns 'disabled-by-server' when feature flag is off
- Returns 'enabled' for mesh (always-on) unless agent disables
- Handles null agent (no manifest) — all enabled

---

## Performance Considerations

- **`readManifest` per session start:** One disk read (<1KB file). Already done in context builder for `buildAgentBlock`. Consider loading once in `sendMessage` and passing to context builder to avoid double-read.
- **`meshCore.listAgents()` per session start:** One SQLite query, limited to 10 results. Negligible cost.
- **`allowedTools` list size:** ~25 tool names max, ~500 bytes. No meaningful overhead in SDK options.
- **Chip state computation:** Pure boolean logic on already-fetched TanStack Query data. Zero additional network requests.
- **Agent combobox:** Uses `useRegisteredAgents()` which is already fetched by Mesh components. TanStack Query deduplication prevents extra calls.
- **`disableSchedulesByAgentId`:** Single UPDATE query with index on `agent_id`. Runs only on unregister (rare operation).

---

## Security Considerations

- **Tool filtering is defense-in-depth, not a security boundary.** The `allowedTools` filter prevents disabled tools from being called via MCP. However, agents can still perform equivalent actions via Bash or file tools. Per-agent config is about workflow clarity, not hard isolation.
- **`enabledToolGroups` is user-authored data** in `.dork/agent.json`. Never treat as a security boundary for privilege escalation. The `canUseTool` approval flow remains the security gate.
- **`readManifest` path:** `${effectiveCwd}/.dork/agent.json` — CWD is already boundary-validated by the server.
- **Peer agents context block:** Includes agent names and project paths — user-owned data on the same machine. No cross-user exposure in the local-first model.
- **Agent ID in PulseSchedule:** ULID string resolved via Mesh registry. The `resolveEffectiveCwd` validates the resolved path is within the configured boundary.

---

## Documentation

### Guides to Update

- `contributing/architecture.md` — Add tool filtering to the agent-manager data flow section
- `contributing/keyboard-shortcuts.md` — No changes needed
- `contributing/data-fetching.md` — Add `useAgentToolStatus` hook pattern
- `contributing/design-system.md` — Document 3-state chip pattern

### AGENTS.md Updates

- Add `tool-filter.ts` to the server services list
- Update `context-builder.ts` description to mention agent-aware gating and peer agents block
- Update `CapabilitiesTab` description to include tool group toggles
- Update `AgentContextChips` description to mention per-agent state
- Add `pulseTools` to the feature flags table
- Update `SettingsDialog` tab count and add Tools tab description
- Update `AgentDialog` tab count (5 → 4)

---

## Implementation Phases

### Phase 1: Context Injection Enhancement

**Scope:** Make context blocks agent-aware, add peer agents block, add workflow recipes.

**Files modified:**

- `apps/server/src/services/core/context-builder.ts` — New signature, agent-aware gating, `buildPeerAgentsBlock`, `buildPulseToolsBlock`, workflow recipe in relay block

**Files created:** None

**Tests:** `context-builder.test.ts` extensions

### Phase 2: Per-Agent Tool Config Schema + Server Filtering

**Scope:** Schema changes, tool filter utility, agent-manager integration.

**Files modified:**

- `packages/shared/src/mesh-schemas.ts` — `EnabledToolGroupsSchema`, add to manifest + update schema
- `packages/shared/src/config-schema.ts` — Add `pulseTools`
- `apps/server/src/services/core/agent-manager.ts` — Load manifest, resolve config, apply filter

**Files created:**

- `apps/server/src/services/core/tool-filter.ts` — `resolveToolConfig`, `buildAllowedTools`

**Tests:** `tool-filter.test.ts` (new), `agent-manager.test.ts` extensions

### Phase 3: UI — Capabilities Tab Tool Toggles + SettingsDialog Tools Tab

**Scope:** Per-agent toggles in CapabilitiesTab, global defaults in SettingsDialog.

**Files modified:**

- `apps/client/src/layers/features/agent-settings/ui/CapabilitiesTab.tsx` — Add Tool Groups section
- `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx` — Remove context tab, grid-cols-4
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` — Add Tools tab, grid-cols-6

**Files moved:**

- `ContextTab.tsx` content moves to a `ToolsTab` inside `features/settings/ui/`

**Tests:** `CapabilitiesTab.test.tsx` extensions, new `ToolsTab.test.tsx`

### Phase 4: Sidebar Tool Status Chips

**Scope:** Per-agent chip state hook, 3-state chip rendering.

**Files modified:**

- `apps/client/src/layers/features/session-list/ui/AgentContextChips.tsx` — Use `useAgentToolStatus`
- `apps/client/src/layers/entities/agent/index.ts` — Export new hook

**Files created:**

- `apps/client/src/layers/entities/agent/model/use-agent-tool-status.ts`

**Tests:** `use-agent-tool-status.test.ts` (new), `AgentContextChips.test.tsx` extensions

### Phase 5: Agent-First Scheduling with Cascade Unregister

**Scope:** DB migration, server resolution, cascade, client UI.

**Files modified:**

- `packages/db/src/schema/pulse.ts` — Add `agentId` column
- `apps/server/src/services/pulse/pulse-store.ts` — `disableSchedulesByAgentId`, CRUD with agentId
- `apps/server/src/services/pulse/scheduler-service.ts` — `resolveEffectiveCwd`
- `apps/server/src/routes/pulse.ts` — Accept agentId in create/update
- `apps/server/src/services/core/mcp-tools/mesh-tools.ts` — Wire cascade on unregister
- `apps/server/src/routes/mesh.ts` — Wire cascade on DELETE agent
- `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx` — Agent/directory toggle
- `apps/client/src/layers/features/pulse/ui/ScheduleRow.tsx` — Agent display

**Files created:**

- `packages/db/src/migrations/NNNN_add_agent_id_to_pulse_schedules.ts`
- `apps/client/src/layers/features/pulse/ui/AgentCombobox.tsx`

**Tests:** `pulse-store.test.ts`, `scheduler-service.test.ts`, `CreateScheduleDialog.test.tsx`, `ScheduleRow.test.tsx` extensions

---

## Open Questions

_None — all decisions resolved during ideation and interactive decision gathering._

---

## References

- Ideation: `specs/agent-tools-elevation/01-ideation.md`
- Research: `research/20260304_agent_tools_elevation.md`
- Prior research: `research/20260303_agent_tool_context_injection.md`
- Spec #88: `specs/agent-tool-context-injection/02-specification.md`
- ADR-0043: File-first write-through for agent storage
- ADR-0062: Mesh always-on
- ADR-0068: Static XML tool context injection
- ADR-0069: `agentContext` config toggles
