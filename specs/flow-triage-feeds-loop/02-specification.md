---
slug: flow-triage-feeds-loop
number: 262
created: 2026-06-25
status: specified
---

# A Self-Feeding, Self-Unblocking `/flow` Loop

**Status:** Draft
**Author:** Dorian (via `/flow:specify`)
**Date:** 2026-06-25

## Overview

This spec turns the `/flow` engine from a typed-and-prose **foundation** into a harness
that conforms, as far as a server-free harness can, to the `/flow` Charter
([`.agents/flow/CHARTER.md`](../../.agents/flow/CHARTER.md)). It lands the typed contracts
and the v1 prose-wiring that close the charter's three hard gaps (G3 never starves, G5
composable loops, G9 transport-agnostic) and lift most of the "partial" goals, while
explicitly deferring the unattended **running engine** to the P5 server build.

Two pillars, one architecture:

- **Pillar A: feed the loop.** Every shaping stage produces the readiness signal dispatch
  requires; the engine detects starvation instead of stopping silently.
- **Pillar B: never dead-end on a question.** Parked questions route on an
  identity-appropriate channel, are recorded durably, and resume by polling.
- **The architecture both ride on:** a **prioritized reconciler registry + scheduler** over
  a **normalized inbound event seam**, replacing the single monolithic drain.

## Background / Problem Statement

The 2026-06-25 conformance audit (`plans/flow-loop-system-revision.md` section 10, workflow
`wf_8d338ec8-3c8`) graded the running system against the 15 charter goals: **1 met, 11
partial, 3 gap.** Nearly every shortfall has one root cause: the `@dorkos/flow` decision
oracles (`selectDispatch`, `resolveInvolvement`, `evaluateAutoMerge`, `recoverOrphan`,
`shouldRespondToComment`, `resolveCommsChannel`) are typed and tested but have **zero
runtime callers**, and the loop is a single prose-driven drain. Concretely:

- **Starvation (G3, gap).** `dispatch.ts:222` makes `agent/ready` an unconditional
  eligibility requirement, but no stage skill applies it (the `linear-adapter` asserts
  TRIAGE does; `triaging-work` does not). `selectDispatch` returns a bare `[]` with no way
  to tell "done" from "starved." Live evidence: 34 Triage + 19 Backlog, 0 in flight.
- **Dead-end questions (G4, partial).** The `getInbox` poll-and-resume loop exists only as
  prose in `tending-tracker`; no running path invokes it. In shared-account mode the only
  notify mechanism (`assignToHuman`) is a no-op, so a parked question is unseen.
- **Monolithic loop (G5, gap).** There is no reconciler registry, no scheduler, no `loops`
  config; the Pulse drain is one vertical prose loop and ships `enabled: false`.
- **No event seam (G9, gap).** The named `TrackerEvent` type exists only in the charter;
  ingestion is a prose poll of `getInbox`, with no transport abstraction to swap.

## Goals

Close or materially advance these charter goals (full text in the charter):

- **G3 never starves** (gap -> met): readiness produced at every stage boundary; starvation
  detected and surfaced.
- **G5 composable control loops** (gap -> met as typed contract + v1 prose): the reconciler
  registry, scheduler, and `loops` config.
- **G9 transport-agnostic ingestion** (gap -> met as typed seam): the `TrackerEvent` union +
  `InboundTransport` interface + `PollingTransport`.
- **G4 never dead-ends** and **G10 identity-mode-agnostic** (partial -> met for the polled
  path): identity-aware comms, the `comment-and-nudge` channel, and the poll-based resume
  reconciler.
- **G6 / G7 / G13** (partial -> advanced): persist + read the `FlowRun` record, wire
  `recoverOrphan`, and add a `/flow:status` surface.
- **G14 operator-overridable** (partial -> advanced): pause/resume, per-reconciler
  enable/reprioritize via config, and a reclaim/redirect path.
- **G8 / G12** (partial -> tightened): widen the tracker-confinement guard; make the
  calibration floor non-trimmable (`alwaysAsk` `.min(1)`).
