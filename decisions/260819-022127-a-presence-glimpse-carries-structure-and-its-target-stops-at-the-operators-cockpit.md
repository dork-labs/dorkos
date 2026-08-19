---
id: 260819-022127
title: A presence glimpse carries structure, not prose, and its target stops at the operator's cockpit
status: proposed
created: 2026-08-18
spec: presence-verb-glimpse
extractedFrom: presence-verb-glimpse
superseded-by: null
amends: null
---

# 260819-022127. A presence glimpse carries structure, not prose, and its target stops at the operator's cockpit

## Status

Proposed (extracted from spec: `presence-verb-glimpse`, DOR-1351).

It extends `specs/room-presence` §3.2's wire shape and reads against
`notice-copy.ts`'s durable waiting notice, which refuses to put a tool name or a
file path into a shared room. Nothing here weakens that refusal; this ADR says
where the same rule binds for an ephemeral signal, and where it does not.

## Context

A room's working indicator says that an agent is working and how long it has
been. The session pane, for the same turn, has said what it is doing since
BC-37, because the projector derives a structured `SessionActivity`
(`{ toolName, target? }`) from every tool call and the client phrases it through
one table. Carrying that reading into a room raises two questions that would
otherwise be answered twice, differently, by whoever touched the code next.

The first is who owns the words. `SessionActivitySchema` was deliberately built
to carry no prose, so a reading minted by an older server cannot put stale copy
on a newer screen, and `one-verb-source.test.ts` exists because two surfaces
describing one turn two ways has already shipped as a bug here.

The second is who is allowed to read the argument. A room's presence signal
reaches the operator's own cockpit today, but the same publish is also handed to
a chat-bridge forwarder seam and projected across the `CommunityAdapter` port —
both of which are, by construction, audiences that are not this operator. The
product has already answered this once for the durable case: the room's waiting
notice deliberately omits the tool name and the question, because "repeating them
into a shared room would put one member's approval decision, file paths and
commands included, in front of everybody else."

## Decision

We will carry the existing `SessionActivitySchema` on the room presence signal as
one optional field, and phrase it in the client with the table that already
phrases the session lane. No server component mints a verb, and no second verb
table is written.

We will treat the reading's two halves as having different audiences. The
**verb** (`toolName`) may travel wherever presence travels. The **target** — a
basename, a command's first line, a search pattern, a host — is stripped at every
producer-side projection that leaves this cockpit: the chat-bridge presence
forwarder and the `CommunityAdapter` port. The port's payload schema gains no
field for one, so a future adapter cannot carry it by accident.

We will keep the glimpse out of the ear and out of the crossfade. The live
region and the lane's motion key stay bound to the verb-free sentence, so a turn
that starts a tool every two seconds changes the drawn text and nothing else.

## Consequences

### Positive

- One reading, one derivation, one table. A room and a session cannot describe
  the same tool call two ways, and a client that does not recognise a tool
  degrades down the same five-rung ladder on both surfaces.
- The privacy rule is enforced where it can be guaranteed — at the producer, in
  two functions, with two tests — rather than by asking each consumer to behave.
- The port stays honest about its floor. A community backend cannot claim a verb
  the claim map did not produce, which keeps presence mechanically true across
  the seam the way it already is inside it.
- Adding a consumer of an existing derivation adds no new disclosure surface: the
  target the room shows is the same string, with the same 40-character cap, that
  the operator's own session pane already shows them.

### Negative

- The client carries a second grammatical framing, so the tool table had to be
  refactored from finished sentences into clauses. Every shipped session label is
  pinned byte-for-byte to bound that, with one deliberate exception (an em dash
  removed from the `Task` phrase), but the refactor is real work for a feature
  that could have been done with a duplicated table.
- The one-verb source guard had to grow a second guarded name. A guard that
  guards two things is one more thing to keep true than a guard that guards one.
- A bridged chat or a community sees a verb with no object — "running a command"
  rather than "running pnpm test". That is less useful than the cockpit's line,
  and it is the price of the boundary rather than a gap to close later.
- The rule is asymmetric and therefore needs stating in three places
  (`room-conduct.md`, the community-adapter guide, this ADR). An asymmetry
  nobody writes down is an asymmetry somebody tidies away.
