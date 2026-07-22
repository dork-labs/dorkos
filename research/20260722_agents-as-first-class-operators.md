# Agents as First-Class Operators of DorkOS

- **Date:** 2026-07-22
- **Status:** active
- **Question:** How do DorkOS agents get (1) the knowledge and (2) the actuation to do anything a user can do in DorkOS - create agents, manage groups, read activity, schedule tasks, configure runtimes, operate the marketplace, change their own personality, and act on the user's behalf?
- **Method:** 4 parallel codebase scans (agent-facing surface, API/CLI coverage, internal prior art, eval/test infra) + external research on 2025-26 agent-native platform patterns.

---

## Executive summary

DorkOS already contains ~80% of the raw actuation (HTTP routes exist for nearly every capability) and a strong philosophical foundation (ADR-0185 knowledge injection, the marketplace's "it's for agents" vision, agent UI control, agent-built extensions). What it lacks is **coherence**: the capability surface is projected inconsistently across four transports (in-session MCP, external MCP, CLI, OpenAPI docs), each hand-maintained and each drifted from the others. Two runtimes (Codex, OpenCode) get almost no DorkOS tools at all. No first-party skills teach agents how to operate DorkOS. There is no agent identity, so no per-agent permissioning or audit attribution.

**Recommendation: one Capability Registry, projected everywhere; CLI-first actuation; skills-first knowledge; tiered permissions with audit.** This matches both the strongest external pattern (Home Assistant's "one internal capability model, multiple transports"; the CLI-over-flat-MCP efficiency findings) and DorkOS's existing bones (the CLI, `@dorkos/skills` + Harness Sync, ActivityService, the `isSystem` protection primitive, the marketplace confirmation-token flow).

The decisive architectural fact discovered: **only the claude-code runtime can receive DorkOS's in-process MCP server. Codex gets a single scoped `control_ui` tool; OpenCode gets zero tools.** Every runtime, however, can run shell commands. Therefore the `dorkos` CLI is the only actuation surface that can be universal across runtimes - which independently confirms the CLI-first conclusion the external research reached on token-efficiency grounds (CLI ~10-32x cheaper than MCP schemas, higher reliability).

---

## 1. Current state (verified)

### 1.1 Actuation surfaces and their drift

Four projections of "what DorkOS can do", none complete, none derived from a shared source:

| Surface                                                                                                                           | What it has                                                                                                                                                       | What it's missing                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------- |
| **In-session MCP** (`services/runtimes/claude-code/mcp-tools/`, auto-injected per query via `mcpServerFactory`, claude-code only) | ~40 tools: core, tasks, relay (+adapters/bindings/traces), mesh, `create_agent`, `control_ui`/`get_ui_state`, devtools, extensions                                | All 8 marketplace tools (external-only!), agent self-edit, activity, config, groups, version check                                                                        |
| **External MCP** (`/mcp`, `services/core/mcp-server.ts`)                                                                          | Mirror of the above minus UI/devtools, **plus** 8 marketplace tools and 3 read-only resources (`dorkos://sessions                                                 | agents                                                                                                                                                                    | skills`) | activity, config, groups, agent self-edit, version |
| **CLI** (`packages/cli`)                                                                                                          | server boot, config get/set, marketplace install/uninstall/update/sources/cache, package init/validate, harness sync, auth, cloud, telemetry, doctor, shapes fork | No `agents`, `tasks`, `activity`, `mesh`, `relay`, `groups`, `runtime connect`, or `publish` subcommands                                                                  |
| **OpenAPI** (`/api/openapi.json`, hand-registered in `services/core/openapi-registry.ts`, 2,478 lines)                            | 13 tags (Health, Sessions, Models, Tasks, Relay, Mesh, Marketplace, Shapes, Connectors, ...)                                                                      | ~20 mounted routers absent: Agents, Activity, Config, Workspaces, Runtimes/Connect, Extensions, Templates, and more; some registered schemas are drift-prone hand-mirrors |

The HTTP API itself is the broadest layer: agent create + self-edit (`PATCH /api/agents/current`, correctly blocking `name`/system-identity fields), tasks + run history, activity feed, marketplace, mesh health/heartbeat, runtimes/connect (loopback-only), shapes, extensions.

### 1.2 Per-runtime reality

- **claude-code:** full in-process `dorkos` MCP server on every query. The only fully-equipped runtime.
- **codex:** DorkOS cannot inject tools; a loopback `dorkos_ui` MCP server exposes exactly `control_ui` for canvas parity. Nothing else.
- **opencode:** `supportsMcp: false`. Zero DorkOS tools.
- Harness Sync never touches MCP wiring anywhere (no `.mcp.json` / `config.toml` projection).

### 1.3 Knowledge layer

- Every agent's system prompt gets static tool-doc blocks (RELAY/MESH/TASKS/UI contexts, cache-ordered) + `<agent_identity>`/`<agent_persona>`(SOUL.md)/`<agent_safety_boundaries>`(NOPE.md) + a `<dorkos_context>` block (ADR-0185, default ON) that names the subsystems and gives two URLs (`dorkos.ai/llms.txt`, `/docs`). It is a pointer, not content.
- Per-turn dynamic context rides the ADR-0273 structured-prepend channel (git status, UI state, queue notes), runtime-neutral.
- The site ships llms.txt, llms-full.txt, per-page raw `.mdx`, `sitemap.md` (v0.52.0, DOR-345). Public HTTP only; no search tool, no offline/local equivalent served by the running server.
- **No docs MCP exists** (only proposed in `research/20260717_site-og-seo-ai-agents-world-class.md`).
- **No first-party "operate DorkOS" skills exist for end-user agents.** The 29 in-repo `.agents/skills/` are dev-of-DorkOS dogfood skills, never distributed. `scaffoldInstructions()` seeds a fresh agent workspace with only an AGENTS.md stub.
- DorkBot's only real privileges: `isSystem` cross-namespace Relay reach + a richer default AGENTS.md. Tool-wise it is identical to every agent. Its onboarding/living-tour magic is scripted client-side UI, not agent capability.

### 1.4 True dead zones (no programmatic path at all)

1. **Status bar toggles** - client Zustand + `localStorage` only (`app-store-preferences.ts`); never reaches `~/.dork/config.json`.
2. **Smart-group membership evaluation** - client-only (`evaluate-smart-group.ts`); the server stores rules (`ui.sidebar.groups` via `PATCH /api/config`) but cannot compute who matches.
3. **Marketplace publish** - `package init` scaffolds into the personal marketplace; no publish-to-registry step exists anywhere.
4. **Version check** - exists only as a field on `GET /api/config` (`latestVersion`) and a CLI startup side effect; no dedicated capability.

### 1.5 Identity and governance

There is **no agent identity**: an agent calling the API/MCP uses the same bearer credential as a human. No per-agent permissioning, no audit attribution of "which agent did this". Existing primitives to build on: the `isSystem` protection (enforced at routes + MCP + UI), the marketplace confirmation-token trust boundary, the read-only tool allowlist for tokenless external MCP, and ActivityService as the audit sink.

---

## 2. External patterns (2025-26 state of the art)

Full sourcing in the conversation record; the load-bearing findings:

1. **One internal capability model, multiple transports.** Home Assistant's LLM API is the closest analogue: every integration contributes agent tools via a per-feature hook (`async_get_tools`), evaluated per-request; every registered LLM API auto-serves over MCP; they deliberately started with the smallest safe surface and graduated. Never a hand-maintained parallel tool list.
2. **CLI beats flat MCP tool lists for agent actuation.** Empirical evals: an 800-token CLI tips file beat 28k tokens of MCP schemas; 10-32x cheaper; higher reliability. Consensus framework: CLI as default, MCP where structure/auth/typed results/session context genuinely matter. SWE-agent's ACI principles: few, consolidated, concise actions.
3. **Context bloat is the failure mode of "expose everything as tools".** Mitigations in order of strength: tool search / lazy loading (~85% token reduction), code-execution-with-MCP (present the surface as a code API; 98.7% token savings in Anthropic's example), MCP **resources** for knowledge vs **tools** for actuation, progressive disclosure everywhere.
4. **Skills are the knowledge vehicle.** SKILL.md progressive disclosure (name+description at startup, body on activation, bundled files on demand) is exactly how products teach agents to operate them. llms.txt/llms-full is agent-DX, consumed by IDE agents and docs MCPs (Context7, Mintlify).
5. **Self-improvement = accreting skill library** (Voyager): agents write, verify, store, and reuse executable "how I did X" skills. n8n exposes its own workflow engine to agents both ways (consumes MCP, exposes workflows as MCP tools).
6. **Governance consensus:** least-privilege per-agent identity; classify destructive + self-modifying ops and gate them with human approval; audit every attempted action; kill switch. Notion Agents ("every run logged, visible, reversible") is the product benchmark.

---

## 3. Target architecture

### Pillar 1 - The Capability Registry (single source of truth)

A typed registry where each service domain declares its capabilities once:

```ts
defineCapability({
  id: 'agents.update_self',          // stable, namespaced
  title: 'Update an agent profile',
  description: '...',                 // written for models, per ACI principles
  tier: 'act',                        // 'observe' | 'act' | 'destructive'
  input: UpdateAgentSchema,           // Zod, already exists for most routes
  output: AgentManifestSchema,
  handler: ...,                       // or a binding to the existing route handler
})
```

Everything else becomes a **projection** of the registry:

- **HTTP routes + OpenAPI** - registration replaces the hand-maintained 2,478-line `openapi-registry.ts`; completeness becomes structural, not aspirational.
- **In-session MCP server** - generated tool registrations (claude-code; any future runtime that supports injection).
- **External `/mcp`** - same generation, minus session-scoped capabilities; knowledge exposed as MCP resources.
- **CLI** - a generated `dorkos <domain> <verb>` command tree with `--json` output, hitting the local server with the per-instance token.
- **Self-description** - `dorkos capabilities` / `GET /api/capabilities` / `dorkos://capabilities` resource: the live, versioned answer to "what can I do here?". This is what makes the system reflective: the registry is queryable by the agents it governs.
- **Docs** - a generated capability-reference page feeding llms-full.txt.

This mirrors the Home Assistant hook pattern: new DorkOS features contribute a capability declaration and automatically appear on every surface. Drift becomes impossible by construction, and a conformance test ("every capability has a handler, a test, and appears in every projection") enforces it mechanically.

Pragmatic note: this does not require a big-bang rewrite. The registry can start as typed metadata wrapping existing route handlers, and projections can be adopted surface-by-surface (CLI first, then MCP generation, then OpenAPI replacement).

### Pillar 2 - Actuation: CLI-first, MCP-thin

- **The `dorkos` CLI is the universal actuation surface.** It is the only surface reachable from all three runtimes today (Codex and OpenCode cannot receive MCP injection but can all exec commands). Add the missing operator subcommands (generated from the registry): `dorkos agent list|show|create|update`, `dorkos task list|create|trigger|runs`, `dorkos activity`, `dorkos group list|create|update`, `dorkos runtime connect ...`, `dorkos version --check`, `dorkos package publish`. All support `--json`.
- **The in-session MCP server stays curated and small**, reserved for what genuinely needs session context or structure: `control_ui`/`get_ui_state`, widgets/gen-UI, `relay_notify_user`, devtools, connector tools. Marketplace tools should join the in-session server (fixing today's inversion where an external client can install packages but the user's own agent cannot) - or be reached via CLI; either way the asymmetry dies.
- **Auth:** the CLI reuses the existing per-instance local token (`mcp-local-token.ts` pattern) so an agent shelling out on the same machine authenticates transparently; remote/external callers keep the existing 4-tier MCP auth.

### Pillar 3 - Knowledge: skills + self-description + docs-on-demand

Three layers, all progressive-disclosure:

1. **A first-party "Operating DorkOS" skill pack** (the direct answer to "should we provide skills?" - yes). Marketplace package, installed by default into new agent workspaces (extend `scaffoldInstructions()` to seed it), projected to all harnesses by Harness Sync, updateable independently of releases. One umbrella skill (`operating-dorkos`: what DorkOS is, how to discover capabilities, when to use CLI vs tools) plus per-domain skills (`managing-agents`, `scheduling-tasks`, `using-the-marketplace`, `connecting-runtimes`, `publishing-packages`). Skills teach _how_; live facts always come from the registry/CLI, so skills stay evergreen.
2. **Runtime self-description** (Pillar 1's `capabilities` surface) - the agent asks the running server what it can do, versioned, always true. This replaces carrying tool docs in context and shrinks the static system-prompt blocks over time.
3. **Docs-on-demand, locally.** Serve the docs corpus (the same markdown behind llms-full.txt) from the running DorkOS server (`/api/docs-content/...` or an MCP resource) so local/offline agents don't depend on dorkos.ai. A separate docs-MCP product is unnecessary; the existing markdown routes + a search capability in the registry cover it.

The `<dorkos_context>` system-prompt block stays tiny: identity, "you are running inside DorkOS", pointer to the skill pack and `dorkos capabilities`.

### Pillar 4 - Governance: tiers, identity, audit

- **Three capability tiers**, declared per capability in the registry:
  - `observe` - reads; always allowed, still audited.
  - `act` - routine actuation (create agent, schedule task, send relay message); allowed by default, always audited.
  - `destructive` - deletes, self-modification of protected fields, marketplace publish, config resets, runtime credential changes; requires explicit approval via the generalized confirmation-token flow (the marketplace install pattern promoted to a first-class primitive), surfaced in the cockpit as an approval card.
- **Agent identity:** mint per-agent scoped tokens (agent name + tier ceiling) so ActivityService can attribute every action to the acting agent, and so a user can cap what a given agent may do. The `isSystem` rules become just one policy expressed in this model.
- **Audit:** every capability invocation (including denied attempts) emits an Activity event. Notion's bar - "every run logged, visible, reversible" - with the activity feed itself being an `observe` capability, so agents can review their own history.
- **Self-modification boundary:** `PATCH /api/agents/current` already blocks `name` and system-identity fields; personality/SOUL edits are `act`, identity edits stay impossible, deletion is `destructive`.

### Pillar 5 - The recursive loop (self-improvement)

With Pillars 1-4 in place, the Voyager pattern falls out naturally: agents author new skills into the personal marketplace (`marketplace_create_package` already exists), the "Operating DorkOS" pack accepts community/agent contributions, and the eval harness (below) scores whether skill/doc changes actually improve agents' ability to operate DorkOS. The system's users improve the system's own operating surface - the litepaper's "the system improves itself", grounded.

---

## 4. Testing strategy

Two layers, matching the two problem halves; both already have infrastructure:

1. **Deterministic (per-PR, Vitest):**
   - Per-capability handler tests (ordinary unit/integration tests).
   - A **capability conformance suite** (pattern: `runtimeConformance`): every registry entry has a working handler, appears in every projection (MCP, CLI, OpenAPI, docs), declares a tier, and emits an Activity event. Advertised-but-broken and implemented-but-undocumented both become CI failures.
2. **Agentic evals (`packages/evals`, spec `eval-harness`/DOR-357):** the harness is purpose-built for exactly this - prompt a real session, assert on API/filesystem/DB outcomes, never on prose. Its designed 14-eval matrix already _is_ "agents operating DorkOS" (agent-create, task-scheduling, marketplace install, control_ui, safety-refusal...). Plan:
   - Extend the matrix with one eval per capability domain, run on the `claude-code-cheap` tier (test-mode cannot exercise MCP tools: `supportsMcp: false`).
   - Add governance evals: destructive ops must produce an approval request, not an action (the `safety-refusal` pattern generalized).
   - **Build the `docker` isolation tier** (planned in the spec, not yet built; reuse the `smoke:docker` substrate) for evals whose scenarios are destructive or touch host-adjacent state - this is the container answer: every eval already runs in a `mkdtemp` sandbox `DORK_HOME` (never the real `~/.dork`), and the Docker tier adds full OS isolation on top for the scary ones.
   - Wire the spec's Phase-5 CI cadence (per-PR label-gated smoke, nightly full, weekly deep).
   - Fakes inside the sandbox for externally-published state (local registry fixture for publish, stubbed update endpoint for version checks) - evals never hit production services.

Evals double as the self-improvement feedback loop: when an operate-DorkOS eval fails, the fix is usually a better skill, capability description, or CLI ergonomics, not model changes.

---

## 5. Gap-closure inventory

| #   | Gap                                      | Fix                                                                                | Depends on               |
| --- | ---------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------ |
| 1   | Marketplace tools external-only          | Add to in-session server / CLI                                                     | none (quick win)         |
| 2   | No agent self-edit tool                  | `agents.update_self` capability wrapping existing PATCH                            | registry (or quick tool) |
| 3   | No activity/config/version/groups tools  | Registry capabilities + CLI verbs                                                  | registry                 |
| 4   | No CLI operator subcommands              | Generated command tree                                                             | registry                 |
| 5   | OpenAPI ~50% coverage                    | Generated from registry                                                            | registry                 |
| 6   | Codex/OpenCode: no DorkOS tools          | CLI-first actuation + operating-dorkos skill (projected by Harness Sync)           | 4, skill pack            |
| 7   | No first-party skills                    | "Operating DorkOS" pack; seed on agent creation                                    | marketplace (exists)     |
| 8   | Status bar in localStorage               | Move to `ui.*` server config (also wins cross-device sync)                         | none                     |
| 9   | Smart-group eval client-only             | Move `evaluateSmartGroup` to `@dorkos/shared`; server + CLI can compute membership | none                     |
| 10  | No publish flow                          | `dorkos package publish` + registry-side flow                                      | design needed            |
| 11  | No agent identity                        | Per-agent scoped tokens + Activity attribution                                     | governance design        |
| 12  | No approval primitive beyond marketplace | Generalize confirmation-token to all `destructive` capabilities                    | 11                       |
| 13  | Docs not locally servable                | Serve docs corpus + search from the running server                                 | none                     |
| 14  | Eval docker tier + CI unbuilt            | Finish eval-harness Phases 3-5                                                     | none                     |

---

## 6. Suggested sequencing (work backwards from the vision)

1. **Now (coherence, no new architecture):** close asymmetries #1/#2/#8/#9; ship the first "Operating DorkOS" skill pack (#7); start operate-DorkOS evals on the cheap tier against existing tools.
2. **Next (the spine):** Capability Registry + CLI generation + capabilities self-description (#3-#5, #13); conformance suite; migrate in-session/external MCP generation onto it.
3. **Then (trust):** agent identity + tiers + approval primitive + audit attribution (#11/#12); governance evals; Docker eval tier + CI cadence (#14).
4. **Then (the loop):** publish flow (#10); agent-authored skills feeding the pack; eval-gated skill/doc improvement.

Each step is independently shippable and immediately useful; none blocks on a rewrite.

---

## 7. Direct answers to the original questions

- **Skills as the knowledge vehicle?** Yes - as a marketplace-distributed, harness-projected, default-installed pack; but skills teach _procedure_, while _facts_ come live from the registry/CLI so nothing goes stale.
- **Docs MCP?** Doesn't exist today; agents get two URLs in their system prompt. Don't build a separate docs MCP product - serve the existing markdown corpus + search from the running server and expose it as a capability/resource.
- **Graph API / data store for live state?** It already exists as the HTTP API (agents, activity, tasks, mesh topology, sessions). What's missing is agent-optimized access: CLI verbs with `--json`, MCP resources, and the self-describing capabilities index. No new datastore needed.
- **CLI or API?** Both - the API is the substrate, the CLI is the universal agent-facing projection of it (and the only one that works in every runtime today), MCP is the curated structured layer for session-bound and UI capabilities.

## 8. Key prior art (internal)

ADR-0185 (two-layer knowledge), ADR-0273 (context channel), `specs/mcp-server` + `specs/external-mcp-access` (external surface), `specs/marketplace-05-agent-installer` ("the marketplace isn't for humans"), `specs/ext-platform-01/-04` (agent UI control, agent-built extensions), `specs/eval-harness` (DOR-357), `specs/harness-sync` + ADR-0301/0303, `specs/connector-gateway` (act on the user's behalf), `research/20260717_site-og-seo-ai-agents-world-class.md` (AI-readable docs state), `specs/flow-triage-feeds-loop` (self-feeding loop posture).
