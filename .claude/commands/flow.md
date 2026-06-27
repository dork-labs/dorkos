---
description: The /flow engine — one PM-agnostic workflow from capture to done. Routes to a stage, advances a work item or project, or (P2) drives the autonomous loop.
category: flow
allowed-tools: Read, Glob, Grep, SlashCommand, Task, TaskList, TaskGet, AskUserQuestion
argument-hint: '[stage | work-item | project | continue | auto]'
---

# /flow — the workflow engine

One canonical stage model, run two ways: manually via these commands, or
autonomously through a PM tool. Resolve and route: $ARGUMENTS

## Stage model (command ↔ stage)

| Stage     | Command           | Skill               |
| --------- | ----------------- | ------------------- |
| CAPTURE   | `/flow:capture`   | `capturing-work`    |
| TRIAGE    | `/flow:triage`    | `triaging-work`     |
| IDEATE    | `/flow:ideate`    | `ideating-features` |
| SPECIFY   | `/flow:specify`   | `specifying-work`   |
| DECOMPOSE | `/flow:decompose` | `decomposing-work`  |
| EXECUTE   | `/flow:execute`   | `executing-specs`   |
| VERIFY    | `/flow:verify`    | `verifying-work`    |
| REVIEW    | — (human gate)    | —                   |
| DONE      | `/flow:done`      | `closing-work`      |

All tracker I/O routes through the `linear-adapter` skill. When this command names
a work item to the operator (the dispatch pick, the ready-queue list, the resumed
item), render it as identifier with title (`DOR-157 - Title`), per the
linear-adapter display convention; never a bare key.

**Observe + control (non-stage commands).** Three commands sit beside the spine;
they observe or steer the loop, never advance a stage:

| Verb     | Command        | What it does                                                      |
| -------- | -------------- | ----------------------------------------------------------------- |
| `status` | `/flow:status` | One pane: in-flight items, parked questions, the assumption trail |
| `pause`  | `/flow:pause`  | Halt every autonomous mode (drain sentinel + Pulse cron) at once  |
| `resume` | `/flow:resume` | Restore what `pause` halted                                       |

## Trigger doors × execution modes (orthogonal)

The trigger source (manual CLI vs PM-driven) is **orthogonal** to the execution
mode (step vs autonomous). The 2×2:

|                        | **Step** (run one stage, stop)      | **Autonomous** (run to a gate)                                 |
| ---------------------- | ----------------------------------- | -------------------------------------------------------------- |
| **Manual** (CLI/slash) | `/flow:specify`, `/flow:execute`    | `/flow auto` — drain the ready queue from the terminal         |
| **PM-driven**          | rare; explicit single-stage advance | default — a Pulse tick claims an issue, carries it to its gate |

Every stage is autonomous-capable; the human is pulled in by **uncertainty**
(the calibration ladder), not by stage. `/flow auto` is the manual-autonomous
cell — a live terminal drain, server-free (no DorkOS server required). The
PM-driven-autonomous cell is the Pulse seat, a fresh session per tick.

## Routing

**First-run guard (before any routing).** On any `/flow` invocation, confirm flow
is configured: if `.agents/flow/config.json` is absent, or fails validation when run
through `node .agents/flow/scripts/validate-config.mjs` (config JSON in, the
`FlowConfigSchema` parse result JSON out), route straight to `/flow:init` to scaffold
it and stop, before any stage or dispatch work. With a valid config present, behave
exactly as below.

**No arguments (cold start).** When `$ARGUMENTS` is empty, do not guess. Offer the
operator five intents via `AskUserQuestion`, then route the choice:

1. **Capture a new thought**: save a raw idea, no evaluation yet → `/flow:capture`
2. **Work on a project**: via the `linear-adapter` `getProjects` verb, list the active
   (non-terminal) projects and let the operator pick one, then route the chosen project
   through **"Working on a project"** (below). With no active projects, fall through to a
   typed project name via `resolveProject`.
