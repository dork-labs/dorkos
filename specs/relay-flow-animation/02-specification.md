---
slug: relay-flow-animation
id: 260717-170853
created: 2026-07-17
status: specified
linearIssue: DOR-167
---

# Animate live relay message flow along topology binding edges

**Status:** Draft (frozen for DECOMPOSE)
**Author:** Fourier (SPECIFY stage, /flow drain)
**Date:** 2026-07-17
**Tracker:** DOR-167 · type task→feature · size 5 · Low

## Overview

The Agents topology renders a static wiring diagram: adapter nodes (Telegram,
Slack) on the left, agent nodes on the right, and `binding:{id}` edges between
them. Today those edges are inert — you cannot see whether any traffic is
actually flowing across a wire. This spec adds a live pulse: when a human
message is delivered across a binding to an agent, a single small dot travels
that edge from adapter to agent, then fades. It is the most on-brand expression
of "coordination, visualized" — the wiring diagram becomes a live view of your
fleet receiving work.

The ideation (`01-ideation.md`) verified the ticket's two mechanical premises
against the installed code and **reframed the work**: (1) the data the ticket
assumed is already on the wire is **not** — the global SSE stream carries only
`relay.human.console.>` (the operator console), never the adapter↔agent traffic
the binding edges represent; and (2) the motion@12.42 `path`/`arc()` primitive
the ticket cites **cannot** trace an SVG path string (verified in the installed
`motion-dom@12.42.0` d.ts). So DOR-167 is **not** a client-only motion polish
task. The animation is the low-risk 20%; the enabling server broadcast — a new
metadata-only `relay_flow` event emitted at the delivery boundary — is the real
80%.

This spec freezes that full-stack shape: a new `RelayFlowEventSchema` in
`@dorkos/shared` (metadata-only, no message content), an emit at the **inbound
binding-routing boundary** in `BindingRouter.handleInbound` (only for messages
that actually reach the agent — `deliveredTo > 0`, past the DOR-260 budget +
DOR-277 consent gates), a broadcast onto the existing `/api/events` stream, a
short-lived per-edge activity store in the mesh feature, and a single
`--color-primary` dot rendered inside `BindingEdge` tracing its exact
`edgePath`, coalesced per edge, LOD- and reduced-motion-gated.

## Background / Problem Statement

Verified against the codebase (2026-07-17):

- **What renders as an edge vs. what the stream carries — the crux.** Binding
  edges are built in
  `apps/client/src/layers/features/mesh/lib/build-topology-elements.ts:199-213`:
  `id = \`binding:${binding.id}\``, `source = \`adapter:${binding.adapterId}\``,
`target = binding.agentId`. The only other edges are cross-namespace
allow/deny (group→group, `:217-236`). **There are no agent↔agent edges.** The
global stream, meanwhile, is wired in `apps/server/src/index.ts:944-957`:
`relayCore.subscribe('relay.human.console.>', … broadcast('relay_message'))`— the operator console feed only. A`relay.human.console.>`envelope has no
home edge (there is no "console" node), so the ticket's "map an incoming`relay_message` → its binding edge" cannot be done: today's broadcast traffic
  does not correspond to any rendered edge.

- **The client throws the envelope away.**
  `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts:20-30`
  subscribes to `relay_message`/`relay_signal` and only
  `invalidateQueries(['relay','conversations'])`. The envelope is never
  inspected. This is not the hook to extend for the topology (see Detailed
  Design — FSD makes the mesh store unreachable from this entity-layer hook).

- **The delivery boundary that DOES know the binding.**
  `apps/server/src/services/relay/binding-router.ts:238-324`
  (`BindingRouter.handleInbound`) is the one server-side site where a delivery
  is resolved to a concrete binding. It subscribes to inbound `relay.human.*`
  messages, parses `{ adapterId, chatId, channelType }`
  (`human-subject.ts:36-63`), resolves `binding = bindingStore.resolve(...)`
  (`:254`), and republishes to `relay.agent.<runtimeType>.<sessionId>` (`:308`).
  At `:308` **all three join keys are in scope**: `binding.id`,
  `binding.adapterId`, `binding.agentId`. This sidesteps every identity hazard
  the ideation flagged — no `relay.agent.*` subject parsing, no sessionId↔agentId
  bridge, no dependence on the DOR-335 `relayAdapters` mislabel.

- **"Delivered" has a precise meaning at that boundary.** The republish at `:308`
  runs the full DOR-260 pipeline: `RelayPublishPipeline.deliverAndFinalize`
  (`packages/relay/src/relay-publish.ts:262-349`) runs the DOR-277 initiate-
  consent gate (`:275-295`) and the **authoritative budget gate**
  (`enforceBudget`, `:305-314`) BEFORE any adapter dispatch; a rejection returns
  via `rejectAtGate` with `deliveredTo` **not** incremented. On success the
  agent-adapter delivery increments `deliveredTo` (`:341-349`). `publish()`
  returns `{ messageId, deliveredTo }` (`binding-router.ts:39-43`).
  `handleInbound` currently **discards** this return (`:308` bare `await`).
  So the honest unit — "one **delivered** `relay_message` = one pulse" — is
  precisely: emit when the captured `deliveredTo > 0`. A budget-rejected,
  consent-denied, or unsubscribed message (`deliveredTo === 0`) does **not**
  pulse.

