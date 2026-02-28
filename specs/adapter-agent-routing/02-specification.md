---
slug: adapter-agent-routing
---

# Specification: Adapter-Agent Routing & Visual Binding Configuration

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-02-28
**Spec Number:** 71
**Source:** `specs/adapter-agent-routing/01-ideation.md`

---

## 1. Overview

Implement a central BindingRouter service and visual topology UI for binding external communication adapters (Telegram, Webhooks, future Slack/Discord) to specific AI agents. The system uses a binding table (persisted as JSON) to route inbound messages from adapters to agent sessions, with visual configuration via an extended TopologyGraph canvas.

The BindingRouter subscribes to `relay.human.*`, resolves adapter-to-agent bindings from a BindingStore, and republishes messages to `relay.agent.*` for ClaudeCodeAdapter to handle. Each adapter instance maps 1:1 to an agent. Adapters remain dumb protocol bridges; all routing logic is centralized.

## 2. Background / Problem Statement

DorkOS has a working adapter system (Telegram, Webhooks, plugin-based) and an agent identity system, but **no routing layer connects them**. Currently:

- Adapters publish to `relay.human.{platform}.{chatId}` but nothing subscribes to route those messages to agents
- The relay publish pipeline (Bug #70) has an early-return at `relay-core.ts:308-315` that dead-letters messages when no Maildir endpoints match, skipping adapter delivery entirely
- Users cannot configure which adapter talks to which agent without manual code changes
- The TopologyGraph shows agents but not adapters, so there's no visual representation of the full communication topology

This spec closes the routing gap: adapters publish inbound messages, BindingRouter resolves the target agent, and messages flow end-to-end.

## 3. Goals

- Close the adapter-to-agent routing gap so Telegram (and other adapter) messages reach agents end-to-end
- Provide a central, configurable binding table that maps adapter instances to agents
- Support multiple simultaneous adapter-agent bindings (e.g., 3 Telegram bots bound to 3 different agents)
- Enable visual binding configuration via the TopologyGraph canvas (drag-to-connect or dialog)
- Support configurable session strategies per binding (`per-chat`, `per-user`, `stateless`)
- Expose MCP tools so agents can manage their own bindings programmatically
- Persist bindings across server restarts via JSON file storage

## 4. Non-Goals

- Building new platform adapters (Slack, Discord) — those are separate specs
- Multi-tenant authorization model
- Token encryption at rest
- Content-based routing rules (n8n/Node-RED style conditional routing)
- Many-to-many binding (one adapter to multiple agents) — use multi-instance instead
- Real-time binding hot-swap during active conversations

## 5. Technical Dependencies

| Dependency | Version | Purpose |
|---|---|---|
| `@xyflow/react` | v12 | React Flow for topology visualization (already installed) |
| `elkjs` | ^0.9 | Automatic graph layout (already installed) |
| `chokidar` | ^4 | File watching for binding hot-reload (already installed) |
| `zod` | ^3.23 | Schema validation (already installed) |
| `better-sqlite3` | ^11 | Session tracking for `per-chat` strategy (already installed) |

All dependencies are already in the project. No new packages required.

### Prerequisite: Bug #70 Fix

The relay publish pipeline fix (`specs/relay-publish-pipeline-fix/`) must be verified as complete before BindingRouter can function. The fix removes the early-return at `relay-core.ts:308-315` that skips adapter delivery when no Maildir endpoints match. Status: in-progress. This spec includes verification as Phase 1.

## 6. Detailed Design

### 6.1 Architecture Overview

```
┌─────────────┐     relay.human.*      ┌───────────────┐     relay.agent.*     ┌──────────────────┐
│  Telegram    │ ──────────────────────>│               │ ───────────────────> │                  │
│  Adapter     │                        │  BindingRouter│                      │ ClaudeCodeAdapter │
│  (bridge)    │ <──────────────────────│  (resolver)   │ <─────────────────── │  (agent runner)  │
└─────────────┘     relay.human.*      └───────────────┘     relay.human.*    └──────────────────┘
                    (response)                │                                         │
                                              │                                         │
                                    ┌─────────┴─────────┐                     ┌────────┴────────┐
                                    │   BindingStore     │                     │  AgentManager   │
                                    │ (bindings.json)    │                     │  (SDK sessions) │
                                    └───────────────────┘                     └─────────────────┘
```

**Data flow (inbound message):**

1. TelegramAdapter receives message, publishes to `relay.human.telegram.{chatId}`
2. RelayCore `publish()` delivers to BindingRouter (registered as adapter delivery target)
3. BindingRouter resolves binding using most-specific-first matching
4. BindingRouter creates/resumes session via AgentManager based on session strategy
5. BindingRouter republishes to `relay.agent.{sessionId}` for ClaudeCodeAdapter
6. ClaudeCodeAdapter delivers to AgentManager, agent processes message
7. Agent response published to `relay.human.telegram.{chatId}`
8. TelegramAdapter `deliver()` sends response to Telegram API

### 6.2 New Shared Schemas

Add to `packages/shared/src/relay-schemas.ts`:

```typescript
export const SessionStrategySchema = z.enum(['per-chat', 'per-user', 'stateless']);
export type SessionStrategy = z.infer<typeof SessionStrategySchema>;

export const AdapterBindingSchema = z.object({
  id: z.string().uuid(),
  adapterId: z.string(),
  agentId: z.string(),
  agentDir: z.string(),
  chatId: z.string().optional(),
  channelType: ChannelTypeSchema.optional(),
  sessionStrategy: SessionStrategySchema.default('per-chat'),
  label: z.string().default(''),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AdapterBinding = z.infer<typeof AdapterBindingSchema>;

export const CreateBindingRequestSchema = AdapterBindingSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type CreateBindingRequest = z.infer<typeof CreateBindingRequestSchema>;

export const BindingListResponseSchema = z.object({
  bindings: z.array(AdapterBindingSchema),
});

export const BindingResponseSchema = z.object({
  binding: AdapterBindingSchema,
});
```

### 6.3 BindingStore (`packages/relay/src/binding-store.ts`)

JSON file persistence at `~/.dork/relay/bindings.json`, consistent with the existing `adapters.json` pattern.

```typescript
export class BindingStore {
  private bindings: Map<string, AdapterBinding> = new Map();
  private filePath: string;
  private watcher?: FSWatcher;

  constructor(relayDir: string) {
    this.filePath = path.join(relayDir, 'bindings.json');
  }

  async init(): Promise<void> {
    await this.load();
    this.watch(); // chokidar for hot-reload
  }

  // CRUD
  getAll(): AdapterBinding[] { ... }
  getById(id: string): AdapterBinding | undefined { ... }
  getByAdapterId(adapterId: string): AdapterBinding[] { ... }
  create(input: CreateBindingRequest): AdapterBinding { ... }
  delete(id: string): boolean { ... }

  // Resolution — most-specific-first (OpenClaw pattern)
  resolve(adapterId: string, chatId?: string, channelType?: string): AdapterBinding | undefined {
    const candidates = this.getByAdapterId(adapterId);
    // Priority order:
    // 1. adapterId + chatId + channelType (exact match)
    // 2. adapterId + chatId (any channel)
    // 3. adapterId + channelType (any chat)
    // 4. adapterId only (wildcard)
    // 5. no match → return undefined (dead-letter)
    return candidates
      .map(b => ({ binding: b, score: this.scoreMatch(b, chatId, channelType) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      [0]?.binding;
  }

  private scoreMatch(binding: AdapterBinding, chatId?: string, channelType?: string): number {
    let score = 1; // base: adapterId matches (already filtered)
    if (binding.chatId && binding.chatId === chatId) score += 4;
    else if (binding.chatId && binding.chatId !== chatId) return 0; // explicit mismatch
    if (binding.channelType && binding.channelType === channelType) score += 2;
    else if (binding.channelType && binding.channelType !== channelType) return 0;
    return score;
  }

  private async load(): Promise<void> { ... }  // Read JSON, validate with Zod
  private async save(): Promise<void> { ... }  // Atomic write via temp file + rename
  private watch(): void { ... }                // chokidar on bindings.json
  async shutdown(): void { ... }               // Close watcher
}
```

### 6.4 BindingRouter (`packages/relay/src/binding-router.ts`)

Central routing service that intercepts `relay.human.*` messages and resolves bindings.

```typescript
export interface BindingRouterDeps {
  bindingStore: BindingStore;
  relayCore: RelayCore;
  agentManager: AgentManager;
}

export class BindingRouter {
  private sessionMap: Map<string, string> = new Map(); // bindingId:chatId → sessionId
  private sessionMapPath: string; // Persisted to ~/.dork/relay/sessions.json

  constructor(private deps: BindingRouterDeps) {}

  async init(): Promise<void> {
    this.sessionMapPath = path.join(this.deps.relayDir, 'sessions.json');
    await this.loadSessionMap(); // Restore persisted session mappings
    // Subscribe to relay.human.* via RelayCore's signal system
    this.deps.relayCore.on('relay.human.*', this.handleInbound.bind(this));
  }

  private async loadSessionMap(): Promise<void> { /* Read sessions.json if exists */ }
  private async saveSessionMap(): Promise<void> { /* Atomic write sessions.json */ }

  private async handleInbound(envelope: RelayEnvelope): Promise<void> {
    // Extract adapter context from envelope
    const { adapterId, chatId, channelType } = this.parseSubject(envelope.subject);
    if (!adapterId) return;

    // Resolve binding
    const binding = this.deps.bindingStore.resolve(adapterId, chatId, channelType);
    if (!binding) {
      // No binding found — dead-letter the message
      await this.deps.relayCore.deadLetter(envelope, 'no_binding');
      return;
    }

    // Resolve or create session based on strategy
    const sessionId = await this.resolveSession(binding, chatId, envelope);

    // Republish to relay.agent.{sessionId}
    await this.deps.relayCore.publish({
      ...envelope,
      subject: `relay.agent.${sessionId}`,
      metadata: {
        ...envelope.metadata,
        bindingId: binding.id,
        originalSubject: envelope.subject,
      },
    });
  }

  private async resolveSession(
    binding: AdapterBinding,
    chatId: string | undefined,
    envelope: RelayEnvelope
  ): Promise<string> {
    switch (binding.sessionStrategy) {
      case 'stateless':
        // Always create new session
        return this.createSession(binding);

      case 'per-user': {
        const userId = envelope.metadata?.userId ?? chatId ?? 'unknown';
        const key = `${binding.id}:user:${userId}`;
        return this.getOrCreateSession(key, binding);
      }

      case 'per-chat':
      default: {
        const key = `${binding.id}:chat:${chatId ?? 'default'}`;
        return this.getOrCreateSession(key, binding);
      }
    }
  }

  private async getOrCreateSession(key: string, binding: AdapterBinding): Promise<string> {
    const existing = this.sessionMap.get(key);
    if (existing) return existing;
    const sessionId = await this.createSession(binding);
    this.sessionMap.set(key, sessionId);
    await this.saveSessionMap(); // Persist after creating new session mapping
    return sessionId;
  }

  private async createSession(binding: AdapterBinding): Promise<string> {
    // Create session via AgentManager with the binding's agent directory
    const session = await this.deps.agentManager.createSession(binding.agentDir);
    return session.id;
  }

  private parseSubject(subject: string): {
    adapterId?: string;
    chatId?: string;
    channelType?: string;
  } {
    // Pattern: relay.human.{platform}.{chatId}
    const parts = subject.split('.');
    if (parts[0] !== 'relay' || parts[1] !== 'human') return {};
    return {
      adapterId: parts[2], // platform = adapterId prefix
      chatId: parts[3],
      channelType: undefined, // extracted from envelope metadata if present
    };
  }

  async shutdown(): Promise<void> {
    this.sessionMap.clear();
  }
}
```

### 6.5 Bug #70 Fix Verification

The publish pipeline fix (`specs/relay-publish-pipeline-fix/`) ensures adapter delivery is reachable even when no Maildir endpoints match. At `relay-core.ts:308-315`, the early return must be removed so that the adapter delivery path (lines 317+) is always reached.

Phase 1 of this spec verifies this fix is in place. If not yet merged, the fix must be applied before BindingRouter integration.

### 6.6 Server Integration

**`apps/server/src/services/relay/adapter-manager.ts`** — Initialize BindingRouter on startup:

```typescript
// In AdapterManager.init()
this.bindingStore = new BindingStore(this.relayDir);
await this.bindingStore.init();

this.bindingRouter = new BindingRouter({
  bindingStore: this.bindingStore,
  relayCore: this.relayCore,
  agentManager: this.deps.agentManager,
});
await this.bindingRouter.init();
```

**New routes in `apps/server/src/routes/relay.ts`:**

```
GET    /api/relay/bindings          → List all bindings
POST   /api/relay/bindings          → Create binding (validates with CreateBindingRequestSchema)
GET    /api/relay/bindings/:id      → Get single binding
DELETE /api/relay/bindings/:id      → Delete binding
```

### 6.7 Transport Interface Extension

Add to `packages/shared/src/transport.ts` in a new "Relay Bindings" section:

```typescript
// Relay Bindings
getBindings(): Promise<AdapterBinding[]>;
createBinding(input: CreateBindingRequest): Promise<AdapterBinding>;
deleteBinding(id: string): Promise<void>;
```

Implement in all three transports:
- **HttpTransport**: Standard fetch calls to `/api/relay/bindings`
- **DirectTransport**: Direct method calls to BindingStore
- **MockTransport** (test-utils): In-memory array with basic CRUD

### 6.8 MCP Tools

Add to `apps/server/src/services/mcp-tool-server.ts`:

```typescript
tool('binding_list', {}, async () => {
  const bindings = deps.bindingStore?.getAll() ?? [];
  return { content: [{ type: 'text', text: JSON.stringify(bindings, null, 2) }] };
});

tool('binding_create', {
  adapterId: z.string(),
  agentId: z.string(),
  agentDir: z.string(),
  sessionStrategy: SessionStrategySchema.optional(),
  label: z.string().optional(),
}, async (params) => {
  const binding = deps.bindingStore?.create(params);
  return { content: [{ type: 'text', text: JSON.stringify(binding, null, 2) }] };
});

tool('binding_delete', {
  id: z.string(),
}, async (params) => {
  const success = deps.bindingStore?.delete(params.id);
  return { content: [{ type: 'text', text: success ? 'Deleted' : 'Not found' }] };
});
```

### 6.9 Client Entity Layer

New FSD entity at `apps/client/src/layers/entities/binding/`:

```
entities/binding/
├── model/
│   ├── use-bindings.ts       # useQuery for GET /api/relay/bindings
│   ├── use-create-binding.ts # useMutation for POST /api/relay/bindings
│   └── use-delete-binding.ts # useMutation for DELETE /api/relay/bindings/:id
└── index.ts                  # Barrel exports
```

Hooks follow existing TanStack Query patterns from `entities/relay/`:

```typescript
export function useBindings() {
  const transport = useTransport();
  return useQuery({
    queryKey: ['relay', 'bindings'],
    queryFn: () => transport.getBindings(),
    enabled: true,
  });
}

export function useCreateBinding() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBindingRequest) => transport.createBinding(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['relay', 'bindings'] }),
  });
}

export function useDeleteBinding() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => transport.deleteBinding(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['relay', 'bindings'] }),
  });
}
```

### 6.10 TopologyGraph Extension

Extend the existing `TopologyGraph.tsx` in `apps/client/src/layers/features/mesh/ui/` with adapter nodes and binding edges.

**New node type — `AdapterNode`:**

```typescript
// apps/client/src/layers/features/mesh/ui/AdapterNode.tsx
interface AdapterNodeData {
  adapter: RelayAdapter;
  bindings: AdapterBinding[];
  statusColor: string;
  platformIcon: string; // Telegram, Webhook, etc.
}

function AdapterNode({ data, selected }: NodeProps<AdapterNodeData>) {
  return (
    <div className={cn(
      'rounded-xl border bg-card p-4 shadow-soft transition-shadow',
      selected && 'ring-2 ring-primary',
    )}>
      <Handle type="source" position={Position.Right} isConnectable />
      {/* Platform icon + adapter name */}
      {/* Status indicator */}
      {/* Binding count badge */}
    </div>
  );
}
```

**New edge type — `BindingEdge`:**

```typescript
// apps/client/src/layers/features/mesh/ui/BindingEdge.tsx
function BindingEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY });
  return (
    <>
      <BaseEdge id={id} path={edgePath} className="stroke-primary/60 stroke-2" />
      <EdgeLabelRenderer>
        <div style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}
             className="pointer-events-auto rounded-md bg-background/90 px-2 py-1 text-xs shadow-sm">
          {data?.label ?? 'Binding'}
          <button onClick={() => data?.onDelete(id)} className="ml-2 text-destructive">
            <X className="size-3" />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
```

**TopologyGraph changes:**

1. Add `adapter` to `NODE_TYPES` and `binding` to `EDGE_TYPES`
2. Change `nodesConnectable={false}` to `nodesConnectable={true}`
3. Add `isValidConnection` to prevent invalid bindings (adapter→adapter, agent→agent)
4. Add `onConnect` handler that opens a BindingDialog to confirm and configure session strategy
5. ELK layout positions adapters on the left, agents on the right:

```typescript
const elkOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '120',
};

// Adapter nodes get layer constraint = first
// Agent nodes get layer constraint = last
```

6. Add `useBindings()` and `useRelayAdapters()` hooks to data fetching alongside `useTopology()`

**Connection validation:**

```typescript
const isValidConnection = useCallback((connection: Connection) => {
  // Only allow adapter (source) → agent (target) connections
  const sourceNode = nodes.find(n => n.id === connection.source);
  const targetNode = nodes.find(n => n.id === connection.target);
  if (!sourceNode || !targetNode) return false;
  return sourceNode.type === 'adapter' && targetNode.type === 'agent';
}, [nodes]);
```

**BindingDialog** — modal that appears on drag-to-connect, letting user confirm binding and set session strategy, label.

### 6.11 Adapter-to-Node Mapping

Adapters from `useRelayAdapters()` are converted to React Flow nodes:

```typescript
function adapterToNode(adapter: RelayAdapter, index: number): Node<AdapterNodeData> {
  return {
    id: `adapter-${adapter.id}`,
    type: 'adapter',
    position: { x: 0, y: index * (ADAPTER_NODE_HEIGHT + 24) },
    data: {
      adapter,
      bindings: allBindings.filter(b => b.adapterId === adapter.id),
      statusColor: adapter.status === 'running' ? 'green' : 'zinc',
      platformIcon: getPlatformIcon(adapter.type),
    },
  };
}
```

Bindings from `useBindings()` are converted to React Flow edges:

```typescript
function bindingToEdge(binding: AdapterBinding): Edge {
  return {
    id: `binding-${binding.id}`,
    type: 'binding',
    source: `adapter-${binding.adapterId}`,
    target: `agent-${binding.agentId}`,
    data: {
      label: binding.label || binding.sessionStrategy,
      sessionStrategy: binding.sessionStrategy,
      onDelete: handleDeleteBinding,
    },
  };
}
```

## 7. User Experience

### Creating a Binding (Visual)

1. User opens the Mesh panel → Topology tab
2. The canvas shows adapters on the left, agents on the right
3. User drags from an adapter's right handle to an agent's left handle
4. A BindingDialog opens to confirm: session strategy (per-chat/per-user/stateless), optional label
5. On confirm, binding is created and edge appears on the canvas
6. Edge label shows the binding label or session strategy

### Creating a Binding (Dialog)

1. User right-clicks an adapter node → "Create Binding..."
2. A dialog opens with an agent dropdown, session strategy selector, label input
3. On confirm, binding is created and edge appears

### Deleting a Binding

1. User clicks the X button on a binding edge label
2. Confirmation toast appears
3. Edge is removed from canvas

### Agent Self-Service (MCP)

Agents can manage bindings via MCP tools:
- `binding_list` — see all current bindings
- `binding_create` — create a new binding to themselves
- `binding_delete` — remove a binding

## 8. Testing Strategy

### Unit Tests

- **BindingStore**: CRUD operations, resolution scoring, most-specific-first ordering, JSON persistence, edge cases (no bindings, multiple matches, exact vs wildcard)
- **BindingRouter**: Subject parsing, session strategy resolution, dead-letter on no match, republishing with metadata
- **AdapterNode**: Rendering with different adapter states, binding count display
- **BindingEdge**: Rendering with label, delete button click handler

### Integration Tests

- **End-to-end routing**: TelegramAdapter publish → BindingRouter resolve → ClaudeCodeAdapter deliver. Mock AgentManager to verify session creation with correct agent directory.
- **Session strategy**: Verify `per-chat` reuses sessions, `stateless` creates new ones, `per-user` groups by user.
- **Hot-reload**: Modify bindings.json on disk → verify BindingStore picks up changes.

### Mock Strategies

- **BindingStore**: In-memory Map for unit tests (no file I/O)
- **RelayCore**: Mock `publish()` and `on()` to capture routing behavior
- **AgentManager**: Mock `createSession()` to return predictable session IDs
- **Transport**: MockTransport already supports in-memory arrays

## 9. Performance Considerations

- **Binding resolution** is O(n) where n = bindings for a given adapterId. With the expected scale (<100 bindings), this is negligible.
- **Session map** is in-memory, O(1) lookup. Cleared on restart (sessions are re-created on first message).
- **File watching** uses chokidar with debouncing to avoid excessive reloads.
- **ELK layout** is computed once on data change, not on every render. Already optimized in the existing TopologyGraph.

## 10. Security Considerations

- Binding operations require no additional auth (single-user system, consistent with existing adapter/agent CRUD).
- `agentDir` in bindings is validated against the directory boundary (same as session creation).
- Bindings.json file permissions inherit from `~/.dork/relay/` directory.
- MCP tools follow existing patterns (no auth, tools are available to all agent sessions).

## 11. Documentation

- Update `contributing/architecture.md` with BindingRouter in the service inventory
- Add binding methods to `contributing/api-reference.md`
- Update CLAUDE.md services list with BindingStore and BindingRouter descriptions
- Add `entities/binding/` to the FSD layer table in CLAUDE.md

## 12. Implementation Phases

### Phase 1: Foundation (BindingStore + Bug #70 Verification)

1. Verify Bug #70 fix is in place (relay publish pipeline)
2. Add `AdapterBindingSchema`, `SessionStrategySchema`, `CreateBindingRequestSchema` to `relay-schemas.ts`
3. Implement `BindingStore` with JSON persistence, CRUD, resolution logic
4. Unit tests for BindingStore (resolution scoring, CRUD, persistence)

### Phase 2: Core Routing (BindingRouter + Server Integration)

1. Implement `BindingRouter` with inbound interception, resolution, session management, republishing
2. Wire BindingRouter into AdapterManager startup
3. Add HTTP routes: GET/POST/DELETE `/api/relay/bindings`
4. Add Transport interface methods: `getBindings()`, `createBinding()`, `deleteBinding()`
5. Implement in HttpTransport, DirectTransport, MockTransport
6. Add MCP tools: `binding_list`, `binding_create`, `binding_delete`
7. Integration tests for end-to-end routing

### Phase 3: Visual Configuration (TopologyGraph Extension)

1. Create `AdapterNode` component (platform icon, status, binding count)
2. Create `BindingEdge` component (label, delete button)
3. Create `BindingDialog` for connection configuration (strategy, label)
4. Extend `TopologyGraph` with adapter nodes, binding edges, connection validation
5. Create `entities/binding/` FSD entity with hooks
6. Update ELK layout to position adapters left, agents right
7. Component tests for AdapterNode, BindingEdge

### Phase 4: Polish

1. Add binding count badges to adapter nodes
2. Edge case handling: orphaned bindings (adapter deleted), stale sessions
3. Empty state for topology (no adapters configured)
4. Documentation updates

## 13. Open Questions

1. ~~**Session persistence across restarts**~~ (RESOLVED)
   **Answer:** Persist to disk — save session map to JSON file alongside bindings.json so sessions survive restarts.
   **Rationale:** Avoids creating orphan sessions on every restart. Session map is small and follows the same JSON persistence pattern as bindings.json.

   Original context preserved:
   - Option A: In-memory only (sessions re-created after restart)
   - Option B: Persist to disk (JSON file alongside bindings.json)
   - Recommendation was in-memory, but user chose persistence for better UX

2. ~~**Binding conflict detection**~~ (RESOLVED)
   **Answer:** Allow overlapping bindings with a warning in the UI.
   **Rationale:** The most-specific-first scoring system is deterministic and predictable. A UI warning gives users visibility without blocking flexibility.

   Original context preserved:
   - Option A: Allow with warning (show UI warning on overlap)
   - Option B: Prevent overlapping bindings (strict validation)
   - Recommendation: Option A

3. ~~**Adapter type in subject resolution**~~ (RESOLVED)
   **Answer:** Use `adapterId` directly in the subject pattern (`relay.human.{adapterId}.{chatId}`).
   **Rationale:** Adapters already have unique IDs from the adapter registry. Simple 1:1 mapping with no additional numbering scheme needed.

   Original context preserved:
   - Option A: Use adapterId directly
   - Option B: Use adapter type + instance index
   - Recommendation: Option A

## 14. Related ADRs

- **ADR #29**: ClaudeCodeAdapter as relay participant
- **ADR #30**: Dynamic adapter plugin system
- **ADR #32**: Namespace derivation from agent directory
- **ADR #33**: Default-deny cross-namespace communication
- **ADR #35**: @xyflow/react for topology visualization
- **ADR #37**: Relay signals for mesh lifecycle events

## 15. References

- [React Flow v12 Documentation](https://reactflow.dev/api-reference)
- [React Flow Custom Nodes](https://reactflow.dev/learn/customization/custom-nodes)
- [React Flow Custom Edges](https://reactflow.dev/learn/customization/custom-edges)
- `specs/relay-publish-pipeline-fix/02-specification.md` — Bug #70 fix (prerequisite)
- `specs/adapter-catalog-management/02-specification.md` — Adapter catalog system
- `specs/mesh-network-topology/02-specification.md` — TopologyGraph foundation
- `specs/agents-first-class-entity/02-specification.md` — Agent identity system
