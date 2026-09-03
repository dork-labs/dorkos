---
id: 260828-175910
title: One relay adapter holding a runtime map, not a subclass per runtime
status: accepted
created: 2026-08-28
spec: task-runtime-model
supersedes: '0257'
---

# One relay adapter holding a runtime map, not a subclass per runtime

## Status

Accepted. Supersedes the **Decision** section of ADR-0257; its Context and most
of its consequences still stand (see "What ADR-0257 got right" below).

## Context

ADR-0257 planned the relay's internal adapter generalization as a shared
abstract base plus **a thin subclass per runtime** (`ClaudeCodeAdapter`,
`CodexAdapter`, `TestModeAdapter`), with `adapter-manager.ts` holding a
runtime-type → **adapter** map and dispatching by the session's owning runtime.

The base landed. The subclasses never did, and the manager-level dispatch seam
landed unused. When DOR-1614 came to make a Codex or OpenCode agent actually
answer a Telegram or Slack message, the ground had moved:

- Everything under the adapter — `agent-handler.ts`, `task-handler.ts`,
  `approval-handler.ts` — already spoke only `AgentRuntimeLike` and
  `StreamEvent`. Nothing in it was Claude-shaped. The single Claude-specific
  thing left was **the one runtime the host injected**.
- A `CodexAdapter` and an `OpenCodeAdapter` would therefore have overridden
  nothing. They would have inherited every line of the same behaviour in order
  to change one constructor argument — three classes, three registrations, three
  sets of conformance runs, to express "use a different runtime object".
- The manager-level seam ADR-0257 called for (`registerAgentRuntime`,
  `resolveAgentRuntime`, `listRegisteredRuntimeTypes`) was written and then
  never called by anything. Routing had settled one layer down, in the adapter,
  because that is where a message and its subject are both in hand.

The specification for this work (`specs/task-runtime-model`, PR3) called for
the subclasses. Implementation found that call unjustified — the facts above
left a subclass with nothing to override — and this ADR is the record that
supersedes it.

## Decision

**One built-in adapter holds a runtime-type → RUNTIME map and resolves which
runtime answers per message.** There is no subclass per runtime, and the
adapter manager does not dispatch.

- `ClaudeCodeAdapter` takes `agentRuntimes` (every runtime this server
  registered) alongside the single `agentManager` that answers a message naming
  no runtime. The class name stays: `claude-code` is the id of the built-in
  entry in every install's `adapters.json`, so renaming would leave a class and
  a persisted config type disagreeing about the same thing.
- Which runtime answers is read from **what the message names** — the runtime
  segment of `relay.agent.<runtimeType>.<sessionId>`, or a task dispatch
  payload's `runtime` field — and never guessed. A message naming a runtime this
  build did not register is **refused by name**, before it takes a concurrency
  slot, rather than quietly run on another one. **Amended 2026-09-03
  (DOR-1627):** one subject shape names an AGENT and no runtime — the mesh
  endpoint `relay.agent.<namespace>.<agentId>`, which is what one agent's
  `relay_send` to another arrives on. Taking the default for it meant a Codex
  agent DM'd by another agent was answered by Claude Code. The adapter now asks
  the host, through a `resolveAgentRuntimeType` seam wired to the same
  manifest-then-default ladder rooms and chat bindings already use, so who
  answers for an agent no longer depends on which door the message came
  through. Only that shape: a session subject keeps the runtime its
  conversation started on (ADR-0255), and a named runtime still wins over a
  manifest. **Known gap, deliberately left open and pinned by a test:** nothing
  on the relay path calls `persistSessionRuntime`, so an agent-scoped subject
  has no binding to consult and its manifest is re-read every turn — change an
  agent's runtime mid-conversation and the remaining turns go to a program
  handed a session key it has no transcript for (the DOR-764 shape). Closing it
  needs a binding write made only after a turn has started, plus
  `resolveTurnRuntimeType`; threading a session key alone would be inert.
- The discriminator the subject parse uses is the union of the adapter's own
  registered keys and the built-in `RUNTIME_TYPES` list, so a runtime registered
  under a type outside that list still routes to itself, and a type the product
  knows but this build lacks is still refused rather than read as a mesh
  namespace.
- The Tasks scheduler is the one caller OUTSIDE the relay that needs to know
  what the map holds, and it asks rather than assumes. `AdapterManager` exposes
  a single narrow predicate — not the map, not its keys — and
  `task-scheduler-service.ts` takes it as
  `SchedulerDeps.relayHoldsRuntime` to decide per run whether the bus is even an
  option; `relay-dispatch.ts` then writes the resolved runtime onto the envelope
  so the adapter routes by name instead of falling back to its default. That is
  the scheduler-side half of this decision: because routing settled in the
  adapter rather than the manager, "can the relay run this?" stopped being
  answerable by a runtime-type literal and became a question only the relay can
  answer. **Amended 2026-09-02 (DOR-1636):** the predicate shipped as
  `hasAgentRuntime(runtimeType)`, which answered from the constructor-built map
  alone and so said yes for an adapter that had been disabled or had failed to
  start. It is now `canRunTaskOnBus(runtimeType, subject)`, which reads the
  registry — real liveness — and returns the reason when the answer is no. The
  decision this bullet records is unchanged: one narrow question, asked of the
  relay, per run.
- `adapter-manager.ts`'s map stays runtime-type → runtime and is **passed
  through** to the adapter. Its unused dispatch seam — `registerAgentRuntime`,
  `resolveAgentRuntime`, `listRegisteredRuntimeTypes` — is deleted as part of
  this decision, so no future author builds against a route that nothing takes.

## What ADR-0257 got right and this keeps

- The shared abstract `RuntimeAdapter` base owning queueing and the
  open/stream/close lifecycle. It still exists and the built-in adapter still
  delegates its per-session serial queue to it.
- `binding-router.ts` publishing on runtime-neutral subjects rather than
  special-casing by class name. That segment is now the thing routing reads.
- Keeping the external name `ClaudeCodeAdapter` stable.

## Consequences

### Positive

- Adding a runtime to the relay costs a map entry at the composition root, not a
  class. `apps/server/src/index.ts` fills it from
  `runtimeRegistry.listRuntimes()`, so a runtime registered anywhere is reachable
  over the relay with no relay change at all.
- One code path carries every runtime's relay behaviour, so a fix or a
  reliability change cannot land for one runtime and miss another — the failure
  mode a subclass-per-runtime shape invites.
- Fewer moving parts to keep honest: one claim set, one parse set, one refusal.

### Negative

- The class name no longer describes what the class does. Mitigated by module
  TSDoc that says so first, and by the `adapters.json` argument for keeping it —
  but a reader meeting `ClaudeCodeAdapter` cold will still be surprised.
- Per-runtime behaviour, if any is ever genuinely needed, now has nowhere
  structural to live and would arrive as branching inside shared handlers. The
  moment a second such branch appears, revisit the subclass shape ADR-0257
  described rather than growing a third.
- The subject-parse discriminator is a union rather than one list, so a mesh
  namespace equal to a registered-but-unlisted runtime type is ambiguous. Left
  open deliberately: making the namespace guard dynamic would make an agent's
  subject depend on which runtimes happened to be registered at boot, which the
  mesh namespace-stability suite exists to prevent.
