# AGENTS.md

## Vision

DorkOS is the operating system for autonomous AI agents. It provides the coordination layer — scheduling, communication, discovery, memory — that lets one person ship like a team. The intelligence comes from the agents. Everything else comes from DorkOS.

**Core thesis:** Intelligence doesn't scale. Coordination does.

See [meta/dorkos-litepaper.md](meta/dorkos-litepaper.md) for the full vision and [meta/brand-foundation.md](meta/brand-foundation.md) for brand positioning.

## Quality Standard

We pursue world-class UI/UX **and** world-class DX. Neither is negotiable. Neither is secondary.

**UX excellence** means every interaction is crafted — how a panel animates open, how an error message reads, how the layout breathes. Every pixel, transition, and word is a decision about quality. Responsive by default: every surface works on mobile, tablet, and desktop. This product should be so well-crafted that Steve Jobs and Jony Ive would use it as an example of excellence.

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
│   ├── desktop/          # @dorkos/desktop - Electron shell (electron-builder, electron.vite)
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
│   ├── skills/            # @dorkos/skills - SKILL.md file format schemas, parser, writer, scanner
│   ├── marketplace/       # @dorkos/marketplace - Marketplace package schemas, parser, validator, scaffolder (install runtime lives in apps/server/src/services/marketplace/)
│   └── test-utils/       # @dorkos/test-utils - Mock factories, test helpers
├── meta/                 # Brand foundation, personas, value architecture, litepaper
├── decisions/            # Architecture Decision Records (ADRs)
├── docs/                 # External user-facing docs (MDX for Fumadocs)
├── plans/                # Implementation plans, design reviews
├── research/             # Research artifacts (280+ reports)
├── specs/                # Feature specs with manifest.json
└── contributing/         # Internal dev guides (architecture, design system, patterns)
```

## Commands

```bash
pnpm dev               # Start both Express server and Vite dev server (loads .env)
pnpm dev:dogfood       # Dev preview (:6241) + built CLI cockpit (:4242) side by side — see contributing/development-workflow.md
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

Run a single test: `pnpm vitest run <path-to-test-file>`.

## Architecture

**Hexagonal architecture** with a `Transport` interface (`packages/shared/src/transport.ts`) decoupling the React client from its backend. Two adapters: `HttpTransport` (standalone web) and `DirectTransport` (Obsidian plugin, in-process). See `contributing/architecture.md`.

### Server (`apps/server/src/`)

Express server on `DORKOS_PORT` (default 4242, dev convention 6242). Routes obtain the active runtime via `runtimeRegistry.getDefault()`. The `AgentRuntime` interface (`packages/shared/src/agent-runtime.ts`) abstracts all agent backends. SDK interactions are confined to `services/runtimes/claude-code/` (enforced by ESLint).

**Service domains:** `core/`, `runtimes/`, `tasks/`, `relay/`, `mesh/`, `session/`, `marketplace/`, `marketplace-mcp/`, `core-extensions/` — all under `services/`. Filesystem scanning lives in `packages/mesh/src/discovery/unified-scanner.ts`. API docs at `/api/docs`.

**Marketplace installs** warrant extra care: `services/marketplace/transaction.ts` runs real `git reset --hard <backup-branch>` against `process.cwd()` on failure paths. Any test exercising a flow that passes `rollbackBranch: true` MUST mock `_internal.isGitRepo` in `beforeEach` to return false, or the rollback will silently destroy uncommitted tracked-file work. See `contributing/marketplace-installs.md#5-transaction-lifecycle` and ADR-0231.

**Key conventions:**

- `lib/dork-home.ts` is the single source of truth for the data directory (`~/.dork/` in production, `apps/server/.temp/.dork/` in dev). See `.claude/rules/dork-home.md`
- `lib/resolve-root.ts` resolves the default working directory (`DORKOS_DEFAULT_CWD` env var or repo root)
- Each app has its own `env.ts` with Zod-validated env vars
- Persistent user config lives at `~/.dork/config.json` via `conf` v15.1.0 (`apps/server/src/services/core/config-manager.ts`). Zod is the authoritative schema; `z.toJSONSchema(UserConfigSchema)` bridges to conf's Ajv validation. Schema changes require a semver-keyed migration — see `contributing/configuration.md` → Schema Migrations and `.claude/skills/adding-config-fields/`. `/system:release` detects drift and offers to scaffold missing migrations before the tag is cut.
- External MCP server at `/mcp` — Streamable HTTP transport, stateless, optional API key auth (`MCP_API_KEY`). Exposes all DorkOS tools to external agents (Claude Code, Cursor, Windsurf), including the 8 marketplace tools that let any MCP-compatible agent search, install, and scaffold DorkOS packages.

### Sessions

