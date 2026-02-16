# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

DorkOS is a web-based interface and REST/SSE API for Claude Code, built with the Claude Agent SDK. It provides a chat UI for interacting with Claude Code sessions, with tool approval flows and slash command discovery.

The Agent SDK is fully integrated via `agent-manager.ts`, which calls the SDK's `query()` function and maps streaming events to the DorkOS `StreamEvent` types. SDK JSONL transcript files are the single source of truth for all session data.

## Monorepo Structure

This is a Turborepo monorepo with three apps and four shared packages:

```
dorkos/
├── apps/
│   ├── client/           # @dorkos/client - React 19 SPA (Vite 6, Tailwind 4, shadcn/ui)
│   ├── server/           # @dorkos/server - Express API (tsc, NodeNext)
│   └── obsidian-plugin/  # @dorkos/obsidian-plugin - Obsidian plugin (Vite lib, CJS)
├── packages/
│   ├── cli/              # dorkos - Publishable npm CLI (esbuild bundle)
│   ├── shared/           # @dorkos/shared - Zod schemas, types (JIT .ts exports)
│   ├── typescript-config/ # @dorkos/typescript-config - Shared tsconfig presets
│   └── test-utils/       # @dorkos/test-utils - Mock factories, test helpers
├── research/             # Research artifacts (persisted by research-expert agent)
├── turbo.json
├── vitest.workspace.ts
└── package.json          # Root workspace config + turbo only
```

## Commands

```bash
npm run dev            # Start both Express server and Vite dev server (loads .env)
dotenv -- turbo dev --filter=@dorkos/server   # Express server only (loads .env)
dotenv -- turbo dev --filter=@dorkos/client   # Vite dev server only (loads .env)
npm test               # Vitest across client + server (loads .env)
npm test -- --run      # Vitest single run
npm run build          # Build all 3 apps (client Vite + server tsc + obsidian plugin)
npm run typecheck      # Type-check all packages
turbo build --filter=@dorkos/obsidian-plugin  # Build Obsidian plugin only
npm run build -w packages/cli  # Build CLI package (esbuild bundles server+client+CLI)
npm publish -w packages/cli   # Publish dorkos to npm (prepublishOnly auto-builds)
npm start              # Production server (serves built React app, loads .env)
npm run dev:tunnel -w apps/server   # Dev server + ngrok tunnel (tunnels Vite on :3000)
npm run lint           # ESLint across all packages
npm run lint -- --fix  # Auto-fix ESLint issues
npm run format         # Prettier format all files
npm run format:check   # Check formatting without writing
```

Run a single test file: `npx vitest run apps/server/src/services/__tests__/transcript-reader.test.ts`

## Architecture

DorkOS uses a **hexagonal architecture** with a `Transport` interface (`packages/shared/src/transport.ts`) that decouples the React client from its backend. Two adapters exist: `HttpTransport` (standalone web, HTTP/SSE to Express) and `DirectTransport` (Obsidian plugin, in-process services). Transport is injected via React Context (`TransportContext`). See `guides/architecture.md` for full details.

### Server (`apps/server/src/`)

Express server on port `DORKOS_PORT` (default 4242). Seven route groups:

- **`routes/sessions.ts`** - Session listing (from SDK transcripts), session creation, SSE message streaming, message history, tool approve/deny endpoints
- **`routes/commands.ts`** - Slash command listing via `CommandRegistryService`, which scans `.claude/commands/` using gray-matter frontmatter parsing
- **`routes/health.ts`** - Health check; includes optional `tunnel` status field when ngrok is enabled
- **`routes/directory.ts`** - Directory browsing for working directory selection
- **`routes/config.ts`** - Configuration management endpoints (GET for server config, PATCH for user config updates with Zod validation)
- **`routes/files.ts`** - File operations (read/list files)
- **`routes/git.ts`** - Git status and branch information

Ten services:

- **`services/agent-manager.ts`** - Manages Claude Agent SDK sessions. Calls `query()` with streaming, maps SDK events (`stream_event`, `tool_use_summary`, `result`) to DorkOS `StreamEvent` types. Tracks active sessions in-memory with 30-minute timeout. All sessions use `resume: sessionId` for SDK continuity. Accepts optional `cwd` constructor param (used by Obsidian plugin). Resolves the Claude Code CLI path dynamically via `resolveClaudeCliPath()` for Electron compatibility.
- **`services/transcript-reader.ts`** - Single source of truth for session data. Reads SDK JSONL transcript files from `~/.claude/projects/{slug}/`. Provides `listSessions()` (scans directory, extracts metadata), `getSession()` (single session metadata), and `readTranscript()` (full message history). Extracts titles from first user message, permission mode from init message, timestamps from file stats.
- **`services/session-broadcaster.ts`** - Manages cross-client session synchronization. Watches JSONL transcript files via chokidar for changes (including CLI writes). Maintains SSE connections with passive clients via `registerClient()`. Broadcasts `sync_update` events when files change. Debounces rapid writes (100ms). Uses incremental byte-offset reading via `transcriptReader.readFromOffset()`. Graceful shutdown closes all watchers and connections.
- **`services/stream-adapter.ts`** - SSE helpers (`initSSEStream`, `sendSSEEvent`, `endSSEStream`) that format `StreamEvent` objects as SSE wire protocol.
- **`services/command-registry.ts`** - Scans `.claude/commands/` for slash commands. Parses YAML frontmatter via gray-matter. Caches results; supports `forceRefresh`. Used by `routes/commands.ts`.
- **`services/openapi-registry.ts`** - Auto-generates OpenAPI spec from Zod schemas. Powers `/api/docs` (Scalar UI) and `/api/openapi.json`.
- **`services/file-lister.ts`** - Lists files in a directory for the client file browser.
- **`services/git-status.ts`** - Provides git status information (branch, changed files).
- **`services/tunnel-manager.ts`** - Opt-in ngrok tunnel lifecycle. Singleton that wraps `@ngrok/ngrok` SDK with dynamic import (zero cost when disabled). Configured via env vars: `TUNNEL_ENABLED`, `NGROK_AUTHTOKEN`, `TUNNEL_PORT`, `TUNNEL_AUTH`, `TUNNEL_DOMAIN`. Started after Express binds in `index.ts`; tunnel failure is non-blocking. Exposes `status` getter consumed by `health.ts`. Graceful shutdown via SIGINT/SIGTERM.
- **`services/config-manager.ts`** - Manages persistent user config at `~/.dork/config.json`. Uses `conf` for atomic JSON I/O with Ajv validation. Singleton initialized via `initConfigManager()` at server startup and in CLI subcommands. Handles first-run detection, corrupt config recovery (backup + recreate), and sensitive field warnings.

### Session Architecture

Sessions are derived entirely from SDK JSONL files on disk (`~/.claude/projects/{slug}/*.jsonl`). There is no separate session store - the `TranscriptReader` scans these files to build the session list. This means:

- All sessions are visible (CLI-started, DorkOS-started, etc.)
- Session ID = SDK session ID (UUID from JSONL filename)
- No delete endpoint (sessions persist in SDK storage)
- Session metadata (title, preview, timestamps) is extracted from file content and stats on every request

### Client (`apps/client/src/`)

React 19 + Vite 6 + Tailwind CSS 4 + shadcn/ui (new-york style, pure neutral gray palette). Uses **Feature-Sliced Design (FSD)** architecture with strict unidirectional layer imports.

**FSD Layers** (`apps/client/src/layers/`):

