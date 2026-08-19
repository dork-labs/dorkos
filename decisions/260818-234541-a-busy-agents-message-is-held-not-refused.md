---
id: 260818-234541
title: A busy agent's message is held, not refused, and the promise lives only where it can be kept
status: proposed
created: 2026-08-18
spec: room-hold-when-busy
superseded-by: null
amends: 260726-170125
---

# 260818-234541. A busy agent's message is held, not refused, and the promise lives only where it can be kept

## Status

Proposed. **Amends [260726-170125](260726-170125-a-room-is-a-membership-scoped-durable-stream.md)**
(A room is a membership-scoped durable stream, not a session), which stays `accepted`.

**Exactly one reading is retired:** that "**Rooms carry addressing and atomicity, never a concurrency
primitive**" forbids a room holding a message for an agent that is mid-turn in a _different_ room.
The clause's own words — no room-scoped write lock, no room turn policy, write coordination keyed on
the resource — all still stand, and so does its DOR-500 conclusion that the checkout is what a lock
must be keyed on. What is retired is only the inference the dispatcher drew from it at
`room-trigger.ts:103-107` ("Refusing there is still refusing rather than queueing"): that the second
ceiling must answer with a refusal.

**Everything else in the parent stands**, including the same-room hold RP8 already shipped under it.

## Context

A room's dispatcher checks two ceilings before it runs a turn. The `(room, agent)` claim key bounds
one transcript, and since RP8 a message that lands against it is **held** — it becomes the agent's
next turn when the claim releases. The agent's working directory bounds one checkout shared by every
room it belongs to, and a message that lands against _that_ was **refused**, with a durable line
ending "Send it again in a few minutes."

Three things are wrong with that outcome. The message is already a committed room entry, so refusing
only removes the room's obligation to answer it. The remedy is unfollowable: a room shows no "free"
state for another room's agent. And it is the same mistake the session path already corrected — ADR
`260811-184735` replaced `409 SESSION_LOCKED` because "the honest answer was 'it will run next'".

The reason it survived is that holding across the second ceiling looked like the scheduler this
domain has declined twice. It is not one, and the difference is worth stating precisely.

## Decision

**We will hold a message for an agent that is busy anywhere, and refuse it nowhere.** The message
joins the same per-`(room, agent)` collection RP8 built; when the claim that was in the way releases
— by answering, by going silent, by failing, or by being stopped — every held collection for that
agent is re-armed and the oldest runs first, one at a time, in the room that asked.
`BUSY_LINES['working-elsewhere']` is retired.

**We will bound it with the settings that already exist and add none.** A held collection holds
`rooms.collectMaxEntries` messages and drops only its _marks_ past that; a hold older than
`rooms.lateReplyCeilingMinutes` is dropped and written up as a durable notice. Ordering is FIFO by
hold start, promotable by the person, never preemptive.

**We will keep the hold in process memory, and confine the promise to the live lane.** A room trigger
is not a durable queue row — a persisted row would appear in that person's composer as a prompt they
never wrote, and could fire days later into a conversation that ended. So the room announces a hold
only on its ephemeral presence channel, as a new `held` state that says which room is in the way, and
writes **no durable line promising the future**. Durable lines state only what has already happened.

**This is not a concurrency primitive.** It takes no lock, starts no second turn, orders no two
agents against each other, and stores what the agent has not read rather than a plan for a scheduled
turn. The one-turn-per-`(room, agent)` and one-turn-per-checkout ceilings the parent ADR's DOR-500
evidence justifies are enforced exactly as before — the hold is what happens _because_ they hold, not
a way around them.

## Consequences

### Positive

- **A room never asks a person to type something twice.** The only sentence in the product that did
  is gone.
- **The honest answer is now the mechanical one.** "It will run next" is true because the release
  seam runs it, not because a prompt says so.
- **The failure modes are already closed.** Every claim terminal reaches one function, so a blocking
  turn that errors, goes quiet or is stopped still releases the hold — the class of bug every
  queue-capable tool in `research/20260610_message_queuing_agent_runtimes.md` ships (queued messages
  dropped on abort, premature dequeue) has no path here.
- **The promise cannot outlive the machinery that keeps it**, because it lives on a channel that dies
  with the process. A restart takes the lane rung and the hold together, and leaves the message
  exactly where it was: unread, above the agent's cursor, delivered by the next turn's ambient
  window.
- No new table, no migration, no setting, no runtime work — the ceiling is about a working directory,
  which no runtime owns.

### Negative

- **A restart silently forgets that a turn was owed.** The message survives; the promptness does not,
  and nothing tells the person. This is the same exposure the claim map has, now with a promise
  attached to it, and it is the strongest argument anyone will make for the durable version.
- **A held message can wait up to an hour** before the age bound closes it, because the bound is the
  blocking claim's own ceiling. On a busy install a chain of rooms can make that feel long, and the
  only remedy the person has is to open the other room and stop it.
- **The presence channel now carries a room id a reader may not be a member of.** Room ids are not
  capabilities here and the reader resolves the _name_ only from rooms they can already see, but this
  narrows a property `specs/room-presence` had stated absolutely ("the presence line never says busy
  elsewhere").
- **`RoomPresenceState` grows a member that the `CommunityAdapter` port cannot always produce.** It
  is additive and optional, but every future backend now has a state it may need to explain not
  having.
- **One more thing that can be wrong on the lane.** A `held` line that is stale by up to ten seconds
  — after a clear-on-post, or between republishes — says an agent will pick something up when it
  already has.
