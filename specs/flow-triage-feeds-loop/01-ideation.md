---
slug: flow-triage-feeds-loop
number: 262
created: 2026-06-25
status: ideation
---

# A Self-Feeding, Self-Unblocking `/flow` Loop

**Slug:** flow-triage-feeds-loop
**Author:** Dorian (via `/flow:ideate`)
**Date:** 2026-06-25

> **Scope note.** This spec was seeded by a triage question ("34 items stuck in
> Triage, nothing in flight") and grew, by operator direction, into the two
> pillars that together let the `/flow` loop run unattended end to end:
>
> - **Pillar A: feed the loop.** Triage (and every shaping stage) produces work
>   the dispatch policy can actually pick up; the engine notices when it is
>   starved; cross-impact is handled holistically.
> - **Pillar B: never dead-end on a question.** When a stage genuinely needs human
>   input, it routes the question on a channel that fits the identity mode, records
>   it durably, and the run resumes by polling for the answer (no inbound webhook,
>   no Linear coupling).
>
> The slug retains its origin ("triage-feeds-loop"); the title reflects the full
> scope. Number stays #262.

---

## 1) Intent & Assumptions

- **Task brief:** Make the `/flow` engine run unattended end to end. Two pillars:
  - **A.** Stop the loop from starving: every shaping stage applies the readiness
    marker its successor's pickup requires; the engine recognizes a starved queue
    and refills it; triage handles cross-project ripple, not just per-item checks;
    and bulk imports stop bypassing the spine.
  - **B.** Stop questions from being dead-ends: a question-routing path that picks
    its channel from the identity mode, records the question durably on the work
    item, and resumes the run by **polling** for the human's reply.

- **Resolved posture (Decision A0, the frame):** **full autonomy, uncertainty-gated.**
  No human is required to _start_ any stage; the loop shapes (IDEATE / SPECIFY /
  DECOMPOSE) and executes (EXECUTE / VERIFY) autonomously. The human is pulled in
  **only** by genuine questions (the calibration ladder), routed through Pillar B,
  never by a stage gate. This **supersedes** an earlier "hybrid: ready only simple
  work" lean from this session: under full autonomy, readiness is applied broadly
  and the sole gate is the uncertainty-driven question channel.

- **Assumptions:**
  - This **amends the v1 flow harness** (spec #257, implemented). Additive: stage-skill
    prose, small typed-policy edits in `@dorkos/flow`, the orchestrator command, and the
    `linear-adapter`. **Not** the P5 server build.
  - **Tracker-agnostic by construction.** The generic layer (`@dorkos/flow` + stage
    skills) never names a tracker. Every tracker specific (labels, comments, delegation,
    Linear Agent Accounts) lives in the `linear-adapter`. This is the existing adapter
    seam, enforced by the `tracker-confinement` guard.
  - **No inbound webhooks.** DorkOS is local-first with no exposed endpoint to receive a
    tracker's outbound webhooks, so resume is **pull (polling)**, never push. This is the
    decisive constraint and it is also the one path that works identically for shared,
    regular, and (future) agent-account identity modes.
  - **A regular account must always work.** Linear Agent Accounts (`actor=app`) are an
    optional, adapter-confined upgrade, never a requirement. Identity mode is already
    config (`identity.agent` / `identity.reviewer` -> `resolveIdentityMode` ->
    `shared | two-account`; default `shared`).
  - The `agent/*`, `stage/*`, `type/*`, `confidence/*`, `origin/*` label groups are
    already provisioned on the DOR team. This spec uses them; it does not create the
    taxonomy.

- **Out of scope:**
  - The P5 server Flow Engine, `WorkspaceManager`, a public webhook listener, and a second
    PM adapter (reaffirmed non-goals of spec #257).
  - Removing any human floor gate: creating a project, rejecting/cancelling someone's work,
    and outward-facing changes stay stop-and-ask even under full autonomy.
  - Actually triaging the current 34 items (a separate operational `/flow:triage` drain).
  - Building Linear Agent Account integration now (designed as the deferred two-account
    backend; gated on a reachable relay).

## 2) Pre-reading Log

- `.agents/flow/skills/triaging-work/SKILL.md`: TRIAGE Path B Accept transitions to backlog,
  assigns a project, sizes, sets priority, converts blocker prose to typed relations. It never
  applies `agent/ready` or a `stage/*` label, and routes "complex -> IDEATE" in prose only.
- `.agents/flow/skills/specifying-work/SKILL.md`: on entry `transition` to `stage/specify`; on
  completion a breadcrumb. No `agent/ready`.
- `.agents/flow/skills/decomposing-work/SKILL.md`: `transition` to `stage/decompose`; sub-issue
  promotion only at size >= xl. No `agent/ready` on the work item or the execute-ready tasks.
- `packages/flow/src/dispatch.ts`: `filterEligible` drops any item lacking `agent/ready`
  (line 222, unconditional) and any non-`backlog|unstarted|started` item. Ranking ladder:
  `unblockers -> priority -> projectStatus -> type -> size -> age -> identifier`; missing
  priority/size/age sort NEUTRAL (last).
- `packages/flow/src/comms.ts` (`resolveCommsChannel`): routes a `stop-and-ask` to `interactive`
  (live terminal) or `comment-and-assign` (unattended). **Keys only off `liveSession` + `source`;
  blind to identity mode** (the gap Pillar B fixes).
- `packages/flow/src/comment-response.ts` (`shouldRespondToComment`): rule 1 ignores the agent's
  own comments (author **or** `identity.marker`, the only signal in shared mode); rule 3 resumes a
  `agent/needs-input` item on a non-agent comment. So **answer detection already works in shared
  mode via the marker.**
- `packages/flow/src/identity.ts` + `config.json`: `identity: { agent: "auto", reviewer: null,
marker: "— 🤖 /flow" }`; `resolveIdentityMode` -> `shared` when `reviewer` is unset/equal,
  else `two-account`. Default shared. `involvement.nudge { relay, telegram }` exists but is
  "courtesy ping, never primary."
- `.agents/flow/skills/closing-work/SKILL.md`: DONE runs a project pulse check, but only when an
  item in that project reaches DONE and only for loop-continuity; it never reconciles "project
  state lags reality," and has never run on the bulk-imported projects.
- `.agents/flow/skills/linear-adapter/SKILL.md`: normalizes Linear native `triage` -> `backlog`
  category; states "the TRIAGE stage is what applies `agent/ready`" (a contract no skill fulfils).
- `research/20260625_hitl_question_routing_async_resume.md` (this session): framework + product
  survey of async HITL. Three resume architectures (durable-workflow+signal, checkpointed-graph,
  serialized-state+pull); the Claude SDK `defer` primitive; Linear Agent Sessions
  (`awaitingInput` + `prompted` webhook) blocked for us by the no-inbound-endpoint constraint;
  the stateless-replay "thread is the session" pattern fits our fresh-session model.
- `research/20260329_linear_api_agents_service_accounts.md`: Linear `actor=app` agents, the
  delegation-vs-assignment model, `AgentSession` lifecycle and webhook events. Maps to triage
  item DOR-102 (Evaluate Linear Agent Accounts).

## 3) Codebase Map

- **Pillar A modules:** `triaging-work` (readiness + ripple + backfill), `dispatch.ts`
  (starvation classifier), `closing-work` / a `tending-tracker` audit (project drift),
  the orchestrator command + `.agents/flow/README.md` (starvation nudge), `capturing-work`
  (import routing).
- **Pillar B modules:** `comms.ts` (`resolveCommsChannel` gains an `identityMode` input),
  `comment-response.ts` (already marker-aware), `identity.ts` (`resolveIdentityMode`), the
  `linear-adapter` verbs (`comment`, `needsInput`, `getInbox`, `assignToHuman`, the optional
  `actor=app` path), a new **question-routing** stage-agnostic skill, and a resume tick.
- **Shared deps:** `@dorkos/flow` `work-item.ts` (`agentDisposition`, `confidence`),
  `config-schema.ts` (any new keys: confidence threshold, channel matrix, resume cadence),
  the `agent/*` durable label state machine.
- **Data flow (A):** `CAPTURE -> TRIAGE -> (readiness applied) -> getEligibleWork ->
selectDispatch -> claim -> carry through stages -> review gate`.
- **Data flow (B):** `stop-and-ask -> resolveCommsChannel(identityMode) -> {interactive |
comment-and-assign | comment-and-nudge} -> needsInput (comment + agent/needs-input + marker) ->
STOP -> [resume tick polls getInbox] -> non-agent reply detected -> re-attach worktree +
resume session -> clear needs-input -> continue`.
- **Blast radius:** the dispatch eligibility contract and the comms oracles are the typed P5
  promotion surface; prose skills and the typed modules must stay in lockstep. Identity-mode
  routing touches every unattended question. Poll cadence interacts with the Pulse tick model.

## 4) Root Cause Analysis

- **A1 - the loop is starved (the seed).** `dispatch.ts:222` makes `agent/ready` an unconditional
  requirement, but **no stage applies it** (verified across triage/specify/decompose; only
  `closing-work`/`tending-tracker`/the adapter `claim` touch `agent/*`). The `linear-adapter`
  asserts TRIAGE applies it, a contract no skill honors. Live evidence: 34 Triage + 19 Backlog,
  0 in flight; `/flow auto` returns `[]` and reports an empty queue.
- **B1 - questions dead-end.** `comment-response.ts` is the typed _decision_ and `getInbox` is the
  _verb_, but **the active poller that reads the inbox, finds the reply, and resumes the parked
  session is not built** (the same deferred half as the review-gate "does not detect approval"
  caveat). So an unattended question parks and waits for a manual re-trigger.
- **B2 - shared-account attention gap.** In shared mode `assignToHuman` is a no-op and the tracker
  will not notify the human (actor == notified), so a parked question sits unseen. Detection still
  works (the marker), but **attention** does not. `resolveCommsChannel` does not branch on identity
  mode, so it would pick `comment-and-assign` (broken attention half) for shared + unattended.
- **Root cause (unified):** the loop has no owner for the two signals that make autonomy work:
  _readiness_ (what may be picked up) and _resumption_ (how a parked question un-parks). Both are
  designed as typed oracles and labels but neither has a running producer. Full autonomy needs both.

## 5) Research

### Pillar A: feed the loop

- **A-readiness (Decision A1).** Every shaping stage applies the readiness marker its successor
  needs: TRIAGE readies accepted work for the next stage (both the simple path, straight to
  EXECUTE as a `task`, and the complex path, onward to IDEATE); DECOMPOSE readies the execute-ready
  tasks it produces. Simple-vs-complex still selects the **path**, not whether readiness is applied.
  Reconcile the `linear-adapter` prose to match. This is the keystone: without it the loop never runs.
- **A-starvation (Decision A2).** Add a typed `classifyDispatchOutcome` to `dispatch.ts` returning
  `{ picked, eligibleCount, starved, shapeableCount }` so callers distinguish "done" from "starved."
  The orchestrator cold-start defaults to a triage pass when starved; `/flow auto` reports
  "0 ready, N shapeable: run a triage pass?" instead of ending silently.
- **A-ripple (Decision A3).** Add a per-item ripple prompt to triage Path B plus a batch-triage
  mode that builds the relation graph (`getRelations`), surfaces merge candidates, sequences
  `blockedBy`, and flags ADR supersession. Live proof: DOR-99 + DOR-100 (same usage status bar);
  the 24-item harness-portability epic across 4 projects with zero typed relations.
- **A-imports (Decision A4).** Make field backfill (priority/size/type+stage labels/typed
  relations) a non-skippable triage step for unlabeled arrivals, and route plan/roadmap imports
  through CAPTURE so they enter the spine shaped.
- **A-drift (Decision A5).** A periodic tracker-hygiene audit reconciles project state vs child
  reality (the DONE hook structurally cannot, since drifted projects never reach DONE).

### Pillar B: never dead-end on a question

- **Where questions arise.** Calibration ladder x stage bias: intake stages (TRIAGE, IDEATE,
  SPECIFY) ask in the ambiguous middle; execution stages (DECOMPOSE, EXECUTE, VERIFY) proceed-and-log.
  So questions front-load into shaping, peaking at IDEATE. Implication: a shaping stage can **batch**
  its questions, and resume latency matters most early.
- **B-channel (Decision B1).** `resolveCommsChannel` takes `identityMode` as a third input. Matrix:
  - live session (terminal or open chat), any identity -> **interactive** (`AskUserQuestion`).
  - unattended + **two-account** -> **comment-and-assign** (comment + `agent/needs-input` + delegate
    to the distinct human; author-based detection; optional nudge).
  - unattended + **shared/regular** -> **comment-and-nudge** (comment + `agent/needs-input` as the
    durable record; **out-of-band push promoted to primary** via Telegram/Relay/chat; marker-based
    detection; no `assignToHuman`).
- **B-resume (Decision B2).** Resume is **poll-based, tracker-agnostic**. A resume tick polls
  `getInbox` for `needs-input` items; a comment lacking `identity.marker` after the agent's question
  is the answer (the `shouldRespondToComment` rule-3 path, marker as disambiguator). Then re-attach
  the worktree at HEAD and resume: Claude SDK `--resume <sessionId>` with the answer injected, or
  re-run the stage with the full thread as context (the stateless-replay pattern most products use).
  No inbound webhook.
- **B-record (Decision B3).** The question is posted as a **readable comment** (not just a label),
  carrying `identity.marker`; `agent/needs-input` is the durable "pending" state. This is the
  generic contract; the adapter maps it onto the tracker.
- **B-surface (Decision B4).** A "waiting on you" surface (a DorkOS attention list) so parked
  questions are visible, especially in shared mode where the tracker will not notify.
- **B-linear-optional (Decision B6).** Linear Agent Accounts (`actor=app`, `AgentSession`
  `awaitingInput` + `prompted` webhook) are the **optional two-account backend**, confined to the
  `linear-adapter`, deferred until a reachable relay exists (they require inbound webhooks we
  cannot receive today). Subsumes DOR-102. The generic layer never assumes them.

### Recommended direction

Keystone first: **A-readiness (A1) + A-starvation (A2)** turn `/flow auto` from inert to useful and
are small. **B1 + B2 + B3** are the minimum that makes full-autonomy parking safe (a question can be
asked and answered without a human babysitting). A3-A5, B4, B6 are value-additive follow-ons that
DECOMPOSE can sequence. Next step: **SPECIFY** (`/flow:specify flow-triage-feeds-loop`), with draft
ADRs for (1) readiness ownership across the pipeline, (2) the dispatch starvation contract, and
(3) identity-mode-aware, poll-based question routing.

## 6) Decisions

| #   | Decision                  | Choice                                                                                                                                       | Rationale                                                                                                                |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A0  | Autonomy posture          | **Full autonomy, uncertainty-gated.** No human starts a stage; the loop shapes and executes; humans pulled in only by questions              | Operator direction; supersedes the earlier "ready only simple" hybrid lean. Makes Pillar B a prerequisite, not optional. |
| A1  | Readiness ownership       | **Every shaping stage applies readiness for its successor** (TRIAGE readies accepted work both paths; DECOMPOSE readies execute-ready tasks) | No stage applies `agent/ready` today; the loop is starved. Simple/complex still picks the path, not readiness.           |
| A2  | Starvation-awareness      | **Typed `classifyDispatchOutcome` in `dispatch.ts`**, consumed by the orchestrator + `/flow auto`                                            | P5 promotes `dispatch.ts` unchanged; "starved vs done" is a dispatch fact.                                               |
| A3  | Cross-impact              | **Per-item ripple prompt + a batch-triage mode**                                                                                             | Per-item misses merges/sequencing/supersession; the live data proves it.                                                 |
| A4  | Bulk-import handling      | **Backfill + route imports through CAPTURE**                                                                                                 | Stops NEUTRAL-ranked dispatch; closes the back door around the spine.                                                    |
| A5  | Project-state drift       | **Periodic tracker-hygiene audit** (not the DONE hook)                                                                                       | The DONE hook cannot see projects whose items never reach DONE.                                                          |
| B1  | Comms channel selection   | **Branch on identity mode** (interactive / comment-and-assign / comment-and-nudge); nudge promoted to primary in shared mode                 | `resolveCommsChannel` is identity-blind today; shared mode's attention half is broken.                                   |
| B2  | Async resume              | **Poll-based (pull), tracker-agnostic**; re-attach + `--resume` or re-read thread                                                            | No inbound-webhook endpoint exists; polling works for all identity modes.                                                |
| B3  | Durable question record   | **Readable comment + `agent/needs-input` + `identity.marker`**, in generic verbs                                                             | A label alone is not a readable question; the marker disambiguates in shared mode.                                       |
| B4  | Pending-questions surface | **A "waiting on you" attention list in DorkOS**                                                                                              | In shared mode the tracker will not notify; parked questions must be visible.                                            |
| B6  | Linear Agent Accounts     | **Optional, adapter-confined, deferred** (the two-account backend; subsumes DOR-102)                                                         | They require inbound webhooks we cannot receive; a regular account must always work.                                     |
| S0  | Scope & structure         | **One spec (#262), two pillars**, keystone-first (A1+A2, then B1-B3, then the rest)                                                          | Operator chose to fold question routing into #262; A1/A2/B1-B3 are the minimal autonomous loop.                          |

Added after the table was first drafted (governed by
[`../../.agents/flow/CHARTER.md`](../../.agents/flow/CHARTER.md) and
[`../../plans/flow-loop-system-revision.md`](../../plans/flow-loop-system-revision.md)):

- **L0 - Loop architecture.** Replace the monolithic drain with a **prioritized
  reconciler registry + scheduler**. Small single-responsibility sub-loops (triage,
  dispatch, inbox/resume, wip/recovery, hygiene, review/merge), each implementing one
  `Reconciler` interface and declaring its own `priority` + config block, run in priority
  order by one generic runner that decides which are due. Pluggable: add = register,
  remove = `enabled: false`. Per-loop cadence under one ordered runner. Satisfies Charter
  G5. The `loops` config map is the extension seam; the interface + registry are the P5
  promotion surface.
- **B0 - Inbound event seam.** A normalized `TrackerEvent` stream the reconcilers
  consume, fed interchangeably by a **poller** (v1 default, no endpoint needed) or a
  **webhook receiver** (deferred). Events are triggers, not truth (reconcilers re-read
  current state, stay idempotent). Resume (B2) and claim-on-ready (A1) are consumers of
  this one seam. Satisfies Charter G8/G9; the dual of the outbound `PMClient`.

**Recommended next step:** **SPECIFY** (`/flow:specify flow-triage-feeds-loop`), carrying
L0/B0 and the two pillars. The goals charter and the comprehensive plan are the governing
artifacts.
