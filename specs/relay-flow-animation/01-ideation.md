---
slug: relay-flow-animation
id: 260717-170853
created: 2026-07-17
status: ideation
linearIssue: DOR-167
---

# Motion: animate live relay message flow along topology binding edges

**Slug:** relay-flow-animation
**Author:** Muybridge (IDEATE stage, /flow drain)
**Date:** 2026-07-17
**Tracker:** DOR-167 · type task→feature · size 5 · Low

---

## 1) Intent & Assumptions

- **Task brief (verbatim from DOR-167):** "Unlocked by motion@12.42 (12.40 adds
  a `path` transition option — animate a value along an SVG path — plus an
  arc() helper). mesh/ui/BindingEdge.tsx already computes the bezier edgePath
  via getBezierPath. The topology already receives relay_message/relay_signal
  over SSE (entities/relay/model/use-relay-event-stream.ts) but only invalidates
  a query. Map an incoming relay_message → its binding edge id, render a
  transient pulse (small circle) animating source→target along edgePath via the
  path transition, fading out. Gate behind the existing usePrefersReducedMotion().
  Value: the single most on-brand 'coordination, visualized' feature — turns a
  static wiring diagram into a live view of inter-agent traffic (Kai wants to
  SEE his fleet communicate)."

- **The product intent is exactly right and should survive.** A live topology
  where messages visibly ride the wires is the most on-brand expression of
  "coordination, visualized" — this is Kiali/Datadog-APM-grade signal in a
  control panel. The `research/20260226_mesh_topology_elevation.md` prior
  independently named "animated flow edges … particle = Relay message activity"
  as a signature enhancement (its §"Traffic Animation", lines 100-106, 240-248).
  Keep the goal.

- **Two of the ticket's _mechanical_ premises do not hold against the installed
  code, and this reframes the work** (details in §3 and §5). Ideation must carry
  both corrections forward:
  1. **The data isn't on the wire.** The global SSE stream broadcasts
     `relay_message` **only for the `relay.human.console.>` subject** — the
     operator's console feed. It does **not** carry the adapter↔agent or
     agent↔agent traffic the binding edges represent. So "map an incoming
     relay_message → its binding edge id" cannot be done today: the messages
     that arrive don't correspond to any rendered edge.
  2. **The cited motion primitive is the wrong tool.** motion 12.42's
     `transition.path` + `arc()` animates an element **between its old and new
     x/y positions** with a curved trajectory — it does **not** trace an
     arbitrary SVG path string. It cannot follow the edge's `getBezierPath`
     bezier. The exact-path techniques (SVG `<animateMotion>`, CSS
     `offset-path`) predate 12.42 and are already used in-repo.
     Net: DOR-167 is **not** a client-only motion-polish task. The animation is the
     easy 20%; the enabling data plumbing (a server broadcast the client can join
     to a rendered edge) is the real 80%.

- **Assumptions:**
  - Relay/Mesh stay behind the demo-claim gate (AGENTS.md); this feature is
    dogfood/verification-facing until Mesh+Relay is verified end-to-end. It must
    degrade to nothing (no errors, no ghost pulses) when relay is disabled or no
    traffic flows.
  - DOR-259 (this drain) verified relay **delivery** works; the topology renders
    agents + adapter→agent binding edges. That is the surface we animate.
  - `usePrefersReducedMotion()` already exists
    (`features/mesh/lib/use-reduced-motion.ts`) and is the gate.
  - Calm Tech, control-panel aesthetic: subtle, purposeful, no arcade particles.

- **Out of scope:**
  - Rebuilding relay routing, access control, or the console feed.
  - A general-purpose traffic-rate heatmap / throughput encoding (density,
    color-by-rate). MVP visualizes _individual message events_, not rates.
  - Agent↔agent edges as a new topology element (they do not render today — see
    §3). Recommended as a follow-up, not MVP.
  - Fixing the DOR-335 `relayAdapters` mislabel (tracked separately; noted here
    only as a data-quality risk for the join key).

## 2) Pre-reading Log

- `AGENTS.md`: control panel not consumer app; Calm Tech; demo-claim gate keeps
  us from claiming Mesh+Relay works; describe user value, not internals.
