# /flow Charter: goals the system must meet

> The north star for the `/flow` engine. This document leads with **what `/flow`
> must be**, as a set of high-level goals, each paired with a **conformance
> criterion** (how we know the system satisfies it). [`SPEC.md`](./SPEC.md) is the
> technical contract that implements these goals; [`README.md`](./README.md) is the
> operator manual. The system is **audited against this charter**: every goal is
> either met (with evidence) or has an open gap with a plan to close it.
>
> Status: **locked v1.0** (2026-06-25). Refine via an explicit charter revision.

## How to read this

Each goal is a one-line **principle** plus a **Conformant when** line that an audit
can check. A goal is not aspirational prose; it is a test the system passes or fails.

**Precedence (when goals tension).** The calibration floor, the always-on review
gate, and operator override (G12, G14) are **inviolable**. Within them, the system
pursues **maximal autonomy** (G2). Safety and operator control beat autonomy, always.

---

## Group 1: the loop

**G1. One spine, single source of truth.** The stage model
(`CAPTURE → TRIAGE → IDEATE → SPECIFY → DECOMPOSE → EXECUTE → VERIFY → REVIEW → DONE`)
is the only definition of "where work is," and every fact lives in exactly one place.
_Conformant when:_ every tracker state, label, spec status, and loop phase is
**projected** from the stage (matched on a state **category**, never a display name);
and each fact has one home (filesystem = canon, tracker = state + pointers), never
duplicated, never drifting.

**G2. Autonomous by default, manually drivable, uncertainty-gated.** The engine runs the
full spine on its own, and every stage is also a first-class manual command.
_Conformant when:_ no human is required to _start_ any stage (the loop shapes and
executes end to end); every stage is **also** reachable as a manual `/flow:<stage>`
command sharing **one code path** with the autonomous trigger (one skill, two triggers,
no divergence); and the only things that pull in a human are the calibration floor
(irreversible / outward-facing / spend / scope-change), genuine uncertainty, and the
always-on review gate. Involvement is never stage-gated.

**G3. The loop never starves.** There is always either progress or a clear, surfaced
reason there is not.
_Conformant when:_ readiness is produced at every stage boundary, and an empty
dispatch queue with shapeable work behind it is detected and surfaced, never silent.

**G4. The loop never dead-ends on a question.** A parked question always has a path
back to progress.
_Conformant when:_ every `stop-and-ask` has a durable record, an identity-appropriate
channel, and a poll-based resume path that requires no babysitting.

**G5. Composable control loops.** The loop is a set of small, single-responsibility
reconcilers, not one monolith.
_Conformant when:_ triage, dispatch, inbox/resume, WIP/recovery, hygiene (and later
review/merge) are independent, idempotent reconcilers in a registry, each with its own
`priority` and config block, run in priority order by one generic scheduler. Adding a
loop is registering one; removing it is disabling it in config.

**G6. Durable and resumable.** Every unit of work survives a crash, restart, or
context compaction.
_Conformant when:_ the checkpoint is the git commit + the session + the durable
`agent/*` labels; recovery re-derives from ground truth, never from ephemeral memory.

**G7. Concurrency-safe.** Multiple reconcilers and agents run without corrupting each
other or duplicating work.
_Conformant when:_ every claimable unit is claimed before work begins (claims are
respected, never double-claimed); each work item has one writer (one worktree, one
session); concurrent ticks are idempotent and WIP-capped; and a stalled or orphaned
claim is recovered, never silently re-run.

## Group 2: the seams (agnosticism)

**G8. Tracker-agnostic.** The engine speaks a generic work model and generic verbs.
_Conformant when:_ zero tracker strings exist outside the one adapter (enforced by a
guard); the generic layer sees only `WorkItem` + capability verbs.

**G9. Transport-agnostic ingestion.** The engine reacts to a normalized inbound event
stream; how events arrive is a swappable detail.
_Conformant when:_ polling and webhooks are interchangeable producers of the same
`TrackerEvent`; swapping the transport changes no engine code and no reconciler.

**G10. Identity-mode-agnostic.** The system works whether the agent shares the human's
account or has its own.
_Conformant when:_ both shared and two-account modes have a working ask / notify /
detect / resume path; account model is config; no path assumes two identities.

**G11. Server-optional.** Manual use needs no server; autonomy degrades gracefully
where no always-on or exposed server exists.
_Conformant when:_ manual stages and the terminal drain run server-free; unattended
autonomy uses polling (never an inbound webhook we cannot receive); nothing core
requires infrastructure we do not have.

## Group 3: trust and control

**G12. Honest and safe by design.** The operator always knows what happened and what
the system is waiting on.
_Conformant when:_ the review gate and calibration floor are always on; there is no
silent merge, no hidden truncation, and no overstated autonomy in the product or its
docs.

**G13. Legible and observable.** Full autonomy is only acceptable if it is visible.
_Conformant when:_ the operator can inspect, at any time, every reconciler's state,
every claimed or in-flight item, every parked question, and the recorded **rationale**
(the assumption trail) behind each autonomous decision.

**G14. Operator-overridable.** Autonomy is never a loss of control.
_Conformant when:_ the operator can pause the loop, disable or reprioritize any
reconciler, redirect or reclaim any item, and take over a session at any point, without
fighting or corrupting the system.

## Group 4: delivery

**G15. One installable, documented unit.** `/flow` is a self-contained, versioned
plugin whose skills, config, templates, and **docs travel together**.
_Conformant when:_ the package ships first-class documentation (the guide series, in
the house style) that is discoverable and accurate to current capability.

---

## Conformance

The `/flow` system is measured against G1-G15. A periodic **conformance audit**
records, per goal: **met** (with evidence) or **gap** (with the work that closes it).
The current audit and gap register live in
[`plans/flow-loop-system-revision.md`](../../plans/flow-loop-system-revision.md); the
active revision that closes the highest-priority gaps is spec
[`flow-triage-feeds-loop`](../../specs/flow-triage-feeds-loop/01-ideation.md) (#262).

## Build commitments (not charter goals)

These shape _how we build_, not _what the system is_, so they live here as commitments
rather than as audited goals:

- **Promotable, not rewritten.** The v1 prose+typed harness is the promotion surface
  for the future server build. The contracts that **exist in v1 today** (the config
  schema, the `PMClient` verbs, the `FlowRun` record, and the typed decision oracles)
  graduate into the server unchanged. The **event model and the reconciler registry do
  not exist yet**: the revision (spec #262) adds them as typed contracts, which then
  graduate likewise. Recorded in [`SPEC.md`](./SPEC.md) and the revision plan.
