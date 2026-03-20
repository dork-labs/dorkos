---
slug: agent-tool-context-injection
number: 88
created: 2026-03-03
status: specified
---

# Specification: Agent Tool Context Injection

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-03-04
**Spec:** 88
**Research:** `research/20260303_agent_tool_context_injection.md`

---

## 1. Overview

DorkOS provides 28 MCP tools across relay, mesh, adapter, binding, and trace domains. Agents currently receive the tool definitions (what each tool does) but zero instructions on how to use them together — no subject hierarchy documentation, no workflow sequences, no routing conventions. An agent calling `relay_send` has no idea what subject string to use.

This specification adds three static XML context blocks (`<relay_tools>`, `<mesh_tools>`, `<adapter_tools>`) to `context-builder.ts`, injected into agent system prompts via `systemPrompt.append`. Each block documents how to use a tool group together: subject hierarchy, cross-tool workflows, naming conventions. A new `agentContext` section in `UserConfigSchema` provides boolean toggles so power users can control which blocks are injected. A new "Context" tab in the Agent Settings dialog surfaces these toggles with read-only previews of block content.

---

## 2. Background / Problem Statement

The MCP `tool()` description strings answer "what does this tool do?" and "what are its parameters?" but cannot answer:

- **Subject conventions:** What string goes in `relay_send`'s `subject` field? (`relay.agent.{sessionId}`, `relay.human.console.{clientId}`, etc.)
- **Workflow sequencing:** Should I call `relay_register_endpoint` before `relay_send`? What order does the mesh lifecycle follow?
- **Cross-tool orchestration:** How do I find an agent via mesh, get its relay endpoint, then send it a message?
- **Adapter routing:** How do adapter subjects like `relay.human.telegram.{chatId}` relate to the binding system?

Tool descriptions are per-tool; these are cross-tool concerns. The system prompt context block is the correct layer for this documentation (see ADR-0051 for the precedent of injecting structured context via `buildSystemPromptAppend()`).

---

## 3. Goals

- Agents receive workflow documentation for relay, mesh, and adapter tools via system prompt injection
- Each context block is gated on both feature availability AND a user config toggle
- Users can see and control what context their agents receive via the Agent Settings dialog
- Total token overhead stays within 600-1000 tokens (~0.5% of 200K context window)
- Zero regression in existing context blocks (`<env>`, `<git_status>`, `<agent_identity>`, `<agent_persona>`)

---

## 4. Non-Goals

- Modifying MCP `tool()` description strings (those are already solid)
- Adding new MCP tools
- Dynamic/per-session context (live agent lists, current endpoints)
- Pulse tool context (lower priority, separate concern)
- Custom user-provided context blocks (future extension)
- Per-agent capability-based gating (future extension via `manifest.capabilities`)

---

## 5. Technical Dependencies

| Dependency           | Version              | Notes                                        |
| -------------------- | -------------------- | -------------------------------------------- |
| `context-builder.ts` | internal             | Existing `buildSystemPromptAppend()` pattern |
| `relay-state.ts`     | internal             | `isRelayEnabled()` feature flag              |
| `mesh-state.ts`      | internal             | `isMeshEnabled()` (always true per ADR-0062) |
| `config-manager.ts`  | internal             | `configManager.get('agentContext')`          |
| `config-schema.ts`   | `@dorkos/shared`     | `UserConfigSchema` Zod schema                |
| `agent-manager.ts`   | internal             | Calls `buildSystemPromptAppend()`            |
| shadcn/ui Switch     | `@/layers/shared/ui` | Toggle component for Context tab             |

---

## 6. Detailed Design

### 6.1 Context Block Content

Three static string constants, each designed to complement (not duplicate) the existing `tool()` descriptions. Content focuses on subject conventions, workflow sequences, and cross-tool orchestration.

#### `RELAY_TOOLS_CONTEXT` (~250 tokens)