- `apps/client/src/layers/features/mesh/ui/BindingEdge.tsx`: React Flow custom
  edge. Computes `edgePath` locally via `getBezierPath(...)` inside the
  component (has the path string in scope). Memoized. Renders an invisible
  hit-path + `BaseEdge` + hover label. This is the natural host for a pulse
  because it already owns the exact path and re-derives it on pan/zoom/layout.
- `apps/client/src/layers/features/mesh/ui/CrossNamespaceEdge.tsx`: **prior art
  for an animated edge** — dashed bezier with `strokeDasharray` "marching ants"
  and `animated: true`. Establishes that animated edges are already a pattern.
- `apps/client/src/layers/features/agent-hub/ui/PersonalityRadar.tsx:442`:
  **in-repo prior art for particle-along-path** — uses SVG
  `<animateMotion dur … path={…}>`. Confirms the SMIL approach is already
  accepted in the client.
- `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts`:
  subscribes to `relay_message` / `relay_signal` on the unified stream and
  **only** `invalidateQueries(['relay','conversations'])`. The payload is
  discarded — the handler never inspects the envelope. This is the hook the
  ticket wants to extend.
- `apps/client/src/layers/shared/model/event-stream-context.tsx` +
  `.../lib/transport/stream-manager.ts`: `relay_message` is a `GENERIC_EVENTS`
  member on the global `/api/events` stream; handlers get the raw envelope as
  `unknown`. Subscription is easy; the envelope is available to us.
- `apps/client/src/layers/features/mesh/lib/build-topology-elements.ts:189-235`:
  **the edge-id source of truth.** Binding edge `id = \`binding:${binding.id}\``,
  `source = \`adapter:${binding.adapterId}\``, `target = binding.agentId`. The
  only other edges are cross-namespace (group→group) and deny. **There are no
  agent↔agent edges.**
- `apps/server/src/index.ts:944-957`: the server wires relay→SSE with
  `relayCore.subscribe('relay.human.console.>', …) → broadcast('relay_message')`.
  **This subject filter is the whole story for the global stream.**
- `apps/server/src/routes/relay.ts:456-504`: deprecated `/api/relay/stream`
  accepts a `?subject=` pattern but restricts it to
  `ALLOWED_PREFIXES = ['relay.human.console.', 'relay.system.', 'relay.signal.']`
  — still no `relay.agent.*` traffic.
- `packages/shared/src/relay-envelope-schemas.ts:52-64`: `RelayEnvelope =
{ id, subject, from, replyTo?, budget, createdAt, payload }`. The join
  material is `from` (sender subject) and `subject` (destination subject) —
  **subject strings, not node ids.**
- `apps/server/src/services/relay/subject-resolver.ts`: subject taxonomy —
  `relay.human.console.{clientId}` → "You"; `relay.agent.{…sessionId}` → an
  agent, resolved via **sessionId → session → manifest**; `relay.system.*`,
  `relay.inbox.*`. Note the agent subject carries a **sessionId**, while
  topology agent nodes are keyed by **mesh agent.id** — not the same identifier.
- `research/20260226_mesh_topology_elevation.md`: recommends the SVG
  `<animateMotion>` particle ("signature feature of Kiali's traffic animation")
  at Medium effort; explicitly ties it to Relay message activity.
- `research/20260228_graph_topology_visualization_ux.md`: LOD / zoom-culling
  guidance — hide detail below a zoom threshold; relevant to not rendering
  pulses when zoomed out.

## 3) Codebase Map