- **G15 one documented unit** (partial -> met): the published guide series.

## Non-Goals (deferred to the P5 server build, DOR-88/89)

The **running engine** is out of scope. This spec lands the typed contracts and wires the
v1 prose modes to follow them; it does **not** build:

- The always-on server scheduler that executes the reconcilers unattended. v1 invokes the
  reconciler model from prose (the drain runs recovery -> inbox/resume -> dispatch in
  priority order); the continuous autonomous runner is P5.
- **Atomic concurrency** (fencing token, heartbeat, atomic multi-claim, stall-detector).
  v1 stays `concurrency: sequential`, WIP-1.
- **Approval detection + auto-merge execution** (resume-on-approval). v1 keeps the manual
  `/flow:done` after the human merges.
- The **webhook transport**. v1 ships `PollingTransport` + the seam; the webhook producer is
  the deferred drop-in (it needs an inbound endpoint we do not have).
- **Linear Agent Accounts** (`actor=app`) as the two-account backend (DOR-102).
- Re-triaging the current 34 Triage items (a separate operational `/flow:triage` drain).

## Technical Dependencies

- `@dorkos/flow` (`packages/flow/src/`): the typed engine that gains the new contracts.
  Existing modules: `dispatch.ts`, `comms.ts`, `comment-response.ts`, `calibration.ts`,
  `identity.ts`, `flow-run.ts`, `gates.ts`, `work-item.ts`, `config-schema.ts`.
- `zod` + `z.toJSONSchema` (the `buildConfigJsonSchema` bridge) for the new config blocks
  and `config.schema.json` regeneration.
- The `linear-adapter` skill (the v1 `PMClient`): the only tracker I/O surface; gains the
  `agent/ready` write on triage/decompose and the `getInbox` shape the `PollingTransport`
  consumes.
- Vitest (`packages/flow/src/__tests__/`) for the new oracle + interface tests.
- Fumadocs (`docs/`, `apps/site`) for the guide series.

## Detailed Design

### 1. Readiness production (Pillar A; G3)

- **`triaging-work`** Path B Accept applies `agent/ready` + the `stage/*` label via the
  adapter when work is accepted (both routes: simple -> EXECUTE as a `task`, and complex ->
  IDEATE). Per the full-autonomy posture (charter G2), readiness is applied broadly;
  simple-vs-complex selects the **path**, not whether readiness is applied.
- **`decomposing-work`** applies `agent/ready` to the execute-ready tasks it emits.
- **`linear-adapter`** prose reconciled so the asserted "TRIAGE applies `agent/ready`"
  contract (SKILL.md:201-202) is actually fulfilled.

### 2. Starvation detection (Pillar A; G3)

- Add **`classifyDispatchOutcome(items, options)`** to `dispatch.ts`, returning
  `{ picked, eligibleCount, starved, shapeableCount }` where `shapeableCount` counts
  dispatchable-category items behind the `agent/ready` gate (backlog/triage items lacking
  it). Export from `index.ts`; unit-test the empty-with-shapeable case.
- Wire it into every mode: `/flow auto` reports "0 ready, N shapeable: run a triage pass?"
  instead of silently setting `ready: 0`; the `flow-loop.mjs` Stop hook surfaces a
  starved-with-shapeable reason rather than "drain complete"; the orchestrator cold-start
  defaults to recommending triage when starved.

### 3. The reconciler registry + scheduler (G5; charter L0)

A typed, table-driven promotion surface in `@dorkos/flow`:

```ts
interface Reconciler {
  id: string; // 'triage' | 'dispatch' | 'inbox' | 'recovery' | 'hygiene' | 'review'
  defaultConfig: ReconcilerConfig; // { enabled, priority, intervalMs, ...loop-specific }
  isDue(ctx: ReconcileContext): boolean; // cadence + predicate
  run(ctx: ReconcileContext): Promise<ReconcileResult>; // idempotent; re-derives truth, then acts
}
```

- A **registry** of reconcilers and a generic **scheduler** that, each tick, walks the
  registry in **priority order**, runs every `enabled` + `isDue` reconciler, and resolves
  same-item contention by priority (recovery before dispatch).
