# CLAUDE.md

This file provides guidance to AI Coding Agents when working with code and files in this repository.

## Vision & Background

DorkOS is an OS-layer for AI agents — providing the scheduling, memory, communication, and coordination infrastructure that agents themselves don't provide. See [meta/dorkos-litepaper.md](meta/dorkos-litepaper.md) for the full vision, design principles, and roadmap.

## What This Is

DorkOS is a web-based interface and REST/SSE API for Claude Code, built with the Claude Agent SDK. It provides a chat UI for interacting with Claude Code sessions, with tool approval flows and slash command discovery.

Agent backends are abstracted behind the `AgentRuntime` interface (`packages/shared/src/agent-runtime.ts`). The `RuntimeRegistry` (`services/core/runtime-registry.ts`) holds registered runtimes; routes call `runtimeRegistry.getDefault()` to obtain the active runtime. The default (and currently only) implementation is `ClaudeCodeRuntime` (`services/runtimes/claude-code/claude-code-runtime.ts`), which integrates the Claude Agent SDK via `sdk-event-mapper.ts` (event transformation) and `context-builder.ts` (runtime context injection). The SDK's `query()` function is called with `systemPrompt: { type: 'preset', preset: 'claude_code', append: runtimeContext }` to activate full Claude Code guidelines. SDK JSONL transcript files are the single source of truth for all session data.

## Monorepo Structure

This is a Turborepo monorepo with five apps and eight shared packages:

```
dorkos/
├── .github/
│   └── workflows/        # GitHub Actions CI (cli-smoke-test, update-homebrew)
├── apps/
│   ├── client/           # @dorkos/client - React 19 SPA (Vite 6, Tailwind 4, shadcn/ui)
│   ├── server/           # @dorkos/server - Express API (tsc, NodeNext)
│   ├── site/             # @dorkos/site - Marketing site & docs (Next.js 16, Fumadocs)
│   ├── obsidian-plugin/  # @dorkos/obsidian-plugin - Obsidian plugin (Vite lib, CJS)
│   └── e2e/              # @dorkos/e2e - Playwright browser tests
├── packages/
│   ├── cli/              # dorkos - Publishable npm CLI (esbuild bundle)
│   ├── shared/           # @dorkos/shared - Zod schemas, types (JIT .ts exports)
│   ├── db/               # @dorkos/db - Drizzle ORM schemas (SQLite)
│   ├── relay/            # @dorkos/relay - Inter-agent message bus
│   ├── mesh/             # @dorkos/mesh - Agent discovery & registry
│   ├── eslint-config/    # @dorkos/eslint-config - Shared ESLint presets (base, react, node, test)
│   ├── typescript-config/ # @dorkos/typescript-config - Shared tsconfig presets
│   └── test-utils/       # @dorkos/test-utils - Mock factories, test helpers
├── decisions/            # Architecture Decision Records (ADRs)
├── docs/                 # External user-facing docs (MDX for Fumadocs, consumed by marketing site)
├── plans/                # Implementation plans, design reviews, multi-step work breakdowns
├── research/             # Research artifacts (persisted by research-expert agent)
├── specs/                # Feature specs with manifest.json for chronological ordering
├── Dockerfile            # CLI install smoke test image
├── Dockerfile.integration # Full integration test image (server + API + client)
├── Dockerfile.run        # Runnable container image
├── turbo.json
├── vitest.workspace.ts
└── package.json          # Root workspace config + turbo only
```

## Commands

```bash
pnpm dev               # Start both Express server and Vite dev server (loads .env)
dotenv -- turbo dev --filter=@dorkos/server   # Express server only (loads .env)
dotenv -- turbo dev --filter=@dorkos/client   # Vite dev server only (loads .env)
pnpm test              # Vitest across client + server (loads .env)
pnpm test -- --run     # Vitest single run
pnpm build             # Build all apps (client Vite + server tsc + site Next.js + obsidian plugin)
pnpm typecheck         # Type-check all packages
turbo build --filter=@dorkos/obsidian-plugin  # Build Obsidian plugin only
pnpm --filter=dorkos run build   # Build CLI package (esbuild bundles server+client+CLI)
pnpm publish:cli       # Publish dorkos to npm (prepublishOnly auto-builds)
pnpm start             # Production server (serves built React app, loads .env)
pnpm --filter=@dorkos/server run dev:tunnel   # Dev server + ngrok tunnel (tunnels Vite on :3000)
pnpm lint              # ESLint across all packages
pnpm lint -- --fix     # Auto-fix ESLint issues
pnpm format            # Prettier format all files
pnpm format:check      # Check formatting without writing
pnpm docs:export-api   # Export OpenAPI spec to docs/api/openapi.json (loads .env)
pnpm smoke:docker      # Build CLI, pack tarball, Docker smoke test
pnpm smoke:integration # Full integration test (server + API + client in Docker)
pnpm smoke:npm         # Integration test against published npm package
pnpm docker:build      # Build runnable Docker image from local code
pnpm docker:run        # Run dorkos in Docker (build first with docker:build)
pnpm publish:cli       # Publish dorkos CLI to npm (uses pnpm publish --filter=dorkos)
git gtr new <branch>     # Create worktree (runs pnpm install + port setup via .gtrconfig)
git gtr list             # List all worktrees
git gtr rm <branch>      # Remove worktree
```

Slash commands for agent-friendly worktree management: `/worktree:create`, `/worktree:list`, `/worktree:remove`.

Run a single test file: `pnpm vitest run apps/server/src/services/__tests__/transcript-reader.test.ts`

## Architecture

DorkOS uses a **hexagonal architecture** with a `Transport` interface (`packages/shared/src/transport.ts`) that decouples the React client from its backend. Two adapters exist: `HttpTransport` (standalone web, HTTP/SSE to Express) and `DirectTransport` (Obsidian plugin, in-process services). Transport is injected via React Context (`TransportContext`). See `contributing/architecture.md` for full details.

### Server (`apps/server/src/`)

