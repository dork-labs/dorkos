# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

LifeOS Gateway is a web-based interface and REST/SSE API for Claude Code, built with the Claude Agent SDK. It provides a chat UI for interacting with Claude Code sessions, with tool approval flows and slash command discovery.

The Agent SDK is fully integrated via `agent-manager.ts`, which calls the SDK's `query()` function and maps streaming events to the gateway's `StreamEvent` types. SDK JSONL transcript files are the single source of truth for all session data.

## Monorepo Structure

This is a Turborepo monorepo with three apps and four shared packages:

```
lifeos-gateway/
├── apps/
│   ├── client/           # @lifeos/client - React 19 SPA (Vite 6, Tailwind 4, shadcn/ui)
│   ├── server/           # @lifeos/server - Express API (tsc, NodeNext)
│   └── obsidian-plugin/  # @lifeos/obsidian-plugin - Obsidian plugin (Vite lib, CJS)
├── packages/
│   ├── cli/              # @lifeos/gateway - Publishable npm CLI (esbuild bundle)
│   ├── shared/           # @lifeos/shared - Zod schemas, types (JIT .ts exports)
│   ├── typescript-config/ # @lifeos/typescript-config - Shared tsconfig presets
│   └── test-utils/       # @lifeos/test-utils - Mock factories, test helpers
├── turbo.json
├── vitest.workspace.ts
└── package.json          # Root workspace config + turbo only
```

## Commands

```bash
turbo dev              # Start both Express server (port 6942) and Vite dev server (port 3000)
turbo dev --filter=@lifeos/server   # Express server only
turbo dev --filter=@lifeos/client   # Vite dev server only (React UI with HMR)
turbo test             # Vitest across client + server
turbo test -- --run    # Vitest single run
turbo build            # Build all 3 apps (client Vite + server tsc + obsidian plugin)
turbo typecheck        # Type-check all packages
turbo build --filter=@lifeos/obsidian-plugin  # Build Obsidian plugin only
npm run build -w packages/cli  # Build CLI package (esbuild bundles server+client+CLI)
npm start              # Production server (serves built React app)
npm run dev:tunnel -w apps/server   # Dev server + ngrok tunnel (tunnels Vite on :3000)
```

Run a single test file: `npx vitest run apps/server/src/services/__tests__/transcript-reader.test.ts`

## Architecture

The gateway uses a **hexagonal architecture** with a `Transport` interface (`packages/shared/src/transport.ts`) that decouples the React client from its backend. Two adapters exist: `HttpTransport` (standalone web, HTTP/SSE to Express) and `DirectTransport` (Obsidian plugin, in-process services). Transport is injected via React Context (`TransportContext`). See `guides/architecture.md` for full details.

### Server (`apps/server/src/`)

Express server on port `GATEWAY_PORT` (default 6942). Three route groups:

- **`routes/sessions.ts`** - Session listing (from SDK transcripts), session creation, SSE message streaming, message history, tool approve/deny endpoints
- **`routes/commands.ts`** - Scans `../../.claude/commands/` for slash commands using gray-matter frontmatter parsing
- **`routes/health.ts`** - Health check; includes optional `tunnel` status field when ngrok is enabled

Four services:

- **`services/agent-manager.ts`** - Manages Claude Agent SDK sessions. Calls `query()` with streaming, maps SDK events (`stream_event`, `tool_use_summary`, `result`) to gateway `StreamEvent` types. Tracks active sessions in-memory with 30-minute timeout. All sessions use `resume: sessionId` for SDK continuity. Accepts optional `cwd` constructor param (used by Obsidian plugin). Resolves the Claude Code CLI path dynamically via `resolveClaudeCliPath()` for Electron compatibility.
- **`services/transcript-reader.ts`** - Single source of truth for session data. Reads SDK JSONL transcript files from `~/.claude/projects/{slug}/`. Provides `listSessions()` (scans directory, extracts metadata), `getSession()` (single session metadata), and `readTranscript()` (full message history). Extracts titles from first user message, permission mode from init message, timestamps from file stats.
- **`services/stream-adapter.ts`** - SSE helpers (`initSSEStream`, `sendSSEEvent`, `endSSEStream`) that format `StreamEvent` objects as SSE wire protocol.
- **`services/tunnel-manager.ts`** - Opt-in ngrok tunnel lifecycle. Singleton that wraps `@ngrok/ngrok` SDK with dynamic import (zero cost when disabled). Configured via env vars: `TUNNEL_ENABLED`, `NGROK_AUTHTOKEN`, `TUNNEL_PORT`, `TUNNEL_AUTH`, `TUNNEL_DOMAIN`. Started after Express binds in `index.ts`; tunnel failure is non-blocking. Exposes `status` getter consumed by `health.ts`. Graceful shutdown via SIGINT/SIGTERM.

