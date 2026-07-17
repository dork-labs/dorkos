# Tasks — Animate live relay message flow along topology binding edges

**Spec:** `specs/relay-flow-animation/02-specification.md` · **Slug:**
`relay-flow-animation` · **Tracker:** DOR-167 (task→feature, size 5) ·
**Mode:** full · **Generated:** 2026-07-17

5 tasks across 5 phases, matching the spec's own Implementation Phases 1:1.
The shared event schema is the keystone — everything else types against it.
Once it lands, the server emit and the client store/bridge are genuinely
independent (different packages, zero file overlap) and run in parallel; the
client visual then depends on the store; docs/playground/ADR close the loop
once both the server behavior and the client visual exist to describe
honestly.

## Dependency graph

```
1.1 (keystone: shared RelayFlowEventSchema/RelayFlowDirectionSchema + facade
     re-export + OpenAPI regen + client GENERIC_EVENTS entry + schema test)
 ├─→ 2.1 (server: capture deliveredTo, onFlow on >0, broadcastRelayFlow,
 │        dep threading through binding-subsystem + adapter-manager, tests)
 └─→ 3.1 (client: useRelayFlowStore (coalescing/cap) + useRelayFlowSubscription
          bridge + pulse constants, tests)
        └─→ 4.1 (client: BindingEdge offset-path pulse, direction/LOD/
                 reduced-motion gates, mount subscription + reset() in
                 TopologyGraph, RTL incl. reduced-motion + LOD branches)

{2.1, 4.1} both ready once their direct deps land — different packages
(server vs. client), zero file overlap, so they overlap in wall-clock time
even though 4.1 sits one hop deeper in the graph (it waits on 3.1, not 2.1).

5.1 (Dev Playground synthetic showcase + changelog + draft ADR + recorded
     follow-up pointers for DONE: outbound direction, agent↔agent edges)
 ← depends on 2.1 (documents the landed server honesty gate) and 4.1
   (showcases + describes the landed visual)
 — the closing task; nothing runs after it.
```

Compact form: `1.1 → {2.1 ∥ 3.1}; 3.1 → 4.1; {2.1, 4.1} → 5.1`.

**Critical path (4 deep):** `1.1 → 3.1 → 4.1 → 5.1` is the longest chain —
the client side is deeper than the server side because the visual (4.1)
cannot exist without the store (3.1) it reads from.

**Mutually independent (parallelizable) once 1.1 lands:**

- **2.1 (server emit) ∥ 3.1 (client store + bridge)** — different packages
  (`apps/server` vs. `apps/client`), zero file overlap. 3.1's tests drive the
  bridge with a mocked event handler, not a real server round-trip, so it
  never needs 2.1 to have landed.
- **2.1 (server emit) ∥ 4.1 (client visual)** — once 3.1 has landed, 4.1 can
  proceed whether or not 2.1 has finished; 4.1's RTL tests exercise the store
  directly via mocks, not a live SSE event from the server.

**Nothing is promoted to a sub-issue** — no task reaches `xl` (threshold
`xl`), so every task stays a checklist line mirrored into DOR-167.

---

## Phase 1 — Shared schema keystone (event contract + OpenAPI + event registry)

### Task 1.1: Add `RelayFlowEventSchema` + `RelayFlowDirectionSchema`, regenerate OpenAPI, register `relay_flow` in `GENERIC_EVENTS`

