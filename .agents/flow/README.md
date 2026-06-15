# flow — the `/flow` engine

> One unified, PM-agnostic workflow system spanning **capture → done**. A single
> identifiable installable unit: manual stages you drive from the terminal, and
> an autonomous loop seated on DorkOS Pulse.

This README is **the manual**. See [`SPEC.md`](./SPEC.md) for the contract (the
stage model, the `PMClient` promotion surface, the config schema, the `FlowRun`
record, and the typed engine).

> [!IMPORTANT]
> **Autonomous mode depends on a running DorkOS server (Pulse). Manual mode does
> not.** `/flow`, `/flow:<stage>`, and `/flow auto` (terminal draining) run
> without the server. The autonomous Pulse-seated loop (`.dork/tasks/flow-drain/`)
> requires the DorkOS server running to host the chokidar watcher + croner.

## Stages

One canonical spine — the unit of "where work is." Spec status, tracker state,
labels, and loop phase are all **projected** from the stage by the adapter, never
authored independently.

```
 manual ─▶  CAPTURE → TRIAGE → IDEATE → SPECIFY → DECOMPOSE → EXECUTE →
 PM-driven ─▶        VERIFY → ⟦HUMAN REVIEW⟧ → DONE → (MONITOR → SIGNAL)
                     ▲ adapter (PMClient): Linear today, swappable
```

- **CAPTURE** — quick, low-commitment intake of a raw thought as an `idea`. Does
  not evaluate or classify. (`capturing-work`)
- **TRIAGE** — classify freeform input into a type, or evaluate a captured item
  (accept / reject / needs-research / needs-refinement) and make the
  **simple-vs-complex** routing call. (`triaging-work`)
- **IDEATE** — shape a complex brief into a structured ideation artifact.
  (`ideating-features`)
- **SPECIFY** — turn ideation into a frozen specification + draft ADRs.
  (`specifying-work`)
- **DECOMPOSE** — break the spec into `03-tasks.json` tasks (mirrored to the
  tracker as a checklist; promote a sub-issue only at `size ≥ "xl"`).
  (`decomposing-work`)
- **EXECUTE** — implement the tasks across dependency-aware batches in an
  isolated worktree. (`executing-specs`)
- **VERIFY** — run the touched surface, capture proof-of-completion evidence,
  open the PR, and hand off to review. (`verifying-work`)
- **REVIEW** — the **human gate**. The engine parks here; there is no skill and
  no command. On approval + green CI it resumes into DONE.
- **DONE** — close the work, create follow-ups, run the project-pulse check, and
  tear down the worktree. (`closing-work`)
- **MONITOR / SIGNAL** — the optional tail that keeps the loop spinning.

