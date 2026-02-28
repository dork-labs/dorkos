# Research: Adapter-Agent Routing — Visual Binding System

**Date**: 2026-02-28
**Feature slug**: adapter-agent-routing
**Research depth**: Deep Research
**Searches performed**: 14

---

## Research Summary

The goal is to design a system that binds external communication adapters (Telegram bots,
Slack, Discord, Webhooks) to specific agents, with a visual topology/graph UI for
configuration. DorkOS already has a strong adapter foundation in `packages/relay` and
`apps/server/src/services/relay/adapter-manager.ts`. The missing piece is:
(a) a routing table that maps adapter instances → specific agents rather than routing by
subject prefix alone, and (b) a visual wiring board UI to configure those bindings.

The research confirms that DorkOS's existing subject-prefix routing can be augmented with
an explicit binding table, using a React Flow canvas (already aligned with the project's
shadcn/ui + Tailwind 4 stack) for configuration. The OpenClaw open-source project provides
the most directly comparable architecture and is a rich reference implementation.

---

## Key Findings

### 1. Routing Architecture: Explicit Binding Table is the Right Model

**Finding**: The industry pattern for multi-adapter, multi-agent routing splits into three
distinct approaches — and explicit binding tables are best for the DorkOS use case.

- **Subject-prefix routing** (current DorkOS approach): Adapters declare a `subjectPrefix`
  string and the `AdapterRegistry.getBySubject()` method does a `startsWith()` scan. This
  works for single-agent setups but provides no way to route a given adapter's messages to
  a *specific* agent — all Telegram inbound messages fan to the same `relay.human.telegram.*`
  subject regardless of which agent should handle them.

- **Rules engine routing** (n8n, Zapier, Node-RED): Switch/branch nodes apply conditional
  logic to classify messages and route them dynamically. Powerful but complex; adds
  orchestration overhead. Ideal for complex pipelines, overkill for 1:1 channel-to-agent binding.

- **Explicit binding table** (OpenClaw, Microsoft Bot Framework, Botpress): A persisted
  mapping of `{ adapterId, accountId, agentId }` tuples evaluated at message ingress.
  Deterministic, auditable, and visually representable. This is the correct model for
  DorkOS's use case.

OpenClaw's binding model is the closest reference implementation: bindings are evaluated
most-specific-first (exact peer > parent peer > guild > account > channel fallback),
stored in JSON config, and support `accountId: "*"` wildcards for channel-wide fallbacks.

### 2. The Gap in Current DorkOS Architecture

**Finding**: DorkOS's current architecture has adapters delivering to `relay.agent.{sessionId}`
subjects, but the session-to-agent mapping goes through `AgentManager` which creates or
resumes sessions by CWD. There is no concept of "this Telegram adapter should route to
Agent X specifically".

Current flow:
```
Telegram inbound → TelegramAdapter.start() publishes to relay.human.telegram.{chatId}
                 → ClaudeCodeAdapter handles relay.agent.* subjects only
                 → No routing from relay.human.telegram.* to a specific agent
```

What needs to happen:
```
Telegram inbound → BindingRouter looks up { adapterId: 'telegram-bot-a', chatId }
                 → Resolves to agentId 'agent-xyz' via binding table
                 → Publishes to relay.agent.{agentId-session} with agent context
                 → ClaudeCodeAdapter handles delivery to that specific agent session
```

The binding table bridges the inbound side (`relay.human.*`) to the outbound agent side
(`relay.agent.*`). The `AdapterContext.agent` field already exists for passing agent
directory/runtime info through to the ClaudeCodeAdapter — but it's currently populated
only from the Mesh registry, not from bindings.

### 3. React Flow is the Right UI Foundation

**Finding**: React Flow (xyflow) is the dominant library for visual wiring/topology UIs in
React, with native shadcn/ui integration via "React Flow UI" (renamed from React Flow
Components in 2025). It is already architecturally aligned with DorkOS's stack
(React 19, Vite 6, Tailwind 4, shadcn/ui, Zustand).

Key capabilities relevant to the routing UI:
- Custom nodes are plain React components — adapter nodes and agent nodes can be styled
  with the existing DorkOS design system
- `Handle` components define connection points; validation callbacks can enforce the
  rule that only adapter handles connect to agent handles (not adapter-to-adapter)
- `onConnect` callback fires when the user draws an edge — this is where the binding
  is persisted via mutation
