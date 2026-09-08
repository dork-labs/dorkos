---
id: 260908-170643
title: A room turn is an unattended surface and follows the operator's power level
status: accepted
created: 2026-09-08
spec: null
superseded-by: null
amends: 260822-235802
---

# 260908-170643. A room turn is an unattended surface and follows the operator's power level

## Status

Accepted. Amends ADR `260822-235802` (unattended surfaces follow the operator's
power level) by adding the surface that decision's enumeration left out.

## Context

ADR `260822-235802` moved scheduled tasks and relay bindings onto the operator's
configured trust stop, and the `full-power-defaults` programme summarized itself
as "unattended surfaces at the operator's power level". Rooms were not in that
enumeration and were never wired, so exactly two things carried the setting into
a new session: the `interactive: true` flag on `persistSessionRuntime` (the chat
send path) and `resolveUnattendedDefaultStop()` asked for by name (the task
path). A room turn passed neither, deliberately, citing spec `trust-dial`
decision 6 — "the configured default is for sessions a person is watching".

That reading was correct when it was written and is now backwards for rooms. The
asymmetry that decides it: a scheduled task and a relay binding each carry a
permission mode of their own, set on a form, with a per-instance confirm at
creation. **A room carries none.** There is no per-room control, no room-level
grant, and nowhere for a person to express a level. So on the room path the
global setting was not being outranked by a more specific answer; it was reaching
nothing at all. An operator who granted Full autonomy got a room agent that
stopped to ask, in the one place nobody is there to answer, and the turn simply
waited (DOR-1917, operator report 2026-09-08).

## Decision

A room turn resolves the operator's configured trust stop through the runtime it
actually landed on, exactly as a scheduled run does, and seeds it onto the
session it creates. The stop-to-mode mapping is shared rather than copied:
`resolveUnattendedPermissionMode()` in the session-defaults ladder is the one
place that turns a stored stop into a runtime's own mode id, and both unattended
callers go through it.

The seed reaches the turn in two places, because a room binds its session row
after the turn starts and the first turn would otherwise miss it: the per-turn
settings the runner already passes for model and effort, and an explicit
`permissionMode` seed on `persistSessionRuntime` so every later turn inherits it
the ordinary way. The registry seeds a column still holding NULL and never
overwrites a mode already on the row.

`interactive` keeps its meaning and rooms keep not claiming it: nobody is
watching a room turn. What changed is that "nobody is watching" stopped implying
"take the runtime's default" and started implying what it implies everywhere else
in this programme — take the operator's level.

**A stranger's message is clamped.** A bridged Telegram or Slack chat is a
projection of a relay binding into a local room, so an off-machine sender's
message reaches this same room-trigger path. Seeding the operator's level from
one would make the bridged path strictly looser than the binding beside it, for
the very same sender, and would walk straight through the reason a binding
carries its own grant at all (DOR-604). So the seed is applied only when the
triggering entry was written on this machine, decided from the author's stored
natural key through `authorOrigin()` — the one derivation there is — and an
author the registry cannot find reads as external. Model and effort are NOT
clamped: which model an agent is does not depend on who is speaking to it
(DOR-1344).

**An agent's mention is not clamped, and that is a choice.** An agent posting in
a room can trigger another agent's turn, and that turn now starts at the
operator's level. These are the operator's own agents coordinating on their
machine, which is the product's whole thesis; the bound on it is the cascade
guard and the reply limits, not a lower power level.

Two boundaries are deliberately unmoved. Relay bindings and agent-to-agent DMs
that do NOT route through a room still resolve from the binding that carried the
message, where an absent grant is not consent (DOR-604): those surfaces have a
control, and a global default must not overwrite a per-binding answer. And an
unset config still resolves to nothing, so an install whose operator never
answered the power door behaves byte for byte as before.

## Consequences

- A room agent runs at the level its operator chose, from its first reply.
- One place maps a stop onto a runtime's mode id, so a room default and the trust
  dial cannot come to disagree about what a position means.
- Rooms join tasks and bindings under one rule, which is the rule the programme
  always stated; the enumeration in `260822-235802` was the incomplete part, not
  the principle.
- A room conversation that already has settings is untouched: resolution happens
  when the session is created, never retroactively.
- The room path can now reach any mode a runtime declares at the configured stop.
  A comment in `room-turn-runner.ts` that relied on a room turn being unable to
  reach `auto` now rests on the narrower fact that claude-code declares
  `acceptEdits` before `auto` at the same stop.
- **A known gap, recorded rather than hidden:** the standing unattended-autonomy
  banner enumerates `'binding' | 'task'` drivers
  (`UnattendedDriverKind`) and does not know about rooms, so a room running at
  full power is disclosed only by the global Control Center posture. By this
  ADR's own argument — a room is the surface with no per-instance control — that
  is the surface disclosure matters most for. Adding a room driver kind is
  tracked as DOR-1919; it needs a definition of what a "standing" room driver is
  first, since a room turn is transient where a binding and a schedule are not.
