# Specification: Rooms — channels, DMs and threads

- **Slug:** rooms
- **Id:** 260726-170533
- **Date:** 2026-07-26
- **Status:** specified
- **Decisions:** ADR 260726-170125 (room model), ADR 260726-170126 (author identity), ADR 260726-170127 (cascade guard), ADR 260728-022013 (a thread is a relation between entries)

Read `01-ideation.md` first for what is already settled and must not be re-argued.

> **Amended 2026-07-29 (DOR-634): a thread is no longer a kind of room.** ADR
> `260728-022013` supersedes the "a thread is a child room" clause of ADR
> `260726-170125`; migration `0038` dropped `rooms.parentId`,
> `rooms.rootEntryId`, `idx_rooms_parent_id` and the `'thread'` member of
> `RoomKind`, and moved any surviving thread room's entries into its parent. A
> thread is now a set of entries in one room's log pointing at a common root,
> carried by `room_entries.parentEntryId` / `threadRootEntryId`. Everything
> below is amended in place; §12's R4 row is the one place the old shape is
> deliberately left standing, as the plan it was at the time.

---

## 1. Vocabulary

| Term            | Meaning                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Room**        | A membership-scoped durable stream. Two kinds: `channel` and `dm`. A thread is a relation between entries, not a kind of room (ADR 260728-022013).                   |
| **Author**      | Anyone who can post: a human, an agent, or the system. Identified by an opaque `authorId`.                                                                           |
| **Membership**  | An author's binding to one room, carrying that room's addressing override and read cursor.                                                                           |
| **Entry**       | One durable, turn-atomic item in a room's log. Either a `post` (someone said something) or a `notice` (the room says something happened).                            |
| **Integration** | The renamed Relay concept — an external adapter (Telegram, Slack, webhook). Never called a channel after this spec; "Connection" keeps meaning network connectivity. |

---

## 2. Data model

New Drizzle schema file `packages/db/src/schema/rooms.ts`, registered in `packages/db/src/schema/index.ts` and `packages/db/drizzle.config.ts`. Migration generated with `pnpm --filter @dorkos/db db:generate` and **committed** — `db:check` fails CI otherwise.

### `authors`

```ts
export const authors = sqliteTable(
  'authors',
  {
    id: text('id').primaryKey(), // ULID, opaque, this is what everything else stores
    kind: text('kind').notNull(), // 'human' | 'agent' | 'system'
    naturalKey: text('natural_key').notNull(), // agent: agentPath. human: local account key. system: 'system'
    displayName: text('display_name').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('authors_kind_natural_key_unique').on(t.kind, t.naturalKey)]
);
```

**The natural key for an agent is its `agentPath`, never its manifest ULID** (ADR 260726-170126). Resolution is mint-on-first-use: look up `(kind, naturalKey)`, insert if absent, return `id`. `agents.project_path` is already `NOT NULL UNIQUE` (`packages/db/src/schema/mesh.ts:9`), so the natural key is genuinely unique.

`displayName` is a **cache for rendering**, refreshed on resolve. It is never the key.

v1 mints exactly one `human` author (`naturalKey: 'local'`) and one `system` author.

### `rooms`

```ts
id               text primary key      // ULID
kind             text not null         // 'channel' | 'dm'
slug             text                  // channels only; unique among non-archived channels
title            text not null
topic            text
workspaceId      text                  // optional reference; behavior is out of scope (see §9)
archived         integer not null default 0
createdAt        text not null
lastActivityAt   text not null
```

Partial unique index on `slug` where `kind = 'channel' AND archived = 0`.

Archived channels are deliberately excluded: a unique index over all channels would let a long-dead `#general` hold that name forever, and "you cannot reuse the name of a channel you archived two years ago" is a bug report waiting to happen.

**A thread is a relation between entries in one room's log**, not a room with a parent (ADR 260728-022013). One level only, and that is now a service policy rather than a shape the schema decided: a reply whose root is itself a reply is rejected with a typed error (`NESTED_THREAD`), not silently flattened.

### `room_members`

```ts
roomId        text not null
authorId      text not null
responseMode  text not null       // 'always' | 'direct-only' | 'mention-only' | 'silent'
joinedAt      text not null
lastReadSeq   integer not null default 0
primary key (roomId, authorId)
```

`lastReadSeq` **is** the `(member, room)` read cursor. The unread divider reads it.

`responseMode` is always written explicitly at join time, seeded by room kind:

| Room kind | Seed                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| `dm`      | the agent's manifest `behavior.responseMode` (`packages/shared/src/mesh-schemas.ts:62`), default `'always'` |
| `channel` | `'mention-only'`                                                                                            |

Storing it explicitly means there is no dynamic rule to reason about later, and the value is editable per room.

### `room_entries`

```ts
roomId        text not null
seq           integer not null      // per-room monotonic, allocated in-transaction
id            text not null         // ULID, stable, what a reaction would attach to
authorId      text not null
kind          text not null         // 'post' | 'notice'
body          text not null         // JSON
mentions      text not null default '[]'   // JSON array of authorId
sessionId     text                  // the session that produced this, if any
cascadeRoot   text not null         // entry id that began this cascade (own id at depth 0)
cascadeDepth  integer not null default 0
signature     text                  // reserved for phase 4; always null in v1
createdAt     text not null
primary key (roomId, seq)
```

Indexes on `(roomId, id)` and `(roomId, cascadeRoot)`.

**`seq` is allocated inside the insert transaction** (`SELECT COALESCE(MAX(seq),0)+1 FROM room_entries WHERE room_id = ?` in the same tx), which needs no separate counter table — **but the transaction must be `IMMEDIATE`.**

This is not a tuning preference. Drizzle's default is a _deferred_ transaction, which begins as a reader: it takes a read lock for the `MAX(seq)` select and then cannot upgrade to a write lock if another connection wrote in between, failing `SQLITE_BUSY_SNAPSHOT` with no retry. "SQLite serialises writers" is true of writers and says nothing about a transaction that starts life as a reader. Every write path that allocates a `seq` must pass `{ behavior: 'immediate' }`, and the concurrency test must drive real concurrent writers — flipping the flag should turn the test red.

**There is no trim.** Unlike `EventLog` (capped at 5000, oldest evicted) and `SessionEventStore`, a room log never discards entries — a room that forgets what was said is not a room. Retention, if it is ever needed, is a product decision with its own spec.

### `room_sessions`

```ts
roomId     text not null
authorId   text not null
sessionId  text not null
createdAt  text not null
primary key (roomId, authorId)
```

The session an agent member uses when it answers in this room. Three agents in a room means three rows here — three sessions on one stream, each keeping its own runtime binding (ADR-0255).

---

## 3. Shared schemas

