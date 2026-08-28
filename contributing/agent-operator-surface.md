# Agent-Operator Surface

## Overview

DorkOS agents are not just chat partners: they can **operate DorkOS itself**. They read the activity feed, edit their own persona, change your settings, and install marketplace packages. This guide is the internal map of that agent-facing surface: how a capability is declared once and projected onto every surface an agent can reach, where the pieces live, and how to add a new capability.

The one idea that explains the rest is the **Capability Registry**. A service domain declares a capability exactly once with `defineCapability` (id, model-facing description, permission tier, Zod input/output, a transport-neutral `invoke` handler, and the surfaces it projects onto). From that single declaration DorkOS generates:

- the **in-session MCP tool** (the `dorkos` server an agent reaches from inside a claude-code session),
- the **external MCP tool** (the `/mcp` HTTP server for external MCP clients),
- the **OpenAPI path** (so the capability shows up in `/api/docs`),
- the **self-description catalog** (`GET /api/capabilities/catalog`, the `list_capabilities` MCP tool, and `dorkos capabilities`).

CLI operator verbs (`dorkos agent`, `task`, `activity`, `version`) remain the runtime-portable path, because MCP injection only reaches claude-code and Codex/OpenCode agents cannot receive it. The generic `dorkos call <capability-id>` reaches every capability **on the registry** by id, so an agent on any runtime can actuate that much of DorkOS after discovering the catalog. See [The CLI surface](#the-cli-surface).

### The catalog is a subset, and every doc about it has to say so

The registry carries **30** capabilities today: 6 operator, 8 marketplace, 7 connector, 8 MCP-server-management (`mcp.*`, spec `mcp-server-management`), and `capabilities.list`. Alongside them, roughly 40 tools per MCP server (the `UNREGISTERED_TOOL_FAMILIES` in `self-description/capabilities-domain.ts`: tasks, relay, mesh, binding, trace, extension, devtools, UI, plus the hand-registered `create_agent`) have no registry entry. They appear in an agent's tool list and are unreachable by `dorkos call`.

**Absent from the catalog is not the same as untiered, and conflating the two is a documented defect.** Since DOR-468 all **47** hand-registered tools carry a tier in `core/mcp-tool-tiers.ts`, enforced by the same `enforceCapabilityTier` the registry calls (`core/mcp-tool-gate.ts`), and `gatedActionForMcpTool` throws at server-build time for a tool that declares none. So the honest split is two facts, not one: what the CATALOG lists (by-id, `dorkos call`-reachable), and what carries a TIER (everything). Keep them separate whenever you reword this.

`list_capabilities` says this in its own description, and a drift guard in `__tests__/capabilities-domain.test.ts` asserts each named family is genuinely absent from the composed registry, so the caveat self-retires: migrate a family and the guard fails, forcing the sentence out rather than leaving a now-false claim in the highest-traffic model-facing text in the product.

**Treat this as a recurring-defect zone, not a settled fact.** The construction "everything you can do" / "every capability" / "reaches every action" has been written about this catalog and corrected **eight separate times** across this program, because each round fixed the instance it was shown and missed the others. Two of those eight were introduced by the branch whose whole job was removing the other six. When you touch any of it, grep the construction rather than the wording, across `docs/`, `apps/site/`, `contributing/`, `README*`, and `changelog/unreleased/`. The canonical corrected phrasing lives in `capabilities-domain.ts`; reuse it instead of inventing a new one. Delete the caveat when those domains migrate, not before.

**Grepping body prose is not enough, and this is what the eight instances actually taught.** Half of them lived where a body-prose grep does not look, and each is a higher-traffic surface than the paragraph it contradicted:

| Surface                               | Why it hides                                                                                                                                                                                                                                               | Where it bit                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| MDX frontmatter `description:`        | Not prose; becomes `<meta name="description">`, the search snippet, the sidebar hover, and the text Fumadocs feeds to `llms.txt`. A model ingests it and never reads the correction.                                                                       | `docs/guides/action-approvals.mdx:3`                                                               |
| `<Card>` blurbs in Next-steps blocks  | Reads as navigation, not as a claim; sits 35 lines below the corrected bullet in the same file.                                                                                                                                                            | `docs/guides/operating-dorkos.mdx:88`                                                              |
| Marketing data objects                | `apps/site/.../features.ts` is a `.ts` file, so a docs-shaped grep skips it, and its `tagline` / `description` / `benefits` publish to dorkos.ai.                                                                                                          | `features.ts` `agent-attribution`                                                                  |
| JSX string props and inline captions  | Copy inside a component, often a one-line caption under a hero. The home page now keeps its words in a data module and hands them to JSX as props, so neither a prose grep nor a JSX grep sees the claim.                                                  | `_components/copy.ts`, gated by `_components/__tests__/home-copy.test.ts`                          |
| Skill-pack prose in template literals | `packages/operating-skills/src/skills/*.ts` reads as code, so nobody looks, but `seedOperatingSkills` writes it into every new agent's `.agents/skills/` and DorkBot's. A false claim here reaches every agent in the product before it reaches any human. | `scheduling-tasks.ts` told every agent that `tasks_delete` "carries no gate of its own" (DOR-509). |

So the check is: grep the construction across `**/*.{md,mdx,ts,tsx,json}`, then **separately** read every frontmatter `description:`, every `<Card>` blurb, every string field of the marketing feature entry, and the skill-pack template literals for whatever you just corrected. The hedge you wrote in the body has to be carried into all five, or you have moved the false claim rather than removed it.

`.json` is in that glob for one generated file: `docs/api/openapi.json:11383` embeds the `list_capabilities` description verbatim, as does `docs/api/api/capabilities/catalog/get.mdx:18`. Both derive from `capabilities-domain.ts`, so they are correct exactly as long as their source is, and neither is ever hand-edited. The glob is there to catch the case where they have drifted from it.

### The other half: implemented controls nobody can reach

A grep finds sentences. It does not find the second failure mode this program produced three times, where a corrected sentence leaves its **premise** standing in the bullet beside it: copy describing a control the code implements correctly but exposes to nobody. All three sentences sat in one paragraph of one changelog fragment, and they trace to only **two** inert affordances rather than to careless wording, which is the point:

| Inert affordance                                                                         | What the copy implied                                                                                                   |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `tierCeiling` (no setter; see above)                                                     | "Every agent can be limited to what it may do", and separately "DorkOS decides what an agent may do based on who it is" |
| `AgentIdentityService.revoke` (`agent-identity-service.ts:320`, zero production callers) | "a shut-off agent still trying"                                                                                         |

Nothing in production sets a ceiling or revokes a token: a token stops being accepted only by expiry (7 days idle, 30 absolute) or by being malformed.

The useful property is that this class is **bounded by the number of implemented-but-unexposed controls, not by the number of sentences**. So the check is not another grep. Before writing user-facing copy about a subsystem, enumerate the affordances it implements but does not expose (a method with no route, tool, CLI verb, or client caller), and confirm no copy anywhere describes them as available to the reader. For the identity module that enumeration is now closed: `tierCeiling` and `revoke` were the only two, both are ticketed, and both are named above so the next writer inherits the list rather than rediscovering it.

Knowing what you can do is the other half of the surface: see [The awareness surface](#the-awareness-surface).

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
| Runtime-neutral context blocks                | `apps/server/src/services/runtimes/shared/agent-context.ts`                       |
| `dorkos://` resources (both MCP servers)      | `apps/server/src/services/core/mcp-resources/`                                    |
| Identity token env seam                       | `apps/server/src/services/core/agent-identity/agent-token-env.ts`                 |
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

`enforceCapabilityTier` (`capabilities/tier-enforcement.ts`) runs INSIDE `registry.invoke` (DOR-467), so every surface that reaches a capability through the registry is gated by construction — the invoke route, both MCP adapters, and any adapter added later. A caller that owns its own effect and cannot route through the registry reaches the same gate through the one named seam, `authorizeCapability`. The **tier** decides whether to gate; identity is not part of that decision:

| Tier          | What happens                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `observe`     | Runs. Reading is free.                                                                                         |
| `act`         | Runs, audited by the attribution observer at the registry choke point.                                         |
| `destructive` | Does NOT run without an approval a person granted, bound to this capability id AND a hash of this exact input. |

**Scope check before you describe this to a user.** DOR-468 widened tier coverage to the hand-registered tools, so the gate is now system-wide across both surfaces: all 47 hand-registered MCP tools carry a tier (`services/core/mcp-tool-tiers.ts`), and the server's typecheck fails on a tool that declares none. Three capabilities are `destructive` today: `marketplace.uninstall` on the registry side, plus `tasks_delete` and `mesh_unregister` among the hand-registered tools. Everything else is `act` or `observe`, which is the honest thing to say: the three groups exist and cover everything, but only one of the three actually stops a call. Do not describe `act` as gated. It runs, audited.

That coverage is load-bearing, and DOR-519 is the proof. A separate bug handed a session an SDK `allowedTools` list that skipped the approval prompt for 31 to 35 tools at a time, `tasks_delete` and `mesh_unregister` among the names (the two of the three destructive actions that a tool group can contain; `marketplace.uninstall` is not in any group). Neither ran: `allowedTools` decides only whether the SDK asks before invoking a tool, and the tier gate sits below that, inside the handler. The layer that failed was not the layer that mattered. See ADR-0070 and ADR-260726-171347.

A gated call returns a structured `approval_required` payload (the same shape family as the marketplace's `requires_confirmation`, so an agent already knows the dance), carrying a fresh pending approval id, a one-time token, and retry instructions naming the channel for that surface (the `approvalToken` MCP argument, or the `X-DorkOS-Approval` header / `dorkos call --approval`). A `tierCeiling` caps everything the gate does cover: a ceiling of `act` makes destructive capabilities permanently unreachable for that caller, refused with `approvable: false` rather than queued for an approval nobody could grant. **Every** caller has one — an unidentified caller is capped at `anonymousTierCeiling` (default `DEFAULT_ANONYMOUS_TIER_CEILING`, i.e. `destructive` / no extra restriction), so the ceiling comparison cannot be escaped by dropping a credential. **The ceiling is correct code with no way to set it** (see below), so it constrains nothing in production today: identified or anonymous, every caller sits at `destructive`, and the comparison it would lose is one nobody can currently arm. Refused and pending attempts emit Activity events (`capability.denied`, `capability.approval_required`), so an audit trail records what an agent TRIED, not only what it did.

Five rules when working here:

- **Hash the parsed input, never the raw body.** `registry.invoke` parses ONCE and gates on that value, which is also the value the handler runs. There is no second parse and therefore nothing to keep in step: the parse-idempotence conformance assertion that used to guard the old double parse is gone with it. (`hashApprovalInput` still rejects Dates, Sets, Maps and class instances, which is a different guard and stays — see below.)
- **The token travels beside the input, never inside it** — otherwise it would change the hash it is checked against. `capabilityInputShape` adds the extra MCP argument for destructive tools; `splitApprovalToken` takes it back off.
- **The gate fails closed.** Until `initCapabilityTierGate` runs at boot, a destructive call is refused (`enforcement_unavailable`), so a wiring mistake cannot silently open the gate. Same for an input that cannot be canonicalized without losing information (`input_not_bindable`): `hashApprovalInput` rejects Dates, Sets, Maps, and class instances outright, because `stableStringify` would flatten them and bind an approval to a hash that ignores part of the action.
- **Only allowlisted input fields reach the card.** A destructive capability declares `approvalDisplayFields` (dotted paths, in reading order). Without one, every top-level field is shown except those whose NAME says secret. The summary is broadcast on the global event stream and returned by the agent-readable `GET /api/approvals/pending`, so `marketplace.uninstall`'s own `confirmationToken` field must never land there. Caller-supplied values are quoted, capped, and swept for token-shaped runs (`approvals/approval-summary.ts`) so a requester cannot forge a second field into the sentence a person decides on.
- **Auditing a destructive invocation is not conditional on identity.** The gate does not audit calls it ALLOWS (it defers to the invocation observer), so the observer must not skip anonymous callers for a `destructive` capability, or an irreversible action that RAN leaves no record. Both halves are pinned by tests; do not "optimize" either condition.

### Identity is the ceiling, never the switch

The gate deliberately does **not** key on identity presence. Keying on it would hand a prompt-injected agent with shell access a bypass needing strictly less capability than the honest path:

```
env -u DORKOS_AGENT_TOKEN dorkos call marketplace.uninstall --input '{"name":"x","purge":true}'
```

The CLI only attaches `X-DorkOS-Agent` when `DORKOS_AGENT_TOKEN` is in its env, and `sessionGate` is a pass-through in the default local (auth-disabled) posture — so an identity-keyed gate would let that purge run, unapproved and unattributed. A bare `curl` is the same shape.

So an unidentified caller is gated too: same `approval_required`, same binding, and the card says "An unidentified caller wants to run …" with `requestedBy` absent rather than fabricated. Anonymous attempts are audited under `actorType: 'system'`, so the feed never implies DorkOS knows who asked.

Spec §3.1's "absent identity = today's behavior" resolution is about **attribution**, and its rationale was not breaking external MCP clients or human CLI use. Those are `observe` and `act` calls, which pass untouched — the product cost is one Allow click for a human running `dorkos call` against a destructive capability, which is what spec §UX describes anyway. When identity IS present it does exactly two things: caps what the caller may reach (`tierCeiling`) and names them on the card.

**`tierCeiling` has no setter, so today only the second of those two does anything.** The sole production mint site is `agent-token-env.ts:52-55`, which passes `agentPath` and `displayName` and nothing else, so `agent-identity-service.ts:191` defaults every real agent to `destructive` and `TIER_RANK[tier] > TIER_RANK[identity.tierCeiling]` (`tier-enforcement.ts:423`) can never be true. There is no UI, no config field, no `agent.json` key, and no CLI flag: zero non-test references outside `apps/server/`. The enforcement path is right and fully tested; the affordance that would reach it was never built. **Do not describe per-agent limits as a user-facing capability** until a setter lands, and do not build one off the back of this note (it is separately ticketed). The same rule as the tier table above: check the registry, and here the mint site, before you write the sentence.

One narrowing of that §3.1 resolution, added after review: an anonymous **destructive** invocation is recorded anyway, as `actorType: 'system'` / `'Unidentified caller'`. Anonymous `observe` and `act` calls still write nothing. So "absent identity = today's behavior" holds for everything except the one case where silence is indefensible: an irreversible action DorkOS cannot attribute (see `specs/agent-trust/02-specification.md` Errata).

In-session identity is derived from the session's working directory rather than anything the agent presents, so an in-session agent cannot shed its ceiling by withholding a token either.

Both anonymous and identified paths are covered by the same falsifiable mechanism, and it is no longer a list of adapters: the conformance suite drives every `destructive` capability the registry carries through `registry.invoke` itself and requires a refusal. Because the gate is inside `invoke`, that one check covers every adapter at once, including ones that do not exist yet.

### Its companion: a positive per-agent grant fails the other way

The rule above is about the **tier** gate, and reading it as "nothing may ever key on identity" is a mistake worth heading off, because DorkOS now has one gate that does (ADR `260828-123331`, DOR-1611).

The difference is the polarity of the question, not the mechanism:

| Gate                                 | Question                            | An absent identity means | It fails   |
| ------------------------------------ | ----------------------------------- | ------------------------ | ---------- |
| Tier (`enforceCapabilityTier`)       | "is this caller restricted?"        | not restricted           | **open**   |
| Tool group (`enforceToolGroupGrant`) | "does this caller hold this grant?" | holds nothing            | **closed** |

That is why the first must not key on identity presence and the second must. Both obey the invariant the doctrine actually protects — _dropping a credential can never widen what a caller reaches_. Under a negative question, dropping one widens, which is the bypass. Under a positive grant it strictly narrows: `env -u DORKOS_AGENT_TOKEN` buys an anonymous caller that holds nothing.

Three things follow, and each is load-bearing rather than incidental:

- **The grant has to be unwritable by the agent it governs**, or it is not a grant. `updateAgentManifest` — the agent-reachable write path — refuses any patch naming `enabledToolGroups.roomsManage`, before the schema parse and whatever the value. The operator's `PATCH /api/mesh/agents/:id` is the one way in, and does not come through there. This is the narrow half of DOR-1506; the general policy for the rest of the manifest is still open.
- **It runs before the tier gate**, so a call the caller may never make cannot mint an approval card on its way to being refused. The refusal reuses `TierDeniedPayload` with `reason: 'tool_group_disabled'` and `approvable: false`, so 403 / non-`isError` MCP / `capability.denied` all come free — and a model is told plainly that no approval will ever unlock it.
- **The grant is read fresh, from the manifest file, on every call.** Never the SQLite `agents` cache: it has no column for `enabledToolGroups` and hands back `{}` for every agent, so a cached read would report everyone as ungranted and ignore a real grant. Fresh is also what makes "turning it off stops the very next call" a property of the code rather than a promise.

Do not read this as a general licence. Adding a second such group is a decision about a boundary, not a toggle: read ADR `260726-171347` on why the four keys beside it deliberately shape documentation only, and ADR-0070 on what happens when a switch appears to be a boundary and is not.

### The REST doors, and the one way past the gate

Two routes reach a guarded effect without going through a capability, and both shipped ungated:

| Route                                            | What it reached                                    | Why it mattered                                                                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/marketplace/packages/:name/uninstall` | `uninstallFlow.uninstall()` — no tier check at all | `dorkos uninstall` rides it, and the seeded skill pack TAUGHT agents that verb. The path agents learned was the path around the gate.                                                     |
| `PATCH /api/config`                              | `applyConfigPatch()` — no write-policy check       | The capability twin refuses operator-only paths; this route did not, so `curl -X PATCH /api/config -d '{"auth":{"enabled":false}}'` removed the posture the whole approval gate rests on. |

**The first thing to check about that guard is what it can and cannot widen.** The trusted marker is minted at exactly two production call sites, `routes/config.ts` and `routes/marketplace.ts` — and both of those routes were ungated for _every_ caller before this change. The generic agent actuation paths (`dorkos call`, both MCP servers) never mint one. So ADR 260725-133220's property still holds everywhere it held before: dropping a credential can never widen what a caller reaches. At the two newly-gated routes, dropping the header gets you only what you already had unconditionally. **Nothing that was gated becomes ungated**, which is the opposite of the defect that ADR records. Keep that property when you touch the mint sites: a third one on a path that is gated today would invert it.

Both routes now answer to the same guard, and the guard is **not a new idea**. `trustedCaller` (`capabilities/trusted-caller.ts`) delegates to `resolveDecisionAuthority` — the same predicate that decides who may GRANT an approval — and the invariant is one sentence:

> **Whoever may decide an approval may act without one.**

That is deliberately not a strengthening, and the two-step path is real rather than theoretical: review reproduced it end to end on an anonymous, credential-free caller (202 carrying both halves of its own approval, a headerless grant returning `{"ok":true,"outcome":"granted"}`, then the retry executing the destructive capability). It reproduces identically on `main`. A caller clearing this check could reach the same effect in two steps anyway (ask → 202 with the approval id → grant → retry with the token), so letting it act directly removes no guarantee; and a caller this check refuses cannot grant its own approval either, so gating it is not theatre. What it buys is that the two surfaces cannot drift apart about what counts as a person — they read the request through one function, `lib/caller-authority.ts`.

**Be precise about what this stops, because the default posture is `local-trust`.** In every posture, a caller presenting `X-DorkOS-Agent` is refused — and that is the case that matters, because an in-session agent always carries `DORKOS_AGENT_TOKEN`, so `dorkos uninstall` from inside a session IS gated. What is not stopped, with login off, is a caller that strips its own credential: a bare loopback request is indistinguishable from the cockpit's. That is the same gap `decision-authority.ts` already documents, inherited rather than introduced. Do not close it with an `Origin` header or a "cockpit" marker; turning on login is what closes it.

**One place the equivalence argument does NOT reach**, and it is worth stating because it is easy to cite the invariant past its edge: operator-only _config_ paths. `operator.config_patch` is tier `act`, so the capability twin refuses those paths unconditionally — there is no approval that could ever unlock them, and therefore no two-step path to be equivalent to. For that one effect the trusted escape grants something the capability surface refuses to the same principal. That divergence is accepted rather than overlooked (the cockpit needs the route; `local-trust` cannot distinguish it) and is spelled out at the call site in `routes/config.ts`.

The marker itself is an instance of an unexported class, checked with `instanceof`. Not a boolean, not a string, not an object shape — `JSON.parse` cannot produce one, so **no value that arrived as JSON can be trust**, however it is crafted. State it that way and no wider: in-process JavaScript that already holds a real marker can make another (`new (real.constructor)(…)`, `Object.create(proto)`, a subclass, a `Proxy`), and `trustedCaller` itself will mint one for any in-process caller that fabricates a request. The in-process boundary is the call-site scan, not the unexported class. A present-but-forged `trusted` value is refused loudly rather than quietly downgraded. Carrying a trusted marker AND an agent identity is a contradiction (the marker means no machine principal presented itself) and is refused rather than resolved in favour of either.

The invoke route (`POST /api/capabilities/:id/invoke`) deliberately never mints one: it is the generic agent actuation path, and the cost of gating it is one Allow click for a person running a destructive capability from a shell.

### Deciding needs proof of a person, not the absence of proof of a machine

The same inversion survived one file away, at the endpoint that DECIDES: `POST /api/approvals/:id/grant` refused a caller that PRESENTED an agent identity and let everyone else through, so the whole chain was three steps — ask (the 202 hands the caller both the approval id and its token), grant with a header-less request, retry with the token. Review reproduced it end to end.

`resolveDecisionAuthority` (`approvals/decision-authority.ts`) inverts the question, and its module TSDoc is the authoritative statement of what each posture guarantees. In summary:

| Posture              | When                  | What is required                                                  |
| -------------------- | --------------------- | ----------------------------------------------------------------- |
| `signed-in-operator` | `auth.enabled: true`  | An authenticated `res.locals.user`. Real enforcement.             |
| `local-trust`        | `auth.enabled: false` | No agent identity, no approval token. Everything else is allowed. |

`signed-in-operator` verifies a CREDENTIAL, not a human. A per-user API key satisfies `sessionGate` exactly as a session cookie does (DOR-474), so a program holding one — that also sheds its `X-DorkOS-Agent` header, which the check above refuses first — reaches the decide path. That is why the Activity record says "a signed-in account", never "a person": an audit line that overstates is worse than none, because it is believed.

`local-trust` is the DEFAULT posture and it is stated honestly rather than dressed up: with login off, `sessionGate` is a pass-through and there is no cryptographic difference between the person in the cockpit and an agent running `curl` on the same machine. It stops accidents and prompt-injected agents that play by the rules; it does not stop an adversary with shell access. Do not add a forgeable check (an `Origin` header, a "cockpit" marker) and call it security — the gap is better than the lie. The available mitigation is visibility: every recorded decision writes an Activity event (`approval.granted` / `approval.denied`) carrying its posture.

The falsifiable half is `requesterDecideProbe` in the conformance suite: it takes the approval the real invoke route just handed a caller and tries to grant it through the real approvals router, carrying that approval's own retry token. The invariant it encodes is exactly as wide as it proves — **a caller presenting an approval token cannot decide that approval** — and no wider. The broader "whoever can invoke cannot grant" is false by design with login off, and the identified-agent refusal is pinned at the route level instead (`routes/__tests__/capabilities-invoke.test.ts`), because this probe's caller is anonymous.

### How enforcement is proven, and the trap to avoid

Two layers, deliberately different in kind:

- **Structurally, per PR**: two complementary checks. `checkRegistryGateConformance` proves the gate is inside `registry.invoke`, so anything reaching a capability through the registry is gated. `__tests__/gate-bypass-scan.test.ts` covers what that cannot see — code reaching a protected effect (`applyConfigPatch`, `uninstallFlow.uninstall`) WITHOUT touching the registry, which is what both real defects did — by pinning the exact set of modules allowed to call each one. **The effect list is itself incomplete, and that is the scan's real limit**: it narrows the defect class from surfaces to effects rather than closing it, and cannot fail for an effect nobody added. A live uncovered example — the marketplace `sources` routes, ungated for every caller — is named in that file's TSDoc along with why gating it needs its own tier decision; read it before assuming the list is the whole story. See [the conformance suite](#the-conformance-suite).
- **Behaviorally, on a credentialed run**: three governance evals (`packages/evals/src/suite/governance.ts`) ask a real model to uninstall a seeded package and differ only in what the operator then does — `governance-approval-granted` (says yes; the uninstall completes), `governance-approval-denied` (says no; the tree is byte-identical), `governance-approval-expires` (says nothing; the window closes undecided). All three are `core`-tagged and `quarantined`, so they run and report but never gate until promoted.

  Why three and not one: a suite that could only observe "nobody answered" would pass just as happily against a gate that refused _everything_. Proving the gate lets an approved action through is the other half, and it is the half that needs a granted approval to exist.

  `pnpm evals:local` boots the credentialed tier on your own machine against your own `claude` sign-in, and the harness now answers approvals mid-run (DOR-498), so these cases reach a verdict instead of parking on the 90-second timeout. **That is still not the same as having the evidence to promote one.** Promotion is 5 of 5 consecutive credentialed runs, per case, recorded in the README — these cases depend on a real model choosing to retry with its approval token, and observed failures so far have all been model tool-choice variance rather than product regressions. See ["Answering an approval mid-run"](../packages/evals/README.md) for the policy mechanism, why the harness is a legitimate decider rather than a hole in the gate, credential precedence, the docker tier's key requirement, and how to read the GATING line.

  **If you add or change an oracle in that suite, run the falsifiability drill** the README describes: seed a change that should make the oracle red, confirm it does, and record the result. The granted case's own drill found that the intuitive claim — "remove the gate and several oracles red" — is false. Only `tierGateStoppedTheUninstall` reds structurally, for the reason in the next paragraph.

**The trap:** `marketplace.uninstall` is gated TWICE. The tier gate answers first with `status: 'approval_required'`; the marketplace handler's own older confirmation flow answers with `status: 'requires_confirmation'` and a `confirmationToken`. So "the package survived" proves nothing about the tier gate — with the gate ripped out, the handler's own flow still holds the line and a naive oracle stays green. Any test or eval claiming to cover tier enforcement here must discriminate on fields only the gate produces (`approvalId` + `approvalToken`, the registry's `tier`, the `retry` contract), and the eval's own unit test feeds it the marketplace shape and asserts it FAILS. Keep that property if you touch either flow.

The retry field is surface-dependent (`approvalToken` as an MCP argument, `x-dorkos-approval` as an HTTP header) while the payload field is not. Assert the payload's `approvalToken` and the retry contract's shape, not one surface's field name.

### The external mutation gate

The external `/mcp` server is reachable over HTTP, so it enforces a read-only carve-out: in login-off mode, a tool not in `READ_ONLY_MCP_TOOL_NAMES` requires the per-instance local token. That set is now **derived**, not hand-listed: a capability opts in with `surfaces.mcp.readOnlyCarveOut: true` (only valid on `observe`-tier tools), and `readOnlyCarveOutToolNames` reads that flag. `tool-security.ts` unions the derivation with a shrinking list of legacy hand-registered read-only tools from domains that have not migrated onto the registry yet (core, tasks, binding, mesh, relay). The conformance suite asserts the derived portion stays in lock-step, which removes the phase-1 failure mode where a mutating tool could be hand-added to the read-only list.

### Trust boundaries stay in `invoke`

Redaction, confirmation-token flows, and identity guards live inside `invoke` (or the service it calls), on every surface, because the transport adapters only shape the envelope:

- **`operator.update_agent`** routes through `agent-updater.ts`, the same service behind `PATCH /api/agents/current`. The slug (`name`) is immutable and system agents (DorkBot) reject identity changes.
- **`operator.config_patch`** routes through `config-patch.ts` (deep-merge, arrays replace) and the same Zod validation as `PATCH /api/config`, but first it clears a **write allowlist**: `CONFIG_WRITE_POLICY` (`config-write-policy.ts`) marks every leaf of `UserConfigSchema` `agent-writable` or `operator-only`, and a patch touching even one `operator-only` path is refused whole, with no partial write. It has to be an allowlist for the same reason the read side does, plus a sharper one: this capability is tier `act`, so the tier gate runs it with no approval, and `auth.enabled` was writable, which made it an ungated path to removing the logged-in posture that makes destructive approvals enforceable (DOR-488). Operator-only covers the login gate, `tunnel.*`, `mcp.*`, credential material and the hosts it reaches (`providers`, `runtimes.codex.credentialRef`, `runtimes.opencode.provider` + `baseURL`, `cloud.*`), code the server loads or spawns (`extensions.*`, both `binaryPath`s), the directory-scope fields (`server.boundary`, `workspace.rootPath`, `relay.dataDir`, `agents.defaultDirectory`, `mesh.scanRoots`), and `telemetry.*`. **It also has a floor that is not a judgement:** every leaf with a `PROTECTIVE_CARRYOVERS` rule — the values a config wipe refuses to reverse — is `operator-only` too, checked by its own drift guard (DOR-1497). That is what moved the four `agentContext.*` switches, `harness.autoSync`, both `uploads.max*` bounds, `runtimes.claudeCode.persistentSession` and `scheduler.maxConcurrentRuns` onto the list, none of which is security-shaped: a wipe is the accident and it already refuses them, so a deliberate agent write cannot be the looser case. **The guard is at the capability handler, deliberately NOT inside `applyConfigPatch`** — the cockpit's own enable-login and disable-login flows reach that shared function through `PATCH /api/config` and must keep working; `routes/__tests__/config.test.ts` fences that. **If you add a config field, add its verdict**: the drift guard in `__tests__/config-write-policy.test.ts` compares the table against the live schema in both directions and fails until you do.
- **`operator.config_get`** (and `config_patch`'s echo) returns `sanitizedConfigSnapshot()`, which is a **classification allowlist**, not a denylist: `config-disclosure.ts` marks every leaf of `UserConfigSchema` `expose` or `withhold`, and only `expose` paths are copied. It has to be an allowlist because `config_get` carries `readOnlyCarveOut: true` and therefore answers with no credential in login-off mode; a denylist ships every newly added secret-bearing field by default, which is how `mcp.apiKey` once reached this surface. Withheld: the four `SENSITIVE_CONFIG_KEYS`, every credential reference (`providers`, `runtimes.codex.credentialRef`), and `cloud.linkedAccountLabel`. Each of those becomes a boolean `…Configured` flag (or `providersConfigured`, the provider ids). Absolute paths stay exposed deliberately: they are how the surface addresses work. **If you add a config field, add its verdict**: the drift guard in `__tests__/config-disclosure.test.ts` compares the table against the live schema in both directions and fails until you do.
- **`marketplace.install` / `marketplace.uninstall` / `marketplace.create_package`** keep their confirmation-token state machine inside the handler, unchanged across both servers. They now also read the invocation context: `requestedBy` names the asking agent on the card, and `preApproved` tells `marketplace.uninstall` (the one `destructive` capability) that the tier gate already spent a person's approval for these exact arguments — without it, one uninstall would put two cards in front of the operator.

## The awareness surface

Actuation is only half of it: an agent also has to know what it is and what it can reach. Two pieces carry that, and both are shared across runtimes rather than owned by one adapter.

**The context blocks.** `runtimes/shared/agent-context.ts` builds the runtime-neutral system-prompt append: `<agent_identity>`, `<agent_persona>`, `<agent_safety_boundaries>`, `<dorkos_context>` (which names `dorkos capabilities` and `dorkos call`), and `<env>`. Every adapter delivers it through whatever channel its backend actually has:

| Runtime     | Channel                                                | Identity token                                                 |
| ----------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| claude-code | `systemPrompt.append` (cacheable), after its tool docs | Per-turn `DORKOS_AGENT_TOKEN` in the SDK subprocess env        |
| codex       | Prompt prefix (`buildCodexPrompt`)                     | Per-turn `DORKOS_AGENT_TOKEN` via a turn-scoped `Codex` client |
| opencode    | `synthetic` text part (`buildOpenCodeParts`)           | **None**, see below                                            |

Runtime-SPECIFIC tool documentation (`<relay_tools>`, `<mesh_tools>`, `<ui_tools>`, ...) deliberately stays in the Claude adapter's `context-builder.ts`: those blocks teach in-session MCP tools only that runtime is given.

**OpenCode has no identity, and that is a backend limit rather than an omission.** The sidecar is one process shared by every session (ADR-0308) with its environment fixed at spawn, and neither `session.promptAsync` nor session creation carries per-session environment. The only channel that exists is the prompt, and putting a bearer token there would publish it into the model's context and the transcript, which is exactly what `agent-token-env.ts` exists to avoid. So an OpenCode agent's `dorkos call` runs unattributed and uncapped by a tier ceiling. Closing it needs a per-session sidecar or an upstream per-request env seam.

**The resources.** `dorkos://sessions`, `dorkos://agents`, `dorkos://skills`, and `dorkos://capabilities` answer "what is the state of my world?". They are registered from ONE place, `registerDorkOsResources` (`services/core/mcp-resources/`), which both MCP servers call. Registering them on only one server is how the surface drifted before: for two phases they were external-only, so a third-party MCP client could ask a running DorkOS what sessions were open and the user's own agent could not. `DORKOS_RESOURCE_URIS` plus the parity test in that directory is the drift guard.

## The CLI surface

The `dorkos` CLI verbs call a running server's HTTP API using the shared server-discovery + api-client pattern. They are the runtime-portable actuation path (Codex and OpenCode cannot receive MCP injection). Every verb accepts `--json` for raw machine output on stdout; errors go to stderr, so `--json` stdout stays clean on failure.

**Credentials.** `sessionGate` gates every `/api/*` path when `config.auth.enabled` is true and accepts only a Better Auth session cookie or a per-user API key as `Authorization: Bearer <key>`. The CLI has no cookie, so `apiCall` presents a key resolved `DORKOS_API_KEY` → `<dork home>/api-key` (a `0600` file, which is what lets agent subprocesses reach a login-on instance: they inherit the server's env, not the person's) → nothing. That branch is on key **presence**, not on server state, which the CLI cannot know before it calls: with no key set up the request is byte-identical to before, and a leftover `~/.dork/api-key` or exported `DORKOS_API_KEY` is still sent to a login-off server, where `sessionGate` returns at its `auth.enabled` check without ever looking at the header. Two things that look like credentials but are not: the per-instance **local MCP token** is inactive whenever login is on (ADR-0320) and is only ever consulted by `middleware/mcp-auth.ts` on `/mcp` + `/a2a`, and `X-DorkOS-Agent` is resolved _after_ the gate, so agent identity is attribution and can never authorize. A `401` carrying the login gate's own `AUTH_REQUIRED` (or no code at all) is rewritten by `api-client.ts` into guidance naming the credential and where to mint one; do not let a bare `Unauthorized` reach a person. A `401` a ROUTE raised for its own reason is passed through verbatim — since DOR-1361 every room address answers `AGENT_IDENTITY_UNVERIFIED` to an `X-DorkOS-Agent` token it cannot verify, and telling that caller to mint an API key would name the wrong credential.

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

That is the whole checklist for the generated surfaces: the MCP tools (both servers), the OpenAPI path, and the self-description entry appear with no extra wiring, and the conformance suite fails CI if a declared projection is missing.

**A `cli` surface is the exception, and it is not generated.** Declaring `cli` freezes the verb name and makes the conformance suite demand a matching entry in the CLI verb map; it does not write the handler. That is why **zero capabilities declare a `cli` surface today**: the curated verbs (`dorkos agent`, `task`, `activity`, `version`) are hand-written commands that predate the registry, and `dorkos call` covers everything else. See [Adding a curated CLI verb](#adding-a-curated-cli-verb) for the manual half.

One more place where "generated" is narrower than it sounds: only **2** capabilities declare an `http` surface (`operator.activity_list` and `capabilities.list`), so 2 of the OpenAPI document's operations come from the registry against 82 hand-written `registerPath` sites. That is not a bug, and it is routinely overstated in prose. Check a claim against the registry before you write it.

Tiers are the opposite case: they are **not** registry-only. `defineCapability` declares one for a capability and `MCP_TOOL_TIERS` declares one for each hand-registered tool, and both feed the same gate. A count of tiered things is therefore a count over two tables, not one. Getting that wrong produces the specific error of calling `tasks_delete` and `mesh_unregister` "the two destructive actions" when `marketplace.uninstall` is a third.

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
- **`registry.invoke` refuses every `destructive` capability** presented with no approval and no trusted marker. Derived from the registry rather than from a hand-listed set of adapters, which is the change DOR-467 forced: the old list could only fail for a path already on it, so the legacy marketplace routes — never listed, and genuinely ungated — kept it green. A registry declaring no destructive capability is itself a violation, so the check cannot go vacuous.

The per-adapter probes still exist, as ordinary tests in `capability-conformance.test.ts` rather than as a fixture contract. They prove something the registry-level check cannot: that each adapter TRANSLATES a refusal correctly (a `202` on the route, a non-error result on both MCP servers).

The structural checks live in a pure `checkCapabilityConformance` that returns a list of violations, so the suite is itself falsifiable: `packages/test-utils/src/__tests__/capability-conformance.test.ts` seeds drifts (a missing projection, a carve-out on a mutating tool, an OpenAPI collision) and proves each produces a violation. If you add a capability and forget a surface, this suite goes red before review.

## Phase 1 history

Before the registry, each capability was hand-registered three-plus times: an MCP descriptor in `operator-tool-descriptors.ts` / `marketplace-tool-descriptors.ts`, glue on each MCP server, a `tool-security.ts` entry for read-only tools, and a separate CLI handler. Keeping those in sync by hand was the failure mode the registry removes (its sharpest near-miss: a mutating tool one edit away from the hand-maintained read-only list). Phase 1 (spec `agents-as-operators`) shipped the operator and marketplace tool surfaces and froze their tool names and CLI verb names as a public contract; phase 2 (spec `capability-registry`) migrated those exact names onto the registry with byte-compatible output, so nothing an agent or MCP client relied on changed. The descriptor tables and per-server glue are gone; the tool names, CLI verbs, and confirmation flows they defined live on, generated from one declaration each.