- **The animation primitive is verified, not assumed.** SVG `<animateMotion>`
  along a path string is already in the client
  (`apps/client/src/layers/features/agent-hub/ui/PersonalityRadar.tsx:442`,
  `<animateMotion dur path=…>`). CSS `offset-path: path(…)` + `offset-distance`
  traces the same exact bezier and is drivable by `motion` (the house animation
  lib, `contributing/animations.md`). Both trace the **exact** `edgePath`.
  motion@12.42 `transition.path`/`arc()` curves an element **between its old and
  new x/y positions** (installed `motion-dom@12.42.0` d.ts, per ideation §4) —
  it cannot follow an SVG path string and is **rejected**.

- **The gate + reduced-motion primitives exist.** `usePrefersReducedMotion()`
  (`apps/client/src/layers/features/mesh/lib/use-reduced-motion.ts`) is the
  gate; `BindingEdge` already reads zoom via `useStore(zoomSelector)`
  (`BindingEdge.tsx:14,53`) and owns the exact `edgePath`
  (`getBezierPath`, `:56-63`) — it re-derives on every pan/zoom/layout tick, so
  a pulse hosted there tracks the wire for free.

- **The whole surface is relay-gated and demo-gated.** Binding edges only exist
  when `relayEnabled` (`build-topology-elements.ts:190`). Mesh+Relay is behind
  the AGENTS.md demo-claim gate (unverified end-to-end), so this feature is
  dogfood/verification-facing and must degrade to **nothing** — no errors, no
  ghost pulses — when relay is off or no traffic flows.

## Decisions (LOCKED from ideation)

Carried forward verbatim from `01-ideation.md` §5; not reopened.

1. **Keep the product goal** — a live pulse on binding edges. Most on-brand
   "coordination, visualized"; independently recommended by
   `research/20260226_mesh_topology_elevation.md`.
2. **Animation primitive:** trace the **exact** `edgePath`. Reject motion@12.42
   `path`/`arc()` (wrong primitive — curves between two points, not along a path
   string). Choice between SVG `<animateMotion>` and CSS `offset-path` resolved
   in this spec (see Detailed Design → "Animation primitive").
3. **What to visualize:** one pulse per **delivered `relay_message`**; never
   `relay_signal` (typing/progress/read-receipt chatter would strobe) and never
   session StreamEvents (a different stream — the per-turn firehose).
4. **Burst handling:** coalesce **per edge** (single in-flight pulse per edge,
   short window); allow **cross-edge** concurrency (distinct wires lighting up
   at once IS the fleet signal).
5. **Reduced motion:** no traveling particle (static) for MVP.
6. **Join key:** the **server** emits flow events keyed by binding participants;
   the client does a trivial edge lookup. No client-side subject parsing.
7. **MVP edge scope:** **binding (adapter↔agent) edges only** — the edges that
   render today.

## Decisions resolved in SPECIFY (the ideation's two open questions)

- **Open Q1 — the enabling broadcast (event shape, emit site, privacy).**
  Resolved:
  - **(a) Dedicated `relay_flow` event, not an extension of `relay_message`.**
    `relay_message` is the operator console feed with a full `RelayEnvelope`
    (payload included); reusing it would either leak message content onto a new
    fan-out or overload a feed with a different meaning and audience. A new,
    narrow, metadata-only event keeps the console feed untouched and carries no
    content. It is added to the client's `GENERIC_EVENTS` registry alongside its
    siblings.
  - **(b) Emit at the inbound binding-routing boundary**
    (`BindingRouter.handleInbound`), **only when `deliveredTo > 0`.** This is the
    one site with `{bindingId, adapterId, agentId}` cleanly resolved; gating on
    `deliveredTo > 0` means the pulse fires only for messages that actually
    passed the DOR-260 budget + DOR-277 consent gates and reached the agent.
  - **(c) Metadata-only carries no privacy/access-control risk worth blocking,
    but the choice is deliberate and ADR-worthy.** The event carries only the
    routing skeleton (`bindingId`, `adapterId`, `agentId`, `direction`, `at`) —
    **no** payload, message text, subject string, or `chatId` (a Telegram chat
    id is user data and is deliberately excluded; the animation does not need
    it). Every recipient of `/api/events` is already a same-origin cockpit
    client that can read bindings and adapters via the API, so the routing
    skeleton exposes nothing they cannot already enumerate. Recorded as a draft
    ADR (Related ADRs).

- **Open Q2 — agent↔agent flow (follow-up?) + size re-check.** Resolved:
  **binding-edge flow ships first; agent↔agent is a follow-up.** No agent↔agent
  edge renders today; surfacing it needs both a new topology edge type and a new
  `relay.agent.*` broadcast — its own scoped work. Filed as a follow-up at DONE.
  **v1 is also inbound-direction-only** (adapter→agent); outbound (agent→adapter
  replies) is deferred for a concrete engineering reason (see Non-Goals). Size
  stays **5** — the server plumbing is the bulk, the client animation is
  low-risk; see "Size re-check".

## Goals

- Add a metadata-only `RelayFlowEventSchema` to `@dorkos/shared`
  (`relay-envelope-schemas.ts`, re-exported via `@dorkos/shared/relay-schemas`);
  regenerate OpenAPI.
- Emit a `relay_flow` event from `BindingRouter.handleInbound` when a routed
  inbound message is actually delivered (`deliveredTo > 0`), keyed by
  `{ bindingId, adapterId, agentId, direction: 'inbound', at }`, broadcast onto
  `/api/events` via a `broadcastRelayFlow` helper — with the emit callback
  **injected** into `BindingRouter` (mirroring the existing `eventRecorder` dep)
  so the router stays unit-testable and free of the SSE singleton.
- Register `relay_flow` in the client `GENERIC_EVENTS` array so it is
  dispatchable.
- Add a short-lived per-edge activity store in `features/mesh/model` (Zustand),
  keyed by edge id, with per-edge coalescing, self-expiring entries, and a
  by-edge-id selector so idle edges never re-render.
