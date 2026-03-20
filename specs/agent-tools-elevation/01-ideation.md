---
slug: agent-tools-elevation
number: 89
created: 2026-03-04
status: ideation
---

# Agent Tools Elevation

**Slug:** agent-tools-elevation
**Author:** Claude Code
**Date:** 2026-03-04
**Branch:** preflight/agent-tools-elevation

---

## 1) Intent & Assumptions

- **Task brief:** Evolve DorkOS's agent-tool management from global context-only toggles into a comprehensive, per-agent tool system with world-class UX. Four interconnected goals: (1) Per-agent tool enable/disable stored in agent manifests with global defaults, (2) Agent-scoped sidebar indicators showing per-agent tool status, (3) Natural language cross-tool orchestration via enhanced context injection, (4) Agent-based Pulse scheduling (agent-first instead of CWD-first).
- **Assumptions:**
  - Spec #88 (Agent Tool Context Injection) is fully implemented — ContextTab exists in AgentDialog with global toggles, context builder has gating logic, `agentContext` config section exists
  - The MCP tool server factory pattern (`mcpServerFactory`) already creates fresh instances per `query()` call — natural injection point for per-agent filtering
  - Agent manifests (`.dork/agent.json`) follow file-first write-through (ADR-0043) and are the canonical source of truth
  - Mesh is always-on (ADR-0062), Relay is feature-flagged via `DORKOS_RELAY_ENABLED`
  - All 4 goals will be delivered as a single unified spec with clear phases
- **Out of scope:**
  - Relay core protocol changes
  - Mesh protocol or topology changes
  - New adapter types (Telegram, Webhook, Claude Code adapters already exist)
  - Marketing site or documentation site changes
  - Per-tool granularity (only per-domain: Pulse, Relay, Mesh, Adapter)
  - Obsidian plugin changes (standalone web only)

## 2) Pre-reading Log

### Developer Guides

- `contributing/architecture.md`: Hexagonal architecture, Transport interface, DI patterns, FSD layer rules
- `contributing/design-system.md`: Color palette, 8pt grid spacing, motion specs, component conventions
- `contributing/data-fetching.md`: TanStack Query patterns, mutations, cache invalidation
- `contributing/state-management.md`: Zustand vs TanStack Query decision guide

### Specifications