Sessions derive entirely from SDK JSONL files (`~/.claude/projects/{slug}/*.jsonl`). There is no separate session store. All sessions are visible regardless of which client created them. Session locking via `X-Client-Id` prevents concurrent writes. `POST /api/sessions/:id/messages` is trigger-only (202); all turn delivery, hydration, and cross-client sync ride the durable per-session SSE stream `GET /api/sessions/:id/events` (snapshot → gap-free replay via `Last-Event-ID` → live events with monotonic `seq`). The global `GET /api/events` stream fans out `session_upserted`/`session_removed`/`session_status` for the live session list.

### Agent Storage (ADR-0043)

`.dork/agent.json` on disk (source of truth) + SQLite `agents` table (derived cache). **File-first write-through** — write disk, then update DB. Reconciler syncs file to DB every 5 minutes.

**DorkBot** is the system agent — auto-created at `~/.dork/agents/dorkbot/` on server startup via `ensureDorkBot()` (`services/mesh/ensure-dorkbot.ts`). It serves as the user's guide to DorkOS and handles background jobs (Tasks, summaries). System agents (`isSystem: true`) cannot be renamed, deleted, or unregistered. This is enforced at HTTP routes, MCP tools, and the client UI.

### Client (`apps/client/src/`)

React 19 + Vite 6 + Tailwind CSS 4 + shadcn/ui (new-york style, neutral gray). Uses **Feature-Sliced Design (FSD)** with strict unidirectional layer imports.

**FSD layer rule**: `shared` ← `entities` ← `features` ← `widgets`. This is inviolable. See `.claude/rules/fsd-layers.md`. Layers live in `apps/client/src/layers/`. The app shell (`App.tsx`, `AppShell.tsx`, `main.tsx`, `router.tsx`) lives at the `src/` root and can import from any layer. Each module has a barrel `index.ts` — always import from barrels, never internal paths.

**Routing**: TanStack Router with code-based route definitions in `router.tsx`. Routes: `/` (dashboard), `/agents` (fleet management with list/topology/denied/access views), `/session` (agent chat), `/marketplace` (Dork Hub), `/marketplace/sources`, `/dev/*` (dev playground). Embedded mode (Obsidian) bypasses the router — `App.tsx` renders `<ChatPanel>` directly.

**State**: Zustand for UI state, TanStack Query for server state. See `contributing/state-management.md`.

**Client conventions**: `motion` for animations (see `contributing/animations.md`), `streamdown` for markdown rendering, TanStack Router for client-side routing and URL search params (`?session=`, `?dir=`). Design system documented in `contributing/design-system.md`.

### Site (`apps/site/src/`)

Next.js 16 marketing site + Fumadocs at `dorkos.ai`. Hosts public marketplace browse (`/marketplace`, `/marketplace/[slug]`) and install telemetry endpoint. Database: Neon Postgres + Drizzle ORM (`apps/site/src/db/schema.ts`). See `contributing/marketplace-telemetry.md`.

### Shared Package (`packages/shared/src/`)

Cross-package imports use `@dorkos/shared/*` subpaths: `/agent-runtime`, `/types`, `/config-schema`, `/relay-schemas`, `/mesh-schemas`, `/manifest`, `/logger`, `/transport`, `/schemas`, `/constants`.

### CLI (`packages/cli`)

Published to npm as `dorkos`. Config precedence: CLI flags > env vars > `~/.dork/config.json` > defaults.

## Guides

24 developer guides in [`contributing/`](contributing/INDEX.md) covering architecture, design system, data fetching, state management, testing, marketplace, and more. `docs/` contains external user-facing MDX docs rendered by `apps/site` (Next.js 16, Fumadocs, Vercel).

## The `/flow` Workflow

`/flow` is the one unified, PM-agnostic workflow engine for all product work, spanning **capture to done**. Its canonical home is the external marketplace plugin (`dork-labs/marketplace`, `plugins/flow/`), not this repo: 100% of flow (commands, skills, hooks, the runnable engine + tests, scripts, adapters, config, docs) lives in that one plugin. dorkos is a **consumer** that dogfoods it, not flow's home (ADR-0297). One canonical **stage model** (`CAPTURE -> TRIAGE -> IDEATE -> SPECIFY -> DECOMPOSE -> EXECUTE -> VERIFY -> ⟦REVIEW⟧ -> DONE -> (MONITOR -> SIGNAL)`) replaces the legacy `/pm`, `/ideate`, `/ideate-to-spec`, `/spec:*`, and `/linear:*` command sprawl. Tracker state, spec status, labels, and loop phase are all **projected** from the stage via the adapter, never authored independently; match on a state **category** (`backlog | unstarted | started | completed | canceled`), never a tracker's display **name**.

**Dogfooding the plugin (interim):** load it into a session with `claude --plugin-dir /Users/doriancollier/Keep/dork-os/marketplace/plugins/flow` (a local checkout of the marketplace repo). This registers the plugin's commands, skills, and Stop hook for the session. The blessed install + `dorkos contribute` loop is tracked as DOR-172; until then `--plugin-dir` is the path.

