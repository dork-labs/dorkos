---
id: 260728-022013
title: A thread is a relation between entries, not a child room
status: accepted
created: 2026-07-28
spec: rooms
amends: 260726-170125
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

**260726-170125 deliberately keeps `status: accepted`, and that is not an oversight.** The ADR
vocabulary has no partial state: the manifest carries only `accepted`, `superseded`, `deprecated`,
`proposed`, `rejected` and `draft`, and both the `writing-adrs` skill and `/adr:review` treat
`superseded` as a terminal state meaning "replaced by a newer ADR." A status is therefore an
instruction about whether to rely on the document, not a description of its history, and a reader
must still rely on nearly all of 260726-170125. Marking it terminal to record a one-clause change
would tell every future reader to stop reading the document that establishes the rooms model. The
scope of the change lives in prose at the top of that ADR instead.

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
design." That spec landed on `main` in PR #533 with an open question asking whether
excluding threads breaks the cockpit's thread surfaces. Moving the storage removes
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
has not started. The cockpit has no thread pane, no "N replies" row and no create-thread affordance:
its whole thread surface is a `?thread=` route param that four call sites read and **nothing in the
client ever writes**, plus one icon branch. Server-side it is one route
(`POST /:id/threads`, `apps/server/src/routes/rooms.ts:209-227`), one service method with exactly one
non-test call site, one request schema, one error code, one enum member and two columns. There is no
transport method for thread creation, by design: `room-methods.ts:5-9` says thread creation "reaches
the client in later phases." The full inventory is the table under Decision.

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
  room-creating operation.
