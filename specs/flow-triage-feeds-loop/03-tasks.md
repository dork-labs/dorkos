# Task Breakdown — A Self-Feeding, Self-Unblocking `/flow` Loop

> Decomposition of [`02-specification.md`](./02-specification.md) (spec #262, slug
> `flow-triage-feeds-loop`). Machine-readable canon: [`03-tasks.json`](./03-tasks.json).
> Mode: `full`. Generated 2026-06-25.

**36 tasks across 6 phases** (Phase 1: 7, Phase 2: 6, Phase 3: 5, Phase 4: 7, Phase
5: 4, Phase 6: 7). The keystone is Phase 1 (readiness production +
starvation detection) — it unblocks the value of everything. Phase 2 (the reconciler
registry + scheduler) is the backbone Phases 3-5 plug their reconcilers into. Phase 6
(docs) parallels the code phases, except the autonomy guide, which is honesty-gated on
the capability being real.

**Critical path.** `1.4 (classifyDispatchOutcome)` and `2.1 (Reconciler interface)` are
the two roots. `2.1 -> 2.2 (registry/scheduler)` gates the recovery reconciler (`3.3`)
and the inbox/resume reconciler (`4.6`). `4.1 -> 4.2 (transport)` also gates `4.6`, and
`4.5 (identity-aware comms)` joins it. `3.1 (FlowRun writer/reader)` gates `3.3`, the
status surface (`5.1`), and the persistence prose (`3.5`). Longest chain:
`2.1 -> 2.2 -> 4.6 -> 4.7` (with `4.1 -> 4.2` and `4.5` feeding `4.6`).

**Sizing.** No task is sized `xl` — the spec decomposes cleanly into focused changes,
and the docs guide series was split per-guide (the intended parallelization) rather than
landed as one xl block. `3.1` is the single `large` task (a writer + reader + status
updater + GC + schema reconcile in one module).

---

## Phase 1 — Readiness (keystone)

> The highest-priority phase: readiness production at every shaping stage turns the
> dispatch gate from permanently-starved into fed, and `classifyDispatchOutcome` makes
> "starved vs done" a surfaced fact across every mode. Tasks 1.1-1.4 are mutually
> parallel (different files); 1.5 tests 1.4; 1.6 wires the modes; 1.7 wires the hook.

### Task 1.1: Produce agent/ready + stage labels in triaging-work on accept

- **Size:** medium · **Priority:** high
- **Dependencies:** none · **Parallel with:** 1.2, 1.3, 1.4

Edit `.agents/flow/skills/triaging-work/SKILL.md`. In Path A step 3 (intake creation) and
Path B step 4 (the simple-vs-complex Accept routing), instruct the skill to apply the
durable `agent/ready` label AND the successor `stage/*` label via the linear-adapter
whenever work is accepted, on BOTH routes: simple -> readied for EXECUTE as a `task` (apply
`agent/ready` + the execute-adjacent stage label), and complex -> readied for IDEATE (apply
`agent/ready` + `stage/ideate`). Per decisions A0/A1 (full autonomy), readiness is applied
broadly: add an explicit sentence stating simple-vs-complex selects the PATH, never whether
readiness is applied. Update the Path B decision table 'Routing' cells and the 'Stage
handoff' section to name the `agent/ready` application. This is the keystone fix:
`dispatch.ts` filterEligible (line ~222) drops any item lacking `agent/ready`, and today no
stage applies it (34 Triage + 19 Backlog, 0 in flight). Acceptance: a reader sees, on both
accept routes, the instruction 'via the linear-adapter, apply agent/ready + the stage/\*
label'; the literal `agent/ready` appears in the Accept routing prose; the
`tracker-confinement` Vitest guard stays green (only generic verb naming added, no raw
tracker string).

### Task 1.2: Produce agent/ready on decomposing-work execute-ready tasks

- **Size:** small · **Priority:** high
- **Dependencies:** none · **Parallel with:** 1.1, 1.3, 1.4

Edit `.agents/flow/skills/decomposing-work/SKILL.md`. In step 5 (Mirror the plan into the
tracker) add an explicit instruction: via the linear-adapter, apply `agent/ready` to the
execute-ready work item / tasks DECOMPOSE emits, so the dispatch eligibility gate
(`@dorkos/flow` `dispatch.ts` `AGENT_READY_LABEL`, unconditional at filterEligible line
~222) can pick them up for EXECUTE. State plainly that the work item carrying the decomposed
plan becomes dispatchable only once `agent/ready` is applied, and that this is the second
readiness producer after TRIAGE (task 1.1). Acceptance: the skill names 'via the
linear-adapter, apply agent/ready' on its execute-ready output; the literal `agent/ready`
appears in step 5; the `tracker-confinement` guard stays green.

### Task 1.3: Reconcile linear-adapter readiness contract prose

- **Size:** small · **Priority:** high
- **Dependencies:** none · **Parallel with:** 1.1, 1.2, 1.4

Edit `.agents/flow/skills/linear-adapter/SKILL.md` lines ~199-202 (the Triage `state.type`
dagger note). Today it asserts 'The TRIAGE stage is what … applies agent/ready' — a contract
no skill fulfilled. Reconcile the prose so it matches the now-real producers (triaging-work +
decomposing-work, tasks 1.1/1.2): state that readiness (`agent/ready`) is produced by the
shaping stages (TRIAGE on accept both paths, DECOMPOSE on execute-ready tasks) and that an
item lacking `agent/ready` is held out of dispatch by the ABSENT label, not by its category.
Keep the `triage`->`backlog` category mapping unchanged and the 'never fabricate a distinct
triage category' rule. Acceptance: the adapter's readiness assertion describes real
producers; no orphaned 'TRIAGE applies it' claim remains without a corresponding stage-skill
instruction; the adapter still carries its tracker strings (guard's meaningful-non-vacuous
assertion stays green).

### Task 1.4: Add classifyDispatchOutcome to dispatch.ts + export

- **Size:** medium · **Priority:** high
- **Dependencies:** none · **Parallel with:** 1.1, 1.2, 1.3