Match on a tracker state's **category** (`backlog | unstarted | started |
completed | canceled`), never its display **name** — that is what keeps the
system portable across teams and trackers.

## Modes

The **trigger source** is orthogonal to the **execution mode** — a 2×2, not a
single axis:

|                        | **Step** (run one stage, stop)      | **Autonomous** (run to a gate)                                |
| ---------------------- | ----------------------------------- | ------------------------------------------------------------- |
| **Manual** (CLI/slash) | `/flow:specify`, `/flow:execute`    | `/flow auto` — drain the ready queue from the terminal        |
| **PM-driven**          | rare; explicit single-stage advance | default — a Pulse tick claims an item, carries it to its gate |

- **Manual + Step** — `/flow:<stage>` advances one stage and stops. Questions
  arrive interactively. Server-free.
- **Manual + Autonomous** — `/flow auto` drains the ready queue **sequentially
  from the terminal**, carrying each item to its review gate. Server-free.
- **PM-driven + Step** — rare; an explicit single-stage advance triggered by a
  tracker transition.
- **PM-driven + Autonomous** — the default seat: a **Pulse** tick claims the
  top-ranked eligible item and carries it to its gate in a **fresh per-item
  session**. **Requires the DorkOS server** (see below).

Every stage is autonomous-capable. The human is pulled in by **uncertainty** (the
calibration ladder), not by stage — which is why IDEATE asks freely while EXECUTE
asks rarely, as an emergent property of one rule.

## Command ↔ state map

Each `/flow:<stage>` command is a **thin trigger** (≤ ~40 LOC) over the stage
skill. A PM transition into a stage and the slash command are two **triggers** for
the same skill. The mapping is generated from [`config.json`](./config.json)
`stages`:

| Stage     | Command           | Skill               | Stage label       | State category    |
| --------- | ----------------- | ------------------- | ----------------- | ----------------- |
| CAPTURE   | `/flow:capture`   | `capturing-work`    | `stage/capture`   | backlog           |
| TRIAGE    | `/flow:triage`    | `triaging-work`     | `stage/triage`    | backlog/unstarted |
| IDEATE    | `/flow:ideate`    | `ideating-features` | `stage/ideate`    | unstarted         |
| SPECIFY   | `/flow:specify`   | `specifying-work`   | `stage/specify`   | unstarted         |
| DECOMPOSE | `/flow:decompose` | `decomposing-work`  | `stage/decompose` | unstarted         |
| EXECUTE   | `/flow:execute`   | `executing-specs`   | `stage/execute`   | started           |
| VERIFY    | `/flow:verify`    | `verifying-work`    | `stage/verify`    | started           |
| REVIEW    | — (human gate)    | —                   | —                 | started           |
| DONE      | `/flow:done`      | `closing-work`      | `stage/done`      | completed         |

`/flow` (no stage) is the orchestrator: it resolves a stage name, a work item, or
`auto`, then routes to the matching command.

## Gates

Involvement is **uncertainty-gated, not stage-gated** (the calibration ladder,
spec §5). The hard gates:

1. **Question / soft-escalation** — any stage, dynamic; driven by the calibration
   ladder. Row 0 (the floor) always stops for irreversible/destructive,
   outward-facing, secrets/spend/prod, or material-scope-change actions, even at
   full confidence.
2. **Plan-approval gate** (after DECOMPOSE) — **off by default**
   (`gates.planApproval: false`). The engine flows DECOMPOSE → EXECUTE and
   surfaces plan assumptions at the review gate. Flip it on for a pre-code
   checkpoint.
3. **Human-review gate** (after VERIFY) — **always on.** PR + evidence → review
   state → assign the human → stop. On approval + green CI → auto-merge + close +
   teardown.
4. **Circuit breaker** — stop + escalate if a unit exceeds `estimate × N`
   wall-clock or the token budget.

**Auto-merge recovery ladder** (spec §6): approval authorizes one specific state
— this diff, green, cleanly mergeable. If that state can't be reproduced at merge
time, the engine checks _mergeable? · CI green? · functionally unchanged?_ and
routes each failure through the calibration ladder (mechanical conflict → resolve

- announce; real tradeoff → bounce; behavior drift → re-request approval).

## Adapter interface

The `linear-adapter` skill is the v1 **`PMClient`**: it owns **every** tracker
call (Linear MCP primary, Composio `--account personal` fallback) and fulfils the
capability verbs as a **documented prose contract**. Generic stage skills call it
by naming a verb (e.g. _"via the linear-adapter, transition the item …"_) and
never touch a tracker string — a grep guard enforces zero `mcp__linear__*` /
Composio strings outside the adapter.

The verbs: `getCurrentUser`, `getProjects`, `getEligibleWork`, `getInbox`,
`getRelations`, `claim`, `transition`, `comment`, `assignToHuman`,
`attachEvidence`, `needsInput`, `link`, `createSubIssue`. The adapter normalizes
every tracker into one `WorkItem` shape so the dispatch policy and stage skills
never see a tracker-specific field. Full verb contract: the adapter's
[`SKILL.md`](./skills/linear-adapter/SKILL.md); the typed `interface PMClient`
the P5 server build promotes it into is in [`SPEC.md`](./SPEC.md).

## Autonomous mode & the server dependency

The autonomous loop is seated on **DorkOS Pulse** via a file-based schedule
(`.dork/tasks/flow-drain/SKILL.md`). Pulse already provides a contextless
code-loop (croner) that dispatches a fresh, isolated, resumable, runtime-agnostic
agent session per run — so there is no scheduler to build.

- **One tick = one issue.** Each croner fire is a fresh run-session
  (`sessionId = run.id`) that claims and works exactly one issue to its gate, then
  ends — preserving fresh-session-per-issue.
- **Activation requires** the DorkOS server running (hosts the watcher + croner)
  and the project's DorkOS agent registered (a global `~/.dork/tasks/` task is
  watched unconditionally). No build step, no migration — dropping the file is
  picked up live.
- **Crash/stall recovery** is driven by the durable `FlowRun` record + the
  next-tick recovery ladder (spec §12): a `needs-input` item is never reclaimed;
  an orphaned `agent/claimed` item is adopted + resumed (re-attach the worktree at
  HEAD, resume the session) or restarted clean, with `attemptCount` guarding
  against runaway retries.

> **Autonomous mode depends on a running DorkOS server (Pulse); manual mode does
> not.** A non-DorkOS repo wanting autonomous mode can use the documented generic
> `claude -p`-per-issue watcher fallback (not built in v1).

## Configuration

Defaults live in [`config.json`](./config.json), validated against the
Zod-generated [`config.schema.json`](./config.schema.json) (authored as the
`@dorkos/flow` `FlowConfigSchema`, bridged via `z.toJSONSchema`). An optional
per-repo `WORKFLOW.md` override sits at the repo root. The resolved defaults
encode the key decisions: `planApproval: false`, `subIssueThreshold: "xl"`,
`perIssue: "fresh-session"`, `seat: "pulse"`. See [`SPEC.md`](./SPEC.md) →
_Config schema reference_ for the full contract.

## Templates

The system owns a template set under [`templates/`](./templates/README.md),
**loaded by skills** (not projected to any harness):

- [`templates/records/`](./templates/README.md) — tracker work-item bodies by
  type (`idea` · `research` · `hypothesis` · `task` · `project`), each with
  `## Validation criteria` + `## On Completion`.
- [`templates/docs/`](./templates/README.md) — the filesystem doc scaffolds
  (ideation · specification · `03-tasks.json` · ADR).
- [`templates/pr.md`](./templates/pr.md) — the PR template the VERIFY stage fills
  at the review gate.