```xml
<relay_tools>
DorkOS Relay is a pub/sub message bus for inter-agent communication.

Subject hierarchy:
  relay.agent.{sessionId}          — address a specific agent session
  relay.human.console.{clientId}   — reach a human in the DorkOS UI
  relay.system.console             — system broadcast channel
  relay.system.pulse.{scheduleId}  — Pulse scheduler events

Workflows:
- Register a reply address first: relay_register_endpoint(subject="relay.agent.{your-sessionId}")
- Message another agent: relay_send(subject="relay.agent.{their-sessionId}", payload={...}, from="relay.agent.{your-sessionId}")
- Check for replies: relay_inbox(endpoint_subject="relay.agent.{your-sessionId}")
- See who is listening: relay_list_endpoints()

The "from" field is your own subject. Set "replyTo" so the recipient knows where to respond.

Error codes: RELAY_DISABLED (feature off), ACCESS_DENIED (subject blocked), INVALID_SUBJECT (malformed), ENDPOINT_NOT_FOUND (inbox miss).
</relay_tools>
```

#### `MESH_TOOLS_CONTEXT` (~280 tokens)

```xml
<mesh_tools>
DorkOS Mesh is a local agent registry for discovering and communicating with AI agents on this machine.

Agent lifecycle:
1. mesh_discover(roots=["/path"]) — scan directories for agent candidates (looks for CLAUDE.md, .dork/agent.json)
2. mesh_register(path, name, runtime, capabilities) — register a candidate as a known agent
3. mesh_inspect(agentId) — get full manifest, health status, and relay endpoint
4. mesh_status() — aggregate overview: total, active, stale agent counts
5. mesh_list(runtime?, capability?) — filter agents by runtime or capability
6. mesh_deny(path, reason) — exclude a path from future discovery
7. mesh_unregister(agentId) — remove an agent from the registry
8. mesh_query_topology(namespace?) — view agent network from a namespace perspective

Workflows:
- Find agents: mesh_list() then mesh_inspect(agentId) for details
- Contact another agent: mesh_inspect(agentId) to get their relay endpoint, then relay_send
- Register this project: mesh_register(path=cwd, name="project-name", runtime="claude-code")

Runtimes: claude-code | cursor | codex | other
</mesh_tools>
```

#### `ADAPTER_TOOLS_CONTEXT` (~200 tokens)

```xml
<adapter_tools>
Relay adapters bridge external platforms (Telegram, webhooks) to the agent message bus.

Subject conventions for external messages:
  relay.human.telegram.{chatId}    — send to / receive from Telegram
  relay.human.webhook.{webhookId}  — send to / receive from webhooks

Adapter management:
- relay_list_adapters() — see all adapters and their status (connected, disconnected, error)
- relay_enable_adapter(id) / relay_disable_adapter(id) — toggle an adapter on/off
- relay_reload_adapters() — hot-reload config from disk

Bindings route adapter messages to agent projects:
- binding_list() — see current adapter-to-agent bindings
- binding_create(adapterId, agentId, projectPath) — route an adapter to an agent
- binding_delete(id) — remove a binding

Session strategies: per-chat (default, one session per conversation), per-user (shared across chats), stateless (new session each message).
</adapter_tools>
```

### 6.2 Context Builder Changes

File: `apps/server/src/services/core/context-builder.ts`

Add three static constants at module scope and three pure builder functions. Wire them into `buildSystemPromptAppend()`.

**New imports:**

```typescript
import { isRelayEnabled } from '../relay/relay-state.js';
import { configManager } from './config-manager.js';
```

**Static constants** (module-level, computed once at import time):

```typescript
const RELAY_TOOLS_CONTEXT = `<relay_tools>
DorkOS Relay is a pub/sub message bus for inter-agent communication.
...
</relay_tools>`;

const MESH_TOOLS_CONTEXT = `<mesh_tools>
DorkOS Mesh is a local agent registry...
</mesh_tools>`;

const ADAPTER_TOOLS_CONTEXT = `<adapter_tools>
Relay adapters bridge external platforms...
</adapter_tools>`;
```

(Full content as shown in section 6.1.)

**Builder functions:**