- Add a mesh-feature subscription bridge hook that parses `relay_flow` and
  writes to the store; mount it in the topology host.
- Render the pulse inside `BindingEdge`: a single `--color-primary` dot tracing
  the exact `edgePath` in the delivered direction, fading out, coalesced,
  suppressed below a zoom threshold, and rendered as **nothing** under
  reduced-motion.
- Degrade to nothing when relay is off / no traffic: no errors, no ghost pulses.
- Draft the ADR for the `relay_flow` broadcast (privacy: metadata-only) and a
  user-facing changelog fragment; file agent↔agent + outbound as follow-ups.

## Non-Goals

- **Outbound (agent→adapter reply) pulses in v1.** Deferred for a concrete
  reason: the agent reply is published by the runtime adapter to
  `originalEnvelope.replyTo` — a `relay.inbox.*` reply inbox
  (`packages/relay/src/adapters/claude-code/publish.ts:44-52,141`,
  `agent-handler.ts:203,316`), NOT back through `BindingRouter`
  (`handleInbound` explicitly skips `from.startsWith('agent:')`,
  `binding-router.ts:244`). There is **no** single server-side site where an
  outbound reply has `{bindingId, adapterId, agentId}` cleanly resolved without
  building a reverse binding lookup (its own scoped work that would reintroduce
  the sessionId↔agentId bridge the ideation rejected). The `direction` field is
  in the schema so outbound drops in cleanly later, but v1 emits `inbound` only.
- **Agent↔agent flow.** No such edge renders today; needs a new edge type + a
  `relay.agent.*` broadcast. Follow-up.
- **Message content, payload, subject, or chatId on the wire.** Metadata-only,
  by design (privacy).
- **Pulsing `relay_signal`** (typing/progress/read-receipt/backpressure) or
  session StreamEvents. Explicitly excluded — they would strobe.
- **A "denied"/"dead-lettered" visual.** v1 = **delivered only**. A budget-
  rejected or consent-denied message (`deliveredTo === 0`) does not pulse.
  Surfacing a blocked message as a normal pulse would be dishonest (it implies
  traffic flowed where it was stopped); a distinct deny visual is a possible
  future refinement, out of scope here.
- **A traffic-rate heatmap / throughput encoding** (density, color-by-rate). MVP
  visualizes individual delivered events, not rates. (An "N" density badge under
  burst was floated in ideation §4 — deferred.)
- **Touching the console feed** (`relay.human.console.>` → `relay_message`),
  relay routing, access control, or the DOR-335 `relayAdapters` mislabel.

## Technical Dependencies

- No new external dependencies. `motion` (`motion/react`) is already a client
  dependency and the house animation lib (`contributing/animations.md`);
  `@xyflow/react` (`getBezierPath`, `useStore`) and Zustand are already used in
  `features/mesh`.
- `zod` (already in `@dorkos/shared`) for `RelayFlowEventSchema`, with
  `.openapi('RelayFlowEvent')` (the module already calls `extendZodWithOpenApi`,
  `relay-envelope-schemas.ts:8-10`).
- OpenAPI regenerates from the Zod schemas via `pnpm docs:export-api`. Never
  hand-edit `docs/api/openapi.json`.

## Detailed Design

### 1. Shared — the `relay_flow` event schema (metadata-only)

Add to `packages/shared/src/relay-envelope-schemas.ts` (auto re-exported by the
`relay-schemas.ts` facade → `@dorkos/shared/relay-schemas`, which the client
already imports for `AdapterBinding`):

```ts
/** Direction a relay message travels across a binding edge. */
export const RelayFlowDirectionSchema = z
  .enum(['inbound', 'outbound'])
  .openapi('RelayFlowDirection');
export type RelayFlowDirection = z.infer<typeof RelayFlowDirectionSchema>;

/**
 * Metadata-only signal that one relay message was delivered across a binding
 * edge, used solely to animate a transient pulse on the topology. Carries the
 * routing skeleton and NOTHING about the message itself — no payload, text,
 * subject, or chat id.
 */
export const RelayFlowEventSchema = z
  .object({
    /** Binding UUID. The client maps this to edge id `binding:{bindingId}`. */
    bindingId: z.string(),
    /** Adapter instance id (`binding.adapterId`); edge source `adapter:{adapterId}`. */
    adapterId: z.string(),
    /** Mesh agent id (`binding.agentId`); edge target. */
    agentId: z.string(),
    /** Travel direction: `inbound` = adapter→agent (source→target). */
    direction: RelayFlowDirectionSchema,
    /** Emit timestamp (ISO 8601), for client-side staleness/coalescing. */
    at: z.string().datetime(),
  })
  .openapi('RelayFlowEvent');
export type RelayFlowEvent = z.infer<typeof RelayFlowEventSchema>;
```

`bindingId` is the **primary** join key: `handleInbound` already holds
`binding.id`, and the client's edge id is `binding:${binding.id}`, so the client
does a direct string build — no `bindings.find(...)`, no ambiguity when several
bindings share an adapter+agent pair under different `chatId` filters.
`adapterId`/`agentId` ride along for context and robustness (e.g. a future
non-binding flow, or debugging).

### 2. Server — emit at the inbound delivery boundary

**Emit site:** `apps/server/src/services/relay/binding-router.ts`,
`handleInbound`, at the republish (`:308-312`). Capture the return and emit only
on real delivery:

```ts
const { deliveredTo } = await this.deps.relayCore.publish(dispatchSubject, enrichedPayload, {
  from: envelope.from,
  replyTo: envelope.replyTo,
  budget: envelope.budget,
});

// One delivered inbound message = one pulse. deliveredTo === 0 means the
// message was budget-rejected (DOR-260), consent-denied (DOR-277), or had no
// subscriber — it never reached the agent, so it must not pulse.
if (deliveredTo > 0) {
  this.deps.onFlow?.({
    bindingId: binding.id,
    adapterId: binding.adapterId,
    agentId: binding.agentId,
    direction: 'inbound',
    at: new Date().toISOString(),
  });
}
```

**Why `deliveredTo > 0` and not "on accept":** the ideation and DOR-260 draw a
hard line — the budget gate is authoritative and runs inside the same
`publish()` call. Emitting before the gate would light a wire for a message the
system then refused to deliver. `deliveredTo` is the single honest post-gate
delivery signal already computed by the pipeline.

**Wiring — inject, don't import the singleton.** Add `broadcastRelayFlow` to
`apps/server/src/services/relay/relay-sse-events.ts` (consistent with the
existing `broadcastBindingsChanged` / `broadcastAdaptersChanged` there):

```ts
/** Broadcast a delivered relay message across a binding edge (topology pulse). */
export function broadcastRelayFlow(flow: RelayFlowEvent): void {
  eventFanOut.broadcast('relay_flow', flow);
}
```

Add an optional `onFlow?: (flow: RelayFlowEvent) => void` to
`BindingRouterDeps` (`binding-router.ts:62-81`) and `BindingSubsystemDeps`
(`binding-subsystem.ts:20-40`), mirroring the existing optional `eventRecorder`.
Thread it: `binding-subsystem.ts:101-115` passes `onFlow: deps.onFlow` into
`new BindingRouter({...})`; `adapter-manager.ts` (`BindingSubsystem.init`,
`:293`) passes `onFlow: broadcastRelayFlow`. This keeps `BindingRouter` a pure,
unit-testable unit (assert the callback fires with the right payload and only
when `deliveredTo > 0`) and keeps the `eventFanOut` singleton at the
composition edge — the exact pattern `eventRecorder` already follows.

**Data flow (new):**
`inbound relay.human.* → BindingRouter.handleInbound → resolve binding →
publish to relay.agent.* (DOR-260 gate) → deliveredTo>0 → onFlow →
broadcastRelayFlow → eventFanOut('relay_flow') → /api/events SSE`.

### 3. Client — register the event

Add `'relay_flow'` to `GENERIC_EVENTS`
(`apps/client/src/layers/shared/lib/transport/stream-manager.ts:145-156`). No
other transport change — generic events are dispatched verbatim to
`useEventSubscription` subscribers (`event-stream-context.tsx:33`).

### 4. Client — the per-edge activity store (`features/mesh/model`)

A new Zustand store, `useRelayFlowStore` (FSD: `features/mesh/model`, since the
edge id `binding:{id}` and the topology are mesh-feature concerns):

```ts
/** A transient, self-expiring activity entry for one binding edge. */
interface EdgeActivity {
  direction: RelayFlowDirection;
  /** Monotonic id so a fresh pulse re-keys the motion element even back-to-back. */
  nonce: number;
}

interface RelayFlowState {
  /** Keyed by edge id (`binding:{bindingId}`). Absent = idle. */
  activity: Record<string, EdgeActivity>;
  /** Register a delivered message on an edge (coalesced per edge). */
  pulse: (edgeId: string, direction: RelayFlowDirection) => void;
  /** Clear one edge's entry (called on animation-complete). */
  clear: (edgeId: string) => void;
  /** Drop all activity (topology unmount). */
  reset: () => void;
}
```

- **Coalescing (single in-flight per edge):** `pulse(edgeId, dir)` is a no-op if
  `activity[edgeId]` already exists (a pulse is in flight). Bursts on one edge
  collapse to a single pulse; the edge never strobes. The entry is removed by
  `clear(edgeId)`, called from `BindingEdge`'s animation-complete callback
  (~700-900ms later), so the edge is eligible to pulse again on the next
  message. This realizes the ideation's "single in-flight pulse per edge, short
  window (~250-400ms)" — the window is effectively the pulse duration, tied to
  the animation lifecycle rather than a separate wall-clock timer (no dangling
  timers).
- **Cross-edge concurrency:** distinct edge ids are independent keys — ten
  agents receiving at once = ten wires pulsing. That is the fleet signal.
- **Selector by edge id:** `BindingEdge` subscribes via
  `useRelayFlowStore((s) => s.activity[edgeId])`. An idle edge does not
  re-render when another edge pulses — critical because React Flow already
  re-renders edges on every transform change.
- **Concurrency cap (guard):** if `Object.keys(activity).length` exceeds a
  constant (e.g. `MAX_CONCURRENT_PULSES = 24`), `pulse` drops the new entry.
  Bounds the active animation count on a large mesh; MVP meshes are small.
- **TTL / no leaks:** entries are self-limiting (cleared on animation-complete);
  `reset()` on topology unmount clears any orphan. `nonce` (incremented per
  pulse) lets `BindingEdge` re-mount the motion element for a genuinely new pulse
  even if two arrive back-to-back after a clear.

### 5. Client — the SSE→store bridge (`features/mesh/model`)

A new hook `useRelayFlowSubscription()` in the mesh feature (NOT the
entities/relay hook — an entity cannot import the features/mesh store; FSD
`shared ← entities ← features`). It bridges the global stream to the store:

```ts
export function useRelayFlowSubscription(enabled: boolean): void {
  const pulse = useRelayFlowStore((s) => s.pulse);
  useEventSubscription('relay_flow', (raw) => {
    if (!enabled) return;
    const parsed = RelayFlowEventSchema.safeParse(raw);
    if (!parsed.success) return;
    const { bindingId, direction } = parsed.data;
    pulse(`binding:${bindingId}`, direction);
  });
}
```

