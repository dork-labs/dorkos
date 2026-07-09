# AGENTS.md

## Vision

DorkOS is the operating system for autonomous AI agents — the coordination layer (scheduling, communication, discovery, memory) that lets one person ship like a team. **Core thesis: intelligence doesn't scale; coordination does.** Market entry point (2026-07): **mission control for every coding agent you run** — the multi-runtime cockpit (Claude Code, Codex, OpenCode) is the headline differentiator; current strategy lives in [meta/positioning-202607/00-overview.md](meta/positioning-202607/00-overview.md). Full vision: [meta/dorkos-litepaper.md](meta/dorkos-litepaper.md); brand: [meta/brand-foundation.md](meta/brand-foundation.md); personas: `meta/personas/` (Kai — senior dev running 10 agents across 5 projects, dismisses chatbot wrappers; Priya — staff architect in Obsidian, reads source before adopting; Ikechi — non-developer founder shipping apps by directing agents; Lil — privacy-first non-technical professional, horizon-staged, not a launch target; the anti-persona is whoever won't operate their own system — operator mentality, not technical skill, is the line). Tagline (2026-07-09): **"You, Multiplied."** on hero surfaces; "Intelligence doesn't scale. Coordination does." is the manifesto line for essays and anti-positioning only.

**Product state (pre-launch alpha, 2026-07):** the web cockpit via CLI install is the primary, launch-critical surface. The Obsidian plugin and desktop app are staged surfaces — built but under-tested; verify before claiming they work. Multi-agent Mesh+Relay coordination and the marketplace's Claude-Code-superset compatibility are shipped but unverified end-to-end. In user-facing copy, docs, and release notes, never state that an unverified surface or pillar works (the demo-claim gate: `meta/positioning-202607/09-gtm-plan.md` §2.0).

## Quality Standard

World-class UI/UX **and** world-class DX, neither negotiable. Every interaction is crafted; every surface works on mobile, tablet, and desktop. API surfaces are clean, types precise, errors helpful — internals must survive the scrutiny of an architect who reads source code before adopting tools.

**Codebase excellence:** study existing patterns before writing new code and follow them — consistency is a feature; diverging needs justification. Never leave things incomplete: no lingering TODOs, no half-finished migrations, no dead code, no tolerated legacy patterns — when something is superseded, remove it. Have the courage to refactor even when it's hard. If something weird must stay, comment _why_; otherwise refactor it. Simplicity is an active pursuit — the codebase gets cleaner over time.

**Decision filters:** describe what happens for the user, not how the system works internally ("get a Telegram message when your agent finishes"). Every element justifies its existence — if removing it wouldn't hurt the user, remove it. Be honest by design: no dark patterns, no hype language. Would Kai find it valuable, and does it respect Priya's flow? The product feels like a control panel, not a consumer app. (Design mentors — Jobs, Ive, Rams — in `meta/brand-foundation.md`.) All user-facing prose (changelog, release notes, READMEs, docs guides, UI copy, error messages) follows the `writing-for-humans` skill: plain enough for a smart 9th grader who doesn't code.

## Monorepo Structure

Turborepo monorepo:

```
dorkos/
├── apps/
│   ├── client/           # @dorkos/client - React 19 SPA (Vite 6, Tailwind 4, shadcn/ui)
│   ├── server/           # @dorkos/server - Express 5 API (tsc, NodeNext)
│   ├── site/             # @dorkos/site - Marketing site & docs (Next.js 16, Fumadocs)
│   ├── desktop/          # @dorkos/desktop - Electron shell
│   ├── obsidian-plugin/  # @dorkos/obsidian-plugin - Obsidian plugin (Vite lib, CJS)
│   └── e2e/              # @dorkos/e2e - Playwright browser tests
├── packages/
│   ├── cli/              # dorkos - Publishable npm CLI (esbuild bundle)
│   ├── shared/           # @dorkos/shared - Zod schemas, types, AgentRuntime interface
│   ├── db/               # @dorkos/db - Drizzle ORM schemas (SQLite)
│   ├── relay/            # @dorkos/relay - Inter-agent message bus
│   ├── mesh/             # @dorkos/mesh - Agent discovery & registry
│   ├── harness/          # @dorkos/harness - Projects .agents/ + plugins to every agent harness
│   ├── a2a-gateway/      # @dorkos/a2a-gateway - A2A protocol gateway
│   ├── extension-api/    # @dorkos/extension-api - Extension author API
│   ├── skills/           # @dorkos/skills - SKILL.md schemas, parser, writer, scanner
│   ├── marketplace/      # @dorkos/marketplace - Package schemas, parser, validator, scaffolder
│   ├── icons/            # @dorkos/icons - SVG icon & logo registry
│   ├── test-utils/       # @dorkos/test-utils - Mock factories, test helpers
│   └── eslint-config/, typescript-config/
├── meta/                 # Brand, personas, value architecture, litepaper
├── decisions/            # ADRs                          ├── plans/     # Implementation plans
├── docs/                 # User-facing MDX (Fumadocs)    ├── research/  # 290+ research reports
├── specs/                # Feature specs with manifest.json
└── contributing/         # 28 internal dev guides (see contributing/INDEX.md)
```

## Commands

```bash
pnpm dev               # Express server + Vite dev server (loads .env)
pnpm dev:dogfood       # Dev preview (:6241) + built CLI cockpit (:4242) — the default workflow
pnpm build             # Build all apps
pnpm verify            # Affected-only typecheck + lint + test — the pre-PR loop-closer
pnpm knip              # Dead-code detection (build dists first)
pnpm smoke:docker      # CLI Docker smoke test
pnpm smoke:integration # Full integration test in Docker
```

**Targeted verification (prefer these — full runs waste minutes):**

```bash
pnpm vitest run <path>                  # One test file (~1-2s)
pnpm test -- --run                      # Full suite via turbo. NEVER bare `pnpm vitest run`
                                        #   for full runs — it falsely fails 2 tests in dev env
pnpm --filter @dorkos/server typecheck  # One package (~4s vs ~28s full)
pnpm --filter @dorkos/server lint       # One package (~4s)
```

Gotchas: after pulling, rebuild `@dorkos/shared` if imports resolve stale (`pnpm --filter @dorkos/shared build`) — stale dists cause false-red type errors. Ports: dev uses 6xxx (from `.env`), production defaults 4xxx, tests pin 4242/4241.

## Architecture

**Hexagonal architecture** with a `Transport` interface (`packages/shared/src/transport.ts`) decoupling the React client from its backend: `HttpTransport` (web) and `DirectTransport` (Obsidian, in-process). See `contributing/architecture.md`.

### Server (`apps/server/src/`)

Express **5** on `DORKOS_PORT` (default 4242, dev 6242) — mind Express 5 semantics (`req.body` undefined on empty POSTs; changed wildcard routing). The `AgentRuntime` interface (`packages/shared/src/agent-runtime.ts`) abstracts agent backends; production runtimes live under `services/runtimes/`: **claude-code** (default), **codex** (SDK threads, ADR-0309), **opencode** (managed sidecar, ADR-0308), plus `test-mode` for e2e and `connect/` for runtime credentials/delegated login. Routes resolve a session's runtime via `runtimeRegistry` (per-session binding, first-write-wins, ADR-0255); session listing aggregates across runtimes with per-runtime degradation (ADR-0310). Every runtime must pass the shared conformance suite (`runtimeConformance` in `@dorkos/test-utils`); authoring checklist: `contributing/adding-a-runtime.md`.

**Service domains** under `services/`: activity, core, core-extensions, extensions, harness, marketplace, marketplace-mcp, mesh, relay, runtimes, session, tasks, workspace. Filesystem scanning: `packages/mesh/src/discovery/unified-scanner.ts`. API docs at `/api/docs`.

**Marketplace installs** use a file-scoped, git-free transaction (`services/marketplace/transaction.ts`): stage in tmpdir → backup target → atomic rename → restore on failure. See `contributing/marketplace-installs.md` and ADR-0304.

