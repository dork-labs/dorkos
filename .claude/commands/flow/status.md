---
description: Show every in-flight item, parked question, and assumption trail across the /flow loop
category: flow
allowed-tools: Read, Glob, Skill, AskUserQuestion
argument-hint: '[issue-id to focus on, or empty for the whole loop]'
---

# /flow:status — observe the loop

Render one status pane for the `/flow` loop: $ARGUMENTS

This is an OBSERVE command: it reads, never advances. It joins three sources into
a single pane:

1. **`.dork/flow/flow-state.json`**: the durable per-issue run records (the typed
   `@dorkos/flow` `readFlowState` shape). The session↔issue association, worktree,
   branch, stage, and status of every run.
2. **`.dork/flow/auto-run.json`**: the `/flow auto` drain sentinel, if a drain is
   live (`active`, `ready`, `shapeable`, `startedAt`, `pid`).
3. **The tracker, via the `linear-adapter`**: titles, labels, parked questions, and
   assumption comments. Read `.agents/flow/skills/linear-adapter/SKILL.md` and use
   its verbs; never touch a tracker string directly from this command.

Render, in this order:

- **In flight.** Every claimed / in-flight item: each FlowRun in `flow-state.json`
  plus every `agent/claimed` item on the tracker. For each, show `DOR-123 - Title`
  (resolve the title via the `linear-adapter`, per its display convention), then its
  worktree path, branch, `sessionId`, and current `stage` / `status` from the
  FlowRun. If a drain is live, head the pane with the `auto-run.json` sentinel
  (`active`, `ready` ready vs `shapeable` behind the readiness gate).
- **Parked.** Every `agent/needs-input` item: via the `linear-adapter`, list the
  parked items, and for each show the open question text and how long it has waited
  (now minus the parking comment's timestamp).
- **Why.** The per-item assumption trail: via the `linear-adapter`, read each item's
  `agent/assumption` comments (or the assumption-log artifact), so the review gate
  stays auditable.

With an issue identifier as `$ARGUMENTS`, scope the pane to that one item (its
FlowRun, its parked question, its assumption trail). With no argument, show the
whole loop. When nothing is in flight and no drain is live, say so plainly rather
than rendering an empty pane.
