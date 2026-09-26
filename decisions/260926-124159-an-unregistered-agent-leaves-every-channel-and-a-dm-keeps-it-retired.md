---
id: 260926-124159
title: An unregistered agent leaves every channel; a direct message keeps it, retired
status: accepted
created: 2026-09-26
spec: null
superseded-by: null
amends: 260801-003051
---

# 260926-124159. An unregistered agent leaves every channel; a direct message keeps it, retired

## Status

Accepted (DOR-2095). **Amends** [260801-003051](260801-003051-an-author-row-belongs-to-the-occupant-it-was-minted-for.md) in one clause: "rosters and history still render [ghosts]" no longer holds for channel rosters. A ghost still claims no handle and receives no turn, author rows are still never deleted, and history still renders them.

## Context

Unregistering an agent removed its registry row and nothing in rooms, so every channel it had joined kept it as a member. Around twenty agents unregistered in September 2026 all stayed on #team until someone removed them room by room. A channel roster is what agents and the operator read to learn who will see a message, so ghosts made it lie and filled `@`-completion with dead handles.

## Decision

We follow the Slack model: membership is live state, history is archive. `MeshCore.onUnregister`, which every removal path shares (the DELETE routes, the MCP tool, the reconciler's 24-hour orphan sweep), cascades into `RoomService.dropDepartedAgentAt`. That removes every author at the directory that no registered agent answers for from every **channel**, with its session binding and any fallback seat, in one transaction. A **direct message** keeps the membership, because a DM is named by its member set (`dm_member_key`) and removing one person would turn it into a different conversation or collide with an existing one.

**Leaving is recoverable.** The same transaction writes each removed seat to `room_departed_seats` (migration 0113): the membership as it stood, whether it held the fallback seat, and the manifest id of the agent that left. `MeshCore.onAgentsChanged` (registered or updated) replays those seats when the agent now registered at the author's directory has that same manifest id. A seat comes back only if the room still exists, is still an unarchived channel, and the author has no seat there now. The fallback seat comes back only if nobody holds it. The matched tombstones are deleted in the same transaction. The session binding is not restored: the next turn opens a fresh session and reads what it missed from its restored cursor, rather than resuming a transcript the runtime may have pruned or re-keyed while the agent was away. A different agent at the same folder matches nothing, including through a legacy author row with no stamp.

"Retired" is **derived, not stored**: an agent author is retired exactly when `isLiveAuthor` fails. The wire carries it as `AuthorRef.retired`, and `RoomWithRoster.formerAuthors` names everyone who wrote in a room and is no longer on its roster, so their messages keep a name. A boot-time sweep first replays any waiting seat whose agent is back, then repairs seats left before the cascade existed. It removes a seated agent only when the registry has no live occupant for it AND no undenied manifest at its directory names the same agent (a pending registration). Every write re-checks liveness at commit time.

## Consequences

### Positive

- Channel rosters and `@`-completion name only agents that can answer. Nobody cleans up by hand, and existing ghosts are repaired on the next start.
- An agent the reconciler unregistered because its folder was away for more than 24 hours (an external drive, a weekend) comes back to every channel it was in, with its per-room settings, its read position and its fallback seat.
- Because retirement is derived, an agent that returns with the same manifest is active again in its DMs without anything being un-retired.
- A person or agent only taken out of a room is named in its history too; before this, their messages read as "Unknown".

### Negative

- A person's own unregister usually deletes the agent's manifest, so adding the folder again makes a new agent with a new id. That agent starts with nothing: its old DMs stay retired and it must be added to channels again. Only a manifest git tracks survives a manual unregister, and then the same agent returns with its seats.
- Seats recorded by the repair sweep for an author with no stamp are kept but never replayed, because nothing can prove a returning agent is the same one.
- The session binding is not carried across a departure, so the first turn after a return starts a fresh runtime session.
- One migration (`room_departed_seats`), and tombstones for rooms that are never reopened stay until the same agent returns.
- The room read carries one more query (`formerAuthors`), one indexed probe per non-system author on the install.