- The React Flow Pro "AI Workflow Editor" template uses shadcn/ui + Zustand + Vercel AI
  SDK, which matches DorkOS's existing Zustand store pattern and shadcn primitives
- Easy Connect pattern: making the entire node a draggable handle reduces connection
  friction significantly for a wiring-board metaphor
- Zustand store for node/edge state is the recommended pattern; this aligns with
  `app-store.ts` already in use

The `@xyflow/react` npm package is the correct import path (rebranded from `reactflow`).

### 4. Session Mapping Strategy for Inbound Messages

**Finding**: OpenClaw's session key structure is the best reference for how to map
inbound external messages to agent sessions.

OpenClaw's key: `agent:{agentId}:{provider}:{chatId}` (DMs) or
`agent:{agentId}:{provider}:group:{groupId}:topic:{threadId}` (groups/threads)

DorkOS equivalent recommendation:
```
relay.agent.{agentId}.telegram.{chatId}        (DM session)
relay.agent.{agentId}.telegram.group.{chatId}  (group session)
relay.agent.{agentId}.slack.{channelId}
relay.agent.{agentId}.webhook.{bindingId}
```

This allows the ClaudeCodeAdapter to derive the CWD/session from the binding record
(looked up by `agentId`) rather than from the subject alone. The `conversationId` field
in `StandardPayload` already exists and can carry the `chatId` for reply routing.

Three session strategies exist for external channels; each has different UX tradeoffs:

| Strategy | Behavior | Best for |
|---|---|---|
| Per-chat session | One conversation thread per chat ID | Persistent personal bots |
| Per-user session | One thread per user across chats | Support bot with user context |
| Stateless session | Fresh context each message | Q&A bots, command dispatchers |

Recommendation: default to per-chat sessions (most intuitive), expose as a binding-level
setting so operators can choose per binding.

### 5. Multi-Instance Adapter Management

**Finding**: `AdapterManager` already supports `multiInstance: true|false` per adapter
type (declared in the `AdapterManifest`). Telegram currently allows multiple instances,
but the routing from a given instance to a specific agent is not implemented.

OpenClaw's approach is instructive: each account entry gets a stable `id` field, and
bindings reference that `accountId`. The same pattern maps cleanly to DorkOS:
each `AdapterConfig.id` is the stable reference used in binding records.

For lifecycle management per instance:
- Individual start/stop is already implemented via `AdapterManager.enable(id)` and
  `disable(id)` — these persist changes and reconcile the registry
- Health per instance is surfaced via `AdapterStatus` returned by `getStatus()` on each
  `RelayAdapter`
- Hot-reload is implemented via chokidar file watcher on `adapters.json`

The existing architecture handles this well. No changes needed to lifecycle management.

### 6. Security Model for Adapter-Agent Bindings

**Finding**: Bindings introduce a new security surface — the authorization question
"who can bind which adapter to which agent?" needs a clear answer, and credential
management for multiple bot tokens needs to be hardened.

**Credential storage (current)**: Bot tokens are stored in plain JSON at
`~/.dork/relay/adapters.json`. The `maskSensitiveFields()` method in `AdapterManager`
masks password-type fields in API responses (returns `***`), and
`mergeWithPasswordPreservation()` prevents accidental erasure. This is adequate for
single-user local CLI use, but not production multi-user deployments.

**Security recommendations**:
- Short-term (local use): current masking approach is adequate
- Medium-term: encrypt sensitive fields at rest using a derived key from a
  machine-specific secret (similar to macOS Keychain integration)
- For webhook adapters: HMAC-SHA256 signature verification is already implemented in
  `WebhookAdapterConfig.inbound.secret`; enforce timestamp window of ±5 minutes to
  prevent replay attacks
- For Telegram: tokens stored with `password` field type → masked in API responses
- Binding audit log: every binding create/update/delete should be appended to
  `~/.dork/relay/binding-audit.jsonl` with timestamp, user, and change details
- Rate limiting: `RateLimitConfig` already exists in `relay-schemas.ts` and
  `rate-limiter.ts` — wire per-binding rate limits into the routing layer
- Authorization for binding changes: since DorkOS is single-user CLI, the server process
  ownership (OS-level) is the authorization boundary; no additional auth needed
  for the MVP