| Layer                    | Modules                                                            | Purpose                     |
| ------------------------ | ------------------------------------------------------------------ | --------------------------- |
| `shared/ui/`             | 14 shadcn primitives (Badge, Dialog, Select, Tabs, etc.)           | Reusable UI primitives      |
| `shared/model/`          | TransportContext, app-store, 8 hooks (useTheme, useIsMobile, etc.) | Hooks, stores, context      |
| `shared/lib/`            | cn, Transports, font-config, favicon-utils, celebrations, etc.     | Domain-agnostic utilities   |
| `entities/session/`      | useSessionId, useSessions, useDirectoryState, useDefaultCwd        | Session domain hooks        |
| `entities/command/`      | useCommands                                                        | Command domain hook         |
| `features/chat/`         | ChatPanel, MessageList, MessageItem, ToolCallCard, useChatSession  | Chat interface              |
| `features/session-list/` | SessionSidebar, SessionItem, DirectoryPicker                       | Session management          |
| `features/commands/`     | CommandPalette                                                     | Slash command palette       |
| `features/settings/`     | SettingsDialog                                                     | Settings UI                 |
| `features/files/`        | FilePalette, useFiles                                              | File browser                |
| `features/status/`       | StatusLine, GitStatusItem, ModelItem, etc.                         | Status bar                  |
| `widgets/app-layout/`    | PermissionBanner                                                   | App-level layout components |

**Layer dependency rule**: `shared` ← `entities` ← `features` ← `widgets` ← `app` (strictly unidirectional). See `.claude/rules/fsd-layers.md` for full import rules.

- **State**: Zustand for UI state (`layers/shared/model/app-store.ts`), TanStack Query for server state (`entities/session/`, `entities/command/`)
- **URL Parameters**: `?session=` (session ID via nuqs) and `?dir=` (working directory via nuqs) persist client state in the URL for standalone mode. In Obsidian embedded mode, both use Zustand instead. The `?dir=` parameter is omitted when using the server default directory to keep URLs clean.
- **Barrel Exports**: Every FSD module has an `index.ts` barrel. Import from barrels only (e.g., `import { ChatPanel } from '@/layers/features/chat'`), never from internal paths.
- **Markdown Rendering**: Assistant messages are rendered as rich markdown via the `streamdown` library (Vercel). `StreamingText` wraps the `<Streamdown>` component with `github-light`/`github-dark` Shiki themes and shows a blinking cursor during active streaming. User messages remain plain text. The `@source` directive in `index.css` ensures Streamdown's Tailwind classes are included in the CSS output.
- **Animations**: `motion` (motion.dev) for UI animations. `App.tsx` wraps the app in `<MotionConfig reducedMotion="user">` to respect `prefers-reduced-motion`. Used for: message entrance animations (new messages only, not history), tool card expand/collapse, command palette enter/exit, sidebar width toggle, button micro-interactions. Tests mock `motion/react` to render plain elements.
- **Design System**: Color palette, typography, spacing (8pt grid), and motion specs are documented in `guides/design-system.md`.

### Shared (`packages/shared/src/`)

`schemas.ts` defines Zod schemas for all types with OpenAPI metadata. Each schema exports an inferred TypeScript type (e.g., `export type Session = z.infer<typeof SessionSchema>`). `types.ts` re-exports all types from `schemas.ts`, so existing `import { Session } from '@dorkos/shared/types'` imports work unchanged. `config-schema.ts` defines `UserConfigSchema` (Zod) for the persistent config file, exporting the `UserConfig` type, defaults, and sensitive key list. Imported as `@dorkos/shared/config-schema`.

**API docs** are available at `/api/docs` (Scalar UI) and `/api/openapi.json` (raw spec). The OpenAPI spec is auto-generated from the Zod schemas in `apps/server/src/services/openapi-registry.ts`.

**Request validation** uses `schema.safeParse(req.body)` in route handlers. Invalid requests return 400 with `{ error, details }` where details is Zod's formatted error output.

### Path Aliases