**Commands (command ↔ stage):** the plugin namespaces every command under `/flow:`: `/flow:flow` (orchestrator, routes to a stage, a work item, or `auto`) · `/flow:capture` · `/flow:triage` · `/flow:ideate` · `/flow:specify` · `/flow:decompose` · `/flow:execute` · `/flow:verify` · `/flow:done`. `REVIEW` is a human gate (no command). Each `/flow:<stage>` is a thin trigger over its gerund-named stage skill; a PM transition into a stage and the slash command are two triggers for the same skill.

**Manual vs autonomous (orthogonal to the trigger source):** run one stage and stop (`/flow:<stage>`), or run to a gate: `/flow:flow auto` drains the ready queue **sequentially from the terminal** (server-free), and the **Pulse** seat claims the top-ranked eligible item each tick and carries it to its review gate in a fresh per-item session. **Autonomous mode (Pulse) depends on a running DorkOS server; manual mode does not.** Involvement is **uncertainty-gated, not stage-gated** (the calibration ladder): IDEATE asks freely, EXECUTE asks rarely, as an emergent property of one rule. The human-review gate (after VERIFY) is always on; the plan-approval gate (after DECOMPOSE) is off by default.

**The adapter seam:** all tracker I/O is confined to the `linear-adapter` skill (the v1 `PMClient`), a single audit surface; generic stage skills speak the generic `WorkItem` model + verbs and never embed a tracker string. Linear is the v1 tracker: DorkOS is a Linear **team** (key `DOR`) holding multiple projects. Reach Linear via the Linear MCP tools or, when MCP is unauthenticated, the Composio CLI (`composio execute LINEAR_* --account personal`, where the `personal` account holds DorkOS; never the `artblocks` work account).

See [`contributing/flow-engine.md`](contributing/flow-engine.md) (the internal dev guide and consumer-wiring reference) and the plugin's own `README.md` (the manual) + `SPEC.md` (the contract) at `dork-labs/marketplace`, `plugins/flow/`.

## Compact Instructions

If auto-compaction fires mid-`/flow`, **preserve this state above all else** — it is what makes the work resumable across the compaction boundary (the within-stage seatbelt, spec §11). When you summarize, carry forward verbatim:

- **Current work item** — its identifier (e.g. `DOR-123`) and title.
- **Current stage** — where on the spine the work is (`CAPTURE … DONE`) and the active sub-step.
- **Gate state** — whether parked at a gate (review / plan-approval / a `needs-input` question) and, if so, what is awaited.
- **Artifact pointers** — the spec dir (`specs/<slug>/`), the worktree path + branch, the `flow-state.json` run record, and any open PR.
- **Assumption trail** — calibration-ladder assumptions logged so far (so the review gate stays auditable).

Filesystem + tracker are ground truth (the model is amnesiac by design); recover the rest from `flow-state.json`, `specs/<slug>/04-implementation.md`, and the tracker via the `linear-adapter`. Never invent progress you cannot re-derive from those.

## Worktrees

**One checkout, one writer.** This repo is routinely multi-agent, so `main` is the clean integration tree, not a shared scratchpad. Two agents mutating one checkout corrupt each other — the `Stop` auto-checkpoint hook (`git add -A` + stash + reset) races concurrent git and yields empty-tree commits or sweeps the other agent's files (same failure modes as `research/20260611_workspace_strategy_runtimes_symphony.md`).

**Default to an isolated worktree for any code change.** Stay in `main` only when you are certainly the sole writer _and_ the work is non-code (`research/`, `specs/`, tracker, docs prose) or one commit landed immediately. Trigger a worktree when another agent may share the checkout, the work is multi-commit, the tree is dirty or on another topic, or a dev server must run undisturbed. Never create one from inside one; never auto-remove one with uncommitted or unpushed work. Mechanics, detection, and cleanup: `working-in-worktrees` skill + `/worktree:create|list|remove`; the execution gate is the `/flow:execute` stage (Phase 0 of the `implementing-specifications` skill, shipped by the external flow plugin): where the intent stages (`/flow:ideate`/`/flow:specify`/`/flow:decompose`, `specs/` markdown only) stay in `main`, isolation begins at `EXECUTE`.

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

280+ research reports in `research/` (`YYYYMMDD_topic-slug.md`). **Always check `research/` before doing new research.**

## Artifacts

- **ADRs**: `decisions/` with `manifest.json`. Commands: `/adr:create`, `/adr:list`, `/adr:from-spec`
- **Plans**: `plans/` at repo root (not `docs/plans/` or `.plan`)
- **Specs**: `specs/` with `manifest.json`. Dirs contain `01-ideation.md`, `02-specification.md`, optionally `03-tasks.json`
