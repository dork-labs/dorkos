# DorkOS Architecture

## Overview

The DorkOS uses a hexagonal (ports & adapters) architecture centered on a **Transport** abstraction layer. This enables the same React client to run in two modes:

1. **Standalone web** -- Express server + HTTP/SSE via `HttpTransport`
2. **Obsidian plugin** -- In-process services via `DirectTransport`, no server needed

## Core Abstraction: Transport Interface

The `Transport` interface (`packages/shared/src/transport.ts`) defines 9 methods that cover all client-server communication:

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

## Testing

All hooks and components use mock `Transport` objects injected via `TransportProvider` in test wrappers:

```typescript
function createMockTransport(overrides?: Partial<Transport>): Transport {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    // ...all 9 methods
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