**Webhook security checklist**:
- HMAC signature verification (already implemented)
- Timestamp anti-replay window (needs implementation)
- IP allowlisting per binding (future)
- Retry de-duplication via message ID (already handled by Maildir store)

---

## Detailed Analysis

### The Binding Table Data Model

A new schema needs to be added to `packages/shared/src/relay-schemas.ts`:

```typescript
// Binding: maps an adapter instance + optional chat filter → a specific agent
export const AdapterBindingSchema = z.object({
  id: z.string().ulid(),               // Stable binding ID
  adapterId: z.string(),               // References AdapterConfig.id
  agentId: z.string(),                 // References agent manifest ID
  agentDir: z.string().optional(),     // Agent working directory (resolved from Mesh or static)
  // Optional narrowing filters (all must match for binding to apply):
  chatId: z.string().optional(),       // Exact chat/channel ID (Telegram, Slack, etc.)
  channelType: ChannelTypeSchema.optional(), // 'dm' | 'group' | 'channel' | 'thread'
  sessionStrategy: z.enum(['per-chat', 'per-user', 'stateless']).default('per-chat'),
  // Reliability overrides:
  rateLimit: RateLimitConfigSchema.partial().optional(),
  // Metadata:
  label: z.string().optional(),        // Human label shown in topology UI
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type AdapterBinding = z.infer<typeof AdapterBindingSchema>;
```

Bindings are stored in `~/.dork/relay/bindings.json` (separate from `adapters.json` to
maintain clean separation of concerns). A `BindingStore` service (analogous to `PulseStore`)
manages CRUD and persistence.

### The Routing Layer

A `BindingRouter` (new service in `apps/server/src/services/relay/`) intercepts inbound
messages from external adapters before they enter the relay subject hierarchy:

```
TelegramAdapter receives message from chatId=12345
  → calls relay.publish('relay.human.telegram.12345', payload, { from: 'adapter:telegram-bot-a' })
  → BindingRouter.onMessage() intercepts (subscribed to 'relay.human.*')
  → BindingRouter.resolve('telegram-bot-a', { chatId: '12345', channelType: 'dm' })
    → finds binding: { adapterId: 'telegram-bot-a', agentId: 'my-agent', agentDir: '/Users/x/project' }
  → BindingRouter republishes to 'relay.agent.my-agent.telegram.12345'
     with AdapterContext.agent = { directory: '/Users/x/project', runtime: 'claude-code' }
  → ClaudeCodeAdapter receives it and routes to the right AgentManager session
```

Binding resolution order (most-specific wins, same as OpenClaw):
1. adapterId + chatId + channelType
2. adapterId + chatId
3. adapterId + channelType
4. adapterId (wildcard — all messages from this adapter)
5. No match → dead-letter or configurable fallback behavior

### Visual Topology UI Design

The topology view should render two columns of nodes connected by animated edges:

```
┌─────────────────────────────────────────────────────────┐
│                  ADAPTER-AGENT ROUTING                   │
├────────────────────────┬────────────────────────────────┤
│  ADAPTERS              │  AGENTS                         │
│                        │                                 │
│ ┌──────────────┐       │  ┌──────────────┐              │
│ │ 🤖 Bot A     │───────┼─▶│ 🏗 Builder   │              │
│ │ Telegram     │       │  │ /projects/a  │              │
│ │ ● connected  │       │  └──────────────┘              │
│ └──────────────┘       │                                 │
│                        │  ┌──────────────┐              │
│ ┌──────────────┐       │  │ 📚 Architect │              │
│ │ 🔗 GitHub    │───────┼─▶│ /projects/b  │              │
│ │ Webhook      │       │  └──────────────┘              │
│ │ ● connected  │       │                                 │
│ └──────────────┘       │                                 │
│                        │                                 │
│ ┌──────────────┐       │                                 │
│ │ 💬 Bot B     │  drag │                                 │
│ │ Telegram     │──────▶│  (drop on agent to bind)       │
│ │ ● connected  │       │                                 │
│ └──────────────┘       │                                 │
│                        │                                 │
│  [+ Add Adapter]       │  [+ Add Agent]                  │
└────────────────────────┴────────────────────────────────┘
```

**Node types**:

1. `AdapterNode` — left column. Shows: platform icon, adapter ID, status dot
   (green/red/gray), message count, platform-specific badge (Telegram, Webhook, Slack).
   Source handle on the right edge.

