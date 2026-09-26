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

We follow the Slack model: membership is live state, history is archive. `MeshCore.onUnregister`, which every removal path shares (the DELETE routes, the MCP tool, the reconciler's 24-hour orphan sweep), cascades into `RoomService.dropDepartedAgentAt`, which removes every author at that directory that no registered agent answers for from every **channel**, with its session bindings and any fallback seat, in one transaction. A **direct message** keeps the membership, because a DM is named by its member set (`dm_member_key`) and removing one person would turn it into a different conversation or collide with an existing one. "Retired" is **derived, not stored**: an agent author is retired exactly when `isLiveAuthor` fails. The wire carries it as `AuthorRef.retired`, and `RoomWithRoster.formerAuthors` names everyone who wrote in a room and is no longer on its roster, so their messages keep a name. A boot-time sweep repairs seats left before the cascade existed. It removes a seated agent only when the registry has no live occupant for it AND no undenied manifest at its directory names the same agent (a pending registration). The write re-checks liveness at commit time.

## Consequences

### Positive

- Channel rosters and `@`-completion name only agents that can answer. Nobody cleans up by hand, and existing ghosts are repaired on the next start.
- No migration. Because retirement is derived, an agent that comes back with the same manifest (a re-scan, a remounted drive past the grace period) is active again in its DMs and in #team without anything being un-retired.
- A person or agent only taken out of a room is named in its history too; before this, their messages read as "Unknown".

### Negative

- Registering the same agent again does not restore its channel seats. A channel seat is an invitation, and unregistering spent it. #team is the exception because `ensureTeamRoom` seats every registered agent.
- An agent whose directory stays unreachable past the reconciler's 24-hour grace period is unregistered, and loses its channel seats, like any other unregister. This matches every other `onUnregister` cascade (tokens revoked, schedules paused).
- The room read carries one more query (`formerAuthors`), one indexed probe per non-system author.