- **There is no data to move.** On the operator's live install, measured read-only on 2026-07-28,
  `rooms` holds 6 channels, 2 DMs and 0 threads. That is one install on one day, not a claim about
  every install, but it is the install that exists. _(Confirmed 2026-07-29: migration `0038` run
  against a copy of that database moved nothing, renumbered nothing and changed no read cursor. The
  migration was still written and tested as though there were data, because "the install that
  exists" is not the only install that will ever run it.)_

**The surface as it was inventoried on 2026-07-28. It was not exhaustive, and this paragraph is the
correction.**

> **Amended 2026-07-29, after DOR-634 shipped.** This table originally ended the sentence above with
> "so it is exhaustive by intent." It was not, and saying so invited three separate reviewers to use
> it as a checklist. Across the ticket's three PRs it was found wrong in **fifteen** places, so the
> claim is withdrawn rather than patched: **a fresh search beats this table, and any future
> inventory should say what it looked at rather than that it found everything.** What it missed, kept
> because the pattern is more useful than the list —
>
> - **The largest live omission was `room-context.ts`'s `resolveFrame`**, the only consumer of the
>   thread relation in the agent path — a rewrite, not a deletion. With it went
>   `room-context-block.ts`, `additional-context.ts`'s `RoomContextData.thread` contract,
>   `openapi-registry.ts` (CI-gated), `room-rows.ts`'s `NewRoom`, and `room-service.ts`'s room draft.
> - **`palette-rooms.ts` is absent because it did not exist yet** — PR #575 created it about five
>   hours after this ADR was written — and it held `paletteRoomTarget`, **the only thing in the client
>   that ever wrote `?thread=`.** The sentence below claiming "nothing in the client ever writes" it
>   was true when written and false a day later. An inventory of a moving codebase has a shelf life.
> - **Tests were left out of the table entirely**, which is where most of the actual work turned out
>   to be: the `responseMode × roomKind` matrix in `addressing.test.ts` enumerated `thread` as a room
>   kind, `sidebar-item.test.ts` and `room-marks.test.tsx` each pinned a legacy row's mark, and 40
>   `parentId: null` / `rootEntryId: null` fixture lines were spread across 18 files.
> - **Two rows were wrong rather than missing.** `room-roster.ts` is cited for an `inheritedFrom`
>   symbol that does not exist in the file — the thread branch lived in `seedResponseMode` alone. And
>   `message-variants.ts` is not a thread-room surface at all: it is the session chat's message
>   toolbar, whose "reply-in-thread lands here later" note is still true and still untouched.
> - **Line ranges rotted within the day** (`RoomAvatar.tsx` 86-94 → 105-123, `DashboardSidebar.tsx`
>   131-133 → 146,148, via PR #580), and the prose sweep missed its own `spec:` target,
>   `specs/rooms/02-specification.md`.
>
> The table stands below as the inventory that was made, which is still useful as evidence of how the
> change was scoped. It is not a checklist and never was one.

`L` marks live code that behaves differently after the change; `P` marks prose or a type that only
has to stop saying the retired thing.

| Where                                                                                          | What                                                                         |     |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --- |
| `packages/db/src/schema/rooms.ts:86,89-90,105,118`                                             | `kind` doc, `parentId`, `rootEntryId`, `idx_rooms_parent_id`                 | L   |
| `packages/shared/src/room-schemas.ts:31-34,150,158-161,188,206,304,389-396`                    | `RoomKindSchema`, `parentId`, `rootEntryId`, `CreateThreadRequestSchema`     | L   |
| `apps/server/src/routes/rooms.ts:46,209-227`                                                   | `POST /:id/threads`, `NESTED_THREAD` status mapping                          | L   |
| `apps/server/src/services/rooms/room-service.ts:320-382,948-951`                               | `createThread`, its nested-thread guard, `summarize` for the default title   | L   |
| `apps/server/src/services/rooms/room-roster.ts:71-90,196-214`                                  | `inheritedFrom`, the thread branch of `seedResponseMode`                     | L   |
| `apps/server/src/services/rooms/room-errors.ts:21`                                             | `NESTED_THREAD` error code                                                   | L   |
| `apps/client/src/layers/entities/room/ui/RoomAvatar.tsx:86-94`                                 | live `room.kind === 'thread'` branch rendering `MessagesSquare`              | L   |
| `apps/client/src/router.tsx:232,242-243,251`                                                   | the `?thread=` search-param schema and its "child room" docstring            | L   |
| `apps/client/src/layers/widgets/room-view/ui/ChannelsPage.tsx:15-16,20-21`                     | `thread ?? id` precedence                                                    | L   |
| `apps/client/src/app/use-room-document-title.ts:44-45,64-65`                                   | same precedence, for the tab title                                           | L   |
| `.../features/dashboard-sidebar/ui/DashboardSidebar.tsx:131-133`                               | same precedence, for the active-room highlight                               | L   |
| `apps/e2e/fixtures/rooms-api.ts:40`                                                            | hand-written `kind: 'channel' \| 'dm' \| 'thread'`                           | P   |
| `apps/server/src/services/rooms/room-service.ts:46`                                            | "rooms and threads are free to create"                                       | P   |
| `docs/getting-started/configuration.mdx:182`                                                   | the same sentence, user-facing                                               | P   |
| `apps/client/src/layers/entities/room/model/use-rooms.ts:82-90`                                | docstring; `useRoomsByKind` (`:100-108`) selects by kind and needs no change | P   |
| `apps/client/src/layers/entities/room/{index.ts:2,ui/RoomTitle.tsx:28,lib/room-display.ts:98}` | "channels, direct messages and threads" asides                               | P   |
| `apps/client/src/layers/shared/lib/transport/room-methods.ts:5-9`                              | "thread creation reaches the client in later phases"                         | P   |
| `apps/client/src/layers/features/chat/ui/message/message-variants.ts:37`                       | "reactions and reply-in-thread land here in later phases"                    | P   |

- **The surfaces that do NOT touch the thread-as-room shape, verified by search so nobody repeats
  it:** no MCP tool and no Capability Registry entry mentions threads; no browser test exercises one
  (only the fixture type above); and neither the Obsidian plugin nor the desktop shell contains
  anything about them (their only "thread" hits are about OS threads). Relay's `ChannelTypeSchema`
  (`packages/shared/src/relay-envelope-schemas.ts:26-28`) has a `'thread'` member, and
  `packages/relay/src/lib/thread-id.ts`, `trace-store.ts:303`, `binding-form.ts:27`,
  `BindingDialog.tsx:48` and `binding-tools.ts:50` all carry it, but every one of them names a Slack
  or Discord thread on the remote side and is unrelated to room storage.

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

- **The parent room's unread count changes meaning, and the shipped mark-read path cannot clear it.**
  This is the sharpest consequence of one shared `seq` space and the one the migration is most
  likely to get wrong. `countUnread` counts every entry above the cursor with no visibility
  predicate (`room-store.ts:525-532`), while the cursor is only ever advanced to the newest entry
  the reader can actually see: `useMarkRoomRead` takes its `newestSeq` from the entries the open
  room rendered (`use-mark-room-read.ts:76-83`, fed by `ChannelsPage.tsx:47`). A thread reply draws
  from the parent's `seq` and is excluded from a `WHERE parent_entry_id IS NULL` timeline, so it
  lands above the cursor in a view that can never move past it. **The two places the predicate could
  go fail differently, and both are wrong:** put it inside `listEntries` and the sidebar's "Mark as
  read" (`use-mark-room-read.ts:105-107`, which reads `listRoomEntries(roomId, { limit: 1 })`) stops
  at the same top-level entry, leaving a badge the reader cannot clear from anywhere; put it only in
  the client view and the sidebar clears the badge while the open room never does, so it returns on
  the next refetch. Either way the count includes entries the reader is not being shown.
  The fix is DOR-634's to choose, and there are two shapes: filter `countUnread` to the same
  predicate the timeline renders and surface thread unreads separately on the summary row, or
  advance the mark-read path to the room's true max `seq` regardless of visibility. We lean to the
  first, because unread should mean unread in what the reader is looking at, but that is a lean and
  not a decision. **The old model had this for free** (a thread was a room, with its own cursor and
  its own count), and giving that up is what buys everything above.

  **Resolved 2026-07-28, and the lean above was overturned: neither shape, but a third.** The
  visibility predicate went in exactly one place — the render — and neither the cursor path nor the
  count moved. `countUnread`, `listEntries` and `useMarkRoomRead` are untouched, because
  `useMarkRoomRead` already advances to the room's true max (the array it is handed is unfiltered),
  so the second shape was a constraint to preserve rather than work to do. The first shape was
  refused on evidence: a visible-only `newestSeq` short-circuits `use-mark-room-read.ts`, leaving a
  badge that clears only when an unrelated top-level entry arrives — the exact "lie the reader cannot
  correct" that file's own module doc forbids. The paragraph above also under-counts the callers:
  `countUnread` had **two**, and the second computed a thread's `replyCount` in the agent context
  path, so editing the predicate would have silently changed a value nothing named. That caller
  retired with the child room, and `countThreadReplies` answers it now.

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