```typescript
/**
 * Build the `<relay_tools>` context block.
 * Included when Relay is enabled AND the config toggle is on.
 */
function buildRelayToolsBlock(): string {
  if (!isRelayEnabled()) return '';
  const config = configManager.get('agentContext');
  if (config?.relayTools === false) return '';
  return RELAY_TOOLS_CONTEXT;
}

/**
 * Build the `<mesh_tools>` context block.
 * Included when Mesh is available AND the config toggle is on.
 */
function buildMeshToolsBlock(): string {
  const config = configManager.get('agentContext');
  if (config?.meshTools === false) return '';
  return MESH_TOOLS_CONTEXT;
}

/**
 * Build the `<adapter_tools>` context block.
 * Included when Relay is enabled (adapters require Relay) AND the config toggle is on.
 */
function buildAdapterToolsBlock(): string {
  if (!isRelayEnabled()) return '';
  const config = configManager.get('agentContext');
  if (config?.adapterTools === false) return '';
  return ADAPTER_TOOLS_CONTEXT;
}
```

**Updated `buildSystemPromptAppend`:**

```typescript
export async function buildSystemPromptAppend(cwd: string): Promise<string> {
  const [envResult, gitResult, agentResult] = await Promise.allSettled([
    buildEnvBlock(cwd),
    buildGitBlock(cwd),
    buildAgentBlock(cwd),
  ]);

  // Tool context blocks are synchronous (static strings + config checks)
  const relayBlock = buildRelayToolsBlock();
  const meshBlock = buildMeshToolsBlock();
  const adapterBlock = buildAdapterToolsBlock();

  return [
    envResult.status === 'fulfilled' ? envResult.value : '',
    gitResult.status === 'fulfilled' ? gitResult.value : '',
    agentResult.status === 'fulfilled' ? agentResult.value : '',
    relayBlock,
    meshBlock,
    adapterBlock,
  ]
    .filter(Boolean)
    .join('\n\n');
}
```

The tool context builder functions are synchronous (no async needed — they return static strings gated by synchronous config checks). They are called directly rather than wrapped in `Promise.allSettled()` to avoid unnecessary promise overhead.

**Test exports:**

```typescript
/** @internal Exported for testing only. */
export {
  buildRelayToolsBlock as _buildRelayToolsBlock,
  buildMeshToolsBlock as _buildMeshToolsBlock,
  buildAdapterToolsBlock as _buildAdapterToolsBlock,
  RELAY_TOOLS_CONTEXT as _RELAY_TOOLS_CONTEXT,
  MESH_TOOLS_CONTEXT as _MESH_TOOLS_CONTEXT,
  ADAPTER_TOOLS_CONTEXT as _ADAPTER_TOOLS_CONTEXT,
};
```

### 6.3 Config Schema Changes

File: `packages/shared/src/config-schema.ts`

Add `agentContext` section to `UserConfigSchema` after the existing `onboarding` section:

```typescript
  agentContext: z
    .object({
      relayTools: z.boolean().default(true),
      meshTools: z.boolean().default(true),
      adapterTools: z.boolean().default(true),
    })
    .default(() => ({ relayTools: true, meshTools: true, adapterTools: true })),
```

All toggles default to `true` — context injection is on by default when the underlying feature is available. Users opt out, not in.

### 6.4 Config API Changes

File: `apps/server/src/routes/config.ts`

No code changes required. The existing PATCH handler already deep-merges incoming patches with current config, validates via `UserConfigSchema.safeParse(merged)`, and writes validated keys via `configManager.set()`. Since `agentContext` is added to `UserConfigSchema`, it flows through automatically.

The GET response will include `agentContext` in the config object:

```json
{
  "agentContext": {
    "relayTools": true,
    "meshTools": true,
    "adapterTools": true
  }
}
```

### 6.5 Agent Settings Context Tab

New file: `apps/client/src/layers/features/agent-settings/ui/ContextTab.tsx`

A read-only preview tab with toggle switches. Follows the pattern established by `CapabilitiesTab.tsx` and `ConnectionsTab.tsx`.