- `useEventSubscription` and `useEventStream` are imported from
  `@/layers/shared/model` (features may import shared).
- `enabled` = `relayEnabled` (topology already knows this). When relay is off,
  no subscription work happens and the store stays empty — degrade to nothing.
- Mounted once in the topology host (`features/mesh/ui/TopologyGraph.tsx` or the
  `TopologyPanel` that owns it), alongside `reset()` on unmount. It does **not**
  live in `BindingEdge` (one subscription for the whole graph, not one per
  edge).
- We do **not** gate the bridge on reduced-motion — the store write is cheap and
  the render decision belongs to `BindingEdge` (which reads
  `usePrefersReducedMotion`). Keeps the gate in one place.

### 6. Client — the pulse visual (`BindingEdge`)

`BindingEdge` (`apps/client/src/layers/features/mesh/ui/BindingEdge.tsx`) already
computes `edgePath` (`:56-63`) and reads `zoom` (`:53`). Add:

```ts
const activity = useRelayFlowStore((s) => s.activity[id]);
const clear = useRelayFlowStore((s) => s.clear);
const prefersReduced = usePrefersReducedMotion();
const showPulse = !!activity && !prefersReduced && zoom >= PULSE_MIN_ZOOM;
```

Render (inside the existing fragment, after `BaseEdge`):

```tsx
<AnimatePresence>
  {showPulse && (
    <motion.circle
      key={activity.nonce} // fresh pulse remounts cleanly
      r={3}
      className="fill-primary"
      style={{ offsetPath: `path("${edgePath}")` }}
      initial={{ offsetDistance: activity.direction === 'inbound' ? '0%' : '100%', opacity: 0 }}
      animate={{
        offsetDistance: activity.direction === 'inbound' ? '100%' : '0%',
        opacity: [0, 1, 1, 0],
      }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.8, ease: 'easeInOut' }}
      onAnimationComplete={() => clear(id)}
    />
  )}
</AnimatePresence>
```

**Animation primitive — CSS `offset-path` + `offset-distance` via `motion`
(chosen); SVG `<animateMotion>` (PersonalityRadar precedent) is the considered
fallback.** Both trace the exact bezier. `offset-path` wins because:

- **Clean React lifecycle.** `motion` + `AnimatePresence` give fade-out and
  unmount cleanup for free, and `onAnimationComplete` clears the store entry —
  tying the "single in-flight" window to the animation, not a wall-clock timer.