- The reconcilers wrap the **existing oracles** (dispatch -> `selectDispatch`, inbox ->
  `shouldRespondToComment`, recovery -> `recoverOrphan`, review -> `evaluateAutoMerge`,
  hygiene -> `classifyDispatchOutcome`), plus triage. No new decision logic.
- A **`loops` config block** keyed by reconciler `id`
  (`loops: { dispatch: { enabled, priority, ... }, inbox: { ... }, ... }`) added to
  `FlowConfigSchema`, regenerated into `config.schema.json`. This map is the extension seam:
  add a loop = register it; remove = `enabled: false`.
- **v1 wiring:** the `/flow auto` and `flow-drain` prose loops are rewritten to follow the
  registry order (recovery -> inbox/resume -> dispatch) instead of the single vertical
  drain. The continuous autonomous runner that executes this unattended is P5; the typed
  registry + scheduler are landed and tested now as the promotion surface.

### 4. The normalized inbound event seam (G9; charter B0)

- A typed **`TrackerEvent`** discriminated union in `@dorkos/flow`
  (`comment.added | item.readied | item.assigned | item.state-changed | mention |
item.created`), with the existing `InboxComment` becoming the payload of `comment.added`.
- An **`InboundTransport`** interface (`poll()` / `subscribe()` -> `TrackerEvent[]`) with a
  v1 **`PollingTransport`** implementation wrapping the adapter's `getInbox` + a durable
  watermark cursor. The webhook producer is a deferred drop-in.
- **Events are triggers, not truth:** on any event, the consuming reconciler re-reads the
  item's current state via the `PMClient` before acting. A `dedupeKey` + the
  skip-self-authored (`identity.marker`) rule keep reconcilers idempotent.
- An **`ingestion`/`transport`** config block selecting the producer (poll vs webhook) +
  poll interval, proving the swap is a config edit. The inbox reconciler consumes
  `TrackerEvent[]` from the injected transport.

### 5. Identity-mode-aware question routing + resume (Pillar B; G4, G10)

- **`resolveCommsChannel`** gains an `identityMode` input and a third channel,
  **`comment-and-nudge`**: unattended + shared -> comment + `agent/needs-input` (durable
  record) + an out-of-band nudge **promoted to primary** (Relay/Telegram/chat); unattended +
  two-account -> `comment-and-assign`; live session -> `interactive` (any mode).
- Promote `involvement.nudge` from courtesy-only to the primary attention channel in shared
  mode (`config-schema.ts` `NudgeSchema` + `comms.ts`).
- The **inbox/resume reconciler** (section 3) polls `getInbox` for `agent/needs-input`
  items, applies `shouldRespondToComment` rule 3 (the `identity.marker` disambiguates a
  non-agent reply in shared mode), then re-attaches the worktree and resumes via
  `--resume <sessionId>` or thread-replay. Identity-mode-agnostic by construction.
- Resolve `identity.agent: "auto"` via the adapter `getCurrentUser` once per tick and pass
  the resolved `Identity` into `classifyOwnership` / `shouldRespondToComment` /
  `resolveCommsChannel`, so the typed mode-agnostic oracles are actually fed.

### 6. The `FlowRun` record + recovery wiring (G6, G7, G13)

- A typed **`FlowRun` writer/reader** for `flow-state.json` following the schema in
  `flow-run.ts` (drop the ad-hoc `stage/trigger/depth/gate/tasksFile` fields or add them to
  the schema). The claim/worktree step persists it (issueId, identifier, sessionId,
  worktreePath, branch, workerPid, attemptCount, status) and updates status at each stage
  transition; stale records for closed issues are reconciled or garbage-collected.
- The **recovery reconciler** (section 3) lists `agent/claimed` + `started` +
  not-`needs-input` items, reads their `FlowRun` + liveness probes, calls `recoverOrphan`,
  and acts on the `RecoveryAction` (resume the captured `sessionId` at HEAD, restart-clean,
  escalate, or re-derive). Runs at the head of each drain tick.

