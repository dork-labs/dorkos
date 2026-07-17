---
id: 260717-180706
title: Relay flow animation broadcasts metadata-only relay_flow events at the inbound binding-routing boundary
status: accepted
created: 2026-07-17
spec: relay-flow-animation
superseded-by: null
---

# 260717-180706. Relay flow animation broadcasts metadata-only relay_flow events at the inbound binding-routing boundary

## Status

Accepted

## Context

The Agents topology renders adapter↔agent binding edges (`binding:{id}`), but they were inert — no way to see whether a message had ever crossed one. The only relay traffic already reaching `/api/events` is `relay_message`, a full `RelayEnvelope` (payload included) fired from the operator console feed (`relay.human.console.>`); it has no home edge and carries content that must never reach a topology-wide fan-out. The one server-side site that resolves a delivery to a concrete binding — `BindingRouter.handleInbound` — republishes to `relay.agent.*` through `RelayPublishPipeline.deliverAndFinalize`, which runs the DOR-260 budget gate and the DOR-277 consent gate before any adapter dispatch and returns `{ messageId, deliveredTo }`; `handleInbound` discarded that return with a bare `await`. Animating the wire honestly required a new signal — keyed by binding participants, content-free, and fired only for messages that actually reached the agent.

## Decision

We will emit a new, dedicated `relay_flow` SSE event — metadata-only (`bindingId`, `adapterId`, `agentId`, `direction`, `at`; never payload, text, subject, or `chatId`) — from `BindingRouter.handleInbound`, captured from the publish pipeline's `deliveredTo` return and fired only when `deliveredTo > 0`, i.e. only after a message has cleared both gates and actually reached the agent. The emit is wired through an injected `onFlow` callback (mirroring the existing `eventRecorder` dependency) so `BindingRouter`/`BindingSubsystem` stay unit-testable and never import the `eventFanOut` SSE singleton directly; the singleton is referenced only at the outermost composition edge, `AdapterManager.initBindingSubsystem`, via a new `broadcastRelayFlow` helper alongside the existing `broadcastBindingsChanged`/`broadcastAdaptersChanged`. We chose a dedicated event over extending `relay_message` because the console feed's audience and content shape are different — reusing it would either leak message content onto the topology fan-out or overload a feed meant for a different purpose. v1 emits `direction: 'inbound'` only (adapter→agent); the schema already accepts `'outbound'` so an agent→adapter reply pulse can be added later without a wire-format change.

## Consequences

### Positive

- No message content ever reaches the new fan-out — the routing skeleton (`bindingId`/`adapterId`/`agentId`/`direction`/`at`) is all any client can see, and every `/api/events` recipient is already a same-origin cockpit client that can enumerate bindings and adapters via the API, so nothing new is exposed
- The delivered-only gate (`deliveredTo > 0`) keeps the animation honest — a budget-rejected or consent-denied message never lights a wire it never actually crossed
- `BindingRouter`/`BindingSubsystem` remain fully unit-testable with a plain `vi.fn()` standing in for `onFlow`, with zero dependency on the `eventFanOut` singleton — the same shape as the existing `eventRecorder` dependency
- The console feed (`relay_message`, full envelope) is untouched — no risk of overloading a different-audience feed or leaking payload onto it

### Negative

- Outbound (agent→adapter reply) pulses are deferred: the reply publishes to a `relay.inbox.*` reply inbox (`packages/relay/src/adapters/claude-code/publish.ts:44-52,141`, `agent-handler.ts:203,316`), not back through `BindingRouter` (`handleInbound` explicitly skips `from.startsWith('agent:')`, `binding-router.ts:244`), so there is no single server-side site today that resolves an outbound reply to `{bindingId, adapterId, agentId}` without a reverse-binding lookup — a real, user-visible gap (inbound traffic pulses, replies do not)
- Agent↔agent flow is not visualized: no such edge renders in the topology today (only `binding:{id}` adapter↔agent edges exist, per `build-topology-elements.ts:199-213`); surfacing it needs a new edge type plus a new `relay.agent.*` broadcast
- A second SSE event type (alongside `relay_message`, `relay_bindings_changed`, `relay_adapters_changed`) adds a small amount of ongoing surface area to the `/api/events` contract and the client's `GENERIC_EVENTS` registry that future changes must keep in sync

## Follow-ups for DONE

Recorded here as pointers for the DONE stage to file as tracker issues (DECOMPOSE/EXECUTE do not write to the tracker):

1. **Outbound (agent→adapter reply) pulses.** Needs a binding-aware site for outbound replies — likely a reverse-binding lookup keyed off the reply's session/adapter — since the reply path bypasses `BindingRouter` entirely today.
2. **Agent↔agent flow.** Needs a new topology edge type plus a `relay.agent.*` broadcast; no such edge exists to animate yet.

## Related

- **DOR-260** — made the per-message envelope budget (`RelayBudget`) authoritative and enforced at `deliverAndFinalize()`. This decision's delivered-only gate rides directly on that: a budget-rejected message never increments `deliveredTo`, so it never pulses.
- **DOR-277** — the agent→human initiate-consent gate at the same boundary; a consent-denied message likewise never pulses.
- **ADR-0310** — the `/api/events` fan-out this event joins, alongside `relay_message` and `relay_bindings_changed`.