2. `AgentNode` — right column. Shows: agent icon (from mesh manifest), agent name,
   working directory (truncated), session count. Target handle on the left edge.

3. `BindingEdge` — animated dashed line when active (messages flowing), solid when
   idle. Edge label shows session strategy badge. Click to open binding detail/edit.

**Interaction design**:

- Drag from an adapter node's output handle onto an agent node to create a binding
- Delete key on selected edge removes the binding (with confirmation if sessions exist)
- Click an edge to open a sidebar with binding details (rate limit, session strategy,
  chat filters, recent message count)
- Double-click an adapter node to open the existing `AdapterSetupWizard`
- The canvas uses auto-layout by default (dagre or elkjs for left-to-right flow);
  users can drag to override, positions persist in binding record metadata
- Empty state: show a "Connect your first adapter" empty illustration with a call to
  action button

**Progressive disclosure**:
- Level 1 (default): Simple view — adapters on left, agents on right, drag to connect
- Level 2 (click edge): Binding details — session strategy, message count, last activity
- Level 3 (edge settings panel): Rate limits, chat filters, advanced routing rules
- Never surface Level 3 until Level 1 works perfectly

### Adapter Node Card Design

Each adapter node should function as a status card integrated into the graph canvas:

```
┌──────────────────────────────┐
│ ⬤  Telegram Bot A            │
│ ● 3 active · 142 msgs today  │
│ Token: ●●●●●3a7f             │
│ [Test] [Configure] [Disable] │
└──────────────────────────────┘───▶
```

The three inline action buttons prevent the need to context-switch away from the canvas
for common operations. Status dot color:
- Green = connected
- Amber = starting / stopping
- Red = error (show last error on hover)
- Gray = disabled

### FSD Layer Placement

Following DorkOS's Feature-Sliced Design:

```
apps/client/src/layers/
├── entities/binding/                 # NEW: binding domain
│   ├── model/
│   │   ├── use-bindings.ts          # TanStack Query: GET /api/relay/bindings
│   │   ├── use-create-binding.ts    # Mutation: POST /api/relay/bindings
│   │   ├── use-delete-binding.ts    # Mutation: DELETE /api/relay/bindings/:id
│   │   └── use-update-binding.ts    # Mutation: PATCH /api/relay/bindings/:id
│   └── index.ts
├── features/routing/                 # NEW: topology graph feature
│   ├── ui/
│   │   ├── RoutingTopology.tsx      # Root React Flow canvas
│   │   ├── AdapterNode.tsx          # Custom node component
│   │   ├── AgentNode.tsx            # Custom node component
│   │   ├── BindingEdge.tsx          # Custom edge component
│   │   ├── BindingDetailPanel.tsx   # Slide-over for edge details
│   │   ├── EmptyTopologyState.tsx   # Empty state illustration
│   │   └── __tests__/
│   ├── model/
│   │   └── use-topology-state.ts    # Zustand slice for canvas node positions
│   └── index.ts
```

`RoutingTopology` is added as a new tab in the `RelayPanel` sidebar, alongside the
existing Activity Feed, Inbox, and Adapters tabs.

---

## Potential Solutions

### Option A: Binding Table + Subject Rewrite (Recommended)

**Architecture**: Add a `BindingStore` + `BindingRouter` to the relay pipeline. The router
subscribes to `relay.human.*` subjects, resolves the binding table, and republishes to
`relay.agent.{agentId}.*` subjects with enriched `AdapterContext`. The visual topology UI
manages bindings via REST CRUD endpoints on `/api/relay/bindings`.

**Pros**:
- Minimal disruption to existing adapter architecture
- Deterministic, auditable — bindings are a stable JSON file on disk
- Works cleanly with existing Mesh agent registry for agent discovery
- Subject rewrite means existing monitoring/tracing tools see correct routing
- Easy to extend (add Discord adapter, it just needs a binding)

**Cons**:
- Adds a new hop in the message pipeline (subscribe → rewrite → republish)
- Binding resolution adds ~1ms latency per message (in-memory lookup, negligible)
- Two-phase delivery (inbound subject → binding lookup → agent subject) slightly
  complicates tracing spans

### Option B: Adapter-Level Agent Injection

**Architecture**: Pass `agentId` as part of `AdapterConfig` (e.g., `config.agentId`).
Each adapter instance is bound to one agent at config time. The TelegramAdapter reads
`this.config.agentId` and publishes directly to `relay.agent.{agentId}.*`.