Add `classifyDispatchOutcome(items, config, opts)` to `packages/flow/src/dispatch.ts`
returning `{ picked: WorkItem[]; eligibleCount: number; starved: boolean; shapeableCount:
number }`. Compute `picked = selectDispatch(items, config, opts)`; `eligibleCount =
picked.length`; `shapeableCount` = count of dispatchable-CATEGORY items (stateCategory in
DISPATCHABLE_STATE_CATEGORIES {backlog,unstarted,started}, project NOT in
DEAD_PROJECT_STATE_CATEGORIES) that LACK the `AGENT_READY_LABEL` (items a triage/decompose
pass could ready but that currently sit behind the readiness gate); `starved = eligibleCount
=== 0 && shapeableCount > 0`. Reuse the existing module constants; classify ownership is not
needed for the shapeable count (it is a readiness/category fact). Export the function and a
`DispatchOutcome` type from `packages/flow/src/index.ts` inside the existing dispatch export
block (`export { selectDispatch, filterEligible, rankEligible, isClaimable } …`). Note
inline assumption: `shapeableCount` counts only items missing `agent/ready` (the lever a
triage pass pulls), not blocked-or-WIP-capped ready items. Acceptance: returns `{ picked:
[], eligibleCount: 0, starved: true, shapeableCount: N }` when all candidates are
dispatchable-category but unlabeled; `starved: false` when `picked` is non-empty; `{ starved:
false, shapeableCount: 0 }` when only completed/canceled items remain (genuinely done).
`pnpm --filter @dorkos/flow typecheck` passes.

### Task 1.5: Unit-test classifyDispatchOutcome (empty-with-shapeable, done, picked)

- **Size:** small · **Priority:** high
- **Dependencies:** 1.4 · **Parallel with:** none

Add `packages/flow/src/__tests__/dispatch-outcome.test.ts` (or extend `dispatch.test.ts`)
covering `classifyDispatchOutcome`. Each scenario carries a purpose comment. (a)
empty-with-shapeable: three backlog-category items WITHOUT `agent/ready` -> `{ picked: [],
eligibleCount: 0, starved: true, shapeableCount: 3 }`. (b) done: only completed/canceled
items -> `{ starved: false, shapeableCount: 0 }`. (c) picked: one `agent/ready` backlog item
-> `{ eligibleCount: 1, starved: false }`. (d) mixed: one ready + two shapeable -> `{
eligibleCount: 1, starved: false, shapeableCount: 2 }`. Construct WorkItems with the existing
dispatch.test.ts fixtures/helpers and a stub `classifyOwnership` returning 'unassigned'. The
empty-with-shapeable test is written to FAIL against pre-1.4 code (the function does not
exist). Acceptance: `pnpm vitest run packages/flow/src/__tests__/dispatch-outcome.test.ts` is
green; the four scenarios pin starved-vs-done.

### Task 1.6: Surface starvation in /flow auto + cold-start (flow.md)

- **Size:** medium · **Priority:** high
- **Dependencies:** 1.4 · **Parallel with:** none

Edit `.claude/commands/flow.md`. (1) In the `/flow auto` section step 2 ('Each iteration'),
replace the silent 'set ready: 0 and go to Stop' branch with `classifyDispatchOutcome`
semantics: when `picked` is empty but `shapeableCount > 0`, report 'Queue starved: 0 ready, N
shapeable — run a triage pass?' and offer via `AskUserQuestion` to run `/flow:triage`; only
when `shapeableCount === 0` (genuinely done) set `ready: 0` and Stop. Write the `shapeable`
count into `.dork/flow/auto-run.json` alongside `ready` so the Stop hook can tell starved
from done (task 1.7); document the new `shapeable` sentinel field in step 1 ('Start'). (2) In
the cold-start Routing section ('No arguments'), when the ready queue is empty but shapeable
work exists, default the recommended `AskUserQuestion` intent to 'Triage the backlog'. Render
any named item as `DOR-123 - Title` per the linear-adapter display convention. Note inline
assumption: the auto-run sentinel gains `shapeable: <N>`. Acceptance: the `/flow auto` prose
no longer sets `ready: 0` silently while shapeable work remains; it names the 'N shapeable:
run a triage pass?' surface; the cold-start recommends triage when starved; confinement guard
green.

### Task 1.7: Surface starved-with-shapeable in the flow-loop Stop hook

- **Size:** medium · **Priority:** high
- **Dependencies:** 1.4, 1.6 · **Parallel with:** none

Edit `.claude/hooks/flow-loop.mjs` and `packages/flow/src/__tests__/flow-loop.test.ts`.
Extend the pure `decideStop(output, autoRun)`: when `autoRun.active === true` and `ready <=
0` but `autoRun.shapeable > 0`, still ALLOW stop (a terminal drain cannot triage itself) BUT
return a distinct reason like `'drain starved — N shapeable item(s) need triage
(/flow:triage)'` so `printBlockMessage`/the allow-stop log tells the operator to run a triage
pass instead of the misleading 'drain complete — no ready work remaining'. Preserve the
fail-open invariant intact for every other input (absent/unreadable/malformed/inactive
sentinel -> allow stop). Update the JSDoc sentinel-shape comment to document the new optional
`shapeable` field. Add flow-loop.test.ts cases (purpose-commented): (a) `{ active: true,
ready: 0, shapeable: 4 }` -> allow-stop, reason mentions 'starved'/'triage'; (b) `{ active:
true, ready: 0, shapeable: 0 }` -> allow-stop, reason 'drain complete'; (c) `{ active: true,
ready: 2 }` -> block-stop (unchanged). Acceptance: starved drains surface a triage prompt,
not 'drain complete'; the three new cases pass; no regression to the existing fail-open
tests.

---

## Phase 2 — Reconciler registry + scheduler

> The backbone. The typed `Reconciler` interface + registry + generic priority-ordered
> scheduler + the `loops` config are the promotion surface the P5 server inherits
> unchanged; in v1 the drain prose follows the registry order. Tasks 3.3 and 4.6 plug
> their reconcilers into the slots this phase opens.

### Task 2.1: Define the typed Reconciler interface + context/result types

- **Size:** medium · **Priority:** high
- **Dependencies:** none · **Parallel with:** 1.1, 1.2, 1.3, 1.4