- `specs/agent-tool-context-injection/` (Spec #88): Foundation — static XML blocks, `agentContext` config section, ContextTab in AgentDialog, dual gating (feature flag AND config toggle). Status: specified/implemented
- `specs/agent-centric-ux/` (Spec #85): Establishes agents as primary UX unit — sidebar redesign, Cmd+K palette. Status: specified
- `specs/command-palette-10x/` (Spec #87): Enhanced Cmd+K with agent preview, frecency, drill-down. Status: specified
- `specs/dynamic-mcp-tools/` (Spec #41): MCP tool injection architecture — `mcpServerFactory` pattern. Status: implemented
- `specs/pulse-scheduler/` (Spec #43): Pulse design, CWD-based scheduling. Status: specified
- `specs/shadcn-sidebar-redesign/` (Spec #86): Agent-centric sidebar with glanceable status. Status: ideation

### Architecture Decision Records

- `decisions/0043`: Agent storage file-first write-through — manifests in `.dork/agent.json`, SQLite as cache
- `decisions/0050`: Agent routes always mounted — `/api/agents` independent of Mesh
- `decisions/0051`: Agent identity/persona injection via context builder
- `decisions/0062`: Remove Mesh feature flag — Mesh is always-on
- `decisions/0063`: Shadcn Command Dialog for global palette
- `decisions/0068`: Static XML tool context injection — zero-cost, co-located blocks
- `decisions/0069`: `agentContext` config toggles — independent from feature flags, dual gating

### Key Source Files

- `apps/server/src/services/core/context-builder.ts`: 3 static XML constants (RELAY, MESH, ADAPTER), 3 builder functions, gated by config + feature flags
- `apps/server/src/services/core/mcp-tools/index.ts`: Factory `createDorkOsToolServer(deps)` with 7 domain tool groups (Core, Pulse, Relay, Adapter, Binding, Trace, Mesh)
- `apps/server/src/services/core/agent-manager.ts`: `sendMessage()` calls `buildSystemPromptAppend(cwd)` then `mcpServerFactory()` — the two injection points
- `packages/shared/src/mesh-schemas.ts`: `AgentManifestSchema` — currently has no tool-related fields
- `packages/shared/src/config-schema.ts`: `UserConfigSchema` with `agentContext: { relayTools, meshTools, adapterTools }`
- `apps/client/src/layers/features/agent-settings/ui/ContextTab.tsx`: Current global toggle UI (needs relocation)
- `apps/client/src/layers/features/agent-settings/model/use-agent-context-config.ts`: Hook for `agentContext` config
- `apps/client/src/layers/features/session-list/ui/AgentContextChips.tsx`: Sidebar chips showing global Pulse/Relay/Mesh status
- `apps/server/src/services/pulse/pulse-store.ts`: Schedule schema with `cwd` column, no `agentId`
- `apps/server/src/services/pulse/scheduler-service.ts`: Dispatch via `agentManager.sendMessage(runId, prompt, { cwd })`
- `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx`: CWD-based directory picker

### Research

- `research/20260303_agent_tool_context_injection.md`: Static XML > dynamic, ~730 tokens total, subject hierarchy most critical
- `research/20260304_agent_tools_elevation.md`: Per-agent filtering via SDK `allowedTools`, `enabledToolGroups` map, backward-compatible schema evolution

## 3) Codebase Map

### Primary Components/Modules

**Context Injection Pipeline:**

- `apps/server/src/services/core/context-builder.ts` — Assembles XML blocks for system prompt append. 3 static constants + 3 builder functions. Reads agent manifest via `readManifest(cwd)`.
- `apps/server/src/services/core/agent-manager.ts` — Orchestrates SDK sessions. `sendMessage()` calls context builder + MCP factory.
- `apps/server/src/services/core/mcp-tools/index.ts` — Tool server factory. 7 domain groups: Core, Pulse, Relay, Adapter, Binding, Trace, Mesh.

**Agent Manifest & Config:**

- `packages/shared/src/mesh-schemas.ts` — `AgentManifestSchema` Zod schema. No tool fields yet.
- `packages/shared/src/config-schema.ts` — `UserConfigSchema` with `agentContext` section.
- `packages/shared/src/manifest.ts` — `readManifest()`, `writeManifest()`, `removeManifest()`.

**Client UI (Tools):**

- `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx` — 5 tabs including ContextTab (to be relocated)
- `apps/client/src/layers/features/agent-settings/ui/ContextTab.tsx` — Global toggles (to move to SettingsDialog)
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` — Global settings (will receive Tools tab)
- `apps/client/src/layers/features/session-list/ui/AgentContextChips.tsx` — Sidebar chips (global status)

**Pulse Scheduler:**

- `apps/server/src/services/pulse/pulse-store.ts` — SQLite persistence, `cwd` column only
- `apps/server/src/services/pulse/scheduler-service.ts` — Cron dispatch via `agentManager.sendMessage()`
- `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx` — CWD-based creation

**Entity Hooks:**

- `apps/client/src/layers/entities/agent/` — `useCurrentAgent`, `useResolvedAgents`, `useAgentVisual`
- `apps/client/src/layers/entities/pulse/` — `useSchedules`, `useRuns`, `usePulseEnabled`
- `apps/client/src/layers/entities/mesh/` — `useRegisteredAgents`, `useMeshStatus`
- `apps/client/src/layers/entities/binding/` — `useBindings`, `useCreateBinding`

### Shared Dependencies

- Config system: `configManager.get('agentContext')` → context builder gating
- Agent manifest I/O: `readManifest(cwd)` shared by context builder, agent routes, mesh system
- Feature flags: `isRelayEnabled()` gates Relay tools + context blocks
- TanStack Query: All entity hooks use query/mutation patterns with `queryClient.invalidateQueries()`
- Transport interface: `TransportContext` decouples client from HTTP/Direct transport

### Data Flow

```
Agent Session Start (per sendMessage):
  agent-manager.ts
    ├─ readManifest(cwd) → agent toolConfig (or undefined)
    ├─ resolveToolConfig(manifest.toolConfig, globalConfig.agentContext) → effective config
    ├─ buildSystemPromptAppend(cwd, effectiveConfig) → XML blocks (only enabled tools)
    └─ mcpServerFactory(effectiveConfig) → MCP server (only enabled tool domains)
        └─ query({ systemPrompt: { append }, mcpServers })
```

### Feature Flags/Config

| Flag                        | Location              | Default             | Scope                               |
| --------------------------- | --------------------- | ------------------- | ----------------------------------- |
| `DORKOS_RELAY_ENABLED`      | `relay-state.ts`      | `true`              | Gates Relay/Adapter tools + context |
| `agentContext.relayTools`   | `~/.dork/config.json` | `true`              | Global default for Relay tools      |
| `agentContext.meshTools`    | `~/.dork/config.json` | `true`              | Global default for Mesh tools       |
| `agentContext.adapterTools` | `~/.dork/config.json` | `true`              | Global default for Adapter tools    |
| `agentContext.pulseTools`   | `~/.dork/config.json` | N/A (to add)        | Global default for Pulse tools      |
| `manifest.toolConfig.*`     | `.dork/agent.json`    | undefined (inherit) | Per-agent override                  |

### Potential Blast Radius

**Direct changes (~15 files):**

- Schema: `mesh-schemas.ts` (add `toolConfig`), `config-schema.ts` (add `pulseTools`)
- Server: `context-builder.ts`, `agent-manager.ts`, `mcp-tools/index.ts`, `pulse-store.ts`, `scheduler-service.ts`, `routes/pulse.ts`
- Client: `SettingsDialog.tsx` (add Tools tab), `AgentDialog.tsx` (remove ContextTab, add Tools section to Capabilities), `ContextTab.tsx` (relocate + rename), `AgentContextChips.tsx`, `CreateScheduleDialog.tsx`, `ScheduleRow.tsx`

**Indirect (dependent files, ~10 files):**

- Entity hooks: `entities/agent/`, `entities/pulse/` (new hooks for agent-scoped queries)
- Test files: `context-builder.test.ts`, `ContextTab.test.tsx`, `pulse-store.test.ts`, `agent-manager.test.ts`

**No breaking changes:** All new fields are optional with backward-compatible defaults.

## 4) Root Cause Analysis

N/A — This is a feature, not a bug fix.

## 5) Research

### Potential Solutions

**1. Per-Agent Tool Filtering via MCP `allowedTools`**

- Description: Use the SDK's per-session `allowedTools` mechanism to filter which MCP tools are available based on the agent's `toolConfig`. Single MCP server instance, filtered at session level.
- Pros: Uses SDK's intended mechanism, no dynamic server creation, simple implementation
- Cons: Requires maintaining a list of tool names per domain for filtering
- Complexity: Low
- Maintenance: Low

**2. Dynamic MCP Server Creation Per Agent**

- Description: Create separate MCP server instances per agent, only registering enabled tool domains.
- Pros: Clean separation, no filtering needed
- Cons: More complex factory, SDK Protocol can only connect to one transport at a time (already handled by fresh-per-query pattern), slight overhead
- Complexity: Medium
- Maintenance: Medium

**3. Context-Only Gating (No MCP Filtering)**

- Description: Only filter context blocks, always register all MCP tools. Agents without context won't know how to use tools but could still call them.
- Pros: Simplest to implement, no MCP changes needed
- Cons: Incomplete — agents can still call tools they shouldn't have. Context and tools out of sync.
- Complexity: Low
- Maintenance: Low but risky

### Security Considerations

- Per-agent tool filtering should be enforced at both MCP and context levels (dual gating)
- Tool access is advisory, not a hard security boundary — agents can still attempt calls
- Agent manifest is filesystem-writable — trust model is local user trust

### Performance Considerations

- Static XML context blocks: ~730 tokens total, negligible impact (~0.37% of 200K window)
- Peer agent list in context: scales with registered agent count, cap at ~50 agents
- MCP tool filtering: per-session, negligible CPU cost
- PulseStore `agentId` column: additive, no migration needed for existing data

### Recommendation

**Recommended Approach:** Per-agent tool filtering via domain-level gating in both the MCP factory and context builder (Approach 1). The factory already runs per-session — accept a tool config parameter and conditionally include/exclude domain tool groups. Context builder receives the same resolved config and gates XML blocks accordingly.

**Rationale:** This is the lowest-complexity approach that achieves full dual gating (tools + context always in sync). It builds on the existing `mcpServerFactory` and context builder patterns without introducing new abstractions.

**Caveats:**

- Binding tools should follow Adapter toggle (they're semantically part of the adapter system)
- Trace tools should follow Relay toggle (tracing is a Relay subsystem)
- Core tools (ping, get_server_info, get_session_count) should always be available

## 6) Decisions

| #   | Decision                                      | Choice                                      | Rationale                                                                                                                                                                                                                          |
| --- | --------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | How per-agent config relates to global config | Agent overrides global                      | Keep global ContextTab as defaults (relocated to SettingsDialog, renamed "Tools"). Agent manifest `toolConfig` overrides when present. `undefined` = inherit global default. Matches existing `!== false` backward compat pattern. |
| 2   | Spec scope                                    | Single unified spec                         | All 4 goals are deeply interconnected — per-agent config enables scoped UI, NL orchestration depends on peer context, agent-based Pulse needs manifest changes. One spec with clear phases.                                        |
| 3   | Tool config schema shape                      | Simple boolean map                          | `toolConfig: { pulse?: boolean, relay?: boolean, mesh?: boolean, adapter?: boolean }`. Matches existing `agentContext` pattern. `undefined` = inherit. Easy to understand and extend later if needed.                              |
| 4   | Pulse tool gating                             | Full parity with other domains              | Add `pulseTools` to global config AND per-agent `toolConfig`. Create `<pulse_tools>` context block. Filter Pulse MCP tools per-agent. Complete symmetry across all 4 tool domains.                                                 |
| 5   | ContextTab location                           | Relocate from AgentDialog to SettingsDialog | The existing ContextTab (Spec #88) shows global defaults — it belongs in SettingsDialog, not AgentDialog. AgentDialog gets a per-agent Tools section showing inherited vs overridden state. Tab renamed from "Context" to "Tools". |
