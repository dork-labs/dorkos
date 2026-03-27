# CLAUDE.md

## Vision

DorkOS is the operating system for autonomous AI agents. It provides the coordination layer — scheduling, communication, discovery, memory — that lets one person ship like a team. The intelligence comes from the agents. Everything else comes from DorkOS.

**Core thesis:** Intelligence doesn't scale. Coordination does.

See [meta/dorkos-litepaper.md](meta/dorkos-litepaper.md) for the full vision and [meta/brand-foundation.md](meta/brand-foundation.md) for brand positioning.

## Quality Standard

We pursue world-class UI/UX **and** world-class DX. Neither is negotiable. Neither is secondary.

**UX excellence** means every interaction is crafted — how a panel animates open, how an error message reads, how the layout breathes. Every pixel, transition, and word is a decision about quality. This product should be so well-crafted that Steve Jobs and Jony Ive would use it as an example of excellence.

**DX excellence** means clean API surfaces, precise TypeScript types, helpful error messages, predictable conventions, and architecture that a staff engineer would admire. Priya reads source code before adopting tools. If our internals wouldn't survive her scrutiny, we haven't shipped.

**Codebase excellence** is non-negotiable. Before writing new code, study existing patterns in the codebase and follow them — consistency is a feature, and diverging from established conventions requires justification, not just preference. We never leave things incomplete — no TODOs that linger, no half-finished migrations, no dead code. We never tolerate deprecated or legacy patterns; when something is superseded, we remove it. We have the courage to refactor even when it's hard and would be easier to leave alone. If something is weird or unintuitive but _must_ stay, we comment _why_. If it doesn't need to stay, we refactor it. Simplicity is an active pursuit — we continuously simplify the application, the UI/UX, and the code. The codebase should get cleaner over time, not accumulate cruft.

### Design Mentors

When making decisions, ask what these people would think of your work:

**Steve Jobs** — _Taste and focus._ Say no to a thousand things. Design is how it works, not how it looks. Care about the back of the fence even if nobody sees it. The intersection of technology and the humanities.

**Jony Ive** — _Simplicity through rigor._ "True simplicity is derived from so much more than just the absence of clutter." Doing something genuinely better is very hard. Obsessive refinement of materials and craft.

**Dieter Rams** — _Less, but better._ Good design is honest. Good design is unobtrusive. Good design is thorough down to the last detail. Good design is as little design as possible.

### Decision-Making Filters

1. **The Apple Test**: Describe what happens for the user, not how the system works internally. "Get a Telegram message when your agent finishes" — not "publish to a hierarchical subject namespace."
2. **Less, but better**: Every element should justify its existence. If removing it wouldn't hurt the user, remove it.
3. **Honest by design**: Tell the user exactly what happens. No dark patterns, no marketing language in the product, no hiding complexity behind false simplicity.
4. **The Kai Test**: Would our primary persona — a senior dev who runs 10 agents across 5 projects — find this valuable? Or would he dismiss it as "another chatbot wrapper"? (See `meta/personas/the-autonomous-builder.md`)
5. **The Priya Test**: Does this respect our secondary persona's flow? She's a staff architect who thinks in Obsidian and codes with Claude. Context-switching costs her 15 minutes of mental state. (See `meta/personas/the-knowledge-architect.md`)
6. **The Anti-Persona Filter**: If a feature would primarily serve someone who expects a hosted, no-code, visual builder — it's out of scope. DorkOS is for developers who ship. (See `meta/personas/the-prompt-dabbler.md`)

### Brand Voice in the Product

Confident. Minimal. Technical. Sharp. Honest. Not corporate. Use language like _autonomous_, _engine_, _orchestration_, _agents_, _control_, _operator_, _builder_. Never use hype language. The product itself should feel like a control panel, not a consumer app.

## Who We Build For

**Kai Nakamura** (primary) — Senior dev / indie hacker. Runs 10-20 agent sessions per week across 5 projects. Thinks in systems, not sessions. Wants his agents to work while he sleeps and tell him what they did. Dismisses "chatbot wrappers" instantly.