```tsx
import { useCallback } from 'react';
import { useRelayEnabled } from '@/layers/entities/relay';
import { Badge, Label, Switch } from '@/layers/shared/ui';
import { useAgentContextConfig } from '../model/use-agent-context-config';

export function ContextTab() {
  const relayEnabled = useRelayEnabled();
  const { config, updateConfig } = useAgentContextConfig();

  const handleToggle = useCallback(
    (key: 'relayTools' | 'meshTools' | 'adapterTools', value: boolean) => {
      updateConfig({ [key]: value });
    },
    [updateConfig]
  );

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Control which tool usage instructions are injected into the agent system prompt. These
        blocks teach the agent how to use DorkOS tools together.
      </p>

      <ContextBlockSection
        label="Relay Tools"
        description="Subject hierarchy, messaging workflows, and error codes for the Relay message bus."
        enabled={config.relayTools}
        available={relayEnabled}
        unavailableReason="Relay is disabled"
        onToggle={(v) => handleToggle('relayTools', v)}
        preview={RELAY_PREVIEW}
      />

      <ContextBlockSection
        label="Mesh Tools"
        description="Agent lifecycle, discovery workflow, and cross-tool orchestration with Relay."
        enabled={config.meshTools}
        available={true}
        onToggle={(v) => handleToggle('meshTools', v)}
        preview={MESH_PREVIEW}
      />

      <ContextBlockSection
        label="Adapter Tools"
        description="External platform subjects, adapter management, and binding routing conventions."
        enabled={config.adapterTools}
        available={relayEnabled}
        unavailableReason="Relay is disabled"
        onToggle={(v) => handleToggle('adapterTools', v)}
        preview={ADAPTER_PREVIEW}
      />
    </div>
  );
}
```

`ContextBlockSection` is a local helper component (not exported from the barrel):

```tsx
interface ContextBlockSectionProps {
  label: string;
  description: string;
  enabled: boolean;
  available: boolean;
  unavailableReason?: string;
  onToggle: (value: boolean) => void;
  preview: string;
}

function ContextBlockSection({
  label,
  description,
  enabled,
  available,
  unavailableReason,
  onToggle,
  preview,
}: ContextBlockSectionProps) {
  const effective = available && enabled;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label className="text-sm font-medium">{label}</Label>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          {!available && (
            <Badge variant="secondary" className="text-xs">
              {unavailableReason}
            </Badge>
          )}
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={!available}
            aria-label={`Toggle ${label} context`}
          />
        </div>
      </div>
      {effective && (
        <pre className="bg-muted max-h-40 overflow-y-auto rounded-md p-3 text-xs leading-relaxed">
          {preview}
        </pre>
      )}
    </section>
  );
}
```

Preview strings (`RELAY_PREVIEW`, `MESH_PREVIEW`, `ADAPTER_PREVIEW`) are static module-level constants in `ContextTab.tsx` matching the server-side XML block content (without the outer XML tags for cleaner display).

### 6.6 Agent Context Config Hook

New file: `apps/client/src/layers/features/agent-settings/model/use-agent-context-config.ts`

```typescript
import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

interface AgentContextConfig {
  relayTools: boolean;
  meshTools: boolean;
  adapterTools: boolean;
}

const DEFAULTS: AgentContextConfig = {
  relayTools: true,
  meshTools: true,
  adapterTools: true,
};

export function useAgentContextConfig() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });

  const config: AgentContextConfig = {
    ...DEFAULTS,
    ...data?.agentContext,
  };

  const mutation = useMutation({
    mutationFn: (patch: Partial<AgentContextConfig>) =>
      transport.updateConfig({ agentContext: { ...config, ...patch } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config'] });
    },
  });

  const updateConfig = useCallback(
    (patch: Partial<AgentContextConfig>) => {
      mutation.mutate(patch);
    },
    [mutation]
  );

  return { config, updateConfig };
}
```

### 6.7 AgentDialog Tab Integration

File: `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx`

Add the Context tab as the fifth tab:

```tsx
import { ContextTab } from './ContextTab';

// Update grid-cols-4 to grid-cols-5:
<TabsList className="mx-4 mt-3 grid w-full grid-cols-5">
  <TabsTrigger value="identity">Identity</TabsTrigger>
  <TabsTrigger value="persona">Persona</TabsTrigger>
  <TabsTrigger value="capabilities">Capabilities</TabsTrigger>
  <TabsTrigger value="connections">Connections</TabsTrigger>
  <TabsTrigger value="context">Context</TabsTrigger>
</TabsList>

// Add TabsContent after the connections content:
<TabsContent value="context" className="mt-0">
  <ContextTab />
</TabsContent>
```