- `@/*` -> `./src/*` (within each app, scoped to that app's source)
- FSD layer imports use `@/layers/shared/lib`, `@/layers/shared/model`, `@/layers/features/chat`, etc.

Cross-package imports use the `@dorkos/*` package names (e.g., `import { Session } from '@dorkos/shared/types'`). The old `@shared/*` alias has been removed.

Configured in each app's `tsconfig.json` (for IDE/tsc) and `vite.config.ts` (for bundling).

### SSE Streaming Protocol

Messages flow: client POST to `/api/sessions/:id/messages` -> server yields `StreamEvent` objects as SSE -> client parses in `useChatSession`.

Event types: `text_delta`, `tool_call_start`, `tool_call_delta`, `tool_call_end`, `tool_result`, `approval_required`, `question_prompt`, `error`, `done`, `session_status`, `task_update`.

### Session Sync Protocol

Clients can subscribe to session changes via a persistent SSE connection: `GET /api/sessions/:id/stream`. This provides real-time sync across multiple clients (including CLI changes).

Events:

- `sync_connected` — Sent on initial connection. Data: `{ sessionId }`
- `sync_update` — Sent when new content is written to the session's JSONL file. Data: `{ sessionId, timestamp }`

Clients receiving `sync_update` should re-fetch message history. The GET /messages endpoint supports ETag caching (If-None-Match/304) for efficient polling.

### Session Locking

POST /messages uses session locking to prevent concurrent writes. Clients send an `X-Client-Id` header. If a session is already locked by another client, the server returns 409 with `{ error: 'Session locked', code: 'SESSION_LOCKED', lockedBy, lockedAt }`. Locks auto-expire after 5 minutes and are released when SSE connections close.

### Session History

When a session is opened, the client fetches message history via GET `/api/sessions/:id/messages`. The server reads the SDK's JSONL transcript file at `~/.claude/projects/{slug}/{sessionId}.jsonl`, parsing user and assistant messages. This works for sessions started from any client (CLI, DorkOS, etc.) since all use the same SDK storage.

### Vault Root Resolution

**Standalone server:** Resolves repo root from `apps/server/dist/` upward to the repository root.

**Obsidian plugin:** `CopilotView` computes `repoRoot = path.resolve(vaultPath, '..')` (vault is `workspace/`, repo root is its parent). This is passed to `AgentManager(repoRoot)` and `CommandRegistryService(repoRoot)`.

Both paths are used by `CommandRegistryService` to find `.claude/commands/` and by `AgentManager` as the SDK's working directory.

### Obsidian Plugin Build

The plugin build (`apps/obsidian-plugin/vite.config.ts`) includes four Vite plugins (in `apps/obsidian-plugin/build-plugins/`) that post-process `main.js` for Electron compatibility: `copyManifest`, `safeRequires`, `fixDirnamePolyfill`, `patchElectronCompat`. Output goes to `apps/obsidian-plugin/dist/`. See `guides/architecture.md` > "Electron Compatibility Layer" for details.

### CLI Package (`packages/cli`)

The `dorkos` npm package bundles the server + client into a standalone CLI tool. Published to npm as `dorkos` (unscoped). Install via `npm install -g dorkos`, run via `dorkos`. Build pipeline (`packages/cli/scripts/build.ts`) uses esbuild in 3 steps: (1) Vite builds client to static assets, (2) esbuild bundles server + `@dorkos/shared` into single ESM file (externalizing node_modules), (3) esbuild compiles CLI entry point. Output: `dist/bin/cli.js` (entry with shebang), `dist/server/index.js` (bundled server), `dist/client/` (React SPA). The version is injected at build time via esbuild's `define` config (reads from `packages/cli/package.json`). The CLI creates `~/.dork/` on startup for config storage and sets `DORK_HOME` env var. It also sets `DORKOS_PORT`, `CLIENT_DIST_PATH`, `DORKOS_DEFAULT_CWD`, `TUNNEL_ENABLED`, and `NODE_ENV` before dynamically importing the bundled server.

CLI subcommands: `dorkos config` (manage config), `dorkos init` (interactive setup wizard). Config precedence: CLI flags > environment variables > `~/.dork/config.json` > built-in defaults.

## Guides

Detailed documentation lives in `guides/`:

| Guide                                                                                    | Contents                                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`guides/architecture.md`](guides/architecture.md)                                       | Hexagonal architecture, Transport interface, dependency injection, Electron compatibility layer, build plugins, data flow diagrams, module layout, testing patterns |
| [`guides/design-system.md`](guides/design-system.md)                                     | Color palette, typography, spacing (8pt grid), motion specs, component conventions                                                                                  |
| [`guides/obsidian-plugin-development.md`](guides/obsidian-plugin-development.md)         | Plugin lifecycle, ItemView pattern, React mounting, active file tracking, drag-and-drop, Vite build config, Electron quirks, debugging, common issues               |
| [`guides/api-reference.md`](guides/api-reference.md)                                     | OpenAPI spec, Scalar docs UI, Zod schema patterns, adding endpoints, SSE streaming, validation errors                                                               |
| [`guides/configuration.md`](guides/configuration.md)                                     | Config file system, settings reference, CLI commands, precedence rules, REST API, error recovery                                                                    |
| [`guides/interactive-tools.md`](guides/interactive-tools.md)                             | Tool approval, AskUserQuestion, TaskList interactive flows                                                                                                          |
| [`guides/keyboard-shortcuts.md`](guides/keyboard-shortcuts.md)                           | Keyboard shortcuts and hotkeys                                                                                                                                      |
| [`guides/05-data-fetching.md`](guides/05-data-fetching.md)                               | TanStack Query patterns, mutations                                                                                                                                  |
| [`guides/06-state-management.md`](guides/06-state-management.md)                         | Zustand vs TanStack Query decision guide                                                                                                                            |
| [`guides/07-animations.md`](guides/07-animations.md)                                     | Motion library patterns                                                                                                                                             |
| [`guides/08-styling-theming.md`](guides/08-styling-theming.md)                           | Tailwind v4, dark mode, Shadcn                                                                                                                                      |
| [`guides/11-parallel-execution.md`](guides/11-parallel-execution.md)                     | Parallel agent execution patterns, batching, context savings                                                                                                        |
| [`guides/13-autonomous-roadmap-execution.md`](guides/13-autonomous-roadmap-execution.md) | Autonomous workflow, `/roadmap:work`                                                                                                                                |