**Priya Sharma** (secondary) — Staff engineer / architect. Lives in Obsidian. Wants to query her coding agent without leaving her architecture document. Flow preservation is her core emotional need. Reads source code before adopting tools.

Full personas in `meta/personas/`. Value architecture in `meta/value-architecture-applied.md`.

## Monorepo Structure

Turborepo monorepo:

```
dorkos/
├── apps/
│   ├── client/           # @dorkos/client - React 19 SPA (Vite 6, Tailwind 4, shadcn/ui)
│   ├── server/           # @dorkos/server - Express API (tsc, NodeNext)
│   ├── site/             # @dorkos/site - Marketing site & docs (Next.js 16, Fumadocs)
│   ├── obsidian-plugin/  # @dorkos/obsidian-plugin - Obsidian plugin (Vite lib, CJS)
│   └── e2e/              # @dorkos/e2e - Playwright browser tests
├── packages/
│   ├── cli/              # dorkos - Publishable npm CLI (esbuild bundle)
│   ├── shared/           # @dorkos/shared - Zod schemas, types, AgentRuntime interface
│   ├── db/               # @dorkos/db - Drizzle ORM schemas (SQLite)
│   ├── relay/            # @dorkos/relay - Inter-agent message bus
│   ├── mesh/             # @dorkos/mesh - Agent discovery & registry
│   ├── eslint-config/    # @dorkos/eslint-config - Shared ESLint presets
│   ├── typescript-config/ # @dorkos/typescript-config
│   ├── icons/            # @dorkos/icons - SVG icon & logo registry
│   └── test-utils/       # @dorkos/test-utils - Mock factories, test helpers
├── meta/                 # Brand foundation, personas, value architecture, litepaper
├── decisions/            # Architecture Decision Records (ADRs)
├── docs/                 # External user-facing docs (MDX for Fumadocs)
├── plans/                # Implementation plans, design reviews
├── research/             # Research artifacts (140+ reports)
├── specs/                # Feature specs with manifest.json
└── contributing/         # Internal dev guides (architecture, design system, patterns)
```

## Commands

```bash
pnpm dev               # Start both Express server and Vite dev server (loads .env)
dotenv -- turbo dev --filter=@dorkos/server   # Express server only
dotenv -- turbo dev --filter=@dorkos/client   # Vite dev server only
pnpm test              # Vitest across client + server
pnpm test -- --run     # Vitest single run (no watch)
pnpm build             # Build all apps
pnpm typecheck         # Type-check all packages
pnpm lint              # ESLint across all packages
pnpm lint -- --fix     # Auto-fix
pnpm format            # Prettier format all files
pnpm smoke:docker      # CLI Docker smoke test
pnpm smoke:integration # Full integration test (server + API + client in Docker)
```

Run a single test: `pnpm vitest run <path-to-test-file>`. Agent worktree commands: `/worktree:create`, `/worktree:list`, `/worktree:remove`.

## Architecture

**Hexagonal architecture** with a `Transport` interface (`packages/shared/src/transport.ts`) decoupling the React client from its backend. Two adapters: `HttpTransport` (standalone web) and `DirectTransport` (Obsidian plugin, in-process). See `contributing/architecture.md`.

### Server (`apps/server/src/`)

Express server on `DORKOS_PORT` (default 4242, dev convention 6242). Routes obtain the active runtime via `runtimeRegistry.getDefault()`. The `AgentRuntime` interface (`packages/shared/src/agent-runtime.ts`) abstracts all agent backends. SDK interactions are confined to `services/runtimes/claude-code/` (enforced by ESLint).

**Service domains:** `services/core/` (shared infra), `services/runtimes/` (agent backends), `services/pulse/` (scheduling), `services/relay/` (messaging), `services/mesh/` (discovery), `services/discovery/` (filesystem scanning), `services/session/` (session management). API docs at `/api/docs`.

**Key conventions:**

