# DorkOS Architecture

## Overview

The DorkOS uses a hexagonal (ports & adapters) architecture centered on a **Transport** abstraction layer. This enables the same React client to run in two modes:

1. **Standalone web** -- Express server + HTTP/SSE via `HttpTransport`
2. **Obsidian plugin** -- In-process services via `DirectTransport`, no server needed

## Core Abstraction: Transport Interface

The `Transport` interface (`packages/shared/src/transport.ts`) defines 13 methods that cover all client-server communication:

```
Transport
  createSession(opts)        -> Session
  listSessions()             -> Session[]
  getSession(id)             -> Session
  getMessages(sessionId)     -> { messages: HistoryMessage[] }
  sendMessage(id, content, onEvent, signal, cwd?) -> void
  approveTool(sessionId, toolCallId)        -> { ok: boolean }
  denyTool(sessionId, toolCallId)           -> { ok: boolean }
  getCommands(refresh?)      -> CommandRegistry
  health()                   -> { status, version, uptime }
  getAgentByPath(cwd)        -> AgentManifest | null
  createAgent(cwd, name?, description?, runtime?) -> AgentManifest
  updateAgent(cwd, updates)  -> AgentManifest
  resolveAgents(paths)       -> Record<string, AgentManifest | null>
```

### Key Design Decision: Callback-Based Streaming

`sendMessage` uses `onEvent: (event: StreamEvent) => void` callbacks rather than returning an `AsyncGenerator`. An optional `cwd` parameter is passed through so the SDK uses the correct project directory when resuming sessions. This normalizes both transports:

- **HttpTransport** parses SSE events from a `ReadableStream` and calls `onEvent`
- **DirectTransport** iterates the `AsyncGenerator` from AgentManager and calls `onEvent`

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
    -> App
```

### Obsidian Plugin (`CopilotView.tsx`)

```
// Vault path = workspace/, repo root = its parent (where .claude/ lives)
repoRoot = path.resolve(vaultPath, '..')

AgentManager(repoRoot)          -- resolves Claude CLI, sets cwd
TranscriptReader()              -- reads JSONL from ~/.claude/projects/{slug}/
CommandRegistryService(repoRoot) -- scans repoRoot/.claude/commands/

DirectTransport({ agentManager, transcriptReader, commandRegistry, vaultRoot: repoRoot })
  -> TransportProvider
    -> ObsidianApp -> App
```

## Transport Implementations

### HttpTransport (`apps/client/src/layers/shared/lib/http-transport.ts`)

Communicates with the Express server over HTTP and SSE:

- Standard `fetch()` for CRUD operations
- `POST + ReadableStream` for SSE streaming in `sendMessage`
- Parses `text/event-stream` lines into `StreamEvent` objects
- Constructor takes `baseUrl` (defaults to `/api`)

### DirectTransport (`apps/client/src/layers/shared/lib/direct-transport.ts`)

Calls service instances directly in the same process:

- No HTTP, no port binding, no serialization
- Uses `DirectTransportServices` interface (narrow typed subset of service methods)
- `sendMessage` iterates `AsyncGenerator<StreamEvent>` from AgentManager
- `createSession` generates UUIDs via `crypto.randomUUID()`
- Respects `AbortSignal` for cancellation

## Data Flow

### Standalone Web (HttpTransport)

```
User input -> ChatPanel -> useChatSession.handleSubmit()
  -> transport.sendMessage(sessionId, content, onEvent, signal, cwd)
    -> fetch(POST /api/sessions/:id/messages) + ReadableStream SSE parsing
      -> onEvent(event) -> React state updates -> UI re-render
```

### Obsidian Plugin (DirectTransport)

```
User input -> ChatPanel -> useChatSession.handleSubmit()
  -> transport.sendMessage(sessionId, content, onEvent, signal, cwd)
    -> agentManager.sendMessage() -> SDK query()
      -> AsyncGenerator<StreamEvent>
        -> onEvent(event) -> React state updates -> UI re-render
```

## Module Layout

```
packages/
  shared/src/
    transport.ts            -- Transport interface (the "port")
    types.ts                -- Shared type definitions
    manifest.ts             -- Agent manifest I/O (readManifest, writeManifest, removeManifest)