**Pros**:
- Simpler — no separate binding layer
- Zero-latency resolution (baked into adapter startup)

**Cons**:
- Breaks the clean separation between transport (adapter) and routing (binding)
- Harder to rebind at runtime without restarting the adapter
- Does not support 1-adapter-to-multiple-agents-by-chat-filter scenarios
- Harder to visualize in topology UI (binding is buried in adapter config)

### Option C: Relay Routing Rules Engine

**Architecture**: Implement a full routing rules engine with condition/action pairs
(like n8n's Switch node). Rules evaluated in priority order per message.

**Pros**:
- Maximum flexibility — supports complex multi-hop routing, content-based routing
- Future-proof for advanced use cases

**Cons**:
- Significant scope increase — essentially implementing a mini-workflow engine
- Visual configuration becomes much more complex (not a simple wiring board)
- Overkill for the 1:1 binding requirement stated in the feature brief

---

## Security Considerations

### Token/Credential Management

- All bot tokens stored in `adapters.json` under `~/.dork/relay/` with `0600` permissions
- `AdapterManager.maskSensitiveFields()` already prevents token exposure in API responses
- `mergeWithPasswordPreservation()` prevents accidental token erasure during config updates
- Enhancement needed: encrypt tokens at rest using AES-256-GCM with a key derived from
  a machine-specific secret stored in `~/.dork/.keyring` (chmod 600)
- Never log token values — existing logger patterns are safe but add explicit scrubbing

### Binding Authorization

- Single-user local tool: OS process ownership is sufficient authorization
- All binding mutations should be recorded in `~/.dork/relay/binding-audit.jsonl`
- Audit record: `{ ts, action: 'create'|'update'|'delete', bindingId, adapterId, agentId, userId: process.env.USER }`

### Webhook Security

- HMAC-SHA256 signature verification already implemented in `WebhookAdapter`
- Add timestamp anti-replay: reject webhooks with `X-Timestamp` older than 5 minutes
- Previous secret rotation (`previousSecret` field already exists) — support 24h grace window
- Per-binding rate limiting using existing `RateLimiter` service

### Agent Isolation

- Each agent binding creates sessions scoped to `agentId + chatId` to prevent cross-agent
  conversation bleed
- A message from Telegram bot A should never route to an agent bound to Telegram bot B

---

## Performance Considerations

### Binding Resolution

- In-memory binding index (Map keyed by `adapterId`) for O(1) adapter lookup
- Within an adapter's bindings, most-specific-first ordered list for linear scan
  (typically 1-5 bindings per adapter — negligible)
- Binding changes hot-reload the in-memory index (same chokidar pattern as adapters.json)

### React Flow Canvas

- Node count is small (< 20 adapters, < 20 agents) — React Flow handles thousands
- Use `useMemo` for `nodeTypes` and `edgeTypes` to prevent re-render storms
- Persist canvas positions in binding metadata, not in React state, to survive page reloads
- Animate edges with CSS `stroke-dashoffset` transitions rather than JS animation loops

### Session Resolution

- Session keys are string-based — use a `Map<string, AgentSession>` in AgentManager
  indexed by the binding-scoped session key
- Session TTL should be configurable per binding (default: match existing 30-minute timeout)

---

## Recommendation

**Implement Option A (Binding Table + Subject Rewrite)** with the following phased rollout:

### Phase 1: Data Model + API (backend only)
1. Add `AdapterBindingSchema` to `packages/shared/src/relay-schemas.ts`
2. Create `BindingStore` service at `apps/server/src/services/relay/binding-store.ts`
   (SQLite-backed, same pattern as PulseStore)
3. Create `BindingRouter` at `apps/server/src/services/relay/binding-router.ts`
   (subscribes to `relay.human.*`, resolves, republishes)
4. Add CRUD endpoints at `/api/relay/bindings` in `apps/server/src/routes/relay.ts`
5. Wire `BindingRouter` into server startup sequence after `RelayCore` and `AdapterManager`

### Phase 2: MCP Tool + CLI discoverability
6. Add `relay_create_binding`, `relay_list_bindings`, `relay_delete_binding` MCP tools
   to `mcp-tool-server.ts` so agents can configure their own bindings

### Phase 3: Visual Topology UI
7. Add `entities/binding/` domain layer (TanStack Query hooks)
8. Add `features/routing/` with React Flow canvas
9. Integrate as a new tab in `RelayPanel`
10. Add `@xyflow/react` to `apps/client/package.json`

### Phase 4: Polish
11. Animated edge state (active message flow visualization)
12. Empty state onboarding illustration
13. Binding audit log viewer in the topology sidebar
14. Per-binding rate limit configuration in the settings panel

**Rationale**: This approach threads the needle between simplicity and power. The binding
table is the industry-standard solution (used by OpenClaw, Microsoft Bot Framework,
Botpress). The visual wiring board metaphor is immediately intuitive — operators see
exactly what connects to what. React Flow + shadcn/ui delivers a world-class visual
experience without a heavy third-party dependency. And the phased rollout means Phase 1
delivers immediate value (programmatic binding) while Phase 3 delivers the magic.

---

## Research Gaps and Limitations

- No direct research on Slack's multi-workspace bot token model — likely similar to
  Telegram's multi-bot token approach but needs verification before adding Slack adapter
- Discord adapter not yet in DorkOS — needs a library evaluation (`discord.js` vs.
  `Eris` vs. `discordeno`) before implementation
- The React Flow Pro AI Workflow Editor template requires a paid subscription; the free
  tier examples at reactflow.dev/examples are sufficient for DorkOS's use case
- No research on mobile PWA behavior for the topology canvas — pinch-to-zoom handling
  on iOS may need attention

## Contradictions and Disputes

- n8n/Node-RED use rules-engine routing (Option C), which is more flexible but more
  complex. The DorkOS feature brief explicitly calls for 1:1 binding, making Option A
  the more appropriate choice despite being less flexible.
- React Flow's `nodeTypes` must be defined outside the React tree (or memoized) to avoid
  re-renders — several community tutorials show it incorrectly defined inside components.
  The official docs are authoritative here.

---

## Sources and Evidence

- OpenClaw multi-agent routing architecture: [Multi-Agent Routing - OpenClaw](https://docs.openclaw.ai/concepts/multi-agent)
- OpenClaw channel routing and access control: [Channel Routing - OpenClaw DeepWiki](https://deepwiki.com/openclaw/openclaw/8.1-channel-routing-and-access-control)
- React Flow official docs and examples: [Node-Based UIs in React - React Flow](https://reactflow.dev/)
- React Flow custom nodes documentation: [Custom Nodes - React Flow](https://reactflow.dev/learn/customization/custom-nodes)
- React Flow + shadcn/ui integration blog: [Introducing React Flow UI - xyflow](https://xyflow.com/blog/react-flow-components)
- React Flow AI Workflow Editor template: [AI Workflow Editor - React Flow](https://reactflow.dev/ui/templates/ai-workflow-editor)
- n8n multi-channel chatbot architecture: [Build a Multi-Channel Chatbot with n8n](https://medium.com/@bhagyarana80/build-a-multi-channel-chatbot-with-n8n-ai-99ff6e8428af)
- Graph visualization UX best practices: [Create Meaningful UX in Graph Visualization](https://cambridge-intelligence.com/graph-visualization-ux-how-to-avoid-wrecking-your-graph-visualization/)
- Drag and drop UX design patterns: [Designing drag and drop UIs - LogRocket](https://blog.logrocket.com/ux-design/drag-and-drop-ui-examples/)
- Secrets management best practices: [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- Webhook security best practices: [Webhook Security Best Practices - WebhookDebugger](https://www.webhookdebugger.com/blog/webhook-security-best-practices)
- Microsoft Bot Framework channel adapters: [Bot Framework Architecture - Microsoft Learn](https://learn.microsoft.com/en-us/azure/bot-service/bot-builder-basics?view=azure-bot-service-4.0)
- Multi-bot Telegram instance management: [MultiBot-Telegram](https://fozan.gitbook.io/multibot-telegram)

## Search Methodology

- Searches performed: 14
- Most productive search terms: "openclaw multi-agent", "React Flow xyflow shadcn 2025",
  "binding table adapter routing agent", "OpenClaw channel routing access control"
- Primary information sources: reactflow.dev, docs.openclaw.ai, deepwiki.com,
  DorkOS source code (packages/relay, apps/server/src/services/relay)
- Existing DorkOS code was the most informative source — the architecture is already
  80% of the way there
