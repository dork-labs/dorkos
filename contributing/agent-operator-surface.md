# Agent-Operator Surface

## Overview

DorkOS agents are not just chat partners — they can **operate DorkOS itself**: create agents, schedule tasks, install marketplace packages, toggle settings, and read the activity feed. This guide is the internal map of that agent-facing capability surface: which tools exist, on which server, where their handlers live, and how to add a new one today.

The surface has two shapes, and the split is the one idea that explains the rest:

- **MCP tools** — how an agent reaches DorkOS from _inside a session_ (the in-session `dorkos` MCP server) or from an _external MCP client_ (the `/mcp` HTTP server). MCP injection only reaches the **claude-code** runtime.
- **CLI operator verbs** — how an agent reaches DorkOS from _any_ runtime. The `dorkos` CLI is the only actuation surface reachable from Codex and OpenCode too (they cannot receive MCP injection), so the verbs are the portable path (DOR-434).

Everything here is **hand-registered** today. Phase 2 replaces the hand-registration with a generated Capability Registry — see [Phase 2](#phase-2-the-capability-registry) at the end.

**Pair this guide with:**

- [spec `agents-as-operators`](../specs/agents-as-operators/02-specification.md) — the feature spec this surface implements (§1.1–1.8).
- [research: agents as first-class operators](../research/20260722_agents-as-first-class-operators.md) — the analysis that motivated the surface and the Capability Registry direction.
- [`contributing/adding-a-runtime.md`](adding-a-runtime.md) — why MCP injection is claude-code-only and the CLI is the universal path.
- [`contributing/marketplace-installs.md`](marketplace-installs.md) — the install pipeline the marketplace tools and `dorkos install` both drive.
- The user-facing guide [Your agents can operate DorkOS](../docs/guides/operating-dorkos.mdx) and the [CLI reference](../docs/guides/cli-usage.mdx#operator-commands).

## Key Files

| Concept                                      | Location                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| In-session MCP composition root              | `apps/server/src/services/runtimes/claude-code/mcp-tools/index.ts`          |
| External `/mcp` composition root             | `apps/server/src/services/core/mcp-server.ts`                               |
| Operator tool descriptors (shared)           | `apps/server/src/services/core/operator/operator-tool-descriptors.ts`       |
| Operator tool handlers (shared)              | `apps/server/src/services/core/operator/operator-tool-handlers.ts`          |
| Agent self-edit service (shared)             | `apps/server/src/services/core/operator/agent-updater.ts`                   |
| Config deep-merge patch service (shared)     | `apps/server/src/services/core/operator/config-patch.ts`                    |
| Operator tools, in-session glue              | `apps/server/src/services/runtimes/claude-code/mcp-tools/operator-tools.ts` |
| Operator tools, external glue                | `apps/server/src/services/core/external-mcp/operator-tools.ts`              |
| Marketplace tool descriptors (shared)        | `apps/server/src/services/marketplace-mcp/marketplace-tool-descriptors.ts`  |
| Marketplace tools registration               | `apps/server/src/services/marketplace-mcp/marketplace-mcp-tools.ts`         |
| Read-only carve-out (external mutation gate) | `apps/server/src/services/core/external-mcp/tool-security.ts`               |
| CLI operator verb handlers                   | `packages/cli/src/commands/{agent,task,activity,version}.ts`                |
| CLI operator output helpers                  | `packages/cli/src/lib/operator-output.ts`                                   |
| CLI subcommand interception                  | `packages/cli/src/cli.ts`                                                   |

## MCP tools: which server, which tools

Both MCP servers assemble their tool list from small per-domain modules. The two composition roots register overlapping-but-different sets. The table below is the operator-relevant slice — the tools that let an agent operate DorkOS (the full lists also include mesh/relay/binding/devtools/ui plumbing, which are documented with their own domains).

| Tool                            | In-session `dorkos` | External `/mcp` | What it does                                                            |
| ------------------------------- | :-----------------: | :-------------: | ----------------------------------------------------------------------- |
| `activity_list`                 |         yes         |       yes       | Read the activity feed (filters: categories, actorType, actorId, time). |
| `config_get`                    |         yes         |       yes       | Read the config snapshot (secrets redacted).                            |
| `check_update`                  |         yes         |       yes       | Server version + latest npm version.                                    |
| `agents_recent_activity`        |         yes         |       yes       | Per-agent most-recent-session map.                                      |
| `update_agent`                  |         yes         |       yes       | Edit an agent's manifest/personality (self-edit + guards).              |
| `config_patch`                  |         yes         |       yes       | Deep-merge user settings (same validated path as the settings UI).      |
| `create_agent`                  |         yes         |       yes       | Create a new agent workspace.                                           |
| `marketplace_search`            |         yes         |       yes       | Search the marketplace.                                                 |
| `marketplace_get`               |         yes         |       yes       | Fetch one package's manifest.                                           |
| `marketplace_list_marketplaces` |         yes         |       yes       | List configured sources.                                                |
| `marketplace_list_installed`    |         yes         |       yes       | List installed packages.                                                |
| `marketplace_recommend`         |         yes         |       yes       | Suggest packages for a goal.                                            |
| `marketplace_install`           |         yes         |       yes       | Install a package (confirmation-token flow).                            |
| `marketplace_uninstall`         |         yes         |       yes       | Remove an installed package.                                            |
| `marketplace_create_package`    |         yes         |       yes       | Scaffold a new package (confirmation-token flow).                       |

The **six operator tools** (`activity_list`, `config_get`, `check_update`, `agents_recent_activity`, `update_agent`, `config_patch`) land from one shared catalog — `OPERATOR_TOOL_DESCRIPTORS` in `operator-tool-descriptors.ts`. The in-session server maps each descriptor onto the Claude Agent SDK `tool()` helper (`getOperatorTools`); the external server maps the same descriptors onto `McpServer.tool()` (`registerOperatorTools`). Neither re-implements a handler — the glue is transport-only.

The **eight marketplace tools** work the same way: `MARKETPLACE_TOOL_DESCRIPTORS` is the shared catalog, wired into both servers so an external MCP client _and_ the user's own in-session agent can install (DOR-429).

### The external mutation gate

The external `/mcp` server is reachable over HTTP, so it enforces a read-only carve-out. `READ_ONLY_MCP_TOOL_NAMES` in `tool-security.ts` is the single source of truth: a tool named there is allowed even in read-only mode; anything else is a mutation. The four read-only operator tools (`activity_list`, `config_get`, `check_update`, `agents_recent_activity`) are in the set; `update_agent` and `config_patch` are deliberately **not** — they mutate, so they are gated. When you add a tool, decide its side-effect class and update the set accordingly (a new mutating tool must _not_ be added).

### Trust boundaries on the mutating tools

- **`update_agent`** routes through `agent-updater.ts`, the same service behind `PATCH /api/agents/current`. The slug (`name`) is immutable, and system agents (DorkBot) reject identity changes — enforced in one place so the tool and the route cannot drift. The tool description directs the agent to confirm with the user before editing a _different_ agent's manifest.
- **`config_patch`** routes through `config-patch.ts` (deep-merge, arrays replace) and the same Zod validation as `PATCH /api/config`. Its description flags it as a user-settings mutation to perform only on explicit user intent.
- **`marketplace_install` / `marketplace_create_package`** keep their confirmation-token flow unchanged across both servers.

## CLI operator verbs

The `dorkos` CLI verbs (DOR-434) call a running server's HTTP API using the shared server-discovery + api-client pattern. They are the runtime-portable actuation path. Every verb accepts `--json` for machine output (raw JSON on stdout, nothing else); human output uses a small table renderer in `operator-output.ts`. Errors always go to stderr, so `--json` stdout stays clean on failure.

| Verb                             | HTTP call                                                      | Handler                |
| -------------------------------- | -------------------------------------------------------------- | ---------------------- |
| `dorkos agent list`              | `GET /api/mesh/agents`                                         | `commands/agent.ts`    |
| `dorkos agent show <path-or-id>` | `GET /api/mesh/agents/:id` or `/api/agents/current?path=`      | `commands/agent.ts`    |
| `dorkos agent create`            | `POST /api/agents/create`                                      | `commands/agent.ts`    |
| `dorkos agent update`            | `PATCH /api/agents/current?path=`                              | `commands/agent.ts`    |
| `dorkos task list`               | `GET /api/tasks`                                               | `commands/task.ts`     |
| `dorkos task create`             | `POST /api/tasks`                                              | `commands/task.ts`     |
| `dorkos task trigger <id>`       | `POST /api/tasks/:id/trigger`                                  | `commands/task.ts`     |
| `dorkos task runs`               | `GET /api/tasks/runs`                                          | `commands/task.ts`     |
| `dorkos activity`                | `GET /api/activity`                                            | `commands/activity.ts` |
| `dorkos version --check`         | `GET /api/config` (falls back to the local update-check cache) | `commands/version.ts`  |

`agent show` picks its endpoint with a small heuristic: an argument containing a path separator (or starting with `.`, `~`, `/`) resolves via the by-path endpoint; anything else is treated as a Mesh id/slug.

`dorkos activity --type <event>` filters **within the fetched page only** — the feed endpoint (`GET /api/activity`) has no server-side event-type filter, so the CLI applies `--type` after the fetch. A matching event older than `--limit` is not fetched and so will not appear; raise `--limit` to widen the window.

`dorkos version --check` is the one verb that degrades instead of failing when no server is running: it reads the last-known latest version from `~/.dork/cache/update-check.json` and reports the CLI's own version.

Each verb is intercepted in `cli.ts` before the top-level `parseArgs`, so its own flag namespace (including `--json`) is not rejected as unknown — the same interception pattern the marketplace verbs use.

## How to add a tool or verb today

### Add an MCP operator tool

1. Add a descriptor to `OPERATOR_TOOL_DESCRIPTORS` in `operator-tool-descriptors.ts`: `name`, `description` (write it for a model — imperative, name the real inputs and guards), `inputSchema` (a Zod shape), `annotations` (side-effect class), and `createHandler`.
2. Put the handler logic in `operator-tool-handlers.ts` (or a dedicated service under `services/core/operator/` when it has real domain rules, as `agent-updater.ts` and `config-patch.ts` do). **Wrap existing service/route logic — never duplicate route validation.**
3. Both servers pick the descriptor up automatically (the in-session and external glue both map the shared catalog). No composition-root edit is needed.
4. If the tool is read-only, add its name to `READ_ONLY_MCP_TOOL_NAMES`. If it mutates, leave it out.
5. Add unit tests covering the happy path and each rejection (e.g. system-agent protection, invalid patch).

### Add a marketplace tool

Same shape, but the catalog is `MARKETPLACE_TOOL_DESCRIPTORS` in `marketplace-tool-descriptors.ts`, and the confirmation-token flow lives in `marketplace-mcp-tools.ts` — preserve it for any install/create-style mutation.

### Add a CLI operator verb

1. Add a handler module under `packages/cli/src/commands/` following `agent.ts`/`task.ts`: a `parse<Verb>Args` function (strict `parseArgs`, friendly unknown-option errors) and a `run<Verb>` function that calls `apiCall` and returns an exit code (never `process.exit` — `cli.ts` owns termination).
2. Support `--json` via `printJson`; render human output with `renderTable`; send errors to stderr via `printError` (all in `operator-output.ts`).
3. Intercept the verb in `cli.ts` before the top-level `parseArgs`, and add it to the `--help` text and the [CLI reference doc](../docs/guides/cli-usage.mdx#operator-commands).
4. Command names and flags are the **stable public contract** — phase 2 regenerates the internals, not the surface. Do not build a framework; keep handlers thin and direct.
5. Add tests mirroring `commands/__tests__/agent.test.ts` (mock `api-client`, cover parsing + one happy path per verb).

## Phase 2: the Capability Registry

Everything above is hand-registered: a descriptor here, a CLI handler there, a `tool-security` entry, a help-text line. Phase 2 (see the [spec](../specs/agents-as-operators/02-specification.md) and [research report](../research/20260722_agents-as-first-class-operators.md)) introduces a **Capability Registry** — one declaration per capability that generates the MCP descriptors, the CLI verb dispatch, and the read-only classification from a single source. When that lands, this guide's "how to add" sections collapse to "add a capability to the registry." Until then, keep the hand-registration in sync across the three surfaces (in-session MCP, external MCP, CLI), and keep command names and flags stable so the registry can adopt them without breaking callers.