New subpath `@dorkos/shared/room-schemas` (`packages/shared/src/room-schemas.ts` + an `exports` block in `packages/shared/package.json`, matching the `./smart-groups` block at lines 176-179).

Exports, all with `.openapi()` metadata: `RoomKindSchema`, `AuthorKindSchema`, `AuthorRefSchema`, `RoomSchema`, `RoomMemberSchema`, `RoomEntrySchema`, `RoomEntryKindSchema`, `CreateRoomRequestSchema`, `PostToRoomRequestSchema`, `UpdateMembershipRequestSchema`, and the room SSE event union `RoomEventSchema`.

### What an `AuthorRef` has to carry

A room's roster is **the only place a client learns an author exists**, so `AuthorRef` must carry enough to render and to compare — not just a label. It carries `id`, `kind`, `displayName`, optional `emoji` and `color` (presentation), and `agentRef`, a stable handle derived from the agent's `agentPath`.

`emoji`, `color` and `displayName` are a **render cache**, refreshed on resolve and never the key. `agentRef` is a derived compare handle, **not a second identity key** — the key is still `agentPath` (ADR 260726-170126).

This exists because its absence already caused a defect: R2 had to filter DM candidates by comparing display _strings_, since `AuthorRef` offered nothing stabler, which meant two agents sharing a name hid each other from the menu.

`responseMode` **reuses the existing enum** — import the values from `mesh-schemas.ts`, do not re-declare them. A second copy of that enum is a review-blocking finding.

### Canonical serialization (reserved for signing)

`room-schemas.ts` exports `canonicalizeEntry(entry): string` — a deterministic, key-sorted, UTF-8 NFC serialization of the signable subset (`roomId`, `id`, `authorId`, `kind`, `body`, `createdAt`). Nothing signs in v1; the function exists so phase 4 lands without a migration, and it must have tests pinning its output byte-for-byte.

---

## 4. Server

New service domain `apps/server/src/services/rooms/`, following the `workspace` domain's layout (`apps/server/src/services/workspace/index.ts:40-82` is the factory + singleton-accessor template):

```
rooms/
  room-store.ts        Drizzle CRUD over the five tables
  author-registry.ts   mint-on-first-use resolution of (kind, naturalKey) -> authorId
  room-service.ts      orchestration: create, join, post, read cursor, thread replies
  addressing.ts        who should be triggered by an entry (§5)
  cascade-guard.ts     depth + ancestry (§6)
  mentions.ts          parse @name -> authorId[] at post time
  index.ts             createRoomSubsystem() + get/setRoomService
```

Wired in `apps/server/src/index.ts` beside `createWorkspaceSubsystem`. Routes at `apps/server/src/routes/rooms.ts`, mounted `app.use('/api/rooms', roomRoutes)` in `apps/server/src/app.ts` next to line 163.

### REST surface

