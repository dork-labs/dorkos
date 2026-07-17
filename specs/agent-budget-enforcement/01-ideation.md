---
slug: agent-budget-enforcement
id: 260717-153826
created: 2026-07-17
status: ideation
linearIssue: DOR-265
---

# Enforce or remove the per-agent hourly turn cap (`AgentManifest.budget.maxCallsPerHour`)

**Slug:** agent-budget-enforcement
**Author:** Cook (IDEATE stage, /flow drain)
**Date:** 2026-07-17
**Tracker:** DOR-265 · type task→design · size 5 · Medium · split out of DOR-260

---

## 1) Intent & Assumptions

- **Task brief (from DOR-265):** `AgentManifest.budget` ships two fields —
  `maxHopsPerMessage: 5` and `maxCallsPerHour: 100` — that are persisted,
  surfaced in the API, editable in the UI, and enforce **nothing**. The DOR-260
  work made the per-**message** envelope budget genuinely enforced; the
  per-**agent** budget stayed advisory. The DOR-259 smoke on this drain flagged
  the honesty gap: manifests ship defaults that gate nothing. The recorded fork:
  **ENFORCE it properly** (the issue's turn-start-row design) **OR honestly
  REMOVE it** as dead metadata.

- **The decision this ideation resolves:** enforce (a) vs. remove (b) vs. a
  staged hybrid (c). This ideation verified every claim in the issue against the
  code and **recommends (b) REMOVE**, with one bounded fork left for the operator
  (the `maxHopsPerMessage` sibling — §6 Open Q A).

- **What "the per-message envelope budget IS enforced" means (verified):**
  `RelayPublishPipeline.deliverAndFinalize()` runs one authoritative
  `enforceBudget(envelope, subject)` gate BEFORE any delivery path — Maildir
  copy, adapter dispatch (the live paid turn), and subscriber fan-out
  (`packages/relay/src/relay-publish.ts:297-314`). An over-budget message is
  dead-lettered and nothing downstream runs (DOR-260). This envelope budget
  (`RelayBudget`: `maxHops` / `callBudgetRemaining` / TTL / cycle detection) is a
  **different object** from `AgentBudget` and is the subject of this whole
  distinction.

- **Assumptions carried in:**
  - Multi-agent Mesh+Relay is **not launch-critical** (AGENTS.md demo-claim gate
    holds it as a Script-3 story, "shipped but unverified end-to-end"). Nothing
    here blocks launch either way.
  - The AGENTS.md quality bar is binding: "Be honest by design: no dark
    patterns"; "Every element justifies its existence — if removing it wouldn't
    hurt the user, remove it"; "no dead code, no tolerated legacy patterns — when
    something is superseded, remove it." An editable "safety limit" that throttles
    nothing is precisely the thing that bar forbids.
  - The three launch runtimes are claude-code, codex, opencode — but see §3/§5
    for the honest reality that **only claude-code has a relay agent-turn adapter
    today**.

- **Out of scope:**
  - The per-message envelope budget (`RelayBudget`) — it is enforced and correct;
    this issue does not touch it.
  - The per-sender relay rate limiter (`checkRateLimit` +
    `SqliteIndex.countSenderInWindow`, `relay-publish.ts:201-220`) — a distinct,
    working sliding-window throttle keyed on the **sender** identity, unrelated to
    the per-agent manifest cap.
  - Building the codex/opencode relay adapters (they do not exist; that is its own
    future work).

## 2) Pre-reading Log

- `AGENTS.md` — honest-by-design bar; no-dead-code rule; demo-claim gate (Mesh+Relay
  is a not-yet-verified Script-3 surface); "describe what happens for the user."
- `.claude/skills/flow__ideating-features/SKILL.md` + `templates/docs/ideation.md`
  — the IDEATE scaffold this doc follows.
- `packages/shared/src/mesh-schemas.ts:69-92` — `AgentBudgetSchema`
  (`maxHopsPerMessage` default 5, `maxCallsPerHour` default 100) **with an explicit
  TSDoc note**: "these fields are **not currently enforced at runtime**… the former
  `BudgetMapper` and its `rate_limit_buckets` table were removed as dead code…
  Treat them as advisory metadata until runtime enforcement is wired back in —
  DOR-265 tracks that work." `AgentManifestSchema` (`:163`) defaults `budget`;
  `UpdateAgentRequestSchema` (`:334-357`) picks `budget` → editable via PATCH.
- `packages/relay/src/relay-publish.ts` — the DOR-260 authoritative budget gate
  (`:297-314`), the `rejectAtGate` dead-letter + reply-settle path (`:417-446`),
  and the per-sender rate limiter (`:201-220`). The envelope `maxHops` /
  `callBudgetRemaining` come from **relay config** (`this.opts`, `:224-229`),
  never from an agent's manifest budget.
- `packages/relay/src/adapters/claude-code/agent-handler.ts` — where a **paid
  turn actually starts**: `deps.agentManager.sendMessage(...)` at `:204`, AFTER
  the `STREAM_EVENT_TYPES` skip check (`:50-65`, `:179-185`) returns success
  without a turn for reply/stream traffic (`text_delta`, `tool_call_*`,
  `tool_result`, `done`, …). Confirms: counting raw publishes to `relay.agent.*`
  would burn the cap on reply traffic; the "this is a paid turn" signal exists
  only here, inside the adapter, after the skip.
- `apps/server/src/services/relay/adapter-manager.ts:543-559` — `buildContext`
  sets `agent.directory` + `agent.runtime` **only**; it never populates
  `agent.manifest`. Confirms claim (2).
- `packages/relay/src/types.ts:587-596` — `AdapterContext.agent.manifest?:
Record<string, unknown>` is **typed but optional and never written** by any
  producer.
- `packages/relay/src/sqlite-index.ts:257-264` — `countSenderInWindow(sender,
windowStartIso)` counts indexed **published messages per sender**, not turns
  per **target** agent. No turn-count store exists. Confirms claim (3).
- `packages/relay/src/adapters/claude-code/claude-code-adapter.ts` — the **only**
  runtime relay adapter that dispatches agent turns; constructed with a single
  `deps.agentManager` (`:158-170`), routes `relay.agent.>` (runtime-scoped
  `relay.agent.claude-code.` + legacy `relay.agent.`) and `relay.system.tasks.>`.
- `apps/server/src/services/relay/adapter-factory.ts:90-97` — the `claude-code`
  branch resolves `deps.agentRuntimes.get('claude-code')` and builds a
  `ClaudeCodeAdapter`. **No `codex` or `opencode` case exists.**
- `apps/server/src/index.ts:723-734` — the sole `new AdapterManager(...)` in
  production is given **one** runtime: `agentManager:
runtimeRegistry.getDefault()` (claude-code, or TestModeRuntime in e2e). No
  `agentRuntimes` map with codex/opencode; `registerAgentRuntime('codex'|…)` is
  never called in composition.
- `packages/db/src/schema/mesh.ts:23-25` — the `agents` table has a
  `budgetJson` column defaulting to `'{"maxHopsPerMessage":5,"maxCallsPerHour":100}'`.
- `docs/concepts/mesh.mdx:125` — already documents budget as **"Advisory only,
  not enforced at runtime today."** (Honest today; a removal must delete this row,
  not just the code.)
