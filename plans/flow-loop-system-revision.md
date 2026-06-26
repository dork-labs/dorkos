# /flow Loop-System Revision: the comprehensive plan

> One consolidated plan for revising the `/flow` loop system, anchored on a goals
> charter and a conformance discipline. Produced 2026-06-25 from a deep-dive design
> session. Pairs with [`.agents/flow/CHARTER.md`](../.agents/flow/CHARTER.md) (the
> goals) and spec [`flow-triage-feeds-loop`](../specs/flow-triage-feeds-loop/01-ideation.md)
> (#262, the active revision). Research:
> [`research/20260625_hitl_question_routing_async_resume.md`](../research/20260625_hitl_question_routing_async_resume.md).

## 1. The problem, in one paragraph

The `/flow` engine is well-designed on paper (spec #257) but does not actually run
unattended. Three structural reasons: (1) **no stage applies `agent/ready`**, so the
dispatch loop is permanently starved (0 in flight while 53 items wait); (2) **parked
questions dead-end** because the resume-on-reply detector is designed but not running,
and the comms path assumes a separate human account; (3) the loop is a **single
monolithic drain**, which couples concerns that want different cadences (claiming work
vs detecting a reply vs recovering a stall). This plan fixes all three by adopting a
**goals-first** discipline (a charter the system must conform to) and a
**reconciler-based** architecture (small single-responsibility loops over a normalized
event seam).

## 2. Goals (the charter)

The 14 goals live in [`.agents/flow/CHARTER.md`](../.agents/flow/CHARTER.md), grouped
as: **the loop** (one spine + single source of truth; autonomous + uncertainty-gated;
never starves; never dead-ends; composable reconcilers; durable), **the seams**
(tracker-, transport-, identity-mode-agnostic; server-optional), **trust and control**
(honest + safe; legible + observable; operator-overridable), and **delivery** (one
documented unit). Precedence: the calibration floor, the review gate, and operator
override are inviolable; within them, maximal autonomy. Each goal carries a "Conformant
when" test. (Promotability is a build commitment, not a charter goal.) The charter is the
contract the system is audited against; everything below serves it.

## 3. Target architecture

### 3.1 Composable reconcilers (Goal G5)

Replace the monolithic drain with independent, idempotent reconcilers, each watching
one slice of state, each re-deriving truth from the tracker/filesystem (never trusting
an event payload), each with its own cadence and priority:

| Reconciler       | Watches                             | Decision oracle (typed)        | Action                               | Cadence |
| ---------------- | ----------------------------------- | ------------------------------ | ------------------------------------ | ------- |
| **triage**       | native-Triage / unlabeled items     | (triage skill rubric)          | classify, route, ready or surface    | slow    |
| **dispatch**     | `agent/ready` eligible work         | `selectDispatch`               | claim + carry to the review gate     | main    |
| **inbox/resume** | `agent/needs-input` items + replies | `shouldRespondToComment`       | resume the parked session            | fast    |
| **wip/recovery** | `agent/claimed` items               | `recoverOrphan`                | resume / restart-clean / escalate    | medium  |
| **hygiene**      | queue depth, project state, labels  | `classifyDispatchOutcome`(new) | nudge a triage pass; reconcile drift | slow    |
| **review/merge** | approved PRs at the review gate     | `evaluateAutoMerge`            | merge + close + teardown (deferred)  | medium  |

The reconcilers are **the existing typed oracles wired to triggers**, not new logic.

**Registry + scheduler (the runner).** The sub-loops live in a **registry**; a single
generic **scheduler** is the "system that runs them in order and decides what to do."
Each reconciler implements one interface and declares:

- an `id`, a **`priority`** (execution order + contention winner), and its **own config
  block** (`enabled`, cadence/`intervalMs`, limits, thresholds);
- a **predicate** (is there work for me, given current state?), a **decision** (the typed
  oracle), and an **action** (via the adapter).

```ts
interface Reconciler {
  id: string;
  defaultConfig: ReconcilerConfig; // enabled, priority, intervalMs, ...loop-specific
  isDue(ctx): boolean; // cadence + predicate
  run(ctx): Promise<ReconcileResult>; // idempotent; re-derives truth, then acts
}
```

On each tick (a timer wake or an inbound `TrackerEvent`), the scheduler walks the
registry **in priority order**, runs every reconciler that is `enabled` and `isDue`, and
resolves same-item contention by priority (recovery before dispatch). **Pluggable by
construction:** adding a sub-loop is registering an entry; removing it is `enabled:
false` in config; the runner and the other loops never change (Goal G5). Per-loop cadence
(fast `inbox`, slow `hygiene`) lives in each loop's config block, so one ordered runner
still gives every loop its own rhythm.

**Config shape.** The flow config gains a `loops` map keyed by reconciler `id`:
`loops: { dispatch: { enabled, priority, wipCap, ... }, inbox: { enabled, priority,
intervalMs }, hygiene: { ... }, ... }`. This map **is** the extension seam; the typed
`Reconciler` interface + the registry are the promotion surface (the P5 server runs the
same registry).

**Where the runner lives.** Manual `/flow auto` runs the scheduler inline (dispatch +
inbox loops, interactive comms). The Pulse seat fires the scheduler on its cron; the
scheduler, not the cron, decides which loops are due. One runner, many loops, two host
environments.

### 3.2 The normalized inbound event seam (Goals G8, G9)

This is the dual of the outbound `PMClient`. The `PMClient` is how the engine **acts
on** the tracker; a `TrackerEventSource` is how the tracker **informs** the engine.

- **One normalized envelope:** `TrackerEvent { kind, itemId, actor, occurredAt,
receivedVia, dedupeKey, raw }`. Kinds: `comment.added`, `item.readied`,
  `item.assigned`, `item.state-changed`, `mention`, `item.created`.
- **Two interchangeable producers, one shape:** a **poller** (diffs adapter reads
  against a durable cursor; at-least-once; the v1 default, no endpoint needed) and a
  **webhook receiver** (push; needs a reachable endpoint/relay; deferred). Both emit
  identical `TrackerEvent`s; the engine cannot tell which produced one. **Swapping the
  transport changes no engine code** (G8).
- **Events are triggers, not truth.** On any event, the reconciler re-reads the item's
  current state via the `PMClient` before acting. This makes the system robust to
  duplicate, reordered, missed, and out-of-band events, and makes poll and webhook
  equivalent. Idempotent reconcilers + a `dedupeKey` + "skip self-authored (marker)
  events" handle the rest.
- **Confinement (G7):** the `TrackerEvent` type + the reconcilers are generic
  (`@dorkos/flow`, the promotion surface). Linear-specific parsing (webhook JSON, the
  optional `actor=app` AgentSession path) lives in the `linear-adapter`. No tracker
  string leaks into the generic layer.

### 3.3 The two pillars (Goals G3, G4, G10)

From spec #262, now framed as conformance work:

- **Pillar A: feed the loop (G3).** Every shaping stage applies readiness for its
  successor; a typed `classifyDispatchOutcome` distinguishes starved from done; triage
  gains a cross-impact lens; imports route through CAPTURE; a hygiene reconciler catches
  project drift.
- **Pillar B: never dead-end (G4, G9).** Identity-mode-aware comms (shared mode promotes
  the nudge to primary); poll-based, tracker-agnostic resume (one consumer of the event
  seam); a readable durable question record; a "waiting on you" surface. Linear Agent
  Accounts are the optional, adapter-confined two-account backend.

## 4. The goals-first method (how we keep the system honest)

1. **Charter** (done, draft): the 13 goals + conformance tests.
2. **Conformance audit:** for each goal, audit the current `/flow` system. Output a
   **gap register**: per goal, `met | partial | gap`, evidence, and the closing work.
3. **Revisions:** the gaps map to work. The known set: Pillar A + Pillar B + the
   reconciler refactor + the event seam (#262 and its DECOMPOSE). New gaps the audit
   surfaces get added.
4. **Re-verify:** after each revision lands, re-run the audit for the touched goals. The
   system is "done" when every goal is **met**.

This dogfoods `/flow`: we use the engine (and its stages) to improve the engine.

## 5. Documentation plan (Goal G15)

Three layers, all traveling with the eventual plugin:

- **Discovery:** each skill's frontmatter `description` (what `/help` and the command
  palette show). Keep crisp and task-oriented.
- **Usage + mastery:** a **guide series** in `docs/guides/flow/` (Fumadocs MDX, rendered
  at dorkos.ai/docs and reachable from the plugin's `homepage`), in the **house style**
  of the reference autonomy guide: a comparison table, A/B/C approach cards with
  pros/cons, a "dials" table, and a "which should I use" decision guide. Reproduce the
  visuals with Fumadocs components (Cards, Callout, Tabs, Steps, tables). Planned guides:
  _What /flow is_ (the spine), _Driving it manually_, _Turning on autonomy_ (the
  reference), _The dials_ (config), _How it works_ (architecture: reconcilers + seams).
- **In-repo canon:** `.agents/flow/CHARTER.md` (goals), `SPEC.md` (contract),
  `README.md` (operator manual), `contributing/flow-engine.md` (dev guide).

**Honesty gate (G12):** a guide ships only when its capability is real. The "Turning on
autonomy" guide lands **with** the #262 capability, not before (documenting a starved
loop as "runs while you sleep" would violate G11).

**Plugin packaging:** when `/flow` is assembled into its marketplace package (DOR-133),
the package `README.md` is the concise entry point and `homepage` points at the
dorkos.ai guide series. Claude Code surfaces the skill `description` fields and the
README; longer-form docs live at the homepage (no in-CLI long-doc renderer exists).

## 6. Execution strategy (including workflows)

**Dogfood through the `/flow` stages**, in an isolated worktree at EXECUTE (intent
stages stay in `main`). Where parallelism and independent verification pay off, use a
**multi-agent workflow**; otherwise work inline.

Recommended workflow use, by phase:

- **Conformance audit (immediate, high value):** a fan-out workflow, **one agent per
  goal** (15), each auditing the current `/flow` system against its goal and returning a
  structured `{ goal, status, evidence, gaps }`. Synthesize a gap register. This is a
  clean, bounded fan-out and is the natural first execution step once goals are locked.
- **Reconciler implementation (later):** the shared core (the `TrackerEvent` model,
  `classifyDispatchOutcome`, the identity-mode comms input, config keys) lands first,
  **sequentially**; then the individual reconcilers, which are fairly independent, can be
  implemented by a **parallel workflow** (one agent per reconciler, worktree-isolated).
- **Doc generation (later):** a workflow generating the guide series in parallel (one
  agent per guide), each in the house style, gated by the honesty rule.
- **Adversarial review (before merge):** a review workflow over the diff, verifying each
  change against the charter goals it claims to satisfy.

Solo (no workflow) for: the charter refinement, the goals-first spec edits, single-file
fixes, and anything already verified.

## 7. Sequence

1. **Lock the goals** (operator refines the charter). [gate]
2. **Run the conformance audit** workflow -> gap register (appended here).
3. **Finalize #262** SPECIFY: fold the reconciler architecture + event seam into the
   spec; seed ADRs (readiness ownership; dispatch starvation; the inbound event seam +
   reconcilers; identity-mode-aware poll-based question routing).
4. **DECOMPOSE #262** into the shared core + per-reconciler tasks.
5. **EXECUTE** (worktree; shared core first, then parallel reconcilers).
6. **VERIFY + re-audit** the touched goals; **document** the now-real capabilities.
7. **Package** (DOR-133) once the loop conforms.

## 8. Artifact map

| Artifact                                             | Role                                                         | Status                 |
| ---------------------------------------------------- | ------------------------------------------------------------ | ---------------------- |
| `.agents/flow/CHARTER.md`                            | the 13 goals + conformance tests                             | draft v0.1             |
| `plans/flow-loop-system-revision.md` (this)          | the comprehensive plan + gap register                        | living                 |
| `specs/flow-triage-feeds-loop/01-ideation.md` (#262) | the active revision (two pillars + reconcilers + event seam) | ideation               |
| `.agents/flow/SPEC.md` (#257)                        | the technical contract that implements the charter           | implemented; to extend |
| `docs/guides/flow/*`                                 | the user-facing guide series (house style)                   | not started            |
| DOR-102                                              | Linear Agent Accounts (optional two-account backend)         | triage; deferred       |
| DOR-133                                              | assemble `/flow` into a marketplace package                  | triage                 |

## 9. Open decisions for the operator

1. **The goals themselves** (G1-G15): confirm or refine. They are the foundation; the
   audit and spec follow from them.
2. **Execution approach:** confirm using a workflow for the conformance audit (and later
   the parallel reconciler build), versus working inline.
3. **Charter home:** `.agents/flow/CHARTER.md` (travels with the plugin) vs `meta/`
   (vision docs). Current choice: `.agents/flow/` so it ships with the package.

## 10. Conformance audit + gap register (2026-06-25)

Method: 15 read-only agents, one per goal, each grading the **running** system against
its "Conformant when" test with file:line evidence (workflow `flow-conformance-audit`,
run `wf_8d338ec8-3c8`).

### Scorecard

| Goal                           | Status      | Verdict (one line)                                                                                                                                |
| ------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 one spine / single source   | **partial** | reads project on category; the projection **write** is prose-only; spec status is file-count derived, not stage-projected                         |
| G2 autonomous / manual / gated | **partial** | manual side + uncertainty oracle are real; "autonomous end to end" is prose-driven, Pulse disabled, DONE needs a manual start                     |
| G3 never starves               | **gap**     | no stage produces `agent/ready` (the unconditional gate); no starvation detection; modes stop silently                                            |
| G4 never dead-ends             | **partial** | record/channel/resume designed + tested; the poll-based resume is wired into no running loop                                                      |
| G5 composable control loops    | **gap**     | no reconciler registry, no scheduler; the loop is one monolithic prose drain                                                                      |
| G6 durable / resumable         | **partial** | substrates exist; `recoverOrphan` has zero callers; `flow-state.json` written/read by no code                                                     |
| G7 concurrency-safe            | **partial** | "safe" only by being sequential WIP-1; claim not atomic, WIP cap not enforced cross-tick                                                          |
| G8 tracker-agnostic            | **partial** | guard passes but scopes only skills+commands (not the engine pkg/hook/drain); `'linear'` literals in generic enums                                |
| G9 transport-agnostic          | **gap**     | no `TrackerEvent` type, no transport seam, webhooks deferred; only a prose poll                                                                   |
| G10 identity-mode-agnostic     | **partial** | detect + interactive ask work; `resolveCommsChannel` is identity-blind; shared-mode notify + resume unbuilt                                       |
| **G11 server-optional**        | **met**     | manual + terminal drain are genuinely server-free; the one server path is optional, off by default, honestly disclosed                            |
| G12 honest and safe            | **partial** | strong posture (always-on review gate, no silent merge); but the floor is config-trimmable (`alwaysAsk: []` parses) so "inviolable" is unenforced |
| G13 legible / observable       | **partial** | tracker-projected facts inspectable; no reconciler state, no run-record writer, no `/flow:status` surface                                         |
| G14 operator-overridable       | **partial** | pause + re-derive work; "disable/reprioritize any reconciler" has no surface (no registry); reclaim only at tick boundary                         |
| G15 one documented unit        | **partial** | bundle docs are first-class + accurate; the published guide series (`docs/guides/*.mdx`) has zero `/flow` content                                 |

**Tally: 1 met, 11 partial, 3 gap.**

### The single root cause

Nearly every "partial" reduces to one fact: the engine is **designed, typed, and tested,
but unwired.** The `@dorkos/flow` oracles (`selectDispatch`, `resolveInvolvement`,
`evaluateAutoMerge`, `recoverOrphan`, `shouldRespondToComment`, `resolveCommsChannel`,
`classifyOwnership`) have **zero runtime callers**; the package is imported by no app.
Stage-to-stage advancement is prose the LLM follows ("carry it through the stages"); the
only code in the loop is the fail-open Stop hook (it just keeps the terminal alive). The
Pulse seat, the only autonomous executor, ships `enabled: false` and is a four-line prose
stub. So ~10 of the 11 partials collapse to: **the running engine that would invoke these
oracles does not exist yet.** This is consistent with the v1 design (SPEC names the running
engine as the P5 server build), but it means the charter's operational goals are not met today.

### Two buckets of closing work

**(a) v1-harness-closable** (prose + typed + config, mostly spec #262): readiness production
(G3), the starvation classifier (G3), identity-aware comms + the `comment-and-nudge` channel
(G10), the inbox/resume reconciler wired into the drain (G4/G10), the `flow-state.json`
writer/reader + `recoverOrphan` wiring (G6/G7/G13), the reconciler registry + scheduler +
`loops` config (G5/L0), the `TrackerEvent` seam + polling transport (G9/B0), a `/flow:status`
surface (G13), the operator-override surface (G14), the docs guide series (G15), and the
honesty/guard fixes (G8/G12).

**(b) P5-server-engine** (DOR-88/89): the typed scheduler actually executing the oracles in
an unattended loop (this alone flips most partials to met), atomic claim + fencing +
stall-detector (G7), approval detection + auto-merge execution / resume-on-approval (G2/G12),
the webhook transport (G9, optional), and Linear Agent Accounts (G10/DOR-102).

### Three confirmed gaps

- **G3 never starves** -> spec #262 A1 (every shaping stage applies `agent/ready`) + A2 (typed
  `classifyDispatchOutcome` wired into all modes).
- **G5 composable control loops** -> spec #262 L0 (the `Reconciler` interface + registry +
  generic scheduler + `loops` config). The centerpiece; many partials converge here.
- **G9 transport-agnostic** -> spec #262 B0 (the `TrackerEvent` union + an `InboundTransport`
  interface with a `PollingTransport` v1 impl).

### Self-corrections the audit caught in our own docs (G12 honesty)

- The CHARTER build-commitments listed "the reconciler registry" among existing v1 contracts;
  it does not exist. **Corrected** (it is added by the revision, then promoted).
- The charter calls the floor "inviolable" but `config-schema.ts` allows `alwaysAsk: []`
  (no `.min(1)`), so it is trimmable. Recorded as a code gap (add `.min(1)`), keeping the
  goal as the target.

### Prioritized build order

1. **Readiness + starvation** (G3): #262 A1/A2. Unblocks the loop. [v1]
2. **Reconciler registry + scheduler + `loops` config** (G5): #262 L0. The backbone the other
   loops plug into. [v1 typed + config; fully executes under P5]
3. **`flow-state.json` FlowRun writer/reader + `recoverOrphan` wiring** (G6/G7/G13). [v1]
4. **Inbox/resume reconciler + identity-aware comms** (G4/G10): #262 B1/B2. [v1]
5. **`TrackerEvent` seam + polling transport** (G9): #262 B0. [v1 typed]
6. **`/flow:status` + operator override** (G13/G14). [v1]
7. **Docs guide series + honesty/guard fixes** (G15/G8/G12). [v1, parallelizable]
8. **The running server engine + approval detection + atomic concurrency** (G2/G7/G12): P5,
   DOR-88/89. Flips the remaining partials to met. [server]

The charter is the right target. The system is a typed-and-prose foundation with, now, a
precise and evidence-backed path to conformance.