| Method   | Path                               | Purpose                                                                                              |
| -------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/rooms`                       | List rooms. `?kind=` filter. `unreadCount` per room — see the scoping rule below.                    |
| `POST`   | `/api/rooms`                       | Create a channel or DM.                                                                              |
| `GET`    | `/api/rooms/:id`                   | One room with its roster.                                                                            |
| `PATCH`  | `/api/rooms/:id`                   | Title, topic, archive.                                                                               |
| `GET`    | `/api/rooms/:id/entries`           | Paginated history, `?before=<seq>&limit=`.                                                           |
| `POST`   | `/api/rooms/:id/entries`           | Post. **Trigger-only, returns 202** — mirrors `POST /api/sessions/:id/messages`. Delivery rides SSE. |
| `POST`   | `/api/rooms/:id/members`           | Add a member (agent or human). Operator-only — `403 OPERATOR_ONLY` for an agent caller.              |
| `PATCH`  | `/api/rooms/:id/members/:authorId` | Change `responseMode`.                                                                               |
| `DELETE` | `/api/rooms/:id/members/:authorId` | Remove a member.                                                                                     |
| `PUT`    | `/api/rooms/:id/read-cursor`       | Set `lastReadSeq`.                                                                                   |
| `POST`   | `/api/rooms/:id/threads`           | Reply inside a thread off an entry in this room. Nothing is created first.                           |

Every route obtains runtimes via `runtimeRegistry`, never an SDK import. All eleven routes and their schemas are registered in the OpenAPI route registry, and `docs/api/openapi.json` is regenerated (`pnpm docs:export-api`) and committed — an API surface `/api/docs` does not know about is not a shipped API surface. Note the `openapi-fresh` CI job regenerates and diffs, so unregistered routes produce **no drift and a green check**; the gap is silent and has to be closed deliberately.

### Who sees which rooms

- **The local human sees every room.** This is a single-player cockpit; "membership-scoped" in ADR 260726-170125 describes the model, not an authorization rule against the person running the machine.
- **An agent sees only rooms it is a member of.** That boundary is real today — an agent enumerating the operator's DMs with other agents is an information leak, and it costs one join to prevent.
- **`unreadCount` is only meaningful for a room you are a member of.** Derive it from the membership cursor or omit it. Never return the room's full entry count for a non-member, which is what a missing join silently produces.

Real per-account scoping arrives with accounts.

### Who the author of a request is

**Resolved server-side, never from the request body.** An agent-token-bearing request is that agent; otherwise it is the local human. A body-supplied `authorId` is ignored, and there must be a test asserting that. Without this rule any caller could post as anyone, which in a shared room is impersonation rather than a data-integrity nit.

### SSE

`GET /api/rooms/:id/events` — same three-part contract as the session stream (`apps/server/src/routes/session-events-handler.ts:94-254` is the reference): snapshot on cold connect, gap-free replay from `Last-Event-ID`, then live. Cursor format `<roomId>-<epoch>-<seq>`, validated against the process `STREAM_EPOCH` exactly as `parseResumeCursor` does (`:64-83`), so a cursor minted by a dead process is rejected rather than silently mis-replayed.

Room lifecycle events fan out on the existing global `GET /api/events` under five names: `room_created`, `room_updated`, `room_member_added`, `room_member_removed`, `room_activity`.

**Two streams, two jobs — and broadcasting is only half of each.** A name the server broadcasts but the client does not list in `GENERIC_EVENTS` (`apps/client/src/layers/shared/lib/transport/stream-manager.ts`) is dispatched nowhere and dropped with no error. R1 shipped the broadcasts without the allowlist entries and the events went nowhere until `6516c0234` (#509) fixed it. **A new global event name is not done until it appears in both places**, and `sse-event-allowlist.test.ts` is the guard that proves it. Keep the names string literals — that guard reads raw source and cannot see a name built at runtime.

The division of labour, which is easy to get backwards:

| Stream                      | Carries                                                                                 | Consumer                                       |
| --------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `GET /api/rooms/:id/events` | a room's **entries** — snapshot, `Last-Event-ID` replay, live, per-room monotonic `seq` | the open room's message list (`useRoomStream`) |
| `GET /api/events`           | the five **signals** above                                                              | the sidebar's room list                        |

The global names exist for a reader **not** currently connected to a room: the list changing, and an activity bump that reorders it and marks it unread. Do not drive an open room's message list from global events, and do not drive the sidebar from a per-room subscription. The precedent to mirror is the global session-stream bridge that keeps `['sessions','recent']` fresh (ADR-0265).

**Ephemeral signals never enter the room log.** Typing, presence, read receipts, delivery receipts, progress and backpressure are delivered live and dropped on replay. They reuse `SignalTypeSchema` (`packages/shared/src/relay-envelope-schemas.ts:21`) rather than declaring new names.

---

## 5. Addressing — who answers

On a committed `post` entry by author `A` in room `R`, for each agent member `M` of `R` where `M.authorId !== A.authorId`:

| `M.responseMode` | Triggered when                                      |
| ---------------- | --------------------------------------------------- |
| `silent`         | never                                               |
| `mention-only`   | `M.authorId ∈ entry.mentions`                       |
| `direct-only`    | `R.kind === 'dm'`, or `M.authorId ∈ entry.mentions` |
| `always`         | always                                              |

**Amended 2026-08-13 (DOR-1208): outside a channel, the table above is gated by who WROTE the entry.** When `R.kind !== 'channel'` and `A` is not a person, the only members triggered are those in `entry.mentions` — every row of the table collapses to the `mention-only` row for that entry, `always` and `direct-only` included. A person's message is unchanged, in every kind of room, and a channel is unchanged for every author.

The reason is that this table was written when a DM held exactly one agent. A DM needs no `@`, which is why `direct-only` fires on everything in one and why the DM seed is the agent's `always` manifest default — and that is a claim about a person talking to their agents. Group DMs (§12.3) made it false: with every member on `always`, one message from a person cost four turns and two apology notices while two agents answered each other. See ADR `260814-025326`, which also relaxes the roster rule that had kept two agents out of one room in the first place. The gate is spelled `R.kind !== 'channel'` rather than `=== 'dm'`, so a stored kind that is neither takes the narrower side.

Then the cascade guard (§6) may veto. Survivors are triggered on their `room_sessions` row, creating the session if absent. **That binding is first-write-wins**, which is what makes an agent's per-room context survive across messages rather than starting fresh each time.

**What the agent says becomes a post.** This is the feature, and the spec previously stopped short of saying it. The agent's turn is run through the normal `triggerTurn` path — so it is a visible session turn, not invisible work — and its reply is written back as a `post` entry authored by that agent, **carrying the triggering entry's provenance** (`cascadeRoot`, and `cascadeDepth + 1`). The cascade guard reads exactly that provenance, so a reply that does not carry it is a reply the guard cannot see.

Addressing three agents and getting three answers is the intended outcome, not a pathology. `responseMode` exists to stop agents answering when they were **not** addressed; it makes no attempt to order or serialise the ones who were.

### Mentions

`mentions.ts` parses `@name` at post time against the room's roster (agent name, then author `displayName`), resolves to `authorId[]`, and stores the resolved list on the entry. Resolution happens once, at write; the client renders from the stored list and never re-parses. An unresolvable `@name` stays plain text.

---

## 6. Cascade guard

Per ADR 260726-170127. The relay's budget envelope does not reach here — `enforceBudget` has exactly two call sites, both inside `packages/relay`, and nothing in `services/session` constructs an envelope.

Before triggering author `X` from entry `E`:

1. `depth = E.cascadeDepth + 1`. Refuse if `depth > maxAgentDepth` (config, default **3**).
2. Refuse if `X` appears among `SELECT DISTINCT author_id FROM room_entries WHERE room_id = ? AND cascade_root = E.cascadeRoot`.

A post by a **human** author always starts a fresh cascade: `cascadeRoot = <own id>`, `cascadeDepth = 0`. A human can therefore always re-engage a room the guard has stopped.

A refusal writes a `notice` entry into the room. The copy is the room's voice, not a stack trace, and follows `writing-for-humans`:

> Ana stopped replying here — this back-and-forth hit its automatic-reply limit. Send a message to pick it back up.

A silently dropped trigger is indistinguishable from a broken agent, and in a shared room the person who notices is not the person who configured it.

**One notice per agent per cascade, not per refusal.** Three `always` agents in a channel produce three refusals for one human message under the obvious reading, and a room that answers a question with six apology lines is worse than one that quietly stops. A later cascade may legitimately notice again.

**Depth and ancestry are not peers, and the ordering matters.** Ancestry is the rule that actually bounds ping-pong: it fires the moment an author would repeat inside one cascade. Depth only ever fires for a chain of _distinct_ agents, or when `maxAgentDepth` is 0. Treating them as two equivalent limits — as an earlier draft of this section did — invites tuning the one that almost never fires. ADR 260726-170127 states this correctly; this section did not.

---

## 7. Client

FSD layers apply without exception: `shared ← entities ← features ← widgets`, barrel imports only.

### `entities/room/`

`model/` — `useRooms()` (query key `['rooms']`), `useRoom(id)`, `useRoomEntries(id)`, `usePostToRoom()`, `useRoomStream(id)` bridging SSE into the query cache the way the session stream already does. All data access goes through the `Transport` interface (`packages/shared/src/transport.ts`) — **never raw `fetch`**.

Both implementations must gain the methods. `DirectTransport` composes factory return types via declaration merging (`direct-transport.ts:37-44`), which structurally checks each factory against `Transport` at compile time — so a missing method is a **type error in the factory file**, not a runtime surprise. Because rooms are out of scope for the Obsidian embed in v1 (§9), the room methods belong in `direct/stub-methods.ts` alongside the other server-only subsystems, not in a real in-process implementation.

`ui/` — `RoomAvatar`, `RoomTitle`, `MemberList`.

### Sidebar

Two new sections in `apps/client/src/layers/features/dashboard-sidebar/`, composed directly into `DashboardSidebar.tsx` (around line 465, beside `RecentSessionsSection` and `PinnedSection`).

`sidebar-contributions.ts` is **not** the mechanism — it is a footer-button registry (`SIDEBAR_FOOTER_BUTTONS`). Nor is the `sidebar.body` slot, which is a route-scoped whole-body takeover and would replace the agent roster rather than sit beside it.

- `ChannelsSection.tsx` — collapsible `SidebarGroup`, `#`-prefixed rows, unread badge, "New channel" affordance. Mirrors `RecentSessionsSection.tsx:79-95` for the collapse header.
- `DirectMessagesSection.tsx` — same shape, avatar rows, "New message" affordance.