### Session Architecture

Sessions are derived entirely from SDK JSONL files on disk (`~/.claude/projects/{slug}/*.jsonl`). There is no separate session store - the `TranscriptReader` scans these files to build the session list. This means:

- All sessions are visible (CLI-started, gateway-started, etc.)
- Session ID = SDK session ID (UUID from JSONL filename)
- No delete endpoint (sessions persist in SDK storage)
- Session metadata (title, preview, timestamps) is extracted from file content and stats on every request

### Client (`apps/client/src/`)

React 19 + Vite 6 + Tailwind CSS 4 + shadcn/ui (new-york style, pure neutral gray palette).

- **State**: Zustand for UI state (`app-store.ts`), TanStack Query for server state (`use-sessions.ts`, `use-commands.ts`)
- **URL Parameters**: `?session=` (session ID via nuqs) and `?dir=` (working directory via nuqs) persist client state in the URL for standalone mode. In Obsidian embedded mode, both use Zustand instead. The `?dir=` parameter is omitted when using the server default directory to keep URLs clean.
- **Chat**: `useChatSession` hook loads message history via `useTransport().getMessages()`, then streams via `transport.sendMessage()` with callback pattern. Tracks text deltas and tool call lifecycle in refs for performance. Exposes `isLoadingHistory` for UI feedback.
- **Components**: `ChatPanel` > `MessageList` > `MessageItem` + `ToolCallCard`; `SessionSidebar`; `CommandPalette`; `PermissionBanner` + `ToolApproval` for tool approval flow
- **Markdown Rendering**: Assistant messages are rendered as rich markdown via the `streamdown` library (Vercel). `StreamingText` wraps the `<Streamdown>` component with `github-light`/`github-dark` Shiki themes and shows a blinking cursor during active streaming. User messages remain plain text. The `@source` directive in `index.css` ensures Streamdown's Tailwind classes are included in the CSS output.
- **Animations**: `motion` (motion.dev) for UI animations. `App.tsx` wraps the app in `<MotionConfig reducedMotion="user">` to respect `prefers-reduced-motion`. Used for: message entrance animations (new messages only, not history), tool card expand/collapse, command palette enter/exit, sidebar width toggle, button micro-interactions. Tests mock `motion/react` to render plain elements.
- **Design System**: Color palette, typography, spacing (8pt grid), and motion specs are documented in `guides/design-system.md`.

### Shared (`packages/shared/src/`)

`schemas.ts` defines Zod schemas for all types with OpenAPI metadata. Each schema exports an inferred TypeScript type (e.g., `export type Session = z.infer<typeof SessionSchema>`). `types.ts` re-exports all types from `schemas.ts`, so existing `import { Session } from '@lifeos/shared/types'` imports work unchanged.

**API docs** are available at `/api/docs` (Scalar UI) and `/api/openapi.json` (raw spec). The OpenAPI spec is auto-generated from the Zod schemas in `apps/server/src/services/openapi-registry.ts`.

**Request validation** uses `schema.safeParse(req.body)` in route handlers. Invalid requests return 400 with `{ error, details }` where details is Zod's formatted error output.

### Path Aliases

