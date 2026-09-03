---
id: 260819-023317
title: Stopping one agent is the room halt scoped, not a new verb, and scoping it is not arbitration
status: accepted
created: 2026-08-19
spec: room-per-agent-stop
extractedFrom: room-per-agent-stop
superseded-by: null
amends: null
---

# 260819-023317. Stopping one agent is the room halt scoped, not a new verb, and scoping it is not arbitration

## Status

Accepted (extracted from spec: `room-per-agent-stop`, DOR-1352).

It reads against ADR `260726-170125`, which is unchanged: that ADR refuses a room-scoped turn
lock, a speaker election and a scheduler. Nothing here elects a speaker or orders two agents
against each other, and this ADR exists mainly so the next reader does not mistake it for
something that does.

## Context

A DorkOS room can have several agents working at once. Until now the only way to stop any of them
was `POST /api/rooms/:id/halt`, which stops all of them, writes one room-wide notice, and drops
every gather buffer in the room. The live peek drew a per-row **Stop** only when exactly one agent
was working, because with two or more a row button would have stopped the other rows too
(`specs/unified-conversation` §5.3.4).

Two forces made a scoped stop look risky rather than obvious. First, this domain has twice refused
anything that arbitrates between agents (ADR `260726-170125`), and "a control that stops one agent
and leaves the others" reads at first glance like arbitration. Second, the room-wide halt's
correctness lives in three orderings that are easy to lose in a re-implementation: the stopped
dispatch is marked before the first `await` (the two-second interrupt race measured on
2026-08-15, DOR-1232), the durable notice is written before the claim is released, and the gather
buffer is dropped before the claim is released. A stop built as a fresh path, or as a direct call
to the session interrupt endpoint, would silently re-open all three.

## Decision

A per-agent stop is the room-wide halt with its scope narrowed to one `(room, agent)` key, not a
new verb. `RoomTriggerDispatcher.haltAgent` performs the same five steps under the same
constraints as `halt` — mark the dispatch, drop that agent's collection, write the notice,
interrupt, release the claim through `releaseClaim` — and touches no other key. The constraints,
not the statement order, are what carries over: all three are about what must be true **before the
claim is released**, and the two bodies order the middle pair differently on purpose, because a
per-agent stop has to know what it dropped before it can say what it found while the room-wide one
speaks for everybody and can say it first. It is reached by a sibling route,
`POST /api/rooms/:id/halt/:authorId`, rather than by an optional target field on the existing
route, because an optional target fails open: a client that omits it stops the whole room. It
reuses the `halted` notice code and distinguishes the two scopes by `subjectAuthorId` (absent =
the room, present = one agent), because widening `RoomNoticeCodeSchema` is not additive for a
pinned client.

Scoping the verb is **not** arbitration, and the line is: this control belongs to the operator,
never to a room participant. `requirePersonAuthor` gates it exactly as it gates the room-wide
halt, so an agent can no more stop one room-mate than it can stop all of them. What ADR
`260726-170125` refuses is the system choosing which agent speaks; what this adds is a person
choosing which agent to stop watching, which is the same authority they already had at room
granularity.

The rule generalizes: **the scope of a control action is a parameter of that action, expressed as
a path segment, and every ordering constraint the unscoped version documents applies unchanged to
the scoped one.** Any future scoped control here (a per-agent pause, a per-thread stop) is built
the same way, or it is not built.

## Consequences

### Positive

- A person can stop the agent that went wrong and keep the two that are working. The peek's Stop
  goes on every row, so a person never has to know which internal state a row is in to know what
  its button does.
- The interrupt race stays closed by construction: there is one halt path in the dispatcher, and
  both entry points into it mark before they yield.
- No new notice code, so no client pinned to the old enum breaks, and `NoticeRow` needs no change.
- The "fails open" failure mode is unreachable. A path segment cannot be silently dropped the way
  a body field can.
- It supersedes one line of `specs/room-hold-when-busy` §5.3 for a stated reason rather than by
  drift: a held row gets a Stop now, because the objection to it was that the row's Stop was
  secretly room-wide.

### Negative

- Two halt bodies in `room-trigger.ts` that share their ordering by convention and by adjacency
  rather than by a shared function. That is deliberate — one body with three branches read worse
  than two of ten lines — but it means an ordering fix has to be made twice, and the tests for
  each must independently pin the order of effects.
- Two damping keys for one notice code (`roomId` and `(roomId, authorId)`), so `workStarted` has
  to clear both. A future third scope would need a third.
- The `halted` code now means two different-sized facts, distinguished only by an optional field.
  Any consumer that treats `notice === 'halted'` as "the whole room stopped" is now wrong; the
  bridge delivery path was audited and is not one of them.
- The temptation to give an agent this button grows, because a scoped stop looks less drastic than
  a room-wide one. The gate is unchanged and is asserted in the route test table rather than
  assumed.

### Inherited, and chosen rather than overlooked

Two shapes come with reusing the `halted` notice at a smaller scope. Both were traced before this
was accepted; neither is a bug to be fixed later, and each is written down so the next reader does
not "discover" it.

- **The stopped agent does not read its own stop line.** The ambient window an agent is shown
  excludes entries whose `subjectAuthorId` is that agent (`room-store.ts`, `excludeAuthorId`), so
  every notice about a member is written for everybody EXCEPT that member — the same rule that
  keeps an agent from reading "Ana is busy" about itself and answering it. A stop reaches the
  runtime, never the model (ADR `260726-170127`), so the agent has nothing to learn from the line
  anyway: what stopped it was a transport signal, and the next thing it sees is the next message.
- **A second stop before any new claim is silent.** Damping re-arms on `workStarted`, which only
  fires when a claim is taken. Pressing Stop twice on an idle agent is one line, exactly as it is
  for the room-wide halt, and for the same reason: what makes a second line a repeat is that
  nothing happened in between. The person still gets an answer to the second press — the HTTP
  `{ stopped: 0 }` — and the room does not say the same sentence twice.