`ContextTab` does not receive `agent` or `onUpdate` props because it operates on the global `agentContext` config section, not the per-agent manifest. Tool context settings are server-wide, not per-agent.

### 6.8 Barrel Export Update

File: `apps/client/src/layers/features/agent-settings/index.ts`

No changes needed. `ContextTab` is used internally by `AgentDialog` and does not need to be exported from the barrel.

---

## 7. Data Flow

```
+----------------------------------------------------------------------------+
| Server Startup                                                             |
|                                                                            |
|  config.json --> configManager.get('agentContext')                          |
|                  { relayTools: true, meshTools: true, adapterTools: true }  |
|                                                                            |
|  relay-state.ts --> isRelayEnabled() --> true/false                         |
|  mesh-state.ts  --> isMeshEnabled()  --> true (always, ADR-0062)           |
+----------------------------------------------------------------------------+
                              |
                              v
+----------------------------------------------------------------------------+
| Agent Session (per sendMessage call)                                       |
|                                                                            |
|  agent-manager.ts                                                          |
|    |                                                                       |
|    +---> buildSystemPromptAppend(cwd)                                      |
|    |      +---> buildEnvBlock(cwd)            --> <env>...</env>            |
|    |      +---> buildGitBlock(cwd)            --> <git_status>...</git>     |
|    |      +---> buildAgentBlock(cwd)          --> <agent_identity>...       |
|    |      +---> buildRelayToolsBlock()        --> <relay_tools>... | ""     |
|    |      +---> buildMeshToolsBlock()         --> <mesh_tools>...  | ""     |
|    |      +---> buildAdapterToolsBlock()      --> <adapter_tools>..| ""     |
|    |                                                                       |
|    +---> query({ systemPrompt: { append: joinedBlocks } })                 |
+----------------------------------------------------------------------------+
                              |
                              v
+----------------------------------------------------------------------------+
| Client UI (Agent Settings Dialog)                                          |
|                                                                            |
|  ContextTab                                                                |
|    +---> useAgentContextConfig()  --> reads from config query cache         |
|    +---> useRelayEnabled()        --> checks relay feature flag             |
|    +---> PATCH /api/config        --> updates agentContext section          |
+----------------------------------------------------------------------------+
```

---

## 8. Gating Logic

Each context block requires BOTH conditions to be true:

| Block             | Feature Gate                | Config Gate                           | Default State             |
| ----------------- | --------------------------- | ------------------------------------- | ------------------------- |
| `<relay_tools>`   | `isRelayEnabled() === true` | `agentContext.relayTools !== false`   | Included when relay is on |
| `<mesh_tools>`    | Always available (ADR-0062) | `agentContext.meshTools !== false`    | Always included           |
| `<adapter_tools>` | `isRelayEnabled() === true` | `agentContext.adapterTools !== false` | Included when relay is on |

Config toggles use `!== false` checks (not `=== true`) so that the default state (undefined/missing key) resolves to included. This ensures backward compatibility when upgrading from a config file that predates the `agentContext` section.

---

## 9. Token Budget

| Block             | Estimated Tokens | Content Focus                                          |
| ----------------- | ---------------- | ------------------------------------------------------ |
| `<relay_tools>`   | ~250             | Subject hierarchy, 4 workflow steps, error codes       |
| `<mesh_tools>`    | ~280             | 8-step lifecycle, 3 workflow patterns, runtimes        |
| `<adapter_tools>` | ~200             | External subjects, adapter management, binding routing |
| **Total**         | **~730**         | **0.37% of 200K context window**                       |

This is well within the 600-1000 token target. For comparison, the existing `<env>` block is ~60 tokens and `<agent_persona>` can be up to ~400 tokens.

---

## 10. File Impact Summary

### Phase 1: Context Blocks + Config Schema (Server-Only)

| File                                                              | Action | Description                                                                        |
| ----------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| `packages/shared/src/config-schema.ts`                            | Modify | Add `agentContext` section to `UserConfigSchema`                                   |
| `apps/server/src/services/core/context-builder.ts`                | Modify | Add 3 static constants, 3 builder functions, wire into `buildSystemPromptAppend()` |
| `apps/server/src/services/core/__tests__/context-builder.test.ts` | Modify | Add tests for each builder function under enabled/disabled states                  |