Collapse state: two new booleans on `SidebarPrefsSchema` (`packages/shared/src/config-schema.ts:250-267`), `channelsCollapsed` and `dmsCollapsed`, with matching setters in `use-sidebar-prefs.ts`. **Follow the `adding-config-fields` skill** — a config schema change without a semver-keyed migration is a review-blocking finding.

`EmbedSidebar.tsx` is a **separate component with no shared roster abstraction**. Rooms do not appear in the Obsidian embed in v1; that is a deliberate scope call, and the embed must not regress.

### Route

```ts
const channelsRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/channels',
  component: ChannelsPage,
  validateSearch: zodValidator(channelsSearchSchema), // { id?: string }
});
```

Room identity travels as a **search param**, matching how `/session` carries `?session=` rather than a path param (`router.tsx:71-79`). Discord does the same thing for DMs, so `/channels?id=<dmId>` is precedented rather than odd.

### Room view

`widgets/room-view/` composes the existing chat message list unchanged. Phase 1 already renders authors, grouping, day and unread separators; a room is simply the first place that list has more than two participants. Header shows title, topic and member avatars. The composer posts to `/api/rooms/:id/entries`.

The unread divider now reads `lastReadSeq` from the membership rather than `localStorage` — this is what resolves D4 of `multi-participant-message-list` from "client-local for phase 1" to the real cursor.

### Author rendering

`resolve-message-author.ts` keeps deriving a **view model** for session chat. Room entries arrive with a persisted `authorId` and are rendered from the room's roster. **Do not persist the view model, and do not feed `ctx.agent.id` into a room column** — that is the exact bug ADR 260726-170126 exists to prevent.

---

## 8. The Integration rename

Mechanical, independently shippable, and it must land before the sidebar section does — two "Channels" in one product, one of them a badge inside the sidebar, is a UX defect on its own.

**"Channel" is a conversation. Relay's external adapters are "Integrations". "Connection" is left alone and keeps meaning network connectivity.** See ADR 260726-193526, which supersedes ADR-0224.

The first attempt at this used "Connection" and was wrong — ADR-0224 had already flagged that collision, and it is real: `ConnectionStatusBanner`, `ConnectionItem` ("Connection lost"), `use-sse-connection.ts`, `SessionInspector`'s "Connection" row, `status-bar-registry.ts:374` and `TestStep.tsx`'s "Connection successful/failed" all mean _is the socket up_. The status bar is always visible, so "Connection lost" beside a "Connections" tab would read as a dropped Telegram integration. Leave every one of those alone.

"Integration" is what `docs/integrations/building-relay-adapters.mdx` has been calling this all along.

| File                                                                                                               | Change                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `features/settings/ui/ChannelsTab.tsx` + `SettingsDialog.tsx:36`                                                   | Tab label → `Integrations`; `ChannelSettingRow` → `IntegrationSettingRow`                                               |
| `features/agent-settings/ui/ChannelsTab.tsx`, `ChannelPicker.tsx`, `BoundChannelRow.tsx`, `ChannelBindingCard.tsx` | Copy and component names → Integration                                                                                  |
| `features/agent-hub/ui/tabs/ConfigTab.tsx`                                                                         | The real "Channels" accordion title                                                                                     |
| `features/agent-hub/ui/tabs/ToolsTab.tsx`, `tool-inventory.ts`, `mcp-tool-groups.ts`                               | The "External Channels" tool group                                                                                      |
| `entities/binding/ui/BindingDialog.tsx`                                                                            | The "Connect Channel" dialog. **Keep** its "Channel Type" label — that is `ChannelTypeSchema`, the remote surface kind  |
| `features/relay/ui/ConnectionsTab.tsx`, `RelayEmptyState.tsx:70`, `RelayPanel.tsx:68`                              | → `IntegrationsTab`; body copy "Active Channels" / "Add Channel". Watch for a filename clash — this file already exists |
| `features/mesh/ui/BindingEdge.tsx:37-41`, `TopologyGraph.tsx`, `AdapterNode.tsx`                                   | Graph labels                                                                                                            |
| `features/dashboard-status/lib/subsystem-copy.ts:34-42`                                                            | "No channels connected yet"                                                                                             |
| `shared/lib/shortcuts.ts:84`, `palette-contributions.ts`                                                           | Shortcut and command-palette labels                                                                                     |
| Tour anchors, tour definitions, DorkBot copy                                                                       | Onboarding prose                                                                                                        |
| `entities/session/config/origin-descriptors.ts:28`                                                                 | `channel: { label: 'Channel' }` → `'Integration'`                                                                       |
| `apps/server/.../sessions/classify-origin.ts:72`                                                                   | The generic `originLabel: 'Channel'` fallback. Server-side, but user-facing                                             |
| `docs/concepts/relay.mdx`, `docs/guides/relay-messaging.mdx`, `docs/integrations/building-relay-adapters.mdx`      | Prose                                                                                                                   |

**Wire data does not change.** The `origin` value `'channel'`, `ChannelTypeSchema`, `channelType`, and every adapter payload stay exactly as they are — `ChannelTypeSchema`'s `'channel'` names the remote surface kind inside Slack or Discord, which is their word for their thing. Nor does telemetry's "Tier 1 channel" prose in `config-schema.ts`. Generated `openapi.json` and shipped changelog entries are excluded.

No database, API, or config migration is involved: no column is named channel, and the settings tab id `'channels'` is a runtime union in `app-store-panels.ts:21`, not persisted.

Run the REVIEW.md dangling-reference sweep over `docs/`, `contributing/` and `*.md`.

---

## 8.5 Sessions and DMs overlap — RESOLVED in §14.4

**Settled 2026-07-27.** The operator asked for the distinction to be articulated and documented; §14.4 is the answer and this section is kept for the reasoning that led there.

The short form: **a session is about a directory, a DM is about who you are talking to, and a channel is about what you are talking about.** All three stay. The outcome this section warned against — shipping all three permanently _without deciding_ — is avoided by writing the distinction down, not by removing one of them.

The original text follows.

---

After R2 the sidebar reads: Recent (sessions) → Channels → Direct messages → Pinned → agent groups → Agents. So a DM with Ana and a session with Ana both exist, and both read as "my conversation with Ana." Two lists meaning nearly the same thing is the duplication that should be removed rather than shipped.

The distinction that survives scrutiny is:

> **A session is about a directory. A DM is about a participant.**

A session is bound to a working tree — "work with Ana on `~/projects/api`". A DM has no tree of its own; Ana works wherever Ana lives, via her workspace binding.

**Recommendation:** make that distinction deliberate rather than accidental. **Channels and DMs are where you talk; sessions are where work happens against a specific tree; promotion is the bridge** — the same "make this a branch" escalation threads already have in A′-policy. Over time Recent stops meaning "conversations" and starts meaning "work in progress."

