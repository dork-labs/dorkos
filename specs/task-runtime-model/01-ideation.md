---
slug: task-runtime-model
id: 260828-002928
created: 2026-08-28
status: ideation
---

# Per-task runtime, model, and effort for scheduled tasks

**Tracker:** DOR-1615 (this programme), DOR-1347 (folded in), DOR-1614 (relay leg, separate PR).
**Author:** Claude (orchestrator), decisions settled with Dorian 2026-08-27/28.

## 1) Problem

A scheduled task always runs on claude-code with the SDK's default model. The
scheduler's runtime is a single object captured at boot
(`apps/server/src/index.ts`, `schedulerAgentManager`), never the registry, and
the `SchedulerAgentManager` port strips `model`/`effort` out of the options it
forwards. Two constants assert the assumption and name the fix in their own
comments ("read it from the task"): `apps/server/src/services/tasks/scheduled-run-power.ts:61`
and `apps/client/src/layers/features/tasks/ui/TaskFormInner.tsx:48`.

Meanwhile every other execution surface — interactive sessions, rooms (DMs
included), relay agent turns — resolves runtime per agent and model through the
`resolveUnattendedSessionDefaults` ladder. Scheduled tasks are the only surface
not plugged in. DOR-1347 tracks the model half of that gap.

## 2) Settled decisions (do not re-derive)

1. **Fields live inside the `schedule:` block** of the task's SKILL.md
   (`runtime:`, `model:`, `effort:`), NOT the top-level Claude-Code-dialect
   `model:` frontmatter — a codex/opencode model id in the top-level field would
   be read by Claude Code when the skill is invoked interactively.
2. **Top-level `model:` is honored as a fallback tier** when (and only when)
   the resolved runtime is claude-code. Author intent ("this skill runs on
   haiku") applies to scheduled fires too.
3. **Model is one string in the resolved runtime's id space** (claude aliases /
   full IDs, `gpt-5.5`, `provider/model`) — same semantics as the agent
   manifest's `model` field: deliberately unvalidated at write, warn chip in
   UI, runtime errors at run time.
4. **Resolution ladder at fire time** (first hit wins):
   runtime: `schedule.runtime` → target agent's manifest `runtime` (if
   registered) → registry default.
   model/effort: `schedule.model`/`schedule.effort` → skill top-level
   `model:`/`effort:` (claude-code only) → agent manifest (model only when the
   agent's runtime matches the resolved runtime; effort survives mismatch,
   dropped only where unsupported) → `runtimes.<section>.defaultModel`/
   `.defaultEffort` → runtime default. Reuse
   `resolveUnattendedSessionDefaults`, do not build a parallel ladder.
5. **`effort` ships now** — every seam already carries `{model, effort}`
   together; leaving it out reopens ~17 files later.
6. **Scheduler takes the runtime registry**; the boot-bound
   `schedulerAgentManager` and both `TASK_RUNTIME` constants go away.
7. **v1 dispatch routing:** tasks resolving to claude-code keep the relay path
   (envelope gains model/effort); codex/opencode tasks dispatch DIRECT until
   DOR-1614 lands relay adapters for them.
8. **Sticky × runtime change:** a sticky task whose resolved runtime differs
   from the previous run's session runtime starts a FRESH session (sessions are
   runtime-bound first-write-wins, ADR-0255).
9. **Runtime disabled/unregistered at fire time:** fail the run loudly with a
   clear error. Never silently fall back to another runtime.
10. **MCP `tasks_create`/`tasks_update` and the CLI may set runtime/model/effort**
    — agents can already set the far-more-powerful `prompt`, and agent-proposed
    tasks pass the approval gate. `permissionMode` and `status` stay refused.
11. **UI:** runtime + model selects in the task form defaulting to "Agent's
    runtime" / "Agent default", fed by `GET /api/models?runtime=`; the Trust
    dial's capability profile follows the selected runtime; task rows show an
    override chip only when set; run records stamp the RESOLVED runtime+model
    and history shows them.
12. **Marketplace shape schedule declarations do NOT gain runtime/model in v1**
    (deferred; flag in docs as not-yet).

## 3) Relay leg (DOR-1614, separate PR)

Groundwork shipped in ADR-0257 / spec `codex-runtime-adapter-prework`: abstract
`RuntimeAdapter` base, adapter-manager takes a runtime map, per-session routing
via `runtimeRegistry.getSessionRuntimeType` with `AdapterNotRegisteredError`.
The map only ever gets one entry (`apps/server/src/index.ts` — single-entry
map). Scope: Codex + OpenCode adapter subclasses, register all enabled runtimes
into the map, chat-originated sessions honor the target agent's manifest
runtime (`resolveSessionCreatorRuntime` gets the "real rule" its comment asks
for), relay task dispatch per runtime, turn-execution-settings keyed by the
resolved runtime. Rooms/DMs are already multi-runtime
(`room-turn-runner.ts:869`) — out of scope.

## 4) Delivery

Three PRs, each from its own worktree, each adversarially reviewed per
REVIEW.md before opening: PR1 server core (DOR-1615 + DOR-1347), PR2 client UI

- docs + operating skill (after PR1 merges), PR3 relay multi-runtime
  (DOR-1614, parallel with PR1).