Create `packages/flow/src/reconciler.ts` defining the typed reconciler contract (charter L0):
`type ReconcilerId = 'triage' | 'dispatch' | 'inbox' | 'recovery' | 'hygiene' | 'review'`;
`interface ReconcilerConfig { enabled: boolean; priority: number; intervalMs: number }`
(loop-specific fields extend per reconciler); `interface ReconcileContext { now: number;
lastRunAt?: number }` plus a generic slot for the injected adapter/oracle inputs each
reconciler needs (kept tracker-agnostic — no Linear strings); `interface ReconcileResult { id:
ReconcilerId; acted: boolean; itemId?: string; summary: string }`; and `interface Reconciler {
id: ReconcilerId; defaultConfig: ReconcilerConfig; isDue(ctx: ReconcileContext): boolean;
run(ctx: ReconcileContext): Promise<ReconcileResult>; }`. Types + interface ONLY — no
registry, no scheduler, no concrete reconcilers yet. Add module-level + export TSDoc. Export
every type/interface from `packages/flow/src/index.ts`. Acceptance: `pnpm --filter
@dorkos/flow typecheck` passes; the interface is importable; no runtime logic.

### Task 2.2: Build the registry + generic priority-ordered scheduler

- **Size:** medium · **Priority:** high
- **Dependencies:** 2.1 · **Parallel with:** none

Add the registry + generic scheduler to `packages/flow/src/reconciler.ts` (or a sibling
`scheduler.ts`). `createReconcilerRegistry(reconcilers: Reconciler[])` stores entries and
exposes `list()` returning them sorted by ASCENDING `priority` (lower runs first).
`runTick(registry, ctx, configByLoop)`: walks the registry in priority order and, for each
reconciler whose resolved config (the `loops` map from task 2.4 merged over the reconciler's
`defaultConfig`) has `enabled === true` AND `isDue(ctx) === true`, awaits `run(ctx)`,
collecting `ReconcileResult[]`. Resolve same-item contention by priority: track the set of
`itemId`s already acted on this tick and SKIP a lower-priority reconciler's `run` for an
itemId a higher-priority reconciler already claimed (recovery before dispatch on the same
item). The scheduler stays pure: re-deriving truth is each reconciler's job; the scheduler
only orders, gates by enabled/isDue, and dedupes by itemId. Export `createReconcilerRegistry`

- `runTick` from index.ts. Acceptance: a tick runs reconcilers in ascending-priority order;
  disabled or not-due reconcilers are skipped; two reconcilers targeting one itemId -> only the
  higher-priority acts; `runTick` returns the collected results in priority order.

### Task 2.3: Unit-test the registry + scheduler (order, due-gating, contention)

- **Size:** medium · **Priority:** high
- **Dependencies:** 2.2 · **Parallel with:** none

Add `packages/flow/src/__tests__/reconciler.test.ts` with purpose-commented scenarios built
from fake Reconcilers (vi.fn-backed `isDue`/`run`). (a) priority order: three reconcilers with
priorities 10/30/50 run in ascending order, asserted via a shared call-order log. (b)
due-gating: a reconciler whose `isDue` returns false, and one with `enabled: false` in config,
are both skipped (their `run` is never invoked). (c) contention: a priority-10 reconciler
returns `{ itemId: 'DOR-1', acted: true }` and a priority-30 reconciler also targets 'DOR-1'
-> the priority-30 `run` is NOT invoked for that item (recovery-before-dispatch dedupe).
Assert `runTick` returns results in priority order. The contention test is written to FAIL on
any non-priority-ordered or non-deduped scheduler. Acceptance: `pnpm vitest run
packages/flow/src/__tests__/reconciler.test.ts` is green; all three invariants pinned.

### Task 2.4: Add the loops config block + regenerate config.schema.json

- **Size:** medium · **Priority:** high
- **Dependencies:** 2.1 · **Parallel with:** 2.2

Add a `loops` config block to `packages/flow/src/config-schema.ts` keyed by reconciler `id`,
and regenerate the JSON Schema. Define `ReconcilerConfigSchema = z.object({ enabled:
z.boolean().default(true), priority: z.number().int(), intervalMs: z.number().int().positive()
}).prefault({})` and `LoopsSchema = z.object({ recovery, inbox, dispatch, triage, hygiene,
review })` each defaulting to its per-loop config. DECOMPOSE calibration defaults (noted inline
as assumptions): priorities recovery=10, inbox=20, review=25, dispatch=30, triage=40,
hygiene=50 (lower = earlier + contention winner; recovery > inbox/resume > dispatch > triage >
hygiene per the spec's resolution, with review slotted before dispatch so completed PRs clear
before new claims); intervalMs recovery=300000, inbox=60000 (fast), review=300000,
dispatch=300000, triage=3600000, hygiene=21600000 (slow); all enabled. Add `loops: LoopsSchema`
to `FlowConfigSchema`, mirror the resolved defaults into `.agents/flow/config.json`, and
regenerate `.agents/flow/config.schema.json` via `pnpm --filter @dorkos/flow generate:schema`
(NEVER hand-edit the generated artifact). Extend
`packages/flow/src/__tests__/config-schema.test.ts`: `FlowConfigSchema.parse({}).loops.recovery
.priority === 10` and `loops.inbox.intervalMs` is the smallest interval. Acceptance: `parse({})`
resolves the full loops map; config.json + config.schema.json regenerated and consistent;
schema test green.

### Task 2.5: Register the baseline reconcilers wrapping existing oracles

- **Size:** medium · **Priority:** medium
- **Dependencies:** 2.2, 2.4, 1.4 · **Parallel with:** none

Register the reconcilers whose decision oracle already exists and is pure, in
`packages/flow/src/reconciler.ts` (or `reconcilers/`). `dispatch` wraps `selectDispatch`
(isDue: there is `agent/ready` eligible work; run claims the top-ranked). `hygiene` wraps
`classifyDispatchOutcome` (isDue: queue-depth check; run surfaces starvation per task 1.4).
`review` wraps `evaluateAutoMerge` (isDue: approved PRs at the gate). Add a `triage`
reconciler whose decision has NO typed oracle (it delegates to the triaging-work skill in v1):
its `isDue` is 'there are native-triage / unlabeled items lacking `agent/ready`', its `run` is
a thin delegation marker returning `{ acted, summary }`. Each reconciler's `defaultConfig`
carries its priority/interval matching the loops defaults (task 2.4). The recovery + inbox
reconcilers are deliberately NOT added here (tasks 3.3, 4.6 add them). Export the baseline
reconcilers + a `defaultRegistry()` helper from index.ts (recovery + inbox slots are filled by
3.3/4.6). Add tests to reconciler.test.ts asserting that among the baseline set the registry
orders review(25) < dispatch(30) < triage(40) < hygiene(50), and that each baseline
reconciler's `run` calls its wrapped oracle with no new decision logic. Acceptance: baseline
reconcilers wrap their oracles; `defaultRegistry().list()` is priority-ordered; tests green.