## Testing

Tests use Vitest with `vi.mock()` for Node modules. A shared `vitest.workspace.ts` at the repo root configures test projects for each app. Server tests mock `fs/promises` for transcript reading. Client tests use React Testing Library with jsdom and inject mock `Transport` objects via `TransportProvider` wrappers (see `guides/architecture.md` for the pattern). Shared test utilities (mock factories, helpers) live in `packages/test-utils/`.

Tests live alongside source in `__tests__/` directories within each app and package (e.g., `apps/server/src/services/__tests__/transcript-reader.test.ts`).

## Code Quality

**ESLint 9** (flat config at `eslint.config.js`) + **Prettier** (`.prettierrc`) enforce code quality and formatting across the monorepo.

- **Warn-first approach**: Most rules are warnings to avoid blocking development. Only critical issues (FSD layer violations) are errors.
- **No type-checked lint rules**: The typecheck hook already runs `tsc --noEmit` — ESLint uses syntax-only TypeScript rules (`tseslint.configs.recommended`).
- **FSD layer enforcement**: `no-restricted-imports` rules enforce the unidirectional layer dependency hierarchy as hard errors. Cross-feature model imports are enforced by the Claude Code rule in `.claude/rules/fsd-layers.md`.
- **React Compiler rules**: Bundled with `eslint-plugin-react-hooks` v7, downgraded to warnings.
- **TSDoc**: `eslint-plugin-jsdoc` enforces TSDoc on exported functions/classes (warn-first). See `.claude/rules/documentation.md` for conventions.
- **Prettier + Tailwind**: `prettier-plugin-tailwindcss` sorts Tailwind classes automatically.
- **Claude Code rules**: `.claude/rules/file-size.md`, `.claude/rules/documentation.md`, `.claude/rules/code-quality.md` provide additional guidelines for file size limits, documentation standards, and code quality practices.
