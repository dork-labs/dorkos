---
id: 260728-022013
title: A thread is a relation between entries, not a child room
status: accepted
created: 2026-07-28
spec: rooms
superseded-by: null
---

# 260728-022013. A thread is a relation between entries, not a child room

## Status

Accepted. Supersedes one clause of
[260726-170125](260726-170125-a-room-is-a-membership-scoped-durable-stream.md).

**The scope of the supersession is one sentence.** Only "a thread is a child room — the same
entity with a parent, one level deep" is reversed. Everything else in that ADR stands unchanged
and remains the governing decision: a room is a membership-scoped durable stream; a room is not a
session and N agents in a room are N sessions on one stream, each keeping its own runtime binding;
membership is where per-room state lives, carrying the `(member, room)` read cursor and the
`responseMode` override; the log is turn-atomic, DorkOS-owned and never trimmed; rooms carry
addressing and atomicity but never a concurrency primitive; a room may reference a workspace;
signing is reserved but deferred.

## Context

260726-170125 chose the child-room shape for one good reason, stated in its own Consequences:
threads would cost "one nullable `parentId`, not a second conversation model." That held while a
thread was a design sketch. It stopped holding once rooms shipped, because the things a container
has to carry turned out to be things it carries badly, and because a later spec ruled the opposite
shape correct one layer up.

**The cascade guard is weaker across a thread boundary than inside a room.** 260726-170127 names
ancestry, not depth, as "the load-bearing one" of its two rules, and says a pure depth counter
"permits N-1 wasted model calls before it fires." Ancestry is a within-room guarantee by
construction: `authorsInCascade` filters on `room_entries.room_id` and reads
`idx_room_entries_cascade_root`, an index on `(roomId, cascadeRoot)`
(`packages/db/src/schema/rooms.ts:208`, `apps/server/src/services/rooms/room-store.ts:540-549`).
260726-170127 records the same limit for cross-room cascades: they "carry their depth but not their
ancestry." A child-room thread therefore hands a cascade back the weaker of the two bounds. The
service already knows this and routes around it: `createThread` runs the seeding gate specifically
because "an ungated `createThread` would hand an agent an unlimited supply of fresh cascade
namespaces" (`apps/server/src/services/rooms/room-service.ts:344-352`).

**The turn budget multiplies with the container.** `turn-budget.ts` records the measurement in its
own module comment: "measured through the real mount, a cap of 2/room bought 16 turns across 8
channels. Threads are cheaper still, since a thread inherits the parent's whole roster, so five
threads off one parent bought 12" (`apps/server/src/services/rooms/turn-budget.ts:32-36`). The
per-room cap is not defective; a thread simply is a room, so it comes with a fresh window.

**An agent starts a thread blank.** `room_sessions` is keyed `(roomId, authorId)`
(`packages/db/src/schema/rooms.ts:220-228`), and that key is the point: an agent's context in
`#backend` is deliberately not its context in a DM. A thread is a different room, so it is a
different session, with no continuity with the channel the thread came out of. Under the child-room
shape the free default is the blank agent.

**Membership multiplies too.** `room_members` is keyed `(roomId, authorId)`
(`packages/db/src/schema/rooms.ts:134-148`) and `createThread` inherits the parent's entire roster
(`room-service.ts:353-373`), so every thread mints a membership row, a read cursor and a
`responseMode` per member, each of which then has to be kept in step with the parent forever.

**Retrieval wants one log, not N.** `specs/room-participation/01-ideation.md` §4.7 proposes
`search_room_history(roomId, query)` and `read_room_history(roomId, before, limit)` so an agent
whose context window compacted can read the room's own record. One predicate over one log beats a
`UNION` across a parent log and every thread log hanging off it.

**The port above storage already models it as a relation.** `specs/community-adapter`
`02-specification.md` §4 establishes that "at the port, a thread is a relation between entries, and
`listRooms` never returns one," and it is candid about the price: the local adapter must filter
`kind === 'thread'` out of `listRooms`, which it calls "the largest single consequence of the
design" (`:459`, `:475`). That spec landed on `main` in PR #533 with an open question (`:728`)
asking whether excluding threads breaks the cockpit's thread surfaces. Moving the storage removes
the divergence rather than translating it, and answers the open question by deleting it.

**The prior art points the same way.** `research/20260727_thread-models.md` surveys six shipping
products and the upstream protocols. Matrix, which has the cheapest containers in the industry,
explicitly considered and rejected threads-as-rooms in MSC3440, and its four stated disadvantages
match four costs found independently by reading our code, one for one (§4.3a). Buzz's pointer model
was an economic choice, not a design preference: a Nostr event id is a content hash a client mints
offline, while a relay-signed container needs an authorized `kind:9007` plus three discovery events.
That economics does not transfer, because we own a SQL engine and `WHERE parent_entry_id IS NULL`
is free.