- **`motion` is the house lib** (`contributing/animations.md`), so this is
  consistent with the rest of the client; SMIL start/stop-from-React is awkward
  for a one-shot, on-demand pulse (SMIL is built for declarative loops, as in
  PersonalityRadar's `repeatCount="indefinite"`).
- **Direction is trivial:** inbound animates `offsetDistance 0%→100%`
  (adapter→agent = source→target); outbound (later) swaps to `100%→0%`.
- **Coordinate space:** the `motion.circle` is a sibling of `BaseEdge` in the
  same SVG group, so `offset-path(edgePath)` positions it in the same flow
  coordinates `BaseEdge`'s `d` uses; React Flow's ancestor transform maps both to
  screen identically. Pan/zoom track for free.

Diverging from the exact PersonalityRadar precedent is justified per AGENTS.md
("diverging needs justification"): the lifecycle/fade/reduced-motion ergonomics
of `motion` materially beat SMIL for an on-demand one-shot, and `motion` is the
project-wide animation standard. `offset-path` is well-supported in the
evergreen cockpit target.

**Calm Tech tuning:** one small dot, `r=3`, `fill-primary` (matches the edge
stroke `stroke-primary`); `duration 0.8s` ease-in-out; opacity keyframes
`[0,1,1,0]` so it fades in at the start and out at the end (a heartbeat, not a
laser). No trails, no color cycling. `PULSE_MIN_ZOOM = 0.5` (a moving dot reads
at lower zoom than the `0.7` label threshold; below it the dot is sub-pixel
noise — the ideation's LOD guidance,
`research/20260228_graph_topology_visualization_ux.md`).

**Reduced motion (Decision 5 — static/nothing):** `showPulse` is false when
`usePrefersReducedMotion()` is true — the pulse element is never rendered. This
is the explicit, testable gate (the global `<MotionConfig reducedMotion="user">`
would also neutralize the transform, but rendering nothing is the honest MVP: no
element, no work). A subtle static opacity blip is a possible future refinement,
out of scope.

**Cleanup / unmount:** `AnimatePresence` removes the element when `showPulse`
goes false (pulse ends → `clear` → store entry gone) or when the edge/graph
unmounts. `onAnimationComplete` fires exactly once per pulse; no timers to leak.
`reset()` on topology unmount clears any orphaned entry.

### Code structure & file organization

| Change                                                                     | Path                                                                                                       |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `RelayFlowEventSchema` + `RelayFlowDirectionSchema` (+ types)              | `packages/shared/src/relay-envelope-schemas.ts` (re-exported via `relay-schemas.ts` facade)                |
| OpenAPI regen                                                              | `docs/api/openapi.json` via `pnpm docs:export-api`                                                         |
| Emit + capture `deliveredTo`; add `onFlow` dep                             | `apps/server/src/services/relay/binding-router.ts`                                                         |
| `broadcastRelayFlow` helper                                                | `apps/server/src/services/relay/relay-sse-events.ts`                                                       |
| Thread `onFlow` dep                                                        | `apps/server/src/services/relay/binding-subsystem.ts`, `apps/server/src/services/relay/adapter-manager.ts` |
| Register `relay_flow`                                                      | `apps/client/src/layers/shared/lib/transport/stream-manager.ts` (`GENERIC_EVENTS`)                         |
| `useRelayFlowStore` + `useRelayFlowSubscription`                           | `apps/client/src/layers/features/mesh/model/` (+ `index.ts` barrel)                                        |
| Pulse render                                                               | `apps/client/src/layers/features/mesh/ui/BindingEdge.tsx`                                                  |
| Mount subscription + `reset()`                                             | `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx` (or its `TopologyPanel` host)                  |
| Constants (`PULSE_MIN_ZOOM`, `MAX_CONCURRENT_PULSES`, `PULSE_DURATION_MS`) | `apps/client/src/layers/features/mesh/config/`                                                             |

### API changes

- **New SSE event** `relay_flow` on `GET /api/events` (the existing global fan-out
  stream). Payload = `RelayFlowEvent`. No REST route added or removed; no status
  codes change.
- **OpenAPI:** `RelayFlowEvent` + `RelayFlowDirection` schema components appear
  after regen. `/api/events` is an SSE stream (not documented per-event in the
  REST spec), so the addition is schema-only.

### Data model changes

None. No DB column, no config field. `relayEnabled` already gates the surface;
reduced-motion is OS-level.

## User Experience

- **Kai watching his fleet (topology view):** when a Telegram/Slack message is
  delivered to one of his agents, a single soft dot travels that adapter→agent
  wire and fades. Ten agents receiving at once = ten wires pulsing independently.
  A static wiring diagram becomes a live view of work arriving. No message text
  is ever shown — just that traffic flowed, and where.
- **One edge, many messages fast:** the wire pulses once and does not strobe
  (per-edge coalescing) — calm, legible, one heartbeat per burst.
- **Zoomed out:** pulses fade below the LOD threshold rather than becoming
  sub-pixel noise; the graph stays clean at a distance.
- **Reduced-motion users:** no traveling particle at all — the topology is fully
  static, honest, and motion-sickness-safe.
- **Relay off / no traffic / message blocked:** nothing happens — no errors, no
  ghost pulses. A budget-rejected or consent-denied message does not light a
  wire (it never reached the agent).
- **Honesty:** only **delivered** messages pulse, and only on the real edges that
  represent real bindings — never a signal, never a blocked message, never a
  wire that carried nothing.

## Testing Strategy

- **Server emit-site unit (`binding-router` test) — the keystone.** Drive
  `handleInbound` with a `FakeRelayCore` whose `publish` returns
  `{ messageId, deliveredTo }`:
  - `deliveredTo > 0` → `onFlow` fires exactly once with
    `{ bindingId: binding.id, adapterId: binding.adapterId, agentId:
binding.agentId, direction: 'inbound', at: <ISO> }`. _Purpose: delivered
    inbound message pulses, keyed correctly._
  - `deliveredTo === 0` → `onFlow` does **not** fire. _Purpose: budget-
    rejected/consent-denied/unsubscribed messages never pulse (the honesty
    gate)._
  - `from` starts with `agent:` (skipped at `:244`), no binding resolved, or a
    paused/`canReceive:false` binding → `onFlow` never fires. _Purpose: no
    phantom pulse on non-routed inbound._
- **Shared schema unit (`relay-envelope-schemas` test):** `RelayFlowEventSchema`
  accepts a valid event; rejects one missing `bindingId`/`direction` or with a
  bad `direction`; strips an extra `payload`/`text` key (proving metadata-only).
  _Purpose: the wire contract is tight and content-free._
- **Client store + coalescing unit (`useRelayFlowStore` test):**
  - `pulse(edge)` sets an entry; a second `pulse(edge)` while in flight is a
    no-op (single in-flight per edge). _Purpose: no strobe._
  - `pulse(edgeA)` + `pulse(edgeB)` set two independent entries. _Purpose:
    cross-edge concurrency._
  - `clear(edge)` removes the entry; a subsequent `pulse(edge)` re-registers with
    an incremented `nonce`. _Purpose: eligible again after the pulse, fresh
    re-key._
  - Beyond `MAX_CONCURRENT_PULSES` active, `pulse` drops. _Purpose: bounded
    concurrency._
- **Client bridge unit (`useRelayFlowSubscription` test):** a `relay_flow` event
  with a valid payload calls `pulse('binding:{id}', direction)`; a malformed
  payload (`safeParse` fail) is ignored; `enabled=false` ignores all.
  _Purpose: parse-and-route is safe and gated._
- **BindingEdge RTL (`BindingEdge.test.tsx`), including the reduced-motion
  branch:**
  - With an active store entry, zoom ≥ threshold, reduced-motion off → the pulse
    element renders (assert the `motion.circle`/`fill-primary` node present).
  - Reduced-motion on (mock `matchMedia`) → **no** pulse element (Decision 5).
  - Zoom below `PULSE_MIN_ZOOM` → no pulse element (LOD).
  - No active entry → no pulse element (idle edges are clean).
    _Purpose: the render gate honors activity, reduced-motion, and LOD._
- **E2E — not driven, stated honestly.** A real end-to-end pulse requires a live
  external adapter (e.g. Telegram) delivering a real message through a binding to
  a running agent, then asserting a sub-second transient SVG animation. That is
  not reliably drivable in Playwright, and Mesh+Relay is behind the demo-claim
  gate (unverified e2e). We do **not** add an e2e test; coverage is the server
  emit-site unit + client store/bridge units + BindingEdge RTL. **Manual /
  dev-playground verification:** a small Dev Playground showcase that fires
  synthetic `relay_flow` events at a mock topology (per the
  `maintaining-dev-playground` skill) is the honest visual-QA path and is
  recommended as a DECOMPOSE task — it doubles as the demo surface without
  claiming live relay works.
- **Green gate:** `pnpm --filter @dorkos/shared build` first (stale dist →
  false-red types), then affected typecheck/lint/test via `pnpm verify`;
  `pnpm docs:export-api` and confirm `openapi-fresh` (per the MEMORY note: a red
  on an untouched-schema PR means another PR landed a schema-stale main —
  reproduce by merging `origin/main` first, then regenerating).

Each test carries a purpose comment; no always-pass tests.

## Performance Considerations

- **No extra edge re-renders.** Activity lives in a store read by a by-edge-id
  selector; an idle edge never re-renders when another edge pulses. This is the
  one real risk (React Flow re-renders edges on every transform) and the store
  selector is the mitigation.
- **Off-thread animation.** `motion` animates `offset-distance`/`opacity` via the
  Web Animations API / rAF, off the React render loop. One small `<circle>` per
  active edge.
- **Bounded active count.** Per-edge coalescing caps active pulses at one per
  edge; `MAX_CONCURRENT_PULSES` caps the total. `PULSE_MIN_ZOOM` culls pulses at
  a distance.
- **Server:** one extra `new Date().toISOString()` + a metadata broadcast per
  delivered inbound message — negligible; the console feed is untouched.

## Security Considerations

- **Metadata-only, no content.** `RelayFlowEvent` carries `bindingId`,
  `adapterId`, `agentId`, `direction`, `at` — no payload, message text, subject,
  or `chatId`. No message content reaches the new fan-out.
- **No new exposure.** `/api/events` recipients are same-origin cockpit clients
  that can already enumerate bindings/adapters via the API; the routing skeleton
  reveals nothing new. No new route, auth surface, or external fetch.
- **Delivered-only.** Emitting on `deliveredTo > 0` means the event never
  reveals a message the budget/consent gates blocked.

## Documentation

- **Changelog fragment** (user-visible: a new live visual). Add
  `changelog/unreleased/<id>-<slug>.md` (timestamp-id via `.claude/scripts/id.ts`
  - slug), an **Added** entry in `writing-for-humans` voice, e.g.: _"The Agents
    map now shows live traffic: when a message reaches one of your agents from a
    connected app, a dot travels the wire between them. It respects your
    reduced-motion setting."_ Never edit `CHANGELOG.md` directly
    (ADR 260707-231641). Keep it demo-gate-safe — describe what the user sees, do
    not claim Mesh+Relay is verified end-to-end.
- **OpenAPI:** regenerate via `pnpm docs:export-api` (adds `RelayFlowEvent`).
- **Inline TSDoc** on the new schema, store, hook, and helper (enforced by
  `eslint-plugin-jsdoc`); the `relay_flow` line in `GENERIC_EVENTS` needs no
  extra comment (the array's module doc covers it).
- **Draft ADR** — see Related ADRs (seeded here, not created this stage per the
  drain directive).

## Implementation Phases

Schema lands first so the server emit and client bridge both type-check against
it; the rest is largely parallelizable in a worktree. (DECOMPOSE will shape
~5-6 tasks — see "Estimated DECOMPOSE shape".)

- **Phase 1 — shared schema (keystone):** `RelayFlowDirectionSchema` +
  `RelayFlowEventSchema` + types + facade re-export; `pnpm docs:export-api`;
  schema unit test.
- **Phase 2 — server emit:** capture `deliveredTo` in `handleInbound`, emit via
  injected `onFlow` on `deliveredTo > 0`; `broadcastRelayFlow` helper; thread the
  dep through `binding-subsystem` + `adapter-manager`; emit-site unit tests.
- **Phase 3 — client plumbing:** register `relay_flow` in `GENERIC_EVENTS`; the
  mesh `useRelayFlowStore` (+ coalescing) and `useRelayFlowSubscription` bridge;
  store + bridge unit tests.
- **Phase 4 — client visual:** the `BindingEdge` pulse (offset-path + motion,
  direction, LOD, reduced-motion); mount the subscription + `reset()` in the
  topology host; BindingEdge RTL (incl. reduced-motion + LOD branches).
- **Phase 5 — polish/docs:** Dev Playground showcase (synthetic `relay_flow`),
  changelog fragment, draft ADR, follow-up issues (outbound direction,
  agent↔agent flow).

## Size re-check

The ideation flagged the server broadcast as the bulk; SPECIFY confirms it.
Server: new shared schema (+ openapi regen), capture-and-emit in `handleInbound`,
broadcast helper + dep threading through two files, emit-site tests. Client:
`GENERIC_EVENTS` line, a new store with coalescing + a bridge hook (+ tests), and
the `BindingEdge` pulse (+ RTL). It spans shared → server → client with three
test suites. This is a genuine, self-contained full-stack feature but a bounded
one — the server plumbing is small and additive; the client animation is
low-risk once the wire exists. **Size 5 holds** (not an 8): no DB migration, no
new config, no routing changes, purely additive, degrades to nothing. The
inbound-only + agent↔agent-deferred scope keeps it there.

## Estimated DECOMPOSE shape

~5-6 tasks (Phase boundaries above); after Phase 1 (schema) lands, Phases 2 and
3-4 parallelize:

1. Shared `relay_flow` schema + facade export + OpenAPI regen + schema test.
2. Server emit: capture `deliveredTo`, `onFlow` on `>0`, `broadcastRelayFlow`,
   dep threading, emit-site units.
3. Client store + bridge: `GENERIC_EVENTS` entry, `useRelayFlowStore`
   (coalescing/cap), `useRelayFlowSubscription`, units.
4. Client visual: `BindingEdge` pulse (offset-path/motion, LOD, reduced-motion),
   mount + `reset()`, RTL.
5. Docs + follow-ups: Dev Playground showcase, changelog, draft ADR, file
   outbound + agent↔agent follow-up issues.

## Open Questions

Both ideation open questions were resolved in this spec (see "Decisions resolved
in SPECIFY"). No floor-level blockers remain — direction is fully pinned.

- ~~**Reuse/extend `relay_message` vs a dedicated `relay_flow`; privacy of
  surfacing delivery metadata; where the emit lives.**~~ **(RESOLVED.)** Dedicated
  metadata-only `relay_flow`; emit at `BindingRouter.handleInbound` on
  `deliveredTo > 0`; no content on the wire; injected callback for testability.
- ~~**Agent↔agent as MVP or follow-up; does it change the size?**~~ **(RESOLVED.)**
  Follow-up (needs a new edge type + `relay.agent.*` broadcast); v1 is
  inbound-direction-only for the reason in Non-Goals. Size stays 5.

## Related ADRs

- **Proposed ADR (extract at DECOMPOSE/EXECUTE via `/adr:from-spec`):** _"Relay
  flow animation broadcasts metadata-only `relay_flow` events at the inbound
  binding-routing boundary."_ Records: the privacy posture (routing skeleton
  only — `bindingId`/`adapterId`/`agentId`/`direction`/`at`, never payload, text,
  subject, or `chatId`); the dedicated-event-vs-`relay_message` choice (the
  console feed carries content and stays untouched); the delivered-only honesty
  gate (`deliveredTo > 0`, riding the DOR-260 budget + DOR-277 consent gates);
  the clean server-side join (`BindingRouter` holds `binding.id`/`adapterId`/
  `agentId`, avoiding the sessionId↔agentId + DOR-335 identity hazards); and the
  inbound-only-v1 scope with outbound deferred for lack of a binding-aware
  outbound site. _(Per the drain directive, this spec seeds the ADR for
  extraction; it does not create the file.)_
- **DOR-260** — made the per-message envelope budget authoritative and enforced
  at `deliverAndFinalize()`. This spec's "delivered = `deliveredTo > 0`" gate
  rides directly on that: a budget-rejected message never increments
  `deliveredTo`, so it never pulses.
- **DOR-277** — the agent→human initiate-consent gate, the sibling check at the
  same boundary; a consent-denied message likewise does not pulse.
- **ADR-0310 / the `/api/events` fan-out** — the global SSE stream this event
  joins (alongside `relay_message`, `relay_bindings_changed`).

## References

- Issue: **DOR-167**. Ideation:
  `specs/relay-flow-animation/01-ideation.md` (the reframe, the identity-join
  analysis, the verified motion-primitive rejection).
- Emit site + join: `apps/server/src/services/relay/binding-router.ts:238-324`
  (`handleInbound`; publish at `:308`, discarded return today),
  `:39-43` (`publish` returns `{ messageId, deliveredTo }`),
  `apps/server/src/services/relay/human-subject.ts:36-63` (subject parse),
  `apps/server/src/services/relay/binding-subsystem.ts:20-40,101-115` (dep
  threading), `apps/server/src/services/relay/adapter-manager.ts:293`
  (`BindingSubsystem.init`).
- Delivery semantics: `packages/relay/src/relay-publish.ts:262-349`
  (`deliverAndFinalize`: consent gate `:275-295`, budget gate `:305-314`,
  `deliveredTo` `:319-349`), `packages/relay/src/adapter-delivery.ts` (the
  detached agent-delivery path), `packages/relay/src/adapters/claude-code/publish.ts:44-52,141`
  - `agent-handler.ts:203,316` (outbound replies go to `relay.inbox.*`, not
    through `BindingRouter` — the reason outbound is deferred).
- Broadcast path: `apps/server/src/index.ts:944-957` (the console-only
  `relay_message` wiring this spec does NOT touch),
  `apps/server/src/services/core/event-fan-out.ts` (`eventFanOut.broadcast`),
  `apps/server/src/services/relay/relay-sse-events.ts` (the
  `broadcastBindingsChanged`/`broadcastAdaptersChanged` pattern to mirror).
- Schema home: `packages/shared/src/relay-envelope-schemas.ts:52-64`
  (`RelayEnvelope`, the neighboring schemas; `extendZodWithOpenApi` at `:8-10`),
  `packages/shared/src/relay-schemas.ts` (facade re-export →
  `@dorkos/shared/relay-schemas`), `packages/shared/package.json:44-46`
  (subpath).
- Client: `apps/client/src/layers/shared/lib/transport/stream-manager.ts:145-159`
  (`GENERIC_EVENTS`), `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts:20-30`
  (the entity hook we do NOT extend),
  `apps/client/src/layers/features/mesh/lib/build-topology-elements.ts:199-213`
  (edge id/source/target), `apps/client/src/layers/features/mesh/ui/BindingEdge.tsx:14,53,56-63`
  (zoom selector + `edgePath`),
  `apps/client/src/layers/features/mesh/lib/use-reduced-motion.ts`
  (`usePrefersReducedMotion`),
  `apps/client/src/layers/features/agent-hub/ui/PersonalityRadar.tsx:442`
  (the `<animateMotion>` precedent, considered and set aside for `offset-path`).
- Motion primitive rejection: installed `motion-dom@12.42.0` d.ts (`path`/`arc()`
  curve between two x/y points, cannot follow a path string) — per ideation §4.
- Research: `research/20260226_mesh_topology_elevation.md` (traffic-animation
  particle, independently recommended), `research/20260228_graph_topology_visualization_ux.md`
  (LOD / zoom-culling).