- `lib/dork-home.ts` is the single source of truth for the data directory (`~/.dork/` in production, `apps/server/.temp/.dork/` in dev). See `.claude/rules/dork-home.md`
- `lib/resolve-root.ts` resolves the default working directory (`DORKOS_DEFAULT_CWD` env var or repo root)
- Each app has its own `env.ts` with Zod-validated env vars
- External MCP server at `/mcp` — Streamable HTTP transport, stateless, optional API key auth (`MCP_API_KEY`). Exposes all DorkOS tools to external agents (Claude Code, Cursor, Windsurf).

### Sessions

Sessions derive entirely from SDK JSONL files (`~/.claude/projects/{slug}/*.jsonl`). There is no separate session store. All sessions are visible regardless of which client created them. Session locking via `X-Client-Id` prevents concurrent writes. Cross-client sync via persistent SSE (`GET /api/sessions/:id/stream`).

### Agent Storage (ADR-0043)

`.dork/agent.json` on disk (source of truth) + SQLite `agents` table (derived cache). **File-first write-through** — write disk, then update DB. Reconciler syncs file to DB every 5 minutes.

### Client (`apps/client/src/`)

React 19 + Vite 6 + Tailwind CSS 4 + shadcn/ui (new-york style, neutral gray). Uses **Feature-Sliced Design (FSD)** with strict unidirectional layer imports.

**FSD layer rule**: `shared` ← `entities` ← `features` ← `widgets`. This is inviolable. See `.claude/rules/fsd-layers.md`. Layers live in `apps/client/src/layers/`. The app shell (`App.tsx`, `AppShell.tsx`, `main.tsx`, `router.tsx`) lives at the `src/` root and can import from any layer. Each module has a barrel `index.ts` — always import from barrels, never internal paths.

**Routing**: TanStack Router with code-based route definitions in `router.tsx`. Route structure:

- `/` → `DashboardPage` (widgets/dashboard) — mission control with four sections in priority order: `NeedsAttentionSection` (conditional, zero DOM when empty), `ActiveSessionsSection` (sessions updated in last 2h), `SystemStatusRow` (Pulse/Relay/Mesh health cards + sparkline), `RecentActivityFeed` (time-grouped event feed). With `DashboardSidebar` (navigation + recent agents) and `DashboardHeader` (system health dot + quick actions)
- `/agents` → `AgentsPage` (widgets/agents) — fleet management surface. Mode A (no agents): full-bleed `DiscoveryView`. Mode B (agents present): tabbed `AgentsList` + lazy `TopologyGraph`. With `DashboardSidebar` (shared nav, Agents item active) and `AgentsHeader` (Scan for Agents button)
- `/session` → `SessionPage` (widgets/session) — agent chat, with `SessionSidebar` + `SessionHeader`, `?session=` and `?dir=` search params
- `/dev/*` → Dev playground (outside router, conditional on dev mode)
- Embedded mode (Obsidian plugin) bypasses the router entirely — `App.tsx` renders `<ChatPanel>` directly

**State**: Zustand for UI state, TanStack Query for server state. See `contributing/state-management.md`.

**Client conventions**: `motion` for animations (see `contributing/animations.md`), `streamdown` for markdown rendering, TanStack Router for client-side routing and URL search params (`?session=`, `?dir=`). Design system documented in `contributing/design-system.md`.

### Shared Package (`packages/shared/src/`)

Cross-package imports use `@dorkos/shared/*` subpaths: `/agent-runtime`, `/types`, `/config-schema`, `/relay-schemas`, `/mesh-schemas`, `/manifest`, `/logger`, `/transport`, `/schemas`, `/constants`.

### Path Aliases

- `@/*` → `./src/*` within each app
- `@dorkos/*` for cross-package imports

### CLI (`packages/cli`)

Published to npm as `dorkos`. Config precedence: CLI flags > env vars > `~/.dork/config.json` > defaults.

## Guides