**The timing is not incidental.** R4 (DOR-527), the phase that builds threading's product surface,
has not started. The cockpit's entire thread surface is four lines of `thread ?? id` precedence
(`router.tsx:242-252`, `ChannelsPage.tsx:20-21`, `use-room-document-title.ts:64-65`,
`DashboardSidebar.tsx:131-133`), and nothing in the client ever writes `?thread=`. Server-side it is
one route (`POST /:id/threads`, `apps/server/src/routes/rooms.ts:209-227`), one service method with
exactly one non-test call site, one request schema, one error code, one enum member and two columns.
There is no transport method for thread creation, by design: `room-methods.ts:5-9` says thread
creation "reaches the client in later phases."

## Decision

We will store the thread relation on the **entry**, not on the room. A thread is a set of entries in
the same room that point at a common root entry; it is not a room, has no roster of its own, and
never appears in a room list.

**Depth stays at one level, and that is now a policy, not a ceiling.** The service keeps refusing a
reply whose root is itself a reply, on the same reasoning 260726-170125 gave and that all six
surveyed products share. What changes is where the constraint lives: it becomes a rule the service
enforces and can revisit, rather than a shape the schema has already decided. We are not opening
nesting; we are removing the schema's vote on it.

**Migration shape, stated so the follow-up ticket has a target and not a blank page.** This ADR
decides; it does not implement.

- `room_entries` gains a nullable `parentEntryId` (and the root pointer the port already names), so
  a reply is an entry in the parent room with a pointer, and the default timeline is
  `WHERE parent_entry_id IS NULL`.
- `rooms.parentId`, `rooms.rootEntryId`, `idx_rooms_parent_id` and the `'thread'` member of
  `RoomKind` retire, along with `NESTED_THREAD` in its current room-shaped form.
- `POST /api/rooms/:id/threads` becomes an entry-level route, and `createThread` stops being a
  room-creating operation. The roster inheritance in `room-roster.inheritedFrom` and the thread
  branch of `seedResponseMode` go with it, since there is no second roster to seed.
- **There is no data to move.** On the operator's live install, measured read-only on 2026-07-28,
  `rooms` holds 6 channels, 2 DMs and 0 threads. That is one install on one day, not a claim about
  every install, but it is the install that exists.

## Consequences

### Positive

- The cascade guard's strong rule applies to a threaded conversation. A reply lives in the parent
  room, so ancestry is in scope and A to B to A is refused at the first repeat instead of running to
  the depth ceiling.
- One turn-budget window covers a channel and everything threaded inside it, so the per-room cap
  bounds what it appears to bound.
- An agent triggered in a thread answers in the room's session, with the room's context, by default.
  The blank-agent case stops being the free default and becomes something you would have to build.
- No roster, read cursor or `responseMode` row is duplicated, so there is no parent state to keep in
  sync and no drift to detect later.
- Retrieval is one predicate over one log. `search_room_history` and `read_room_history` do not have
  to fan out.
- Storage and the community port now agree. The local adapter no longer filters `kind === 'thread'`
  out of `listRooms`, the "largest single consequence" of that spec's design disappears, and its
  open question about the cockpit's thread surfaces is answered rather than deferred.
- `docs/concepts/rooms.mdx` ("DorkOS has two kinds: channels and direct messages") becomes correct.
  It was drift under the old model.
- 260726-170125's recorded negative, "A thread of a thread has no representation and will eventually
  be asked for," is retired. The answer moves to a service rule that a future ADR can change without
  a schema migration.

### Negative

- **A thread can no longer have its own membership subset.** Under the child-room shape you could in
  principle add somebody to a thread without adding them to the parent, or drop somebody from one
  branch. That capability is now gone. It was never reachable (`createThread` inherits the parent's
  whole roster, and no route ever edited a thread's roster separately), and at one level of depth a
  narrower subset is a private conversation inside a room that other members can see the existence
  of, which is a worse answer than a DM. But it is a real capability being removed, not one that was
  merely unimplemented.
- **A thread can no longer have its own read cursor.** "Unread in this thread" is now expressible
  only as a projection over the parent's cursor and the entry relation, not as a stored
  `last_read_seq`. This is precisely the cost Matrix paid on the other side: MSC3771 added a
  `thread_id` to read receipts because a single chronological timeline could not express per-thread
  read state, so we are choosing the problem they had rather than avoiding it. We choose it
  knowingly: a per-thread cursor at one level of depth is a badge, and a badge computed on read is
  cheaper to get right than a second cursor that has to be maintained, migrated and reconciled.
- **A thread can no longer carry its own response modes.** An agent cannot be `always` in one thread
  and `mention-only` in the parent channel. Since a thread inherited the parent's modes verbatim
  anyway, no shipped behavior changes; what is lost is a place to diverge later, and per-thread
  addressing was never asked for by anything.
- **The room list stops being the only enumeration of conversations.** Anything that wanted "every
  conversation" by listing rooms now needs the entry relation too. That is the correct shape and it
  is what the port already assumes, but it is one more thing a new consumer has to know.
- **A schema migration and a superseded clause are real cost for a feature nobody has used.** The
  honest defence is timing rather than urgency: this is the smallest the change will ever be, and
  every phase of R4 that ships a thread pane, an unread badge or a reply affordance against the room
  shape makes it larger.
- **260726-170125 is now partly historical**, and a reader who finds its "thread is a child room"
  sentence without the amendment above will be misled. The amendment is in place; the risk is that
  quoted excerpts of that ADR travel without it.