- `specs/fleet-context-health/01-ideation.md` — house-style reference for this drain.

## 3) Codebase Map

**Primary components/modules:**

- **The schema (source of the advisory contract):**
  `packages/shared/src/mesh-schemas.ts` — `AgentBudgetSchema` (both fields + the
  advisory note), its use in `AgentManifestSchema.budget` and
  `UpdateAgentRequestSchema` (making it editable via `PATCH /api/mesh/agents/:id`).
- **Persistence:** `packages/db/src/schema/mesh.ts` (`budgetJson` column +
  default); `packages/mesh/src/{mesh-discovery.ts,agent-registry.ts,reconciler.ts}`
  (serialize/deserialize the manifest, seed the default).
- **Server seed sites (write the default, read it nowhere for enforcement):**
  `apps/server/src/routes/agents.ts:135`, `routes/test-control.ts:81`,
  `services/mesh/ensure-dorkbot.ts:68`, `services/core/agent-creator.ts:264`;
  `packages/test-utils/src/mock-factories.ts:114`.
- **Client UI (surfaces the dead knob to the user):**
  - `apps/client/src/layers/features/agent-settings/ui/ToolsTab.tsx:210,283-394`
    — a collapsible **"safety limits (budget)"** section with **editable number
    inputs** for both `maxHopsPerMessage` and `maxCallsPerHour` ("{hops} hops ·
    {calls} calls/hr"). This is the sharpest honesty violation: it reads as an
    enforced control and gates nothing.
  - `apps/client/src/layers/features/mesh/ui/AgentNode.tsx:202`,
    `TopologyPanel.tsx:54-55`, `lib/build-topology-elements.ts:169-170` — display
    "{maxCallsPerHour} calls/hr · {maxHopsPerMessage} max hops" on the topology.
  - Dev showcases: `dev/showcases/{topology-agent-node.tsx,settings-mock-data.ts}`.
- **Docs:** `docs/guides/agents.mdx:63`, `docs/guides/agent-discovery.mdx:164,197`,
  `docs/concepts/mesh.mdx:125` (already "advisory only"), `docs/api/openapi.json`
  (generated — regen, don't hand-edit).
- **The paid-turn signal (relevant only for option a):**
  `packages/relay/src/adapters/claude-code/agent-handler.ts:179-204` — after the
  `STREAM_EVENT_TYPES` skip, right before `agentManager.sendMessage`.

**Shared dependencies:** `AgentManifest` / `AgentBudget` are `@dorkos/shared`
types crossing the `Transport` boundary (Http + Direct) and the OpenAPI schema;
any schema change fans out to every adapter's manifest projection, the DB column,
`FakeAgentRuntime`/mock factories, the client editors, and `docs/api/openapi.json`.

**Data flow (the disconnect, verified):**

1. A manifest carries `budget.maxCallsPerHour` → persisted in `budgetJson` →
   surfaced via `GET /api/mesh/agents` → **displayed and edited** in the client.
2. A turn to an agent is a `relay.agent.*` publish → envelope built with a
   `RelayBudget` from **relay config** (`opts.maxHops` / `defaultCallBudget`),
   **never** the agent's `AgentBudget` → the DOR-260 gate enforces the _envelope_
   budget → the claude-code adapter starts the turn.
3. **Nowhere** does `AgentBudget.maxCallsPerHour` (or `maxHopsPerMessage`) feed
   step 2. The two fields are write-only metadata. There is no turn-count store,
   no manifest on `AdapterContext`, and no per-target-agent counter.

**Feature flags/config:** none. Defaults are hardcoded constants (5 / 100).

**Potential blast radius:**

- **Removal (b):** schema field delete → DB migration (drop/retire `budgetJson`)
  → ~5 server seed sites → 3-4 client UI surfaces (incl. the editable ToolsTab
  inputs) → 3 docs references → openapi regen. Purely subtractive.
- **Enforcement (a):** new turn-count store (Drizzle table + migration, i.e.
  re-instating what was deleted) → `buildContext` manifest plumbing (+ a
  `meshCore.getAgent`) → a new in-adapter rejection path with reply-settling → a
  window config knob → conformance/tests → UI/telemetry for "capped." Additive
  and cross-cutting.

## 4) Root Cause Analysis

Not a bug — a design/honesty fork. The "root cause" of the advisory gap is
historical: `BudgetMapper` + the `rate_limit_buckets` table once enforced
`maxCallsPerHour`, were removed as dead code (only a **stale build artifact**,
`packages/mesh/dist/budget-mapper.d.ts`, still mentions them — no
`packages/mesh/src/budget-mapper.ts` exists), and the manifest fields were left
behind. DOR-260 then made the _envelope_ budget authoritative but deliberately
did not resurrect the _per-agent_ one — hence this split-out issue.

## 5) Research

### 5.1 Verified reality of each DOR-265 claim

| #   | Issue claim                                                                                                                                                                 | Verdict                         | Evidence                                                                                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —   | Per-message envelope budget is enforced at `deliverAndFinalize()`                                                                                                           | **TRUE**                        | `relay-publish.ts:297-314` — one `enforceBudget` gate before all delivery (DOR-260).                                                                                                                                                                                                                                            |
| —   | `maxCallsPerHour` + `maxHopsPerMessage` remain ADVISORY; schema carries a not-enforced note                                                                                 | **TRUE**                        | `mesh-schemas.ts:69-92`. Both fields; neither enforced.                                                                                                                                                                                                                                                                         |
| —   | Former `BudgetMapper` + `rate_limit_buckets` were removed as dead code                                                                                                      | **TRUE**                        | No `src/budget-mapper.ts`; no `rate_limit_buckets` in `packages/db/src`; only a **stale `dist/.d.ts`** residue remains (worth deleting during either option).                                                                                                                                                                   |
| 1   | Relay can't distinguish a paid turn from reply traffic; a turn streams 10-20 `StreamEvent`s the CCA skips; the "paid turn" signal is only inside the adapter after the skip | **TRUE**                        | `STREAM_EVENT_TYPES` (`agent-handler.ts:50-65`, skip at `:179-185`); real turn at `sendMessage` `:204`. Counting raw publishes would burn the cap on replies.                                                                                                                                                                   |
| 2   | `AdapterContext.agent.manifest` is typed but NEVER populated                                                                                                                | **TRUE**                        | Type `packages/relay/src/types.ts:595`; `buildContext` sets only `directory`+`runtime` (`adapter-manager.ts:553-558`).                                                                                                                                                                                                          |
| 3   | No turn-count store; `countSenderInWindow` counts published messages per sender, not turns per target agent                                                                 | **TRUE**                        | `sqlite-index.ts:257-264` — per-**sender**, per published message.                                                                                                                                                                                                                                                              |
| ★   | Proposed design should be "shared across claude/codex/opencode adapters"                                                                                                    | **MISLEADING — key correction** | **Only the claude-code relay adapter exists.** `adapter-factory.ts:90-97` has no codex/opencode case; `index.ts:727` gives `AdapterManager` a single `agentManager` (the default runtime); no `CodexAdapter`/`OpenCodeAdapter` class exists anywhere. codex/opencode agents **do not receive relay agent-turn dispatch today.** |

### 5.2 The honest per-runtime reality (this reshapes the whole cost)

The issue frames enforcement as spanning three adapters. It does not. Today:

|                                                     | claude-code                                  | codex                                                                | opencode |
| --------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- | -------- |
| **Relay agent-turn adapter exists?**                | **Yes** (`ClaudeCodeAdapter`, the only one). | **No**                                                               | **No**   |
| **Registered into `AdapterManager.agentRuntimes`?** | Yes, as the single default `agentManager`.   | No (`registerAgentRuntime('codex')` is never called in composition). | No       |
| **Receives paid relay turns today?**                | Yes.                                         | No.                                                                  | No.      |

The runtime-scoped subject shape (`relay.agent.<runtimeType>.<sessionId>`), the
`AdapterContext.agent.runtime` field, and the `RuntimeAdapter` base class (whose
docstring names codex "as an example") are forward-looking **scaffolding** for a
multi-adapter future that is not wired. So enforcement's "multi-adapter reach" is
**a future concern, not a present cost** — but it is also the reason enforcement
built today would be enforcement for a code path (codex/opencode over relay) that
does not yet execute.

### 5.3 A field asymmetry the issue conflates

The two fields are **not equally cheap to enforce**:

- **`maxCallsPerHour`** has **no cheap enforcement path.** It needs (i) a new
  per-target-agent turn-count store (a sliding window over turns, i.e.
  re-instating the deleted `rate_limit_buckets`), (ii) the paid-turn signal from
  inside the adapter (after the skip), and (iii) manifest plumbing onto
  `AdapterContext`. This is the substance of the issue's design.
- **`maxHopsPerMessage`** has an **already-enforced sibling**: the envelope
  `RelayBudget.maxHops` gate. Today the envelope's `maxHops` comes from relay
  config (`opts.maxHops`), not the target agent's manifest. Wiring the target
  agent's `maxHopsPerMessage` into the envelope's `maxHops` at publish time would
  be a genuinely small enforcement that reuses the existing DOR-260 gate — no new
  store. (Still needs the manifest available at publish time, which the relay
  currently lacks for the target.)

So "remove both because both are dead" is defensible, but there is a real,
narrow fork on `maxHopsPerMessage` (remove vs. cheaply wire) that the operator
should decide — §6 Open Q A.

### 5.4 Solution options

1. **ENFORCE — the issue's turn-start-row design.** Record a turn-start row per
   paid turn in the agent-handler right before `sendMessage` (after the skip);
   plumb the target manifest onto `AdapterContext` via `buildContext`; a
   sliding-window count over the last hour gates the turn; a cap-hit dead-letters
   / 429-rejects and settles the reply-waiter.
   **Cost (real, verified):** new Drizzle table + migration (re-instating the
   deleted store); a `meshCore.getAgent(agentId) → manifest` and `buildContext`
   change to populate `agent.manifest`; a sliding-window query keyed on target
   agentId; a **new rejection semantics** distinct from the pre-delivery gate (the
   message already passed the envelope gate, so the refusal happens _inside_ the
   adapter — it returns a failing `DeliveryResult` and the `finally` block's
   error+done events settle `relay_send_and_wait`/A2A callers; it can NOT reuse
   `rejectAtGate`, which runs pre-delivery); a window/limit config knob; tests
   (the runtime conformance suite plus a relay integration proving replies don't
   burn the cap); and honest UI/telemetry for the "capped" state.
   **Pros:** the field becomes truthful; a second, coarser runaway-safety net
   above the per-message budget. **Cons:** medium-large for a size-5;
   re-introduces exactly the store deleted as dead code; builds enforcement for a
   non-launch-critical, single-adapter-today surface whose end-to-end coordination
   is itself unverified; the "shared across three adapters" reach is speculative.
2. **REMOVE — delete the advisory metadata honestly.** Drop
   `AgentBudgetSchema` (both fields) → `AgentManifest.budget`; retire the
   `budgetJson` column (Drizzle migration); remove the ~5 server seed sites; delete
   the ToolsTab editable inputs and the topology "calls/hr · max hops" displays;
   delete the docs rows (incl. the already-"advisory only" mesh.mdx line);
   regen openapi; delete the stale `dist` residue.
   **Pros:** honest by design (removes an editable control that gates nothing);
   smaller and purely subtractive; satisfies the no-dead-code rule; reversible —
   the door stays open to reintroduce the cap **with** enforcement (and the
   correct in-adapter signal) when Mesh becomes launch-critical and the
   multi-runtime adapters actually exist. **Cons:** loses the _intent_ signal (an
   operator can no longer even _declare_ a desired cap) until it's rebuilt; a DB
   migration touches the agents table.
3. **Staged hybrid.** E.g. remove the UI knob now (stop the dishonesty) but keep
   the schema field as documented advisory metadata; or ship `maxHopsPerMessage`
   enforcement (cheap) while removing `maxCallsPerHour`.
   **Pros:** stops the sharpest dishonesty fast. **Cons:** the "keep the field as
   documented dead metadata" variant leaves **tolerated dead code** — exactly what
   AGENTS.md forbids ("no tolerated legacy patterns… when something is superseded,
   remove it"). A hybrid that _keeps a dead field_ is worse than either clean pole.

**Recommendation: Option 2 (REMOVE), removing `maxCallsPerHour` with conviction
and — by default — `maxHopsPerMessage` with it, leaving the hop-field's
"remove vs. cheaply wire" as the one operator fork (Open Q A).** Enforcement
(option 1) is speculative work for a non-launch-critical, single-adapter surface:
it resurrects a store that was deliberately deleted, to gate a cap no one has hit,
on a coordination path (codex/opencode over relay) that does not execute yet,
while the per-message envelope budget already provides the enforced runaway
protection. Removing the editable "safety limit" that throttles nothing is the
honest, minimal, reversible move that the quality bar actually asks for.

## 6) Decisions

Resolved during ideation (brief + verified codebase reality). The one genuine
fork left for the human is in Open Questions.

| #   | Decision                                                    | Choice                                                                                                                                                                                                                                                                                                  | Rationale                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Enforce vs. remove `maxCallsPerHour`                        | **REMOVE**                                                                                                                                                                                                                                                                                              | No cheap enforcement path (needs a resurrected turn-count store); not launch-critical; the per-message envelope budget already enforces runaway protection; an editable knob that gates nothing violates honest-by-design + no-dead-code. |
| 2   | Reject the "keep it as documented advisory metadata" hybrid | Yes, reject                                                                                                                                                                                                                                                                                             | AGENTS.md forbids tolerated dead code; a field that enforces nothing but stays "documented" is the worst of both — dishonest _and_ undead.                                                                                                |
| 3   | Scope of removal                                            | The full `AgentBudgetSchema` object, its `AgentManifest.budget` use, the `UpdateAgentRequest` pick, the `budgetJson` DB column (migration), all seed sites, all client UI (ToolsTab editors + topology displays + showcases), docs rows, openapi regen, and the stale `dist/budget-mapper.d.ts` residue | A clean, complete subtraction — no half-migrations.                                                                                                                                                                                       |
| 4   | Reintroduction path                                         | Leave a short note (ADR + a follow-up "enforce per-agent turn cap **with** the store" issue) referencing this ideation's verified cost analysis and the correct in-adapter turn-start signal                                                                                                            | Keeps the door open without carrying dead metadata; when Mesh is launch-critical and codex/opencode relay adapters exist, enforcement is a deliberate, scoped build.                                                                      |
| 5   | Relationship to the enforced budgets                        | Untouched                                                                                                                                                                                                                                                                                               | The `RelayBudget` envelope gate (DOR-260) and the per-sender rate limiter are separate, working systems; removal must not perturb them.                                                                                                   |

## Open Questions (need the human operator — bounded, decision-ready)

- **A. `maxHopsPerMessage`: remove-with, or cheaply wire?** `maxCallsPerHour` is
  a clear remove. Its sibling has an **already-enforced** target
  (`RelayBudget.maxHops`, the DOR-260 gate), so a target agent's
  `maxHopsPerMessage` _could_ be wired into the envelope's `maxHops` at publish
  time as a genuinely small enforcement (no new store; the gate exists). Two
  honest paths: **(a) remove both** — symmetric, minimal, the recommended default
  (the per-agent hop cap is redundant with the relay-config hop default and no one
  relies on it); or **(b) remove `maxCallsPerHour`, and instead wire
  `maxHopsPerMessage` into the enforced envelope `maxHops`** — turns one dead
  field truthful for cheap, but still needs the target manifest available at
  publish time (a smaller version of option-1 plumbing) and keeps a `budget`
  concept in the schema. **Recommendation leans (a)** for a clean, complete
  removal; **(b)** only if a per-agent hop cap is a control the operator actually
  wants to keep. **Which?**

- **B. DB column: drop, or retain-and-ignore?** Removing `budgetJson` is a proper
  Drizzle migration on the `agents` table (source of truth is the on-disk
  `agent.json`; the column is the derived cache). Straightforward, but if the
  operator prefers minimal schema churn we could stop reading/writing it and drop
  the column in a later sweep. **Recommendation: drop it now** (no-dead-code
  applies to the schema too, and a live-but-ignored column is its own small lie).
  Flag only because a migration is the one non-trivial, non-reversible step.

## Risks

- **"It looks like a one-liner" (removal direction).** Removal is subtractive but
  fans out across schema → DB migration → 5 server sites → 4 client surfaces →
  docs → openapi. SPECIFY must enumerate all of them (§3) so nothing is
  half-removed (a lingering seed default or a stale UI input would reintroduce the
  dishonesty).
- **Editable-UI regression surface.** The ToolsTab "safety limits" section is a
  live form; deleting its two inputs must not break the surrounding budget-panel
  layout or the `PATCH` payload shape (`UpdateAgentRequest` loses `budget`).
- **Latent codex/opencode routing subtlety (informational).** The
  `ClaudeCodeAdapter`'s legacy `relay.agent.` prefix would _match_ a
  `relay.agent.codex.<id>` subject and dispatch it to the claude-code runtime.
  This is pre-existing and out of scope, but it underscores why "just add codex/
  opencode adapters and share the cap" is not free — it is a separate,
  careful build. Do not let SPECIFY treat multi-adapter enforcement as near.
- **Reintroduction temptation.** If a future operator wants the cap back, the
  enforcement must be built with the _correct_ in-adapter turn-start signal (after
  the `STREAM_EVENT_TYPES` skip), not a naive publish-count at the relay gate — or
  it will burn the cap on reply traffic. Capture this in the follow-up note so the
  lesson isn't relearned.

## Recommended direction & next step

**Recommendation: (b) REMOVE.** Delete `maxCallsPerHour` (and, by default,
`maxHopsPerMessage`) as honest dead-metadata removal, leaving a documented path to
reintroduce a per-agent cap **with** enforcement later. The enforcement design the
issue proposes is real and correctly analyzed — but it resurrects a deliberately
deleted store to gate a cap nobody has hit, on a not-launch-critical, single-
adapter (claude-code-only) surface whose coordination is itself unverified, while
the per-message envelope budget already provides enforced runaway protection.
Removing an editable "safety limit" that throttles nothing is the move the
honest-by-design and no-dead-code bars actually require.

**Next step: move-to-specify.** The direction is clear and the substrate is fully
mapped, but SPECIFY must (1) resolve Open Q A (`maxHopsPerMessage`: remove-both vs.
cheaply-wire) and Open Q B (drop the DB column now) with the operator; (2)
enumerate the complete removal set from §3 (schema, DB migration, seed sites,
client UI, docs, openapi regen, stale `dist` residue); (3) pin the
`UpdateAgentRequest`/OpenAPI shape change and its client consumers; and (4) draft
the reintroduction note. Draft ADR candidate: **"Remove the advisory per-agent
budget; the enforced runaway protection is the per-message envelope budget"** —
records the honesty decision, the verified single-adapter reality, and the correct
in-adapter turn-start signal for any future enforcement. This is past
"stay-in-ideation" and more than "adapt-directly": it carries two bounded operator
forks and a non-reversible DB migration that a frozen spec should own.