| Guide                                                                                        | Contents                                                    |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [`contributing/architecture.md`](contributing/architecture.md)                               | Hexagonal architecture, Transport, DI, data flows, testing  |
| [`contributing/design-system.md`](contributing/design-system.md)                             | Color palette, typography, spacing (8pt grid), motion specs |
| [`contributing/api-reference.md`](contributing/api-reference.md)                             | OpenAPI spec, Zod schemas, SSE streaming                    |
| [`contributing/configuration.md`](contributing/configuration.md)                             | Config system, CLI commands, precedence                     |
| [`contributing/data-fetching.md`](contributing/data-fetching.md)                             | TanStack Query patterns, mutations                          |
| [`contributing/state-management.md`](contributing/state-management.md)                       | Zustand vs TanStack Query decision guide                    |
| [`contributing/animations.md`](contributing/animations.md)                                   | Motion library patterns                                     |
| [`contributing/styling-theming.md`](contributing/styling-theming.md)                         | Tailwind v4, dark mode, Shadcn                              |
| [`contributing/obsidian-plugin-development.md`](contributing/obsidian-plugin-development.md) | Plugin lifecycle, Electron quirks                           |
| [`contributing/interactive-tools.md`](contributing/interactive-tools.md)                     | Tool approval, AskUserQuestion flows                        |
| [`contributing/parallel-execution.md`](contributing/parallel-execution.md)                   | Parallel agent patterns                                     |
| [`contributing/browser-testing.md`](contributing/browser-testing.md)                         | Playwright E2E test patterns                                |
| [`contributing/environment-variables.md`](contributing/environment-variables.md)             | Env var conventions, turbo.json                             |
| [`contributing/keyboard-shortcuts.md`](contributing/keyboard-shortcuts.md)                   | Keybinding system, customization                            |
| [`contributing/project-structure.md`](contributing/project-structure.md)                     | FSD layers, file organization                               |
| [`contributing/relay-adapters.md`](contributing/relay-adapters.md)                           | Adapter development guide                                   |
| [`contributing/adapter-catalog.md`](contributing/adapter-catalog.md)                         | Adapter catalog system                                      |
| [`contributing/extension-authoring.md`](contributing/extension-authoring.md)                 | Extension authoring guide                                   |

`docs/` contains external user-facing MDX docs rendered by `apps/site` (Next.js 16, Fumadocs, Vercel).

## Hard Rules

These are non-negotiable constraints enforced by ESLint, CI, or convention:

1. **FSD layer violations are errors** — `no-restricted-imports` enforces the unidirectional hierarchy
2. **SDK imports confined** — `@anthropic-ai/claude-agent-sdk` banned outside `services/runtimes/claude-code/`
3. **`os.homedir()` banned** — use `lib/dork-home.ts` instead (carve-out only for that file)
4. **TSDoc on exports** — `eslint-plugin-jsdoc` enforces documentation on exported functions/classes
5. **Prettier + Tailwind** — `prettier-plugin-tailwindcss` sorts classes automatically
6. 10 path-specific rules in `.claude/rules/` provide contextual guidance (see `.claude/README.md`)

## Testing

Vitest with `vi.mock()`. Tests in `__tests__/` alongside source. Client tests use React Testing Library + jsdom with mock `Transport` via `TransportProvider`. Shared helpers in `packages/test-utils/`.

## CI

GitHub Actions validates CLI on push to main: smoke tests (Node 20/22) and integration tests. Run locally: `pnpm smoke:docker` or `pnpm smoke:integration`.

## Research

140+ research reports in `research/` (`YYYYMMDD_topic-slug.md`). **Always check `research/` before doing new research.**

## Artifacts

- **ADRs**: `decisions/` with `manifest.json`. Commands: `/adr:create`, `/adr:list`, `/adr:from-spec`
- **Plans**: `plans/` at repo root (not `docs/plans/` or `.plan`)
- **Specs**: `specs/` with `manifest.json`. Dirs contain `01-ideation.md`, `02-specification.md`, optionally `03-tasks.json`