**The alternative** is that a DM turns out to be just "a session where you didn't have to pick a directory," in which case the two should converge and one should go.

Nothing could post in a room before R3, so there was no evidence to decide on. There is now. **The outcome to avoid is shipping both permanently without deciding, which is what happens by default.**

---

## 9. Explicitly out of scope

- **Room-workspace cwd resolution.** `rooms.workspaceId` is stored and returned; how it composes with the `agent-workspace-binding` precedence chain belongs to that spec.
- **Reactions.** Phase 2 of `multi-participant-message-list`, unblocked by the author key here.
- **A′-mechanism**, the resource-keyed write lock. Not thread-gated.
- **Signing.** Field reserved, `canonicalizeEntry` written and tested, nothing signs.
- **Accounts.** One local human author until they land.
- **Rooms in the Obsidian embed.**

---

## 10. Phasing

| Phase             | Deliverable                                                                                          | Depends on |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ---------- |
| **R0** (DOR-523)  | The Integration rename (§8)                                                                          | —          |
| **R1** (DOR-524)  | Shared schemas, five tables + migration, rooms service, REST + SSE, tests                            | —          |
| **R2** (DOR-525)  | `entities/room`, Transport methods, sidebar sections, `/channels` route, room view rendering history | R1         |
| **R3a** (DOR-526) | Addressing, mentions, triggering agents, cascade guard, turn budget                                  | R2         |
| **R3b** (DOR-569) | Composer, stream reconnect, at-bottom scroll guard (§12.1)                                           | R3a        |
| **R5** (DOR-570)  | Rooms use the agent avatars agents already have (§12.2)                                              | R2         |
| **R6a** (DOR-571) | Group DMs, server-side dedupe on the member set (§12.3)                                              | R5         |
| **R6b** (DOR-572) | Sidebar context menus, add/remove members, archive (§12.4)                                           | R6a        |
| **R4** (DOR-527)  | Threads: child rooms, summary rows, `conversation_context` digest                                    | R3b        |
| **R7** (DOR-565)  | User-facing docs — a concepts page and a coverage row                                                | R6b        |

R0 and R1 are independent and run in parallel; so are R3b and R5. Each phase is one PR, in its own worktree, reviewed by a separate agent against `REVIEW.md`.

R5, R6a and R6b were not in the original plan. They came out of operator feedback on the shipped R2+R3a surface — see §12, which is the record of what that feedback found and what was decided about it.

## 11. Testing

- Server: `FakeAgentRuntime` and scenarios from `@dorkos/test-utils`; SSE via `collectDurableEvents`.
- **Cascade guard needs a test that actually cascades** — two `always` agents in one room, asserting the run terminates, a `notice` lands, and the ancestry rule fires before the depth ceiling. The guard's absence is invisible except under a cascade.
- `seq` allocation needs a concurrent-insert test; the in-transaction `MAX(seq)+1` is the load-bearing claim.
- `canonicalizeEntry` needs byte-exact fixtures.
- Client: React Testing Library with a mock `Transport` via `TransportProvider`.
- The sidebar sections need **browser** verification, not just jsdom — menu-to-editor focus races in this repo are invisible to jsdom.

---

## 12. What using it found

R2 and R3a shipped, and the operator used them. Five things came back. None was a bug in what was built; four were things the plan had never covered, and one was a design mistake made in R2 and inherited since. This section records what each one is and what was decided, so the reasoning survives the phase that implements it.

### 12.1 You could not post (R3b, DOR-569)

`ChannelsPage.tsx:107` reads "You can read this room, but not post to it yet." It is prose, not a permission check: `POST /api/rooms/:id/entries` has worked since R3a. The composer was simply the half of R3 that was cut when the phase split. **No permission concept is being introduced** — a reader who sees that line has every right to post and always did.

Two things ship with it, both of which have to land before the composer rather than after:

- **The stream reconnects.** `use-room-stream.ts` is one bare `for await` that never re-subscribes; the code says so in its own comment. That was tolerable while nothing could post. It stops being tolerable the moment somebody can, because a dropped socket is then a lost message rather than a stale read.

  The retry loop goes **in the hook, around `transport.subscribeRoom`** — not in `SSEConnection`. `SSEConnection` speaks HTTP directly and is not reachable through the Transport port, so binding the room stream to it would leave the Obsidian embed with no room stream at all. `session-stream-methods.ts` and `transport-stream-pump.ts` already draw exactly this line: Transport methods are contract-level with no reconnection, and resilience sits above them.

- **The scroll guard.** `ChannelsPage.tsx:48-54` scrolls to the bottom on every arrival unconditionally. Reading history while an agent replies yanks the reader away from what they were reading. `features/chat/model/view/use-scroll-overlay.ts` already solves this; the room view has no virtualizer, so none of chat's measurement machinery comes with it.

### 12.2 Rooms invented a second avatar for agents that already had one (R5, DOR-570)

Agents carry an emoji and a colour. Rooms draw a hashed letter disc instead (`RoomAvatar`, `MemberList`, both via `authorColor(id)` + `initialOf(name)`), so the same agent reads as a coloured emoji in the agent list and an unrelated pastel letter in the room directly beside it.

The data was never missing. `AuthorRef` carries optional `emoji` and `color`; `toAuthorRef` projects them and `room-roster.ts:221` populates them from the agent record. `MessageAuthorAvatar` already renders them correctly, which is why the room _timeline_ looks right and the sidebar does not.

**Why the duplicate appeared is worth naming, because it will happen again.** The FSD rule forbids `entities/room` importing `entities/agent`, so room UI could not reach `AgentAvatar` at all, and a hashed disc was the path of least resistance. The fix is the one the layer rule was pointing at all along: the presentational disc belongs in `shared/ui` — three modules currently hand-roll the same `color-mix(in oklch, … 18%, transparent)` — and `AgentAvatar` becomes a thin wrapper that adds the health ring.

One data change comes with it. `RoomSummary` carries no members, so the sidebar cannot know who a DM is with; `DirectMessagesSection` works around that with `useRoomRosters`, which is **one `GET /api/rooms/:id` per DM**. Putting the resolved participants on the list payload (batched through `AuthorRegistry.getMany`, not an N+1 on the server) draws the right avatar and deletes the workaround in the same move.

### 12.3 A DM held exactly one agent (R6a, DOR-571)

The server was ready — `CreateRoomRequest.agentPaths` is an array, added in R3a. The picker was not: `NewDirectMessageMenu` is single-select, and it filters out every agent already in a DM.

Slack's shape is a multi-select: typeahead, chips for who is selected, one action to start. One agent gives a 1:1; two or more give a group conversation named from the participants.

