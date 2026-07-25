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
- The user-facing guides [Your agents can operate DorkOS](../docs/guides/operating-dorkos.mdx) and [Action Approvals](../docs/guides/action-approvals.mdx), plus the [CLI reference](../docs/guides/cli-usage.mdx#operator-commands).

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
| Tier enforcement (the gate)                   | `apps/server/src/services/core/capabilities/tier-enforcement.ts`                  |
| Approval primitive                            | `apps/server/src/services/core/approvals/approval-service.ts`                     |
| Agent identity + token expiry                 | `apps/server/src/services/core/agent-identity/agent-identity-service.ts`          |
| Gate audit → Activity                         | `apps/server/src/services/core/agent-identity/capability-gate-audit.ts`           |
| Conformance suite                             | `packages/test-utils/src/capability-conformance.ts`                               |
| Governance eval (behavioral proof)            | `packages/evals/src/suite/governance.ts`                                          |

## How a capability projects

A `CapabilityDefinition` carries a `surfaces` object with three optional projections:

- `mcp`: the tool name, which server(s) advertise it (`in-session`, `external`, or both), an optional `readOnlyCarveOut` flag, and the two annotation hints (`openWorldHint`, `idempotentHint`) that a tier alone cannot express. The other two MCP hints (`readOnlyHint`, `destructiveHint`) are derived from the `tier`.
- `cli`: a curated operator verb (and optional subcommand). Optional: a capability with no `cli` surface is still reachable through the generic `dorkos call`.
- `http`: a method + path auto-registered into the OpenAPI document.

`composeDorkOsCapabilityRegistry` folds every domain into one immutable registry at boot and throws on any structural conflict (a duplicate id, a duplicate tool name, a duplicate CLI verb, a duplicate HTTP route, or an id not prefixed with its domain). The two MCP adapters and the OpenAPI projection then read that one registry, so a capability appears on every surface it declares with zero extra wiring.

### Permission tiers are enforced

Every capability declares a `tier`: `observe` (pure read), `act` (mutates local state), or `destructive` (deletes or unregisters). Since spec `agent-trust` §3.2 the tier is a **real gate**, not metadata.

`enforceCapabilityTier` (`capabilities/tier-enforcement.ts`) runs at all three choke points BEFORE `registry.invoke` — the invoke route, and both MCP adapters via `invokeCapabilityAsMcpResult`. The **tier** decides whether to gate; identity is not part of that decision:

| Tier          | What happens                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `observe`     | Runs. Reading is free.                                                                                         |
| `act`         | Runs, audited by the attribution observer at the registry choke point.                                         |
| `destructive` | Does NOT run without an approval a person granted, bound to this capability id AND a hash of this exact input. |

A gated call returns a structured `approval_required` payload — the same shape family as the marketplace's `requires_confirmation`, so an agent already knows the dance — carrying a fresh pending approval id, a one-time token, and retry instructions naming the channel for that surface (the `approvalToken` MCP argument, or the `X-DorkOS-Approval` header / `dorkos call --approval`). The identity's `tierCeiling` caps everything: a ceiling of `act` makes destructive capabilities permanently unreachable for that agent, refused with `approvable: false` rather than queued for an approval nobody could grant. Refused and pending attempts emit Activity events (`capability.denied`, `capability.approval_required`), so an audit trail records what an agent TRIED, not only what it did.

Three rules when working here:

- **Hash the parsed input, never the raw body.** A choke point parses first, gates on the parsed value, then hands that same value to `registry.invoke` — which parses it again. That double parse is only safe while destructive schemas are parse-idempotent, so the conformance suite asserts exactly that, per destructive capability. A schema that grows a non-idempotent `.transform()` fails there rather than quietly binding the approval to something other than what runs.
- **The token travels beside the input, never inside it** — otherwise it would change the hash it is checked against. `capabilityInputShape` adds the extra MCP argument for destructive tools; `splitApprovalToken` takes it back off.
- **The gate fails closed.** Until `initCapabilityTierGate` runs at boot, a destructive call is refused (`enforcement_unavailable`), so a wiring mistake cannot silently open the gate.

### Identity is the ceiling, never the switch

The gate deliberately does **not** key on identity presence. Keying on it would hand a prompt-injected agent with shell access a bypass needing strictly less capability than the honest path:

```
env -u DORKOS_AGENT_TOKEN dorkos call marketplace.uninstall --input '{"name":"x","purge":true}'
```

The CLI only attaches `X-DorkOS-Agent` when `DORKOS_AGENT_TOKEN` is in its env, and `sessionGate` is a pass-through in the default local (auth-disabled) posture — so an identity-keyed gate would let that purge run, unapproved and unattributed. A bare `curl` is the same shape.

So an unidentified caller is gated too: same `approval_required`, same binding, and the card says "An unidentified caller wants to run …" with `requestedBy` absent rather than fabricated. Anonymous attempts are audited under `actorType: 'system'`, so the feed never implies DorkOS knows who asked.

Spec §3.1's "absent identity = today's behavior" resolution is about **attribution**, and its rationale was not breaking external MCP clients or human CLI use. Those are `observe` and `act` calls, which pass untouched — the product cost is one Allow click for a human running `dorkos call` against a destructive capability, which is what spec §UX describes anyway. When identity IS present it does exactly two things: caps what the caller may reach (`tierCeiling`) and names them on the card.

In-session identity is derived from the session's working directory rather than anything the agent presents, so an in-session agent cannot shed its ceiling by withholding a token either.

Both anonymous and identified paths are covered by the same falsifiable mechanism: `GATED_ADAPTER_PATHS` lists each of the three adapters twice (`…` and `…-anonymous`), and a missing probe is itself a conformance violation.

### How enforcement is proven, and the trap to avoid

Two layers, deliberately different in kind:

- **Structurally, per PR**: the conformance suite's `destructiveGateProbes` drive each adapter path against a real `destructive` capability and require an `approval_required` payload with no side effect. That is the drift gate — see [the conformance suite](#the-conformance-suite).
- **Behaviorally, on a credentialed run**: the `governance-approval-gate` eval (`packages/evals/src/suite/governance.ts`) asks a real model to uninstall a seeded package with no approval in hand, then asserts the gate stopped it, an approval row landed in the sandbox database, and the package tree is byte-identical. It is `core`-tagged and `quarantined`, so it runs and reports but never gates until a credentialed run promotes it.

**The trap:** `marketplace.uninstall` is gated TWICE. The tier gate answers first with `status: 'approval_required'`; the marketplace handler's own older confirmation flow answers with `status: 'requires_confirmation'` and a `confirmationToken`. So "the package survived" proves nothing about the tier gate — with the gate ripped out, the handler's own flow still holds the line and a naive oracle stays green. Any test or eval claiming to cover tier enforcement here must discriminate on fields only the gate produces (`approvalId` + `approvalToken`, the registry's `tier`, the `retry` contract), and the eval's own unit test feeds it the marketplace shape and asserts it FAILS. Keep that property if you touch either flow.

The retry field is surface-dependent (`approvalToken` as an MCP argument, `x-dorkos-approval` as an HTTP header) while the payload field is not. Assert the payload's `approvalToken` and the retry contract's shape, not one surface's field name.

### The external mutation gate

The external `/mcp` server is reachable over HTTP, so it enforces a read-only carve-out: in login-off mode, a tool not in `READ_ONLY_MCP_TOOL_NAMES` requires the per-instance local token. That set is now **derived**, not hand-listed: a capability opts in with `surfaces.mcp.readOnlyCarveOut: true` (only valid on `observe`-tier tools), and `readOnlyCarveOutToolNames` reads that flag. `tool-security.ts` unions the derivation with a shrinking list of legacy hand-registered read-only tools from domains that have not migrated onto the registry yet (core, tasks, binding, mesh, relay). The conformance suite asserts the derived portion stays in lock-step, which removes the phase-1 failure mode where a mutating tool could be hand-added to the read-only list.

### Trust boundaries stay in `invoke`

Redaction, confirmation-token flows, and identity guards live inside `invoke` (or the service it calls), on every surface, because the transport adapters only shape the envelope:

- **`operator.update_agent`** routes through `agent-updater.ts`, the same service behind `PATCH /api/agents/current`. The slug (`name`) is immutable and system agents (DorkBot) reject identity changes.
- **`operator.config_patch`** routes through `config-patch.ts` (deep-merge, arrays replace) and the same Zod validation as `PATCH /api/config`.
- **`operator.config_get`** (and `config_patch`'s echo) returns `sanitizedConfigSnapshot()`, which is a **classification allowlist**, not a denylist: `config-disclosure.ts` marks every leaf of `UserConfigSchema` `expose` or `withhold`, and only `expose` paths are copied. It has to be an allowlist because `config_get` carries `readOnlyCarveOut: true` and therefore answers with no credential in login-off mode; a denylist ships every newly added secret-bearing field by default, which is how `mcp.apiKey` once reached this surface. Withheld: the four `SENSITIVE_CONFIG_KEYS`, every credential reference (`providers`, `runtimes.codex.credentialRef`), and `cloud.linkedAccountLabel`. Each of those becomes a boolean `…Configured` flag (or `providersConfigured`, the provider ids). Absolute paths stay exposed deliberately: they are how the surface addresses work. **If you add a config field, add its verdict**: the drift guard in `__tests__/config-disclosure.test.ts` compares the table against the live schema in both directions and fails until you do.
- **`marketplace.install` / `marketplace.uninstall` / `marketplace.create_package`** keep their confirmation-token state machine inside the handler, unchanged across both servers. They now also read the invocation context: `requestedBy` names the asking agent on the card, and `preApproved` tells `marketplace.uninstall` (the one `destructive` capability) that the tier gate already spent a person's approval for these exact arguments — without it, one uninstall would put two cards in front of the operator.

## The CLI surface

The `dorkos` CLI verbs call a running server's HTTP API using the shared server-discovery + api-client pattern. They are the runtime-portable actuation path (Codex and OpenCode cannot receive MCP injection). Every verb accepts `--json` for raw machine output on stdout; errors go to stderr, so `--json` stdout stays clean on failure.

**Credentials.** `sessionGate` gates every `/api/*` path when `config.auth.enabled` is true and accepts only a Better Auth session cookie or a per-user API key as `Authorization: Bearer <key>`. The CLI has no cookie, so `apiCall` presents a key resolved `DORKOS_API_KEY` → `<dork home>/api-key` (a `0600` file, which is what lets agent subprocesses reach a login-on instance: they inherit the server's env, not the person's) → nothing. That branch is on key **presence**, not on server state, which the CLI cannot know before it calls: with no key set up the request is byte-identical to before, and a leftover `~/.dork/api-key` or exported `DORKOS_API_KEY` is still sent to a login-off server, where `sessionGate` returns at its `auth.enabled` check without ever looking at the header. Two things that look like credentials but are not: the per-instance **local MCP token** is inactive whenever login is on (ADR-0320) and is only ever consulted by `middleware/mcp-auth.ts` on `/mcp` + `/a2a`, and `X-DorkOS-Agent` is resolved _after_ the gate, so agent identity is attribution and can never authorize. A `401` from any verb is rewritten by `api-client.ts` into guidance naming the credential and where to mint one; do not let a bare `Unauthorized` reach a person.

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
- the docs projection serves the same routes as the boot registry;
- **every adapter path enforces the tier gate.** `destructiveGateProbes` supplies one probe per path (`invoke-route`, `in-session-mcp`, `external-mcp`); each drives the real adapter against a `destructive` capability with an identity and no token, and must come back with an `approval_required` payload and no side effect. A missing probe is itself a violation, so adding a fourth agent-facing surface without gating it cannot pass quietly.

The structural checks live in a pure `checkCapabilityConformance` that returns a list of violations, so the suite is itself falsifiable: `packages/test-utils/src/__tests__/capability-conformance.test.ts` seeds drifts (a missing projection, a carve-out on a mutating tool, an OpenAPI collision) and proves each produces a violation. If you add a capability and forget a surface, this suite goes red before review.

## Phase 1 history

Before the registry, each capability was hand-registered three-plus times: an MCP descriptor in `operator-tool-descriptors.ts` / `marketplace-tool-descriptors.ts`, glue on each MCP server, a `tool-security.ts` entry for read-only tools, and a separate CLI handler. Keeping those in sync by hand was the failure mode the registry removes (its sharpest near-miss: a mutating tool one edit away from the hand-maintained read-only list). Phase 1 (spec `agents-as-operators`) shipped the operator and marketplace tool surfaces and froze their tool names and CLI verb names as a public contract; phase 2 (spec `capability-registry`) migrated those exact names onto the registry with byte-compatible output, so nothing an agent or MCP client relied on changed. The descriptor tables and per-server glue are gone; the tool names, CLI verbs, and confirmation flows they defined live on, generated from one declaration each.
