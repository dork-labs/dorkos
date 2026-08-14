---
id: 260814-024525
title: Bridged rooms are projections, not communities
status: accepted
created: 2026-08-14
spec: null
supersedes: null
amends: null
superseded-by: null
---

# 260814-024525. Bridged rooms are projections, not communities

## Status

Accepted — the `CommunityAdapter` port's scope is settled by this record, and its first production consumer ships with it (DOR-1204, `apps/server/src/services/communities/list-rooms-across-communities.ts`).

Companion reading: [ADR-0310](0310-runtime-owned-session-storage-aggregated-listing.md) supplies the per-backend degradation shape this port copied, and the port itself is documented at length in `packages/shared/src/community-adapter.ts`.

## Context

`CommunityAdapter` is the fourth swappable seam beside `AgentRuntime`, `Transport` and `ConnectorProvider`: one port for rooms in more than one place, a registry that dispatches on `(community, roomId)`, an ADR-0310-shaped aggregation, and a conformance suite (`communityConformance`) that gates every implementation. Two backends exist — `local/` wrapping this machine's SQLite rooms, and a read-only `buzz/` relay adapter that is deliberately not registered.

It had **no production consumer**. `aggregateCommunityRooms` was never called from a route; nothing user-facing dispatched through the registry. Meanwhile the one place messages genuinely arrive from somewhere else — the Telegram and Slack chat bridge — reached rooms by a different door entirely: `services/relay/chat-bridge` calls `RoomService.postExternal`, straight into the local store, never touching the port. The 2026-08-13 architecture review named this exactly (`research/20260813_room-architecture-vs-buzz-qm.md` §2, "dead seam"; §5.4 recommendation 4) and put the choice as: route the bridge through the port so the conformance suite protects a real path, or park the port.

The framing behind that choice is the thing worth deciding, because both branches assume the bridge and the port are candidates for the same job. They are not. The port was built for the multi-user program — DOR-589 D2, and DOR-595 which lists it as backend #3 — where somebody else's server holds the conversation. A bridged Telegram group is not that: DorkOS's own SQLite holds every entry, the entry ids, the read cursors, the roster and the turn history, and Telegram holds a copy of the same conversation for the people reading it there.

The two are told apart by one question — **who holds the durable log** — and every other property of a room follows from its answer.

## Decision

**A bridged room is a PROJECTION of a local room, not a community. The `CommunityAdapter` port is reserved for communities whose source of truth is remote.**

- **The local store is the source of truth for a bridged room, and the bridge is a surface.** Telegram and Slack are second windows onto a conversation this machine owns — the same relationship the cockpit and the Obsidian plugin have to it, over a different wire. `chat-bridge` writing through `RoomService.postExternal` is therefore correct and is **sanctioned**, not tolerated: a projection must write to the store that owns the log, and routing it through a port whose whole purpose is to address a log somewhere else would be indirection with nothing on the other end.
- **The port's contract is a remote-truth contract**, and so is its conformance suite's scope. Gap-free cursor resume, a roster with roles, admission and invites, owner-vouched agent admission, and `'not-admitted'` as a first-class connection status are all questions about a database somebody else runs. A bridge has honest answers to none of them; made to implement the port it would refuse most of the surface and fake the rest, which is precisely the "capability flags that are a lie the conformance suite cannot catch" failure the port's own module doc warns against.
- **The port gets a real consumer instead of a fake one.** `GET /api/rooms` now answers through `listRoomsAcrossCommunities`, which reads the registry and runs `aggregateCommunityRooms` over every configured community, surfacing per-community degradation as `warnings[]`. This machine's own rooms deliberately do **not** travel over the port there, for three reasons in descending order of seriousness: an adapter instance serves one connected identity while `GET /api/rooms` is per-caller (an agent must see only its own rooms, and the local adapter connects as the operator); `listRooms()` takes no arguments, so `?kind=` and `?includeArchived=` cannot cross it; and `CommunityRoom` is narrower than `RoomSummary`, with no honest value for `workspaceId` or `ambientMaxEntries`. So the port serves the half only it can — every other community — and that call site is the drift guard: compiled, executed and asserted on a path a person hits, on every install, today over an empty set.