**That filter has to go, and taking it out moves a correctness rule.** Excluding agents already in a DM was how duplicate 1:1s were prevented. It is wrong once group DMs exist — Ana alone and Ana + Kai are different conversations — so the guarantee moves to where it can actually be made:

> `POST /rooms` with `kind: 'dm'` returns the **existing** room when a DM with exactly that member set already exists.

Server-side, because it is an idempotency property of the resource rather than a rule about a menu, and because the client would need every roster loaded to evaluate it correctly. Slack behaves the same way: re-opening a conversation with the same people opens the same conversation.

Two details later confirmed against primary sources (`research/20260727_chat-navigation-quick-switcher-patterns.md`). **Chips, not a checkbox list** — Discord uses checkboxes and we have fewer agents than a Discord user has friends, so it is less obviously wrong at our scale than it looks, but chips keep _who is already selected_ visible and ordered, which matters more here because each agent carries its own `responseMode` consequences for the room. And **Teams does not dedupe at all** — it lets you hold several identical chats and tells you to rename them apart. That is a design gap to avoid, not a third option worth weighing.

### 12.4 Channels and DMs had no context menu, and no way to manage membership (R6b, DOR-572)

`POST /:id/members`, `DELETE /:id/members/:authorId` and `PATCH /:id/members/:authorId` have existed since R1 and nothing in the cockpit calls them. Agent rows have had a right-click menu since well before rooms shipped; room rows have none.

Both menus are built from **one pure node list**, the way `AgentRowMenuItems.tsx` already does it — `buildRowMenuNodes(model)` renders into the right-click `ContextMenu` and the "…" `DropdownMenu` through the same walk, so a hand-copied second list cannot drift out of step.

|                                   | Channel | DM       |
| --------------------------------- | ------- | -------- |
| Mark as read _(only when unread)_ | ✓       | ✓        |
| Mute / Unmute                     | ✓       | ✓        |
| Add agents…                       | ✓       | ✓        |
| Members…                          | ✓       | ✓        |
| Agent profile                     | —       | 1:1 only |
| Rename…                           | ✓       | ✓        |
| Edit topic…                       | ✓       | —        |
| Archive                           | ✓       | ✓        |

Four calls in there are decisions rather than defaults:

- **Adding an agent to a DM happens in place**, and the menu item says the agent will see the conversation's history. Slack forks a new conversation instead. Its reason is privacy between people who do not own each other's accounts, which does not apply when every participant is one of your own agents — and forking would strand the conversation you were in the middle of.
- **No "Leave".** With a single human author, leaving a room you created makes it invisible with no route back. Archive is the honest verb for that intent, and it is reversible.
- **No "Pin".** Rooms sort by recent activity and there are few of them. Pinning earns its place when the list is long enough to lose something in; adding it now would double the preference surface to solve a problem nobody has yet. Deliberate omission.
- **Mute stays in**, despite costing a semver-keyed config migration, because a channel holding two `always`-mode agents will be noisy by construction and mute is what makes that survivable. This is the one item justified by the cascade behaviour rather than by Slack.

The members panel is where `responseMode` finally becomes reachable. It is a per-room override the schema has carried since R1 (`RoomMemberSchema`) with no UI anywhere — so today an agent's behaviour in a room is fixed at join time and cannot be changed without editing the database.

---

## 13. What looking at it found

Everything above was reasoned from source. This section is what a browser showed, plus the navigation design that follows from it. Screenshots taken against `main@3dffe652b` at 1440×900 with two seeded channels.

### 13.1 Four defects that reading could not find

- **Every channel renders its `#` twice.** `RoomAvatar` draws a lucide `Hash` glyph and `roomDisplayTitle` returns `` `#${slug}` ``, so a sidebar row reads `# #general` and so does the room header. Nothing asserts it; both halves are individually correct. The fix is not to strip the prefix from `roomDisplayTitle` — that string is also the tooltip, the `aria-label` and what a toast says, where `#general` is the right form. `RoomTitle` should render the bare name wherever a mark sits beside it, and every text-only caller keeps the prefixed form.

- **The empty room instructs an action that has no affordance.** It says "Add the agents you want in this conversation, and everything they say will stay here." There is no way to add an agent to a room anywhere in the product (§12.4). The copy is right about the intent and wrong about the present tense; R6b is what makes it true. Until then the empty state is a promise the UI cannot keep.

- **The document title ignores rooms entirely.** On `/channels` it reads `🐧 apps — DorkOS` — the _session's_ working directory. `use-document-title.ts` is keyed on `cwd` and returns the bare `'DorkOS'` when there is none, so a room you are actually reading never appears, and a backgrounded tab cannot tell you a room has activity. The machinery is already there: `buildTitle` takes a `tasksBadgeCount` rendered as `(N)` while hidden. Unread rooms belong in the same place.

- **Channels sort by recency.** `room-store.ts:99` orders every kind by `lastActivityAt DESC`, so a quiet channel sinks and the list reorders under you. That is right for DMs and wrong for channels: Slack sorts channels alphabetically precisely so the list stops moving and you learn where things are. Sort DMs by recency, channels by name.

### 13.2 Rooms in the command palette

The palette (`features/command-palette/`) has fuzzy search, frecency, preview panels and prefix scoping — `@` for agents, `>` for commands. **Rooms are absent from all of it.** A channel is reachable only by finding it in the sidebar with a mouse.

**Add `#` for rooms.** Slack and Discord both use it and it is the closest thing to universal muscle memory in this product category. (Threads read as `#parent › thread title` here because a thread was a child room at the time; under ADR 260728-022013 a thread is never a row in this list at all.)

**DMs stay under `@`, not `#`.** This is not arbitrary: a channel is addressed by its name, a DM by who is in it. Typing `@ana` should offer _both_ "Message Ana" and "New session with Ana" — the same distinction §8.5 already draws between a session (about a directory) and a DM (about a participant). It is also where DorkOS diverges from every chat app: the entity you navigate to is also an actor you can dispatch work to, so the agent's palette row wants verbs, not just a destination.

**Unread first in the zero-query state.** Rooms already carry `unreadCount`. Ranking unread above frecency turns `Cmd+K → Enter` into "go to the thing that needs me", which is what a mission-control surface should do and what a generic launcher does not. This is the single highest-value item in this section.

**Contextual actions come from R6b's node list, not a second list.** When a room is open, the palette offers that room's actions — the _same_ pure `buildRoomRowMenuNodes(model)` that feeds the right-click menu and the `…` dropdown. Three surfaces, one model. Palettes drifting out of step with their equivalent right-click menus is the standard failure here, and `AgentRowMenuItems.tsx` already proves the pattern in this codebase.