### Phase 2: Agent Settings Context Tab (Client UI)

| File                                                                               | Action | Description                                                  |
| ---------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------ |
| `apps/client/src/layers/features/agent-settings/ui/ContextTab.tsx`                 | Create | New tab component with toggle switches and previews          |
| `apps/client/src/layers/features/agent-settings/model/use-agent-context-config.ts` | Create | Hook for reading/updating agentContext config                |
| `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx`                | Modify | Add Context tab (5th tab), update grid-cols-4 to grid-cols-5 |
| `apps/client/src/layers/features/agent-settings/__tests__/ContextTab.test.tsx`     | Create | Component tests for toggle behavior and preview rendering    |

---

## 11. Acceptance Criteria

1. **Relay context injected:** Agents receive `<relay_tools>` block when relay is enabled and `agentContext.relayTools` is true (default: true)
2. **Mesh context injected:** Agents receive `<mesh_tools>` block when mesh is available and `agentContext.meshTools` is true (default: true)
3. **Adapter context injected:** Agents receive `<adapter_tools>` block when relay is enabled and `agentContext.adapterTools` is true (default: true)
4. **Config schema updated:** `agentContext` section in `UserConfigSchema` with three boolean toggles, all defaulting to true
5. **Config API supports new section:** PATCH `/api/config` with `{ "agentContext": { "relayTools": false } }` disables relay context injection
6. **Context tab in Agent Settings:** Fifth tab "Context" in AgentDialog with toggle switches per block
7. **No regression:** Existing `<env>`, `<git_status>`, `<agent_identity>`, `<agent_persona>` blocks unchanged
8. **Unit tests for builders:** Each of `buildRelayToolsBlock`, `buildMeshToolsBlock`, `buildAdapterToolsBlock` tested under feature-enabled/disabled and config-on/off combinations
9. **Context tab shows preview:** When a toggle is on and the feature is available, a read-only `<pre>` block shows the XML content

---

## 12. Testing Strategy

### 12.1 Server Unit Tests

File: `apps/server/src/services/core/__tests__/context-builder.test.ts`

Test the three new builder functions by mocking feature flags and config:

```typescript
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn(() => true),
}));
vi.mock('../config-manager.js', () => ({
  configManager: {
    get: vi.fn(() => ({ relayTools: true, meshTools: true, adapterTools: true })),
  },
}));

import { isRelayEnabled } from '../../relay/relay-state.js';
import { configManager } from '../config-manager.js';
import {
  _buildRelayToolsBlock,
  _buildMeshToolsBlock,
  _buildAdapterToolsBlock,
} from '../context-builder.js';

describe('buildRelayToolsBlock', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns relay context when relay enabled and config on', () => {
    const result = _buildRelayToolsBlock();
    expect(result).toContain('<relay_tools>');
    expect(result).toContain('relay.agent.{sessionId}');
    expect(result).toContain('</relay_tools>');
  });

  it('returns empty string when relay disabled', () => {
    vi.mocked(isRelayEnabled).mockReturnValue(false);
    expect(_buildRelayToolsBlock()).toBe('');
  });

  it('returns empty string when config toggle is off', () => {
    vi.mocked(configManager.get).mockReturnValue({ relayTools: false });
    expect(_buildRelayToolsBlock()).toBe('');
  });
});

describe('buildMeshToolsBlock', () => {
  it('returns mesh context by default (mesh always-on)', () => {
    const result = _buildMeshToolsBlock();
    expect(result).toContain('<mesh_tools>');
    expect(result).toContain('mesh_discover');
    expect(result).toContain('</mesh_tools>');
  });

  it('returns empty string when config toggle is off', () => {
    vi.mocked(configManager.get).mockReturnValue({ meshTools: false });
    expect(_buildMeshToolsBlock()).toBe('');
  });
});

describe('buildAdapterToolsBlock', () => {
  it('returns adapter context when relay enabled and config on', () => {
    const result = _buildAdapterToolsBlock();
    expect(result).toContain('<adapter_tools>');
    expect(result).toContain('binding_create');
    expect(result).toContain('</adapter_tools>');
  });

  it('returns empty string when relay disabled', () => {
    vi.mocked(isRelayEnabled).mockReturnValue(false);
    expect(_buildAdapterToolsBlock()).toBe('');
  });
});

describe('buildSystemPromptAppend (tool context integration)', () => {
  it('includes tool context blocks in output when features are enabled', async () => {
    const result = await buildSystemPromptAppend('/test/path');
    expect(result).toContain('<env>');
    expect(result).toContain('<relay_tools>');
    expect(result).toContain('<mesh_tools>');
    expect(result).toContain('<adapter_tools>');
  });

  it('excludes relay and adapter blocks when relay is disabled', async () => {
    vi.mocked(isRelayEnabled).mockReturnValue(false);
    const result = await buildSystemPromptAppend('/test/path');
    expect(result).toContain('<env>');
    expect(result).toContain('<mesh_tools>');
    expect(result).not.toContain('<relay_tools>');
    expect(result).not.toContain('<adapter_tools>');
  });
});
```