**Key conventions:**

- `lib/dork-home.ts` is the single source of truth for the data directory (`~/.dork/` prod, `apps/server/.temp/.dork/` dev). `os.homedir()` is banned.
- `lib/resolve-root.ts` resolves the default working directory; each app has its own Zod-validated `env.ts`.
- Persistent user config: `~/.dork/config.json` via `conf` (`services/core/config-manager.ts`); Zod is the authoritative schema. Schema changes require a semver-keyed migration — `contributing/configuration.md` + the `adding-config-fields` skill.
- External MCP server at `/mcp` (Streamable HTTP, stateless, optional `MCP_API_KEY`) exposes all DorkOS tools, including the 8 marketplace tools.

### Sessions

Session storage is runtime-owned (ADR-0310): claude-code derives from SDK JSONL (`~/.claude/projects/{slug}/*.jsonl`), codex from SDK threads, opencode from its sidecar store — there is no unified DorkOS transcript store. `GET /api/sessions` aggregates across runtimes, tags each session with its `runtime`, degrades per runtime (`warnings[]`). Session locking via `X-Client-Id`. `POST /api/sessions/:id/messages` is trigger-only (202); all turn delivery, hydration, and cross-client sync ride the durable per-session SSE stream `GET /api/sessions/:id/events` (snapshot → gap-free replay via `Last-Event-ID` → live events with monotonic `seq`). The global `GET /api/events` stream fans out session lifecycle events.

### Agent Storage (ADR-0043)

`.dork/agent.json` on disk (source of truth) + SQLite `agents` table (derived cache); **file-first write-through**, reconciler syncs every 5 min. **DorkBot** is the system agent, auto-created at `~/.dork/agents/dorkbot/` by `ensureDorkBot()`; system agents (`isSystem: true`) cannot be renamed, deleted, or unregistered — enforced at routes, MCP tools, and client UI.

### Client (`apps/client/src/`)

React 19 + Vite 6 + Tailwind 4 + shadcn/ui (new-york, neutral gray). **Feature-Sliced Design** with the inviolable layer rule `shared ← entities ← features ← widgets` (`.claude/rules/fsd-layers.md`); layers in `src/layers/`, app shell at `src/` root may import any layer. Always import from barrel `index.ts`, never internal paths. Routing: TanStack Router, code-based routes in `router.tsx` — `/`, `/activity`, `/agents`, `/session`, `/tasks`, `/workspaces`, `/marketplace`, `/marketplace/sources`, `/dev/*`. Embedded mode (Obsidian) bypasses the router. State: Zustand for UI, TanStack Query for server state (`contributing/state-management.md`). `motion` for animation, `streamdown` for markdown; design system in `contributing/design-system.md`.

### Site, Shared, CLI

`apps/site`: Next.js 16 + Fumadocs at dorkos.ai; public marketplace browse + install telemetry (Neon Postgres + Drizzle). `packages/shared`: import via `@dorkos/shared/*` subpaths — see the `exports` map in `packages/shared/package.json` (24 subpaths). `packages/cli`: published as `dorkos`; config precedence CLI flags > env vars > `~/.dork/config.json` > defaults.

## The `/flow` Workflow

`/flow` is the PM-agnostic workflow engine (stage spine `CAPTURE → … → DONE`) — it lives entirely in the external marketplace plugin (`dork-labs/marketplace`, `plugins/flow/`; ADR-0297). Install it from the DorkOS Marketplace at project scope: Harness Sync projects it into `.claude/commands/flow/` + `.claude/skills/flow__*` (ADR 260706-192819), so `/flow:*` works in DorkOS sessions and the bare `claude` CLI alike (`claude --plugin-dir <marketplace-checkout>/plugins/flow` also works for a one-off). There is no in-repo fallback; without the plugin installed, `/flow:*` does not exist. All tracker I/O goes through its `linear-adapter` skill; Linear team key `DOR`. Reach Linear via Linear MCP or `composio execute LINEAR_* --account personal` — **never the `artblocks` work account**. Reference: `contributing/flow-engine.md`.

