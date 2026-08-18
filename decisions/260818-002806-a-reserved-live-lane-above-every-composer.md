---
id: 260818-002806
title: A reserved live lane above every composer replaces the status strip and the under-composer presence line
status: accepted
created: 2026-08-18
spec: unified-conversation
superseded-by: null
amends: 152
---

# 260818-002806. A reserved live lane above every composer replaces the status strip and the under-composer presence line

## Status

Accepted. Shipped in P2 (`#1092`) and confirmed against the tree at P5
(DOR-1332): `Conversation.LiveLane` (`features/conversation/ui/LiveLane.tsx`)
is the reserved `h-6` line, mounted on every surface, documented under
`contributing/design-system.md` → Components → Live lane.

**One number in this record no longer matches the shipped stack.** The
Decision section below still says "ten states" and lists a queue note as the
lowest rung; P4's review (session 7, `04-implementation.md`) deleted the
`queued` rung outright rather than reordering it — a queue only ever exists
because a turn is already in flight, so it could never win against
`turn-streaming` and would have hidden what the agent is doing to report a
number. The shipped stack is **nine** rungs, ending at `turn-complete` then
`empty`. Left uncorrected in the prose below because an ADR is a record of
the decision as reasoned at the time, not a living spec; the accurate count
lives in `contributing/design-system.md` and `lane-state.ts`'s own TSDoc.

Amends ADR-152, which stays **accepted**. What survives is its whole decision: a `deriveStripState()`-shaped pure function mapping raw props to a discriminated union, rendered through one morphing container with `AnimatePresence mode="wait"` keyed on the variant. What is retired is its scope — "the chat UI's status strip", six states, in the session chat only, implemented as `features/chat/ui/status/strip-state.ts` (the file its `affects` glob names). Those move to `features/conversation/model/lane-state.ts`, shared by every surface, with nine states.

## Context

The session chat says what is happening in `ChatStatusStrip`, above its composer. A room says it in `RoomPresenceLine`, **below** its composer — placed there deliberately, because `specs/room-presence` §5.1 argued that putting it above would push the last message every time an agent picked something up. Neither is clickable, neither can show the other's states, and a person moving between the two surfaces reads two vocabularies for one idea. Meanwhile the room's most important state, "an agent is waiting on you", is not in either line at all: it is a durable, deliberately vague notice a minute late, telling the person to go and find a session. Three things therefore compete for the space above the composer with no rule about which wins.

## Decision

We will reserve a fixed-height 24px line above every conversation's composer, always mounted, empty when there is nothing to say, and put everything in it — in one priority order, in one morphing container. The order is Ask, then stalled stream, then presence, then the session's own turn status (waiting, operation progress, system message, streaming, complete), then a queue note, then empty. `ChatStatusStrip`, `strip-state.ts`, `RoomPresenceLine` and `RoomStalledNotice` are deleted; `ChatStatusSection`, which is the composer's model and mode line rather than a busy indicator, is untouched and becomes `Conversation.Footer` content. Clicking presence content opens a peek listing each working agent with what it is replying to, a link to its session, and an honest Stop; clicking an Ask grows the same lane into the answer card.

## Consequences

### Positive

- Zero layout shift becomes a structural property rather than a promise: the height is a constant, so the browser test is "the timeline's scroll offset did not change", and no stylesheet edit can quietly make it false. This answers `room-presence` §5.1's objection instead of arguing with it.
- One vocabulary. A person reads the same line, in the same place, in a session, a channel and a DM.
- The space above the composer gets a rule. The most important true thing wins, and "an agent needs you" outranks "an agent is busy" by construction.
- The line becomes an affordance: it is the one place to look whether the system is busy or blocked, and both states lead somewhere.
- Two of the priority rungs encode hard-won honesty rules that were previously implicit — a stalled stream hides presence, because a client that cannot read the stream must not claim to know who is working; and an Ask outranks a stalled stream, because its countdown never came off the wire.

### Negative

- Every quiet room and every idle session now carries a blank 24px line. The cost is real, was weighed, and was accepted over a floating pill that would hover exactly where the newest message lands.
- `deriveLaneState` has ten variants where `deriveStripState` had six, and the two extra sources (presence and the Ask queue) come from different stores. A wrong rung is a state that silently never renders, so the priority table needs a test per rung rather than a test of the function.
- The lane is a second live region in the app after the sidebar's, so it has to stay disciplined: it announces the sentence and never the elapsed tick, and Asks are announced by the transcript's existing approval announcer rather than by the lane, or a fleet of agents turns a screen reader into a siren.
- The peek's Stop cannot be per-agent without a per-author room halt, which needs its own notice copy and a scoped buffer drop. Until then the peek offers a single-agent Stop or a room-wide one, and says which.
