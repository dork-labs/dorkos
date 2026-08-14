---
slug: community-remote-trigger
id: 260814-025025
created: 2026-08-14
status: ideation
---

# Ideation: The remote trigger path — turning a mention in someone else's community into a turn on my machine

- **Slug:** community-remote-trigger
- **Date:** 2026-08-14
- **Author:** Claude (directed by Dorian)
- **Tracker:** community program — C2 is DOR-596 ("she brings her agents"); the port is DOR-595 backend #3; the program frame is DOR-589 D2.
- **Anchors:** codebase = branch `dor-1204-adapter-load-bearing` off `origin/main` @ `e370557f8`. Prior art = `specs/community-server/01-ideation.md`, `specs/community-adapter/02-specification.md`, ADR `260727-184933` (the community server never runs a member's agent), ADR `260814-024525` (bridged rooms are projections, not communities), `research/20260813_room-architecture-vs-buzz-qm.md`.

## 1) Intent

**The `CommunityAdapter` port deliberately never executes an agent.** Rule 4 of the port is explicit: "There is no turn, no session handle and no invocation on this port… The port carries conversation; compute stays on the member's machine" (`packages/shared/src/community-adapter.ts`; D9; ADR `260727-184933`). That is the right call — it is what keeps a community server from becoming a place that runs other people's models on other people's bills, and it is what makes "she brings her agents" mean her agents, running where she is.

It also leaves a hole with nothing in it. In a community whose truth is remote, somebody types `@ana what's the status?` in a room on **their** server. The message travels to my machine as a `CommunityRoomEvent` on `subscribeRoom`. And then… nothing happens, because no code turns that event into a turn. Ana is mine, she runs here, and the only thing that could dispatch her is a thing this repo has not built.

This spec sketches that thing: **the subscription→dispatch bridge**. It is the missing half of the port, and it is the whole of what C2 needs.

Honest framing up front: this is an ideation artifact. It names the shape, the mechanisms that transfer, the ones that do not, and — at some length — the five things nobody has answered yet. At least one of them is a hole in the port itself, not in this bridge.

## 2) What already exists, and where it stops

The local trigger chain is complete and well-bounded. Following one message:

1. `POST /api/rooms/:id/entries` commits an entry and returns 202. Delivery is the stream's job (ADR-0264).
2. `resolveAddressing` resolves `@name` **once, at write time**, and stores the resolved author ids on the entry (`mentions.ts`). Nothing re-parses text later.
3. `RoomTriggerDispatcher.dispatch(room, entry, namedUnreachable)` (`room-trigger.ts:336`) runs `selectTriggerTargets` (`addressing.ts`), then per target `evaluateCascade` (`cascade-guard.ts`) and `RoomTurnBudget` (`turn-budget.ts`), claims `(room, agent)`, publishes presence, and runs the turn through `RoomTurnRunner`.
4. Every way of declining writes a durable room notice (`room-notice-log.ts` — the single writer; `.claude/rules/room-conduct.md`, "a refusal is visible").
5. The reply is committed as a room entry, and reaches every reader on the room's own SSE stream.

Every one of those steps is keyed on **local rows**: a `Room` and a `RoomEntry` from this machine's SQLite, an `authorId` from the local `AuthorRegistry`, a `cascade_root`/`cascade_depth` pair stamped on the entry, a `room_members.last_read_seq`.

The port speaks a different vocabulary and stops one step short. `subscribeRoom(roomId, sinceCursor, signal)` yields `snapshot | entry | signal | room_closed`; a `CommunityEntry` carries `id`, `authorId`, `text`, `mentions` (member ids, resolved at write time by the community — the same discipline, which is lucky), `parentEntryId`, `threadRootEntryId`, `depth`, `cursor`. `listMembers(roomId)` gives a roster with `kind`, `handle`, `role`, optional `responseMode`, and `ownerMemberId`. There is no dispatcher on the other side of any of it.

## 3) The shape

### 3.1 Where it lives

A **community-aware dispatcher beside `RoomTriggerDispatcher`, not inside it** — `apps/server/src/services/communities/remote-trigger/`.

Beside, because the two have different inputs and the same outputs. `RoomTriggerDispatcher` takes `(Room, RoomEntry)` and is 900 lines of decisions that assume local rows. Teaching it a second row shape would fork every branch in it. The remote dispatcher's job is narrower: **translate, then delegate**. It owns the subscription lifecycle, the identity mapping, and the provenance question (§3.4); everything after that is the existing dispatcher's, unchanged.

Not inside `services/rooms/`, because rooms is already a god object the architecture review called out by name, and because this code's dependency is the port, not the store.

### 3.2 What it consumes

One subscription per `(community, room I am in)`, held while the community is connected:

- **`subscribeRoomList`** tells it which rooms exist and when one appears or goes away. The port already absorbs poll-vs-push here, so this side has one code path.
- **`subscribeRoom`** per room, resumed from the last cursor it finished processing. `StaleCommunityCursorError` is caught, the subscription falls back to a cold snapshot, and **dedupe is by `CommunityEntry.id`** — the port's own rule, and the thing that stops a re-snapshot re-triggering yesterday's mentions.
- **`listMembers`** for the roster, refreshed on the room's own events rather than polled. It is what maps a remote `memberId` in `entry.mentions` to a local agent, and it is where `responseMode` comes from when the backend has it.

**A remote entry is mirrored into a local room row before it is dispatched, and that mirror is a CACHE.** This is the pragmatic call: engagement windows, claims, presence, notices, read cursors and `buildRoomContext` are all keyed on local rows, and rebuilding six mechanisms against port types to avoid one mirror is the wrong trade. It also stays consistent with ADR `260814-024525` — for a **bridged** room the local store is the truth; for a **community** room the local rows are a cache the community can invalidate, which is exactly what the port already says a `'not-admitted'` connection does. The mirror carries the community ref, so nothing can confuse the two.

### 3.3 The reply path

A turn's reply goes back through `post(roomId, { text, parentEntryId, mentions })`, gated on `canPost`. Two consequences that are easy to miss:

- **A read-only community cannot be answered.** Ana can be told that somebody asked, can run, and cannot speak. The bridge must refuse to dispatch at all in that case rather than run a turn whose output has nowhere to go — burning a model call to produce a message nobody will ever see is worse than the silence.
- **The "a refusal is visible" invariant does not survive the boundary.** Every local decline writes a durable notice into the room. In a community we cannot post into, there is nowhere to write it; and even where we can, writing "Ana is out of turns for this room" into somebody else's community is our machine's plumbing on their wall. The working answer is that **remote refusals are surfaced locally** — in the mirrored room, visible to the agent's owner, who is the person who can act — and that the invariant is restated as "visible to whoever can do something about it". This needs Dorian's sign-off; it is a real weakening of a settled rule.

### 3.4 Bounds across a remote boundary

This is the part that does not transfer cleanly, and it is the reason this deserves a spec rather than a ticket.

| Mechanism                                         | Crosses?           | Why                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Turn budget** (`RoomTurnBudget`)                | **Yes, unchanged** | It counts turns **we** ran, in our process, "whoever the caller claims to be". It is the one bound whose input is entirely local, so it is the one that still holds against a community that is hostile, buggy, or merely chatty. It is therefore the primary bound here, not the backstop it is locally. |
| **Cascade depth + ancestry** (`cascade-guard.ts`) | **No**             | It reads `cascade_root`, `cascade_depth` and the distinct authors already in the cascade — three columns on **our** entries. `CommunityEntry` carries none of them and never will: provenance is a claim, and a claim from a server we do not run is not evidence.                                        |
| **Engaged window** (`engagement.ts`)              | **Yes**            | It is a predicate over the durable log, and the mirror is a durable log.                                                                                                                                                                                                                                  |
| **Claims / `busyIn`**                             | **Yes**            | One turn per `(room, agent)` is a fact about our process.                                                                                                                                                                                                                                                 |
| **`responseMode`**                                | **Partly**         | Present only when the backend declares the capability. Where it is absent (Buzz), the honest default is the **agent's own local manifest default** — the agent is ours, and its owner's setting is the only real answer available.                                                                        |

The cascade row is the hard one. Three options, none free:

1. **Every remote entry starts a fresh cascade at depth 0.** Simple, and safe against humans. Unsafe against a community where two members' agents can address each other: each hop looks like a fresh start to both machines, and the local ancestry rule never sees a repeat. This is the 30-hop failure `cascade-guard.ts` already documents, reproduced across two hosts.
2. **Treat a remote entry authored by an agent as already-spent** (the un-provenanced-agent rule the guard applies today). Safe, and it means an agent in a remote community can never answer another agent — including the one case people will most want, a colleague's agent handing work to mine.
3. **Carry provenance as a convention on the wire** — a depth marker inside the entry, or a `features` field the adapter maps. Correct in principle, unenforceable in practice: nothing stops a remote entry claiming depth 0 forever, so it is a courtesy between well-behaved implementations, bounded by the turn budget rather than by itself.

The recommendation is **(2) as the shipping default with (3) as an opt-in per community**, and the turn budget as the bound that is actually load-bearing. That is a decision for the specification stage, and it wants an ADR: it is the first time a settled invariant (bounds are mechanisms, never prompts or conventions) meets a boundary where we do not own the mechanism.

## 4) What C2 (DOR-596) needs from this

"She brings her agents" decomposes into five things, and this bridge is three of them:

1. **Admission** — her agent gets its own identity in the community, vouched for by her (`admitAgent`, `agentAdmission: 'owner-vouched'`). Exists on the port; nothing calls it.
2. **Arrival** — a mention of her agent in that community reaches her machine. **This spec, §3.2.**
3. **Execution** — the mention becomes a turn, on her machine, on her subscription, under her bounds. **This spec, §3.4.**
4. **Attribution** — the reply appears in the community authored by her agent, not by her. **This spec, §3.3 — and see Open Question 1, which says the port cannot currently express it.**
5. **Removal** — she leaves, or an admin ejects the agent, and it stops. `revokeAgent` plus the `'not-admitted'` cache rule cover it, provided the bridge tears its subscriptions down on that status rather than retrying.

## 5) Open questions

**1. An agent cannot be the author of a `post()`, and this may be a hole in the port.** `post(roomId, input)` takes no author. One adapter instance serves one connected identity. So an agent's reply, sent through its owner's adapter, arrives attributed to its owner — which directly contradicts `CommunityEntrySchema`'s own rule that "an entry authored by an agent NEVER carries its owner's id", asserted by the conformance suite. The candidate answers each cost something: one adapter instance per `(community, agent)` (but the registry is keyed on `CommunityRef` alone, so it collides), an author field on `post` (widens the port for one caller), or the community server resolving the author from the credential presented (moves the problem to a server that does not exist yet). **This is the one that most needs answering before anything is built**, and it is the same question DOR-596 flags open as "agent auth to a remote community".

**2. What credential does an agent present?** Rule 3 says no credential crosses the port and an adapter resolves its own from a server-side store keyed on its `CommunityRef`. An owner-vouched agent identity implies a second credential, or a delegation of the owner's — neither exists, and `communityCredentialEnvVar`/`resolveCommunityCredential` are keyed per community, not per member.

**3. Where does a remote turn run?** `CommunityRoom` deliberately has no `workspaceId` — a remote community has no opinion about a path on somebody's laptop, and putting one on the wire is the privacy defect the author registry exists to prevent. So the cwd for a turn triggered from a remote room has to come from somewhere local: the agent's own manifest, a per-community default, or a prompt at admission time. Unanswered.

**4. Which read cursor decides what the agent has already been shown?** Locally it is `room_members.last_read_seq`, advanced at claim time. A community with `readCursor: 'client-opaque'` round-trips a blob it cannot interpret; one with `'none'` has no cursor at all. The mirror can carry its own — but then two cursors exist for one room and the rule for which wins is not obvious.

**5. Halt, late replies and restart.** `POST /api/rooms/:id/halt` reaches the runtimes for a local room. A turn triggered from a remote room is ours to stop, so halt should work — but the room the person is looking at may be the remote one, on a surface we do not own. And the coordination state that would let a restart recover an in-flight remote turn is the same state the architecture review found is not durable today (`research/20260813_room-architecture-vs-buzz-qm.md` §2, structural debt #2). Sequencing question: does this wait for that?

## 6) Non-goals

- **Not the community server.** This is the client half. `specs/community-server/` owns the other one, and ADR `260727-184933` already settles that the server never runs a member's agent.
- **Not a remote read UI.** Opening a remote room in the cockpit — routing `(community, roomId)` through the room routes, the event stream and the composer — is its own piece of work, and it is why `listRoomsAcrossCommunities` counts a remote community's rooms in a warning today instead of listing them.
- **Not the bridged-chat path.** Telegram and Slack rooms are projections into local rooms and go nowhere near this (ADR `260814-024525`). A message arriving from Telegram already dispatches, through the ordinary local chain, and must keep doing so.
- **Not a second bounds model.** Whatever §3.4 settles, there is one addressing matrix, one budget and one claim map. A remote room that needed its own would be evidence the translation is in the wrong place.
