---
id: 260824-120019
title: The room read carries live presence, reversing "the republish loop covers it"
status: accepted
created: 2026-08-24
spec: specs/room-presence/02-specification.md
superseded-by: null
amends: null
---

# 260824-120019. The room read carries live presence, reversing "the republish loop covers it"

## Status

Accepted. Shipped in DOR-786. Reverses one resolved open question in `specs/room-presence/02-specification.md` §18; the rest of that spec stands unchanged.

## Context

The room-presence spec asked whether a cold read of a room should carry the claims in flight, so that opening a room mid-turn draws its working line at once. It answered no:

> _"keep the snapshot durable-only. **Rationale:** the snapshot/replay contract partitions on durability; putting ephemeral state in the snapshot makes every future reader reason about a mixed contract to shave ≤10 s off a line that is absent most of the time. Revisit only if dogfooding shows the gap is felt."_

The gap is felt, in two places the spec did not have in front of it.

**The room sheet cannot tell quiet from deaf.** Presence rides each room's own SSE stream, and only the room ON SCREEN has one open. The details sheet opens from four places, including a sidebar row over some other room — and there it hears nothing, draws nothing, and is indistinguishable from a room where genuinely nobody is working. That is not a ten-second delay. It is a permanent, silent wrong answer, and neither the sheet nor the person reading it had any way to detect it.

**The workaround already shipped, one field over.** `RoomSummary.working` — a bare count on the room LIST — exists for exactly this reason, and `useOpenRoomWorking` reaches sideways into the sidebar's cached list to decorate the open room's masthead, because "the open room is read as a `RoomWithRoster`, which carries no count". A surface reading another surface's cache to answer a question about the room it is actually looking at is the shape of a missing field.

Two things the spec worried about turn out not to bind here:

- **The snapshot/replay contract is not what is being mixed.** The concern was about the entry STREAM — `Last-Event-ID`, gap-free replay, a reader that must know what will and will not be redelivered. A field on the room BODY replays nothing and resumes nothing. It is a value read at request time, exactly like `reactionFrequents` and `viewerHasPosted`, which are already on that body for the same reason: the read is already scoped to this caller and the value is already in hand.
- **The claim map is already this readable.** `room_context.working` hands the same `{authorId, since}` rows to every agent taking a turn in the room. Giving them to the person in the room is not a new disclosure; withholding them from the person while handing them to the agents was the odd half.

## Decision

**`RoomWithRoster` carries `workingAgents: {authorId, since}[]`** — a live read of the dispatcher's claim map, taken at request time, on every surface that builds a room body: `GET /api/rooms/:id`, the create/update responses, and the room stream's hydration snapshot. It is Zod-optional so an older caller still parses, and the server always sends it.

Three narrowing choices, each of which is the decision:

- **A LIST, not a count, and named apart from the count.** The sidebar draws a dot, so `RoomSummary.working` is a number; the sheet draws rows against a roster, so this is rows. They are different types answering the same question, and `RoomWithRoster` is routinely built by spreading a `RoomSummary` — so one name for both would be a silent mismatch instead of a caught one. Hence `workingAgents`.
- **`{authorId, since}` and nothing more.** Not the cascade, not the dispatch id, not the entry the turn answers, and above all not the session. Those stay inside `RoomTriggerDispatcher`, exactly as `workingCount`'s own note says. `specs/room-presence` §15 deferred the session mapping until there was an authorization design for it, and `GET /api/rooms/:id/sessions` is that design — ids only, people only. This field does not reopen it.
- **Empty is an answer; absent is not.** `[]` means nobody is working. A missing field means this source cannot say — an older server, or a client that has not read the room yet. The client hook that reads it exposes that distinction directly (`workingKnown`) rather than collapsing both into an empty list, which is the bug being fixed rather than a detail of the fix.

## Consequences

### Positive

- A room opened mid-turn draws its working rows on the first paint, from any of the four places the sheet opens, including the ones with no stream at all.
- The sheet can say "nobody is working here" and mean it. Before, it could only fail to say anything.
- `useOpenRoomWorking`'s sideways read of the sidebar's list cache now has a first-party answer available beside it. It is left in place in this change — the masthead's chip wants a count and the list is still the source that keeps it live — but it is no longer the only way to learn presence about an open room.

### Negative

- **The field can be stale, and only the client can bound that.** It is true when the response is built and never updated; the stream is what keeps it current, and a client with no stream has a snapshot that ages. Every reader must apply the same `PRESENCE_TTL_MS` bound the rest of the presence machinery uses, measured from when the read landed. The sheet's hook does; a future reader that forgets will draw a turn that ended.
- **A second source for one fact.** The stream and the room body can disagree for a moment. The precedence rule is the one the sidebar's dot already uses and it is not negotiable: the stream wins whenever it has spoken, because it is the only thing that can say an agent has STOPPED.
- One more field on the hottest room read. It costs no query — the claim map is in memory — but it is one more thing every room body carries.

## Addendum — the same promise forces a notice the room used to withhold

Recorded here rather than as its own ADR because it has the same cause: the 202
now names the agents the room asked to reply, and a promise has to be
withdrawable.

`RoomTriggerDispatcher.abandonHolds` drops the messages waiting on an agent that
has just left a room, and its docstring argued — deliberately, at length — for
writing no notice: the act that reaches it is operator-only and already visible
on the roster, so the room was not going quiet for no reason, and a _busy_ line
would have been false besides.

Two of those three arguments no longer hold. The false-because-busy one is
answered by giving the event its own code, `agent_left`, which says the member
left rather than that it was occupied. But "already visible" means visible to
whoever is looking at the roster at that moment, and the ephemeral `done` on the
held indicator reaches only whoever has the room open right then — while the
person who SENT the message may be neither, and was told in so many words that a
turn was owed. So the room now writes one line, once, naming the member.

Archiving still writes nothing and structurally cannot: `postNotice` refuses an
archived room, because archiving promises the room stops gaining entries.

## Related

`specs/room-presence/02-specification.md` §15, §18; ADR 260726-170125 (the room is a membership-scoped durable stream); ADR-0310 (runtime-owned sessions — why the claim, not a session store, is the presence source).