### Task 2.6: Rewrite /flow auto + flow-drain prose to registry order

- **Size:** medium · **Priority:** medium
- **Dependencies:** 2.2, 2.4 · **Parallel with:** none

Rewrite the v1 drain prose to follow the reconciler registry order (recovery -> inbox/resume
-> dispatch) instead of the single vertical drain. Edit `.claude/commands/flow.md` `/flow
auto` section so each iteration runs, in this order: (1) the recovery pass (re-adopt orphaned
claimed work), (2) the inbox/resume pass (un-park answered questions), (3) the dispatch pass
(claim the top-ranked ready item, carry to the review gate) — naming these as the registry's
priority order and referencing `@dorkos/flow` `runTick` + the `loops` config (task 2.4) as the
typed source of truth the v1 prose mirrors. Edit `.dork/tasks/flow-drain/SKILL.md` to mirror
the same recovery -> inbox/resume -> dispatch order in its body. State explicitly that the
continuous unattended runner that actually calls `runTick` is the deferred P5 server build; v1
follows the order in prose. Acceptance: both the `/flow auto` prose and `flow-drain` name the
recovery -> inbox/resume -> dispatch order; neither adds a raw tracker string (confinement
guard green).

---

## Phase 3 — Durability

> Persist the run record so a crash/restart can re-adopt and resume work; wire
> `recoverOrphan` into a recovery reconciler at the head of each tick. `3.1` is the
> single `large` task; `3.3` plugs the recovery slot opened in Phase 2.

### Task 3.1: Add the typed FlowRun writer/reader for flow-state.json

- **Size:** large · **Priority:** high
- **Dependencies:** none · **Parallel with:** 2.2, 2.4

Add a typed FlowRun writer/reader for `.dork/flow/flow-state.json` to
`packages/flow/src/flow-run.ts` (or a sibling `flow-state.ts`). Persist a `Record<issueId,
FlowRun>` (runs keyed by issue, per the existing `FlowRun` TSDoc). API: `readFlowState(filePath):
Record<string, FlowRun>` (returns `{}` on missing/malformed — never throws, like the Stop-hook
sentinel reader); `writeFlowRun(filePath, run): void` (upsert by `issueId`, file-first
write-through per ADR-0043); `updateFlowRunStatus(filePath, issueId, status, patch?): void`
(status transition + optional field patch); `gcFlowState(filePath, isClosed: (issueId: string)
=> boolean): number` (drop records for closed/terminal issues, return the count removed). The
file path is PASSED IN — never call `os.homedir()` (packages rule); the server-free caller
resolves `.dork/flow/flow-state.json` relative to repo root, like `.dork/flow/auto-run.json`.
Reconcile the FlowRun schema: ADD a `stage` field (the current spine stage) to the `FlowRun`
interface — the status surface (task 5.1) needs it — and drop any ad-hoc
`trigger/depth/gate/tasksFile` fields that prose has been writing rather than carrying them
untyped; document the decision inline. Export the writer/reader (+ updated `FlowRun`) from
index.ts. Note: this typed module is the pinned oracle + schema-of-record the v1 prose (task
3.5) follows; the P5 server imports it verbatim. Acceptance: write-then-read round-trips a
FlowRun by issueId; a malformed file reads as `{}`; `gcFlowState` removes closed-issue records
and keeps open ones; `pnpm --filter @dorkos/flow typecheck` passes.

### Task 3.2: Unit-test the FlowRun writer/reader round-trip + GC

- **Size:** small · **Priority:** high
- **Dependencies:** 3.1 · **Parallel with:** none

Add `packages/flow/src/__tests__/flow-state.test.ts` with purpose-commented scenarios. (a)
round-trip: `writeFlowRun` then `readFlowState` returns the same FlowRun keyed by `issueId`.
(b) upsert: a second write for the same `issueId` replaces, never duplicates. (c) malformed: a
non-JSON file reads as `{}` (fail-soft, never throws). (d) status update:
`updateFlowRunStatus` flips `running -> waiting_for_review` and applies a field patch. (e) gc:
`gcFlowState` with `isClosed` true for one of two records removes exactly that record and
returns 1. Use a temp file path (`node:os` `tmpdir()` in the TEST only, or a vi-mocked
`node:fs`); never touch a real `~/.dork`. Acceptance: all five pass; no reliance on production
data dir.

### Task 3.3: Add the recovery reconciler wrapping recoverOrphan

- **Size:** medium · **Priority:** high
- **Dependencies:** 3.1, 2.2 · **Parallel with:** none

Add the `recovery` reconciler to the registry, wrapping `recoverOrphan`
(`packages/flow/src/flow-run.ts`). `isDue`: there is at least one `agent/claimed` +
`started`-category + not-`agent/needs-input` item (the v1 orphan predicate). `run(ctx)`: for
each such item, read its `FlowRun` via `readFlowState` (task 3.1), gather the probe
`RecoveryContext` (`worktreeExists`, `sessionLogIntact`) and derive the `OrphanSignal`
(`claimed-no-worker` when `FlowRun.workerPid` is not alive, `no-local-record` when no FlowRun
exists), call `recoverOrphan(signal, run, ctx, recovery)`, and map the returned
`RecoveryAction` to a `ReconcileResult` summary (resume / restart-clean / escalate / re-derive
/ skip). The probe I/O (pid liveness, fs checks) is injected via `ReconcileContext`, keeping
`recoverOrphan` pure. `defaultConfig.priority = 10` (head of the tick, before inbox +
dispatch). Register it into `defaultRegistry()` (task 2.5 left the slot) and export.
Acceptance: the recovery reconciler sorts FIRST (priority 10) in `defaultRegistry()`; given a
`claimed-no-worker` item with an intact checkpoint its run yields a `resume` action carrying
the FlowRun's `attemptCount + 1`; a `needs-input` item is excluded from the isDue set (never
reclaimed).

### Task 3.4: Unit-test the recovery reconciler via a fake registry

- **Size:** small · **Priority:** medium
- **Dependencies:** 3.3 · **Parallel with:** none

