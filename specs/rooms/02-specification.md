# Specification: Rooms — channels, DMs and threads

- **Slug:** rooms
- **Id:** 260726-170533
- **Date:** 2026-07-26
- **Status:** specified
- **Decisions:** ADR 260726-170125 (room model), ADR 260726-170126 (author identity), ADR 260726-170127 (cascade guard)

Read `01-ideation.md` first for what is already settled and must not be re-argued.

---

## 1. Vocabulary

| Term            | Meaning                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Room**        | A membership-scoped durable stream. Three kinds: `channel`, `dm`, `thread`.                                                                                          |
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
kind             text not null         // 'channel' | 'dm' | 'thread'
parentId         text                  // non-null iff kind = 'thread'
slug             text                  // channels only; unique among non-archived channels
title            text not null
topic            text
workspaceId      text                  // optional reference; behavior is out of scope (see §9)
rootEntryId      text                  // threads only: the parent entry this thread hangs off
archived         integer not null default 0
createdAt        text not null
lastActivityAt   text not null
```

Partial unique index on `slug` where `kind = 'channel' AND archived = 0`. Index on `parentId`.

Archived channels are deliberately excluded: a unique index over all channels would let a long-dead `#general` hold that name forever, and "you cannot reuse the name of a channel you archived two years ago" is a bug report waiting to happen.

**A thread is a room with a parent.** One level only: creating a thread whose parent is itself a thread is rejected at the service boundary with a typed error, not silently flattened.

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
| `thread`  | inherit the parent room's membership value                                                                  |

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
  room-service.ts      orchestration: create, join, post, read cursor, thread create
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
| `POST`   | `/api/rooms/:id/members`           | Add a member (agent or human).                                                                       |
| `PATCH`  | `/api/rooms/:id/members/:authorId` | Change `responseMode`.                                                                               |
| `DELETE` | `/api/rooms/:id/members/:authorId` | Remove a member.                                                                                     |
| `PUT`    | `/api/rooms/:id/read-cursor`       | Set `lastReadSeq`.                                                                                   |
| `POST`   | `/api/rooms/:id/threads`           | Open a thread off an entry.                                                                          |

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

Room lifecycle events (created, archived, member added/removed, `lastActivityAt` bumped) fan out on the existing global `GET /api/events`.

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

Then the cascade guard (§6) may veto. Survivors are triggered on their `room_sessions` row, creating the session if absent.

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
  validateSearch: zodValidator(channelsSearchSchema), // { id?: string, thread?: string }
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

## 9. Explicitly out of scope

- **Room-workspace cwd resolution.** `rooms.workspaceId` is stored and returned; how it composes with the `agent-workspace-binding` precedence chain belongs to that spec.
- **Reactions.** Phase 2 of `multi-participant-message-list`, unblocked by the author key here.
- **A′-mechanism**, the resource-keyed write lock. Not thread-gated.
- **Signing.** Field reserved, `canonicalizeEntry` written and tested, nothing signs.
- **Accounts.** One local human author until they land.
- **Rooms in the Obsidian embed.**

---

## 10. Phasing

| Phase            | Deliverable                                                                                          | Depends on |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ---------- |
| **R0** (DOR-523) | The Integration rename (§8)                                                                          | —          |
| **R1** (DOR-524) | Shared schemas, five tables + migration, rooms service, REST + SSE, tests                            | —          |
| **R2** (DOR-525) | `entities/room`, Transport methods, sidebar sections, `/channels` route, room view rendering history | R1         |
| **R3** (DOR-526) | Posting, addressing, mentions, triggering agents, cascade guard, read cursor                         | R2         |
| **R4** (DOR-527) | Threads: child rooms, summary rows, `conversation_context` digest                                    | R3         |

R0 and R1 are independent and run in parallel. Each phase is one PR, in its own worktree, reviewed by a separate agent against `REVIEW.md`.

## 11. Testing

- Server: `FakeAgentRuntime` and scenarios from `@dorkos/test-utils`; SSE via `collectDurableEvents`.
- **Cascade guard needs a test that actually cascades** — two `always` agents in one room, asserting the run terminates, a `notice` lands, and the ancestry rule fires before the depth ceiling. The guard's absence is invisible except under a cascade.
- `seq` allocation needs a concurrent-insert test; the in-transaction `MAX(seq)+1` is the load-bearing claim.
- `canonicalizeEntry` needs byte-exact fixtures.
- Client: React Testing Library with a mock `Transport` via `TransportProvider`.
- The sidebar sections need **browser** verification, not just jsdom — menu-to-editor focus races in this repo are invisible to jsdom.
