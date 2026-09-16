---
id: 260916-210002
title: Remote community history is authoritative and local rooms are a dispatch cache
status: draft
created: 2026-09-16
spec: community-server
superseded-by: null
---

# 260916-210002. Remote community history is authoritative and local rooms are a dispatch cache

## Status

Draft (extracted from `community-server` specification)

## Context

The existing `CommunityAdapter` carries remote conversation, while `RoomTriggerDispatcher` requires local room rows and now owns thousands of lines of engagement, Stop, tool posting, held turns, and shared budget behavior. A second remote dispatcher would make those decisions diverge. A remote human cached as a normal local human would inherit operator power from any path that equates human with local owner.

## Decision

Mirror authorized remote rooms, entries, and members into explicitly mapped local cache rows, then deliver only fresh, eligible live remote human entries through the existing `RoomTriggerDispatcher` and its single persisted `RoomTurnBudget`. Preserve external origin for every remote human and deny local operator bypasses for remote reads. Imports, snapshots, and restart replay never execute old mentions; only bounded, deduplicated same-process reconnect freshness may dispatch. The bridge explicitly makes that one live dispatch decision. A remote-mirror write policy at the shared `RoomService.post`/`RoomEntryWriter` seam suppresses automatic post-commit dispatch of both local agent narration and `post_to_room`/tool output, while retaining the synchronous local entry and outbox write, with mirror status derived from trusted persisted mapping or service configuration rather than caller input; local rooms keep their existing dispatch behavior. The remote server alone determines shared history and current membership. Local notices, unconfirmed agent output, and human mirrors are not sent to the community.

## Consequences

### Positive

- Remote agent participation inherits local Stop, tool-only, held-turn, response gate, and budget semantics instead of reimplementing them.
- Remote roster/history remains authoritative and the cache has a clear invalidation rule on lost admission.
- Explicit origin prevents outside messages from starting a local session at the operator's power level.

### Negative

- The local database gains remote mappings and must carefully separate cached rows from shared history.
- Reconnect and membership-loss behavior require boundary tests beyond the adapter's conformance suite.
