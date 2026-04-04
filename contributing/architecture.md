# DorkOS Architecture

## Overview

The DorkOS uses a hexagonal (ports & adapters) architecture centered on a **Transport** abstraction layer. This enables the same React client to run in two modes:

1. **Standalone web** -- Express server + HTTP/SSE via `HttpTransport`
2. **Obsidian plugin** -- In-process services via `DirectTransport`, no server needed

## Core Abstraction: Transport Interface

The `Transport` interface (`packages/shared/src/transport.ts`) defines all client-server communication methods organized into logical groups:

```
Transport
  -- Session Management --
  createSession(opts)            -> Session
  listSessions(cwd?)             -> Session[]
  getSession(id, cwd?)           -> Session
  updateSession(id, opts, cwd?)  -> Session
  getMessages(sessionId, cwd?)   -> { messages: HistoryMessage[] }
  sendMessage(id, content, onEvent, signal?, cwd?, options?) -> void
                                          # options: { clientMessageId?, uiState? }
  approveTool(sessionId, toolCallId)  -> { ok: boolean }
  denyTool(sessionId, toolCallId)     -> { ok: boolean }
  submitAnswers(sessionId, toolCallId, answers) -> { ok: boolean }
  stopTask(sessionId, taskId)         -> { success: boolean, taskId: string }
  interruptSession(sessionId)         -> { ok: boolean }
  getTasks(sessionId, cwd?)           -> { tasks: TaskItem[] }
  getLastMessageIds(sessionId)        -> { user: string, assistant: string } | null

  -- Server / Config --
  health()                   -> HealthResponse
  getConfig()                -> ServerConfig
  updateConfig(patch)        -> void
  getModels()                -> ModelOption[]
  getSubagents()             -> SubagentInfo[]
  getCapabilities()          -> { capabilities: Record<string, RuntimeCapabilities>, defaultRuntime: string }
  startTunnel()              -> { url: string }
  stopTunnel()               -> void
  browseDirectory(path?, showHidden?) -> BrowseDirectoryResponse
  getDefaultCwd()            -> { path: string }
  getCommands(refresh?, cwd?) -> CommandRegistry
  listFiles(cwd)             -> FileListResponse
  getGitStatus(cwd?)         -> GitStatusResponse | GitStatusError

  -- Tasks Scheduler --
  listSchedules / createSchedule / updateSchedule / deleteSchedule
  triggerSchedule / listRuns / getRun / cancelRun

  -- Relay Message Bus --
  listRelayMessages / getRelayMessage / sendRelayMessage
  listRelayEndpoints / registerRelayEndpoint / unregisterRelayEndpoint
  readRelayInbox / getRelayMetrics / listRelayDeadLetters / listRelayConversations
  sendMessageRelay / getRelayTrace / getRelayDeliveryMetrics
  -- Note: sendMessageRelay is available for external adapter integration only.
  -- The web client always uses sendMessage (direct SSE streaming).

  -- Relay Adapters --
  listRelayAdapters / toggleRelayAdapter / getAdapterCatalog
  addRelayAdapter / removeRelayAdapter / updateRelayAdapterConfig / testRelayAdapterConnection

  -- Relay Adapter Events --
  getAdapterEvents(adapterId, limit?)

  -- Relay Bindings --
  getBindings / createBinding / deleteBinding / updateBinding

  -- Mesh Agent Discovery --
  discoverMeshAgents / listMeshAgents / getMeshAgent
  registerMeshAgent / updateMeshAgent / unregisterMeshAgent
  denyMeshAgent / listDeniedMeshAgents / clearMeshDenial

  -- Mesh Observability --
  getMeshStatus / getMeshAgentHealth / sendMeshHeartbeat

  -- Mesh Topology --
  getMeshTopology / updateMeshAccessRule / getMeshAgentAccess

  -- File Uploads --
  uploadFiles(files, cwd, onProgress?) -> UploadResult[]

  -- Agent Identity --
  getAgentByPath(cwd)        -> AgentManifest | null
  initAgent(cwd, name?, description?, runtime?) -> AgentManifest
  updateAgentByPath(cwd, updates) -> AgentManifest
  resolveAgents(paths)       -> Record<string, AgentManifest | null>
```

### Key Design Decision: Callback-Based Streaming

