# DorkOS Architecture

> **Sync note:** A condensed, user-facing version of this guide is published on the docs site at `docs/contributing/architecture.mdx`. When you change the architecture here, update that page too so the two do not drift.

## Overview

The DorkOS uses a hexagonal (ports & adapters) architecture centered on a **Transport** abstraction layer. This enables the same React client to run in two modes:

1. **Standalone web** -- Express server + HTTP via `HttpTransport`, with the durable streams over WebSocket (ADR 260805-041016)
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
  getSessionSnapshot(sessionId, cwd?) -> SessionSnapshot
  subscribeSession(sessionId, sinceCursor?, cwd?, signal?) -> AsyncIterable<SessionEvent>
  subscribeSessionList()         -> AsyncIterable<SessionListEvent>
  postMessage(id, content, cwd?, options?) -> { sessionId }   # trigger-only, 202
                                          # options: { clientMessageId?, uiState? }
  approveTool(sessionId, toolCallId)  -> { ok: boolean }
  denyTool(sessionId, toolCallId, reason?) -> { ok: boolean }
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
  -- The web client always uses postMessage + the durable session event stream.

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

### Key Design Decision: Trigger + Durable Stream

`postMessage` is trigger-only: it starts the turn and resolves to the canonical session id (ADR-0264). Delivery happens on the durable session event stream — `getSessionSnapshot` hydrates, `subscribeSession(sessionId, sinceCursor)` yields `SessionEvent`s with monotonic `seq` for gap-free resume. An optional `options` bag supports `clientMessageId` for server-echo ID reconciliation and `uiState` for passing a client UI state snapshot to the agent (see [Agent UI Control](#agent-ui-control)). This normalizes both transports:

- **HttpTransport** maps the streams to `GET /api/sessions/:id/events` and `GET /api/events` (WebSocket; the same paths also serve SSE for integrations — ADR 260805-041016)
- **DirectTransport** iterates the runtime's async generators in-process

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

**The home surface is a layout, not a route.** `/`, `/activity`, `/tasks` and `/workspaces` are one tabbed place, and the tab bar is a second pathless layout route (`_home`, `widgets/home/ui/HomeSurfaceLayout.tsx`) nested inside `_shell`. Because it uses `id` rather than `path` and declares no `validateSearch`, the four pages keep their exact addresses, their own search schemas and their own loaders, so `/activity?categories=agent` still arrives with its filter applied. The active tab is derived from `location.pathname` on every render — there is no tab state to keep in sync with the URL. `shared/config/home-surface.ts` owns the list of those four paths; the tab bar reads it to name the tabs and `features/dashboard-sidebar` reads it to keep the sidebar's single **Home** entry lit across all four.

Each route provides its own sidebar and header content via private slot hooks in `AppShell` (`useSidebarSlot` / `useHeaderSlot`). The sidebar body and header cross-fade on route change via `AnimatePresence`. `/` renders `DashboardSidebar` + `DashboardHeader`; `/session` keeps the same `DashboardSidebar` roster (the old session drill-in was retired — per-session context now lives in the right-panel inspector) with the `SessionHeader`. A registered `sidebar.body` contribution can take over the body wholesale for its route (the marketplace facet panel does this on `/marketplace`). `SessionSidebar` still exists but only as the Obsidian plugin's chrome (`apps/client/src/App.tsx`), not the web shell.

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

Communicates with the Express server over HTTP, with the durable streams on WebSockets:

- Standard `fetch()` for CRUD operations
- `postMessage` POSTs the trigger and parses the `202 { sessionId }` body
- `subscribeSession`/`subscribeSessionList` consume the durable streams (`GET /sessions/:id/events`, `GET /events`) over WebSocket, validating frames against `@dorkos/shared/session-stream`
- `uploadFiles` uses XHR with `FormData` for progress tracking
- Constructor takes `baseUrl` (defaults to `/api`)

Domain-specific methods (Relay, Tasks, Mesh) are delegated to factory-produced objects to keep concerns separated:

- `createRelayMethods(baseUrl, getClientId)` — Relay bus, adapters, bindings, events
- `createTasksMethods(baseUrl)` — Tasks schedules and runs
- `createMeshMethods(baseUrl)` — Mesh discovery, registry, topology
- `createMarketplaceMethods(baseUrl)` — Marketplace sources, package listing, install/uninstall/update, cache (`apps/client/src/layers/shared/lib/transport/marketplace-methods.ts`)

HttpTransport uses `Object.assign(this, createRelayMethods(...))` at construction time. Each factory lives in its own file under `transport/` and handles HTTP serialization for its domain. This keeps the Transport interface unified while allowing independent testability of domain methods.

### DirectTransport (`apps/client/src/layers/shared/lib/direct-transport.ts`)

Calls service instances directly in the same process:

- No HTTP, no port binding, no serialization
- Uses `DirectTransportServices` interface (narrow typed subset of service methods)
- `getSessionSnapshot`/`subscribeSession`/`subscribeSessionList` iterate the runtime's async generators in-process
- `uploadFiles` copies files to disk via Node.js `fs` (no HTTP)
- `createSession` generates UUIDs via `crypto.randomUUID()`
- Respects `AbortSignal` for cancellation

**Scope limitation:** DirectTransport currently implements only session, message, tool, task, and agent APIs. Relay, Mesh, and Tasks methods are not available in DirectTransport (Obsidian plugin mode) — these features require server-side state and are scoped for the standalone web client.

### Authentication across the Transport seam

Optional local login (Better Auth) rides the same seam without changing the Transport interface:

- **HttpTransport** sends `credentials: 'include'` on every fetch path (the central `fetchJSON` in `shared/lib/transport/http-client.ts`, plus `ws-connection.ts` and `session-stream-methods.ts`, whose sockets carry the cookie on the handshake). The Better Auth session cookie rides the browser cookie jar, so the constructor needs no token wiring. When a gated request returns `401 { code: 'AUTH_REQUIRED' }`, the client's auth-required signal flips and `AuthGuard` (`features/auth`) renders the `LoginScreen`. Machine callers may instead send `Authorization: Bearer <api-key>`.
- **DirectTransport** (Obsidian embedded mode) stays **unauthenticated** — it calls service instances in-process with no HTTP boundary to gate, and the embedded shell never mounts `AuthGuard`. Progressive disclosure means no user concept appears there.

Server-side, the single `sessionGate` middleware enforces this for `/api/*` and `/mcp` only when `config.auth.enabled` is true; otherwise it is a zero-overhead pass-through. See `contributing/authentication.md` for the full auth architecture.

## Data Flow

### Standalone Web (HttpTransport)

`POST /api/sessions/:id/messages` is trigger-only (ADR-0264): it returns `202 { sessionId }` (the canonical id) and the turn runs detached server-side. ALL turn delivery — and cross-client sync — rides the durable per-session stream `GET /api/sessions/:id/events` (snapshot → gap-free replay via `Last-Event-ID` → live `SessionEvent`s with monotonic `seq`), owned client-side by `StreamManager` (`shared/lib/transport/stream-manager.ts`).

```
User input -> ChatPanel -> useChatSession.handleSubmit()
  -> transport.postMessage(sessionId, content, cwd) -> POST /api/sessions/:id/messages -> 202
  -> turn runs detached; runtime StreamEvents feed the per-session projector (monotonic seq)

Delivery (always, for every subscribed client):
  -> GET /api/sessions/:id/events (durable stream: snapshot -> replay -> live)
    -> StreamManager validates SessionEvent frames -> session stream store applies them
      -> React state updates -> UI re-render

Session list (sidebar/liveness):
  -> GET /api/events (global stream) -> session_upserted / session_removed / session_status
```

See [Agent UI Control](#agent-ui-control) for the bidirectional UI-command pattern.

### Obsidian Plugin (DirectTransport)

```
User input -> ChatPanel -> useChatSession.handleSubmit()
  -> transport.postMessage(sessionId, content, cwd)
    -> runtime.sendMessage() -> SDK query() (turn runs detached)
  -> StreamManager pump iterates transport.subscribeSession()
    -> SessionEvents -> session stream store -> React state updates -> UI re-render
```

## Tabbed Dialog Primitive (`TabbedDialog`)

`apps/client/src/layers/shared/ui/tabbed-dialog.tsx` is the high-level primitive for any sidebar-tabbed dialog in DorkOS. It owns the responsive sidebar, mobile drill-in behavior, animated active-tab pill, deep-link sync via `useDialogTabState`, and extension-slot merging. Both `SettingsDialog` and `AgentDialog` consume it as thin declarative wrappers around a `tabs[]` array.

**Reach for `TabbedDialog` when you need:**

- A sidebar-navigated dialog with multiple tabs
- Deep-link entry points ("open dialog X to tab Y")
- Responsive mobile drill-in behavior

**Reach for `NavigationLayout` directly when you need:**

- A bare layout primitive without a `ResponsiveDialog` wrapper (e.g., embedded in a non-modal page)
- Tab content that needs to live outside the parameterless `component: ComponentType` shape
- Custom dialog chrome that doesn't fit the `TabbedDialog` API

Keyboard navigation inside the dialog is handled by `NavigationLayout`'s built-in `role="tablist"` — `Tab` into the sidebar, then `Up/Down/Home/End` to navigate between tabs. `TabbedDialog` does **not** register numeric modifier shortcuts (`⌘1-⌘9`) — those conflict with Chrome's browser-level tab-switching on macOS.

For the underlying state-sync hook, see `useDialogTabState` in `shared/model/` (documented in `contributing/state-management.md`).

## Dialog deep linking via URL search params

DorkOS dialogs (Settings, Agent, Tasks, Relay, Mesh) are URL-addressable via search params on every route. The `dialogSearchSchema` is merged into each route's `validateSearch` schema; consumers use the per-dialog hooks in `@/layers/shared/model`:

- `useSettingsDeepLink()` — Settings dialog with tab + sub-section deep links
- `useAgentDialogDeepLink()` + `useOpenAgentDialog()` — Agent dialog with `agentPath`
- `useTasksDeepLink()` / `useRelayDeepLink()` / `useMeshDeepLink()` — parameterless dialogs

`RegistryDialog` reads BOTH the URL signal and the existing store flag (`storeOpen || urlSignal.isOpen`) so legacy store-based opens continue to work. Closing the dialog clears both signals. Use the URL hooks for any new cross-page open.

Example URLs:

- `/?settings=tools` — Settings on Dashboard, Tools tab
- `/team?settings=tools&settingsSection=external-mcp` — Settings on the Team page, Tools tab, scrolled to External MCP
- `/?agent=identity&agentPath=/abs/path/to/repo` — Agent dialog → Identity for that project

## Agent UI Control

Agents can observe and control the DorkOS client UI through a bidirectional pattern:

**Client → Agent** (UI state awareness): The client captures a `UiState` snapshot (canvas, panels, sidebar, active agent) and passes it via `postMessage(id, content, cwd, { uiState })`. The server forwards this to the SDK as context injection, giving the agent situational awareness of what the user sees.

**Agent → Client** (UI commands): The agent calls the `control_ui` MCP tool, which validates a `UiCommand` via `UiCommandSchema` and emits a `ui_command` stream event to the durable stream. The client dispatches this via `executeUiCommand()` (`layers/shared/lib/ui-action-dispatcher.ts`), a pure side-effect dispatcher that mutates the Zustand store.

A companion `get_ui_state` MCP tool lets agents query the current UI state without sending a message.

### UiCommand Actions

| Action                                        | Effect                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `open_canvas`                                 | Opens the canvas panel with URL, markdown, or JSON content                                   |
| `update_canvas`                               | Updates canvas content without toggling visibility                                           |
| `close_canvas`                                | Closes the canvas panel                                                                      |
| `open_panel` / `close_panel` / `toggle_panel` | Controls named panels (settings, pulse, relay, mesh, picker)                                 |
| `open_sidebar` / `close_sidebar`              | Controls sidebar visibility                                                                  |
| `switch_sidebar_tab`                          | Switches the sidebar to a named tab (embedded Obsidian app only; a no-op on the web cockpit) |
| `show_toast`                                  | Shows a toast notification (success, error, info, warning)                                   |
| `set_theme`                                   | Switches between light and dark theme                                                        |
| `scroll_to_message`                           | Scrolls chat to a specific message ID                                                        |
| `switch_agent`                                | Switches to a different agent by working directory                                           |
| `open_command_palette`                        | Opens the command palette                                                                    |

### Key Types

- `UiState` — client snapshot (canvas, panels, sidebar, agent) passed to the agent
- `UiCanvasContent` — discriminated union (`url` | `markdown` | `json`) for canvas payloads
- `UiCommand` — discriminated union on `action` (14 variants)
- `UiCommandEvent` — stream event wrapper (`{ type: 'ui_command', command }`)

All types defined in `packages/shared/src/schemas.ts`, re-exported from `packages/shared/src/types.ts`.

### Files

| File                                                                  | Purpose                                                                             |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/shared/src/schemas.ts`                                      | `UiStateSchema`, `UiCommandSchema`, `UiCommandEventSchema`, `UiCanvasContentSchema` |
| `apps/server/src/services/runtimes/claude-code/mcp-tools/ui-tools.ts` | `control_ui` and `get_ui_state` MCP tool definitions                                |
| `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts`           | `executeUiCommand()` — pure dispatcher, no React deps                               |

## Runtime Registry

DorkOS abstracts agent backends behind the `AgentRuntime` interface (`packages/shared/src/agent-runtime.ts`). Routes and services interact with every backend through this one contract; three production runtimes implement it — **Claude Code** (default), **Codex**, and **OpenCode** — plus the deterministic **test-mode** runtime for e2e.

### Adapter Lineup

Each adapter lives in its own directory under `apps/server/src/services/runtimes/`, owning its SDK behind an ESLint boundary:

```
services/runtimes/
├── claude-code/   # @anthropic-ai/claude-agent-sdk — default runtime (JSONL transcripts, MCP tools, plugins)
├── codex/         # @openai/codex-sdk — SDK-thread adapter (ADR-0309)
├── opencode/      # @opencode-ai/sdk — managed `opencode serve` sidecar (ADR-0308)
└── test-mode/     # scripted scenario runtime for e2e (DORKOS_TEST_RUNTIME)
```

**Codex — the SDK-thread model (ADR-0309).** One DorkOS session maps to one Codex thread. The sessionId↔threadId map is durable adapter-owned state (`codex_threads` table via `CodexThreadMap`, first-write-wins); `sendMessage` drives the SDK's `runStreamed()`, and `event-mapper.ts` converts thread events to `StreamEvent`s. Codex has no interactive approval channel (`supportsToolApproval: false`) — permission posture is upfront sandbox selection instead, with the shared permission-mode ids mapping onto sandbox levels (`default` → read-only, `acceptEdits` → workspace-write, `bypassPermissions` → full access). The SDK cannot enumerate past threads, so after a server restart earlier Codex sessions drop out of `listSessions` (resume of known sessions still works via the thread map).

**OpenCode — the sidecar model (ADR-0308).** One managed `opencode serve` process per DorkOS server (`server-manager.ts`): lazily spawned on first OpenCode use, bound to `127.0.0.1` with per-boot basic-auth credentials, health-checked with an exponential-backoff restart ladder, and torn down (SIGTERM → SIGKILL) in `shutdownServices()`. All I/O rides the SDK — OpenCode's own session store is opaque to DorkOS. A single global SSE subscription (`global-event-hub.ts`) fans events out per session (one subscription per runtime, not per session); `approvals.ts` forwards OpenCode permission requests through the standard tool-approval flow (answered `once`/`reject` only, never `always`, so OpenCode-side rule state cannot diverge from DorkOS). OpenCode is also the open-source-model path: its provider catalog (Ollama, any OpenAI-compatible endpoint) surfaces in the DorkOS model picker as `provider/model` options.

Both new adapters register at the composition root (`apps/server/src/index.ts`), gated on `runtimes.codex.enabled` / `runtimes.opencode.enabled` config, and probe their external requirements (binary + auth) via `checkDependencies()` — surfaced through `GET /api/system/requirements` and the client's needs-setup flow. Every runtime must pass the shared conformance suite (`runtimeConformance(makeRuntime)` from `@dorkos/test-utils`). The full checklist for adding runtime #4 is `contributing/adding-a-runtime.md`.

### AgentRuntime Interface

The `AgentRuntime` interface defines all operations that an agent backend must support:

- **Session lifecycle**: `ensureSession`, `hasSession`, `updateSession`
- **Messaging**: `sendMessage` (returns `AsyncGenerator<StreamEvent>`)
- **Interactive flows**: `approveTool`, `submitAnswers`, `interruptQuery`
- **Session queries**: `listSessions`, `getSession`, `getMessageHistory`, `getSessionTasks`, `getSessionETag`, `getLastMessageIds`, `readFromOffset`
- **Hydration & streaming**: `getSessionSnapshot`, `subscribeSession` (resumable, monotonic `seq`), `subscribeSessionList`
- **Session locking**: `acquireLock`, `releaseLock`, `isLocked`, `getLockInfo`
- **Capabilities**: `getSupportedModels`, `getCapabilities` (returns `RuntimeCapabilities`)
- **Dependency checks**: `checkDependencies` (binary/auth probes behind `GET /api/system/requirements` and the client's needs-setup flow)
- **Commands**: `getCommands`
- **Lifecycle**: `checkSessionHealth`, `getInternalSessionId`
- **Optional DI**: `setMcpServerFactory?`, `setMeshCore?`, `setRelay?`, `setSessionSettings?`

### RuntimeCapabilities

Each runtime declares static capability flags via `getCapabilities()`:

| Field                       | Description                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                      | Runtime type identifier (`claude-code`, `codex`, `opencode`, `test-mode`)                                                                                                 |
| `supportsToolApproval`      | Whether tool approval UI should be shown                                                                                                                                  |
| `supportsCostTracking`      | Whether dollar-cost tracking is available (gates the cost strip)                                                                                                          |
| `supportsResume`            | Whether sessions can be resumed                                                                                                                                           |
| `supportsMcp`               | Whether DorkOS can inject its MCP tool server                                                                                                                             |
| `supportsManagedMcpServers` | Whether DorkOS can inject an agent's own managed MCP servers — the Agent Hub Toolkit tab's "Add server" affordance — distinct from `supportsMcp`'s in-process tool server |
| `supportsQuestionPrompt`    | Whether the AskUserQuestion interactive flow is supported                                                                                                                 |
| `supportsPlugins`           | Whether marketplace plugins / plugin commands apply                                                                                                                       |
| `permissionModes`           | Structured mode declaration: `{ supported, default, values[] }` — the picker renders exactly this set                                                                     |
| `nativeContext`             | Context kinds the runtime injects natively (ADR-0273)                                                                                                                     |
| `features`                  | Open extension map for runtime-specific flags (ADR-0256)                                                                                                                  |

Capability-gated UI renders only what the active runtime declares — e.g. the cost strip is absent on Codex (`supportsCostTracking: false`, token usage only), and the permission picker shows Codex's sandbox levels rather than Claude's modes.

### RuntimeRegistry

`RuntimeRegistry` (`apps/server/src/services/core/runtime-registry.ts`) is a singleton that holds all registered runtime implementations.

Key methods:

- `register(runtime)` — register or replace a runtime by its `type` string
- `getDefault()` / `getDefaultType()` / `setDefault(type)` — the default runtime (claude-code unless changed). Shape-neutral: callers use only the `AgentRuntime` interface, so any registered runtime is a valid default. The relay's Claude Code adapter, which genuinely needs Claude-specific methods, binds the concrete claude-code runtime at the composition root instead (`relayAgentRuntime` in `index.ts`, passed as an `agentRuntimes` map keyed by the runtime's own `type`). The relay's binding subsystem prefers `getDefaultType()` when choosing where to create chat-originated sessions, but falls back — with a log — to the runtime the relay actually holds rather than disabling routing
- `resolveForSession(sessionId)` — per-session dispatch: reads the session's immutable runtime binding from `session_metadata` (ADR-0255)
- `persistSessionRuntime(sessionId, type)` — records the binding when the session starts, **first-write-wins** (a session's runtime never changes after that). A row created earlier by a settings change carries no runtime, and this call claims it; a row that already names one is left alone
- `resolveForAgent(agentId, meshCore?)` — looks up the agent's manifest to determine which runtime to use, falling back to the default
- `listRuntimes()` — all registered runtimes (powers session-list aggregation)
- `getAllCapabilities()` — returns capability flags for all registered runtimes (used by `GET /api/capabilities`)

### How Routes Use the Registry

Routes never reference a specific runtime class. Session-scoped routes resolve the session's own runtime; the session list aggregates across all of them:

```typescript
import { runtimeRegistry } from '../services/core/runtime-registry.js';

// Per-session routes dispatch on the session's persisted runtime (ADR-0255)
const runtime = await runtimeRegistry.resolveForSession(sessionId);

// Listing aggregates every registered runtime (ADR-0310)
const { sessions, warnings } = await aggregateSessionList({
  runtimes: runtimeRegistry.listRuntimes(),
  projectDir,
});
```

For a **new** session, `resolveRuntimeTypeForNewSession` (`routes/sessions.ts`) picks the type — explicit `body.runtime` hint (or `?runtime=` launch param) > agent manifest `runtime` field > registry default — and `persistSessionRuntime` freezes it there, on the first message.

A session that has not sent one yet has **no** runtime, and `session_metadata.runtime` is NULL to say so. Changing a setting before the first message (the pre-launch picker) creates the row, and that write deliberately names no runtime and seeds no defaults: it does not know which runtime the session will run on, and every default is a per-runtime answer. Reads resolve an unbound row exactly like a row-less one — by inference, never persisted — so nothing is blocked in the meantime (DOR-812).

### Aggregated Session Listing (ADR-0310)

Session storage stays **runtime-owned** — Claude Code's JSONL transcripts, Codex's SDK threads, OpenCode's own store — with no unified transcript database. `GET /api/sessions` and the global session-list stream aggregate instead:

- `aggregateSessionList` (`services/session/aggregate-session-list.ts`) fans out `listSessions` across `listRuntimes()` with `Promise.allSettled` and a per-runtime time budget, merges and sorts by `updatedAt`, and tags every session with its `runtime` type. A failing or slow runtime degrades to partial results plus a `warnings[]` entry in the response envelope — never a failed request. An optional `?runtime=` query filters to one runtime.
- `session-list-broadcaster` (`services/session/session-list-broadcaster.ts`) fans in `subscribeSessionList` across all registered runtimes with per-runtime failure isolation, feeding the global `GET /api/events` stream. Runtimes must register **before** the broadcaster starts (see the composition-root ordering in `index.ts`).

### Per-Session Settings Persistence (ADR-0260 / ADR-0261)

Per-session settings — `permissionMode`, `model`, `effort`, `fastMode` — are **owned by the API core layer**, not by any runtime. They are persisted in the `session_metadata` table (the same table that holds immutable runtime ownership; settings columns use last-write-wins, identity columns first-write-wins). Runtimes stay pure executors.

**The seam mirrors `AgentRegistryPort`/`RelayPort`:** the core exposes a narrow `SessionSettingsPort` (`getSessionSettings`/`saveSessionSettings`/`rekeySessionSettings`, implemented by `RuntimeRegistry`) and injects it into a runtime via the optional `setSessionSettings?(port)` setter at the composition root (`apps/server/src/index.ts`). A new runtime gains durable settings by accepting that one port — no DB code of its own.

**Source-of-truth model:**

- **Persisted store = truth.** It survives idle eviction (30-min `checkSessionHealth`) and server restart.
- **In-memory session = warm cache.** Needed for the live `query.setPermissionMode` and per-turn reads.
- **SDK transcript = legacy fallback only** (sessions created before this feature).

**Flow (claude-code):**

- **Hydrate** in `ensureForMessage` — the funnel every send path shares (HTTP, Tasks, relay). When the in-memory session is absent, seed from the port. Precedence: `per-send override → persisted → runtime default` (the runtime declares its default via `RuntimeCapabilities.permissionModes.default`).
- **Write-through** in `updateSession` — persist the operator's change first (durable even if the live apply fails), then best-effort `setPermissionMode`. Only user-driven PATCHes reach `updateSession`, so transient per-send overrides are never persisted.
- **Display overlay** in `services/session/session-settings-overlay.ts` — the one projection of the store onto a `Session` for display, shared by every path that hands a session to a client: `GET /`, `GET /:id`, `GET /recent`, and the `session_upserted` fan-out in `SessionListBroadcaster`. Keeping them on one helper is what makes the session-list badge, the in-session toolbar, and runtime enforcement read one value; four separate derivations is exactly how they came to disagree (DOR-463).
- **One key.** The overlay resolves each session's store key through `getInternalSessionId(id) ?? id` — the same translation `PATCH /:id` uses to WRITE — and reads that key and no other. A read that keys by the raw id alone misses the row the operator just wrote; a read that tries several keys makes the answer depend on which id the caller asked by.
- **Re-key on rebind.** The adapter moves the row the moment it binds a new canonical id (`SessionStore.rebindSdkSession` → `rekeySessionSettings`, DOR-493), so the operator's choice follows the session instead of being stranded under the id it was written for. Without the move, a turn sent under the canonical id after eviction or a restart hydrates a miss and the runtime ENFORCES its default mode instead of the operator's. Claude-code is the only runtime that aliases at all; the others return `undefined` from `getInternalSessionId` and never re-key. The property to keep is **an operator's explicit choice never loses to anything that is not a newer operator's explicit choice** — and the merge cannot keep it alone, because the rows record no provenance: an operator's `plan` and a server-seeded `acceptEdits` are the same shape once written. Both merge directions were measured wrong on some input (source-wins loses a newer operator choice; destination-wins loses a real one to a seeded default, since `persistSessionRuntime` INSERTs rows pre-filled from `runtimes.defaultTrustStop`). What keeps it is **ordering**: the row moves before the event that lets `trigger-turn` announce the canonical id, and nobody can name an id they have not been told — so by the time a POST can arrive under the new id, the row is there and bound, nothing is seeded, and nothing is counted as a second session. Destination-wins per field is what remains, correct for the one input still reachable: two rows that both hold operator choices. The move is also **best-effort at the seam**: a settings-store failure warns and leaves the row where it was rather than failing the turn, while the id alias is published either way (approvals, interrupt and the event stream all resolve through it). Note what this does not buy — a session can still end up with two rows if a stale client POSTs under the retired id, because `persistSessionRuntime` mints one for whatever id it is handed (DOR-837). The re-key moves the row; it does not reserve the id it vacated.
- **Retired ids never reach a list.** `aggregateSessionList` drops any session whose runtime aliases it onto a different canonical id, because every single-session route resolves that id to the successor. The invariant it buys: every id in a listing resolves to itself.

Every claude-code query is launched with `allowDangerouslySkipPermissions: true` (ADR-0261) — a pure capability gate the SDK consults only in `bypassPermissions` mode (verified inert in other modes), so the operator can switch a live session to bypass instantly instead of the SDK rejecting the escalation.

### File Organization

Each adapter is self-contained in its directory (see [Adapter Lineup](#adapter-lineup) above for `codex/` and `opencode/`). All Claude Code-specific services live under `services/runtimes/claude-code/`:

| File                                 | Purpose                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `claude-code-runtime.ts`             | `ClaudeCodeRuntime` class implementing `AgentRuntime` (composition root)          |
| `agent-types.ts`                     | `AgentSession` and `ToolState` interfaces (shared across subdirs)                 |
| `runtime-constants.ts`               | Shared constants used across ClaudeCodeRuntime modules                            |
| `index.ts`                           | Barrel export for `ClaudeCodeRuntime`                                             |
| `messaging/message-sender.ts`        | Extracted send-message logic (streaming, tool-group resolution, context building) |
| `messaging/context-builder.ts`       | Runtime context injection for system prompt                                       |
| `messaging/interactive-handlers.ts`  | Tool approval, question flows, and MCP elicitation                                |
| `messaging/permission-mode-guard.ts` | Resolves the effective permission mode (incl. auto-mode fallback)                 |
| `messaging/runtime-cache.ts`         | `RuntimeCache` — caches models, subagents, and other slow-fetch runtime data      |
| `sdk/sdk-event-mapper.ts`            | Thin dispatcher: SDK message to `StreamEvent` (routes to `event-mappers/`)        |
| `sdk/event-mappers/`                 | Per-category mappers (system / stream / message / result)                         |
| `sdk/sdk-error-mapping.ts`           | SDK error/refusal subtype to `ErrorCategory` surfacing                            |
| `sdk/sdk-utils.ts`                   | `makeUserPrompt()`, `resolveClaudeCliPath()`                                      |
| `sdk/build-task-event.ts`            | Task event builder                                                                |
| `sessions/transcript-reader.ts`      | JSONL session data reader                                                         |
| `sessions/transcript-parser.ts`      | JSONL line parser                                                                 |
| `sessions/task-reader.ts`            | Task state parser                                                                 |
| `sessions/session-store.ts`          | `SessionStore` — in-memory store for active `AgentSession` objects                |
| `sessions/session-list-watcher.ts`   | Fleet-wide session-list watcher backing `subscribeSessionList` (file watching)    |
| `sessions/question-answers.ts`       | Structured-question answer mapping                                                |
| `tooling/tool-filter.ts`             | Per-agent MCP tool-group resolution (`resolveToolConfig`)                         |
| `tooling/command-registry.ts`        | Slash command discovery                                                           |
| `mcp-tools/`                         | MCP tool server (core, tasks, relay, mesh, adapter, binding, UI, extension tools) |

Every runtime SDK is contained exclusively within its adapter directory, enforced by `no-restricted-imports` rules in the server's `eslint.config.js` (shared ban constants):

| SDK                              | Confined to                      |
| -------------------------------- | -------------------------------- |
| `@anthropic-ai/claude-agent-sdk` | `services/runtimes/claude-code/` |
| `@openai/codex-sdk`              | `services/runtimes/codex/`       |
| `@opencode-ai/sdk`               | `services/runtimes/opencode/`    |

No other server code imports a runtime SDK directly.

### Subagent Text Streaming

When the main agent spawns a subagent via the `Task` tool, the subagent's output is streamed live into that task's inline block. Two non-obvious facts make this work:

- **The SDK forwards whole messages, not deltas.** With `forwardSubagentText` (SDK 0.3.168+), a subagent's output arrives as complete `assistant` messages tagged with `parent_tool_use_id` — _not_ as token-level stream deltas. `sdk/event-mappers/message-event-mapper.ts` detects the tag, extracts each text block, and emits a `subagent_text_delta` stream event carrying `{ parentToolUseId, text }`. Non-text blocks (tool_use / thinking) are dropped — v1 is text only.
- **The client correlates back to the spawning task.** `handleSubagentTextDelta` (`apps/client/src/layers/features/chat/model/stream/stream-tool-handlers.ts`) resolves the event's `parentToolUseId` to the spawning `Task` part via `findBackgroundTaskPartByToolUseId` (the `toolUseId` retained when the background task started), then appends `text` to that part's `subagentText`. The text renders inside the task's block (`SubagentBlock.tsx`). Deltas that arrive before the task is known are dropped.

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

## Community Registry (the fourth seam)

`CommunityAdapter` (`packages/shared/src/community-adapter.ts`) is the fourth swappable seam beside `AgentRuntime`, `Transport` and `ConnectorProvider`. It lets one local server read and write rooms in more than one place — this machine's SQLite rooms, a foreign relay, a hosted community — without the cockpit, the router or the session spine learning that more than one place exists. **The client's `Transport` is unchanged**: the seam is entirely server-side, so keys never touch the browser and there is one render path and one streaming model.

One instance serves one community, so every address on the port is the pair `(community, roomId)`. `CommunityRegistry` (`apps/server/src/services/communities/registry.ts`) dispatches on the community and holds the human-readable label; `aggregateCommunityRooms` lists across communities with per-community degradation and `warnings[]` — ADR-0310's shape with the nouns changed. Backend differences are **declared capabilities with branched conformance assertions**, never softened shared ones, and `communityConformance` in `@dorkos/test-utils` is the gate. The first backend behind it is this machine's own rooms: `LocalCommunityAdapter` (`apps/server/src/services/communities/local/`) wraps the shipped `RoomService` rather than replacing it, and is registered as `LOCAL_COMMUNITY` at startup so the registry always holds the one community that certainly exists. Author guide: [adding-a-community-adapter.md](adding-a-community-adapter.md).

## Read State (ADR 260808-140956)

**`read_cursors` is the single user-side read-state store.** One table in `@dorkos/db` (`packages/db/src/schema/read-cursors.ts`) answers "how far has this person read" for every kind of thread: `(user_id, thread_kind, thread_id) → last_read_seq, updated_at`, with `thread_kind` constrained to `room | session | inbox`. `last_read_seq` is a position, not a time, so both sides compare integers on a key. `thread_id` is opaque and carries no foreign key: the three kinds live in three stores, one of them (sessions) not in this database at all because session storage is runtime-owned (ADR-0310), and a cursor stays meaningful for a thread that has been deleted.

`user_id` is an `authors.id` (what `resolveCaller(res).id` returns, the same namespace as `room_members.author_id`) and **never the Better Auth `user.id`**. The two are indistinguishable strings for the same human, so the mistake lands silently: the person gets a second row per thread and their divider resets the moment login is toggled.

### Two cursors, two questions

| Column                       | Whose        | Answers                                 | Written by                                                                       |
| ---------------------------- | ------------ | --------------------------------------- | -------------------------------------------------------------------------------- |
| `read_cursors.last_read_seq` | a **person** | which entries this human has looked at  | that person's client, through the HTTP route below                               |
| `room_members.last_read_seq` | an **agent** | which entries have been **shown** to it | the ambient participation loop (`services/rooms/room-trigger.ts`), never a route |

The membership column survives Phase 3 unchanged as the RP3 delivery cursor (room-participation spec §8.3): it advances as entries are handed to an agent and is rewound when a claimed turn refuses. The two read the same-looking integer and are never substituted for each other, and no migration collapses them.

### One write path

`PUT /api/read-cursors/:kind/:id` (`apps/server/src/routes/read-cursors.ts`), plus `GET` of the same address, is the only way a cursor moves. Its own router rather than more surface on `rooms.ts`, because two of the three kinds are not rooms.

- **People only.** The check is on the resolved caller's `kind`, not on the presence of an `X-DorkOS-Agent` header, so a fourth `resolveCaller` branch keeps the boundary rather than quietly widening it. An agent gets `403 PEOPLE_ONLY`.
- **The cursor written is always the caller's.** No request names a user, so no client can move (and therefore read back) anyone else's read state.
- **`kind: 'room'` delegates into `RoomService.setReadCursor`**, so a room cursor gets the room's `requireVisibleRoom` check, the monotonic guard, and the recomputed unread count in one call. Writing it straight to the table would emit an event the room list has nothing to patch with, leaving the badge lit on the second device.
- Monotonicity is a write-path invariant, deliberately not a `CHECK`: SQLite cannot express a constraint about a value's own previous state. `ReadCursorStore.set` and `RoomStore.setReadCursor` share the same `lt()` predicate.

`ReadCursorService.advance` broadcasts `read_cursor` on the global `GET /api/events` fan-out **only when the cursor actually moved**, carrying the unread count where one can be computed. A no-op write (opening an already-read thread, the common case) says nothing. An agent's cursor is never announced: RP3 advances it once per agent per turn, which would make it the loudest event on the stream, and nothing in the cockpit draws it.

### Client

Rooms and chats share one placement rule (`unreadPlacement` in `apps/client/src/layers/shared/lib/group-timeline.ts`) and one `UnreadDivider` (`apps/client/src/layers/features/chat/ui/message/UnreadDivider.tsx`), drawn by both `MessageList` and `RoomTimeline`. Chat sessions moved off the per-browser `dorkos:chat:last-seen:*` watermark onto the table, keyed by **transcript position** (server-confirmed message count), not by SSE `seq`. `purgeLegacyWatermarks` in `use-unread-cursor.ts` sweeps the retired prefix on every session open and deliberately does **not** carry the value over: a number one browser wrote about itself, republished as this person's position everywhere, is how one stale tab un-reads a conversation on every device.

`DirectTransport` (Obsidian, no server) satisfies the same contract from `localStorage` (`apps/client/src/layers/shared/lib/direct/read-cursor-methods.ts`), monotonic like the server's. The seam is the right place for that choice: refusing there would leave the embed with a rule that never draws and never clears, which reads as a broken divider rather than as a missing server. What the embed gives up is sharing across devices, not the feature.

### Anti-Patterns

```ts
// ❌ Reading the membership column to answer a person's question
const seq = store.getMember(roomId, personId)?.lastReadSeq; // that is the AGENT delivery cursor

// ✅ Ask the user-side store
const cursor = getReadCursorService().get(callerId, 'room', roomId);

// ❌ Writing a room cursor straight to the table
getReadCursorService().advance(userId, 'room', roomId, seq); // skips visibility + unread count

// ❌ Keying on the Better Auth account id
store.set(session.user.id, 'room', roomId, seq); // silently splits one person into two rows

// ✅ Key on the resolved author id
store.set(resolveCaller(res).id, 'room', roomId, seq);
```

There is no `PUT /api/rooms/:id/read-cursor`. It was removed once every client wrote through the generic route; a test in `rooms.test.ts` keeps it gone.

## Per-Session Tool Groups

Each agent can be told about a different subset of the DorkOS MCP tools. The resolution pipeline runs on every `sendMessage()` call in `ClaudeCodeRuntime`:

```
ClaudeCodeRuntime.sendMessage(sessionId, content, cwd)
  -> readManifest(effectiveCwd)                    // Load .dork/agent.json
  -> resolveToolConfig(manifest.enabledToolGroups, // Merge agent overrides with global defaults
       { relayEnabled, tasksEnabled, globalConfig })
  -> buildSystemPromptAppend(cwd, meshCore,        // Context blocks gated by toolConfig
       toolConfig)
  -> query({ systemPrompt })                       // SDK call — no tool list is passed
```

### Resolution Order

1. **Per-agent override** (`enabledToolGroups` in `.dork/agent.json`): explicit `true`/`false` per domain
2. **Global default** (`agentContext.*Tools` in `~/.dork/config.json`): applies when agent has no override
3. **Server feature flag** (`relayEnabled`, `tasksEnabled`): hard gate that overrides both above when `false`

### Implicit Grouping

Four top-level toggles control six tool groups:

| Toggle    | Controls                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------- |
| `tasks`   | Tasks tools (list/create/update/delete schedules, run history)                                    |
| `relay`   | Relay tools (send, inbox, endpoints) + Trace tools (get_trace, get_metrics)                       |
| `mesh`    | Mesh tools (discover, register, list, deny, status, inspect, topology)                            |
| `adapter` | Adapter tools (list/enable/disable/reload adapters) + Binding tools (list/create/delete bindings) |

Core tools (ping, get_server_info, get_session_count, get_agent) are always included.

### What a Disabled Group Actually Does

Exactly one thing: `buildSystemPromptAppend` leaves that group's tool block out of the agent's context, so the agent is never told those tools exist. The tools stay registered on the session's MCP server, and an agent that names one anyway can still call it through the normal approval prompt. This steers the agent; it is not a security boundary.

Until DOR-519 this section described a second, stronger mechanism: the resolved config also produced an SDK `allowedTools` array. That was a misreading of the option. `allowedTools` auto-approves the names in it rather than restricting them, and the array was only non-empty once a group had been turned OFF. So turning one group off made 31 to 35 tools skip the approval prompt (the count depends which group), while leaving every group on auto-approved only the 13 names in `DORKOS_AGENT_TOOLS`. `binding_delete` and `relay_disable_adapter` are representative of what that exposed. The toggle ran backwards, and because `enabledToolGroups` is agent-writable through `config_patch`, an agent could widen its own auto-approval. The wiring and `buildAllowedTools` are gone, nothing sets `allowedTools`, and a test in `claude-code-runtime.test.ts` fails if anything sets it again. ADR-0070 carries the full history.

Both of the `destructive` tools that appeared in those lists, `tasks_delete` and `mesh_unregister`, were never actually exposed: they are gated in the handler by `gateHandRegisteredMcpTools` (DOR-468), a layer `allowedTools` cannot reach. (Scoped deliberately: `marketplace.uninstall` is `destructive` too, but the marketplace tools are not in any tool group, so they were never in those lists. There are three destructive actions in total.) That left 29 to 34 `act` and `observe` tools in the list, of which 7 to 13 already auto-approved through `canUseTool` regardless of any toggle. The prompts the toggle actually silenced numbered 16 to 24. That split is the argument for where enforcement lives: consequence is gated by tier in `services/core/mcp-tool-gate.ts`, below every caller, and never by a list of names a config toggle can rewrite.

Taking real access away means leaving a disabled group's tools out at MCP registration time. That work is still open. ADR-260726-171347 records the current, deliberate position: these toggles gate context, not access.

### Files

| File                                                                         | Purpose                                      |
| ---------------------------------------------------------------------------- | -------------------------------------------- |
| `apps/server/src/services/runtimes/claude-code/tooling/tool-filter.ts`       | `resolveToolConfig()`                        |
| `apps/server/src/services/runtimes/claude-code/messaging/context-builder.ts` | Agent-aware block gating, peer agents block  |
| `packages/shared/src/mesh-schemas.ts`                                        | `EnabledToolGroupsSchema` on `AgentManifest` |
| `packages/shared/src/config-schema.ts`                                       | `agentContext.tasksTools` global default     |

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
          http-transport.ts -- HTTP adapter
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
          claude-code-runtime.ts -- ClaudeCodeRuntime implementing AgentRuntime (composition root)
          agent-types.ts      -- AgentSession/ToolState interfaces (shared across subdirs)
          runtime-constants.ts -- Runtime constants
          index.ts            -- Barrel export for ClaudeCodeRuntime
          messaging/          -- Send-message pipeline
            message-sender.ts -- Extracted send-message logic
            context-builder.ts -- Runtime context for systemPrompt (XML blocks)
            interactive-handlers.ts -- Tool approval & question flows
            permission-mode-guard.ts -- Resolves effective permission mode (incl. auto-mode fallback)
            plugin-activation.ts -- Builds options.plugins from installed marketplace plugins
            runtime-cache.ts  -- Caches models/commands/MCP status/subagents
          sdk/                -- SDK message ↔ StreamEvent mapping + SDK utilities
            sdk-event-mapper.ts -- Dispatcher: SDK message → StreamEvent
            event-mappers/    -- Per-category mappers (system/stream/message/result)
            sdk-error-mapping.ts -- SDK error/refusal subtype → ErrorCategory
            sdk-utils.ts      -- makeUserPrompt(), resolveClaudeCliPath()
            build-task-event.ts -- TaskUpdateEvent builder from tool call inputs
          sessions/           -- Transcript/session/task reading + sync
            transcript-reader.ts -- JSONL session reader (single source of truth)
            transcript-parser.ts -- JSONL line → HistoryMessage parser
            task-reader.ts    -- Task state parser from JSONL transcript lines
            session-store.ts  -- In-memory session state
            session-list-watcher.ts -- Fleet-wide session-list watcher (chokidar) backing subscribeSessionList
            question-answers.ts -- Structured-question answer mapping
          tooling/            -- Tool/command/dependency configuration
            tool-filter.ts    -- Per-agent MCP tool-group resolution (resolveToolConfig)
            command-registry.ts -- Slash command discovery
            check-dependency.ts -- Verifies the Claude CLI dependency
          mcp-tools/          -- In-process MCP tool server for Claude Agent SDK
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
      marketplace/            -- Package install/uninstall/update pipeline
        marketplace-installer.ts -- 8-stage orchestrator; dispatches per-kind flows
        marketplace-cache.ts  -- Content-addressable clone cache (TTL, prune)
        marketplace-source-manager.ts -- Source CRUD (marketplaces.json on disk)
        package-fetcher.ts    -- marketplace.json fetch + git clone of packages
        package-resolver.ts   -- Resolves package name → source + entry
        permission-preview.ts -- Builds PermissionPreview from manifest analysis
        conflict-detector.ts  -- Detects file conflicts before writing begins
        telemetry-hook.ts     -- Install/uninstall/update event telemetry
        installed-metadata.ts -- Reads .dork/manifest.json from installed packages
        transaction.ts        -- File-scoped transaction engine: stage, move target aside as
                                  backup, activate, restore backup on failure (see ADR-0304)
        lib/atomic-move.ts    -- Crash-safe directory rename (tmp + rename)
        flows/                -- Per-kind install flows: install-plugin.ts, install-agent.ts,
                                  install-skill-pack.ts, install-adapter.ts, uninstall.ts, update.ts
      core-extensions/        -- Toggleable first-party extensions staged at server startup
        ensure-core-extensions.ts -- Stages every core extension so extension-manager picks them up
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
      marketplace.ts        -- Marketplace HTTP routes (/api/marketplace/*): sources, packages,
                                install/uninstall/update, cache, installed listing
      mcp.ts                -- MCP server endpoint (/mcp, Streamable HTTP transport)
      a2a.ts                -- A2A protocol endpoints (feature-flag gated: DORKOS_A2A_ENABLED)
      models.ts             -- GET /api/models (dynamic via runtimeRegistry.getDefault())
      capabilities.ts       -- GET /api/capabilities (all runtime capability flags)
      discovery.ts          -- POST /api/discovery/scan (SSE agent discovery)
    middleware/
      host-guard.ts         -- /api Host allowlist; DNS rebinding protection, login-off only
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

### Problem 3: Claude Code Binary Path Resolution

Since SDK 0.2.113 the Agent SDK ships Claude Code as a per-platform native binary (an optional dependency), and `cli.js` is no longer published. The SDK resolves the bundled binary relative to `import.meta.url`. In the bundled plugin, this resolves inside `Obsidian.app`, which doesn't contain the binary.

**Fix:** `ClaudeCodeRuntime` resolves the binary path dynamically via `resolveClaudeCliPath()`:

1. The SDK's bundled, version-matched native binary (preferred — avoids requiring a separate install)
2. Fall back to a `claude` on PATH (resilience for when the bundled optional dependency failed to install)
3. Otherwise `undefined` (let the SDK resolve)

The resolved path is passed via `pathToClaudeCodeExecutable` in SDK options.

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
- **Corrupt config recovery**: A `conf` constructor throw is classified before anything is replaced (`classifyConfigLoadFailure`). A failure the file caused (bad JSON, schema violation, or a deterministic throw that survives the retry staircase) backs the file up to `config.json.bak`, recreates with defaults, and re-applies the DOR-584 protections. A failure the OS caused (any errno error: `EMFILE`, `EACCES`, `EBUSY`, …) never replaces the file, however long it lasts: it is retried, then raised as `ConfigUnreadableError` and the server exits. Behind both, an absolute rule: nothing is replaced unless the file was read first, so a misclassified failure still cannot destroy anything. See [configuration.md → Error Recovery](configuration.md#error-recovery).
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

Models are served dynamically from the resolved runtime's `getSupportedModels()` rather than being hardcoded, so the list reflects SDK updates on its own. The `models` route (`routes/models.ts`) resolves `?runtime=` > `?sessionId=` > the registry default and returns `{ models: ModelOption[] }`. Nothing here is Claude-specific: a `runtimes.default` of `codex` or `opencode` returns that runtime's catalog.

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

**Native dependencies:** `better-sqlite3` (via `@dorkos/db`) and `node-pty` (via the CLI) are required at runtime but cannot be inlined by esbuild. They are direct dependencies in `packages/cli/package.json` so `npm install -g` builds them. `node-pty` ships no Linux prebuilds and compiles via node-gyp; `better-sqlite3` has official Linux prebuilds for Node 24 and vendors its own SQLite. Install environments need build tools (`python3`, `build-essential` on Linux — no `libsqlite3-dev`; Xcode CLI tools on macOS).

**Docker image:** One multi-stage `Dockerfile` at the repo root produces four build targets:

| Target                | Purpose                                                                 | Command                                |
| --------------------- | ----------------------------------------------------------------------- | -------------------------------------- |
| `smoke`               | CLI install smoke test (`--version`, `--help`, `--post-install-check`)  | `pnpm smoke:docker`                    |
| `integration`         | Full integration test — starts server, validates API + client endpoints | `pnpm smoke:integration`               |
| `runtime`             | Published product image — starts a DorkOS server on `DORKOS_PORT`       | `pnpm docker:build && pnpm docker:run` |
| `builder` / `install` | Internal stages — toolchain + global npm install, not run directly      | —                                      |

`runtime` is the last stage, so a bare `docker build .` produces it. Install mode is selected by the `INSTALL_MODE` build arg: `tarball` (local build, default) or `npm` (published package). Use `pnpm smoke:npm` to run the integration target against the published npm package. The `integration` and `runtime` targets set `DORKOS_HOST=0.0.0.0` to enable Docker port forwarding.

The GitHub Actions workflow (`.github/workflows/cli-smoke-test.yml`) runs smoke tests on bare Ubuntu runners (Node 22/24 matrix), Docker smoke tests, and full integration tests on every push to main.

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

- `GET /.well-known/agent-card.json` — Fleet Agent Card (mounted at app root; the legacy `/.well-known/agent.json` path is kept as an alias)
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

It also **subscribes** to two control subjects — `relay.system.approval.>` (tool approvals) and `relay.control.task-cancel.>` (run stop requests). Both must reach a turn that is already holding one of the adapter's concurrency slots, which delivery cannot do.

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

## Relay Message Routing (on by default)

When the Relay feature flag is on — which it is unless `relay.enabled` is set false or `DORKOS_RELAY_ENABLED=false` — Tasks (scheduled) message flows are routed through the Relay message bus instead of calling the runtime directly. The web client always uses direct SSE regardless of this flag.

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

| Module                      | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `task-store.ts`             | SQLite database + JSON file for task and run state                      |
| `task-scheduler-service.ts` | Cron engine using `croner` with overrun protection and concurrency caps |

### Dispatch Modes

- **Relay dispatch** (the default): the scheduler publishes to `relay.system.tasks.{taskId}` and `ClaudeCodeAdapter` runs the turn. `relay.enabled` defaults to **true** in user config, so this is what a fresh install does; `DORKOS_RELAY_ENABLED` overrides the config when it is set
- **Direct dispatch**: with Relay off (or failed to start), `TaskSchedulerService` calls the active runtime's `sendMessage()` itself

The two paths stop a run differently, which is why the difference matters
beyond trivia (DOR-808). A directly dispatched run is aborted in place — the
scheduler holds its `AbortController`. A relay-dispatched run is executing
inside the adapter, so `POST /api/tasks/runs/:id/cancel` publishes a
`task_cancel` payload to `relay.control.task-cancel.{runId}`; the adapter's
subscription aborts the run through the same path its time limit uses. Either
way the run record ends `cancelled` with `Run cancelled`, and the route answers
honestly — 200 when a runner took the request, 502 when nothing acknowledged it.

**`relay.control.` is a namespace, not a name.** Two things it is deliberately
not: it is not under `relay.system.tasks.`, which the adapter claims for
delivery — `deliver()` holds a concurrency slot for the whole run, so a stop
routed through it queues behind the run it is trying to end. And it is not under
`relay.system.` at all, because a subscriber counts as a DELIVERY unless it
explicitly refuses, and `GET /api/relay/stream` lets anyone watch
`relay.system.>` with a handler that only forwards what it sees — a watcher on a
stop's subject makes every Stop report success while nothing was stopped. The
namespace is reserved in the bus itself (`packages/relay/src/lib/reserved-subjects.ts`),
which both the agent tool surface and `POST /api/relay/endpoints` consult, and
`EndpointRegistry` refuses a `relay.control.*` mailbox outright with no opt-out.
Note what a mailbox there would actually do, since the obvious guess is wrong:
it would not swallow the stop — the Maildir watcher re-dispatches to the same
subscribers, so the handler still runs — but `deliveredTo` would count the
mailbox delivery, reproducing the false confirmation by another route. Finally,
the adapter refuses any stop whose `from` is not `relay.system.tasks.scheduler`;
that name must stay under `relay.system.`, because `POST /api/relay/messages`
rejects exactly the principals `isConsentExemptPrincipal` covers, and that is
what stops an HTTP caller asserting it.

Agent-created schedules enter `pending_approval` state and require human approval before activation.

### Cascade Disable on Agent Unregister

When an agent is unregistered from Mesh, all Tasks schedules linked to that `agentId` are automatically disabled via `TaskStore.disableTasksByAgentId()`. Agent-linked schedule runs that cannot resolve the agent's project path fail with a descriptive error rather than falling back silently.

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
