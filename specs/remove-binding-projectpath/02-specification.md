---
slug: remove-binding-projectpath
number: 131
created: 2026-03-14
status: specification
authors:
  - Claude Code
---

# Remove projectPath from AdapterBinding — Derive CWD from Agent Registry

## Status

Specification

## Overview

Remove `projectPath` from the `AdapterBinding` schema. Instead of storing CWD on the binding, derive it at routing time from the agent registry via `meshCore.getProjectPath(binding.agentId)`. This eliminates a data redundancy that causes empty-CWD bugs and discrepancy risks.

## Background / Problem Statement

The `AdapterBinding` schema stores both `agentId` and `projectPath`, but agents have a **1:1 mapping** with `projectPath` (enforced by a UNIQUE constraint in the `agents` DB table). This creates three problems:

1. **Redundancy** — `agentId` already implies a `projectPath`. Storing both violates single-source-of-truth.
2. **Discrepancy risk** — The binding's `projectPath` can diverge from the agent's actual registered path (e.g., if the agent directory moves).
3. **Empty-string bugs** — Multiple binding creation paths (quick-route, adapter setup wizard) set `projectPath: ''` because the UI doesn't always ask for it. The live Slack binding has this bug today.

The root cause is a design flaw: `projectPath` should never have been a binding field. The agent registry already owns this data.

## Goals

- Remove `projectPath` from `AdapterBindingSchema` and `CreateBindingRequestSchema`
- Derive CWD at routing time from `meshCore.getProjectPath(agentId)` in `BindingRouter`
- Migrate existing `bindings.json` files to strip `projectPath` on load
- Remove the "Project Path" input from the binding creation UI
- Update MCP `binding_create` tool to not require `projectPath`
- Update all tests

## Non-Goals

- Changes to how agents store or register their `projectPath`
- Changes to the agent discovery/scanning system
- Redesigning the binding creation UX beyond removing the `projectPath` field
- Adding new UI elements to display the derived agent path

## Technical Dependencies

- `AdapterMeshCoreLike` interface (already exists in `adapter-manager.ts:52-54`)
- `MeshCore.getProjectPath(agentId)` (already exists in `packages/mesh/src/mesh-core.ts:169`)
- `meshCore` dependency already available in `AdapterManager.deps`

No new external libraries required.

## Detailed Design

### 1. Schema Changes

**File:** `packages/shared/src/relay-adapter-schemas.ts`

Remove `projectPath` from the binding schema:

```typescript
// BEFORE
export const AdapterBindingSchema = z
  .object({
    id: z.string().uuid(),
    adapterId: z.string(),
    agentId: z.string(),
    projectPath: z.string(), // ← REMOVE
    chatId: z.string().optional(),
    channelType: ChannelTypeSchema.optional(),
    sessionStrategy: SessionStrategySchema.default('per-chat'),
    label: z.string().default(''),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('AdapterBinding');

// AFTER
export const AdapterBindingSchema = z
  .object({
    id: z.string().uuid(),
    adapterId: z.string(),
    agentId: z.string(),
    chatId: z.string().optional(),
    channelType: ChannelTypeSchema.optional(),
    sessionStrategy: SessionStrategySchema.default('per-chat'),
    label: z.string().default(''),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('AdapterBinding');
```

`CreateBindingRequestSchema` derives via `.omit()` and auto-updates. `AdapterBinding` and `CreateBindingRequest` types are auto-inferred.

### 2. BindingRouter — CWD Resolution from Mesh

**File:** `apps/server/src/services/relay/binding-router.ts`

Add `meshCore` as a required dependency and resolve CWD from it:

```typescript
import type { AdapterMeshCoreLike } from './adapter-manager.js';

export interface BindingRouterDeps {
  bindingStore: BindingStore;
  relayCore: RelayCoreLike;
  agentManager: AgentSessionCreator;
  relayDir: string;
  meshCore: AdapterMeshCoreLike; // ← ADD (required)
  resolveAdapterInstanceId?: (platformType: string) => string | undefined;
}
```

