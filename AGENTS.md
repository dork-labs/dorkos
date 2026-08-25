# AGENTS.md

## Vision

DorkOS is the operating system for autonomous AI agents — the coordination layer (scheduling, communication, discovery, memory) that lets one person ship like a team. **Core thesis: intelligence doesn't scale; coordination does.** Market entry point (2026-07, language settled 2026-08 by DOR-1517): **one place for every AI agent you run** — running Claude Code, Codex, and OpenCode side by side in one window is the headline differentiator. **Never write "mission control" or "cockpit" in user-facing prose** (site, docs, READMEs, UI copy, error messages, release notes) — the operator retired both words, and the category phrase is "one place" ("All your agents. One place." / "one place for every AI agent you run"). Say "the DorkOS app", "the app", "one place" or "one window" instead. Two carve-outs: GitHub ships a product literally named "Mission Control", and the compiled changelog keeps its historical wording. Enforced by `scripts/check-banned-words.sh` in the `typecheck` workflow. Current strategy lives in [meta/positioning-202607/00-overview.md](meta/positioning-202607/00-overview.md). Full vision: [meta/dorkos-litepaper.md](meta/dorkos-litepaper.md); brand: [meta/brand-foundation.md](meta/brand-foundation.md); personas: `meta/personas/` (Kai — senior dev running 10 agents across 5 projects, dismisses chatbot wrappers; Priya — staff architect in Obsidian, reads source before adopting; Ikechi — non-developer founder shipping apps by directing agents; Lil — privacy-first non-technical professional, horizon-staged, not a launch target; the anti-persona is whoever won't operate their own system — operator mentality, not technical skill, is the line). Tagline (2026-07-09): **"You, Multiplied."** on hero surfaces; "Intelligence doesn't scale. Coordination does." is the manifesto line for essays and anti-positioning only.

**Product state (pre-launch alpha, 2026-08):** the web app via CLI install is the primary, launch-critical surface. The macOS desktop app is shipped and verified — signed, notarized, downloadable at `dorkos.ai/download/mac`, riding the unified `vX.Y.Z` releases (Apple Silicon), and matured by the desktop-resilience programme. The phone surface is an installable web app with push notifications, reached over the built-in tunnel. A **Windows x64 build rides the same release train** — unsigned NSIS installer, downloadable at `dorkos.ai/download/windows` — but it is an **early alpha: built and code-reviewed, not yet confirmed by a real end-user install on Windows**, so it stays behind the demo-claim gate (labeled "alpha" in site copy). There is no Linux desktop build yet. The Obsidian plugin remains a staged surface — built but under-tested (re-checked 2026-08); verify before claiming it works. Multi-agent Mesh+Relay coordination now carries end-to-end coverage (rooms e2e specs plus the shared conformance suites) and has come off the gate: Rooms ships GA, and the reply-limit dials that make agent-to-agent traffic safe to leave on landed with it. The marketplace's install path is covered end to end, but its **Claude-Code-superset compatibility** is still the unverified part of that pillar. In user-facing copy, docs, and release notes, never state that a still-unverified surface or pillar — the Obsidian plugin, the Windows desktop alpha, the marketplace's Claude-Code-superset compatibility — works (the demo-claim gate: `meta/positioning-202607/09-gtm-plan.md` §2.0).

## Quality Standard

World-class UI/UX **and** world-class DX, neither negotiable. Every interaction is crafted; every surface works on mobile, tablet, and desktop. API surfaces are clean, types precise, errors helpful — internals must survive the scrutiny of an architect who reads source code before adopting tools.

**Codebase excellence:** study existing patterns before writing new code and follow them — consistency is a feature; diverging needs justification. Never leave things incomplete: no lingering TODOs, no half-finished migrations, no dead code, no tolerated legacy patterns — when something is superseded, remove it. Have the courage to refactor even when it's hard. If something weird must stay, comment _why_; otherwise refactor it. Simplicity is an active pursuit — the codebase gets cleaner over time.