3. **Continue the queue**: pick up the next-ranked item across the whole ready queue and
   carry it to its gate, then stop → **single-item dispatch** (below)
4. **Triage the backlog**: classify and route captured items → `/flow:triage`
5. **Check loop status**: render the in-flight / parked / assumptions pane → `/flow:status`

**Recommended default (starvation-aware).** Before presenting the five intents,
peek at the dispatch outcome by feeding the `linear-adapter` candidate set to
`node .agents/flow/scripts/dispatch.mjs` (candidate set + policy as JSON in,
`classifyDispatchOutcome`'s `{ picked, eligibleCount, starved, shapeableCount }` as
JSON out; act on the counts). When the ready queue is empty but shapeable work waits
behind the readiness gate (`eligibleCount === 0 && shapeableCount > 0`), the queue
is **starved**, so default the recommended `AskUserQuestion` intent to **"Triage
the backlog"** (intent 4) and note "0 ready, <N> shapeable: run a triage pass?".
When ready work exists, default instead to **"Continue the queue"** (intent 3).
Render any named item as `DOR-123 - Title` (linear-adapter display convention).

`AskUserQuestion` auto-appends an **"Other"** free-text option: a stage name, a specific
item (an issue # or description, resolved then advanced one stage), a **project name**
(resolved via the `linear-adapter` `resolveProject` verb), or `auto` to drain the whole
queue.

**With arguments, resolve and route** (resolution precedence, first match wins):

1. **A control verb** (`status`, `pause`, or bare `resume`): invoke `/flow:status` /
   `/flow:pause` / `/flow:resume`. These observe or steer the loop; they never advance a
   stage. Disambiguation: `resume <project>` (a project name follows) keeps its existing
   meaning: carry that project forward (precedence rule 5, "Working on a project"); bare
   `resume` or `resume <issue-id>` un-pauses autonomy via `/flow:resume`.
2. **A stage name** (e.g. `/flow specify`): invoke that stage's `/flow:<stage>` command.
3. **An explicit work item** (an issue identifier like `DOR-157`, or a spec path):
   determine its current stage from its `stage/*` label (via the `linear-adapter` skill)
   or its spec artifacts, then advance one stage.
4. **`continue` or `auto`** (optionally followed by a project name, see below): the
   queue-draining modes.
5. **A project** (a tracker project name, a spec slug that homes on a project, or a
   project umbrella's identifier): resolve it via the `linear-adapter` `resolveProject`
   verb, then route by the project's state (see "Working on a project" below).
6. **Otherwise**: treat the argument as a work-item description, resolve the item via the
   `linear-adapter`, then advance one stage.

When a name matches more than one thing (two projects, or an item and a project), do not
guess: list the matches with `AskUserQuestion` and let the operator pick. A bare token that
matches a stage name resolves as that **stage** (precedence rule 2); to address a project
whose name collides with a stage, name it explicitly with `/flow resume <project>` or pass
the project's umbrella identifier.

### Working on a project

`/flow <project>` (and the aliases `/flow start <project>` / `/flow resume <project>`)
resolves the project, then routes by where it sits on the spine:

- **Has dispatchable children** (one or more `agent/ready` items in a non-terminal state):
  **project-scoped single-item dispatch**. Via the `linear-adapter`, pull the project's
  candidate set with `getProjectWork(projectId)`, rank it with the dispatch ladder by
  running `node .agents/flow/scripts/dispatch.mjs` (candidate set as JSON in, the ranked
  `selectDispatch` result as JSON out; it already honors the `projectStatus` tier and the
  `perProject` WIP cap), claim the top-ranked item, and carry it to its human-review gate,
  then **stop**. One item, never looping, no `auto` sentinel.
- **No dispatchable children yet** (still being shaped, pre-DECOMPOSE): advance the
  project's **umbrella issue** one stage, exactly like routing a work item (its `stage/*`
  label drives which). This is how `/flow resume <project>` carries a freshly-ideated
  project into SPECIFY.

**Project-scoped queue modes** narrow the global modes to one project's queue:

- **`/flow continue <project>`**: one project-scoped dispatch tick (identical to
  `/flow <project>` when the project has dispatchable children).
- **`/flow auto <project>`**: drain that project's ready queue autonomously to the
  human-review gate, the same loop as bare `/flow auto` (below) but with the candidate set
  scoped to the project via `getProjectWork`. Honors `autonomy.wipCap.perProject`.

### Global queue modes (no project scope)

- **`continue`** (or the cold-start "Continue the queue" choice): **single-item dispatch**
  across the whole ready queue. Via the `linear-adapter`, rank the ready queue with the
  dispatch ladder by running `node .agents/flow/scripts/dispatch.mjs` (candidate set as
  JSON in, the ranked `selectDispatch` result as JSON out), claim the top-ranked eligible
  item, and
  carry it to its human-review gate, then **stop**. This is one tick of `auto`: server-free,
  a single item, never looping. It writes **no** `.dork/flow/auto-run.json` sentinel (that
  file is `auto` only), so the `flow-loop` Stop hook stays a strict no-op and the session
  ends after the one item.
- **`auto`**: drain the whole ready queue autonomously to the human-review gate (below).

When the stage is still ambiguous after this, ask.

## `/flow auto` — drain the ready queue (manual autonomous mode)

Drain the ready queue **sequentially from the terminal**, server-free. Each
issue is carried to its human-review gate; involvement is uncertainty-gated
(the calibration ladder: run `node .agents/flow/scripts/involvement.mjs` with the
decision context as JSON in for the `resolveInvolvement` verdict as JSON out), and comms route
through the live terminal — `AskUserQuestion` inline, never a parked tracker
comment (`resolveCommsChannel(trigger, identityMode, involvement)` returns
`interactive` for a manual + live-session trigger in either identity mode;
unattended routes split by mode, `comment-and-assign` for two-account and
`comment-and-nudge` for shared).

**The active-run sentinel (what the Stop hook reads).** `/flow auto` keeps the
session looping by signalling its state in `.dork/flow/auto-run.json`. The
`flow-loop.mjs` Stop hook reads ONLY this file: with it absent (every normal
session, every `/flow:<stage>` step run) the hook is a strict no-op and the
session stops. This sentinel is distinct from the per-issue `flow-state.json`
run record (the session↔issue association, recovery ladder).

1. **Start.** Write `.dork/flow/auto-run.json` =
   `{ "active": true, "ready": <N>, "shapeable": <M>, "startedAt": "<ISO>", "pid": <pid> }`.
   Both counts come from `node .agents/flow/scripts/dispatch.mjs` (candidate set as
   JSON in, `classifyDispatchOutcome`'s `{ picked, eligibleCount, starved, shapeableCount }`
   as JSON out):
   `<N>` is `eligibleCount` (ready, eligible issues from the dispatch policy) and
   `<M>` is `shapeableCount` (dispatchable-category items still behind the
   `agent/ready` gate). The `shapeable` field is the sentinel that lets the
   `flow-loop` Stop hook tell a **starved** queue (work waiting on a triage pass)
   from a genuinely **drained** one (task 1.7). (Inline assumption: the auto-run
   sentinel gains `shapeable: <N>`.)
2. **Each iteration runs the reconciler registry order: recovery → inbox/resume → dispatch.**
   This mirrors the flow engine's `runTick` walking the `loops` config (the typed
   source of truth) in ascending priority — `loops.recovery` (10) before
   `loops.inbox` (20) before `loops.dispatch` (30). The continuous unattended
   runner that actually calls `runTick` on a timer is the deferred P5 server build;
   v1 walks the same order by hand in this prose. Each pass re-derives truth via
   the `linear-adapter` before acting (events are triggers, not truth), and a
   higher-priority pass that claims an item wins same-item contention (recovery
   re-adopts an orphan before dispatch tries to claim it).
   - **(0) Resolve identity for the tick.** Before any pass, via the
     `linear-adapter` call `getCurrentUser` **once** to resolve
     `identity.agent: "auto"` into the authenticated account id; build the resolved
     `Identity { agent, reviewer, marker }` and derive the mode with the flow engine's
     `resolveIdentityMode` (`reviewer` unset / `null` / equal to `agent` is
     **shared**; a distinct reviewer is **two-account**). Resolve this **once per
     tick, not per item**, and cache it: feed the same resolved `Identity` + mode
     into `classifyOwnership` (dispatch + ownership), `shouldRespondToComment`
     (inbox), and `resolveCommsChannel(trigger, identityMode, involvement)`
     (stop-and-ask routing), so the typed oracles always receive a concrete account
     id, never the literal `"auto"`.
   - **(1) Recovery pass** (`loops.recovery`, priority 10) — re-adopt orphaned
     claimed work at the head of the tick, and garbage-collect stale runs first.
     Read the durable run map from `.dork/flow/flow-state.json` via the typed
     the flow engine's `readFlowState`, then call `gcFlowState` to drop records whose
     issue is closed/terminal (so the store stays honest before any new claim). Via
     the `linear-adapter`, list `agent/claimed` + started-category +
     not-`agent/needs-input` items. For each, take its `FlowRun` from the run map,
     probe whether its `workerPid` is alive and the worktree/session checkpoint
     survives, and run the recovery oracle `node .agents/flow/scripts/recovery.mjs`
     (the run record + liveness probe as JSON in, the `recoverOrphan` `RecoveryAction`
     as JSON out): on `resume`, re-attach the worktree at HEAD and **resume** the captured
     `sessionId` rather than re-claim from scratch; otherwise act on the returned
     `RecoveryAction` (`restart-clean`, `escalate` to `agent/blocked`, or
     `re-derive`). A parked `agent/needs-input` item is never reclaimed.
   - **(2) Inbox/resume pass** (`loops.inbox`, priority 20) — un-park answered
     questions before claiming anything new. This is the typed `inbox` reconciler
     (the flow engine's `inboxReconciler`) wrapping `shouldRespondToComment` over the
     normalized event seam: via the `linear-adapter`, poll the inbox into the
     `InboundTransport` (the flow engine's `PollingTransport`, fed by the adapter's
     `getInbox` + a durable watermark) to get `comment.added` `TrackerEvent`s on
     `agent/needs-input` items. Events are triggers, not truth: re-read each item's
     current state, then run `shouldRespondToComment` (rule 3 → `resume`; the
     resolved `identity.marker` from step 0 disambiguates a non-agent reply in
     shared mode, and rule 1 skips the agent's own). On `resume`, re-attach the
     worktree at HEAD and resume the parked run via `--resume <sessionId>` (read
     from the item's `FlowRun`) or thread-replay. The poll↔webhook producer is a
     config edit (`ingestion.producer`), never a code change.
   - **(3) Dispatch pass** (`loops.dispatch`, priority 30) — claim the top-ranked
     ready item and carry it to its gate. Via the `linear-adapter`, fetch eligible
     work and classify the dispatch outcome by running
     `node .agents/flow/scripts/dispatch.mjs` (candidate set as JSON in,
     `classifyDispatchOutcome`'s `{ picked, eligibleCount, starved, shapeableCount }`
     as JSON out), which both ranks the ready queue (`selectDispatch`) and counts the
     shapeable backlog behind the readiness gate. - **If `picked` is empty, do not stop silently.** Branch on `shapeableCount`: - **Starved** (`shapeableCount > 0`): the queue is starved, not done. Write
     `ready: 0, shapeable: <M>` to the sentinel, then surface it: report
     "Queue starved: 0 ready, <M> shapeable: run a triage pass?" and offer, via
     `AskUserQuestion`, to run `/flow:triage` to ready that backlog (then resume
     the drain) or to stop. A triage pass produces the `agent/ready` fuel
     dispatch needs. Render any named item as `DOR-123 - Title` (linear-adapter
     display convention). - **Done** (`shapeableCount === 0`): the queue is genuinely drained (or the
     only remaining work is parked on a human or a gate). Set
     `ready: 0, shapeable: 0` and go to **Stop**. - Otherwise claim the top-ranked eligible issue (`picked[0]`, durable label +
     state, via the adapter) and provision its worktree. On claim, persist a
     `FlowRun` to `.dork/flow/flow-state.json` via the flow engine's typed
     `writeFlowRun`, following the `FlowRun` shape:
     `{ issueId, identifier, sessionId, worktreePath, branch, stage, status,
attemptCount, workerPid, startedAt }`, with `status` starting at `queued`
     then `running`. This is the per-issue session↔issue record the recovery pass
     adopts (distinct from the `.dork/flow/auto-run.json` drain sentinel). Carry
     the item through the stages to its human-review gate, advancing the record
     with `updateFlowRunStatus` at each transition (`waiting_for_review` at the
     review gate, `complete` at DONE; move `stage` in lockstep). At each stage
     boundary, honor the operator override: if the item now carries the
     `agent/paused` marker (via the `linear-adapter`), advance it no further,
     release the claim cleanly, and move on (see "Operator override" below). At
     every decision point walk the calibration ladder; `stop-and-ask` on a live
     terminal asks inline via `AskUserQuestion`.
   - After the iteration reaches a gate (or parks on a genuine question), update
     `ready` **and** `shapeable` in the sentinel to the new remaining counts.

3. **Loop continuation.** While `active: true` and `ready > 0`, the `flow-loop`
   Stop hook blocks the stop (exit 2) and the drain continues to the next issue.
   Output `<promise>ABORT</promise>` to stop early, or `<promise>PHASE_COMPLETE:auto</promise>`
   to end the drain cleanly — either overrides the sentinel and allows the stop.
4. **Stop / teardown.** When the queue is drained (or on abort), **delete**
   `.dork/flow/auto-run.json`. With the sentinel gone the Stop hook fails open
   and the session ends. Never leave a stale sentinel — it would trap the next
   session in the drain loop.

## Operator override (pause / resume / reclaim)

The operator always outranks the loop. Three override surfaces, coarse to fine:

- **Halt everything.** `/flow:pause` stops every autonomous mode from one place: it
  sets `active: false` in the `.dork/flow/auto-run.json` drain sentinel AND
  `enabled: false` in the `.dork/tasks/flow-drain` Pulse cron frontmatter, so no
  mode keeps claiming. `/flow:resume` restores both. Halting and restoring autonomy
  is always one action, never a hunt across files.
- **Disable or reorder one loop.** Per-reconciler control is a `loops` config edit,
  not a command: `loops.<id>.enabled: false` silences a single reconciler (e.g.
  `loops.triage`, `loops.hygiene`) and `loops.<id>.priority` reorders the tick. Edit
  `.agents/flow/config.json`; see the dials guide (`docs/guides/flow/the-dials.mdx`).
- **Reclaim or redirect one item.** Via the `linear-adapter`, apply the
  **`agent/paused`** marker to an item. The running tick honors `agent/paused` **at
  stage boundaries**: it advances the item no further, releases the claim cleanly
  (drops `agent/claimed`), and leaves the worktree intact for inspection, rather
  than abandoning a half-finished stage. To hand the item to a human or another
  agent instead, use the ownership-policy reassignment (reassign on the tracker via
  the `linear-adapter`); `classifyOwnership` then treats it as not-ours.

All tracker I/O (fetch, rank inputs, claim, transition, comment, assign) routes
through the `linear-adapter` skill; this command never names a tracker string.