`sendMessage` uses `onEvent: (event: StreamEvent) => void` callbacks rather than returning an `AsyncGenerator`. An optional `cwd` parameter is passed through so the SDK uses the correct project directory when resuming sessions. An optional `options` bag supports `clientMessageId` for server-echo ID reconciliation and `uiState` for passing a client UI state snapshot to the agent (see [Agent UI Control](#agent-ui-control)). This normalizes both transports:

- **HttpTransport** parses SSE events from a `ReadableStream` and calls `onEvent`
- **DirectTransport** iterates the `AsyncGenerator` from the runtime and calls `onEvent`

### File Uploads

`uploadFiles` uses a different pattern per transport:

- **HttpTransport** sends files via XHR (`XMLHttpRequest`) with `FormData` to `POST /api/uploads?cwd=...`. XHR is used instead of `fetch()` because it supports `upload.onprogress` events for real-time progress reporting.
- **DirectTransport** copies files directly to `{cwd}/.dork/.temp/uploads/` using Node.js `fs` — no HTTP, no serialization.

The `UploadFile` interface (`packages/shared/src/transport.ts`) abstracts over the browser `File` API so the shared package stays free of DOM lib dependencies.

Consumers (hooks, components) see the same interface regardless of transport.

## Dependency Injection

Transport is injected via React Context:

```
TransportContext.tsx
  TransportProvider  -- wraps app root, provides a Transport instance
  useTransport()     -- hook to consume the Transport
```

### Standalone Web (`main.tsx`)

```
HttpTransport({ baseUrl: '/api' })
  -> TransportProvider
    -> RouterProvider (TanStack Router)
      -> AppShell (layout route with <Outlet>)
        -> DashboardPage (/) or SessionPage (/session)
```

**Client routing** (`router.tsx`): TanStack Router with code-based routes. A pathless `_shell` layout route renders `AppShell` (sidebar, header, dialogs). Child routes render into `<Outlet>`:

| Path       | Component                   | Search Params                        |
| ---------- | --------------------------- | ------------------------------------ |
| `/`        | `DashboardPage`             | —                                    |
| `/session` | `SessionPage` → `ChatPanel` | `?session=`, `?dir=` (Zod-validated) |

Each route provides its own sidebar and header content via private slot hooks in `AppShell` (`useSidebarSlot` / `useHeaderSlot`). The sidebar body and header cross-fade on route change via `AnimatePresence`. `/` renders `DashboardSidebar` + `DashboardHeader`; `/session` renders `SessionSidebar` + `SessionHeader`.

Search params use `@tanstack/zod-adapter` with `zodValidator()`. Hooks `useSessionId()` and `useDirectoryState()` read/write via `useSearch`/`useNavigate` internally, preserving their public API.

### Obsidian Plugin (`CopilotView.tsx`)

```
// Vault path = workspace/, repo root = its parent (where .claude/ lives)
repoRoot = path.resolve(vaultPath, '..')

ClaudeCodeRuntime(repoRoot)     -- resolves Claude CLI, sets cwd
TranscriptReader()              -- reads JSONL from ~/.claude/projects/{slug}/
CommandRegistryService(repoRoot) -- scans repoRoot/.claude/commands/

DirectTransport({ runtime, transcriptReader, commandRegistry, vaultRoot: repoRoot })
  -> TransportProvider
    -> ObsidianApp -> App
```

## Transport Implementations

### HttpTransport (`apps/client/src/layers/shared/lib/transport/http-transport.ts`)

Communicates with the Express server over HTTP and SSE:

- Standard `fetch()` for CRUD operations
- `POST + ReadableStream` for SSE streaming in `sendMessage`
- Parses `text/event-stream` lines into `StreamEvent` objects
- `uploadFiles` uses XHR with `FormData` for progress tracking
- Constructor takes `baseUrl` (defaults to `/api`)

Domain-specific methods (Relay, Tasks, Mesh) are delegated to factory-produced objects to keep concerns separated:

- `createRelayMethods(baseUrl, getClientId)` — Relay bus, adapters, bindings, events
- `createTasksMethods(baseUrl)` — Tasks schedules and runs
- `createMeshMethods(baseUrl)` — Mesh discovery, registry, topology

HttpTransport uses `Object.assign(this, createRelayMethods(...))` at construction time. Each factory lives in its own file under `transport/` and handles HTTP serialization for its domain. This keeps the Transport interface unified while allowing independent testability of domain methods.

### DirectTransport (`apps/client/src/layers/shared/lib/direct-transport.ts`)

Calls service instances directly in the same process:

- No HTTP, no port binding, no serialization
- Uses `DirectTransportServices` interface (narrow typed subset of service methods)
- `sendMessage` iterates `AsyncGenerator<StreamEvent>` from the runtime
- `uploadFiles` copies files to disk via Node.js `fs` (no HTTP)
- `createSession` generates UUIDs via `crypto.randomUUID()`
- Respects `AbortSignal` for cancellation

**Scope limitation:** DirectTransport currently implements only session, message, tool, task, and agent APIs. Relay, Mesh, and Tasks methods are not available in DirectTransport (Obsidian plugin mode) — these features require server-side state and are scoped for the standalone web client.

## Data Flow

### Standalone Web (HttpTransport)

The web client always uses direct SSE — `transport.sendMessage()` is the sole message path regardless of whether `DORKOS_RELAY_ENABLED` is set. When not streaming, a persistent SSE connection (`GET /api/sessions/:id/stream`) receives `sync_update` events for cross-client synchronization.

```
User input -> ChatPanel -> useChatSession.handleSubmit()
  -> transport.sendMessage(sessionId, content, onEvent, signal, cwd)
    -> fetch(POST /api/sessions/:id/messages) + ReadableStream SSE parsing
      -> onEvent(event) -> React state updates -> UI re-render

Cross-client sync (when idle):
  -> GET /api/sessions/:id/stream (persistent fetch + ReadableStream SSE)
    -> sync_update event -> queryClient.invalidateQueries()

Agent UI commands (during streaming):
  -> onEvent({ type: 'ui_command', data: { command } })
    -> executeUiCommand(ctx, command) -> Zustand store mutations / toast / theme change
```

The `ui_command` stream event type carries agent-issued `UiCommand` payloads back to the client. See [Agent UI Control](#agent-ui-control) for the full bidirectional pattern.

### Obsidian Plugin (DirectTransport)

```
User input -> ChatPanel -> useChatSession.handleSubmit()
  -> transport.sendMessage(sessionId, content, onEvent, signal, cwd)
    -> runtime.sendMessage() -> SDK query()
      -> AsyncGenerator<StreamEvent>
        -> onEvent(event) -> React state updates -> UI re-render
```

## Agent UI Control

Agents can observe and control the DorkOS client UI through a bidirectional pattern:

**Client → Agent** (UI state awareness): The client captures a `UiState` snapshot (canvas, panels, sidebar, active agent) and passes it via `sendMessage(id, content, onEvent, signal, cwd, { uiState })`. The server forwards this to the SDK as context injection, giving the agent situational awareness of what the user sees.

**Agent → Client** (UI commands): The agent calls the `control_ui` MCP tool, which validates a `UiCommand` via `UiCommandSchema` and emits a `ui_command` stream event to the SSE stream. The client dispatches this via `executeUiCommand()` (`layers/shared/lib/ui-action-dispatcher.ts`), a pure side-effect dispatcher that mutates the Zustand store.

A companion `get_ui_state` MCP tool lets agents query the current UI state without sending a message.

### UiCommand Actions

| Action                                        | Effect                                                       |
| --------------------------------------------- | ------------------------------------------------------------ |
| `open_canvas`                                 | Opens the canvas panel with URL, markdown, or JSON content   |
| `update_canvas`                               | Updates canvas content without toggling visibility           |
| `close_canvas`                                | Closes the canvas panel                                      |
| `open_panel` / `close_panel` / `toggle_panel` | Controls named panels (settings, pulse, relay, mesh, picker) |
| `open_sidebar` / `close_sidebar`              | Controls sidebar visibility                                  |
| `switch_sidebar_tab`                          | Switches sidebar to a named tab                              |
| `show_toast`                                  | Shows a toast notification (success, error, info, warning)   |
| `set_theme`                                   | Switches between light and dark theme                        |
| `scroll_to_message`                           | Scrolls chat to a specific message ID                        |
| `switch_agent`                                | Switches to a different agent by working directory           |
| `open_command_palette`                        | Opens the command palette                                    |

### Key Types

- `UiState` — client snapshot (canvas, panels, sidebar, agent) passed to the agent
- `UiCanvasContent` — discriminated union (`url` | `markdown` | `json`) for canvas payloads
- `UiCommand` — discriminated union on `action` (14 variants)
- `UiCommandEvent` — SSE event wrapper (`{ type: 'ui_command', command }`)

All types defined in `packages/shared/src/schemas.ts`, re-exported from `packages/shared/src/types.ts`.

### Files

| File                                                                  | Purpose                                                                             |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/shared/src/schemas.ts`                                      | `UiStateSchema`, `UiCommandSchema`, `UiCommandEventSchema`, `UiCanvasContentSchema` |
| `apps/server/src/services/runtimes/claude-code/mcp-tools/ui-tools.ts` | `control_ui` and `get_ui_state` MCP tool definitions                                |
| `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts`           | `executeUiCommand()` — pure dispatcher, no React deps                               |

## Runtime Registry

DorkOS abstracts agent backends behind the `AgentRuntime` interface (`packages/shared/src/agent-runtime.ts`). This allows routes and services to interact with any agent backend (Claude Code, future alternatives) through a uniform contract.

### AgentRuntime Interface

The `AgentRuntime` interface defines all operations that an agent backend must support:

- **Session lifecycle**: `ensureSession`, `hasSession`, `updateSession`
- **Messaging**: `sendMessage` (returns `AsyncGenerator<StreamEvent>`)
- **Interactive flows**: `approveTool`, `submitAnswers`, `interruptQuery`
- **Session queries**: `listSessions`, `getSession`, `getMessageHistory`, `getSessionTasks`, `getSessionETag`, `getLastMessageIds`, `readFromOffset`
- **Session sync**: `watchSession`
- **Session locking**: `acquireLock`, `releaseLock`, `isLocked`, `getLockInfo`
- **Capabilities**: `getSupportedModels`, `getCapabilities` (returns `RuntimeCapabilities`)
- **Commands**: `getCommands`
- **Lifecycle**: `checkSessionHealth`, `getInternalSessionId`
- **Optional DI**: `setMcpServerFactory?`, `setMeshCore?`, `setRelay?`

### RuntimeCapabilities

Each runtime declares static capability flags via `getCapabilities()`:

| Flag                      | Description                                                  |
| ------------------------- | ------------------------------------------------------------ |
| `supportsPermissionModes` | Whether permission modes (default, plan, auto) are supported |
| `supportsToolApproval`    | Whether tool approval UI should be shown                     |
| `supportsCostTracking`    | Whether cost/token tracking is available                     |
| `supportsResume`          | Whether sessions can be resumed                              |
| `supportsMcp`             | Whether MCP tool servers can be injected                     |
| `supportsQuestionPrompt`  | Whether AskUserQuestion interactive flow is supported        |

### RuntimeRegistry

`RuntimeRegistry` (`apps/server/src/services/core/runtime-registry.ts`) is a singleton that holds all registered runtime implementations. Routes call `runtimeRegistry.getDefault()` to obtain the active runtime.

Key methods:

- `register(runtime)` — register or replace a runtime by its `type` string
- `getDefault()` — returns the default runtime (claude-code unless changed)
- `resolveForAgent(agentId, meshCore?)` — looks up the agent's manifest to determine which runtime to use, falling back to the default
- `getAllCapabilities()` — returns capability flags for all registered runtimes (used by `GET /api/capabilities`)

### How Routes Use the Registry

Routes never reference a specific runtime class. They obtain the active runtime from the registry:

```typescript
import { runtimeRegistry } from '../services/core/runtime-registry.js';

router.get('/sessions', async (req, res) => {
  const runtime = runtimeRegistry.getDefault();
  const sessions = await runtime.listSessions(projectDir);
  res.json({ sessions });
});
```

### File Organization

All Claude Code-specific services live under `services/runtimes/claude-code/`:

| File                      | Purpose                                                                           |
| ------------------------- | --------------------------------------------------------------------------------- |
| `claude-code-runtime.ts`  | `ClaudeCodeRuntime` class implementing `AgentRuntime`                             |
| `session-store.ts`        | `SessionStore` — in-memory store for active `AgentSession` objects                |
| `runtime-cache.ts`        | `RuntimeCache` — caches models, subagents, and other slow-fetch runtime data      |
| `runtime-constants.ts`    | Shared constants used across ClaudeCodeRuntime modules                            |
| `agent-types.ts`          | `AgentSession` and `ToolState` interfaces                                         |
| `sdk-event-mapper.ts`     | SDK message to `StreamEvent` transformation                                       |
| `context-builder.ts`      | Runtime context injection for system prompt                                       |
| `tool-filter.ts`          | Per-agent MCP tool filtering                                                      |
| `interactive-handlers.ts` | Tool approval, question flows, and MCP elicitation                                |
| `transcript-reader.ts`    | JSONL session data reader                                                         |
| `transcript-parser.ts`    | JSONL line parser                                                                 |
| `session-broadcaster.ts`  | Cross-client session sync via file watching                                       |
| `session-lock.ts`         | Session write locks                                                               |
| `command-registry.ts`     | Slash command discovery                                                           |
| `build-task-event.ts`     | Task event builder                                                                |
| `task-reader.ts`          | Task state parser                                                                 |
| `sdk-utils.ts`            | `makeUserPrompt()`, `resolveClaudeCliPath()`                                      |
| `message-sender.ts`       | Extracted send-message logic (streaming, tool filtering, context building)        |
| `mcp-tools/`              | MCP tool server (core, tasks, relay, mesh, adapter, binding, UI, extension tools) |
| `index.ts`                | Barrel export for `ClaudeCodeRuntime`                                             |

SDK imports (`@anthropic-ai/claude-agent-sdk`) are contained exclusively within `services/runtimes/claude-code/`. No other server code imports the SDK directly. This is enforced by a `no-restricted-imports` rule in the server's `eslint.config.js`.

### Extension MCP Tools

The external MCP server registers 6 extension management tools:

| Tool                   | Description                                       |
| ---------------------- | ------------------------------------------------- |
| `list_extensions`      | List all extensions with status and scope         |
| `create_extension`     | Scaffold a new extension with template code       |
| `reload_extensions`    | Recompile and reload (all or single)              |
| `get_extension_errors` | Get extensions in an error state with diagnostics |
| `get_extension_api`    | Get full ExtensionAPI type reference              |
| `test_extension`       | Headless smoke test (compile + mock activate)     |

Tools are implemented in `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts` and registered in `mcp-server.ts`. All handlers guard on `deps.extensionManager` — when extensions are disabled, tools return descriptive errors.

The agent iteration loop: `create_extension` -> `test_extension` (smoke) -> `reload_extensions` (visual) -> iterate.

## Per-Session Tool Filtering

Each agent session can have a tailored MCP tool palette. The filtering pipeline runs on every `sendMessage()` call in `ClaudeCodeRuntime`:

```
ClaudeCodeRuntime.sendMessage(sessionId, content, cwd)
  -> readManifest(effectiveCwd)                    // Load .dork/agent.json
  -> resolveToolConfig(manifest.enabledToolGroups, // Merge agent overrides with global defaults
       { relayEnabled, tasksEnabled, globalConfig })
  -> buildSystemPromptAppend(cwd, meshCore,        // Context blocks gated by toolConfig
       toolConfig)
  -> buildAllowedTools(toolConfig)                 // Produce SDK allowedTools array
  -> query({ allowedTools, systemPrompt })         // SDK call with filtered tools
```

### Resolution Order

1. **Per-agent override** (`enabledToolGroups` in `.dork/agent.json`): explicit `true`/`false` per domain
2. **Global default** (`agentContext.*Tools` in `~/.dork/config.json`): applies when agent has no override
3. **Server feature flag** (`relayEnabled`, `tasksEnabled`): hard gate that overrides both above when `false`

### Implicit Grouping

Four top-level toggles control six tool groups:

| Toggle    | Controls                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------- |
| `pulse`   | Tasks tools (list/create/update/delete schedules, run history)                                    |
| `relay`   | Relay tools (send, inbox, endpoints) + Trace tools (get_trace, get_metrics)                       |
| `mesh`    | Mesh tools (discover, register, list, deny, status, inspect, topology)                            |
| `adapter` | Adapter tools (list/enable/disable/reload adapters) + Binding tools (list/create/delete bindings) |

Core tools (ping, get_server_info, get_session_count, get_agent) are always included.

### Defense in Depth

When a domain is disabled, both the MCP `allowedTools` filter and the context block are omitted. The `allowedTools` filter prevents the SDK from offering the tools; the context block omission removes usage instructions from the system prompt. This is defense-in-depth, not a security boundary.

### Files

| File                                                               | Purpose                                       |
| ------------------------------------------------------------------ | --------------------------------------------- |
| `apps/server/src/services/runtimes/claude-code/tool-filter.ts`     | `resolveToolConfig()` + `buildAllowedTools()` |
| `apps/server/src/services/runtimes/claude-code/context-builder.ts` | Agent-aware block gating, peer agents block   |
| `packages/shared/src/mesh-schemas.ts`                              | `EnabledToolGroupsSchema` on `AgentManifest`  |
| `packages/shared/src/config-schema.ts`                             | `agentContext.tasksTools` global default      |

## Module Layout

```
packages/
  shared/src/
    agent-runtime.ts        -- AgentRuntime interface + RuntimeCapabilities (universal backend contract)
    transport.ts            -- Transport interface (the "port", includes getCapabilities)
    types.ts                -- Shared type definitions
    manifest.ts             -- Agent manifest I/O (readManifest, writeManifest, removeManifest)
    relay-schemas.ts        -- Facade re-exporting from 4 focused sub-modules (backward compatible)
    relay-envelope-schemas.ts -- Envelopes, budgets, payloads, signals, HTTP API request/query schemas
    relay-access-schemas.ts   -- Access control rules (allow/deny by subject pattern)
    relay-adapter-schemas.ts  -- Adapters, catalogs, bindings, HTTP request schemas
    relay-trace-schemas.ts    -- Delivery traces, metrics, reliability configuration
    mesh-schemas.ts         -- Zod schemas for Mesh (AgentManifest, health, topology, lifecycle)
    config-schema.ts        -- UserConfigSchema with defaults and sensitive key list

  relay/src/
    relay-core.ts           -- Main RelayCore class (pub/sub orchestrator)
    types.ts                -- RelayAdapter, DeliveryResult, AdapterContext, etc.
    adapter-registry.ts     -- AdapterRegistry (lifecycle + subject-prefix routing)
    adapter-plugin-loader.ts -- Dynamic plugin loading (npm package or local path)
    maildir-store.ts        -- Maildir-based atomic message storage per endpoint
    sqlite-index.ts         -- SQLite index for message history and status queries
    dead-letter-queue.ts    -- O(1) dead-letter lookup via SQLite rowid
    access-control.ts       -- Subject-level access control rules
    delivery-pipeline.ts    -- Staged delivery (rate limit, circuit breaker, backpressure)
    adapter-delivery.ts     -- Adapter delivery with 30s timeout protection
    subscription-registry.ts -- In-process push subscriptions
    watcher-manager.ts      -- chokidar-based Maildir new/ watchers
    signal-emitter.ts       -- Signal (lifecycle event) broadcasting
    rate-limiter.ts         -- Per-sender sliding window rate limiting
    circuit-breaker.ts      -- Per-endpoint circuit breaker (CLOSED/OPEN/HALF_OPEN)
    backpressure.ts         -- Reactive load-shedding based on mailbox depth
    budget-enforcer.ts      -- Budget envelope validation and decrement
    subject-matcher.ts      -- NATS-style subject and wildcard matching
    endpoint-registry.ts    -- Maildir endpoint registration + hash computation
    adapters/
      claude-code/          -- Routes relay.agent.> and relay.system.tasks.> to ClaudeCodeRuntime
                               (modular: claude-code-adapter.ts, agent-handler.ts, tasks-handler.ts, queue.ts, publish.ts)
      telegram/             -- Telegram Bot API via grammY (modular: telegram-adapter.ts, inbound.ts, outbound.ts, webhook.ts)
      webhook-adapter.ts    -- Generic HTTP POST with HMAC-SHA256 verification

  a2a-gateway/src/
    agent-card-generator.ts -- A2A Agent Card generation from Mesh manifests
    schema-translator.ts    -- A2A ↔ DorkOS type translation
    task-store.ts           -- SQLite task state persistence
    dorkos-executor.ts      -- Bridges A2A tasks to Relay publish/subscribe
    express-handlers.ts     -- Express handlers for A2A endpoints
    index.ts                -- Barrel export

  mesh/src/
    mesh-core.ts            -- Thin coordinator composing discovery, agent management, and denial modules
    mesh-discovery.ts       -- Discovery & registration logic (discover, register, registerByPath)
    mesh-agent-management.ts -- Agent list/get/update/unregister, health, topology operations
    mesh-denial.ts          -- Denial list operations (deny, undeny, list)
    discovery/              -- Unified discovery system
      unified-scanner.ts    -- BFS async generator with detection strategies, symlink support
      types.ts              -- ScanEvent, UnifiedScanOptions, UNIFIED_EXCLUDE_PATTERNS
    agent-registry.ts       -- SQLite-backed persistent agent registry
    denial-list.ts          -- SQLite-backed denial list to suppress re-discovery
    namespace-resolver.ts   -- Namespace derivation from agent workspace paths
    topology.ts             -- TopologyManager for cross-namespace access rules
    health.ts               -- computeHealthStatus() (active/inactive/stale thresholds)
    relay-bridge.ts         -- Publishes lifecycle events to Relay subjects when enabled
    budget-mapper.ts        -- Maps Relay budget envelopes to mesh agent capabilities
    reconciler.ts           -- Reconciles discovered candidates with registry state
    manifest.ts             -- readManifest/writeManifest for .dork/agent.json
    strategies/
      claude-code-strategy.ts -- Detects .claude/settings.json workspaces
      cursor-strategy.ts    -- Detects .cursor/ directories
      codex-strategy.ts     -- Detects .codex/ directories

apps/
  client/src/layers/
    shared/
      model/
        TransportContext.tsx -- React Context DI (useTransport, TransportProvider)
        app-store.ts        -- Zustand UI state store
        use-theme.ts        -- Theme hook (+ 7 other hooks)
      lib/
        direct-transport.ts -- In-process adapter (Obsidian plugin)
        transport/
          http-transport.ts -- HTTP/SSE adapter
          relay-methods.ts  -- createRelayMethods() factory
          pulse-methods.ts  -- createTasksMethods() factory
          mesh-methods.ts   -- createMeshMethods() factory
          http-client.ts    -- fetchJSON, buildQueryString helpers
          sse-parser.ts     -- parseSSEStream helper
        utils.ts            -- cn() utility
    components/
      App.tsx               -- Main app shell
    main.tsx                -- Standalone entry (HttpTransport)
    # Client dependencies: fuse.js (fuzzy search with match indices for command palette)

  obsidian-plugin/src/
    main.ts                 -- Obsidian plugin entry
    views/
      CopilotView.tsx       -- Creates DirectTransport + service instances
    components/
      ObsidianApp.tsx       -- Plugin wrapper (auto-session, context bar)
    lib/
      obsidian-adapter.ts   -- Platform adapter for Obsidian

  server/src/
    services/
      core/                   -- Shared infrastructure services
        runtime-registry.ts   -- Registry of agent runtimes (singleton, keyed by type)
        config-manager.ts     -- Persistent user config (~/.dork/config.json)
        stream-adapter.ts     -- SSE helpers (initSSEStream, sendSSEEvent, endSSEStream).
                                  sendSSEEvent is async — must be awaited. Awaits drain
                                  when res.write() returns false (backpressure handling).
        tunnel-manager.ts     -- Opt-in ngrok tunnel lifecycle
        update-checker.ts     -- npm registry version check with 1-hour cache
        file-lister.ts        -- Directory file listing
        git-status.ts         -- Git branch and changed files
        upload-handler.ts     -- File upload service (multer config, storage, MIME validation)
        mcp-server.ts         -- External MCP server factory (Streamable HTTP transport)
        openapi-registry.ts   -- Auto-generated OpenAPI spec from Zod schemas
      runtimes/               -- Agent backend implementations
        index.ts              -- Barrel export for runtimes
        claude-code/          -- Claude Code runtime (Agent SDK)
          claude-code-runtime.ts -- ClaudeCodeRuntime implementing AgentRuntime
          agent-types.ts      -- AgentSession/ToolState interfaces
          sdk-event-mapper.ts -- SDK message → StreamEvent mapper
          context-builder.ts  -- Runtime context for systemPrompt
          tool-filter.ts      -- Per-agent MCP tool filtering (resolveToolConfig, buildAllowedTools)
          interactive-handlers.ts -- Tool approval & question flows
          command-registry.ts -- Slash command discovery
          transcript-reader.ts  -- JSONL session reader (single source of truth)
          transcript-parser.ts  -- JSONL line → HistoryMessage parser
          session-broadcaster.ts -- Cross-client session sync via chokidar file watching
          session-lock.ts     -- Session write locks with auto-expiry
          build-task-event.ts -- TaskUpdateEvent builder from tool call inputs
          task-reader.ts      -- Task state parser from JSONL transcript lines
          sdk-utils.ts        -- makeUserPrompt(), resolveClaudeCliPath()
          mcp-tools/          -- In-process MCP tool server for Claude Agent SDK
          index.ts            -- Barrel export for ClaudeCodeRuntime
      tasks/                  -- Tasks scheduler services
        tasks-store.ts        -- SQLite + JSON schedule/run state
        scheduler-service.ts  -- Cron engine (croner) with overrun protection
        tasks-presets.ts      -- Default schedule presets (~/.dork/tasks/presets.json)
        tasks-state.ts        -- DORKOS_TASKS_ENABLED feature flag holder
      relay/                  -- Relay messaging services
        adapter-manager.ts    -- Server-side adapter lifecycle (config I/O, hot-reload, enable/disable)
        adapter-factory.ts    -- Adapter instantiation from config (built-in + plugin)
        adapter-config.ts     -- Config load/save/watch, sensitive field masking
        adapter-error.ts      -- AdapterError typed error class
        binding-store.ts      -- JSON-backed adapter-agent binding store (~/.dork/relay/bindings.json)
        binding-router.ts     -- relay.human.> → relay.agent.{sessionId} routing with session strategies
        trace-store.ts        -- SQLite delivery trace storage (message_traces table)
        relay-state.ts        -- DORKOS_RELAY_ENABLED feature flag holder
        subject-resolver.ts   -- Subject pattern resolution helpers
      mesh/                   -- Mesh state
        mesh-state.ts         -- Mesh subsystem internal state tracking
      discovery/              -- Agent discovery (delegates to @dorkos/mesh unified scanner)
    lib/
      resolve-root.ts       -- DEFAULT_CWD (prefers DORKOS_DEFAULT_CWD, falls back to repo root)
      boundary.ts           -- Directory boundary validation (enforces 403 for out-of-boundary paths)
      feature-flag.ts       -- Generic feature flag helpers
      route-utils.ts        -- Shared Express route utilities
    routes/
      sessions.ts / commands.ts / health.ts / directory.ts / config.ts
      files.ts / git.ts / tunnel.ts / pulse.ts / agents.ts
      uploads.ts            -- POST /api/uploads (multipart file upload)
      relay.ts              -- Relay HTTP routes (feature-flag guarded)
      mesh.ts               -- Mesh HTTP routes (always mounted)
      mcp.ts                -- MCP server endpoint (/mcp, Streamable HTTP transport)
      a2a.ts                -- A2A protocol endpoints (feature-flag gated: DORKOS_A2A_ENABLED)
      models.ts             -- GET /api/models (dynamic via runtimeRegistry.getDefault())
      capabilities.ts       -- GET /api/capabilities (all runtime capability flags)
      discovery.ts          -- POST /api/discovery/scan (SSE agent discovery)
    middleware/
      mcp-auth.ts           -- MCP API key auth middleware
      mcp-origin.ts         -- MCP Origin header validation (DNS rebinding protection)
    index.ts                -- Express server entry
```

## Electron Compatibility Layer

The Obsidian plugin runs inside Electron's renderer process, which creates two categories of incompatibility with the bundled Node.js code. These are handled by Vite build plugins that post-process `main.js`.

### Problem 1: Vite `import.meta.url` Polyfill

Vite converts ESM `import.meta.url` to a CJS polyfill that uses `document.baseURI`. In Electron, this produces `app://obsidian.md/main.js` instead of a `file://` URL. Node's `fileURLToPath()` then throws.

**Fix:** `fixDirnamePolyfill()` plugin replaces Vite's polyfill with native `__dirname` / `__filename` (available in CJS).

### Problem 2: Browser AbortSignal vs Node.js EventTarget

In Electron's renderer, `new AbortController().signal` is Chromium's Web API `AbortSignal`, not a Node.js `EventTarget`. The Claude Agent SDK passes this signal to two Node.js APIs that reject it:

1. `events.setMaxListeners(50, signal)` -- throws `ERR_INVALID_ARG_TYPE`
2. `child_process.spawn(cmd, args, { signal })` -- throws `ERR_INVALID_ARG_TYPE`

**Fix:** `patchElectronCompat()` plugin prepends a preamble that monkey-patches both APIs:

- `spawn()` -- strips the `signal` option, manually listens for abort to kill the process
- `setMaxListeners()` -- wraps in try/catch, silently ignores `ERR_INVALID_ARG_TYPE`

### Problem 3: Claude Code CLI Path Resolution

The SDK resolves its `cli.js` relative to `import.meta.url`. In the bundled plugin, this resolves inside `Obsidian.app`, which doesn't have a `cli.js`.

**Fix:** `ClaudeCodeRuntime` resolves the CLI path dynamically via `resolveClaudeCliPath()`:

1. Try `require.resolve('@anthropic-ai/claude-agent-sdk/cli.js')` (works in dev)
2. Fall back to `which claude` (finds the globally installed CLI)
3. Pass via `pathToClaudeCodeExecutable` in SDK options

### Problem 4: Optional Dependencies

Some bundled libraries reference packages that aren't installed (e.g., `@emotion/is-prop-valid`, `ajv-formats`).

**Fix:** `safeRequires()` plugin wraps these `require()` calls in try/catch, returning `{}` on failure.

### Build Plugin Execution Order

All four plugins run in this order during `vite build` in `apps/obsidian-plugin/` (using `apps/obsidian-plugin/vite.config.ts`):

1. `copyManifest()` -- copies `manifest.json` to `dist/`
2. `safeRequires()` -- wraps optional requires during chunk rendering
3. `fixDirnamePolyfill()` -- replaces `import.meta.url` polyfills after write
4. `patchElectronCompat()` -- prepends spawn/setMaxListeners patches after write

## Data Directory Resolution

All persistent DorkOS state lives under a single data directory (`dorkHome`). Resolution is handled by `apps/server/src/lib/dork-home.ts`:

```
resolveDorkHome() priority:
  1. DORK_HOME env var     — explicit override (wins in any environment)
  2. .temp/.dork/ (cwd)    — dev default (keeps state out of ~)
  3. ~/.dork/              — production default
```

**Broadcast pattern**: `index.ts` calls `resolveDorkHome()` once at startup, sets `process.env.DORK_HOME`, then passes the resolved path to all services as a required parameter.

**Required-parameter convention**: Server services (`ConfigManager`, `initLogger`, etc.) accept `dorkHome` or `logDir` as a **required** `string` parameter — no fallback chains. This prevents dev state from silently leaking to `~/.dork`.

**ESLint guardrail**: `no-restricted-imports` in the server's `eslint.config.js` bans importing `homedir` from `os` in `apps/server/src/**/*.ts` (with a carve-out for `lib/dork-home.ts`). See `.claude/rules/dork-home.md`.

**Packages**: `packages/*/` may use `os.homedir()` as standalone/test safety nets. The server always overrides via constructor options.

## Configuration System

DorkOS uses a persistent JSON config file at `~/.dork/config.json` for user preferences. The config system spans three layers: schema, service, and CLI.

### Config File

Location: `~/.dork/config.json` (created automatically on first run). Format:

```json
{
  "version": 1,
  "server": { "port": 4242, "cwd": null, "boundary": null },
  "tunnel": { "enabled": false, "domain": null, "authtoken": null, "auth": null },
  "ui": { "theme": "system" },
  "logging": { "level": "info", "maxLogSizeKb": 500, "maxLogFiles": 14 },
  "relay": { "enabled": true, "dataDir": null },
  "scheduler": { "enabled": true, "maxConcurrentRuns": 1, "timezone": null, "retentionCount": 100 },
  "mesh": { "scanRoots": [] },
  "agentContext": {
    "relayTools": true,
    "meshTools": true,
    "adapterTools": true,
    "tasksTools": true
  }
}
```

### Schema (`packages/shared/src/config-schema.ts`)

`UserConfigSchema` (Zod) defines all config fields with defaults and constraints. Exports:

- `UserConfig` type (inferred from schema)
- `USER_CONFIG_DEFAULTS` (parsed defaults for `conf` constructor)
- `SENSITIVE_CONFIG_KEYS` (fields that trigger warnings: `tunnel.authtoken`, `tunnel.auth`)

### ConfigManager Service (`apps/server/src/services/core/config-manager.ts`)

Singleton service wrapping the `conf` library for atomic JSON I/O. Key behaviors:

- **Initialization**: `initConfigManager(dorkHome)` creates the singleton. `dorkHome` is required — no fallback chain. Called at server startup and in CLI subcommands.
- **Validation**: Uses Ajv (via `conf`) for write-time validation and Zod for explicit `validate()` calls.
- **Corrupt config recovery**: If `conf` constructor throws, backs up the corrupt file to `config.json.bak` and recreates with defaults.
- **First-run detection**: `isFirstRun` flag based on whether config file existed before construction.
- **Sensitive field warnings**: `setDot()` returns `{ warning }` for keys in `SENSITIVE_CONFIG_KEYS`.

### Precedence Chain

When the CLI starts the server, config values are resolved in this order (highest priority first):

```
CLI flags (--port, --tunnel, --dir)
  > Environment variables (DORKOS_PORT, TUNNEL_ENABLED, etc.)
    > Config file (~/.dork/config.json)
      > Built-in defaults (from UserConfigSchema)
```

The CLI reads from `ConfigManager` and sets environment variables before importing the server, so the server always reads from `process.env`.

### REST API Integration

`PATCH /api/config` accepts partial config objects, deep-merges with current config, validates via `UserConfigSchema.safeParse()`, and persists via `ConfigManager`. Returns warnings for sensitive fields.

### CLI Subcommands

- `dorkos config` / `config list` / `config get <key>` / `config set <key> <value>` / `config reset [key]` / `config edit` / `config path` / `config validate`
- `dorkos init` -- Interactive setup wizard (uses `@inquirer/prompts`). Supports `--yes` for non-interactive defaults.

Both subcommands initialize `ConfigManager` independently and exit before starting the server.

## Server Utilities

### Vault Root Resolution (`apps/server/src/lib/resolve-root.ts`)

`DEFAULT_CWD` is the single source of truth for the server's default working directory. It prefers the `DORKOS_DEFAULT_CWD` environment variable (set by the CLI, Obsidian plugin, or tests) and falls back to the repository root resolved from `lib/resolve-root.ts`'s own location.

```typescript
export const DEFAULT_CWD: string = env.DORKOS_DEFAULT_CWD ?? path.resolve(thisDir, '../../../');
```

This replaced the previous pattern where each route computed its own fallback path, centralizing vault root logic.

### CORS Configuration (`DORKOS_CORS_ORIGIN`)

The server reads `DORKOS_CORS_ORIGIN` from the environment to configure CORS allowed origins. When unset, defaults to the Vite dev server origin. This allows production deployments to restrict cross-origin access without code changes.

### Dynamic Model List (`GET /api/models`)

Available Claude models are served dynamically from the active runtime's `getSupportedModels()` method rather than being hardcoded. The `models` route (`routes/models.ts`) calls `runtimeRegistry.getDefault().getSupportedModels()` and returns `{ models: ModelOption[] }`. This ensures the model list automatically reflects SDK updates.

## Build Configuration

### Standalone Web (`apps/client/vite.config.ts`)

Standard Vite React build. Server compiled separately via `tsc`.

### Obsidian Plugin (`apps/obsidian-plugin/vite.config.ts`)

- **Target**: `node18` (Electron has Node.js runtime)
- **Format**: CJS (Obsidian requires `module.exports`)
- **External**: Obsidian API, CodeMirror, Lezer, all Node.js built-ins
- **Bundled**: Claude Agent SDK, gray-matter, React, TanStack Query, all npm deps
- **Output**: Single `main.js` file with `inlineDynamicImports`
- CSS extracted to `styles.css` (auto-loaded by Obsidian)
- **Build plugins**: `copyManifest`, `safeRequires`, `fixDirnamePolyfill`, `patchElectronCompat`

### CLI Package (`packages/cli/scripts/build.ts`)

3-step esbuild pipeline producing a standalone npm-installable CLI:

1. **Vite client build** — `apps/client/` React SPA to `dist/client/`
2. **esbuild server bundle** — `apps/server/` + workspace packages to `dist/server/index.js` (ESM, node built-ins externalized)
3. **esbuild CLI entry** — `packages/cli/src/cli.ts` to `dist/bin/cli.js` (with shebang)

**Native dependency:** `better-sqlite3` is required at runtime (via `@dorkos/db`) but cannot be inlined by esbuild. It is listed as a direct dependency in `packages/cli/package.json` so `npm install -g` compiles it via node-gyp. Install environments need build tools (`python3`, `build-essential`, `libsqlite3-dev` on Linux; Xcode CLI tools on macOS).

**Docker images:** Three Dockerfiles at the repo root serve different purposes:

| File                     | Purpose                                                                 | Command                                |
| ------------------------ | ----------------------------------------------------------------------- | -------------------------------------- |
| `Dockerfile`             | CLI install smoke test (`--version`, `--help`, `--post-install-check`)  | `pnpm smoke:docker`                    |
| `Dockerfile.integration` | Full integration test — starts server, validates API + client endpoints | `pnpm smoke:integration`               |
| `Dockerfile.run`         | Runnable container — starts a DorkOS server on `DORKOS_PORT`            | `pnpm docker:build && pnpm docker:run` |

`Dockerfile.integration` supports two install modes via `INSTALL_MODE` build arg: `tarball` (local build, default) or `npm` (published package). Use `pnpm smoke:npm` to test the published npm package. Both integration and runnable images set `DORKOS_HOST=0.0.0.0` to enable Docker port forwarding.

The GitHub Actions workflow (`.github/workflows/cli-smoke-test.yml`) runs smoke tests on bare Ubuntu runners (Node 20/22 matrix), Docker smoke tests, and full integration tests on every push to main.

## A2A Gateway

The A2A gateway (`packages/a2a-gateway/src/`) exposes DorkOS agents to external A2A-compatible clients using Google's Agent-to-Agent protocol. It is feature-flag gated behind `DORKOS_A2A_ENABLED` (default `false`) and requires `DORKOS_RELAY_ENABLED=true`.

### Key Modules

| Module                    | Purpose                                                      |
| ------------------------- | ------------------------------------------------------------ |
| `agent-card-generator.ts` | Generates A2A Agent Cards from Mesh agent manifests          |
| `schema-translator.ts`    | Translates between A2A protocol types and DorkOS Relay types |
| `task-store.ts`           | SQLite-backed task state persistence for A2A task lifecycle  |
| `dorkos-executor.ts`      | Bridges A2A task execution to Relay publish/subscribe        |
| `express-handlers.ts`     | Express request handlers for the three A2A endpoints         |

### Data Flow

```
External A2A Client → POST /a2a (JSON-RPC)
  → express-handlers → schema-translator → relayCore.publish() → Agent
Agent response → Relay subscription → schema-translator → A2A TaskStatusUpdate → SSE to client
```

### Auth

Reuses `MCP_API_KEY` via the existing `mcpApiKeyAuth` middleware — the same authentication used by the MCP endpoint.

### Server Integration

Routes are mounted in `apps/server/src/routes/a2a.ts`:

- `GET /.well-known/agent.json` — Fleet Agent Card (mounted at app root)
- `GET /a2a/agents/:id/card` — Per-agent Agent Card
- `POST /a2a` — JSON-RPC 2.0 endpoint

## Relay

The Relay message bus (`packages/relay/src/`) provides inter-agent messaging and external channel integration. It decouples agents from direct communication concerns using a subject-based pub/sub model inspired by NATS JetStream.

### RelayCore

`RelayCore` (`packages/relay/src/relay-core.ts`) is the main entry point that composes all sub-modules into a single API. It is constructed with a `RelayOptions` object and initialized via `await relayCore.init()` which runs SQLite migrations and starts the Maildir file watchers.

Key sub-modules composed by RelayCore:

| Module                  | Purpose                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `MaildirStore`          | Atomic Maildir-based message storage (tmp/ → new/ rename)                      |
| `SqliteIndex`           | SQLite message history with status queries. Uses `@dorkos/db` Drizzle instance |
| `EndpointRegistry`      | Tracks Maildir endpoints by subject + SHA256 hash                              |
| `SubscriptionRegistry`  | In-process push subscriptions dispatched by chokidar watchers                  |
| `WatcherManager`        | chokidar watchers on each endpoint's `new/` directory                          |
| `DeadLetterQueue`       | O(1) SQLite-backed dead-letter lookup; separate from message history           |
| `AccessControl`         | Per-subject access control rules (allow/deny by sender pattern)                |
| `DeliveryPipeline`      | Staged delivery: rate limit → circuit breaker → backpressure → Maildir write   |
| `AdapterDelivery`       | Adapter delivery with 30-second timeout protection                             |
| `SignalEmitter`         | Lifecycle signal broadcasting for Mesh bridge integration                      |
| `RateLimiter`           | Per-sender sliding window rate limiting                                        |
| `CircuitBreakerManager` | Per-endpoint circuit breaker (CLOSED / OPEN / HALF_OPEN states)                |

### Relay Publish Pipeline — Unified Fan-Out

The `RelayCore.publish()` method uses a unified fan-out model: both Maildir endpoints and adapter delivery are attempted before any dead-letter decision is made. This ensures adapter-only subjects (like `relay.agent.*` handled by `ClaudeCodeAdapter`) receive messages even when no Maildir endpoints are registered.

Pipeline steps:

1. Validate subject format
2. Access control check
3. Rate limit check (per-sender)
4. Build envelope with budget
5. Deliver to matching Maildir endpoints (may be zero)
6. Deliver to matching adapter via `deliverToAdapter()` (timeout-protected, 30s)
7. Dead-letter only when `deliveredTo === 0` and no matching endpoints exist

Adapter delivery includes SQLite indexing (with `adapter:` prefixed endpoint hash) for audit trail completeness.

**Known edge case — POST/SSE race:** When a client sends a message via POST and simultaneously establishes an SSE subscription, there is a window where the subscription may not yet be active when the response arrives. The subscription dispatch in `publish()` mitigates this for most cases, but it is not guaranteed for the very first message. This is a known limitation, not a bug.

### Adapter System

**`RelayAdapter` interface** (`packages/relay/src/types.ts`) — the plugin contract every adapter must implement:

```typescript
interface RelayAdapter {
  id: string;
  subjectPrefix: string | readonly string[];
  displayName: string;
  start(relay: RelayPublisher): Promise<void>;
  stop(): Promise<void>;
  deliver(subject, envelope, context?): Promise<DeliveryResult>;
  getStatus(): AdapterStatus;
  testConnection?(): Promise<{ ok: boolean; error?: string }>;
}
```

**`AdapterRegistry`** (`packages/relay/src/adapter-registry.ts`) manages adapter lifecycle. On `register()`, the registry performs a zero-downtime hot-reload: starts the new adapter, swaps it in, then stops the old adapter. `Promise.allSettled()` is used on `shutdown()` so one adapter crashing never blocks others.

**`AdapterPluginLoader`** (`packages/relay/src/adapter-plugin-loader.ts`) loads adapters from three sources:

1. Built-in adapters (factory map)
2. npm packages (`plugin.package` field in config — dynamic `import(packageName)`)
3. Local file paths (`plugin.path` field — dynamic `import(pathToFileURL(absolutePath))`)

Loading errors are non-fatal: the loader warns and skips the failing adapter.

**`AdapterManager`** (`apps/server/src/services/relay/adapter-manager.ts`) is the server-side lifecycle manager. It:

- Loads config from `~/.dork/relay/adapters.json` and watches for changes via chokidar (hot-reload)
- Delegates adapter instantiation to `adapter-factory.ts` and `adapter-plugin-loader.ts`
- Masks sensitive fields (via `AdapterManifest.configFields[].sensitive`) in API responses
- Initializes and owns the `BindingStore` and `BindingRouter` subsystems (when `relayCore` is provided)
- Preserves password fields across config updates (`mergeWithPasswordPreservation`)

**Adapter data flow:**

```
Inbound:  External message → Adapter.handleInbound() → RelayCore.publish() → Maildir fan-out
Outbound: RelayCore.publish() → AdapterRegistry.deliver() → Adapter.deliver() → External API
```

**Built-in adapters:**

| Adapter             | Library          | Transport               | Subject Prefix                          |
| ------------------- | ---------------- | ----------------------- | --------------------------------------- |
| `TelegramAdapter`   | grammY           | Long polling / webhook  | `relay.human.telegram.*`                |
| `WebhookAdapter`    | Native HTTP      | HTTP POST + HMAC-SHA256 | `relay.webhook.*`                       |
| `ClaudeCodeAdapter` | Claude Agent SDK | In-process              | `relay.agent.>`, `relay.system.tasks.>` |

### ClaudeCodeAdapter

`ClaudeCodeAdapter` (`packages/relay/src/adapters/claude-code-adapter.ts`) is the runtime adapter that bridges Relay to Claude Agent SDK sessions. It replaces the earlier `MessageReceiver` bridge and plugs into `AdapterRegistry` alongside external adapters.

It handles two subject prefixes:

- `relay.agent.>` — delivers messages to an existing agent session (via the runtime's `sendMessage()`)
- `relay.system.tasks.>` — dispatches Tasks scheduler jobs (via the runtime's `sendMessage()`)

On deliver, it extracts payload content via shared `extractPayloadContent()` utilities, streams the SDK response back to the `replyTo` subject as individual `StreamEvent` chunks, and records delivery spans in `TraceStore`.

### Adapter Catalog Management

The adapter catalog allows users to discover available adapter types and configure instances without editing JSON files directly.

`AdapterManifest` (in `@dorkos/shared/relay-schemas`) describes each adapter type with:

- `configFields: ConfigField[]` — typed field definitions (text, password, number, boolean) with `required`, `default`, `description`, and `sensitive` flags
- `multiInstance` — whether multiple instances of the type are allowed
- `builtin` — whether the adapter ships with DorkOS or is user-installed
- `category` — adapter grouping (`internal` | `messaging` | `webhook` | `custom`)

`GET /api/relay/adapters/catalog` returns `CatalogEntry[]` — the full manifest plus all configured instances, with sensitive fields masked. The UI (`AdapterSetupWizard`, `AdapterCard`, `CatalogCard`, `ConfigFieldInput`) uses this catalog for guided setup without requiring JSON editing.

### Adapter-Agent Binding Router

The `BindingRouter` (`apps/server/src/services/relay/binding-router.ts`) routes inbound messages from external adapters to the correct agent session. It subscribes to `relay.human.>` and resolves a binding for each message.

**Binding resolution** uses most-specific-first scoring against the `BindingStore`:

1. `adapterId + chatId + channelType` (score 7)
2. `adapterId + chatId` (score 5)
3. `adapterId + channelType` (score 3)
4. `adapterId` only / wildcard (score 1)
5. No match → message silently dropped (no dead-letter)

**Session strategies** (configured per binding):

- `per-chat` (default) — one agent session per `chatId`; reuses existing sessions
- `per-user` — one session per user identity extracted from envelope metadata
- `stateless` — creates a fresh session for every message

**Session persistence** — the session map is written atomically to `{relayDir}/sessions.json` on every new session creation and on shutdown. On startup, `BindingRouter` loads this file to recover session mappings across server restarts. The map uses LRU eviction when it exceeds 10,000 entries.

**Subject parsing** handles both DM subjects (`relay.human.{platformType}.{chatId}`) and group chat subjects (`relay.human.{platformType}.group.{chatId}`). The platform type (e.g., `telegram`) is resolved to the actual adapter instance ID via `resolveAdapterInstanceId`.

**`BindingStore`** (`apps/server/src/services/relay/binding-store.ts`) persists bindings to `~/.dork/relay/bindings.json`. It uses chokidar with mtime-based self-write detection to distinguish external edits from its own saves, triggering hot-reload only for the former.

See `contributing/relay-adapters.md` for the full developer guide on creating custom adapters.

## Relay Message Routing (when DORKOS_RELAY_ENABLED=true)

When the Relay feature flag is enabled, Tasks (scheduled) message flows are routed through the Relay message bus instead of calling the runtime directly. The web client always uses direct SSE regardless of this flag.

### Tasks Dispatch Flow

```
SchedulerService → relay.publish('relay.system.tasks.{scheduleId}')
  → ClaudeCodeAdapter.deliver() (handleTasksDispatch) → runtime.sendMessage() → Claude SDK
```

### Message Tracing

Every `relay.publish()` records a `TraceSpan` in SQLite via `TraceStore` (in `apps/server/src/services/relay/trace-store.ts`). Spans are updated on delivery completion with status and timing. API: `GET /api/relay/messages/:id/trace`, `GET /api/relay/trace/metrics`.

## Mesh

The Mesh subsystem (`packages/mesh/src/`) provides agent discovery, registration, and lifecycle management. It enables DorkOS to detect and coordinate with other AI coding agents running on the same machine or network.

### Core Components

| Module                         | Purpose                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `mesh-core.ts`                 | Thin coordinator delegating to extracted modules (discovery, agent management, denial)              |
| `mesh-discovery.ts`            | Discovery & registration logic (`discover`, `register`, `registerByPath`)                           |
| `mesh-agent-management.ts`     | Agent CRUD, health computation, topology operations                                                 |
| `mesh-denial.ts`               | Denial list operations (`deny`, `undeny`, `list`)                                                   |
| `discovery/unified-scanner.ts` | Unified BFS async generator with detection strategies (claude-code, cursor, copilot, dork-manifest) |
| `agent-registry.ts`            | SQLite-backed persistent registry of known agents (via `@dorkos/db` Drizzle instance)               |
| `denial-list.ts`               | SQLite-backed denial list preventing re-discovery of denied paths                                   |
| `namespace-resolver.ts`        | Resolves agent namespaces from workspace paths for subject-based routing                            |
| `topology.ts`                  | `TopologyManager` — cross-namespace access rules and filtered topology views                        |
| `budget-mapper.ts`             | Maps Relay budget envelopes to mesh agent capabilities                                              |
| `relay-bridge.ts`              | Optional bridge publishing lifecycle events to Relay subjects                                       |
| `health.ts`                    | `computeHealthStatus()` — active/inactive/stale thresholds from last heartbeat                      |
| `reconciler.ts`                | Reconciles newly discovered candidates against registry state                                       |
| `manifest.ts`                  | Reads/writes `.dork/agent.json` manifest files                                                      |

### Discovery Strategies

Three pluggable strategies detect different agent types:

| Strategy             | Detects                | Signal                                    |
| -------------------- | ---------------------- | ----------------------------------------- |
| `ClaudeCodeStrategy` | Claude Code workspaces | `.claude/` directory with `settings.json` |
| `CursorStrategy`     | Cursor editor sessions | `.cursor/` directory                      |
| `CodexStrategy`      | OpenAI Codex agents    | `.codex/` directory                       |

### Health Tracking

Agent health is computed from the `last_seen_at` timestamp in the agent registry, updated each time a heartbeat is received (`POST /api/mesh/agents/:id/heartbeat`):

| Status     | Threshold                                      |
| ---------- | ---------------------------------------------- |
| `active`   | Last heartbeat < 5 minutes ago                 |
| `inactive` | Last heartbeat 5–30 minutes ago                |
| `stale`    | Last heartbeat > 30 minutes ago, or never seen |

Health is returned by `GET /api/mesh/agents/:id/health` and aggregated by `GET /api/mesh/status` (`MeshStatus`).

### Namespace Isolation and Topology

`NamespaceResolver` derives a namespace string from an agent's workspace path (e.g., `/home/user/projects/api-service` → `projects.api-service`). Namespaces provide default isolation: agents in different namespaces cannot see each other unless an explicit cross-namespace rule grants access.

`TopologyManager` stores cross-namespace access rules and applies per-agent visibility filtering when `getMeshTopology()` is called. `PUT /api/mesh/topology/access` creates or updates rules. The topology view is consumed by the `TopologyGraph` React Flow visualization in the client (`features/mesh/`).

### Server Integration

The server exposes Mesh via `routes/mesh.ts` (always mounted, no feature flag). MCP tools in `mcp-tool-server.ts` allow agents to discover, register, deny, inspect, and query topology programmatically (`mesh_discover`, `mesh_register`, `mesh_deny`, `mesh_list`, `mesh_unregister`, `mesh_status`, `mesh_inspect`, `mesh_query_topology`).

### Lifecycle Hooks

`MeshCore` supports an `onUnregister(callback)` lifecycle hook for extensibility. The server wires cascade effects through this hook — for example, disabling Tasks schedules linked to the unregistered agent (see [Cascade Disable on Agent Unregister](#cascade-disable-on-agent-unregister)).

### Relay Bridge

When both Mesh and Relay are enabled, `RelayBridge` publishes lifecycle events (`agent.registered`, `agent.unregistered`, `agent.health_changed`) to Relay subjects, enabling cross-agent event subscriptions.

## Tasks

The Tasks subsystem provides cron-based agent scheduling. It lives entirely in `apps/server/src/services/tasks/` with state persisted to SQLite (`~/.dork/dork.db`) and JSON (`~/.dork/schedules.json`).

### Key Components

| Module                 | Purpose                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `tasks-store.ts`       | SQLite database + JSON file for schedule and run state                  |
| `scheduler-service.ts` | Cron engine using `croner` with overrun protection and concurrency caps |

### Dispatch Modes

- **Direct mode** (default): `SchedulerService` calls the active runtime's `sendMessage()` directly to start agent sessions
- **Relay mode** (`DORKOS_RELAY_ENABLED=true`): Publishes to `relay.system.tasks.{scheduleId}` instead; `ClaudeCodeAdapter` handles dispatch

Agent-created schedules enter `pending_approval` state and require human approval before activation.

### Cascade Disable on Agent Unregister

When an agent is unregistered from Mesh, all Tasks schedules linked to that `agentId` are automatically disabled via `TasksStore.disableSchedulesByAgentId()`. Agent-linked schedule runs that cannot resolve the agent's project path fail with a descriptive error rather than falling back silently.

## Testing

All hooks and components use mock `Transport` objects injected via `TransportProvider` in test wrappers:

```typescript
function createMockTransport(overrides?: Partial<Transport>): Transport {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    // ...all Transport methods (session, tasks, relay, mesh, agent identity, etc.)
    ...overrides,
  };
}

function createWrapper(transport: Transport) {
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}
```

This pattern replaces the previous relative `vi.mock()` approach, providing better type safety and more explicit test setup.
