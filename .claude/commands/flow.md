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

**No arguments (cold start).** When `$ARGUMENTS` is empty, do not guess. Offer the
operator four intents via `AskUserQuestion`, then route the choice:

1. **Capture a new thought**: save a raw idea, no evaluation yet → `/flow:capture`
2. **Work on a project**: via the `linear-adapter` `getProjects` verb, list the active
   (non-terminal) projects and let the operator pick one, then route the chosen project
   through **"Working on a project"** (below). With no active projects, fall through to a
   typed project name via `resolveProject`.
3. **Continue the queue**: pick up the next-ranked item across the whole ready queue and
   carry it to its gate, then stop → **single-item dispatch** (below)
4. **Triage the backlog**: classify and route captured items → `/flow:triage`

`AskUserQuestion` auto-appends an **"Other"** free-text option: a stage name, a specific
item (an issue # or description, resolved then advanced one stage), a **project name**
(resolved via the `linear-adapter` `resolveProject` verb), or `auto` to drain the whole
queue.

**With arguments, resolve and route** (resolution precedence, first match wins):

1. **A stage name** (e.g. `/flow specify`): invoke that stage's `/flow:<stage>` command.
2. **An explicit work item** (an issue identifier like `DOR-157`, or a spec path):
   determine its current stage from its `stage/*` label (via the `linear-adapter` skill)
   or its spec artifacts, then advance one stage.
3. **`continue` or `auto`** (optionally followed by a project name, see below): the
   queue-draining modes.
4. **A project** (a tracker project name, a spec slug that homes on a project, or a
   project umbrella's identifier): resolve it via the `linear-adapter` `resolveProject`
   verb, then route by the project's state (see "Working on a project" below).
5. **Otherwise**: treat the argument as a work-item description, resolve the item via the
   `linear-adapter`, then advance one stage.

When a name matches more than one thing (two projects, or an item and a project), do not
guess: list the matches with `AskUserQuestion` and let the operator pick. A bare token that
matches a stage name resolves as that **stage** (precedence rule 1); to address a project
whose name collides with a stage, name it explicitly with `/flow resume <project>` or pass
the project's umbrella identifier.

### Working on a project

`/flow <project>` (and the aliases `/flow start <project>` / `/flow resume <project>`)
resolves the project, then routes by where it sits on the spine:

- **Has dispatchable children** (one or more `agent/ready` items in a non-terminal state):
  **project-scoped single-item dispatch**. Via the `linear-adapter`, pull the project's
  candidate set with `getProjectWork(projectId)`, rank it with the dispatch ladder
  (`@dorkos/flow` `selectDispatch`, which already honors the `projectStatus` tier and the
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
  dispatch ladder (`@dorkos/flow` `selectDispatch`), claim the top-ranked eligible item, and
  carry it to its human-review gate, then **stop**. This is one tick of `auto`: server-free,
  a single item, never looping. It writes **no** `.dork/flow/auto-run.json` sentinel (that
  file is `auto` only), so the `flow-loop` Stop hook stays a strict no-op and the session
  ends after the one item.
- **`auto`**: drain the whole ready queue autonomously to the human-review gate (below).

When the stage is still ambiguous after this, ask.

## `/flow auto` — drain the ready queue (manual autonomous mode)

Drain the ready queue **sequentially from the terminal**, server-free. Each
issue is carried to its human-review gate; involvement is uncertainty-gated
(the calibration ladder, `@dorkos/flow` `resolveInvolvement`), and comms route
through the live terminal — `AskUserQuestion` inline, never a parked tracker
comment (`resolveCommsChannel` returns `interactive` for a manual + live-session
trigger).

**The active-run sentinel (what the Stop hook reads).** `/flow auto` keeps the
session looping by signalling its state in `.dork/flow/auto-run.json`. The
`flow-loop.mjs` Stop hook reads ONLY this file: with it absent (every normal
session, every `/flow:<stage>` step run) the hook is a strict no-op and the
session stops. This sentinel is distinct from the per-issue `flow-state.json`
run record (the session↔issue association, recovery ladder).

1. **Start.** Write `.dork/flow/auto-run.json` =
   `{ "active": true, "ready": <N>, "startedAt": "<ISO>", "pid": <pid> }`,
   where `<N>` is the count of ready, eligible issues from the dispatch policy.
2. **Each iteration.**
   - Via the `linear-adapter` skill, fetch eligible work and rank it with the
     dispatch ladder (the typed oracle is `@dorkos/flow` `selectDispatch`).
   - If the queue is empty (or the only remaining work is parked on a human or a
     gate), set `ready: 0` and go to **Stop**.
   - Otherwise claim the top-ranked eligible issue (durable label + state, via
     the adapter), provision its worktree, and carry it through the stages to its
     human-review gate. At every decision point walk the calibration ladder;
     `stop-and-ask` on a live terminal asks inline via `AskUserQuestion`.
   - After the issue reaches its gate (or parks on a genuine question), update
     `ready` in the sentinel to the new remaining count.
3. **Loop continuation.** While `active: true` and `ready > 0`, the `flow-loop`
   Stop hook blocks the stop (exit 2) and the drain continues to the next issue.
   Output `<promise>ABORT</promise>` to stop early, or `<promise>PHASE_COMPLETE:auto</promise>`
   to end the drain cleanly — either overrides the sentinel and allows the stop.
4. **Stop / teardown.** When the queue is drained (or on abort), **delete**
   `.dork/flow/auto-run.json`. With the sentinel gone the Stop hook fails open
   and the session ends. Never leave a stale sentinel — it would trap the next
   session in the drain loop.

All tracker I/O — fetch, rank inputs, claim, transition, comment, assign — routes
through the `linear-adapter` skill; this command never names a tracker string.