- `@/*` -> `./src/*` (within each app, scoped to that app's source)

Cross-package imports use the `@lifeos/*` package names (e.g., `import { Session } from '@lifeos/shared/types'`). The old `@shared/*` alias has been removed.

Configured in each app's `tsconfig.json` (for IDE/tsc) and `vite.config.ts` (for bundling).

### SSE Streaming Protocol

Messages flow: client POST to `/api/sessions/:id/messages` -> server yields `StreamEvent` objects as SSE -> client parses in `useChatSession`.

Event types: `text_delta`, `tool_call_start`, `tool_call_delta`, `tool_call_end`, `tool_result`, `approval_required`, `error`, `done`.

### Session History

When a session is opened, the client fetches message history via GET `/api/sessions/:id/messages`. The server reads the SDK's JSONL transcript file at `~/.claude/projects/{slug}/{sessionId}.jsonl`, parsing user and assistant messages. This works for sessions started from any client (CLI, gateway, etc.) since all use the same SDK storage.

### Vault Root Resolution

**Standalone server:** Resolves repo root from `apps/server/dist/` upward to the repository root.

**Obsidian plugin:** `CopilotView` computes `repoRoot = path.resolve(vaultPath, '..')` (vault is `workspace/`, repo root is its parent). This is passed to `AgentManager(repoRoot)` and `CommandRegistryService(repoRoot)`.

Both paths are used by `CommandRegistryService` to find `.claude/commands/` and by `AgentManager` as the SDK's working directory.

### Obsidian Plugin Build

The plugin build (`apps/obsidian-plugin/vite.config.ts`) includes four Vite plugins (in `apps/obsidian-plugin/build-plugins/`) that post-process `main.js` for Electron compatibility: `copyManifest`, `safeRequires`, `fixDirnamePolyfill`, `patchElectronCompat`. Output goes to `apps/obsidian-plugin/dist/`. See `guides/architecture.md` > "Electron Compatibility Layer" for details.

### CLI Package (`packages/cli`)

The `@lifeos/gateway` npm package bundles the server + client into a standalone CLI tool. Build pipeline (`packages/cli/scripts/build.ts`) uses esbuild in 3 steps: (1) Vite builds client to static assets, (2) esbuild bundles server + `@lifeos/shared` into single ESM file (externalizing node_modules), (3) esbuild compiles CLI entry point. Output: `dist/bin/cli.js` (entry with shebang), `dist/server/index.js` (bundled server), `dist/client/` (React SPA). The CLI uses `node:util` parseArgs and sets environment variables (`GATEWAY_PORT`, `CLIENT_DIST_PATH`, `GATEWAY_CWD`, `TUNNEL_ENABLED`, `NODE_ENV`) before dynamically importing the bundled server.

## Guides

Detailed documentation lives in `guides/`:

| Guide | Contents |
|-------|----------|
| [`guides/architecture.md`](guides/architecture.md) | Hexagonal architecture, Transport interface, dependency injection, Electron compatibility layer, build plugins, data flow diagrams, module layout, testing patterns |
| [`guides/design-system.md`](guides/design-system.md) | Color palette, typography, spacing (8pt grid), motion specs, component conventions |
| [`guides/obsidian-plugin-development.md`](guides/obsidian-plugin-development.md) | Plugin lifecycle, ItemView pattern, React mounting, active file tracking, drag-and-drop, Vite build config, Electron quirks, debugging, common issues |
| [`guides/api-reference.md`](guides/api-reference.md) | OpenAPI spec, Scalar docs UI, Zod schema patterns, adding endpoints, SSE streaming, validation errors |
| [`guides/interactive-tools.md`](guides/interactive-tools.md) | Tool approval, AskUserQuestion, TaskList interactive flows |

## Testing

Tests use Vitest with `vi.mock()` for Node modules. A shared `vitest.workspace.ts` at the repo root configures test projects for each app. Server tests mock `fs/promises` for transcript reading. Client tests use React Testing Library with jsdom and inject mock `Transport` objects via `TransportProvider` wrappers (see `guides/architecture.md` for the pattern). Shared test utilities (mock factories, helpers) live in `packages/test-utils/`.

Tests live alongside source in `__tests__/` directories within each app and package (e.g., `apps/server/src/services/__tests__/transcript-reader.test.ts`).