- **Primary components/modules:**
  - `features/mesh/ui/BindingEdge.tsx` — pulse host (owns `edgePath`).
  - `features/mesh/lib/build-topology-elements.ts` — edge id / source / target
    construction; the authority on how a message must be keyed to hit an edge.
  - `entities/relay/model/use-relay-event-stream.ts` — where the envelope
    arrives client-side (today it's thrown away after a query invalidation).
  - `features/mesh/lib/use-reduced-motion.ts` — the gate.
  - `features/mesh/ui/TopologyGraph.tsx` — React Flow host; `EDGE_TYPES`, zoom.
- **Shared dependencies:** `motion/react` (already imported in AgentNode /
  AdapterNode), `@xyflow/react` (`getBezierPath`, `useStore` for zoom),
  `cn()`, design tokens (`--color-primary`).
- **Data flow (today):** relayCore (`relay.human.console.>`) → `eventFanOut`
  → `/api/events` SSE → `stream-manager` → `useEventSubscription('relay_message')`
  → `invalidateQueries` → conversations list refetch. **The envelope never
  reaches the topology as anything but a cache-buster.**
- **Data flow (needed):** relay delivery across a binding →
  **[NEW] server broadcast keyed to the binding/participants** → SSE →
  client resolver → edge lookup by `binding:{id}` → transient pulse on
  `BindingEdge`.
- **The edge/traffic mismatch (the crux):**

  | What renders as an edge                                  | What the global stream carries                             |
  | -------------------------------------------------------- | ---------------------------------------------------------- |
  | `binding:{id}`: adapter → agent (Telegram → Kai's agent) | `relay.human.console.*`: operator ⇄ agent console chatter  |
  | cross-namespace allow/deny: group → group                | —                                                          |
  | (no agent↔agent edge)                                    | agent↔agent lives on `relay.agent.*`, **never broadcast**) |

  A `relay.human.console.>` envelope has no home edge — there is no "console"
  node in the topology. So the animation has nothing to attach to until the
  server surfaces edge-relevant traffic.

- **Identity join hazards:**
  - `relay.agent.*` subjects carry a **sessionId**; topology agent nodes use
    **mesh agent.id**; `binding.agentId` is the mesh agent.id. Client-side
    subject-string parsing would have to bridge sessionId → agentId (fragile).
  - **DOR-335**: `relayAdapters` is a known mislabel; the adapter/binding
    identity feeding the topology is not fully trustworthy today. The join key
    must not depend on a field with an open correctness bug.
  - Conclusion: the clean join is for the **server** to emit flow events already
    keyed by `{ adapterId, agentId, direction }` (or the resolved binding id),
    so the client does a trivial `bindings.find(...)` → `binding:{id}` and never
    parses subjects. This sidesteps both hazards.
- **Feature flags/config:** `relayEnabled` gates the whole surface (bindings +
  edges only exist when relay is on). No new config field required for MVP;
  reduced-motion is OS-level.
- **Potential blast radius:** BindingEdge re-render behavior (many edges),
  React Flow render loop, the `use-relay-event-stream` hook contract, and a new
  server broadcast path (privacy/volume). All additive; nothing removed.

## 4) Research

**Where the pulse should live (rendering).** BindingEdge already computes the
exact `edgePath` and re-derives it on every pan/zoom/layout tick. Rendering the
pulse inside BindingEdge means it tracks the wire for free. The edge needs to
know "am I active right now?" — a lightweight per-edge activity signal (a
Zustand store or context keyed by edge id) that the SSE handler writes and the
edge subscribes to by its own id. Fits FSD: store in `features/mesh/model`, the
SSE→store bridge in the mesh feature, envelope arrival stays in
`entities/relay`.

**Animation primitive — verified against the installed API (not release notes):**

1. **SVG `<animateMotion>` along `edgePath`** (or `<mpath href="#edge">`).
   Traces the **exact** bezier. Declarative, GPU-cheap, already used in-repo
   (`PersonalityRadar.tsx`) and recommended by the topology-elevation research.
   Downsides: SMIL is imperative to start/stop from React; reduced-motion and
   cleanup handled by conditionally mounting/unmounting the element.
   **Pros:** exact path, repo-consistent, tiny. **Cons:** SMIL ergonomics.
2. **CSS `offset-path: path(edgePath)` + animate `offset-distance` 0→100%**
   on a `motion.circle`/`div`. Also traces the **exact** bezier. Drivable by
   `motion` (so `AnimatePresence` handles fade-out + unmount cleanup, and the
   reduced-motion gate is a plain conditional). Evergreen-browser feature; fine
   for the cockpit. **Pros:** exact path, clean React lifecycle via motion,
   fade-out for free. **Cons:** new pattern (no existing offset-path use).
3. **motion `transition.path` + `arc()` (the ticket's cited unlock).** Verified
   in `node_modules/.pnpm/motion-dom@12.42.0/.../index.d.ts:2230-2340,2900-2941`:
   `path?: MotionPath` is documented as "the path the element travels **between
   its old and new x/y positions**" and `arc()` bulges that straight line. It
   consumes start/end deltas, **not** an SVG path string. It **cannot** follow
   the BindingEdge bezier — a pulse would drift off the drawn wire. **Reject for
   this use.** (It would be the right tool for, e.g., a node flying to a new
   layout position along a curve — not for tracing an existing edge.)

   **Recommendation:** Option 2 (`offset-path` + `offset-distance` via motion)
   as the primary — exact path fidelity plus motion's lifecycle for fade-out,
   reduced-motion, and unmount cleanup. Option 1 is an acceptable fallback if we
   prefer zero new CSS patterns. Either way, **the motion@12.42 `path`/`arc()`
   feature the ticket names is not what unlocks this** — the exact-path
   techniques were always available. The real unlock is the server broadcast.

**What signal to visualize — the burst/coalescing question, resolved honestly.**
The brief's worry ("a turn streams 10-20 StreamEvents … pulsing every
StreamEvent would be noise") conflates two different streams:

- **Session StreamEvents** (assistant text/tool blocks) ride
  `/api/sessions/:id/events` — a per-session transcript stream. These are the
  10-20-per-turn firehose. **They are not relay envelopes and are not on the
  topology's radar.** We must not pulse these.
- **Relay envelopes** are discrete inter-agent/console messages on
  `/api/events`. A console round-trip is roughly: 1 inbound message + a few
  `progress` **signals** + 1 final `agent_result`. That's a handful of discrete
  events per exchange, not a firehose.

So the honest unit to visualize is **one delivered relay message = one pulse on
its binding edge.** Decisions:

- **Pulse `relay_message` (message deliveries), not `relay_signal`.** Signals
  (typing/progress/read-receipt/backpressure) are chatter; surfacing them would
  strobe. (A future option: a subtle sustained glow on an edge while a `typing`/
  `progress` signal is active, distinct from the discrete message pulse. Defer.)
- **Coalesce per edge under burst.** If an edge receives multiple messages
  within a short window (e.g. ~250-400ms), do not stack overlapping pulses —
  either let the in-flight pulse ride and drop the extras, or bump a small
  "N" density hint. One edge must never strobe. Cross-edge concurrency (10
  agents at once) is fine — those are distinct wires lighting up, which is
  exactly the "fleet communicating" signal.
- **Direction matters.** Adapter→agent (inbound) vs agent→adapter (outbound)
  should animate along the edge in the corresponding direction (source→target
  vs target→source) — hence the server event carries `direction`.

**Performance.**

- React Flow re-renders edges on transform changes; the pulse must not force
  extra edge re-renders. Keep activity state in a store that only the active
  edge subscribes to (selector by edge id), so an idle edge never re-renders on
  someone else's traffic.
- Cap concurrent pulses (e.g. ignore/queue beyond a small N) to bound the SMIL/
  CSS-animation count.
- **LOD:** suppress pulses below a zoom threshold (reuse the `zoomSelector`
  already in BindingEdge, and the LOD guidance in
  `research/20260228_graph_topology_visualization_ux.md`) — at a distance the
  pulses would be sub-pixel noise.
- **Cleanup on unmount:** motion `AnimatePresence` (option 2) or conditional
  mount (option 1) removes the element and its animation when the pulse ends or
  the edge/graph unmounts. No dangling timers if the store uses short-lived,
  self-expiring activity entries (or motion's `onAnimationComplete` to clear).

**Reduced motion + Calm Tech.** When `usePrefersReducedMotion()` is true: no
traveling particle. Option A — nothing (fully static, honest). Option B — a
single brief, non-translating opacity blip on the edge to still signal "traffic
happened" without motion-sickness risk. Recommend **A** for MVP (simplest,
safest), with B as a possible refinement. Regardless: no arcade trails, one
small dot in `--color-primary`, gentle ease, ~600-900ms, fade at the end. It
should read as a heartbeat, not a laser.

## 5) Decisions

Resolved during ideation (what the evidence settles). Genuinely open,
scope-level choices are in §6.

| #   | Decision                                                     | Choice                                                                                                                                                         | Rationale                                                                                                                                                                |
| --- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Keep the product goal?                                       | Yes — live pulse on binding edges                                                                                                                              | Most on-brand "coordination, visualized"; research prior independently recommends it.                                                                                    |
| 2   | Animation primitive                                          | CSS `offset-path` + `offset-distance` driven by `motion` (primary); SVG `<animateMotion>` fallback                                                             | Both trace the **exact** bezier; motion gives clean fade-out + reduced-motion + unmount cleanup.                                                                         |
| 3   | Use motion 12.42 `path`/`arc()` (the ticket's cited unlock)? | **No**                                                                                                                                                         | Verified in installed `motion-dom@12.42.0` d.ts: `path`/`arc()` curve the trajectory **between two x/y points**; they cannot follow an SVG path string. Wrong primitive. |
| 4   | What to visualize                                            | One pulse per delivered **`relay_message`**; not `relay_signal`; not session StreamEvents                                                                      | Relay envelopes are discrete; StreamEvents/signals are the firehose that would strobe.                                                                                   |
| 5   | Burst handling                                               | Coalesce **per edge** (single in-flight pulse per edge, short window); allow cross-edge concurrency                                                            | Prevents one wire strobing; concurrent distinct wires _are_ the fleet signal.                                                                                            |
| 6   | Reduced-motion behavior                                      | No traveling particle (static) for MVP                                                                                                                         | Simplest honest gate; Calm Tech.                                                                                                                                         |
| 7   | Join key                                                     | Server emits flow events keyed by binding participants (`{adapterId, agentId, direction}` or resolved `bindingId`); client does `bindings.find → binding:{id}` | Avoids fragile subject-string parsing and the sessionId↔agentId + DOR-335 identity hazards.                                                                              |
| 8   | MVP edge scope                                               | **Binding (adapter↔agent) edges only**                                                                                                                         | Those are the edges that render today and the traffic they represent is real and legible.                                                                                |

## 6) Open Questions (for SPECIFY)

1. **The enabling server broadcast — what traffic, and what is safe to surface?**
   The global stream carries only `relay.human.console.>`. MVP needs the server
   to broadcast the **binding-relevant** deliveries (adapter→agent inbound and
   agent→adapter outbound) as a lightweight event (new `relay_flow`, or an
   extension of `relay_message`) keyed by `{adapterId, agentId, direction}`.
   SPECIFY must decide: (a) reuse/extend `relay_message` vs a dedicated
   `relay_flow` event; (b) whether surfacing delivery metadata (no payload
   content needed — we only animate) has any privacy/access-control implication
   worth an ADR; (c) where in the relay pipeline the hook lives
   (`adapter-delivery.ts` is the delivery choke point). **Recommended default:**
   a new metadata-only `relay_flow` event (`{ bindingId?, adapterId, agentId,
direction, at }`, no payload) emitted at the adapter delivery boundary — keeps
   the console feed untouched and carries no message content.

2. **Agent↔agent flow — follow-up, not MVP?** The most literal reading of
   "watch your fleet communicate" is agent↔agent, but **no agent↔agent edge
   renders today** (only adapter↔agent bindings and namespace allow/deny).
   Surfacing agent↔agent traffic would require both a new topology edge type and
   broadcasting `relay.agent.*` traffic. **Recommended:** ship binding-edge flow
   first (real value, bounded), and file agent↔agent flow as a follow-up that
   pairs a new edge with its own broadcast. SPECIFY to confirm this split (and
   whether it changes DOR-167's size from 5, since the server work is the bulk).

## 7) Recommended Direction & Next Step

**Direction:** Build the pulse, but recognize DOR-167 as **server-broadcast +
client-animation**, scoped to the adapter↔agent **binding edges that already
render**. Server emits a metadata-only `relay_flow` event at the delivery
boundary, keyed by binding participants + direction. Client extends
`use-relay-event-stream` to write a short-lived per-edge activity entry into a
mesh store; `BindingEdge` subscribes by its own id and renders a single
`--color-primary` dot tracing its exact `edgePath` via CSS `offset-path` +
`offset-distance` (driven by `motion` for fade-out/cleanup), coalesced per edge,
LOD- and reduced-motion-gated. Explicitly **do not** use motion 12.42's
`path`/`arc()` (wrong primitive) and **do not** pulse `relay_signal` or session
StreamEvents.

**Next step:** Proceed to **SPECIFY**. The spec must (1) resolve Open Question 1
into a concrete server event + emit site (likely a draft ADR for the new
`relay_flow` broadcast), (2) confirm the binding-only MVP scope and re-check the
size estimate given the server work, (3) pin the per-edge coalescing window and
concurrent-pulse cap, and (4) define the activity-store shape and the
BindingEdge subscription. The client animation is low-risk once the wire exists.
