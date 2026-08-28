---
id: 260823-000218
title: Room turn limits ship loose, and a person may turn them off entirely
status: accepted
created: 2026-08-23
spec: null
superseded-by: null
amends: null
---

# 260823-000218. Room turn limits ship loose, and a person may turn them off entirely

## Status

Accepted. Verified in code: `packages/shared/src/config-schema.ts` sets `maxAgentDepth: 30`, `maxTurnsPerAgentPerCascade: 10`, `maxAutomaticTurnsPerRoomPerHour: 1000`, `maxAutomaticTurnsTotalPerHour: 5000`, and `turnLimitsEnabled: true` by default — matching this decision's table exactly.

## Context

ADR 260727-181825 says a permissive default is legal and must be argued in writing. This is that argument, for four fields at once.

The room bounds shipped conservative: three replies deep, sixty automatic turns per room per hour, two hundred and forty across the install. Those numbers were picked before anybody had run agents in a room all day. In use they stop ordinary work — a room where two agents are working something through hits the reply ceiling in the first minute and the hourly cap in an afternoon — and a limit that fires during ordinary work does not teach restraint. It teaches people to turn limits off, which is the state where nothing is bounded and nobody has thought about it.

| Setting                                 | Was | Now  | Max was | Max now |
| --------------------------------------- | --- | ---- | ------- | ------- |
| `rooms.maxAgentDepth`                   | 3   | 30   | 10      | 100     |
| `rooms.maxTurnsPerAgentPerCascade`      | —   | 10   | —       | 100     |
| `rooms.maxAutomaticTurnsPerRoomPerHour` | 60  | 1000 | 10 000  | 10 000  |
| `rooms.maxAutomaticTurnsTotalPerHour`   | 240 | 5000 | 100 000 | 100 000 |

## Decision

**The four numbers above ship at the new values, for new installs and existing ones alike**, and a new switch `rooms.turnLimitsEnabled` (default true) lets a person turn every automatic-reply limit off.

Two things follow that this ADR exists to own rather than to soften.

**A fresh install can now spend about five thousand automatic model turns in an hour.** That is the worst case, and it is real money. It happens when agents talk in circles with nobody watching — the exact accident the caps were built for — and the caps are now set where they stop a runaway rather than where they stop work. Five thousand is a backstop, not an allowance to be spent; nothing about ordinary use approaches it. The per-room cap keeps one room from eating the whole figure, the room says which cap stopped it when either fires, and both numbers are editable. The old defaults were not safer in practice, because they were reached during work and the reflex they produced was to raise them anyway — without the notice copy, the ADR, or a second thought.

**Unlimited mode has no automatic brake at all.** With `turnLimitsEnabled` off, two `always` agents in a room run until a person presses Stop. Not the cascade guard, not the hourly caps, not a timeout: the halt button and per-agent Stop are the only brakes, and this ADR accepts that state explicitly rather than implying something else is watching. It is bounded by disclosure and by access instead: the switch is operator-only, it ships ON, it states the consequence in the sentence beside it, and a config wipe lands back on ON because that is the protective side. It is modelled as its own flag rather than a sentinel `0` on each number so that the numbers keep their meanings and turning limits off and on again restores exactly what was set.

The migration moves a stored value **only when it still equals the old default**. A number somebody typed is a decision and travels untouched.

## Consequences

### Positive

- Rooms hold real conversations without the product interrupting to say a limit was reached.
- The caps become what they were always described as — the ceiling on what this can cost you — rather than a limit met during normal work.
- A person who wants to watch two agents work unattended has a supported way to do it, with the cost stated, instead of setting every number to its maximum and getting the same thing less legibly.

### Negative

- **Bill exposure is the design.** A misconfigured install can spend ~5000 automatic turns in an hour where it used to spend 240. On a metered account that is a bad afternoon, and the only thing standing between a person and it is a cap they can also raise.
- **Unlimited mode can run all night.** Nothing automatic ends it. The disclosure is the mitigation, and disclosure is weaker than a mechanism — this is the one place in the room path where that trade is accepted.
- The migration cannot tell "left at 3 on purpose" from "never touched it". Both read as the stock value and both get 30. Settings is the remedy, and it does not exist yet — until it does, the only way back to a tighter number is `dorkos config set`.
- Existing installs change behaviour on upgrade without being asked. That is the point of the reversal, and it is why the changelog says so in plain words rather than listing four field names.