Express server on `DORKOS_HOST` (default `localhost`) port `DORKOS_PORT` (default 4242). Set `DORKOS_HOST=0.0.0.0` for Docker containers. CORS is configured in `app.ts` via `buildCorsOrigin()`: defaults to localhost on `DORKOS_PORT` and `VITE_PORT` (4241); set `DORKOS_CORS_ORIGIN` to a comma-separated list of origins (or `*`) to override. All endpoints that accept `cwd`, `path`, or `dir` parameters enforce directory boundary validation via `lib/boundary.ts`, returning 403 for paths outside the configured boundary (default: home directory). Routes obtain the active runtime via `runtimeRegistry.getDefault()` rather than referencing a singleton directly. Fifteen route groups:

- **`routes/sessions.ts`** - Session listing (from SDK transcripts), session creation, SSE message streaming, message history, tool approve/deny endpoints
- **`routes/commands.ts`** - Slash command listing via `CommandRegistryService`, which scans `.claude/commands/` using gray-matter frontmatter parsing
- **`routes/health.ts`** - Health check; includes optional `tunnel` status field when ngrok is enabled
- **`routes/directory.ts`** - Directory browsing for working directory selection
- **`routes/config.ts`** - Configuration management endpoints (GET for server config including `pulse.enabled`, `mesh.scanRoots`, PATCH for user config updates with Zod validation)
- **`routes/files.ts`** - File operations (read/list files)
- **`routes/git.ts`** - Git status and branch information
- **`routes/tunnel.ts`** - Runtime tunnel control (POST /start and /stop). Resolves auth token from env var or config, delegates to `tunnelManager`, persists enabled state
- **`routes/pulse.ts`** - Pulse scheduler CRUD (GET/POST/PATCH/DELETE schedules, POST trigger, GET/POST runs). Delegates to SchedulerService and PulseStore
- **`routes/relay.ts`** - Relay inter-agent messaging (POST/GET messages, GET/POST/DELETE endpoints, GET inbox, GET dead-letters, GET metrics, GET stream SSE), adapter catalog management (GET /adapters/catalog, POST /adapters, DELETE /adapters/:id, PATCH /adapters/:id/config, POST /adapters/test), and binding management (GET/POST/DELETE /bindings, GET /bindings/:id). Feature-flag guarded via `relay-state.ts`
- **`routes/mesh.ts`** - Mesh agent discovery and registry (POST /discover, POST/GET/PATCH/DELETE /agents, GET /agents/:id/access, GET /agents/:id/health, POST /agents/:id/heartbeat, GET /topology, PUT /topology/access, POST /deny, GET/DELETE /denied, GET /status). Always-on (no feature flag). Factory: `createMeshRouter(meshCore)`
- **`routes/agents.ts`** - Agent identity CRUD (GET/POST/PATCH /agents/current for per-CWD agent identity, POST /agents/resolve for batch path→agent resolution). Always mounted (no feature flag). Reads/writes `.dork/agent.json` manifest files via `@dorkos/shared/manifest`
- **`routes/models.ts`** - GET /api/models — returns available Claude models via `runtimeRegistry.getDefault().getSupportedModels()`
- **`routes/capabilities.ts`** - GET /api/capabilities — returns capability flags for all registered runtimes plus the default runtime type. Response shape: `{ capabilities: Record<string, RuntimeCapabilities>, defaultRuntime: string }`
- **`routes/discovery.ts`** - Agent discovery SSE endpoint (POST /api/discovery/scan). Delegates to `meshCore.discover()` (unified scanner) and streams results as SSE. Validates scan parameters with Zod, enforces directory boundary. Factory: `createDiscoveryRouter(meshCore)`

Services organized under `services/core/` (shared infrastructure), `services/runtimes/` (agent backend implementations), and domain directories (`pulse/`, `relay/`, `mesh/`):