## Consequences

### Positive

- The bypass stops being an open question. A reviewer finding `chat-bridge → RoomService.postExternal` now finds a record saying why it is the right door, instead of filing it as debt for the third time.
- The conformance suite's scope is nameable: **remote-truth backends**. That makes it a real gate rather than an aspiration, and it means a future bridge (Discord, iMessage, whatever) is not blocked behind a port it has no business implementing.
- The port is no longer dead. A change to `aggregateCommunityRooms`, the registry's degradation shape, or `CommunityWarning` now breaks a route test, which is the only thing that keeps a seam honest between the day it is built and the day it is needed.
- The distinction is testable rather than stylistic: "who holds the durable log" has one answer per backend, and it decides projection-vs-community without a judgment call.

### Negative

- **Two doors into rooms remain, permanently.** A projection writes through `RoomService`; a community reads and writes through the port. That is more surface than one door, and somebody will eventually add a backend at the wrong one. The mitigation is this record plus the module docs on both sides, not a mechanism — there is no compiler check for "which store owns this log".
- **The drift guard is thin while only one community is registered.** The aggregation runs over an empty set on every install today, so what is protected is the call shape and the wire envelope, not the merge behaviour under load. The unit tests carry a fake second community precisely because production cannot yet.
- **`warnings[]` is on the wire before anything renders it.** `GET /api/rooms` now always carries the key, and the cockpit ignores it. That is a deliberately small piece of forward payload — it is what makes "empty" distinguishable from "this server does not report it" — but it is a field with no consumer until a second community exists.
- A remote community's rooms are **not** listed in `rooms` today, only counted in a warning, because nothing on this server resolves a `(community, roomId)` pair. Listing them would put clickable rooms in a sidebar that 404 on open.

## Alternatives Considered

**Make the Telegram/Slack bridge a `CommunityAdapter` backend** (research §5.4 rec 4, first branch). This is the tempting one: it would make the conformance suite protect a path users hit today, immediately. Rejected because it inverts the source of truth. The bridge would have to present this machine's own SQLite rows as a remote community's, mint cursors for a log it does not own, and answer roster, roles, admission and invite questions that Telegram either cannot answer or answers about a different thing (a Telegram group's membership is not a DorkOS room's roster; it is the roster of the window). Worse, it would put the port between a room and its own store, so every local write would have to travel out through an abstraction and back to the same table — cost with no seam behind it.

**Park or delete the port** (research §5.4 rec 4, second branch). Rejected because the reason it exists has not gone away: the multi-user program (DOR-589 D2) and DOR-595 both depend on a community whose truth is remote, and a read-only Buzz adapter already implements the contract. Deleting 4.1k conformance-tested lines and rebuilding them in a quarter costs more than giving them a consumer now — provided the consumer is real, which is the other half of this decision.

**Route the local room list through the port to force the seam load-bearing.** Rejected on a security ground, not a taste one: the port is single-identity by construction (`community-adapter.ts` rule 1), the local adapter connects as whoever owns the install, and `GET /api/rooms` is answered per caller. An agent presenting `X-DorkOS-Agent` would have been shown the operator's rooms — including DMs it is not in. A seam is not worth a visibility regression, and the honest narrow consumption point costs nothing.

## Non-Goals

- **This does not design the remote read or trigger path.** A community whose truth is remote needs a way to open one of its rooms and a way to turn a mention arriving over the adapter's subscription into a local turn; neither exists. That is seeded as `specs/community-remote-trigger/`, and C2 (DOR-596, "she brings her agents") is its first real caller.
- **This configures no remote community.** The Buzz adapter stays unregistered and unexported until there is a user-config surface for a relay URL and a label.
- **This does not say a bridged room can never live in a community.** If a community server one day owns a room that is itself bridged to Telegram, that room is a community room with a projection hanging off it — the two ideas compose, in that order. What is settled is that the projection is never the thing behind the port.