### 7. Observability + operator override (G13, G14)

- A **`/flow:status`** command (and a `status` intent in the orchestrator) that renders,
  from the tracker + `flow-state.json` + `auto-run.json`: every claimed/in-flight item
  (worktree, branch, sessionId), every parked `needs-input` question, and the per-item
  assumption trail.
- **`/flow pause`** / resume that toggles both the `auto-run.json` sentinel and the Pulse
  cron from one place; per-reconciler enable/reprioritize via the `loops` config; a
  documented reclaim/redirect path (an `agent/paused` marker the running tick honors at
  stage boundaries, plus the existing ownership-policy reassignment).

### 8. Honesty + guard fixes (G8, G12)

- Widen the `tracker-confinement` guard's roots to also scan `packages/flow/src/**`
  (excluding its own test), `.dork/tasks/flow-drain/**`, and `.claude/hooks/flow-loop.mjs`,
  so the autonomous surfaces are guarded; decide and document the `'linear'` enum carve-out
  in `TrackerSchema` / `ProvenanceTrackerSchema`.
- Make the calibration floor non-trimmable: `alwaysAsk: z.array(...).min(1)` in
  `config-schema.ts`; add a test asserting `alwaysAsk: []` fails to parse. (The charter
  build-commitment overstatement was already corrected.)

### 9. Documentation (G15)

The guide series in `docs/guides/flow/` (Fumadocs MDX), in the reference house style
(comparison tables, approach cards with pros/cons, dials, decision guides): _What /flow is_,
_Driving it manually_, _Turning on autonomy_, _The dials_, _How it works_ (reconcilers +
seams). Register in `docs/guides/meta.json`; update `slash-commands.mdx` to surface the
`/flow` family; enumerate README/SPEC/CHARTER as docs members in the bundle manifest. Honesty
gate (G12): the _Turning on autonomy_ guide ships only when the capability is real.

## User Experience

- **`/flow auto` never stops silently.** When the ready queue empties with shapeable work
  behind it, it reports "0 ready, N shapeable: run a triage pass?" and offers to run one.
- **A parked question resumes itself.** Unattended, a `stop-and-ask` posts a readable
  question comment, applies `agent/needs-input`, and (shared mode) pings you out of band;
  your reply is detected on the next poll and the run resumes where it left off, with no
  manual re-trigger.
- **`/flow:status`** gives one pane: what is in flight, what is parked on you, and why each
  autonomous decision was made.
- **You stay in control.** `/flow pause` halts every mode from one place; disabling or
  reordering a loop is a `loops` config edit; reassigning an item releases it cleanly.

## Testing Strategy

- **Unit:** `classifyDispatchOutcome` (empty-with-shapeable, done, picked); the `Reconciler`
  registry + scheduler (priority order, due-gating, contention); the `TrackerEvent` union +
  `PollingTransport`; `resolveCommsChannel` with `identityMode` (all three channels x shared
  / two-account); the `FlowRun` writer/reader round-trip; `recoverOrphan` wiring via a fake
  registry; `alwaysAsk: []` rejected.
- **Interchangeability (G9):** feed the **same** `TrackerEvent[]` through a fake polling
  producer and a fake webhook producer and assert identical reconciler output (the seam's
  defining test).
- **Guard (G8):** the widened `tracker-confinement` test fails on a planted
  `mcp__linear__` string in `packages/flow/src`, the drain task, and the hook.
- **Integration:** drive a seeded item triage -> ready -> dispatch -> park -> reply -> resume
  through the reconciler order with a stubbed adapter, proving readiness production and
  poll-based resume without per-stage human starts.
- **Mocking:** the `linear-adapter` is stubbed (`FakeAgentRuntime`-style); no live tracker.

Each test carries a purpose comment; the starvation and interchangeability tests are written
to fail on the pre-change code.

## Performance Considerations

Reconcilers re-derive current state from the tracker each tick; the `PollingTransport`
watermark cursor bounds reads to deltas. The poll interval is per-loop config (fast inbox,
slow hygiene), so responsiveness and tracker-API load are tunable without code change.
Idempotent reconcilers + `dedupeKey` make a missed or duplicated tick harmless.