Replace `binding.projectPath` usage in `handleInbound()`:

```typescript
// BEFORE (lines 131-136)
const enrichedPayload =
  binding.projectPath && envelope.payload && typeof envelope.payload === 'object'
    ? { ...(envelope.payload as Record<string, unknown>), cwd: binding.projectPath }
    : envelope.payload;

// AFTER
const projectPath = this.deps.meshCore.getProjectPath(binding.agentId);
if (!projectPath) {
  logger.warn(`BindingRouter: agent '${binding.agentId}' not found in mesh registry, skipping`);
  return;
}
const enrichedPayload =
  envelope.payload && typeof envelope.payload === 'object'
    ? { ...(envelope.payload as Record<string, unknown>), cwd: projectPath }
    : envelope.payload;
```

Replace in `createNewSession()`:

```typescript
// BEFORE (lines 232-241)
private async createNewSession(binding: AdapterBinding): Promise<string> {
  const session = await this.deps.agentManager.createSession(binding.projectPath);
  return session.id;
}

// AFTER
private async createNewSession(binding: AdapterBinding): Promise<string> {
  const projectPath = this.deps.meshCore.getProjectPath(binding.agentId);
  if (!projectPath) {
    throw new Error(`Agent '${binding.agentId}' not found in mesh registry`);
  }
  logger.debug('[BindingRouter] createNewSession', {
    bindingId: binding.id,
    adapterId: binding.adapterId,
    agentId: binding.agentId,
    projectPath,
  });
  const session = await this.deps.agentManager.createSession(projectPath);
  return session.id;
}
```

### 3. AdapterManager — Wire meshCore into BindingRouter

**File:** `apps/server/src/services/relay/adapter-manager.ts`

In `initBindingSubsystem()`, pass `meshCore` when constructing `BindingRouter`:

```typescript
// Guard: meshCore is now required for binding routing
if (!this.deps.meshCore) {
  logger.info('[AdapterManager] meshCore not provided, skipping binding subsystem');
  return;
}

this.bindingRouter = new BindingRouter({
  bindingStore: this.bindingStore,
  relayCore: this.deps.relayCore,
  agentManager: sessionCreator,
  relayDir,
  meshCore: this.deps.meshCore, // ← ADD
  resolveAdapterInstanceId: (platformType: string) => {
    const match = this.configs.find((c) => c.type === platformType && c.enabled);
    return match?.id;
  },
});
```

### 4. BindingStore — Migration

**File:** `apps/server/src/services/relay/binding-store.ts`

Replace the legacy `agentDir → projectPath` migration with a `projectPath` stripping migration:

```typescript
// BEFORE (lines 196-202)
if (json.bindings) {
  for (const b of json.bindings) {
    if ('agentDir' in b && !('projectPath' in b)) {
      b.projectPath = b.agentDir;
      delete b.agentDir;
    }
  }
}

// AFTER
if (json.bindings) {
  for (const b of json.bindings) {
    // Strip legacy fields — projectPath is now derived from agent registry
    delete b.projectPath;
    delete b.agentDir;
  }
}
```

### 5. MCP Tools — Remove projectPath Parameter

**File:** `apps/server/src/services/runtimes/claude-code/mcp-tools/binding-tools.ts`

Remove `projectPath` from the tool definition and handler:

```typescript
// Tool definition — remove projectPath from schema
tool(
  'binding_create',
  'Create a new adapter-to-agent binding. Routes messages from an adapter to an agent.',
  {
    adapterId: z.string().describe('ID of the adapter to bind'),
    agentId: z.string().describe('Agent ID to route messages to'),
    // projectPath REMOVED — derived from agent registry
    sessionStrategy: z.string().optional().describe('...'),
    chatId: z.string().optional().describe('...'),
    channelType: z.string().optional().describe('...'),
    label: z.string().optional().describe('...'),
  },
  createBindingCreateHandler(deps)
),

// Handler — remove projectPath from args type and create() call
export function createBindingCreateHandler(deps: McpToolDeps) {
  return async (args: {
    adapterId: string;
    agentId: string;
    // projectPath REMOVED
    sessionStrategy?: string;
    // ...
  }) => {
    const binding = await deps.bindingStore!.create({
      adapterId: args.adapterId,
      agentId: args.agentId,
      // projectPath REMOVED
      sessionStrategy: (args.sessionStrategy ?? 'per-chat') as SessionStrategy,
      label: args.label ?? '',
      // ...
    });
  };
}
```

**File:** `apps/server/src/services/core/mcp-server.ts`

Same removal — drop `projectPath` from the `binding_create` tool schema.

### 6. Client UI Changes

**BindingDialog** (`apps/client/src/layers/features/mesh/ui/BindingDialog.tsx`):

- Remove `projectPath: string` from `BindingFormValues` interface
- Remove `projectPath` state, setter, sync effect, and reset
- Remove the "Project Path" `<Input>` field (lines 254-262)
- Remove `projectPath` from `handleConfirm()` output

**BindingList** (`apps/client/src/layers/features/relay/ui/BindingList.tsx`):

- Remove `projectPathName()` utility function
- Change agent name fallback: `agent?.name ?? binding.agentId` (was `agent?.name ?? projectPathName(binding.projectPath)`)
- Remove `projectPath` from create/duplicate binding calls

**use-topology-handlers** (`apps/client/src/layers/features/mesh/ui/use-topology-handlers.ts`):

- Remove `targetProjectPath` from `PendingConnection` interface
- Remove `projectPath` from the `createBindingMutate` call

**ConversationRow** (`apps/client/src/layers/features/relay/ui/ConversationRow.tsx`):

- Remove `projectPath: ''` from quick-route binding creation
- Remove `projectPath: values.projectPath` from dialog binding creation

**AdapterSetupWizard** (`apps/client/src/layers/features/relay/ui/AdapterSetupWizard.tsx`):

- Remove `projectPath: ''` from wizard binding creation

**ToolsTab** (`apps/client/src/layers/features/settings/ui/ToolsTab.tsx`):

- Update tool description: `binding_create(adapterId, agentId)` (remove `projectPath`)

**ContextTab** (`apps/client/src/layers/features/agent-settings/ui/ContextTab.tsx`):

- Update tool description: `binding_create(adapterId, agentId)` (remove `projectPath`)

## Data Flow (After Change)

```
Inbound message (relay.human.slack.D123)
  │
  ▼
BindingRouter.handleInbound()
  │ parseSubject() → adapterId, chatId, channelType
  │ bindingStore.resolve() → binding (agentId, sessionStrategy, ...)
  │
  │ ┌─────────────────────────────────────────┐
  │ │ NEW: meshCore.getProjectPath(agentId)   │
  │ │       → projectPath (from agent registry)│
  │ └─────────────────────────────────────────┘
  │
  │ enrichedPayload = { ...payload, cwd: projectPath }
  │ resolveSession() → sessionId
  │
  ▼
publish(relay.agent.{sessionId}, enrichedPayload)
  │
  ▼
ClaudeCodeAdapter → ensureSession(id, { cwd: projectPath })
```

## User Experience

**Before:** Binding creation dialog shows a "Project Path" text input that users must manually fill. Many creation paths leave it empty, causing silent routing failures.

**After:** Binding creation only asks for adapter, agent, session strategy, label, and optional chat filters. The working directory is automatically determined from the selected agent. No manual path entry needed.

## Testing Strategy

### Server Tests

**binding-router.test.ts** — Core changes:

- Add `meshCore` mock to `BindingRouterDeps` with `getProjectPath: vi.fn()`
- Mock `getProjectPath` to return appropriate paths per test case
- Add test: "skips routing when meshCore returns undefined for agentId"
- Remove all `projectPath` from mock binding objects
- Update assertions that verify CWD enrichment (use meshCore return value)

**binding-store.test.ts:**

- Remove `projectPath` from all mock binding objects
- Add test: "strips projectPath from legacy bindings.json on load"
- Add test: "strips agentDir from legacy bindings.json on load"

**relay-bindings-integration.test.ts:**

- Remove `projectPath` from mock data and request bodies
- Update assertions

**MCP tool tests:**

- Remove `projectPath` from `binding_create` tool call args
- Verify binding is created without `projectPath`

### Client Tests

All binding-related test files need `projectPath` removed from mock data:

- `BindingDialog.test.tsx` — Remove projectPath from form assertions
- `BindingList.test.tsx` — Remove `projectPathName` assertions, update agent fallback test
- `ConversationRow.test.tsx` — Remove `projectPath: ''` from assertions
- `use-bindings.test.tsx` — Remove from mock bindings
- `use-update-binding.test.tsx` — Remove from mock bindings
- `transport-bindings.test.ts` — Remove from mock data and create calls
- `AdapterCard.test.tsx` — Remove from mock bindings
- `TopologyGraph.test.tsx` — Remove from mock connections

## Performance Considerations

- `meshCore.getProjectPath()` is an in-memory registry lookup (O(1) Map.get) — no performance impact
- Eliminates disk I/O for persisting redundant `projectPath` data in `bindings.json` (marginal)

## Security Considerations

No security impact. The change only affects where CWD is sourced (binding file → agent registry). The CWD itself is still validated and used the same way downstream.

## Documentation

- Update `contributing/relay-adapters.md` if it references binding `projectPath`
- Update `contributing/adapter-catalog.md` if it references binding schema
- MCP tool descriptions auto-update via schema changes

## Implementation Phases

### Phase 1: Schema + Server Core

1. Remove `projectPath` from `AdapterBindingSchema` and `CreateBindingRequestSchema`
2. Add `meshCore` to `BindingRouterDeps`, wire in `initBindingSubsystem()`
3. Replace `binding.projectPath` with `meshCore.getProjectPath()` in `handleInbound()` and `createNewSession()`
4. Update `BindingStore.load()` migration to strip `projectPath`
5. Update MCP tool definitions and handlers
6. Update all server tests

### Phase 2: Client

1. Remove `projectPath` from `BindingFormValues` and `BindingDialog`
2. Remove from `BindingList`, `use-topology-handlers`, `ConversationRow`, `AdapterSetupWizard`
3. Update tool description strings in `ToolsTab` and `ContextTab`
4. Update all client tests

### Phase 3: Verification

1. `pnpm typecheck` — clean
2. `pnpm test -- --run` — all green
3. `pnpm lint` — clean
4. Manual: start dev, create binding via UI, verify Slack message routing works with derived CWD

## Related ADRs

- **ADR-0043** — File-first write-through for agent storage (agents own their projectPath via `.dork/agent.json`)
- **ADR-0046** — Central BindingRouter for adapter-agent routing (establishes BindingRouter as the routing service)
- **ADR-0047** — Most-specific-first binding resolution order (scoring algorithm, unaffected by this change)
- **ADR-0126** — Envelope payload enrichment for CWD propagation (documents the CWD enrichment pattern, will need update to note source change)

## References

- Ideation document: `specs/remove-binding-projectpath/01-ideation.md`
- `AdapterMeshCoreLike` interface: `apps/server/src/services/relay/adapter-manager.ts:52-54`
- `MeshCore.getProjectPath()`: `packages/mesh/src/mesh-core.ts:169`
- Live bug: Slack binding in `apps/server/.temp/.dork/relay/bindings.json` has `projectPath: ""`