**Explicitly out of scope: message search.** Slack keeps navigation (`Cmd+K`) and message search (`Cmd+F`) as separate surfaces, and Teams' merged command bar is the cautionary example. We have no message index, and building one to satisfy a palette would be the tail wagging the dog. **[Amended 2026-07-28 (DOR-672) — see Amendment 1 at the end of this document: one of this paragraph's two arguments expires, the conclusion does not.]**

### 13.3 Unread, reachable without the mouse

Unread is currently visible in exactly one place — a badge on a sidebar row — which means it is invisible whenever the sidebar is collapsed or the tab is backgrounded. That is the wrong shape for a product whose whole premise is that agents work while you are not looking.

- Unread count in the document title, reusing `buildTitle`'s existing badge slot. Research confirms a leading `(N)` in the title plus a numbered favicon is the actual cross-industry convention, not something we would be inventing.
- **`Esc` marks this room read; `Shift+Esc` marks everything read.** Slack and Teams converged on this independently, it is mnemonically sound, and nothing in `SHORTCUTS` conflicts.
- Next / previous unread room on `alt+↑` / `alt+↓`, both free.

  **A correction to an earlier draft of this section, which claimed Slack and Discord both bind this.** They do not. Step-through is **Discord's** pattern and it is the minority one: Slack and Teams deliberately chose a filtered _view_ of all unreads instead. We are taking the minority pattern on purpose — a filtered view earns its place at enterprise scale with a hundred channels, and DorkOS has a handful of rooms with one human reading them. Worth knowing it is a scale judgment rather than an industry default, because the right answer flips if a room list ever gets long.

- `mod+shift+k` for a new direct message, matching Slack. Also free.

Sources and the full comparison: `research/20260727_chat-navigation-quick-switcher-patterns.md`.

### 13.4 Phasing

| Phase   | Deliverable                                                                                                                                                           | Depends on |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **R6c** | The four §13.1 defects                                                                                                                                                | R3b, R5    |
| **R9**  | `#` prefix, rooms searchable, unread-first zero-query, `@agent` verbs, new-channel / new-DM actions, prefix legend in the empty state, title badge, unread navigation | R6a, R6b   |

R9 lands after R6b so the contextual actions consume the node list rather than duplicating it. R6c is independent of both and only waits on the two PRs currently touching the same files.

---

## 14. The second operator round

Everything above §13 came from building or from looking. This came from **using it for an afternoon**. Five asks, one of which was already shipped, and four cross-cutting UI/UX principles that apply beyond rooms.

### 14.1 Everything in the sidebar gets a context menu — including the headers

> "I think EVERYTHING in the sidebar should have a context menu. This includes, but is not limited to channels, dms, and all headers."

R6b (DOR-572) covers channel and DM rows. This widens it to **section headers** and to every other row type the sidebar carries.

The constraint that makes this tractable is the one already chosen: `AgentRowMenuItems.tsx` builds one pure node list and renders it into both the right-click `ContextMenu` and the `…` `DropdownMenu`. Every new menu follows that shape. **Consistency is the deliverable, not the menus** — the same verb must mean the same thing and sit in the same position everywhere it appears.

| Surface                      | Items                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------- |
| **Channels header**          | New channel… · Mark all channels read · Collapse / Expand · Sort ▸            |
| **Direct messages header**   | New message… · Mark all read · Collapse / Expand                              |
| **Agents header**            | New agent… · New group… · Sort ▸ · Display ▸ (all / active / needs attention) |
| **Group header**             | already has one — audit it first and align the others to it                   |
| **Recent (sessions) header** | New session… · Collapse / Expand                                              |

Audit the existing agent-row and group-header menus **before** writing new ones, and reconcile: where a verb exists, reuse its exact label and position; where a new verb is genuinely new, put it in the same relative slot across every menu that has it. Mismatched labels for the same action across two menus is the failure this section exists to prevent.

`Sort ▸` and `Display ▸` already exist as per-section state (`ungroupedSortMode`, `ungroupedDisplayFilter`, per-group `sortMode`/`displayFilter`) with **no menu affordance** — the header menu is where they become reachable.

### 14.2 Adding agents belongs in the channel-creation flow

> "I can't figure out how to add agents to channels… The fact that I can't figure it out means the UI/UX could be better. I'll ALWAYS want to add someone to a channel, so this should be part of the flow that we use to create channels."

This is the sharpest finding of the round, and the empty state already admits it: a new channel says _"Add the agents you want in this conversation"_ and **no affordance to do so exists anywhere in the product**. `ChannelCreateInput` takes a name and nothing else, so every channel is born empty and stays empty.

**A channel with no agents in it does nothing.** Creation must therefore include membership, not offer it afterwards:

- The create flow takes a name **and** an agent selection, in one pass. Reuse R6a's chip picker — it already does typeahead, chips, keyboard selection and a commit action, and reusing it makes the two flows feel like one product rather than two features.
- Creating with nobody selected stays possible, but it is the deliberate path, not the default one.
- **§14.3 covers adding afterwards**, which is a different need with a different surface.

The inline sidebar input cannot hold a picker at usable width. This is the concrete case for §14.5's responsive modal.

### 14.3 Adding agents afterwards

> "I should also be able to add agents to channels anytime afterwards."

Three entry points, all reaching one shared surface — the members panel from R6b:

1. **"Add agents…"** in the row context menu (§14.1).
2. **The room header's member list**, which today renders avatars and is not interactive. It is the obvious place to click and currently the most disappointing.
3. **The empty state's own copy**, which promises this and should be the button that does it.

The panel is also where per-member **remove** and the per-room `responseMode` override become reachable — a field the schema has carried since R1 that no UI has ever touched, so an agent's behaviour in a room is currently fixed at join time and changeable only by editing the database.

### 14.4 What a channel, a DM and a session actually are

> "Think through what the real difference is between channels, DMs, and chatting with an agent session directly, and let's articulate and document that distinction."

This **resolves §8.5**, which recorded it as an open decision awaiting evidence. The evidence is now in: all three exist, and the distinction that survives contact is about **what the conversation is anchored to**.

|             | Anchored to        | Holds                                  | Ends when                     |
| ----------- | ------------------ | -------------------------------------- | ----------------------------- |
| **Session** | a **working tree** | one agent, one runtime                 | the work does                 |
| **DM**      | a **participant**  | one or more agents, no tree of its own | never — it is a standing line |
| **Channel** | a **topic**        | any number of agents, by name          | you archive it                |

The one-liner, which belongs in the docs verbatim: **a session is about a directory, a DM is about who you are talking to, and a channel is about what you are talking about.**

Consequences worth stating, because they are what make the distinction real rather than decorative:

- A session **binds to a runtime at first write** (ADR-0255), so it can never be multiplexed across agents. A room holds several agents precisely because it is _not_ a session — three agents in a room are three sessions on one stream (ADR 260726-170125).
- A DM has no `cwd`. Ask an agent to do work in a DM and it works wherever that agent lives, via its workspace binding — which is why "promote this to a session" is the bridge, not a synonym.
- A channel is the only one with a **name people type**. That is why it has a slug and the others do not.

**Where this goes:** R7 (DOR-565) is the user-facing docs page, and this table is its spine. §8.5's "outcome to avoid" — shipping all three permanently without deciding — is avoided by writing this down, not by removing one of them.

### 14.5 Four cross-cutting principles

These apply beyond rooms and should be treated as standing guidance for this surface.

**Popovers do not work on mobile.** The DM picker is a `Popover` anchored to a sidebar button; on a phone the sidebar is a drawer that must close for the popover to be visible. Use the responsive modal (`shared/ui`) for anything that is a _task_ rather than a _glance_. The channel-create picker in §14.2 lands here too.

**Reach it from the command palette, and deep-link into it.** Anything worth a menu item is worth a palette entry — the palette is the only surface that works identically on every viewport and with no pointer. §13.2 already specifies `#` for rooms and the contextual-action model; this extends it: **new channel, new DM, add agents, and members should all be palette-reachable and openable by URL**, so an agent can hand a person a link that opens the right panel.

**Slash commands in rooms.** Sessions have them; rooms do not. A person who types `/` in a chat box expects something and today gets nothing. **Designed in §15** (DOR-603).

**Use the visual companion.** UI/UX work on this surface should go through the `visual-companion` skill rather than being assessed from source. Two defects this programme shipped — a channel rendering `# #general`, and DM rows showing letters where agent faces belong — were invisible to every test and obvious in a screenshot.

## 15. Slash commands in rooms (DOR-603)

§14.5 recorded this as a gap "recorded rather than designed." This designs it. The
answer falls out of §14.4 without needing new invention: **a slash command needs
whatever the thing it acts on is anchored to.**

### 15.1 There are two kinds, and they are different in kind

|                    | Acts on  | Needs a working tree | Where it works                   |
| ------------------ | -------- | -------------------- | -------------------------------- |
| **Room commands**  | the room | no                   | every room                       |
| **Agent commands** | an agent | yes                  | wherever an agent is unambiguous |

**Room commands** — `/add`, `/remove`, `/topic`, `/rename`, `/archive` — change the
room itself. A room is anchored to a participant or a topic, never to a directory,
so these need no tree and always work.

**Agent commands** are the ones a session already has: plugin commands and skills
like `/flow:specify`. These need a tree. §14.4: **a DM has no `cwd`.** So a room
can never run one _itself_ — it resolves the command **through an agent**, which
does have a workspace binding, and the command runs there.

That gives the rule, and it is not a compromise — it is the only thing §14.4
permits:

- **In a 1:1 DM the agent is unambiguous**, so agent commands just work. They run
  in that agent's own workspace. This is the single most useful case and it needs
  no extra syntax.
- **In a group DM or a channel the agent is ambiguous**, so an agent command
  requires an address: `@kai /flow:specify`. Typing a bare agent command in a
  multi-agent room is not an error to punish — the composer asks which agent, the
  same way §14.1's menus ask before doing something irreversible.

### 15.2 The human is always in the room

Slack's `/join` and `/leave` have no counterpart here, and copying them would be
mimicry rather than design. In DorkOS the operator is not a member of a room —
they _are_ the room's other side. **Membership is about agents.** Every membership
verb therefore takes an agent, and there is no verb for the person.

This is worth stating because it is the point where the Slack analogy stops
paying, and it retires a whole class of features nobody needs.

### 15.3 One model, three renderers

The room verbs are exactly R6b's context-menu items (§14.1) and exactly §14.5's
palette entries. **They must be one list, not three.**

This repo already has the pattern: `AgentRowMenuItems.tsx` builds one pure
`buildRowMenuNodes(model)` and renders it into both a ContextMenu and a
DropdownMenu through a single walk. Extend that to a third renderer rather than
authoring a parallel slash-command table. The invariant to hold, and the reason
this matters more than it looks:

> **Every room command has a menu equivalent, and every menu item has a command.
> A capability that exists in only one of the three is a bug in whichever two are
> missing it.**

Without this, the three lists drift within one release — the menu grows an item,
the palette does not, and the slash command silently does the old thing.

### 15.4 The failure everyone ships

An unrecognized `/foo` must **never** be silently swallowed, and must never be
silently sent as chat text either. Both are the same defect wearing different
clothes: the person's intent was a command and the system pretended otherwise.

Unrecognized input stays in the composer with the reason visible, before send.
The `/` menu filters as you type, so an unrecognized command is a state the
person can see coming rather than a result they discover afterwards.

Note also that §13.2's palette prefix for rooms is `#`, which is the channel
sigil — `/` in the composer and `#` in the palette are different namespaces and
must not be conflated.

### 15.5 Scope for DOR-603

Ship room commands and the 1:1-DM agent-command path. The addressed form
(`@agent /command`) in multi-agent rooms depends on §5's addressing work and can
follow, provided the bare form in a multi-agent room asks rather than guesses —
**guessing which agent runs a command is the one outcome that is not acceptable**,
because it silently does work in a tree the person did not choose.

Blocked behind R6b (DOR-572), which builds the pure list §15.3 requires.

---

## Amendment 1 — the message index arrives, and §13.2 keeps its conclusion (2026-07-28, DOR-672)

**Amends §13.2's final paragraph — `specs/rooms/02-specification.md:517`, "Explicitly out of scope: message search."** One of that paragraph's two arguments expires; the conclusion does not. The sentence carries two independent supports and they are worth separating, because only one of them is about to stop being true.

The first is a **UX-separation argument**: Slack keeps `Cmd+K` and `Cmd+F` apart, Teams merged them and is the cautionary example. Nothing about an index touches that. It is the load-bearing half and it stands unchanged — **rooms in the palette is navigation, and message search is a different surface**, so R9 is unaffected.

The second is a **cost argument** — "we have no message index" — and `specs/message-search/02-specification.md` (DOR-672) retires it, because it builds one. Note the tense carefully: **the index does not exist yet.** Until DOR-672 ships, the sentence above is true exactly as written, and R9 must not be planned as though an index were available. After it ships, the honest form is: an index exists, this palette still does not search messages, and the reason is now the first argument alone rather than both.

The thing worth carrying forward is that the cost argument was doing more work than it should have been. It made "no message search in the palette" look contingent on an implementation fact, when the decision was really about what a command palette is for. `specs/room-participation/02-specification.md:646` made the same call for a tool and cites this line by number; it has been amended in the same change, and for a different reason — its tool now calls the index rather than scanning, because there is no case for two search paths over the same rows.