apps/
  client/src/layers/
    shared/
      model/
        TransportContext.tsx -- React Context DI (useTransport, TransportProvider)
        app-store.ts        -- Zustand UI state store
        use-theme.ts        -- Theme hook (+ 7 other hooks)
      lib/
        http-transport.ts   -- HTTP/SSE adapter
        direct-transport.ts -- In-process adapter
        utils.ts            -- cn() utility
    components/
      App.tsx               -- Main app shell
    main.tsx                -- Standalone entry (HttpTransport)

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
      agent-manager.ts      -- Claude Agent SDK session orchestrator
      agent-types.ts        -- AgentSession/ToolState interfaces
      sdk-event-mapper.ts   -- SDK message → StreamEvent mapper
      context-builder.ts    -- Runtime context for systemPrompt
      interactive-handlers.ts -- Tool approval & question flows
      transcript-reader.ts  -- JSONL session reader
      command-registry.ts   -- Slash command discovery
    lib/
      sdk-utils.ts          -- makeUserPrompt(), resolveClaudeCliPath()
    routes/                 -- Express route handlers
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

**Fix:** `AgentManager` resolves the CLI path dynamically via `resolveClaudeCliPath()`:

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

## Configuration System

DorkOS uses a persistent JSON config file at `~/.dork/config.json` for user preferences. The config system spans three layers: schema, service, and CLI.

### Config File

Location: `~/.dork/config.json` (created automatically on first run). Format:

```json
{
  "version": 1,
  "server": { "port": 4242, "cwd": null },
  "tunnel": { "enabled": false, "domain": null, "authtoken": null, "auth": null },
  "ui": { "theme": "system" }
}
```

### Schema (`packages/shared/src/config-schema.ts`)

`UserConfigSchema` (Zod) defines all config fields with defaults and constraints. Exports:

- `UserConfig` type (inferred from schema)
- `USER_CONFIG_DEFAULTS` (parsed defaults for `conf` constructor)
- `SENSITIVE_CONFIG_KEYS` (fields that trigger warnings: `tunnel.authtoken`, `tunnel.auth`)

### ConfigManager Service (`apps/server/src/services/config-manager.ts`)

Singleton service wrapping the `conf` library for atomic JSON I/O. Key behaviors:

- **Initialization**: `initConfigManager(dorkHome?)` creates the singleton. Called at server startup and in CLI subcommands.
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

## Roadmap App (`apps/roadmap/`)

Standalone roadmap management tool that is **separate from the main DorkOS architecture**. It does NOT use the Transport interface, DirectTransport, or any shared DorkOS services. It is an independent Express + React app.

### Server

Express server on port 4243 (`ROADMAP_PORT` env var). Three route groups mounted at `/api/roadmap/`:

- **`routes/items.ts`** - CRUD for roadmap items (list, get, create, update, delete, reorder) with Zod validation
- **`routes/meta.ts`** - Project metadata and health statistics
- **`routes/files.ts`** - Serves spec files, restricted to `specs/` directory to prevent path traversal

Data persistence via `RoadmapStore` (lowdb JSON adapter). Reads/writes `roadmap.json` — the same file used by the Python utility scripts in `roadmap/scripts/`.

### Client

React 19 SPA with Vite 6, Tailwind CSS 4, and FSD architecture (`src/client/layers/`). Four views:

- **Table View** - TanStack Table with sorting, filtering, and column controls
- **Kanban View** - Drag-and-drop columns by time horizon (`@hello-pangea/dnd`)
- **MoSCoW Grid** - Cards grouped by MoSCoW priority category
- **Gantt View** - Custom timeline visualization

State management: Zustand for UI state, TanStack Query for server state. No auth — designed as a single-user local tool.

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

## Relay

The Relay message bus (`packages/relay/src/`) provides inter-agent messaging and external channel integration. It decouples agents from direct communication concerns using a subject-based pub/sub model inspired by NATS JetStream.

### Adapter Registry

The `AdapterRegistry` (in `packages/relay/src/adapter-registry.ts`) manages external channel adapters that bridge external communication platforms into the Relay subject hierarchy. Each adapter implements the `RelayAdapter` interface (`packages/relay/src/types.ts`) with methods for start, stop, deliver, and status reporting.

The `AdapterManager` (in `apps/server/src/services/relay/adapter-manager.ts`) handles server-side lifecycle: config loading from `~/.dork/relay/adapters.json`, chokidar hot-reload with `awaitWriteFinish`, and Express route integration for adapter management endpoints.

**Adapter data flow:**

```
Inbound:  External message → Adapter.handleInbound() → RelayCore.publish() → Maildir fan-out
Outbound: RelayCore.publish() → AdapterRegistry.deliver() → Adapter.deliver() → External API
```

**Built-in adapters:**

