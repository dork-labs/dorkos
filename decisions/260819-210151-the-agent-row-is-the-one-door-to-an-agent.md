---
id: 260819-210151
title: The agent row is the one door to an agent; one agent opens a session, two or more open a group message
status: accepted
created: 2026-08-19
spec: sidebar-simplification
superseded-by: null
amends: null
---

# 260819-210151. The agent row is the one door to an agent; one agent opens a session, two or more open a group message

## Status

Accepted 2026-08-22 — implemented by PR #1159 (task 2.1, DOR-1370).

## Context

The same agent was reachable two ways — its row under Agents (opens a session) and a hand-made 1:1 DM room under Direct messages (opens a room) — with two different results, even though a 1:1 DM's backing session already runs with the agent's own working directory and runtime and the DM view renders only the agent's final text: no tool cards, no thinking, no slash commands, no permission mode, no model picker. `specs/rooms` §8.5 named this exact duplication and predicted the two would converge. The alternative, making the DM the door and the session "open the engine" (2B), needs rooms to render full engine output, which they do not yet — the room log deliberately excludes token deltas (ADR `260726-170125`) and room slash commands are designed but unbuilt.

## Decision

We will make the agent row the one door to an agent: picking one agent opens or resumes its session; picking two or more agents opens a group message. Hand-made 1:1 DM rooms stop being created by any entry point (the picker, `+ New`, Team page, profile); agent-initiated and bridged 1:1 DMs still arise and surface as a dot in Today and on the agent row rather than as a standing Direct messages row. No server migration touches existing DM rooms — the Library simply stops listing hand-made 1:1 DMs (`kind === 'dm'`, roster of exactly one agent, not bridged); they remain reachable via ⌘K and the agent's profile.

## Consequences

### Positive

- One rule holds everywhere an agent is reached from — the sidebar, the Team page, the profile, the command palette, `+ New` — instead of two doors with two behaviors.
- Zero data-migration risk: existing rooms are untouched, only unlisted, so there is nothing to roll back if the rule is wrong.
- Removes verbs that lied ("Chat with X" / "Message" both already opened a session; they now say so).

### Negative

- A 1:1 conversation loses the DM affordances — unread, reactions, threads, agent-initiated push — until session-level equivalents exist; those land later, one capability flag at a time.
- "DM is the door" (2B), the Slack-shaped north star, is deliberately deferred rather than chosen, so this decision will be revisited once rooms can render full engine output.
- Suppressing hand-made 1:1 DMs by a model rule rather than a migration leaves old empty DM rooms as inert, unlisted rows in the database indefinitely.