### 12.2 Client Component Tests

File: `apps/client/src/layers/features/agent-settings/__tests__/ContextTab.test.tsx`

```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

vi.mock('@/layers/entities/relay', () => ({
  useRelayEnabled: vi.fn(() => true),
}));
vi.mock('../model/use-agent-context-config', () => ({
  useAgentContextConfig: vi.fn(() => ({
    config: { relayTools: true, meshTools: true, adapterTools: true },
    updateConfig: vi.fn(),
  })),
}));

import { ContextTab } from '../ui/ContextTab';
import { useRelayEnabled } from '@/layers/entities/relay';
import { useAgentContextConfig } from '../model/use-agent-context-config';

describe('ContextTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders all three toggle sections', () => {
    render(<ContextTab />);
    expect(screen.getByText('Relay Tools')).toBeInTheDocument();
    expect(screen.getByText('Mesh Tools')).toBeInTheDocument();
    expect(screen.getByText('Adapter Tools')).toBeInTheDocument();
  });

  it('shows preview when toggle is on and feature is available', () => {
    render(<ContextTab />);
    expect(screen.getByText(/relay\.agent\.\{sessionId\}/)).toBeInTheDocument();
  });

  it('disables relay and adapter switches when relay is off', () => {
    vi.mocked(useRelayEnabled).mockReturnValue(false);
    render(<ContextTab />);
    const switches = screen.getAllByRole('switch');
    expect(switches[0]).toBeDisabled();
    expect(switches[2]).toBeDisabled();
    expect(switches[1]).not.toBeDisabled();
  });

  it('calls updateConfig when a toggle is switched', async () => {
    const updateConfig = vi.fn();
    vi.mocked(useAgentContextConfig).mockReturnValue({
      config: { relayTools: true, meshTools: true, adapterTools: true },
      updateConfig,
    });
    const user = userEvent.setup();
    render(<ContextTab />);

    const switches = screen.getAllByRole('switch');
    await user.click(switches[1]);

    expect(updateConfig).toHaveBeenCalledWith({ meshTools: false });
  });
});
```

---

## 13. Content Guidelines

The XML block content follows these principles derived from the research report:

1. **No duplication with tool descriptions.** The `tool()` descriptions in `relay-tools.ts`, `mesh-tools.ts`, etc. already explain what each tool does and its parameters. The context blocks explain when and how to use tools together.

2. **Subject hierarchy first.** The relay subject naming convention (`relay.agent.{sessionId}`) is the single most critical piece of missing context. It is placed at the top of each relevant block.

3. **Workflow-oriented.** Each block has a "Workflows" section showing common multi-tool sequences (e.g., "mesh_inspect to get relay endpoint, then relay_send").

4. **Calm, direct prose.** No `CRITICAL: YOU MUST` language. Claude 4.x models respond well to normal imperative sentences.

5. **Numbered steps for lifecycle, bullets for ad-hoc workflows.** Mesh has a natural numbered lifecycle (discover to register to inspect); relay workflows are more ad-hoc (bullet list).

---

## 14. Security Considerations

- **No secrets in context blocks.** The blocks contain only static documentation strings. No API keys, session IDs, or user data.
- **Config validation.** The `agentContext` schema uses `z.boolean().default(true)` — invalid values are rejected by Zod validation in the PATCH handler.
- **No new attack surface.** The context blocks are read-only from the agent's perspective. They document existing tool behavior, not new capabilities.