If compaction fires mid-`/flow`, preserve verbatim: the work item id + title, current stage + sub-step, gate state, artifact pointers (spec dir, worktree path + branch, `flow-state.json`, open PR), and the assumption trail. Filesystem + tracker are ground truth; recover the rest from `flow-state.json` and the tracker.

## Worktrees

**One checkout, one writer.** This repo is routinely multi-agent; `main` is the clean integration tree, not a shared scratchpad — two agents mutating one checkout corrupt each other. **Default to an isolated worktree for any code change.** Stay in `main` only when you are certainly the sole writer _and_ the work is non-code (`research/`, `specs/`, tracker, docs prose) or a single commit landed immediately. Never create a worktree from inside one; never auto-remove one with uncommitted or unpushed work. Mechanics: `working-in-worktrees` skill + `/worktree:create|list|remove`. Intent stages (ideate/specify/decompose, `specs/` markdown) stay in `main`; isolation begins at EXECUTE.

## Pull Requests

Open PRs from a worktree branch based on `origin/main`. The automated Claude review runs on-demand: full review on open/ready-for-review, re-review via the `re-review` label (auto-cleared). Control intensity with `skip-review`, `review:light`, `review:deep`. Flow and label semantics: `creating-pull-requests` skill; the reviewer rubric is `REVIEW.md`.

## Hard Rules

Non-negotiable, enforced by ESLint/CI/convention:

1. **FSD layer violations are errors** — `no-restricted-imports` enforces the hierarchy
2. **SDK imports confined** — each runtime SDK is banned outside its adapter dir: `@anthropic-ai/claude-agent-sdk` → `services/runtimes/claude-code/`, `@openai/codex-sdk` → `services/runtimes/codex/`, `@opencode-ai/sdk` → `services/runtimes/opencode/`
3. **`os.homedir()` banned** — use `lib/dork-home.ts` (sole carve-out: that file)
4. **TSDoc on exports** — enforced by `eslint-plugin-jsdoc`
5. **Prettier + Tailwind class sorting** are automatic — never hand-sort
6. Path-specific rules in `.claude/rules/` load when editing matching files (see `.claude/README.md`)

## Testing

Vitest with `vi.mock()`; tests in `__tests__/` alongside source. Client tests: React Testing Library + jsdom with mock `Transport` via `TransportProvider`. Server session-route tests: `FakeAgentRuntime` + scenarios from `@dorkos/test-utils`; SSE integration via `collectDurableEvents`. Patterns and anti-patterns: `.claude/rules/testing.md`. Single file: `pnpm vitest run <path>`; full runs: `pnpm test -- --run` (see Commands for the bare-vitest gotcha).

## CI

GitHub Actions on push to main: CLI smoke tests (Node 20/22) + integration tests. Locally: `pnpm smoke:docker` / `pnpm smoke:integration`.

## Research

290+ reports in `research/` (`YYYYMMDD_topic-slug.md`). **Always check `research/` before doing new research.**

## Artifacts

- **Identifiers**: new ADRs and specs use timestamp ids `YYMMDD-HHMMSS` from `.claude/scripts/id.ts` (coordination-free; ADR-0312). Legacy 4-digit numbers are frozen and sort first. There is no `nextNumber`.
- **ADRs**: `decisions/<id>-<slug>.md` + `manifest.json`. `/adr:create`, `/adr:from-spec` (applies the significance rubric at extraction — no draft state), `/adr:review`, `/adr:list`.
- **Specs**: `specs/<slug>/` with `manifest.json` (`01-ideation.md`, `02-specification.md`, optional `03-tasks.json`). **Plans**: `plans/` at repo root.
- **Changelog**: per-change fragments in `changelog/unreleased/` (`<id>-<slug>.md`, timestamp-id + slug), compiled into `CHANGELOG.md` at release; never edit `CHANGELOG.md` directly (ADR 260707-231641, `changelog/README.md`).
