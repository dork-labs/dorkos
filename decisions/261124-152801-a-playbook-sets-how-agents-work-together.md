---
id: 261124-152801
title: A playbook sets how agents work together; it is a setting of a space, held by DorkOS's own gate and turn port, never by one runtime's hooks
status: accepted
created: 2026-11-24
spec: null
superseded-by: null
amends: null
---

# 261124-152801. A playbook sets how agents work together; it is a setting of a space, held by DorkOS's own gate and turn port, never by one runtime's hooks

## Status

Accepted as a direction (operator, 2026-11-24: he wants to set how agents communicate and where work happens, to switch between ways "fairly seamlessly", and for something to enforce the choice; the name and the rules below are the architect's, on his request to "use the best term" and "adjust whatever you need"). Nothing here is built. The shapes are settled in a spec before any of it is. Evidence: `research/20261124_architecture-direction-review.md`, "How agents work together".

**Builds on:** [261124-150516](261124-150516-space-side-and-computer-side-one-contract-two-entries.md) (the space side decides, the computer side runs), [261124-150517](261124-150517-turns-survive-restarts-run-record-outbox-capped-recovery.md) (one turn port and the run record), [261124-150519](261124-150519-what-may-go-in-the-core-mini-apps-and-one-wake.md) (the core keeps the mechanism, a package carries the content), ADR 261017-211859 (every chat is a conversation) and ADR 260723-050219 (one registry of capabilities for every agent surface).

## Context

A team of agents needs an agreed way to work: answer the person fast and do the work in the agent's own chat with helpers; or do all work in rooms; or give each piece of work its own channel. DorkOS has pieces of this today, but not as one thing a person can pick. The lead-chat rule ("hand long work to one lead chat, keep rooms to three updates") is a sentence in code. Response modes, the engaged window, the cascade guard and turn budgets are enforced and can be set per room or per agent, but nothing groups them. And the places a rule could be held are uneven:

- Starting a helper chat is a tool only Claude Code agents get. Codex, OpenCode and Doe agents get the registry's capabilities and nothing else, though every runtime is told to use that tool.
- There are two gates: one for capabilities, and a second for hand-registered tools. Both can only allow, ask, refuse or hold. Neither can send an action somewhere else.
- A runtime's own helpers (Claude Code's built-in subagents) start without passing DorkOS's gate. DorkOS only watches them through the runtime's events.
- Hooks differ by runtime: Claude Code runs a package's hooks, Codex needs a person to trust each one, OpenCode and Doe have none, and none exist on another computer.
- Room turns and direct-chat turns share a dispatcher but not their busy rules, an agent's seat in a room never changes hands, and a channel cannot be tied to a worktree. So work cannot move between a chat, a room and a channel and keep its context.

## Decision

We will make the way agents work together a named setting, a **playbook**, and hold it in DorkOS itself.

- **A playbook has three parts.** Words: what each agent is told every turn. Rules: what DorkOS refuses or sends elsewhere ("long work does not go in this room; it goes in its own channel"). Defaults: what DorkOS does without being asked ("make a channel for each piece of work").
- **It is space data.** A space sets one. A room or a project may set its own. An agent may be given an exception. It travels with the space to every computer, like any other setting.
- **DorkOS holds it, at two places.** The gate that every DorkOS action passes through, and the turn port that decides where a turn starts and where its result goes. Never a runtime's own hooks: they differ by runtime and do not exist on another computer.
- **So every act of working together is a capability, on every runtime.** Posting, replying, starting a helper chat, handing off, reporting back, making a channel, making a workspace. The second gate folds into the first, so there is one.
- **The gate learns two things.** It can send an action somewhere else, and it records the reason in words the agent can read, so the agent adapts and does not retry. Rules are data the gate reads. A package never runs code inside the gate.
- **Work can move.** Because every chat is a conversation, a piece of work can be handed from a direct chat to a room thread or a channel and keep its context. A channel can be tied to a workspace.
- **A run keeps the playbook it started under.** The run record names it, so changing the playbook never strands work that is under way: old runs finish under the old rules.
- **What DorkOS cannot hold, it says.** What an agent does inside its own runtime (its built-in helpers) is steered by the playbook's words and by that runtime's own settings, and shown from what DorkOS observes. It is not enforced, and the app does not claim it is.
- **A playbook ships as a package.** The first three are DorkOS's own: quick answers with helpers, everything in rooms, and a channel for each piece of work.

## Consequences

### Positive

- One switch a founder can understand, in place of five settings and a sentence in code.
- The same rules hold for every runtime and on every computer.
- The work that makes it possible is work already decided: one turn port, the run record, every tool a capability, every chat a conversation.
- People can share a way of working as a package, the way they share a mini app.

### Negative

- The gate grows: sending an action elsewhere is a new outcome that every surface must show honestly.
- Rules as data limit what a playbook can express. Anything cleverer has to wait or become a new built-in rule kind.
- Three levels (space, room or project, agent) need a clear answer to "which rule won, and why", shown to people and agents.
- Part of every playbook is only advice, because a runtime's own helpers are out of DorkOS's reach. That gap has to be stated wherever a playbook is chosen.
- Moving work between conversations changes the one-seat-per-room rule, which other rules depend on.

## Alternatives considered

- **Instructions only.** Rejected: the operator asked for enforcement, and prose alone is what DorkOS has today.
- **Enforce with each runtime's hooks.** Rejected: four runtimes, four hook systems, two of them with none, and no hooks on another computer.
- **Let a package run code inside the gate.** Rejected: the gate is the trust boundary, and third-party code there would decide what every agent may do.
- **A fixed set of modes in the core, no packages.** Rejected: ways of working are content, and the core test (ADR 261124-150519) says content belongs in a package. The mechanism stays in the core.