**Decision filters:** describe what happens for the user, not how the system works internally ("get a Telegram message when your agent finishes"). Every element justifies its existence — if removing it wouldn't hurt the user, remove it. Be honest by design: no dark patterns, no hype language. Would Kai find it valuable, and does it respect Priya's flow? The product feels like a control panel, not a consumer app. (Design mentors — Jobs, Ive, Rams — in `meta/website-copy/process.md`.) All user-facing prose (changelog, release notes, READMEs, docs guides, UI copy, error messages) follows the `writing-for-humans` skill: plain enough for a smart 9th grader who doesn't code. How an agent **behaves** in a room, DM or channel shared with other people and other agents follows [meta/agent-etiquette.md](meta/agent-etiquette.md): present, useful, and mostly quiet. Over-participation, not silence, is the failure mode users complain about.

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
pnpm dev:dogfood       # Dev preview (:6241) + the built CLI app (:4242) — the default workflow
pnpm build             # Build all apps
pnpm verify            # Affected-only typecheck + lint + test — the pre-PR loop-closer
pnpm knip              # Dead-code detection (build dists first)
pnpm smoke:docker      # CLI Docker smoke test
pnpm smoke:integration # Full integration test in Docker
pnpm evals:local       # Agent evals against a real model, locally — needs only `claude auth login`
pnpm evals:sweep       # Clear eval sandboxes/containers an interrupted run left behind
```

**Evals** (`packages/evals`, README there): `pnpm evals:local` runs the `core` suite on a real model through the `claude` sign-in on your own machine, so it spends against your own Claude subscription. Credentials resolve in a fixed order: `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN`, then your local sign-in; the run prints which one it used. No credential at all is a runner error, never a pass. The `docker` isolation tier is the exception: its container is sealed off from your home directory, so it needs one of the two variables and says so.

**Targeted verification (prefer these — full runs waste minutes):**

```bash
pnpm vitest run <path>                  # One test file (~1-2s). Works for EVERY package
pnpm test -- --run                      # Full suite via turbo. NEVER bare `pnpm vitest run`
                                        #   for full runs — it skips the per-package env turbo
                                        #   sets up, and has falsely failed tests in dev