---

## 15. Performance Considerations

- **Static strings.** The three context block constants are allocated once at module load time. No per-request allocation.
- **Synchronous checks.** `isRelayEnabled()` and `configManager.get()` are synchronous in-memory reads. No I/O per invocation.
- **Token overhead.** ~730 tokens added to system prompt when all three blocks are active. This is 0.37% of the 200K context window and adds negligible cost to API billing.
- **No impact on `Promise.allSettled`.** The tool context builders are called synchronously outside the `allSettled` block, avoiding unnecessary promise wrapping.

---

## 16. Related Decisions & Specs

| Reference                                            | Relationship                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| ADR-0051: Persona Injection via Context Builder      | Precedent for XML block injection pattern                     |
| ADR-0062: Remove Mesh Feature Flag (Always-On)       | Mesh is always available, no feature flag gate                |
| Spec 42: Context Builder & agent-manager.ts Refactor | Created the `context-builder.ts` architecture                 |
| Spec 41: Dynamic MCP Tool Injection Architecture     | Created the `setMcpServerFactory()` pattern                   |
| Research: `20260303_agent_tool_context_injection.md` | Full research report with token budgets and content templates |

---

## 17. Build Sequence

### Phase 1: Context Blocks + Config Schema (Server-Only)

- [ ] **1.1** Add `agentContext` section to `UserConfigSchema` in `packages/shared/src/config-schema.ts`
- [ ] **1.2** Add `RELAY_TOOLS_CONTEXT`, `MESH_TOOLS_CONTEXT`, `ADAPTER_TOOLS_CONTEXT` constants to `context-builder.ts`
- [ ] **1.3** Add `buildRelayToolsBlock()`, `buildMeshToolsBlock()`, `buildAdapterToolsBlock()` functions to `context-builder.ts`
- [ ] **1.4** Wire the three builder functions into `buildSystemPromptAppend()` return array
- [ ] **1.5** Export builder functions and constants with `@internal` annotation for testing
- [ ] **1.6** Add unit tests for each builder function (feature enabled/disabled, config on/off)
- [ ] **1.7** Add integration test for `buildSystemPromptAppend()` including tool context blocks
- [ ] **1.8** Run `pnpm typecheck` and `pnpm test` to verify no regressions
- [ ] **1.9** Manually verify: start server with relay enabled, send a message, confirm tool context appears in system prompt

### Phase 2: Agent Settings Context Tab (Client UI)

- [ ] **2.1** Create `use-agent-context-config.ts` hook in `features/agent-settings/model/`
- [ ] **2.2** Create `ContextTab.tsx` component in `features/agent-settings/ui/`
- [ ] **2.3** Update `AgentDialog.tsx`: import `ContextTab`, add 5th tab, update `grid-cols-4` to `grid-cols-5`
- [ ] **2.4** Create `ContextTab.test.tsx` with toggle behavior and preview rendering tests
- [ ] **2.5** Run `pnpm typecheck` and `pnpm test` across client
- [ ] **2.6** Manually verify: open Agent Settings, switch to Context tab, toggle switches, confirm previews show/hide

---

## Appendix A: Content Maintenance

When new MCP tools are added to a tool group, the corresponding context block constant should be updated. Since these are static strings in `context-builder.ts`, this is a simple code change — no runtime mechanism is needed.

A future extension could move the content to external files (e.g., `context-blocks/relay-tools.md`) for easier editing, but the current inline approach keeps the blast radius small and avoids filesystem I/O at runtime.

## Appendix B: Future Extensions

- **Per-agent context gating:** Check `manifest.capabilities.includes('relay')` before including `<relay_tools>`. Useful when some agents should not have relay access.
- **Custom user context blocks:** Allow users to add custom blocks via config or `.dork/context/` files.
- **Pulse tool context:** A `<pulse_tools>` block documenting schedule creation, cron syntax, and run management workflows.
- **Dynamic context injection:** Pull live data (current endpoint list, registered agent count) into context blocks. Only warranted if agents demonstrably benefit from this information.