- **`services/core/runtime-registry.ts`** - Registry of available agent runtimes, keyed by type string. Routes call `runtimeRegistry.getDefault()` to get the active runtime. Supports future multi-runtime scenarios via `resolveForAgent(agentId, meshCore)`. Exports `getAllCapabilities()` for the capabilities endpoint and `has()`/`listRuntimes()` for introspection.
- **`services/runtimes/claude-code/claude-code-runtime.ts`** - Claude Code runtime implementing the `AgentRuntime` interface. Encapsulates all Claude Agent SDK interactions: session management (create/resume with 30-minute timeout), streaming messaging via `query()`, transcript reading, file watching (session broadcaster), tool approval (interactive handlers), command registry, and session locking. Replaces the former standalone `AgentManager` class. On each `sendMessage()`, loads the agent manifest and resolves per-agent tool filtering via `tool-filter.ts`, passing `allowedTools` to the SDK `query()` call and `toolConfig` to the context builder. Injects MCP tool servers via `setMcpServerFactory()`.
- **`services/runtimes/claude-code/agent-types.ts`** - `AgentSession` and `ToolState` interfaces, plus `createToolState()` factory. Shared by claude-code-runtime, sdk-event-mapper, and interactive-handlers.
- **`services/runtimes/claude-code/sdk-event-mapper.ts`** - Pure async generator `mapSdkMessage()` that transforms SDK messages (`stream_event`, `tool_use_summary`, `result`, `system/init`) into DorkOS `StreamEvent` types.
- **`services/runtimes/claude-code/tool-filter.ts`** - Per-agent MCP tool filtering. `resolveToolConfig()` merges agent manifest `enabledToolGroups` with global defaults, gated by server feature flags. `buildAllowedTools()` produces the `allowedTools` list for SDK `query()`. Implicit grouping: binding tools follow adapter toggle, trace tools follow relay toggle. Core tools (`ping`, `get_server_info`, `get_session_count`, `get_current_agent`) are always enabled.
- **`services/runtimes/claude-code/context-builder.ts`** - `buildSystemPromptAppend(cwd, meshCore?, toolConfig?)` — gathers runtime context (env info, git status, agent identity/persona, peer agents) and formats as XML blocks (`<env>`, `<git_status>`, `<agent_identity>`, `<agent_persona>`, `<peer_agents>`, `<pulse_tools>`, `<relay_tools>`, `<mesh_tools>`, `<adapter_tools>`) for the SDK `systemPrompt.append`. Never throws. Agent persona injection is conditional on `personaEnabled` flag in the agent manifest. When `toolConfig` is provided, blocks are gated per-agent (omitted when the domain is disabled); otherwise falls back to global config checks. The peer agents block lists registered Mesh agents for cross-agent awareness.
- **`services/runtimes/claude-code/sdk-utils.ts`** - `makeUserPrompt()` (wraps string as `AsyncIterable<SDKUserMessage>`) and `resolveClaudeCliPath()` (Claude CLI path resolution for Electron compatibility).
- **`lib/resolve-root.ts`** - Single source of truth for the server's default working directory. Exports `DEFAULT_CWD`: prefers `DORKOS_DEFAULT_CWD` env var, falls back to repo root resolved from the file's own location. Consumed by routes and services that need the default CWD.
- **`lib/dork-home.ts`** - Resolves the DorkOS data directory (`dorkHome`). Priority: `DORK_HOME` env var > `.temp/.dork` (dev) > `~/.dork` (production). Called once at startup; result broadcast via `process.env.DORK_HOME` and passed as required parameter to services. See `.claude/rules/dork-home.md`.
- **`env.ts`** - Zod-validated environment module. Parses and type-validates all server env vars at startup; exits with a clear error if required vars are missing or invalid. Exports a typed `env` object consumed throughout the server. Each app has its own `env.ts` (`apps/client/src/env.ts`, `apps/site/src/env.ts`, `packages/cli/src/env.ts`) with app-specific schemas.
- **`services/runtimes/claude-code/transcript-reader.ts`** - Single source of truth for session data. Reads SDK JSONL transcript files from `~/.claude/projects/{slug}/`. Provides `listSessions()` (scans directory, extracts metadata), `getSession()` (single session metadata), and `readTranscript()` (full message history). Extracts titles from first user message, permission mode from init message, timestamps from file stats.
- **`services/runtimes/claude-code/transcript-parser.ts`** - Parses SDK JSONL transcript lines into structured `HistoryMessage` objects. Handles content blocks (text, tool_use, tool_result), question prompts, and model metadata extraction.
- **`services/runtimes/claude-code/session-broadcaster.ts`** - Manages cross-client session synchronization. Watches JSONL transcript files via chokidar for changes (including CLI writes). Maintains SSE connections with passive clients via `registerClient()`. Broadcasts `sync_update` events when files change. Debounces rapid writes (100ms). Uses incremental byte-offset reading via `transcriptReader.readFromOffset()`. Graceful shutdown closes all watchers and connections.
- **`services/runtimes/claude-code/session-lock.ts`** - Manages session write locks to prevent concurrent writes from multiple clients. Locks auto-expire after configurable TTL and are released when SSE connections close.
- **`services/core/stream-adapter.ts`** - SSE helpers (`initSSEStream`, `sendSSEEvent`, `endSSEStream`) that format `StreamEvent` objects as SSE wire protocol.
- **`services/runtimes/claude-code/interactive-handlers.ts`** - Handles tool approval and AskUserQuestion flows. Exports `createCanUseTool()` factory for SDK `canUseTool` callback. Manages pending interactions with timeout/resolve/reject lifecycle.
- **`services/runtimes/claude-code/build-task-event.ts`** - Builds `TaskUpdateEvent` objects from TaskCreate/TaskUpdate tool call inputs. Used by the streaming pipeline to emit task progress events.
- **`services/runtimes/claude-code/task-reader.ts`** - Parses task state from JSONL transcript lines. Reconstructs final `TaskItem` state from TaskCreate/TaskUpdate tool_use blocks.
- **`services/runtimes/claude-code/command-registry.ts`** - Scans `.claude/commands/` for slash commands. Parses YAML frontmatter via gray-matter. Caches results; supports `forceRefresh`. Used by ClaudeCodeRuntime's `getCommands()` method.
- **`services/core/openapi-registry.ts`** - Auto-generates OpenAPI spec from Zod schemas. Powers `/api/docs` (Scalar UI) and `/api/openapi.json`.
- **`services/core/file-lister.ts`** - Lists files in a directory for the client file browser.
- **`services/core/git-status.ts`** - Provides git status information (branch, changed files).
- **`services/core/tunnel-manager.ts`** - Opt-in ngrok tunnel lifecycle. Singleton that wraps `@ngrok/ngrok` SDK with dynamic import (zero cost when disabled). Configured via env vars: `TUNNEL_ENABLED`, `NGROK_AUTHTOKEN`, `TUNNEL_PORT`, `TUNNEL_AUTH`, `TUNNEL_DOMAIN`. Started after Express binds in `index.ts`; tunnel failure is non-blocking. Exposes `status` getter consumed by `health.ts` and `routes/tunnel.ts`. Graceful shutdown via SIGINT/SIGTERM.
- **`services/core/config-manager.ts`** - Manages persistent user config at `~/.dork/config.json`. Uses `conf` for atomic JSON I/O with Ajv validation. Singleton initialized via `initConfigManager()` at server startup and in CLI subcommands. Handles first-run detection, corrupt config recovery (backup + recreate), sensitive field warnings, and onboarding state (completedSteps, skippedSteps, dismissedAt, startedAt).
- **`services/runtimes/claude-code/mcp-tools/index.ts`** - In-process MCP tool server for Claude Agent SDK. Uses `createSdkMcpServer()` and `tool()` from the SDK to register tools that agents can call. Core tools: `ping`, `get_server_info`, `get_session_count`. Pulse tools: `pulse_list_schedules`, `pulse_create_schedule`, `pulse_update_schedule`, `pulse_delete_schedule`, `pulse_get_run_history`. Relay tools: `relay_send`, `relay_inbox`, `relay_list_endpoints`, `relay_register_endpoint`, `relay_query` (blocking request/reply with progress accumulation), `relay_dispatch` (fire-and-poll for long-running tasks), `relay_unregister_endpoint` (cleanup dispatch/query inboxes). Trace tools: `relay_get_trace`, `relay_get_metrics`. Mesh tools: `mesh_discover`, `mesh_register`, `mesh_deny`, `mesh_list`, `mesh_unregister`, `mesh_status`, `mesh_inspect`, `mesh_query_topology`. Agent tools: `get_current_agent` (returns current agent identity for the session's CWD). Binding tools: `binding_list`, `binding_create`, `binding_delete` (adapter-to-agent binding management; only registered when bindingStore is provided). Agent-created schedules enter `pending_approval` state. Factory function `createDorkOsToolServer(deps)` accepts `McpToolDeps` (transcriptReader, defaultCwd, pulseStore, relayCore, meshCore) for dependency injection.
- **`services/relay/relay-state.ts`** - Feature flag holder for Relay subsystem. Exports `setRelayEnabled()`/`isRelayEnabled()`. Same pattern as `pulse-state.ts`.
- **`services/mesh/mesh-state.ts`** - Mesh subsystem state holder. Mesh is always-on (no feature flag); this module is retained for internal state tracking only.
- **`services/core/update-checker.ts`** - Server-side npm registry check with in-memory cache (1-hour TTL). Fetches latest version from npm for update notifications. Used by config route to populate `latestVersion` in server config.
- **`services/pulse/pulse-store.ts`** - SQLite database (`~/.dork/pulse.db`) + JSON file (`~/.dork/schedules.json`) for Pulse scheduler state. Uses `better-sqlite3` with WAL mode. Manages schedule CRUD, run lifecycle, and retention pruning. Auto-migrates schema via `PRAGMA user_version`. Schedules have an optional `agentId` field for agent-linked scheduling. `disableSchedulesByAgentId()` cascades disable when an agent is unregistered from Mesh.
- **`services/pulse/scheduler-service.ts`** - Cron scheduling engine using `croner` with overrun protection (`protect: true`). Loads schedules on startup, dispatches jobs to the active runtime as isolated sessions. Tracks active runs via `Map<string, AbortController>` for cancellation/timeout. Configurable concurrency cap (`maxConcurrentRuns`). When `DORKOS_RELAY_ENABLED` is true, `executeRun()` publishes to Relay (`relay.system.pulse.{scheduleId}`) instead of calling the runtime directly; ClaudeCodeAdapter handles the dispatched message. Agent-linked schedules resolve their CWD via `resolveEffectiveCwd()` which looks up the agent's `projectPath` from MeshCore; if the agent is not found (unregistered), the run fails with a descriptive error.
- **`services/relay/trace-store.ts`** - SQLite trace storage for Relay message delivery tracking. Adds `message_traces` table to the existing Relay index database (`~/.dork/relay/index.db`). Provides `insertSpan()`, `updateSpan()`, `getSpanByMessageId()`, `getTrace()`, and `getMetrics()` (live SQL aggregates). Uses same better-sqlite3/WAL patterns as PulseStore.
- **`services/relay/adapter-manager.ts`** - Server-side adapter lifecycle management. Creates and manages adapter instances based on config. Accepts `AdapterManagerDeps` (runtime, traceStore, pulseStore) for dependency injection into adapters like ClaudeCodeAdapter.
- **`services/relay/binding-store.ts`** - JSON file-backed store for adapter-agent bindings. Persists to `~/.dork/relay/bindings.json` with chokidar hot-reload. Provides CRUD operations and most-specific-first resolution for routing inbound adapter messages to the correct agent.
- **`services/relay/binding-router.ts`** - Central routing service for adapter-agent bindings. Subscribes to `relay.human.*` messages, resolves adapter-agent bindings via BindingStore, manages session lifecycle based on session strategies (per-chat, per-user, stateless), and republishes to `relay.agent.*` for ClaudeCodeAdapter to handle. Persists session map to `{relayDir}/sessions.json` for recovery across restarts.
- **`packages/mesh/src/discovery/unified-scanner.ts`** - Unified async generator that performs BFS filesystem traversal to discover AI-configured projects. Scans for markers via detection strategies (claude-code, cursor, copilot, dork-manifest) with configurable depth limits, exclusion patterns, symlink following with cycle detection, and timeout. Yields candidate, auto-import, progress, and complete events. Replaces both the legacy `discovery-engine.ts` (Scanner A) and `discovery-scanner.ts` (Scanner B).
- **`services/pulse/pulse-presets.ts`** - Manages default Pulse schedule presets at `~/.dork/pulse/presets.json`. Creates default presets on first access (codebase health, dependency audit, documentation sync, code quality review). Provides `loadPresets()` and `getPresetsPath()`.
- **`services/pulse/pulse-state.ts`** - Feature flag holder for Pulse subsystem. Exports `setPulseEnabled()`/`isPulseEnabled()`. Same pattern as `relay-state.ts`.

### Session Architecture

Sessions are derived entirely from SDK JSONL files on disk (`~/.claude/projects/{slug}/*.jsonl`). There is no separate session store - the `TranscriptReader` scans these files to build the session list. This means:

- All sessions are visible (CLI-started, DorkOS-started, etc.)
- Session ID = SDK session ID (UUID from JSONL filename)
- No delete endpoint (sessions persist in SDK storage)
- Session metadata (title, preview, timestamps) is extracted from file content and stats on every request

Routes access session operations through the `AgentRuntime` interface obtained via `runtimeRegistry.getDefault()`. The runtime owns session lifecycle (create, resume, message, lock, watch, history queries).

When `DORKOS_RELAY_ENABLED` is true, session messaging uses Relay transport:
- POST `/api/sessions/:id/messages` publishes to `relay.agent.{sessionId}` and returns 202 with `{ messageId, traceId }` receipt
- ClaudeCodeAdapter (via Relay's adapter system) subscribes to the subject and triggers the runtime
- Response chunks are published back to `relay.human.console.{clientId}` and fanned into the SSE stream as `relay_message` events
- Client-side `useChatSession` branches on `useRelayEnabled()`: Relay path uses receipt+SSE, legacy path is unchanged

### Agent Storage (ADR-0043)

Agent data lives in two places: `.dork/agent.json` files on disk (canonical source of truth) and a SQLite `agents` table (derived cache/index). All mutations follow a **file-first write-through** pattern: write to disk, then update DB. The reconciler syncs file → DB every 5 minutes as an anti-entropy safety net. On unregistration, the manifest file is deleted to prevent re-discovery. The agents routes (`routes/agents.ts`) accept an optional `MeshCore` reference to call `syncFromDisk()` after writes, enabling immediate DB sync.

### Client (`apps/client/src/`)

React 19 + Vite 6 + Tailwind CSS 4 + shadcn/ui (new-york style, pure neutral gray palette). Uses **Feature-Sliced Design (FSD)** architecture with strict unidirectional layer imports.

**FSD Layers** (`apps/client/src/layers/`):

| Layer                    | Modules                                                            | Purpose                     |
| ------------------------ | ------------------------------------------------------------------ | --------------------------- |
| `shared/ui/`             | 17 shadcn primitives (Badge, Command, Dialog, Select, Tabs, Tooltip, Toaster, etc.), DirectoryPicker | Reusable UI primitives      |
| `shared/model/`          | TransportContext, app-store, 8 hooks (useTheme, useIsMobile, etc.) | Hooks, stores, context      |
| `shared/lib/`            | cn, Transports, font-config, favicon-utils, celebrations, etc.     | Domain-agnostic utilities   |
| `entities/session/`      | useSessionId, useSessions, useDirectoryState, useDefaultCwd        | Session domain hooks        |
| `entities/command/`      | useCommands                                                        | Command domain hook         |
| `entities/pulse/`        | usePulseEnabled, useSchedules, useRuns, useActiveRunCount, useCancelRun, useCompletedRunBadge | Pulse scheduler domain hooks|
| `entities/relay/`        | useRelayEnabled, useRelayMessages, useRelayEndpoints, useRelayMetrics, useSendRelayMessage, useRelayEventStream, useMessageTrace, useDeliveryMetrics, useDeadLetters, useRelayAdapters, useToggleAdapter, useAdapterCatalog, useAddAdapter, useRemoveAdapter, useUpdateAdapterConfig, useTestAdapterConnection | Relay messaging domain hooks|
| `entities/mesh/`         | useMeshEnabled, useRegisteredAgents, useDiscoverAgents, useRegisterAgent, useDenyAgent, useUnregisterAgent, useUpdateAgent, useDeniedAgents, useMeshStatus, useMeshAgentHealth, useMeshHeartbeat | Mesh discovery domain hooks |
| `entities/binding/`      | useBindings, useCreateBinding, useDeleteBinding                    | Adapter-agent binding hooks |
| `entities/discovery/`    | useDiscoveryStore, useDiscoveryScan                                | Shared discovery scan state (Zustand store + hook) |
| `entities/runtime/`      | useRuntimeCapabilities, useDefaultCapabilities                                                         | Runtime capabilities and feature detection |
| `entities/agent/`        | useCurrentAgent, useResolvedAgents, useCreateAgent, useUpdateAgent, useAgentVisual, useAgentToolStatus | Agent identity domain hooks |
| `features/chat/`         | ChatPanel, MessageList, MessageItem, ToolCallCard, useChatSession  | Chat interface              |
| `features/session-list/` | SessionSidebar, SessionItem, AgentContextChips, SidebarFooterBar   | Session management. AgentContextChips uses `useAgentToolStatus` for per-agent 3-state chip rendering (enabled/disabled-by-agent/disabled-by-server) |
| `features/commands/`     | CommandPalette                                                     | Inline slash command palette (chat input) |
| `features/command-palette/` | CommandPaletteDialog, AgentCommandItem, AgentPreviewPanel, AgentSubMenu, HighlightedText, PaletteFooter, useGlobalPalette, usePaletteItems, useAgentFrecency, usePaletteSearch, usePreviewData | Global Cmd+K command palette with Fuse.js fuzzy search, agent preview panel, Slack bucket frecency, and sub-menu drill-down |
| `features/settings/`     | SettingsDialog, ToolsTab                                           | Settings UI (6 tabs: Appearance, Preferences, Status Bar, Server, Tools, Advanced) |
| `features/files/`        | FilePalette, useFiles                                              | File browser                |
| `features/pulse/`        | PulsePanel, ScheduleRow, CreateScheduleDialog, RunHistoryPanel, CronPresets, CronVisualBuilder, TimezoneCombobox, AgentCombobox | Pulse scheduler UI          |
| `features/relay/`        | RelayPanel, ActivityFeed, MessageRow, EndpointList, InboxView, MessageTrace, DeliveryMetricsDashboard, RelayHealthBar, DeadLetterSection, ConnectionStatusBanner, ComposeMessageDialog, AdapterCard, CatalogCard, ConfigFieldInput, AdapterSetupWizard | Relay messaging UI          |
| `features/mesh/`         | MeshPanel, CandidateCard, AgentCard, RegisterAgentDialog, TopologyGraph, AgentNode, AdapterNode, BindingEdge, BindingDialog, MeshStatsHeader, AgentHealthDetail | Mesh discovery, registry & observability UI|
| `features/agent-settings/` | AgentDialog, IdentityTab, PersonaTab, CapabilitiesTab, ConnectionsTab | Agent identity settings UI (4 tabs). CapabilitiesTab includes per-agent Tool Groups toggles with 3-state display (inherited/overridden) |
| `features/onboarding/`   | OnboardingFlow, AgentDiscoveryStep, PulsePresetsStep, AdapterSetupStep, AgentCard, PresetCard, NoAgentsFound, OnboardingComplete, DiscoveryCelebration, ProgressCard, useOnboarding, usePulsePresets | First-time user experience |
| `features/status/`       | StatusLine, GitStatusItem, ModelItem, etc.                         | Status bar                  |
| `widgets/app-layout/`    | PermissionBanner, DialogHost                                       | App-level layout components |

**Layer dependency rule**: `shared` ← `entities` ← `features` ← `widgets` ← `app` (strictly unidirectional). See `.claude/rules/fsd-layers.md` for full import rules.

- **State**: Zustand for UI state (`layers/shared/model/app-store.ts`) including `previousCwd` for agent switch tracking, TanStack Query for server state (`entities/session/`, `entities/command/`). Agent frecency uses `useSyncExternalStore` with localStorage (`dorkos:agent-frecency-v2` key, Slack bucket algorithm).
- **URL Parameters**: `?session=` (session ID via nuqs) and `?dir=` (working directory via nuqs) persist client state in the URL for standalone mode. In Obsidian embedded mode, both use Zustand instead. The `?dir=` parameter is omitted when using the server default directory to keep URLs clean.
- **Barrel Exports**: Every FSD module has an `index.ts` barrel. Import from barrels only (e.g., `import { ChatPanel } from '@/layers/features/chat'`), never from internal paths.
- **Markdown Rendering**: Assistant messages are rendered as rich markdown via the `streamdown` library (Vercel). `StreamingText` wraps the `<Streamdown>` component with `github-light`/`github-dark` Shiki themes and shows a blinking cursor during active streaming. User messages remain plain text. The `@source` directive in `index.css` ensures Streamdown's Tailwind classes are included in the CSS output.
- **Animations**: `motion` (motion.dev) for UI animations. `App.tsx` wraps the app in `<MotionConfig reducedMotion="user">` to respect `prefers-reduced-motion`. Used for: message entrance animations (new messages only, not history), tool card expand/collapse, sidebar width toggle, button micro-interactions. Command palette animations: sliding selection indicator (`layoutId` pattern), spring entrance (scale+fade), stagger on open/page transitions (first 8 items only), directional x-axis page transitions, item hover nudge (2px), preview panel width spring. Tests mock `motion/react` to render plain elements.
- **Design System**: Color palette, typography, spacing (8pt grid), and motion specs are documented in `contributing/design-system.md`.

### Shared (`packages/shared/src/`)

`agent-runtime.ts` defines the universal `AgentRuntime` interface, `RuntimeCapabilities` flags, and related option types (`SessionOpts`, `MessageOpts`, `SseResponse`). Imported as `@dorkos/shared/agent-runtime`. `schemas.ts` defines Zod schemas for all types with OpenAPI metadata. Each schema exports an inferred TypeScript type (e.g., `export type Session = z.infer<typeof SessionSchema>`). `PulseScheduleSchema` includes an optional `agentId` field for linking schedules to specific agents. `types.ts` re-exports all types from `schemas.ts`, so existing `import { Session } from '@dorkos/shared/types'` imports work unchanged. `config-schema.ts` defines `UserConfigSchema` (Zod) for the persistent config file, exporting the `UserConfig` type, defaults, and sensitive key list. The `agentContext` section includes global toggles for `relayTools`, `meshTools`, `adapterTools`, and `pulseTools` (all default `true`). Imported as `@dorkos/shared/config-schema`. `relay-schemas.ts` defines Zod schemas for the Relay message bus (envelopes, budgets, payloads, signals, access control, adapter bindings, dispatch progress payloads, HTTP request/response shapes). Imported as `@dorkos/shared/relay-schemas`. `mesh-schemas.ts` defines Zod schemas for Mesh agent discovery and observability (AgentManifest with persona/color/icon/enabledToolGroups fields, EnabledToolGroups for per-agent tool domain toggles, DiscoveryCandidate, DenialRecord, AgentHealth, MeshStatus, MeshInspect, MeshLifecycleEvent, ScanProgress, TransportScanEvent, TransportScanOptions, HTTP request/response shapes). Imported as `@dorkos/shared/mesh-schemas`. `manifest.ts` provides canonical manifest I/O (`readManifest`, `writeManifest`, `removeManifest`) for `.dork/agent.json` files. Imported as `@dorkos/shared/manifest`. `logger.ts` exports a minimal `Logger` interface and `noopLogger` for cross-package dependency injection. Imported as `@dorkos/shared/logger`.

**API docs** are available at `/api/docs` (Scalar UI) and `/api/openapi.json` (raw spec). The OpenAPI spec is auto-generated from the Zod schemas in `apps/server/src/services/core/openapi-registry.ts`.

**Request validation** uses `schema.safeParse(req.body)` in route handlers. Invalid requests return 400 with `{ error, details }` where details is Zod's formatted error output.

### Path Aliases

- `@/*` -> `./src/*` (within each app, scoped to that app's source)
- FSD layer imports use `@/layers/shared/lib`, `@/layers/shared/model`, `@/layers/features/chat`, etc.

Cross-package imports use the `@dorkos/*` package names (e.g., `import { Session } from '@dorkos/shared/types'`). The old `@shared/*` alias has been removed.

Configured in each app's `tsconfig.json` (for IDE/tsc) and `vite.config.ts` (for bundling).

### SSE Streaming Protocol

Messages flow: client POST to `/api/sessions/:id/messages` -> server yields `StreamEvent` objects as SSE -> client parses in `useChatSession`.

Event types: `text_delta`, `tool_call_start`, `tool_call_delta`, `tool_call_end`, `tool_result`, `approval_required`, `question_prompt`, `error`, `done`, `session_status`, `task_update`, `relay_message`, `relay_receipt`, `message_delivered`.

When `DORKOS_RELAY_ENABLED` is true, additional event types are used: `relay_message` (Relay response chunk containing a nested StreamEvent), `relay_receipt` (delivery confirmation for a Relay message), and `message_delivered` (message delivery notification).

### Session Sync Protocol

Clients can subscribe to session changes via a persistent SSE connection: `GET /api/sessions/:id/stream`. This provides real-time sync across multiple clients (including CLI changes).

Events:

- `sync_connected` — Sent on initial connection. Data: `{ sessionId }`
- `sync_update` — Sent when new content is written to the session's JSONL file. Data: `{ sessionId, timestamp }`

Clients receiving `sync_update` should re-fetch message history. The GET /messages endpoint supports ETag caching (If-None-Match/304) for efficient polling.

When Relay is enabled, the SSE stream also carries relay event types (`relay_message`, `relay_receipt`, `message_delivered`) alongside the standard sync events.

### Session Locking

POST /messages uses session locking to prevent concurrent writes. Clients send an `X-Client-Id` header. If a session is already locked by another client, the server returns 409 with `{ error: 'Session locked', code: 'SESSION_LOCKED', lockedBy, lockedAt }`. Locks auto-expire after 5 minutes and are released when SSE connections close.

### Session History

When a session is opened, the client fetches message history via GET `/api/sessions/:id/messages`. The server reads the SDK's JSONL transcript file at `~/.claude/projects/{slug}/{sessionId}.jsonl`, parsing user and assistant messages. This works for sessions started from any client (CLI, DorkOS, etc.) since all use the same SDK storage.

### Vault Root Resolution

**Standalone server:** `lib/resolve-root.ts` exports `DEFAULT_CWD` — prefers `DORKOS_DEFAULT_CWD` env var, falls back to the repo root resolved upward from `apps/server/dist/`. This is the single source of truth for the server's default working directory.

**Obsidian plugin:** `CopilotView` computes `repoRoot = path.resolve(vaultPath, '..')` (vault is `workspace/`, repo root is its parent). This is passed to `ClaudeCodeRuntime(repoRoot)` and `CommandRegistryService(repoRoot)`.

Both paths are used by `CommandRegistryService` to find `.claude/commands/` and by `ClaudeCodeRuntime` as the SDK's working directory.

### Obsidian Plugin Build

The plugin build (`apps/obsidian-plugin/vite.config.ts`) includes four Vite plugins (in `apps/obsidian-plugin/build-plugins/`) that post-process `main.js` for Electron compatibility: `copyManifest`, `safeRequires`, `fixDirnamePolyfill`, `patchElectronCompat`. Output goes to `apps/obsidian-plugin/dist/`. See `contributing/architecture.md` > "Electron Compatibility Layer" for details.

### CLI Package (`packages/cli`)

The `dorkos` npm package bundles the server + client into a standalone CLI tool. Published to npm as `dorkos` (unscoped). Install via `npm install -g dorkos`, run via `dorkos`. Build pipeline (`packages/cli/scripts/build.ts`) uses esbuild in 3 steps: (1) Vite builds client to static assets, (2) esbuild bundles server + `@dorkos/shared` into single ESM file (externalizing node_modules), (3) esbuild compiles CLI entry point. Output: `dist/bin/cli.js` (entry with shebang), `dist/server/index.js` (bundled server), `dist/client/` (React SPA). The version is injected at build time via esbuild's `define` config (reads from `packages/cli/package.json`). `better-sqlite3` is listed as a direct dependency — it's a native addon required at runtime (via `@dorkos/db`) that cannot be inlined by esbuild. The CLI creates `~/.dork/` on startup for config storage and sets `DORK_HOME` env var. It also sets `DORKOS_PORT`, `CLIENT_DIST_PATH`, `DORKOS_DEFAULT_CWD`, `DORKOS_BOUNDARY`, `TUNNEL_ENABLED`, and `NODE_ENV` before dynamically importing the bundled server.

CLI subcommands: `dorkos config` (manage config), `dorkos init` (interactive setup wizard). CLI flags include `--port`/`-p`, `--dir`/`-d`, `--boundary`/`-b`, `--tunnel`/`-t`, and `--pulse`/`--no-pulse`. Config precedence: CLI flags > environment variables > `~/.dork/config.json` > built-in defaults.

## Guides

Detailed documentation lives in `contributing/`:

| Guide                                                                                    | Contents                                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`contributing/architecture.md`](contributing/architecture.md)                                       | Hexagonal architecture, Transport interface, dependency injection, Electron compatibility layer, build plugins, data flow diagrams, module layout, testing patterns |
| [`contributing/design-system.md`](contributing/design-system.md)                                     | Color palette, typography, spacing (8pt grid), motion specs, component conventions                                                                                  |
| [`contributing/obsidian-plugin-development.md`](contributing/obsidian-plugin-development.md)         | Plugin lifecycle, ItemView pattern, React mounting, active file tracking, drag-and-drop, Vite build config, Electron quirks, debugging, common issues               |
| [`contributing/api-reference.md`](contributing/api-reference.md)                                     | OpenAPI spec, Scalar docs UI, Zod schema patterns, adding endpoints, SSE streaming, validation errors                                                               |
| [`contributing/configuration.md`](contributing/configuration.md)                                     | Config file system, settings reference, CLI commands, precedence rules, REST API, error recovery                                                                    |
| [`contributing/interactive-tools.md`](contributing/interactive-tools.md)                             | Tool approval, AskUserQuestion, TaskList interactive flows                                                                                                          |
| [`contributing/keyboard-shortcuts.md`](contributing/keyboard-shortcuts.md)                           | Keyboard shortcuts and hotkeys                                                                                                                                      |
| [`contributing/data-fetching.md`](contributing/data-fetching.md)                                     | TanStack Query patterns, mutations                                                                                                                                  |
| [`contributing/state-management.md`](contributing/state-management.md)                               | Zustand vs TanStack Query decision guide                                                                                                                            |
| [`contributing/animations.md`](contributing/animations.md)                                           | Motion library patterns                                                                                                                                             |
| [`contributing/styling-theming.md`](contributing/styling-theming.md)                                 | Tailwind v4, dark mode, Shadcn                                                                                                                                      |
| [`contributing/parallel-execution.md`](contributing/parallel-execution.md)                           | Parallel agent execution patterns, batching, context savings                                                                                                        |

## Documentation

Two documentation systems exist side-by-side:

| Directory | Audience | Format | Purpose |
|---|---|---|---|
| `contributing/` | Internal devs & Claude Code agents | Markdown | Deep implementation details, code patterns, FSD layers |
| `docs/` | External users & integrators | MDX (Fumadocs) | Task-oriented guides, API reference, getting started |

The `docs/` directory contains MDX content structured for [Fumadocs](https://fumadocs.dev) consumption. The `apps/site` workspace (`@dorkos/site`) is a Next.js 16 marketing site that renders these docs via fumadocs-mdx at `/docs/*`, plus an OpenAPI-powered API reference at `/docs/api/*`. Deployed to Vercel with turbo-ignore for smart rebuild skipping. The `docs/api/openapi.json` is generated by `pnpm docs:export-api` and gitignored.

## Testing

Tests use Vitest with `vi.mock()` for Node modules. A shared `vitest.workspace.ts` at the repo root configures test projects for each app. Server tests mock `fs/promises` for transcript reading. Client tests use React Testing Library with jsdom and inject mock `Transport` objects via `TransportProvider` wrappers (see `contributing/architecture.md` for the pattern). Shared test utilities (mock factories, helpers) live in `packages/test-utils/`.

Tests live alongside source in `__tests__/` directories within each app and package (e.g., `apps/server/src/services/__tests__/transcript-reader.test.ts`).

## Code Quality

**ESLint 9** with **per-package flat configs** + **Prettier** (`.prettierrc`) enforce code quality and formatting across the monorepo. Shared presets live in `packages/eslint-config/` (`@dorkos/eslint-config`) with four composable presets: `base.js` (TypeScript + TSDoc + Prettier), `react.js` (React hooks + React Compiler), `node.js` (Node.js-specific rules), and `test.js` (Vitest globals). Each app and package has its own `eslint.config.js` that composes the relevant presets and adds package-specific rules. The root `eslint.config.js` is a thin ~15-line file that only lints root-level files, ignoring `apps/` and `packages/` (which have their own configs). Turbo caches lint per-package via `dependsOn: ["^lint"]`.

- **Warn-first approach**: Most rules are warnings to avoid blocking development. Only critical issues (FSD layer violations) are errors.
- **No type-checked lint rules**: The typecheck hook already runs `tsc --noEmit` — ESLint uses syntax-only TypeScript rules (`tseslint.configs.recommended`).
- **FSD layer enforcement**: `no-restricted-imports` rules in the client's `eslint.config.js` enforce the unidirectional layer dependency hierarchy as hard errors. Cross-feature model imports are enforced by the Claude Code rule in `.claude/rules/fsd-layers.md`.
- **SDK import confinement**: The server's `eslint.config.js` bans `@anthropic-ai/claude-agent-sdk` imports outside of `services/runtimes/claude-code/` via `no-restricted-imports`.
- **os.homedir() ban**: The server's `eslint.config.js` bans importing `homedir` from `os` in `apps/server/src/**/*.ts` (with a carve-out for `lib/dork-home.ts`). See `.claude/rules/dork-home.md`.
- **React Compiler rules**: Bundled with `eslint-plugin-react-hooks` v7, downgraded to warnings.
- **TSDoc**: `eslint-plugin-jsdoc` enforces TSDoc on exported functions/classes (warn-first). See `.claude/rules/documentation.md` for conventions.
- **Prettier + Tailwind**: `prettier-plugin-tailwindcss` sorts Tailwind classes automatically.
- **Claude Code rules**: 9 path-specific rules in `.claude/rules/` provide contextual guidance when editing matching files — covering API routes, components, testing, FSD layers, server structure, code quality, file size, documentation, and dorkHome conventions. See `.claude/README.md` Rules table for the full list.

## CI

A GitHub Actions workflow (`.github/workflows/cli-smoke-test.yml`) validates the CLI install path on every push to main. Four jobs run after a shared `build-tarball` step: `smoke-test-bare` (Node 20/22 matrix on Ubuntu), `smoke-test-docker` (isolated `node:20-slim` container), and `integration-test` (full server startup + API/client endpoint validation). Smoke tests verify `dorkos --version`, `--help`, `--post-install-check`, and `init --yes`. Integration tests start the server and validate `/api/health`, `/api/sessions`, `/api/config`, `/api/models`, and client SPA serving. A mock Claude CLI stub is used since the real CLI is unavailable in CI. Run `pnpm smoke:docker` or `pnpm smoke:integration` locally for the same Docker-based tests.

## Research

Research artifacts from the `research-expert` agent live in `research/` using the naming convention `YYYYMMDD_topic-slug.md`. There are 80+ reports covering topics like scheduler design, relay/mesh architecture, Turborepo env vars, marketing strategy, and more.

**Always check `research/` before doing new research.** Use `Grep` to search filenames and content for relevant keywords. If a report covers the question, use it directly rather than re-doing the work. Only research the gaps or explicitly stale information.

## Architecture Decision Records

Key architectural decisions are documented in `decisions/` as lightweight ADRs (Michael Nygard format). Each ADR has YAML frontmatter (`number`, `title`, `status`, `created`, `spec`) and sections for Context, Decision, and Consequences.

- **Index**: `decisions/manifest.json` tracks all ADRs with `nextNumber` for sequential assignment
- **Commands**: `/adr:create` (new ADR), `/adr:list` (display table), `/adr:from-spec` (extract from spec)
- **Statuses**: `proposed` | `accepted` | `deprecated` | `superseded`

## Plans

Implementation plans, design reviews, and multi-step work breakdowns live in `plans/` at the repo root. This is the canonical location — do not use `docs/plans/` (legacy, being migrated) or `.plan` (ad-hoc holdover).

## Specifications

Feature specifications live in `specs/` with a central index at `specs/manifest.json`. Each spec has a directory (`specs/{slug}/`) containing `01-ideation.md`, `02-specification.md`, and optionally `03-tasks.json` (structured task data) + `03-tasks.md` (human-readable breakdown). The manifest tracks chronological ordering via `nextNumber` and spec metadata (`number`, `slug`, `title`, `created`, `status`).