Adds the metadata-only `relay_flow` wire contract to
`packages/shared/src/relay-envelope-schemas.ts` (auto re-exported via the
`relay-schemas.ts` facade's `export *`), regenerates
`docs/api/openapi.json` via `pnpm docs:export-api`, and appends `'relay_flow'`
to the client's `GENERIC_EVENTS` array
(`apps/client/src/layers/shared/lib/transport/stream-manager.ts:145-155`) so
the event is dispatchable to any subscriber. Adds a schema unit test proving
the contract is tight (missing fields rejected, bad `direction` rejected,
extra `payload`/`text` keys stripped — proving metadata-only).

- size: sm · priority: high · deps: none · ∥ none (the keystone) · cites spec
  §Detailed Design 1, §3, §Technical Dependencies, §Testing Strategy (shared
  schema unit)

---

## Phase 2 — Server emit at the binding-routing boundary

### Task 2.1: Capture `deliveredTo`, emit via injected `onFlow` on `>0`, `broadcastRelayFlow`, dep threading, emit-site tests

Captures the previously-discarded `{ deliveredTo }` return from
`BindingRouter.handleInbound`'s republish
(`binding-router.ts:308`), calls an injected `onFlow` callback only when
`deliveredTo > 0` (the honesty gate — a budget-rejected or consent-denied
message never pulses). Adds `broadcastRelayFlow` to
`relay-sse-events.ts` mirroring the existing `broadcastBindingsChanged` /
`broadcastAdaptersChanged` helpers, threads the optional `onFlow` dependency
through `BindingRouterDeps` → `BindingSubsystemDeps` → `AdapterManager`'s
`initBindingSubsystem` (the same shape as the existing `eventRecorder` dep),
and wires the real `broadcastRelayFlow` only at that outermost composition
edge — keeping `BindingRouter` unit-testable and free of the `eventFanOut`
singleton. Extends the existing `binding-router.test.ts` suite (which already
fixtures `publish` returning `{ messageId, deliveredTo }`) with 5 cases:
delivered fires once with the right payload; `deliveredTo === 0` never fires;
an `agent:*` sender, an unresolved binding, and a paused/`canReceive:false`
binding all never fire.

- size: md · priority: high · deps: 1.1 · ∥ 3.1 (different packages, no file
  overlap) · cites spec §Detailed Design 2, §Testing Strategy (server
  emit-site unit — the keystone test), §Data flow (new)

---

## Phase 3 — Client store + SSE bridge

### Task 3.1: `useRelayFlowStore` (coalescing + concurrency cap) + `useRelayFlowSubscription` bridge + pulse constants, unit tests

Adds two new FSD segments to `features/mesh` (`model/` and `config/`, neither
exists yet in this feature): a Zustand store `useRelayFlowStore` keyed by edge
id (`binding:{bindingId}`) with per-edge coalescing (a `pulse()` while one is
already in flight is a no-op — no strobe), a `MAX_CONCURRENT_PULSES` cap, and
a `reset()` for topology-unmount cleanup; and a bridge hook
`useRelayFlowSubscription(enabled)` that subscribes to `relay_flow` via
`useEventSubscription`, `safeParse`s the payload against
`RelayFlowEventSchema`, and writes to the store — living in
`features/mesh/model` (not `entities/relay`) because FSD forbids an entity
importing a features-layer store. Adds the three pulse constants
(`PULSE_MIN_ZOOM`, `MAX_CONCURRENT_PULSES`, `PULSE_DURATION_MS`) that task 4.1
consumes. 9 unit-test cases across the store (register/coalesce/cross-edge/
clear-and-re-pulse/cap/reset) and the bridge (valid payload routes, malformed
payload ignored, `enabled=false` ignores).

- size: md · priority: high · deps: 1.1 · ∥ 2.1 (different packages, no file
  overlap; tests use a mocked event handler, not a live server round-trip) ·
  cites spec §Detailed Design 4, §5, §Testing Strategy (client store +
  coalescing unit, client bridge unit)

---

## Phase 4 — Client visual (BindingEdge pulse)

### Task 4.1: `BindingEdge` offset-path pulse (direction/LOD/reduced-motion), mount subscription + `reset()` in `TopologyGraph`, RTL tests

Renders a single `--color-primary` `motion.circle` inside `BindingEdge`,
tracing the exact `edgePath` via CSS `offset-path` + `offset-distance`
(direction-aware: inbound animates `0%→100%`, matching adapter→agent =
source→target), gated on `!!activity && !prefersReduced && zoom >=
PULSE_MIN_ZOOM`, fading via opacity keyframes `[0,1,1,0]`, and clearing its
store entry via `onAnimationComplete`. Mounts
`useRelayFlowSubscription(relayEnabled)` once in `TopologyGraph` (which
already computes `relayEnabled` at `:105`) plus a `reset()` on unmount. Adds
4 RTL cases to the existing `BindingEdge.test.tsx` (which already mocks
`@xyflow/react`'s `useStore`/`getBezierPath`): pulse renders with an active
entry + sufficient zoom + motion allowed; **no** pulse under reduced-motion
(Decision 5); **no** pulse below `PULSE_MIN_ZOOM` (LOD); **no** pulse on an
idle edge.

- size: md · priority: high · deps: 3.1 · ∥ 2.1 (once 3.1 has landed, this can
  proceed whether or not 2.1 has finished — different packages, tests mock
  the store directly) · cites spec §Detailed Design 6, §5 (mount site),
  §Testing Strategy (BindingEdge RTL), §Performance Considerations

---

## Phase 5 — Dev Playground, changelog, draft ADR, follow-up pointers

### Task 5.1: Synthetic Dev Playground showcase + changelog (Added) + draft ADR + recorded pointers for the two DONE-stage follow-ups

Adds a `relay-flow-pulse` section to `TOPOLOGY_SECTIONS`
(`dev/sections/topology-sections.ts`) and a showcase that reuses the real
`BindingEdge` component (per the `maintaining-dev-playground` skill's parity
rule — never rebuild the visual) with a control that calls
`useRelayFlowStore.getState().pulse('binding:demo-edge', 'inbound')`
directly, bypassing the SSE stream entirely — the honest manual-QA path the
spec calls for in lieu of an e2e test (Mesh+Relay sits behind the
AGENTS.md demo-claim gate; a real end-to-end pulse isn't reliably drivable in
Playwright). Writes the changelog fragment
(`changelog/unreleased/<id>-relay-flow-animation.md`, **Added**, plain
`writing-for-humans` voice, demo-gate-safe). Drafts the ADR (status
`proposed`) capturing the privacy posture, the dedicated-event-vs-
`relay_message` choice, the delivered-only honesty gate, the clean
server-side join, and the inbound-only-v1 scope — cross-linking DOR-260,
DOR-277, and ADR-0310. Records (but does not file — DECOMPOSE never touches
the tracker) explicit pointers for the two follow-ups DONE is expected to
open: outbound (agent→adapter reply) pulses, and agent↔agent flow.

- size: sm · priority: medium · deps: 2.1, 4.1 · ∥ none (the closing task) ·
  cites spec §Testing Strategy (E2E — not driven, stated honestly),
  §Documentation, §Related ADRs, §Non-Goals, §References
