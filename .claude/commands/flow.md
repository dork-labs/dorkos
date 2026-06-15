---
description: The /flow engine — one PM-agnostic workflow from capture to done. Routes to a stage, advances a work item, or (P2) drives the autonomous loop.
category: flow
allowed-tools: Read, Glob, Grep, SlashCommand, Task, TaskList, TaskGet, AskUserQuestion
argument-hint: '[stage | work-item | auto]'
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

All tracker I/O routes through the `linear-adapter` skill.

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

- **A stage name** (e.g. `/flow specify`) → invoke that stage's `/flow:<stage>` command.
- **A work item or spec path** → determine its current stage from its `stage/*`
  label (via the `linear-adapter` skill) or its spec artifacts, then advance one stage.
- **`auto`** → drain the ready queue autonomously to the human-review gate (below).

Choose the next action and invoke the matching `/flow:<stage>` command; when the
stage is ambiguous, ask.

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