Add recovery-reconciler tests to `packages/flow/src/__tests__/reconciler.test.ts` (or
`recovery-reconciler.test.ts`), each purpose-commented, with a fake `ReconcileContext` and a
mocked `readFlowState` returning a fixture FlowRun. (a) intact checkpoint + dead worker ->
action 'resume'. (b) no worktree -> 'restart-clean' (reason 'no-worktree'). (c) `attemptCount

> = recovery.maxRetries` -> 'escalate' (`agent/blocked`). (d) an `agent/needs-input` item is
> NOT in the isDue set (parked is never reclaimed) — the most important invariant. (e) ordering:
> in a registry containing recovery(10) + dispatch(30) targeting the SAME itemId, recovery acts
> and dispatch is skipped for that item. Acceptance: all five pass; the parked-never-reclaimed
> invariant is explicitly asserted.

### Task 3.5: Wire FlowRun persistence into the claim + transition prose

- **Size:** medium · **Priority:** medium
- **Dependencies:** 3.1, 2.6 · **Parallel with:** none

Wire FlowRun persistence into the v1 loop prose so `.dork/flow/flow-state.json` is maintained
per the task-3.1 schema. Edit `.claude/commands/flow.md` (`/flow auto` claim + worktree step)
and `.dork/tasks/flow-drain/SKILL.md`: on claim, write a FlowRun record (`issueId, identifier,
sessionId, worktreePath, branch, stage, status: queued->running, attemptCount, workerPid,
startedAt`) following the `@dorkos/flow` FlowRun shape; update its `status` at each stage
transition (e.g. -> `waiting_for_review` at the review gate, -> `complete` at DONE); GC stale
records for closed issues at the head of the drain (the recovery pass, task 2.6/3.3).
Reference the typed `writeFlowRun` / `updateFlowRunStatus` / `gcFlowState` as the
schema-of-record the prose mirrors. State the record path explicitly:
`.dork/flow/flow-state.json` (distinct from the `.dork/flow/auto-run.json` drain sentinel).
Acceptance: the prose names the FlowRun fields written on claim and the status updates at
transitions; the path is `.dork/flow/flow-state.json`; confinement guard green.

---

## Phase 4 — Questions

> The never-dead-end pillar: a normalized inbound event seam (poll-first), identity-aware
> comms with the `comment-and-nudge` channel, and the inbox/resume reconciler. `4.1 -> 4.2`
> (transport) and `4.5` (comms) both feed `4.6` (the inbox reconciler).

### Task 4.1: Define the TrackerEvent discriminated union + envelope

- **Size:** medium · **Priority:** high
- **Dependencies:** none · **Parallel with:** 3.1, 2.1

Create `packages/flow/src/events.ts` defining the normalized inbound event seam (charter
B0/G9). Common envelope fields: `kind`, `itemId`, `actor`, `occurredAt` (ISO-8601),
`receivedVia: 'poll' | 'webhook'`, `dedupeKey`, `raw: unknown`. Realize a discriminated union
`TrackerEvent = CommentAddedEvent | ItemReadiedEvent | ItemAssignedEvent | ItemStateChangedEvent
| MentionEvent | ItemCreatedEvent` over `kind` (`'comment.added' | 'item.readied' |
'item.assigned' | 'item.state-changed' | 'mention' | 'item.created'`). The existing
`InboxComment` (`comment-response.ts`) becomes the payload of `comment.added` (a `comment:
InboxComment` field); `mention` carries the mentioned account; `item.state-changed` carries
from/to category; etc. — each variant carries exactly its payload. Add a `dedupeKey` convention
helper (e.g. `${kind}:${itemId}:${occurredAt}`). Export the union + every variant from
index.ts. Acceptance: the union compiles and narrows on `kind`; `comment.added` carries an
`InboxComment`; `pnpm --filter @dorkos/flow typecheck` passes.

### Task 4.2: Add InboundTransport + PollingTransport (watermark)

- **Size:** medium · **Priority:** high
- **Dependencies:** 4.1 · **Parallel with:** none

Add the transport seam to `packages/flow/src/events.ts` (or `transport.ts`). `interface
InboundTransport { poll(since?: Watermark): Promise<{ events: TrackerEvent[]; watermark:
Watermark }>; subscribe?(handler: (e: TrackerEvent) => void): () => void }`, where `Watermark`
is a durable cursor (e.g. an ISO timestamp or opaque string). Implement `PollingTransport`
wrapping an injected `getInbox`-shaped reader: read inbox entries since the watermark, map each
`InboxEntry` -> a `comment.added` (or `mention`) `TrackerEvent` with `receivedVia: 'poll'`,
advance the watermark, and return gap-free deltas. Document that events are TRIGGERS not truth
(consumers re-read current state via the adapter before acting) and carry `dedupeKey` + a
skip-self-authored note (`identity.marker`). The webhook producer is a deferred drop-in
implementing the SAME interface (NOT built here — v1 ships poll only, per the Non-Goals).
Export `InboundTransport`, `PollingTransport`, `Watermark` from index.ts. Acceptance:
`PollingTransport.poll()` turns inbox entries into TrackerEvents and advances a durable
watermark; a second `poll(watermark)` returns only newer events (no re-emit).

### Task 4.3: Test PollingTransport + the interchangeability (G9) seam

- **Size:** medium · **Priority:** high
- **Dependencies:** 4.2 · **Parallel with:** none

