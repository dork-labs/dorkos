---
name: flow-drain
display-name: /flow drain ready queue
description: Claim the top-ranked eligible issue and carry it to its review gate.
cron: '0 * * * *'
timezone: America/Los_Angeles
enabled: false
max-runtime: 2h
permissions: acceptEdits
---

This is the schedulable **Pulse tick**: one tick of the `/flow` autonomous loop,
fired by an external scheduler (the DorkOS server's task-scheduler, OS-cron, or
CI). It is `enabled: false` by default. Turning on autonomy is the explicit
opt-in of wiring a scheduler and flipping this flag (ADR-0295,
bring-your-own-scheduler).

Each firing runs exactly **one `/flow continue` tick** and then stops; the
scheduler provides the repetition. This is NOT `/flow auto` (which loops a single
session via the Stop-hook sentinel). The canonical tick procedure lives in the
`/flow` orchestrator (`.claude/commands/flow.md`); this task is only the scheduled
trigger over it. In reconciler-registry order, one tick:

1. **Recovery.** Re-adopt any orphaned claimed work: read
   `.dork/flow/flow-state.json`, GC closed-issue records, probe the worker, and
   resume / restart-clean / escalate per the recovery script
   (`node .agents/flow/scripts/recovery.mjs`).
2. **Inbox / resume.** Un-park items whose `agent/needs-input` question was
   answered, and resume the parked run.
3. **Dispatch.** Rank the adapter's eligible work
   (`node .agents/flow/scripts/dispatch.mjs`, JSON in, JSON out), claim the
   top-ranked item (durable label plus state), provision its worktree, persist a
   `FlowRun` to `.dork/flow/flow-state.json`, and carry it to its human-review
   gate.

Stop at the review gate or on a genuine question. All tracker reads and writes go
through **the adapter**; this tick never names a tracker directly.

**Operator override.** At each stage boundary, via the adapter, check for the
`agent/paused` marker: if present, advance no further, release the claim
(`agent/claimed`) cleanly, and stop. `/flow:pause` sets this task's
`enabled: false` to halt the cron; `/flow:resume` restores it.

> The final discovery home for this tick (a skill that carries `cron` + `enabled`
> frontmatter, surfaced wherever skills live) lands with the tasks-as-skills
> capability model (DOR-150). The interim `.dork/tasks/flow-drain/` home keeps
> autonomy available now.
