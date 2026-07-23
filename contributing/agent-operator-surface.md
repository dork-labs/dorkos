# Agent-Operator Surface

## Overview

DorkOS agents are not just chat partners: they can **operate DorkOS itself**. They read the activity feed, edit their own persona, change your settings, and install marketplace packages. This guide is the internal map of that agent-facing surface: how a capability is declared once and projected onto every surface an agent can reach, where the pieces live, and how to add a new capability.

The one idea that explains the rest is the **Capability Registry**. A service domain declares a capability exactly once with `defineCapability` (id, model-facing description, permission tier, Zod input/output, a transport-neutral `invoke` handler, and the surfaces it projects onto). From that single declaration DorkOS generates:

- the **in-session MCP tool** (the `dorkos` server an agent reaches from inside a claude-code session),
- the **external MCP tool** (the `/mcp` HTTP server for external MCP clients),
- the **OpenAPI path** (so the capability shows up in `/api/docs`),
- the **self-description catalog** (`GET /api/capabilities/catalog`, the `list_capabilities` MCP tool, and `dorkos capabilities`).

CLI operator verbs (`dorkos agent`, `task`, `activity`, `version`) remain the runtime-portable path, because MCP injection only reaches claude-code and Codex/OpenCode agents cannot receive it. The generic `dorkos call <capability-id>` reaches every capability by id, so an agent on any runtime can actuate DorkOS after discovering the catalog. See [The CLI surface](#the-cli-surface).

Everything above used to be hand-registered (a descriptor here, a CLI handler there, a `tool-security` entry). Phase 2 replaced that with the registry, so forgetting a surface is no longer possible: a single declaration lights them all up, and the [conformance suite](#the-conformance-suite) fails CI if a projection ever drifts. The [Phase 1 history](#phase-1-history) note at the end records what changed.

**Pair this guide with:**

- [spec `capability-registry`](../specs/capability-registry/02-specification.md): the registry design this surface implements.
- [spec `agents-as-operators`](../specs/agents-as-operators/02-specification.md): phase 1, the operator/marketplace capabilities and the frozen tool-name contracts.
- [research: agents as first-class operators](../research/20260722_agents-as-first-class-operators.md): the analysis that motivated the surface and the registry.
- [`contributing/adding-a-runtime.md`](adding-a-runtime.md): why MCP injection is claude-code-only and the CLI is the universal path.
- The user-facing guide [Your agents can operate DorkOS](../docs/guides/operating-dorkos.mdx) and the [CLI reference](../docs/guides/cli-usage.mdx#operator-commands).

## Key files

| Concept                                       | Location                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| Capability declaration (`defineCapability`)   | `apps/server/src/services/core/capabilities/capability-definition.ts`             |
| Registry composition + catalog                | `apps/server/src/services/core/capabilities/registry.ts`                          |
| Composition root (boot + docs)                | `apps/server/src/services/core/self-description/dorkos-registry.ts`               |
| Serializable catalog types (shared)           | `packages/shared/src/capabilities.ts`                                             |
| MCP projection (transport-neutral)            | `apps/server/src/services/core/capabilities/mcp-projection.ts`                    |
| In-session MCP adapter                        | `apps/server/src/services/runtimes/claude-code/mcp-tools/capability-mcp-tools.ts` |
| External MCP adapter                          | `apps/server/src/services/core/external-mcp/capability-mcp-tools.ts`              |
| OpenAPI projection                            | `apps/server/src/services/core/capabilities/openapi-projection.ts`                |
| Self-description domain (`list_capabilities`) | `apps/server/src/services/core/self-description/capabilities-domain.ts`           |
| Operator domain capabilities                  | `apps/server/src/services/core/operator/operator-capabilities.ts`                 |
| Marketplace domain capabilities               | `apps/server/src/services/marketplace-mcp/marketplace-capabilities.ts`            |
| Read-only carve-out (derived + legacy)        | `apps/server/src/services/core/external-mcp/tool-security.ts`                     |
| Invoke route (`dorkos call` backend)          | `apps/server/src/routes/capabilities-invoke.ts`                                   |
| Catalog route                                 | `apps/server/src/routes/capabilities-catalog.ts`                                  |
| CLI: `capabilities` / `call`                  | `packages/cli/src/commands/{capabilities,call}.ts`                                |
| CLI: operator verbs                           | `packages/cli/src/commands/{agent,task,activity,version}.ts`                      |
| Conformance suite                             | `packages/test-utils/src/capability-conformance.ts`                               |

## How a capability projects

A `CapabilityDefinition` carries a `surfaces` object with three optional projections:

- `mcp`: the tool name, which server(s) advertise it (`in-session`, `external`, or both), an optional `readOnlyCarveOut` flag, and the two annotation hints (`openWorldHint`, `idempotentHint`) that a tier alone cannot express. The other two MCP hints (`readOnlyHint`, `destructiveHint`) are derived from the `tier`.
- `cli`: a curated operator verb (and optional subcommand). Optional: a capability with no `cli` surface is still reachable through the generic `dorkos call`.
- `http`: a method + path auto-registered into the OpenAPI document.

`composeDorkOsCapabilityRegistry` folds every domain into one immutable registry at boot and throws on any structural conflict (a duplicate id, a duplicate tool name, a duplicate CLI verb, a duplicate HTTP route, or an id not prefixed with its domain). The two MCP adapters and the OpenAPI projection then read that one registry, so a capability appears on every surface it declares with zero extra wiring.

### Permission tiers

Every capability declares a `tier`: `observe` (pure read), `act` (mutates local state), or `destructive` (deletes or unregisters). Tiers are **inert metadata today**: phase 3 will enforce them. Do not present a tier as an active permission gate anywhere user-facing.

### The external mutation gate

The external `/mcp` server is reachable over HTTP, so it enforces a read-only carve-out: in login-off mode, a tool not in `READ_ONLY_MCP_TOOL_NAMES` requires the per-instance local token. That set is now **derived**, not hand-listed: a capability opts in with `surfaces.mcp.readOnlyCarveOut: true` (only valid on `observe`-tier tools), and `readOnlyCarveOutToolNames` reads that flag. `tool-security.ts` unions the derivation with a shrinking list of legacy hand-registered read-only tools from domains that have not migrated onto the registry yet (core, tasks, binding, mesh, relay). The conformance suite asserts the derived portion stays in lock-step, which removes the phase-1 failure mode where a mutating tool could be hand-added to the read-only list.

### Trust boundaries stay in `invoke`

Redaction, confirmation-token flows, and identity guards live inside `invoke` (or the service it calls), on every surface, because the transport adapters only shape the envelope:

- **`operator.update_agent`** routes through `agent-updater.ts`, the same service behind `PATCH /api/agents/current`. The slug (`name`) is immutable and system agents (DorkBot) reject identity changes.
- **`operator.config_patch`** routes through `config-patch.ts` (deep-merge, arrays replace) and the same Zod validation as `PATCH /api/config`.
- **`marketplace.install` / `marketplace.uninstall` / `marketplace.create_package`** keep their confirmation-token state machine inside the handler, unchanged across both servers.

## The CLI surface

The `dorkos` CLI verbs call a running server's HTTP API using the shared server-discovery + api-client pattern. They are the runtime-portable actuation path (Codex and OpenCode cannot receive MCP injection). Every verb accepts `--json` for raw machine output on stdout; errors go to stderr, so `--json` stdout stays clean on failure.

| Verb                                      | What it does                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `dorkos capabilities`                     | List the live capability catalog (id, title, tier, surfaces). `--json` for raw.          |
| `dorkos call <id>`                        | Invoke any capability by id: `POST /api/capabilities/:id/invoke`. Output is always JSON. |
| `dorkos agent list\|show\|create\|update` | Read and edit agents.                                                                    |
| `dorkos task list\|create\|trigger\|runs` | Read and drive Pulse tasks.                                                              |
| `dorkos activity`                         | Read the activity feed (`--type` filters within the fetched page).                       |
| `dorkos version --check`                  | Server version + latest npm version (degrades to the local update cache).                |

`dorkos capabilities` and `dorkos call` are the registry-native pair: an agent discovers what it can do with `capabilities`, then actuates any of it with `call`, no curated verb required. The curated verbs are thin human sugar over specific capabilities; command names and flags are the **stable public contract**, so the registry can adopt a verb without breaking callers.

`dorkos call` validates the id against the live catalog first (a clear client-side error beats a bare 404), then posts the input to the invoke route. Pass input with `--input '<json>'` or `--input-file <path>` (`-` reads stdin).

## How to add a capability

One declaration, and every surface follows:

1. **Declare it** in the owning domain (`operator-capabilities.ts`, `marketplace-capabilities.ts`, or a new domain that migrates onto the registry). Call `defineCapability` with:
   - `id`: `${domain}.${verb}` (the prefix must equal the domain name).
   - `title` and `description`: write the description for a model (imperative, name the real inputs and guards, say when to reach for it). The conformance suite rejects an empty or too-short description.
   - `tier`: `observe` / `act` / `destructive`.
   - `input` / `output`: Zod schemas. `input` must be a `z.object(...)` so the MCP field-map and the OpenAPI request derive cleanly.
   - `surfaces`: the `mcp` / `cli` / `http` projections you want. Set `readOnlyCarveOut: true` only on an `observe` tool you want reachable tokenless on the external server.
   - `invoke`: the transport-neutral handler. Wrap existing service or route logic; never duplicate route validation. Keep redaction and any confirmation flow here.
2. **Register the domain** in `dorkos-registry.ts` if it is new (both `composeDorkOsCapabilityRegistry` and `composeCapabilityRegistryForDocs`). An existing domain needs no wiring for a new capability.
3. **Tests.** Point a unit test at the handler (happy path + each rejection). The [conformance suite](#the-conformance-suite) already asserts the projections; you do not re-test those.

That is the whole checklist. The MCP tools (both servers), the OpenAPI path, the self-description entry, and (if declared) the CLI verb dispatch all appear automatically, and CI fails if any of them would be missing.

### Adding a curated CLI verb

A `cli` surface declares the verb name, but the curated verb handler is still a thin CLI command today (phase 2 froze the surface, not a code generator). Add a handler under `packages/cli/src/commands/` following `agent.ts` (a `parse<Verb>Args` and a `run<Verb>` returning an exit code), intercept it in `cli.ts` before the top-level `parseArgs`, and add it to the help text and the [CLI reference doc](../docs/guides/cli-usage.mdx#operator-commands). Keep the verb in lock-step with the capability's declared `cli.verb`.

## The conformance suite

`capabilityConformance(registry, fixtures)` in `@dorkos/test-utils` (the capability analogue of `runtimeConformance`) is the per-PR drift gate. It is wired against the real composed registry in `apps/server/src/services/core/capabilities/__tests__/capability-conformance.test.ts` and asserts, for every capability:

- a `${domain}.${verb}` id, a non-empty title, a non-empty model-facing description, and a valid tier;
- `invoke` is reachable against the domain's deps fixtures;
- both MCP servers register **exactly** the declared tool surfaces (no orphan in either direction);
- the CLI verb map covers every declared `cli` surface;
- `READ_ONLY_MCP_TOOL_NAMES`, restricted to capability tools, equals the registry's own `readOnlyCarveOut` derivation;
- every `readOnlyCarveOut` tool is `observe`-tier;
- no two capabilities collide on an OpenAPI route;
- the docs projection serves the same routes as the boot registry.

The structural checks live in a pure `checkCapabilityConformance` that returns a list of violations, so the suite is itself falsifiable: `packages/test-utils/src/__tests__/capability-conformance.test.ts` seeds drifts (a missing projection, a carve-out on a mutating tool, an OpenAPI collision) and proves each produces a violation. If you add a capability and forget a surface, this suite goes red before review.

## Phase 1 history

Before the registry, each capability was hand-registered three-plus times: an MCP descriptor in `operator-tool-descriptors.ts` / `marketplace-tool-descriptors.ts`, glue on each MCP server, a `tool-security.ts` entry for read-only tools, and a separate CLI handler. Keeping those in sync by hand was the failure mode the registry removes (its sharpest near-miss: a mutating tool one edit away from the hand-maintained read-only list). Phase 1 (spec `agents-as-operators`) shipped the operator and marketplace tool surfaces and froze their tool names and CLI verb names as a public contract; phase 2 (spec `capability-registry`) migrated those exact names onto the registry with byte-compatible output, so nothing an agent or MCP client relied on changed. The descriptor tables and per-server glue are gone; the tool names, CLI verbs, and confirmation flows they defined live on, generated from one declaration each.