Add `packages/flow/src/__tests__/transport.test.ts`, purpose-commented. (a) PollingTransport
unit: a fake `getInbox` returning two new comments -> `poll()` emits two `comment.added` events
and advances the watermark; a follow-up `poll(watermark)` returns `[]` (no re-emit). (b) THE
interchangeability test (the seam's defining test, G9): feed the SAME hand-built
`TrackerEvent[]` through a fake polling producer and a fake webhook producer (both implementing
`InboundTransport`) into the same consuming reducer/reconciler stub, and assert IDENTICAL
output — proving the engine cannot tell which transport produced the events. The
interchangeability test is written to FAIL if any consumer branches on `receivedVia`.
Acceptance: both transports yield identical consumer output for identical events; `pnpm vitest
run packages/flow/src/__tests__/transport.test.ts` is green.

### Task 4.4: Add the ingestion/transport config block

- **Size:** medium · **Priority:** medium
- **Dependencies:** 4.1 · **Parallel with:** 4.2

Add an `ingestion` (transport) config block to `packages/flow/src/config-schema.ts` and
regenerate the schema. `IngestionSchema = z.object({ producer: z.enum(['poll',
'webhook']).default('poll'), pollIntervalMs: z.number().int().positive().default(60000)
}).prefault({})`; add `ingestion: IngestionSchema` to `FlowConfigSchema`; mirror the resolved
defaults into `.agents/flow/config.json`; regenerate `.agents/flow/config.schema.json` via
`pnpm --filter @dorkos/flow generate:schema` (never hand-edit the artifact). This block proves
the poll<->webhook swap is a config edit (G9). Extend
`packages/flow/src/__tests__/config-schema.test.ts`: `FlowConfigSchema.parse({}).ingestion
.producer === 'poll'`. Note inline assumption: default producer is `poll` (v1; webhook deferred
per Non-Goals), default `pollIntervalMs` 60000 mirrors the inbox loop cadence (task 2.4).
Acceptance: `parse({})` resolves the ingestion block; config.json + config.schema.json
regenerated; test green.

### Task 4.5: Add identityMode + comment-and-nudge channel to resolveCommsChannel

- **Size:** medium · **Priority:** high
- **Dependencies:** none · **Parallel with:** 4.1, 4.2

Edit `packages/flow/src/comms.ts`. (1) Add `identityMode: IdentityMode` (from `identity.ts`)
as a third input to `resolveCommsChannel`, and add a third channel to the `CommsChannel` union:
`'comment-and-nudge'`. New matrix: live session (manual + `liveSession`), any mode ->
`interactive`; unattended + `two-account` -> `comment-and-assign`; unattended + `shared` ->
`comment-and-nudge` (comment + `agent/needs-input` durable record + an out-of-band nudge
PROMOTED TO PRIMARY via Relay/Telegram/chat, because in shared mode `assignToHuman` is a no-op
and the tracker will not notify the same account). (2) In the returned `CommsRoute`, when the
channel is `comment-and-nudge`, mark the nudge as the primary attention channel (e.g. add
`nudgePrimary: true`, or document that nudge is the attention channel here, not a courtesy
ping). Update the module TSDoc for three channels + the identity-mode branch; keep
`involvement.comms` tone override orthogonal (it never re-routes). Update `config-schema.ts`
`NudgeSchema` TSDoc to note nudge is promoted to primary in shared mode (no structural schema
change required — the relay/telegram booleans stay). Add comms tests to `__tests__/comms.test.ts`
covering all THREE channels x shared/two-account: interactive (live, both modes),
comment-and-assign (unattended two-account), comment-and-nudge (unattended shared, nudge
primary). Acceptance: shared + unattended -> `comment-and-nudge` with nudge promoted to primary;
two-account + unattended -> `comment-and-assign`; live -> `interactive` in both modes; tests
green.

### Task 4.6: Add the inbox/resume reconciler

- **Size:** medium · **Priority:** high
- **Dependencies:** 4.2, 4.5, 2.2 · **Parallel with:** none

Add the `inbox` (inbox/resume) reconciler to the registry, wrapping `shouldRespondToComment`
(`comment-response.ts`) + the `PollingTransport` (task 4.2). `isDue`: the injected transport has
new events OR there are `agent/needs-input` items to re-check. `run(ctx)`: poll the injected
`InboundTransport` for `TrackerEvent[]`; for each `comment.added` on an `agent/needs-input` item,
re-read the item's current state via the adapter (events-are-triggers-not-truth), apply
`shouldRespondToComment` (rule 3 -> `resume`; the `identity.marker` disambiguates a non-agent
reply in shared mode, rule 1 skips the agent's own), and on `resume` emit a `ReconcileResult`
action to re-attach the worktree at HEAD and resume via `--resume <sessionId>` (read from the
FlowRun, task 3.1) or thread-replay. Idempotent via `dedupeKey` + skip-self-authored.
`defaultConfig.priority = 20` (after recovery, before dispatch), `intervalMs = 60000` (fast).
Register into `defaultRegistry()` (task 2.5 left the slot) and export. Acceptance: a non-agent
reply on a parked item yields a `resume` action carrying the FlowRun `sessionId`; an
agent-authored (marker) reply yields no action (rule 1); the inbox reconciler sorts at priority
20 (after recovery 10, before dispatch 30).

### Task 4.7: Resolve identity 'auto' per tick and feed the oracles

- **Size:** small · **Priority:** medium
- **Dependencies:** 4.5, 4.6 · **Parallel with:** none

Wire per-tick identity resolution so the typed mode-agnostic oracles are actually fed the
resolved `Identity`. Edit `.agents/flow/skills/tending-tracker/SKILL.md` and
`.claude/commands/flow.md`: at the HEAD of each tick, resolve `identity.agent: 'auto'` via the
linear-adapter `getCurrentUser` verb ONCE, build the resolved `Identity { agent, reviewer,
marker }`, derive the mode via `resolveIdentityMode`, and pass that resolved identity + mode
into `classifyOwnership` / `shouldRespondToComment` / `resolveCommsChannel` (the inbox/resume
reconciler from task 4.6 and the team-member tick). Document that `'auto'` is resolved exactly
once per tick (not per item) and cached for the tick, so the mode-agnostic oracles receive a
concrete account id, never the literal `'auto'`. Acceptance: the tick prose names
`getCurrentUser` -> resolved `Identity` -> fed into the three oracles; `resolveCommsChannel` now
receives `identityMode`; confinement guard green.

---

## Phase 5 — Control + honesty

> Make the loop legible and overridable (`/flow:status`, pause/resume, per-reconciler
> config, reclaim), and tighten the honesty guarantees (the widened confinement guard +
> the non-trimmable floor). Tasks 5.2-5.4 are mutually parallel; 5.1 needs the FlowRun
> reader.

### Task 5.1: Add the /flow:status command + status intent

- **Size:** medium · **Priority:** high
- **Dependencies:** 3.1 · **Parallel with:** none

Create `.claude/commands/flow/status.md` (the `/flow:status` command) and add a `status` intent
to the `.claude/commands/flow.md` cold-start routing. The command renders one pane from three
sources: the tracker (via the linear-adapter), `.dork/flow/flow-state.json` (task 3.1
`readFlowState`), and `.dork/flow/auto-run.json`. Show: (1) every claimed / in-flight item
rendered `DOR-123 - Title` (linear-adapter display convention) with its worktree path, branch,
`sessionId`, and current stage/status from the FlowRun; (2) every parked `agent/needs-input`
question with the question text and how long it has waited; (3) the per-item assumption trail
(the `agent/assumption` comments / assumption-log artifact). Add `/flow:status` to the flow
command's stage-model + intents documentation. Acceptance: `/flow:status` produces one pane
covering in-flight + parked + rationale, sourced from flow-state.json + auto-run.json + the
tracker; it names no raw tracker string (routes through the linear-adapter); the new command
file mirrors the thin-trigger shape of the other `.claude/commands/flow/*.md` files; confinement
guard green.

### Task 5.2: Add /flow pause/resume + per-reconciler override + reclaim path

- **Size:** medium · **Priority:** medium
- **Dependencies:** 2.4 · **Parallel with:** 5.1, 5.3, 5.4

Add operator-override surfaces (charter G14). (1) Create `.claude/commands/flow/pause.md` and
`.claude/commands/flow/resume.md` (or a single `/flow pause` / `/flow resume` intent in
flow.md) that toggle BOTH the `.dork/flow/auto-run.json` sentinel (`active: false` on pause)
AND the Pulse cron (`.dork/tasks/flow-drain` frontmatter `enabled`) from one place, so halting
every mode is one action. (2) Document per-reconciler enable/reprioritize as a `loops` config
edit (`loops.<id>.enabled` / `loops.<id>.priority`, task 2.4) — reference it in flow.md and the
dials doc. (3) Document a reclaim/redirect path: an `agent/paused` marker the running tick
honors at STAGE BOUNDARIES (it stops advancing that item and releases the claim cleanly), plus
the existing ownership-policy reassignment for redirecting an item to a human or another agent.
Acceptance: pause halts every mode from one place (sentinel + cron toggled together); the prose
names `loops` config as the disable/reprioritize surface and `agent/paused` as the reclaim
marker honored at stage boundaries; confinement guard green.

### Task 5.3: Widen the tracker-confinement guard + document the 'linear' carve-out

- **Size:** medium · **Priority:** high
- **Dependencies:** none · **Parallel with:** 5.1, 5.2, 5.4

Widen the `tracker-confinement` guard in
`packages/flow/src/__tests__/tracker-confinement.test.ts`. Add to `FLOW_BUNDLE_ROOTS`:
`packages/flow/src` (the engine package), `.dork/tasks/flow-drain`, and
`.claude/hooks/flow-loop.mjs` (a single-file root) — so the autonomous surfaces are guarded,
not just the skills + commands. Exclude from the scan: the guard's OWN test file
(`tracker-confinement.test.ts`) and any `__tests__` file that legitimately asserts on
adapter-doc content (e.g. `linear-adapter-doc.test.ts`) — add an explicit allowlist so these
fixtures don't trip the guard. Document the `'linear'` enum carve-out: the lowercase
`z.enum(['linear'])` literal in `config-schema.ts` `TrackerSchema` and `tasks-schema.ts`
`ProvenanceTrackerSchema` is the generic tracker NAME, not a tracker API string — it does NOT
match the `mcp__linear__` / `LINEAR_[A-Z_]+` / `composio` patterns, so it passes naturally; add
a code comment in the guard documenting why the bare enum is allowed. Add a planted-offender
assertion (unit on the pattern matcher, not real files): a `mcp__linear__foo` string in
`packages/flow/src`, the drain task, and the hook each make the guard FAIL. Acceptance: the
widened guard scans the engine pkg + drain + hook, excludes its own + the adapter-doc test,
passes on the current tree, and fails on a planted `mcp__linear__` string in any of the three
new roots.

### Task 5.4: Make the calibration floor non-trimmable (alwaysAsk .min(1))

- **Size:** small · **Priority:** high
- **Dependencies:** none · **Parallel with:** 5.1, 5.2, 5.3

Make the calibration floor non-trimmable in `packages/flow/src/config-schema.ts` (charter G12
'the floor is inviolable'). Change `CalibrationSchema.alwaysAsk` from
`z.array(AlwaysAskSchema).default([...])` to add `.min(1)` so the array must keep at least one
floor trigger and `alwaysAsk: []` fails to parse. Add a test to
`packages/flow/src/__tests__/config-schema.test.ts`: parsing `{ involvement: { calibration: {
alwaysAsk: [] } } }` through `FlowConfigSchema` (or the `CalibrationSchema` directly) returns a
Zod error / throws on `.parse`; the default parse still yields the four floor triggers
(`irreversible-or-destructive`, `outward-facing`, `secrets-or-spend`, `scope-change`).
Acceptance: `alwaysAsk: []` is rejected by the schema; the default (4 triggers) still parses;
the test asserts both the rejection and the default; no regeneration of config.schema.json is
needed beyond running `generate:schema` to reflect the `minItems` constraint.

---

## Phase 6 — Docs

> The guide series in the reference house style (comparison tables, approach cards with
> pros/cons, dials, decision guides), parallelizable per guide. The autonomy guide (6.3)
> is honesty-gated on the Phase 1-5 capability being real; the rest can land alongside the
> code phases.

### Task 6.1: Write the 'What /flow is' guide

- **Size:** medium · **Priority:** medium
- **Dependencies:** none · **Parallel with:** 6.2, 6.4, 6.5

Create `docs/guides/flow/what-flow-is.mdx` (Fumadocs MDX) — the spine overview in the reference
house style. Cover: the CAPTURE -> TRIAGE -> IDEATE -> SPECIFY -> DECOMPOSE -> EXECUTE -> VERIFY
-> REVIEW -> DONE stage model (a stage table), the one-spine single-source-of-truth principle
(tracker state / label / spec status are PROJECTED from the stage, matched on category not
display name), and the command<->stage map. Use Fumadocs components in the house style (Cards, a
comparison/stage table, Callout). Mirror the existing guides' frontmatter (`title`,
`description`). Acceptance: the guide renders the full spine, the command<->stage table, and the
projection principle; uses table + cards + callout; passes the site build (`apps/site`).

### Task 6.2: Write the 'Driving it manually' guide

- **Size:** medium · **Priority:** medium
- **Dependencies:** none · **Parallel with:** 6.1, 6.4, 6.5

Create `docs/guides/flow/driving-it-manually.mdx`. Cover the manual `/flow:<stage>` commands and
the `/flow auto` terminal drain (server-free), the trigger-door x execution-mode 2x2
(manual/PM-driven x step/autonomous), and a worked example of carrying one item from TRIAGE to
DONE by hand. House style: Steps, the 2x2 table, approach cards with pros/cons. Acceptance: the
guide documents every `/flow:<stage>` command + `/flow auto`, the 2x2, and a worked single-item
example; renders in Fumadocs; passes the site build.

### Task 6.3: Write the 'Turning on autonomy' guide (honesty-gated)

- **Size:** medium · **Priority:** medium
- **Dependencies:** 1.4, 2.6, 3.3, 4.6, 5.1 · **Parallel with:** none

Create `docs/guides/flow/turning-on-autonomy.mdx` — the autonomy reference guide, in the house
style (comparison table, A/B/C approach cards with pros/cons, a 'dials' table, a 'which should I
use' decision guide). Cover: `/flow auto` vs the Pulse seat, the readiness/starvation behavior
(G3, tasks 1.1-1.7), the reconciler order recovery -> inbox/resume -> dispatch (tasks 2.x),
identity-mode-aware question routing + poll-based resume (G4/G10, tasks 4.x), and the always-on
review gate + the non-trimmable calibration floor (G12, task 5.4). HONESTY GATE (charter G12):
this guide ships ONLY when the capability is real — i.e. after Phases 1-5 land. Do NOT merge it
describing unbuilt behavior; no overstated 'runs while you sleep' for pieces still deferred to
P5 (the always-on server runner, approval-detection auto-merge, the webhook transport — name
them as deferred). Acceptance: the guide accurately describes the SHIPPED autonomous behavior
and explicitly marks the P5-deferred pieces as not-yet-real; renders in Fumadocs.

### Task 6.4: Write the 'The dials' config guide

- **Size:** medium · **Priority:** medium
- **Dependencies:** 2.4, 4.4 · **Parallel with:** 6.1, 6.2, 6.5

Create `docs/guides/flow/the-dials.mdx` — the config reference. Document the key
`.agents/flow/config.json` dials in a 'dials' table (each: what it does, default, when to change
it): `involvement.calibration` (the now non-trimmable floor + stage bias), `autonomy` (wipCap,
seat, concurrency), `dispatch.rank` + `sizeOrder`, the new `loops` map (per-reconciler
`enabled`/`priority`/`intervalMs`, task 2.4), and the new `ingestion` block (poll vs webhook,
`pollIntervalMs`, task 4.4). House style: a dials table + callouts. Acceptance: the dials table
covers calibration, autonomy, dispatch, loops, and ingestion with their resolved defaults;
reflects the task-2.4 + task-4.4 config additions; renders in Fumadocs.

### Task 6.5: Write the 'How it works' architecture guide

- **Size:** medium · **Priority:** medium
- **Dependencies:** 2.2, 4.1, 3.1 · **Parallel with:** 6.1, 6.2, 6.4

Create `docs/guides/flow/how-it-works.mdx` — the architecture guide. Cover: the reconciler
registry + generic scheduler (priority order, `isDue`, same-item contention; tasks 2.1-2.2), the
normalized inbound event seam (`TrackerEvent` + `InboundTransport`, poll-vs-webhook
interchangeability; tasks 4.1-4.2), the adapter seam (the linear-adapter / `WorkItem` + the 13
verbs), and the durable `FlowRun` record + recovery ladder (task 3.x). House style: a reconciler
table (watches / decision oracle / cadence) mirroring the plan's section-3.1 table, plus prose
describing the data flow. Acceptance: the guide explains the registry, the event seam, the
adapter seam, and FlowRun; includes the reconciler table; renders in Fumadocs.

### Task 6.6: Register the flow guides in meta.json + surface /flow in slash-commands.mdx

- **Size:** small · **Priority:** medium
- **Dependencies:** 6.1, 6.2, 6.3, 6.4, 6.5 · **Parallel with:** none

Register the flow guide series and surface the command family. (1) Add the five flow guides to
the docs nav: follow the existing `docs/guides/meta.json` `pages` pattern — either list
`flow/what-flow-is`, `flow/driving-it-manually`, `flow/turning-on-autonomy`, `flow/the-dials`,
`flow/how-it-works`, or add a folder entry plus a `docs/guides/flow/meta.json` (match how
Fumadocs nesting is done elsewhere in the repo). (2) Update `docs/guides/slash-commands.mdx` to
surface the `/flow` family in its command list/table: the `/flow` orchestrator +
`/flow:capture|triage|ideate|specify|decompose|execute|verify|done` + `/flow:status` + `/flow
pause`/`/flow resume`. Acceptance: the five flow guides appear in the docs nav; slash-commands.mdx
lists the /flow family; the site build passes. Depends on guides 6.1-6.5 existing.

### Task 6.7: Enumerate README/SPEC/CHARTER as docs members in the bundle manifest

- **Size:** small · **Priority:** low
- **Dependencies:** none · **Parallel with:** 6.1, 6.2, 6.4, 6.5

Enumerate the flow docs as bundle members in `.agents/flow/manifest.json` (charter G15 — docs
travel with the plugin). Add a `docs` entry under `members` listing `.agents/flow/README.md`,
`.agents/flow/SPEC.md`, and `.agents/flow/CHARTER.md` as the in-repo canon docs, plus a pointer
to the dorkos.ai guide series (`docs/guides/flow/`). Follow the existing `members` entry shape
(`name` / `source` / `projection` / `description`); use a projection value consistent with the
other non-projected members (e.g. `loaded-by-skills` or a new `docs` projection — match the
manifest's conventions). Optionally add `docs` to the top-level `layers` array if that is how the
harness enumerates doc layers. Acceptance: `manifest.json` enumerates README/SPEC/CHARTER as docs
members and points at the guide series; the JSON stays valid and consistent with the existing
members shape.

---

## Deferred (P5 / server build — NOT tasks)

These are explicit Non-Goals of spec #262 (deferred to DOR-88/89 and DOR-102). They are listed
here for traceability only — no task is created for them:

- The **always-on server scheduler** that executes the reconcilers unattended (v1 follows the
  registry order from prose; the continuous runner is P5).
- **Atomic concurrency / fencing** — fencing token, heartbeat, atomic multi-claim, stall-detector
  (v1 stays `concurrency: sequential`, WIP-1).
- **Approval detection + auto-merge execution** (resume-on-approval); v1 keeps the manual
  `/flow:done` after the human merges.
- The **webhook transport** (v1 ships `PollingTransport` + the seam; the webhook producer is the
  deferred drop-in — it needs an inbound endpoint we do not have).
- **Linear Agent Accounts** (`actor=app`) as the two-account backend (DOR-102).