pnpm --filter @dorkos/server typecheck  # One package (~4s vs ~28s full)
pnpm --filter @dorkos/server lint       # One package (~4s)
```

The targeted run only reaches a package the root `vitest.config.ts` registers as a project, and it lists all of them, `packages/evals` included. `pnpm vitest run <path>` answering "No test files found, exiting with code 1" means your path is wrong, never that the package is unreachable (DOR-670, when it meant both). `scripts/__tests__/vitest-projects.test.ts` fails if that list and the workspace drift apart.

**One test in the repo spends real money**: `packages/evals/src/runner/__tests__/harness-server.test.ts` boots a server and drives a live turn. It runs only when you set `DORKOS_EVALS_CREDENTIALED=1` alongside an `ANTHROPIC_API_KEY`, and skips otherwise. A key you happen to have exported is deliberately not enough, because having one is not the same as deciding to spend. Two things follow. Turbo strips the key, so `pnpm test`, `pnpm verify`, pre-push and CI were never exposed; bare vitest does not strip it, so on this branch the flag is what protects you. And a fake key is not a safe way to run that file: the test server inherits your `claude` sign-in and bills that instead, which was measured with a deliberately invalid key.

Gotchas: under a running `pnpm dev`/`pnpm dev:dogfood`, `@dorkos/shared` rebuilds itself automatically (`tsc --watch` runs as a persistent turbo `dev` pane), so a `git pull` mid-session no longer needs a manual rebuild there. Outside a running dev session — a fresh worktree, a one-off typecheck, or a test run — rebuild `@dorkos/shared` by hand if imports resolve stale (`pnpm --filter @dorkos/shared build`); stale dists cause false-red type errors. If a typecheck red starts with `TS6053` on a `@dorkos/typescript-config` extends, `node_modules` is stale — run `pnpm install` (tsc otherwise falls back to ES5/non-strict defaults and sprays phantom errors across dependency sources). Ports: dev uses 6xxx (from `.env`), production defaults 4xxx, tests pin 4242/4241.

## Architecture

**Hexagonal architecture** with a `Transport` interface (`packages/shared/src/transport.ts`) decoupling the React client from its backend: `HttpTransport` (web) and `DirectTransport` (Obsidian, in-process). See `contributing/architecture.md`.

### Server (`apps/server/src/`)

Express **5** on `DORKOS_PORT` (default 4242, dev 6242) — mind Express 5 semantics (`req.body` undefined on empty POSTs; changed wildcard routing). The `AgentRuntime` interface (`packages/shared/src/agent-runtime.ts`) abstracts agent backends; production runtimes live under `services/runtimes/`: **claude-code** (default), **codex** (SDK threads, ADR-0309), **opencode** (managed sidecar, ADR-0308), plus `test-mode` for e2e and `connect/` for runtime credentials/delegated login. Routes resolve a session's runtime via `runtimeRegistry` (per-session binding, first-write-wins, ADR-0255); session listing aggregates across runtimes with per-runtime degradation (ADR-0310). Every runtime must pass the shared conformance suite (`runtimeConformance` in `@dorkos/test-utils`); authoring checklist: `contributing/adding-a-runtime.md`.

**Service domains** under `services/`: activity, communities, core, core-extensions, extensions, harness, marketplace, marketplace-mcp, mesh, relay, runtimes, search, session, tasks, workspace. Filesystem scanning: `packages/mesh/src/discovery/unified-scanner.ts`. API docs at `/api/docs`.

`CommunityAdapter` (`packages/shared/src/community-adapter.ts`) is the **fourth swappable seam** beside `AgentRuntime`, `Transport` and `ConnectorProvider` — one port for rooms in more than one place, gated by `communityConformance`. This machine's own SQLite rooms are the first backend behind it (`services/communities/local/`), registered as `LOCAL_COMMUNITY` at startup; it wraps `RoomService` rather than replacing it. `GET /api/rooms` is its production consumer (`services/communities/list-rooms-across-communities.ts`): it aggregates every OTHER configured community with per-community degradation, while this machine's own rooms stay off the port — it is single-identity and that list is per-caller. Telegram/Slack bridged rooms are **projections into local rooms, not community backends** (ADR `260814-024525`); the port is reserved for communities whose truth is remote.

**Marketplace installs** use a file-scoped, git-free transaction (`services/marketplace/transaction.ts`): stage in tmpdir → backup target → atomic rename → restore on failure. See `contributing/marketplace-installs.md` and ADR-0304.

**Key conventions:**

- `lib/dork-home.ts` is the single source of truth for the data directory (`~/.dork/` prod, `apps/server/.temp/.dork/` dev). `os.homedir()` is banned outside the five carve-outs in Hard Rule 3.
- `lib/resolve-root.ts` resolves the default working directory; each app has its own Zod-validated `env.ts`.
- Persistent user config: `~/.dork/config.json` via `conf` (`services/core/config-manager.ts`); Zod is the authoritative schema. Schema changes require a semver-keyed migration — `contributing/configuration.md` + the `adding-config-fields` skill.
- External MCP server at `/mcp` (Streamable HTTP, stateless, optional `MCP_API_KEY`) exposes all DorkOS tools, including the 8 marketplace tools.

### Sessions

Session storage is runtime-owned (ADR-0310): claude-code derives from SDK JSONL (`~/.claude/projects/{slug}/*.jsonl`), codex from SDK threads, opencode from its sidecar store — there is no unified DorkOS transcript store. `GET /api/sessions` aggregates across runtimes, tags each session with its `runtime`, degrades per runtime (`warnings[]`). Session locking via `X-Client-Id`. `POST /api/sessions/:id/messages` is trigger-only (202); all turn delivery, hydration, and cross-client sync ride the durable per-session SSE stream `GET /api/sessions/:id/events` (snapshot → gap-free replay via `Last-Event-ID` → live events with monotonic `seq`). The global `GET /api/events` stream fans out session lifecycle events.

### Agent Storage (ADR-0043)

`.dork/agent.json` on disk (source of truth) + SQLite `agents` table (derived cache); **file-first write-through**, reconciler syncs every 5 min. **DorkBot** is the system agent, auto-created at `~/.dork/agents/dorkbot/` by `ensureDorkBot()`; system agents (`isSystem: true`) cannot be renamed, deleted, or unregistered — enforced at routes, MCP tools, and client UI.

### Message search

One derived, rebuildable FTS5 index over everything that was said, read by `GET /api/search` and by ⌘⇧F in the app (`apps/server/src/services/search/`, `features/command-palette/ui/MessageSearchDialog.tsx`, spec `specs/message-search/`). It indexes **rooms and Claude Code transcripts, bare-CLI sessions included** — never tool output, and **not Codex or OpenCode yet**; the surface states that gap itself, and the copy is pinned by a test so a coverage claim cannot drift out of date silently. Sessions are owner-only and reachable by no agent (spec §7). Deleting the index is a supported recovery.

### Client (`apps/client/src/`)

React 19 + Vite 6 + Tailwind 4 + shadcn/ui (new-york, neutral gray). **Feature-Sliced Design** with the inviolable layer rule `shared ← entities ← features ← widgets` (`.claude/rules/fsd-layers.md`); layers in `src/layers/`, app shell at `src/` root may import any layer. Always import from barrel `index.ts`, never internal paths. Routing: TanStack Router, code-based routes in `router.tsx` — `/`, `/activity`, `/team` (`/agents` redirects to it), `/session`, `/tasks`, `/channels`, `/workspaces`, `/connections`, `/marketplace`, `/marketplace/sources`, `/feedback-requests`, `/dev/*`. Embedded mode (Obsidian) bypasses the router. State: Zustand for UI, TanStack Query for server state (`contributing/state-management.md`). `motion` for animation, `streamdown` for markdown; design system in `contributing/design-system.md`.

### Site, Shared, CLI

`apps/site`: Next.js 16 + Fumadocs at dorkos.ai; public marketplace browse + install telemetry (Neon Postgres + Drizzle). `packages/shared`: import via `@dorkos/shared/*` subpaths — see the `exports` map in `packages/shared/package.json` (58 subpaths). `packages/cli`: published as `dorkos`; config precedence CLI flags > env vars > `~/.dork/config.json` > defaults.

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
3. **`os.homedir()` banned in `apps/server/src`** — use `lib/dork-home.ts`. Five carve-outs beyond tests, enumerated in `.claude/rules/dork-home.md`: `lib/dork-home.ts`, `lib/boundary.ts` (two inline-disabled call sites), `claude-code/claude-config-dir.ts`, `codex/codex-home.ts`, `opencode/opencode-data-dir.ts` — the last three mirror another program's resolution of its own directory 1:1, never DorkOS's
4. **TSDoc on exports** — enforced by `eslint-plugin-jsdoc`
5. **Prettier + Tailwind class sorting** are automatic — never hand-sort. Formatting runs at **turn end** (`Stop` hook) and again at `pre-commit`, deliberately **not** after each edit: rewriting a file the moment you edit it makes your in-context copy stale and breaks your next string-replace (`.claude/hooks/format-changed.sh` header). So a file you just wrote is not formatted yet, and that is fine — do not chase it
6. **`git stash` and `git checkout -- <path>` are refused** — the stash is shared by every worktree and holds your auto-checkpoints; the pathspec checkout silently reverts uncommitted work. Both have eaten work here. Park files in the session scratchpad and restore with `cp`. Enforced by `.claude/hooks/git-guard.mjs`; `git stash list`/`show` and branch switching still work
7. **`pkill`, `killall`, and group/all-process `kill` are refused** — several agents plus the operator's own `pnpm dev` (:6242) and dogfood app (:4242) run the same source on one machine, so a kill by name is a kill of everyone's process (a broad `pkill -f` took the operator's dev server down on 2026-08-18). Stop only the process you started, by the PID you already hold or `lsof -ti :<your port>`. Enforced by `.claude/hooks/process-guard.mjs`
8. Path-specific rules in `.claude/rules/` load when editing matching files (see `.claude/README.md`)

## Testing

Vitest with `vi.mock()`; tests in `__tests__/` alongside source. Client tests: React Testing Library + jsdom with mock `Transport` via `TransportProvider`. Server session-route tests: `FakeAgentRuntime` + scenarios from `@dorkos/test-utils`; SSE integration via `collectDurableEvents`. Patterns and anti-patterns: `.claude/rules/testing.md`. Single file: `pnpm vitest run <path>`; full runs: `pnpm test -- --run` (see Commands for the bare-vitest gotcha).

## CI

**Two gates, split by what each is good at.** The lefthook `pre-push` hook runs **affected-only** tests (`turbo test --affected`) — fast, survivable on a machine already busy with other agents, and it skips packages your push never touched. GitHub Actions splits by cost (2026-08-23/24, CI-saturation fix): on PRs, `test` runs **affected-only** and `browser-test` reports an instant pass-through, while the **full monorepo `test` sweep and the Playwright shards run only on `merge_group`, as required merge-queue checks** — the queue's combined-tree build is what decides every merge. The PR legs exist because GitHub requires a required check to succeed **on the PR** before it may enter the queue at all (a merge_group-only required check deadlocks every PR out of the queue — measured on PR #1246). Push-to-main no longer re-runs the suites: the queue already tested the exact tree content (squash rewrites the SHA, not the content). Because turbo caches `test` and replays a full cache hit in ~280ms while printing "29 successful", the merge-group `test` run asserts it actually executed (`scripts/assert-tests-executed.sh`, pinned by `scripts/test-assert-tests-executed.sh`) — never weaken that step without reading its header.

Also on GitHub Actions: `fragment-present` (changelog), `scripts-test`, and CLI smoke tests (Node 22/24) + integration tests, which run on push to main and on PRs that touch what they package. Locally: `pnpm smoke:docker` / `pnpm smoke:integration`.

**`main` merges through a merge queue** (ADR 260728-112203). You never update a branch to satisfy a gate: GitHub builds your PR on top of `main` plus everything ahead of it in the queue, runs the required checks against that combined tree, and fast-forwards only if they pass. "Require branches to be up to date" is off, and being behind `main` no longer blocks anything. Two consequences worth knowing:

- **Every required check must report on `merge_group`.** A required check that only fires on `pull_request` blocks the queue forever. Any new required check needs `merge_group:` in its `on:` list.
- **Some checks stay PR-only on purpose.** Fragment _coverage_ needs the PR's labels and number, which the `merge_group` payload does not carry, so it is answered before queueing and not re-asked. Fragment _validity_ does re-run in the queue.

**Landing a PR is automated.** `merge-tail.yml` arms auto-merge every 10 minutes on PRs that are finished (open, undrafted, unlabelled `hold`, cleanly mergeable, no unresolved threads, every check settled green). Its decision is `scripts/should-arm-automerge.sh`, fixture-pinned. Apply `hold` (or `do-not-merge`, `wip`, `blocked`) to keep a green PR from being armed.

## Research

290+ reports in `research/` (`YYYYMMDD_topic-slug.md`). **Always check `research/` before doing new research.**

## Artifacts

- **Identifiers**: new ADRs and specs use timestamp ids `YYMMDD-HHMMSS` from `.claude/scripts/id.ts` (coordination-free; ADR-0312). Legacy 4-digit numbers are frozen and sort first. There is no `nextNumber`.
- **ADRs**: `decisions/<id>-<slug>.md` + `manifest.json`. `/adr:create`, `/adr:from-spec` (applies the significance rubric at extraction — no draft state), `/adr:review`, `/adr:list`.
- **Specs**: `specs/<slug>/` with `manifest.json` (`01-ideation.md`, `02-specification.md`, optional `03-tasks.json`). **Plans**: `plans/` at repo root.
- **Changelog**: per-change fragments in `changelog/unreleased/` (`<id>-<slug>.md`, timestamp-id + slug), compiled into `CHANGELOG.md` at release; never edit `CHANGELOG.md` directly (ADR 260707-231641, `changelog/README.md`).