| Adapter | Library | Transport | Subject Prefix |
|---------|---------|-----------|----------------|
| `TelegramAdapter` | grammY | Long polling / webhook | `relay.human.telegram.*` |
| `WebhookAdapter` | Native HTTP | HTTP POST + HMAC-SHA256 | `relay.webhook.*` |

**Error isolation:** `Promise.allSettled()` ensures one adapter crashing never affects others.

**Hot-reload:** Start new adapter → register → stop old. If new adapter fails to start, old stays active (zero message gap).

See `contributing/relay-adapters.md` for the full developer guide on creating custom adapters.

## Relay Convergence (when DORKOS_RELAY_ENABLED=true)

When the Relay feature flag is enabled, both Console (chat) and Pulse (scheduled) message flows are routed through the Relay message bus instead of calling AgentManager directly. This provides unified message tracing, delivery tracking, and subject-based routing.

### Console Message Flow

```
Client POST → relay.publish('relay.agent.{sessionId}') → ClaudeCodeAdapter → agentManager.query() → Claude SDK → response → relay.publish(replyTo) → SSE fan-in → client EventSource
```

### Pulse Dispatch Flow

```
SchedulerService → relay.publish('relay.system.pulse.{scheduleId}') → ClaudeCodeAdapter.handlePulseDispatch() → agentManager.query() → Claude SDK
```

### Message Tracing

Every `relay.publish()` records a TraceSpan in SQLite. API: `GET /api/relay/messages/:id/trace`, `GET /api/relay/trace/metrics`.

## Mesh

The Mesh subsystem (`packages/mesh/src/`) provides agent discovery, registration, and lifecycle management. It enables DorkOS to detect and coordinate with other AI coding agents running on the same machine or network.

### Core Components

| Module | Purpose |
|--------|---------|
| `mesh-core.ts` | Main entry point composing discovery, registry, denial list, and Relay bridge |
| `discovery-engine.ts` | Scans directories for agent workspaces using pluggable strategies |
| `agent-registry.ts` | SQLite-backed persistent registry of known agents |
| `denial-list.ts` | Tracks explicitly denied agents to prevent re-discovery |
| `namespace-resolver.ts` | Resolves agent namespaces for subject-based routing |
| `topology.ts` | Computes network topology views with cross-namespace rules |
| `budget-mapper.ts` | Maps Relay budget envelopes to mesh agent capabilities |
| `relay-bridge.ts` | Optional bridge publishing lifecycle events to Relay subjects |
| `manifest.ts` | Reads/writes `.dork/agent.json` manifest files |

### Discovery Strategies

Three pluggable strategies detect different agent types:

| Strategy | Detects | Signal |
|----------|---------|--------|
| `ClaudeCodeStrategy` | Claude Code workspaces | `.claude/` directory with `settings.json` |
| `CursorStrategy` | Cursor editor sessions | `.cursor/` directory |
| `CodexStrategy` | OpenAI Codex agents | `.codex/` directory |

### Server Integration

The server exposes Mesh via `routes/mesh.ts` (feature-flag guarded by `DORKOS_MESH_ENABLED`). MCP tools in `mcp-tool-server.ts` allow agents to discover, register, and inspect the mesh programmatically.

### Relay Bridge

When both Mesh and Relay are enabled, `RelayBridge` publishes lifecycle events (`agent.registered`, `agent.unregistered`, `agent.health_changed`) to Relay subjects, enabling cross-agent event subscriptions.

## Pulse

The Pulse subsystem provides cron-based agent scheduling. It lives entirely in `apps/server/src/services/pulse/` with state persisted to SQLite (`~/.dork/pulse.db`) and JSON (`~/.dork/schedules.json`).

### Key Components

| Module | Purpose |
|--------|---------|
| `pulse-store.ts` | SQLite database + JSON file for schedule and run state |
| `scheduler-service.ts` | Cron engine using `croner` with overrun protection and concurrency caps |

### Dispatch Modes

- **Direct mode** (default): `SchedulerService` calls `AgentManager.query()` directly to start agent sessions
- **Relay mode** (`DORKOS_RELAY_ENABLED=true`): Publishes to `relay.system.pulse.{scheduleId}` instead; `ClaudeCodeAdapter` handles dispatch

Agent-created schedules enter `pending_approval` state and require human approval before activation.

## Testing

All hooks and components use mock `Transport` objects injected via `TransportProvider` in test wrappers:

```typescript
function createMockTransport(overrides?: Partial<Transport>): Transport {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    // ...all 13 methods
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