## Security Considerations

All tracker I/O stays confined to the `linear-adapter` (the widened guard enforces it). The
`agent/needs-input` durable record carries the `identity.marker`; the resume path acts only
on a non-agent reply (rule 3), preventing self-reply loops. No new outbound endpoint is
opened (poll, not webhook), so there is no inbound attack surface. The calibration floor
becomes non-trimmable, so autonomy cannot be silently widened past the floor.

## Documentation

See section 9. Plus: update `SPEC.md` to document the reconciler registry + event seam as
typed v1 contracts (promotion surface); keep the charter and `contributing/flow-engine.md`
in sync; the _Turning on autonomy_ guide is gated on the capability being real.

## Implementation Phases

Per the gap register's prioritized build order (v1-harness scope):

- **Phase 1 (keystone):** readiness production (section 1) + `classifyDispatchOutcome` +
  mode wiring (section 2). Unblocks the loop. **Highest priority.**
- **Phase 2 (backbone):** the `Reconciler` interface + registry + scheduler + `loops` config
  (section 3); rewrite the v1 drain to follow it.
- **Phase 3 (durability):** the `FlowRun` writer/reader + `recoverOrphan` wiring (section 6).
- **Phase 4 (questions):** the `TrackerEvent` seam + `PollingTransport` (section 4) and the
  identity-aware comms + inbox/resume reconciler (section 5).
- **Phase 5 (control + honesty):** `/flow:status` + operator override (section 7); the
  guard + floor fixes (section 8).
- **Phase 6 (docs):** the guide series (section 9), parallelizable.
- **Deferred (P5, DOR-88/89):** the unattended running scheduler, atomic concurrency,
  approval detection, the webhook transport.

## Open Questions

- ~~Should `/flow:262` build the P5 running engine, or only the v1-harness bucket?~~
  **(RESOLVED)** Answer: v1-harness bucket only; the running server engine is deferred to P5
  (DOR-88/89). Rationale: the gap register draws the v1/P5 line cleanly, and coupling the
  harness fixes to the server build would make the spec unshippable in increments.
- ~~Is readiness gated by simple-vs-complex (the earlier hybrid lean)?~~ **(RESOLVED)**
  Answer: no; under full autonomy (charter G2), readiness is applied to all accepted work;
  simple-vs-complex selects the path. Rationale: operator decision A0, supersedes the hybrid.
- Open: the exact default `priority` ordering and per-loop `intervalMs` defaults for the
  `loops` config (a tuning detail; resolve in DECOMPOSE with sensible defaults:
  recovery > inbox > dispatch > triage > hygiene).

## Related ADRs

Seeded with this spec (status: draft, `extractedFrom: flow-triage-feeds-loop`):

- **ADR-0286** Readiness is produced at every stage boundary (the dispatch fuel contract).
- **ADR-0287** Composable reconciler registry + scheduler (supersede the monolithic drain).
- **ADR-0288** Normalized, transport-agnostic inbound event seam (poll-first).
- **ADR-0289** Identity-mode-aware, poll-based human-in-the-loop question routing.

## References

- Charter: [`.agents/flow/CHARTER.md`](../../.agents/flow/CHARTER.md) (the 15 goals).
- Plan + gap register: [`plans/flow-loop-system-revision.md`](../../plans/flow-loop-system-revision.md)
  (section 10; audit run `wf_8d338ec8-3c8`).
- Ideation: [`01-ideation.md`](./01-ideation.md) (decisions A0-A5, B0-B6, L0, S0).
- Research: [`research/20260625_hitl_question_routing_async_resume.md`](../../research/20260625_hitl_question_routing_async_resume.md).
- Contract: [`.agents/flow/SPEC.md`](../../.agents/flow/SPEC.md) (#257, the v1 harness).
- Related tracker work: DOR-88/89 (P5 server engine), DOR-102 (Linear Agent Accounts),
  DOR-133 (assemble `/flow` into a package).
