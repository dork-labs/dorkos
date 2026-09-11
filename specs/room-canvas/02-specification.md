---
slug: room-canvas
id: 260911-195750
created: 2026-09-11
status: specified
linearIssue: DOR-1995
---

# Canvas and Browser in rooms

**Status:** Draft
**Author:** Claude (Opus, SPECIFY stage; directed by Dorian)
**Date:** 2026-09-11
**Tracker:** DOR-1995 (umbrella) · project "Canvas and Browser in Rooms"
**Ideation:** [`specs/room-canvas/01-ideation.md`](01-ideation.md) — decisions D1–D17, phases P0a–P3
**Research:** [`research/20260911_canvas-browser-in-rooms.md`](../../research/20260911_canvas-browser-in-rooms.md)

Every `file:line` in this document was re-read on `origin/main` @ `4c2f80fc1` (2026-09-11). Where a
line moved since the research report read it at `b115c710a`, this document carries the new number.

---

## Overview

A room gets a **table**: a set of documents the room owns, that every member — person or agent — can
put something on, look at, and point at. It is the same canvas surface a session already has, with
three differences that matter: the state lives on the server instead of in one browser's
`localStorage`, it rides the room's own stream so every viewer sees the same thing, and an agent can
**read** it as well as write to it.

The embedded browser becomes its own right-panel tab on **both** session and room routes, so "a
Canvas tab and a Browser tab, the same way sessions have them" is true on both surfaces rather than
true on neither.

Nothing here wakes anybody. A canvas change reaches other members through three channels that
already exist — the room context block each turn is given, one coalesced entry in the room's log per
turn, and an ordinary `@mention` when an agent actually wants eyes — and through no fourth one.

## Background / Problem Statement

**The capability is already in rooms; the addressing is not.** A room turn is an ordinary session
turn: `room-turn-runner.ts:860` dispatches it through `dispatchMessage`, and
`claude-code/mcp-tools/index.ts:234` registers `control_ui` and `get_ui_state` on **every**
claude-code session, room turns included. An agent in a room can call `open_canvas` today. The
command lands on that agent's private session stream, which the client then drops unless the
operator happens to be looking at that exact session (`stream-manager.ts:1002`:
`if (parsed.data.type === 'ui_command' && sessionId === this.attachedSessionId)`). Nobody in the room
sees anything. The tool returns `{ success: true }` regardless.

**The right panel offers rooms nothing.** `init-extensions.ts` registers seven tabs; Session (`:243`),
Files (`:259`), Canvas (`:276`) and Terminal (`:292`) all carry `visibleWhen: ({ pathname }) =>
pathname === '/session'`, and only Room (`:187`) carries `routeShowsRoom`. Registering the existing
Canvas tab on room routes would not fix it: the session canvas slice is persisted per session in
`localStorage` under `STORAGE_KEYS.CANVAS_SESSIONS` (`constants.ts:9`,
`app-store-helpers.ts:160,211`), so each viewer would see their own private documents and call them
shared.

**Four drifts would be inherited.** The `control_ui` description advertises **6** canvas content
types (`ui-tool-contract.ts:34-40`), the `<ui_tools>` system-prompt block advertises **10**
(`context-builder.ts:364-365`), and `UiCanvasContentSchema` accepts **14**
(`schemas.ts:5017-5162`: `url`, `markdown`, `json`, `image`, `pdf`, `widget`, `mcp_app`, `file`,
`model3d`, `audio`, `video`, `csv`, `browser`, `diff`). `apply_layout` is in the schema
(`schemas.ts:5371`) and in `UI_COMMAND_REACH` (`schemas.ts:5486`) and in neither piece of teaching.
ADR `0292`'s notify-and-reconcile banner never landed — `updateActiveDocument` drops an agent update
with `if (!active || active.editing) return;` (`app-store-canvas.ts:372`) and says nothing. And a
`dorkos-ui` fence in a room message renders as a code block, because the fence renderer is registered
only in `features/chat/ui/message/StreamingText.tsx:61-77` and room bodies go through
`render-room-body.tsx:86-91` → `MarkdownContent` with no such renderer.

## Goals

1. A room owns a set of canvas documents that survive reloads, are identical for every viewer, and
   are deleted with the room.
2. Any agent in a room can put a document on that table with the verbs it already knows
   (`open_canvas`, `update_canvas`, `close_canvas`, `open_file`, `open_diff`, `browser_navigate`) —
   on claude-code, codex and the deterministic test-mode runtime alike — and can name **which**
   document it means, because `update_canvas` and `close_canvas` gain an optional `documentId` and a
   stated default (§5.6).
3. Any agent in a room can **read** the table, on every runtime, without a person relaying it.
4. Other members learn the table changed without anybody's turn being triggered.
5. The Browser is its own right-panel tab on `/session` and on room routes, over the same document
   store, with per-view active documents.
6. A person can put something on the table too — a URL they type, a file they open — as themselves.
7. The four drifts above are fixed before rooms inherit them.

## Non-Goals

Out of scope for this spec; all of it is the follow-on spec `canvas-agent-seat` (D17):

- Browser driving tools (`browser_click`, `browser_type`, `browser_scroll`, `browser_wait_for`,
  `browser_read_page`).
- Per-action GIF recording; `browser_screenshot` posting as a room attachment.
- `get_ui_state` and `browser_*` parity for codex and opencode.
- Migrating the **session** canvas to the server store (`session:<id>` scope) and retiring the
  `localStorage` slice. The session slice is untouched by this spec except for the Browser-tab view
  split.
- Follow mode; document-anchored threads; merge-preview diff with accept-to-merge; CRDT or
  multi-cursor editing; explicit `control_ui.target`.
- Canvas over the `CommunityAdapter` port; structured canvas content across chat bridges.
- Indexing canvas documents in message search (D15).

## Technical Dependencies

No new runtime dependencies. Everything is already in the workspace:

| Dependency                       | Where it is already used                                                        |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `drizzle-orm` + `better-sqlite3` | `packages/db/src/schema/rooms.ts` — the new table joins it                      |
| `zod`                            | `packages/shared/src/room-schemas.ts`, `schemas.ts` — the new schemas join them |
| `@dorkos/shared/transport`       | one new Transport method per client→server call (see Detailed Design §9)        |
| `zustand`                        | the new room-canvas client slice, beside `app-store-canvas.ts`                  |
| `@tanstack/react-query`          | document list hydration, beside `use-room-stream.ts`                            |
| the capability registry          | `services/rooms/room-capabilities.ts` — `read_canvas` registers as a room verb  |

## Detailed Design

### 1. The table: `canvas_documents`

One new Drizzle table in `packages/db/src/schema/rooms.ts`, beside `roomAttachments` (`:825`) and
`roomRepos` (`:946`), following the conventions that file already uses (text primary key, `integer`
timestamps in `{ mode: 'timestamp_ms' }`, a cascade FK to `rooms.id`, named indexes).

```ts
export const canvasDocuments = sqliteTable(
  'canvas_documents',
  {
    /** ULID. Deterministic per (scope, sourceKey) when the content has a source key — see §3.2. */
    id: text('id').primaryKey(),
    /** `room:<roomId>`. `session:<id>` is RESERVED for the follow-on spec and never written here. */
    scope: text('scope').notNull(),
    /** The room this document belongs to. Cascades, so deleting a room deletes its table. */
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    /** The `UiCanvasContent` union, JSON-encoded. Validated with `UiCanvasContentSchema` on read. */
    content: text('content', { mode: 'json' }).notNull(),
    /** Cached `content.title` (or the derived label) so a list does not parse every blob. */
    title: text('title').notNull(),
    /** `content.type` — one of the 14. Indexed: the Browser view is a query on it. */
    contentType: text('content_type').notNull(),
    /** The room author who put it here. A person's author id or an agent's. Never null. */
    authorId: text('author_id').notNull(),
    /** Dedupe key (§3.2), or null for content with no natural identity (`json`, `widget`). */
    sourceKey: text('source_key'),
    /** Human label for where the file came from (§8): "Ana's copy · 3 ahead of main". */
    sourceLabel: text('source_label'),
    /** Absolute directory the document's `sourcePath` was resolved against. Null for non-file docs. */
    resolvedCwd: text('resolved_cwd'),
    /** Pinned documents sort first and are never evicted (§3.3). */
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    /** Monotonic per room. Bumped on every write. Last-write-wins ordering, NOT a stream cursor. */
    rev: integer('rev').notNull(),
    /** Who last opened or updated this document — the per-author default target of §5.6. */
    lastTouchedBy: text('last_touched_by').notNull(),
    /** When they did, ISO 8601. `(room, author)` ordered by this is `lastDocumentFor`. */
    lastTouchedAt: text('last_touched_at').notNull(),
    /** The room author currently holding the edit lock, or null (§3.5). */
    editingBy: text('editing_by'),
    /** When that lock was last refreshed, ISO 8601. Read lazily; a stale lock is simply not a lock. */
    editingHeartbeatAt: text('editing_heartbeat_at'),
    openedAt: text('opened_at').notNull(),
    lastActiveAt: text('last_active_at').notNull(),
  },
  (table) => [
    index('idx_canvas_documents_room').on(table.roomId, table.lastActiveAt),
    uniqueIndex('canvas_documents_source_unique').on(table.scope, table.sourceKey),
    index('idx_canvas_documents_type').on(table.roomId, table.contentType),
    index('idx_canvas_documents_last_touched').on(
      table.roomId,
      table.lastTouchedBy,
      table.lastTouchedAt
    ),
  ]
);
```

**Every timestamp is ISO-8601 `text`, not an integer.** That is the convention every table in this
file already uses — `rooms.ts:159, 463, 662, 773, 878, 916, 977` are all
`text('created_at').notNull()` with no default, the caller supplying the value. A
`{ mode: 'timestamp_ms' }` column here would be the only one of its kind in the rooms schema and
would read back as a `Date` where every sibling reads back as a string.

**Indexes live in the table's third argument, in the array-callback form**
(`index('idx_room_entries_author_room').on(...)`, `rooms.ts:716`; `uniqueIndex('rooms_channel_slug_unique')`,
`:470`). A standalone `index(...)` export is ignored **silently** by Drizzle — read the generated SQL
and confirm every index survived (`.claude/rules/testing.md:317`).

**Rows are closed, not tombstoned.** `close_canvas` deletes the row; the `canvas` frame that
announces it carries the id and `closed: true` so every viewer drops it. Nothing needs a tombstone,
because a reconnecting viewer hydrates from the snapshot rather than from a delta log (§2).

**Migration.** `drizzle.config.ts:32` puts migrations in `packages/db/drizzle/`, and the highest one
there is `0095_broad_bloodaxe.sql`, so this lands as `0096_<drizzle-kit-name>.sql` plus its
`drizzle/meta/_journal.json` entry, generated by `drizzle-kit generate` and never hand-written. The
number is not semantic: if another branch lands an `0096` first, **rebase and renumber this one** to
the next free index rather than touching theirs — two branches minting the same number conflict in
`_journal.json` (`.claude/rules/testing.md:317`). This is also why P2a is one PR that owns the whole
table rather than a stack that mints two.

**Archiving keeps rows and freezes them; deleting a room drops them.** Archive is a flag on `rooms`,
so the cascade never fires: a dormant room keeps its whole table and shows it read-only, exactly as
`RoomPanelBody`'s archived banner (`:413-421`) already treats the rest of the room. **Every write
refuses on an archived room before touching the table** — see §3.7.

### 2. The wire: a `canvas` room frame that is state, not a sequence

**This is the resolution of Q1, and it corrects the ideation.** `01-ideation.md` D1 says the frame is
"replayed like `entry`" with "a per-room `seq`". The code says that cannot be. `room-stream-delivery.ts:53-64`:

> "Entries carry a frame id so a reader can resume from them; the snapshot, ephemeral signals and
> reaction updates deliberately do not… The cursor is the highest ENTRY this reader holds; reactions
> have no place in that sequence and inventing one would put two numbers in one cursor."

`RoomReactionEventSchema`'s own TSDoc (`room-schemas.ts:1929-1975`) works the argument through and
lands on three properties. The canvas frame takes exactly the same three:

1. **It is state, never a delta.** A `canvas` frame carries the affected document's WHOLE current
   row (or `closed: true` and the id). A reader that missed five frames and caught the sixth is
   correct again.
2. **It carries no `seq` and no `id:` line**, so it never moves the reader's `Last-Event-ID`. There
   is exactly one cursor on a room stream and it is the highest durable entry.
3. **A resume re-sends the whole table.** After the entry replay and the reaction resync,
   `deliverRoomStream` sends one `canvas` frame per live document (a **canvas resync**, the exact
   parallel of `service.reactionResync` at `room-stream-delivery.ts:114-117`), so a reader that was
   away while a document was closed or changed ends up correct. Because closes are deletions, the
   resync is authoritative as a SET: the client replaces its whole room-canvas slice from it rather
   than merging, which is what makes a missed close self-correct.

The `rev` column is what orders two frames that race for one document inside the client — a lower
`rev` never overwrites a higher one — and it is deliberately not a stream cursor.

```ts
/** The room's shared canvas changed. Durable state, delivered live, replayed as a whole set. */
export const RoomCanvasEventSchema = z
  .object({
    type: z.literal('canvas'),
    /** The document this frame is about. */
    documentId: z.string().min(1),
    /** Absent when `closed` — the row is gone and the id is the whole payload. */
    document: CanvasDocumentSchema.optional(),
    /** True when the document was closed and every viewer should drop it. */
    closed: z.boolean().optional(),
    /** Which of the four writes produced it, for the client's unread dot and for tests. */
    change: z.enum(['opened', 'updated', 'activated', 'pinned']).optional(),
  })
  .openapi('RoomCanvasEvent');
```

`RoomEventSchema` (`room-schemas.ts:1990-1996`) gains it as a fourth member of the discriminated
union. `RoomSnapshotSchema` gains `canvas: CanvasDocument[]` so a cold connect hydrates in one frame.

### 3. `RoomCanvasService`

New file `apps/server/src/services/rooms/canvas/room-canvas-service.ts`, with `index.ts`,
`__tests__/`, and the document-id helper in `canvas/document-key.ts`. It is constructed beside
`RoomService` and reachable from it (`getRoomService().canvas`), because the notice in §6 is a room
entry and `RoomService` owns the single write path into a room's log.

#### 3.1 API

| Method                                             | What it does                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `apply({ roomId, authorId, turnId, command })`     | **The agent path.** The single writer and single enforcement point (§5.1)   |
| `open(roomId, authorId, content, opts)`            | Insert or refresh by source key; evict; publish `opened`; returns the row   |
| `update(roomId, authorId, documentId, content)`    | Replace `content`; refuse while another author holds the edit lock; publish |
| `close(roomId, authorId, documentId)`              | Delete the row; publish `closed`                                            |
| `activate(roomId, authorId, documentId)`           | Bump `lastActiveAt` + `rev`; publish `activated`. Changes **nobody's** tab  |
| `pin(roomId, authorId, documentId, pinned)`        | Set `pinned`; publish `pinned`                                              |
| `list(roomId)`                                     | Pinned first, then `lastActiveAt` descending                                |
| `get(roomId, documentId)`                          | One row, content included                                                   |
| `heartbeat(roomId, authorId, documentId, editing)` | Take, refresh or release the edit lock (§3.5)                               |
| `viewers(roomId)`                                  | `roomStream.subscriberCount(roomId)` — see §3.6                             |
| `lastDocumentFor(roomId, authorId)`                | The author's own most recently opened-or-updated document, or `null` (§5.6) |
| `resync(roomId)`                                   | Every live document as `canvas` frames, for a stream resume                 |

`apply` is the agent path and wraps `open`/`update`/`close` with the refusals of §5.1. The rest are
the human path and the service's own internals; every one of them takes an `authorId` that the route
resolves server-side, and a caller never supplies one. `requireMembership(roomId, authorId)` gates
all of them, the same call the merge service is handed
(`services/rooms/repo/room-merge-service.ts:170`).

`lastDocumentFor` reads the `lastTouchedBy` / `lastTouchedAt` columns rather than a process-memory
map, so the default target of a bare `update_canvas` survives a server restart mid-conversation.

#### 3.2 Dedupe, mirroring the client's `sourceKey()`

`canvas/document-key.ts` exports a **pure** `canvasSourceKey(content: UiCanvasContent): string | null`
that mirrors `app-store-canvas.ts:148-176` case for case:

| content type                                  | key                                     |
| --------------------------------------------- | --------------------------------------- |
| `url`                                         | `url:<url>`                             |
| `browser`                                     | `browser:<url>`                         |
| `markdown` with `sourcePath`                  | `path:<sourcePath>`                     |
| `markdown` without `sourcePath`               | `null`                                  |
| `file`                                        | `path:<sourcePath>`                     |
| `diff`                                        | `diff:<sourcePath>`                     |
| `image`/`pdf`/`model3d`/`audio`/`video`/`csv` | `src:<src>`                             |
| `mcp_app`                                     | `mcp:<serverName>:<uri>`                |
| `json`, `widget`                              | `null` (every open is a fresh document) |

and a **pure** `canvasDocumentId(scope, sourceKey)` = a stable hash of the two. A key of `null`
means "no natural identity", and that document gets a random ULID instead — see §5.7 for which
content gets which, and why the result carries the id either way.

The dedupe rule is what makes the table a table: two agents that open the same file land on one
document rather than two. A test pins the client and server implementations against one shared table
of cases, so they can never disagree about what "the same document" means.

#### 3.3 Capacity

Twelve unpinned documents per room, LRU by `lastActiveAt`, mirroring `MAX_CANVAS_DOCUMENTS`
(`apps/client/src/layers/shared/lib/constants.ts:30`). Pinned documents never evict and are not
counted. A document whose `editingBy` lock is live never evicts either — the same carve-out
`evictToCapacity` makes at `app-store-canvas.ts:249-257`. Eviction publishes a `closed` frame per
evicted document, so no viewer is left holding a row the server dropped.

#### 3.4 Per-turn bounds

`rooms.maxCanvasOpsPerTurn`, default **3** — the shape `rooms.maxPostsPerTurn` already has
(`room-posting.ts:258-271`). **Counted inside `apply`, keyed by `turnId`** (the room turn's dispatch
id), read per call rather than captured, so moving the number in Settings takes effect on the next
operation. Counting it anywhere else would be counting it too late to refuse — §5.1. Over the
ceiling, the operation is refused with the same shape of sentence:

> You have already changed the canvas 3 times in this conversation during this turn, which is the
> limit. Put the rest in one update next turn.

One coalesced entry per turn regardless of how many operations ran (§6).

#### 3.5 The edit lock (Q2 resolved)

A person editing a document holds back agent updates to **that document**, which is ADR `0292`'s rule
moved server-side. `editingBy` + `editingHeartbeatAt`:

- The client posts a heartbeat every **15 s** while an editor is focused and unsaved.
- A lock is live if `editingHeartbeatAt` is within **45 s** — a 3× margin, so one dropped request
  never drops the lock.
- The lock is cleared explicitly on save, on close, and on blur-with-no-changes.
- **The TTL is evaluated lazily at read/write time.** No timer sweeps the table; a crashed browser
  simply stops being a lock 45 s later. This is why a stale lock cannot wedge a document forever.
- An `update` refused by a live lock returns the notify-and-reconcile signal rather than dropping
  silently (§10), which is the half of ADR `0292` that was deferred and never landed.

#### 3.6 Viewers (D12)

`RoomBroadcaster.subscriberCount(roomId)` already exists and is already public
(`room-stream.ts:103-106`). No addition is needed. It counts **live readers of this room's stream**,
so one person with two tabs open counts twice, and an agent counts zero because agents do not
subscribe. The tool result and the teaching say exactly that: `0` means nobody is looking right now,
and a higher number is tabs, not people.

#### 3.7 An archived room's canvas is frozen

**Every write refuses before it touches the table** — `apply`, `open`, `update`, `close`, `activate`,
`pin`, `heartbeat`, and every human route in §4:

```ts
const room = this.visibility.requireRoom(roomId);
if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
```

That is the precedent `postMergeEvent` sets, line for line
(`services/rooms/messages/room-system-posts.ts:197-202`: "an archived room gains no entries, in its
own voice least of all"). A canvas document is the same kind of claim as an entry — it says the room
is still being worked in — and an archived room must not make it.

**Reads still work.** `list`, `get`, `read_canvas`, the two `GET` routes and the stream snapshot all
answer normally, so an archived room's table stays readable forever. That asymmetry is the whole
point of archiving: the record survives, the activity stops.

### 4. Routes

New router `apps/server/src/routes/room-canvas.ts`, mounted under the rooms router. Every route
resolves the caller with `resolveCaller(req, res).id` and gates on membership exactly as
`room-events-handler.ts:47-55` does — an unknown room and a room the caller is not in answer
identically with `404 ROOM_NOT_FOUND`, because "not a member" must not be distinguishable from "no
such room". The four writing routes additionally refuse an archived room (§3.7) before touching the
table; the two reading routes do not.

| Method   | Path                                        | Body                                | Answers                             |
| -------- | ------------------------------------------- | ----------------------------------- | ----------------------------------- |
| `GET`    | `/api/rooms/:id/canvas`                     | —                                   | `{ documents: CanvasDocument[] }`   |
| `GET`    | `/api/rooms/:id/canvas/:documentId`         | —                                   | `CanvasDocument` (content included) |
| `POST`   | `/api/rooms/:id/canvas`                     | `{ content, pinned? }`              | `201` + `CanvasDocument`            |
| `PATCH`  | `/api/rooms/:id/canvas/:documentId`         | `{ content? , pinned?, activate? }` | `CanvasDocument`                    |
| `DELETE` | `/api/rooms/:id/canvas/:documentId`         | —                                   | `204`                               |
| `POST`   | `/api/rooms/:id/canvas/:documentId/editing` | `{ editing: boolean }`              | `{ editingBy, expiresAt }`          |

Refusal codes join `STATUS_BY_CODE` (`routes/room-error-response.ts`):
`CANVAS_DOCUMENT_NOT_FOUND` (404), `CANVAS_BEING_EDITED` (409), `TOO_MANY_CANVAS_OPS_THIS_TURN` (429),
`CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM` (400), `CANVAS_NO_DEFAULT_DOCUMENT` (400), and the existing
`ROOM_ARCHIVED` (§3.7).

**OpenAPI.** Each path is registered in `apps/server/src/services/core/openapi-registry.ts` with its
tags and schemas, and the published docs are regenerated in the same commit — **both steps**, because
running only the first leaves the site publishing the old text while `git status` is clean
(`contributing/api-reference.md` §"Regenerating the published API docs"):

```bash
pnpm docs:export-api                          # registry  -> docs/api/openapi.json
pnpm --filter=@dorkos/site generate:api-docs  # that JSON -> docs/api/api/**/*.mdx
```

### 5. Routing a `control_ui` in a room turn (D3)

This is the load-bearing seam. It has one **writer and enforcement point**, reached by two callers —
one synchronous, one runtime-neutral — and a stamp that keeps them from doubling.

#### 5.1 `RoomCanvasService.apply` is the single writer and the single enforcement point

```ts
apply(input: {
  roomId: string;
  authorId: string;
  /** The room turn's dispatch id. The per-turn ceiling is counted against it. */
  turnId: string;
  command: UiCommand;
}): { applied: true; documentId: string; rev: number; viewers: number } | { applied: false; reason: string };
```

`apply` is where **everything** that can say no lives, in this order: the room is archived (§3.7), the
action is not a canvas verb (§5.4), the command has no usable referent (§5.2), the author is over
`rooms.maxCanvasOpsPerTurn` for this `turnId` (§3.4), the document is held by another member's edit
lock (§3.5). Nothing else in the system refuses a canvas command, and nothing else writes a row.

**Why the enforcement point moved here** — this replaces an earlier design in which the
`collectReply` tap was the only writer. That design cannot work, and the reason is worth stating
because it is easy to re-derive badly: the claude-code `control_ui` handler **returns
synchronously**, while the tap sees the event only after the projector has ingested it and woken its
subscribers. A ceiling enforced at the tap would refuse an operation the tool had already told the
model succeeded. `rooms.maxPostsPerTurn` only works because `postFromTool` is the _same synchronous
call_ that returns to the model (`room-posting.ts:258-271`); a bound that answers later is not a
bound, it is a silent drop. So `apply` is synchronous, and the handler calls it.

#### 5.2 Caller one: the claude-code handler, synchronously

When `session.roomTurn` is set (§5.3), `createControlUiHandler` calls `apply` and returns **its real
result** — never a fabricated success:

```json
{ "success": true, "target": "room", "roomId": "…", "documentId": "…", "rev": 7, "viewers": 2 }
```

and on a refusal, `{ "success": false, "target": "room", "reason": "<the sentence>" }`.

Only after `apply` returns `applied: true` does the handler push the `ui_command` event, stamped:

```ts
session.eventQueue.push({
  type: 'ui_command',
  data: { command, applied: { documentId, rev } },
} as StreamEvent);
```

`UiCommandEventSchema` (`schemas.ts:5498-5502`) gains an optional `applied` field. **It is
server-side data and the client never reads it** — `executeUiCommand` takes the `command` and nothing
else (`ui-action-dispatcher.ts:192-196`), and a client-side read of it is forbidden by a test. Its
only job is dedupe (§5.5). A refused command is never pushed at all, so no room, no session and no
viewer sees an effect the model was told did not happen.

#### 5.3 How the handler learns it is in a room turn

`roomContext` does **not** reach the session object today. `room-turn-runner.ts:865` passes it to
`dispatchMessage`; `trigger-turn.ts:742` folds it into the neutral additional-context bag as
`{ kind: 'room_context', scope: 'per-turn', data }` (`context-assembler.ts:177-178`); the bag is
rendered into the prompt and nothing else.

The precedent for adding a marker is three lines above where it goes.
`claude-code-runtime.ts:476-480` already lifts a bag entry onto the session for exactly this reason:

```ts
const uiStateEntry = opts?.additionalContext?.find((e) => e.kind === 'ui_state');
if (uiStateEntry?.kind === 'ui_state') session.uiState = uiStateEntry.data;
```

So `sendMessage` lifts the room marker the same way, with one difference that is not optional:

```ts
const roomEntry = opts?.additionalContext?.find((e) => e.kind === 'room_context');
session.roomTurn =
  roomEntry?.kind === 'room_context'
    ? { roomId: roomEntry.data.room.id, authorId: opts.roomAuthorId, turnId: opts.dispatchId }
    : undefined;
```

**It is assigned unconditionally, including to `undefined`.** The `ui_state` lift sets and never
clears, which is harmless for a snapshot and would be a defect here: a session that ran one room turn
would keep claiming to be in that room for every later direct turn, and a person's own `open_canvas`
would land on a channel.

`UiToolSession` (`ui-tools.ts:126-144`) gains the field. The agent's room author id and the turn's
dispatch id ride beside the room id because `apply` needs all three and none of them may be taken
from the model.

#### 5.4 What is refused in a room, and where each runtime refuses it

Sixteen of the twenty-two actions are refused in a room — every one that is not a canvas verb —
with this sentence (`writing-for-humans`: short, plain, says what to do instead):

> That only works in a one-on-one session, not in a room. Rooms share a canvas, not a whole window —
> put a document on the canvas instead.

The sixteen: `show_toast`, `open_panel`, `close_panel`, `toggle_panel`, `open_sidebar`,
`close_sidebar`, `switch_sidebar_tab`, `set_theme`, `scroll_to_message`, `switch_agent`, `open_pip`,
`close_pip`, `open_terminal`, `open_command_palette`, `celebrate` and `apply_layout` — that is,
**everything that is not one of the six canvas verbs**, expressed as an allow-list so a
twenty-third action is refused by default rather than leaking. `apply_layout` matters most: it is the
one `reaches-the-machine` action (`schemas.ts:5486`), and refusing it in a room is a security
property.

Two more refusals close the referent gaps the schema leaves open (§5.5):

- `open_canvas` with **no `content`** (it is optional at `schemas.ts:5278`) — in a session it merely
  reveals the pane, which a room has no equivalent of:

  > Opening the canvas by itself does nothing in a room. Pass the content you want the room to see.

- `update_canvas` or `close_canvas` naming no document and with nothing to default to (§5.5).

**Codex refuses through its own existing seam.** The spec's earlier claim that codex has no refusal
path was wrong: `mapControlUi` already calls `isUiActionRefusedOnCodex(parsed.data.action)` and emits
`uiActionRefusalMessage(...)` under `UI_COMMAND_REFUSED_CODE` **instead of** the `ui_command` event
(`codex/event-mapper.ts:631-640`, policy in `codex/ui-command-consent.ts`). That module is the right
home for the room rule too, so it gains a sibling predicate `isUiActionRefusedInRoom(action)` and the
room sentence, and `CodexEventContext` (`event-mapper.ts:122`) gains the same `roomTurn` marker the
session object carries. Codex therefore refuses in a room for the same reason and with the same
words as claude-code, and the refused command never becomes an event. Only the deterministic
test-mode runtime, which scripts events directly, has no refusal seam — and its scenarios are ours,
so the tap's allow-list (§5.5) is the whole answer there.

#### 5.5 Caller two: the tap, for producers that cannot call `apply`

`collectReply` (`room-turn-runner.ts:1262-1400`) already reads every event of a room turn off the
projector — it is how the room collects the reply, derives the live activity lane (`:1381-1383`) and
learns the turn ended (`:1384-1389`). Its `bounds` argument gains `roomId`, `authorId` and
`dispatchId`, and its loop gains one branch:

```ts
if (event.type === 'ui_command' && event.applied === undefined) {
  applyRoomCanvasCommand({
    roomId: bounds.roomId,
    authorId: bounds.authorId,
    turnId: bounds.dispatchId,
    event,
  });
}
```

**The stamp is the dedupe, and it is the whole of it.** An event the claude-code handler applied
carries `applied`, so the tap skips it. An event from codex or test-mode carries none, so the tap
calls the same `apply` — same ceiling, same refusals, same rows. `applyRoomCanvasCommand` is a thin
wrapper around `apply` that discards the result, because on this path there is nobody to return it
to.

**What a tap-only producer gives up, said plainly.** Its refusal is not visible to the model: the
turn already moved on. So the property this design guarantees instead is that **an operation the tap
did not apply is never claimed applied anywhere** — it produces no row, no frame, and no line in the
turn's coalesced entry (§6.2). There are exactly two paths and they differ only in whether the model
is told:

| Path                                     | Refusal reaches the model?                            | Can an operation be silently lost? |
| ---------------------------------------- | ----------------------------------------------------- | ---------------------------------- |
| claude-code (`apply` from the handler)   | yes, in the tool result                               | no — the call is synchronous       |
| codex / test-mode (`apply` from the tap) | only for the sixteen actions codex's own seam refuses | no — unapplied means unclaimed     |

Neither path can report success for something that did not happen, which is the property the ceiling
and the `turn_end` boundary both hinge on: an event that arrives after the turn's collector has
settled is simply not applied, and nothing anywhere says it was.

#### 5.6 Naming the document: `documentId`, and the default

`update_canvas` carries only `content` (`schemas.ts:5281-5284`) and `close_canvas` carries nothing at
all (`:5285`). In a session that is fine — they act on the store's single `activeDocumentId`. A room
has **no shared active document** by design (§9.3: nothing steals anyone's tab), so those two verbs
arrive in a room with no referent.

**(a) The schema gains an optional target.** `UiCommandSchema` adds
`documentId: z.string().optional()` to `update_canvas` and to `close_canvas`, and `CONTROL_UI_INPUT`
(`ui-tool-contract.ts:67-109`) gains the matching field. It is **additive**: the session client
ignores it when absent (today's behaviour, unchanged) and honours it when present, acting on that
document instead of the active one — which is an improvement on the session surface too.

**(b) The default, when it is absent, is the author's own last document.** `RoomCanvasService` keeps
a per-`(roomId, authorId)` last-touched pointer, persisted on the row as `lastTouchedBy` and
`lastTouchedAt` so it survives a restart rather than living in process memory: the author's most
recently opened-or-updated document in that room. This is the honest default because it is the only
one that cannot act on somebody else's work by accident.

**(c) When there is nothing to default to**, `apply` refuses:

> You have not opened anything on this room's canvas yet, so there is nothing to update. Open a
> document first, or pass the documentId of one that is already open.

**(d) The agent is told where the id comes from.** `open_canvas`, `open_file`, `open_diff` and
`browser_navigate` all return `documentId` in their result, and the teaching block (§12.3) says so in
one sentence, names the default, and says that passing a `documentId` is how to act on a document
somebody else opened.

#### 5.7 The id story

Two kinds of id, and which one you get is decided by whether the content has a natural identity:

- **Content with a source key** (`url`, `browser`, `markdown` with `sourcePath`, `file`, `diff`, the
  six media types, `mcp_app`) gets a **deterministic** id: `canvasDocumentId(scope, sourceKey)`, a
  stable hash of the two. Two agents opening the same file land on one document rather than two, which
  is what makes the table a table.
- **Content with no natural identity** (`json`, `widget` — `sourceKey` is `null` for both,
  `app-store-canvas.ts:148-176`) gets a **random ULID**. Every open is a fresh document, exactly as
  the session store already treats them.

**Either way the result carries the id**, because `apply` writes the row before returning. The
earlier draft had the handler _predict_ the id from the pure function and omit it for `json` and
`widget`; with `apply` synchronous there is nothing to predict and no asymmetry to explain.

#### 5.8 `get_ui_state` in a room

`createGetUiStateHandler` (`ui-tools.ts:189-193`) returns `session.uiState ?? DEFAULT_UI_STATE`. In a
room turn it answers about the room's table instead — the private session UI state is not what the
agent is looking at:

```json
{
  "surface": "room",
  "roomId": "…",
  "viewers": 2,
  "yourLastDocumentId": "…",
  "canvas": {
    "documents": [
      { "id": "…", "type": "diff", "title": "src/router.ts", "author": "Ana", "pinned": false }
    ],
    "count": 4
  }
}
```

`yourLastDocumentId` is the §5.6 default, named so an agent can see what a bare `update_canvas` would
act on. No document content is inlined; `read_canvas` is how content is fetched (§7). Outside a room
turn the handler is unchanged, byte for byte.

### 6. How other members find out (D2)

Three channels. There is no fourth, and none of them triggers a turn.

#### 6.1 A `canvas` section in the room context block

`RoomContextData` (`packages/shared/src/additional-context.ts:427-717`) gains one optional field,
beside `files` (`:629`):

```ts
  /** The room's shared canvas, or absent when the room has no documents on it. */
  canvas?: {
    /** Live readers of this room's stream right now (§3.6). */
    viewers: number;
    /** Pinned first, then most recently touched. Capped at the LRU ceiling, so at most 12 + pins. */
    documents: Array<{
      id: string;
      type: UiCanvasContent['type'];
      /** Another member's words. Rendered INSIDE the fence. */
      title: string;
      /** A browser document's page. Another member's words. Rendered INSIDE the fence. */
      url?: string;
      /** Handle of whoever put it there. */
      author: string;
      pinned: boolean;
      /** ISO 8601. */
      lastChangedAt: string;
    }>;
  };
```

**Content is never inlined.** The agent calls `read_canvas` (§7) if it wants a document's contents.
That keeps the per-turn cost of having a canvas near zero, which is what makes E7 ("silence must be
free") survive the feature.

`room-context-block.ts` renders it, and **the split across the fence is the security decision**
(§Security). The file's own module doc (`:20-76`) states the rule: the preamble holds LABELS only,
each through `sanitizeIdentity`; the fence holds everything another member wrote. So:

- **Outside the fence, in the preamble:** the viewer count, each document's id, type, author handle,
  `pinned`, and timestamp. The id is a server-generated opaque string and is printed as an
  `idLabel(id, nonce)` (`:605-606`) exactly as an entry id is, so a title cannot forge one.
- **Inside the nonced fence:** every `title` and every `url`. A title is a string another member —
  possibly a stranger in a bridged room — chose, and a URL is the same. They are defused with
  `defuseUntrustedText` like every other member's text.

`buildRoomContext` (`room-context.ts:325-328`) fills the field from `RoomCanvasService.list`, spread
the same way `files` is (`:685`).

#### 6.2 One coalesced entry per turn

**A room entry, not a notice.** Notice codes (`room-schemas.ts:175-197`) are refusal-shaped and
deliberately damped, and ADR `260829-115625` already worked out why per-change content must not ride
them ("a damped per-merge event is a merge nobody hears about"). The canvas notice takes the **merge**
shape instead: a durable, system-voiced, unaddressed entry with a structured body.

`RoomEntryBodySchema` (`room-schemas.ts:908-920`) gains a third structured sibling beside `moment`
(`:913`) and `merge` (`:914`):

```ts
    canvas: RoomCanvasChangeSchema.optional(),
```

```ts
export const RoomCanvasChangeSchema = z
  .object({
    ops: z
      .array(
        z.object({
          change: z.enum(['opened', 'updated', 'closed']),
          documentId: z.string().min(1),
          type: z.string().min(1),
          title: z.string(),
        })
      )
      .min(1),
  })
  .openapi('RoomCanvasChange');
```

Written through `RoomService.postCanvasEvent(roomId, { text, canvas, subjectAuthorId })` — the same
single-write-path shape `postMergeEvent` has (`services/rooms/messages/room-system-posts.ts:197-202`,
whose interface the merge service is handed at `services/rooms/repo/room-merge-service.ts:184-197`),
archived-room refusal included (§3.7). Like a merge entry it
**stores no mentions, addresses nobody, and triggers no turn**; agents learn the table moved at their
next turn from §6.1.

The text is one line, composed once when the turn settles (`writing-for-humans`):

> Ana opened the diff of `src/router.ts` and a preview of localhost:5173.

Exactly one of these per turn however many operations ran (E17), and none at all for a turn that
changed nothing.

#### 6.3 A mention

When an agent actually wants somebody to look, it writes `@kai the failing test is on the canvas` in
its reply. That is the existing wake mechanism and it needs nothing new. The teaching block says so
in one sentence, and says the other two channels are free.

### 7. `read_canvas` — and it is a room capability, not a claude-code tool

`01-ideation.md` D11 scopes `read_canvas` to "claude-code in-session". **The code makes a better
answer free.** Room verbs are registered in `services/rooms/room-capabilities.ts` as the `rooms`
capability domain (`:659-662`), each with `surfaces.mcp.servers: ['in-session', 'external']`
(`:698-702`). The external server is the loopback `dorkos` MCP that codex and opencode are injected
with, so a capability reaches **all three runtimes**, membership-gated by `callerAuthor(rooms, context)`
(`:711`), with the tier system already handling approval. Registering `read_canvas` there rather than
in `claude-code/mcp-tools/` gives every runtime read parity in the same amount of code, which is
precisely what D16's honesty goal is about.

```ts
defineCapability({
  id: 'rooms.readCanvas',
  title: "Read the room's canvas",
  tier: 'observe',
  input: z.object({
    roomId: z.string().describe('The room whose canvas to read, by its id — not its #name.'),
    documentId: z
      .string()
      .optional()
      .describe('Omit to list what is on the canvas; pass one to read that document.'),
  }),
  surfaces: { mcp: { toolName: 'read_canvas', servers: ['in-session', 'external'], annotations: { idempotentHint: true } } },
  …
});
```

- **No `documentId`** → the list: id, type, title, author, pinned, last change, and `viewers`.
- **With `documentId`** → the document, subject to the rule in §8.1. A file-backed one (`file`,
  `markdown` with `sourcePath`, `diff`) is read through the existing files route with the row's
  stored `resolvedCwd`, so the **boundary check is unchanged** and an agent cannot read outside it. A
  `browser`/`url` document returns its URL and nothing else (browser history is per-viewer and
  in-memory, `app-store-canvas.ts:61-74`). A `widget` returns its definition. A `json` returns its
  data. Byte caps follow the files route's own.

  **A document whose tree this reader cannot already read returns metadata only** — id, type, title,
  author, timestamps — plus one sentence, never content:

  > This file is in Ana's project, which you cannot read from here. Ask them to share it, or open
  > your own copy.

Adding a verb makes the `rooms` domain 16 capabilities, which **reds two claude-code tool-count
guards by design**; both are updated in the same PR (§Testing Strategy).

### 8. Which file a room document names (D5)

A room has no working directory of its own (ADR `260807-233815`). `RoomContextFiles`
(`additional-context.ts:356-397`) already carries the two trees that exist: `repoPath` (the room's
own integration checkout, where `main` lives, server-write-only) and `worktreePath` (this agent's own
copy).

| Room                 | `open_file` / `open_diff` resolves against | Tab label                      |
| -------------------- | ------------------------------------------ | ------------------------------ |
| has a repo           | the room's `repoPath` (`main`) by default  | none (it is the shared tree)   |
| has a repo, own copy | the agent's `worktreePath`, when it asks   | `Ana's copy · 3 ahead of main` |
| has no repo          | the agent's own `cwd`                      | `in Ana's project`             |

The resolved directory is stored on the row as `resolvedCwd` and the label as `sourceLabel`, so every
later read (a viewer opening the tab, another agent calling `read_canvas`) resolves against the same
directory the document was opened against rather than re-deriving it. The ahead-count in the label is
rendered from `RoomContextFiles.ahead` at open time and is a **snapshot with its timestamp**, never a
live number — `ahead` is `null` when git could not be asked, and the label then says
`Ana's copy` with no count rather than inventing one.

When a document resolves outside the shared tree, the tool result says so in a sentence, because the
other members may not be able to read it:

> Opened in your own copy of the files, not the room's. Other members see the tab but may not be able
> to open it.

#### 8.1 A canvas document never lets a member read a tree it could not already read

This is a property, not a convention, and it is enforced rather than documented. Putting a file on a
shared table must not become a way to hand somebody the contents of a tree they have no claim on —
otherwise "open a document" is a read primitive with a different name.

- **Room with a repo.** A file document resolves only under the room's `repoPath`, which every member
  can already read, **or** under the reading member's **own** `worktreePath`. An agent may open a
  document from its own worktree (D5), and it is the only member that can read that document's
  content; everybody else gets the metadata and the sentence below.
- **Room without a repo.** `read_canvas` returns content only when the document's stored
  `resolvedCwd` equals the **reader's own** cwd. Otherwise: metadata plus the sentence. The author
  can always read their own document, which is the case that matters and the only one that is safe.
- **The human file route is unchanged and stays operator-only**, as it is today. This rule constrains
  what an _agent_ can reach through a canvas document; it neither widens nor narrows what the
  operator of the machine can open.

> This file is in Ana's project, which you cannot read from here. Ask them to share it, or open your
> own copy.

The check is on the **reader**, evaluated at read time against the row's stored `resolvedCwd`, never
on the writer at open time — which is what makes it hold for a member who joined after the document
was opened.

### 9. The client

#### 9.1 The Browser tab: two views over one store (D4)

**The split is already drawn by the renderer.** `AgentCanvas.tsx:55-63` renders exactly two content
types through `CanvasBrowserContent` — `url` and `browser` — and the other twelve through eleven
other viewers. So:

- **Browser view** = documents whose `content.type` is `url` or `browser`.
- **Canvas view** = every other type.

Each view keeps its **own** active document id. One store, one document list, two selectors and two
active ids. No migration, no second persistence path, no duplicated dedupe or LRU.

`init-extensions.ts` gains a `browser` contribution at **priority 22** (between Canvas at 20 and
Terminal at 25):

```ts
register('right-panel', {
  id: 'browser',
  title: 'Browser',
  icon: Globe,
  priority: 22,
  component: BrowserContent,
  visibleWhen: ({ pathname, transport }) =>
    (pathname === '/session' || routeShowsRoom(pathname)) &&
    transport?.supportsWorkbenchServe === true,
});
```

The transport predicate mirrors Terminal's (`:292-302`, `transport?.supportsTerminal === true`):
**under DirectTransport the Browser tab is hidden**, because the Obsidian shell has neither the
serve route nor the preview listener, and a tab that can only show an error is worse than no tab.
The capability flag is a new boolean on `Transport`, `true` on `HttpTransport` and `false` on
`DirectTransport`, declared beside `supportsTerminal`.

`revealCanvas` (`ui-action-dispatcher.ts:410-414`) splits into `revealCanvas` and `revealBrowser`,
and the dispatch table routes by what the command produces:

| Command                                                 | Reveals |
| ------------------------------------------------------- | ------- |
| `browser_navigate` (`:290-296`)                         | Browser |
| `open_canvas` / `update_canvas` with `url`/`browser`    | Browser |
| `open_file` whose resolved viewer is the browser (HTML) | Browser |
| everything else that opens a document                   | Canvas  |

`mcp_app` stays in **Canvas** — that is the Q3 resolution, and it falls out of the rule above rather
than being an exception to it: `mcp_app` is rendered by `CanvasMcpAppContent`, not by
`CanvasBrowserContent`, and its source key is `mcp:<serverName>:<uri>`
(`app-store-canvas.ts:148-176`), not a URL. It is an app, not a page.

The stale note at `ui-action-dispatcher.ts:395-398` ("the canvas contribution is only `visibleWhen`
pathname === '/session'") is rewritten, not deleted: it is now the place that records that both tabs
are visible on room routes too.

#### 9.2 The room canvas slice

New Zustand slice `app-store-room-canvas.ts`, beside `app-store-canvas.ts` and deliberately **not**
merged with it:

- keyed by room id, hydrated from the room stream's `snapshot.canvas` and kept current by `canvas`
  frames;
- **no `localStorage`, ever.** The room's table is the server's; persisting a copy would recreate the
  exact divergence this spec exists to remove;
- a frame with a lower `rev` than the row already held is dropped (§2);
- a **canvas resync** on stream resume replaces the whole set rather than merging (§2), which is what
  makes a close missed while disconnected self-correct.

`use-room-stream.ts` gains the `'canvas'` branch beside `'signal'` (`:368`) and `'reaction'` (`:378`),
and the cold-connect path reads `snapshot.canvas`. The document list is **not** a TanStack Query
cache entry — it is stream-hydrated state, like presence, not a fetched resource. `GET
/api/rooms/:id/canvas` exists for agents, tests and a cold non-stream read; the app reads the stream.

#### 9.3 What opens, and what never steals focus

A shared table that yanks everybody's tab is over-participation one layer down. So:

- **`open`** activates the new document only in the view of the member **who authored it** (a person
  who typed a URL lands on their page; the agent's own operator, if attached, sees its document).
  For every other viewer the tab appears in the strip with an unread dot and the active tab does not
  move.
- **`update`, `activate` and `pin` never change anybody's active tab.** `activate` bumps recency and
  ordering on the server; it is not a remote-control verb.
- A viewer who is **editing** a document is never moved off it, by anything.
- **The panel's own auto-select is untouched.** `RightPanelContainer.tsx:148-156` picks the first
  _contextual_ visible contribution in priority order, and on a room route that is **Room** (priority
  8), which beats Canvas (20) and Browser (22). So a room route opens on the Room tab, as it does
  today, and a document arriving while the panel sits on Room — or on any other tab — lights the
  **unread dot** on Canvas or Browser and moves nothing. Nothing in this spec changes that effect,
  and nothing in it should: a tab that selects itself when another member acts is the same failure as
  a turn that triggers itself.

This is a deliberate tightening of D4/D14's "append-and-activate" inheritance from the session store,
and it is what makes "a canvas change wakes nobody" true of pixels as well as of turns.

#### 9.4 Tabs, authors, pins

Each tab carries the author's avatar through the existing identity kit (`IdentityAvatar`,
`resolveAgentVisual` — never a raw `icon`/`color` read, which is null for most agents). Pinned tabs
sort first. The tab strip is the canvas's existing one
(`[role="tablist"][aria-label="Open canvas documents"]`), so the phone thumb-reach and close-button
behaviour already covered by `apps/e2e/tests/responsive/touch-reach.spec.ts` carries over unchanged.

#### 9.5 Human actions (D14)

Three doors, each a member action, each one durable `canvas` frame with the person as `authorId`:

1. **The Browser tab's address bar.** `submitAddress` (`CanvasBrowserContent.tsx:159-166`) posts to
   `POST /api/rooms/:id/canvas` on a room route instead of mutating local state only.
2. **The Room tab's Files section** (`RoomPanelBody.tsx:563-570`, `RoomFilesSection`). Opening a file
   puts it on the room canvas rather than on a private one.
3. **Close and pin** on any tab, from the tab's own menu.

Nothing here is owner-only: every member of the room can do all three. The room is the unit of trust.

### 10. Editing (D6)

- **File-backed documents** (anything with `sourcePath`) use the **CodeMirror source editor**, never
  Blintz, with attribution on save — a commit on `main` by that person, the path the Files section
  already takes. This is binding, not a preference: `specs/project-rooms/02-specification.md:173`
  records that a ProseMirror round-trip rewrites the file and attributes the rewrite to the person.
- **Generated documents** (no `sourcePath`: agent markdown, widgets, JSON) may use Blintz. They
  belong to the room, not to a file.
- Optimistic concurrency and the Reload/Overwrite banner carry over from
  `use-canvas-file-save.ts` unchanged. No CRDT.
- **Notify-and-reconcile lands here** — the deferred half of ADR `0292`. When an agent's
  `update_canvas` is refused by a live edit lock (§3.5), the editing viewer sees a quiet banner,
  "Ana updated this while you were editing", with **Reload** and **Keep mine**, and the agent's tool
  result says the update was held rather than reporting success. Today the update is dropped in
  silence at `app-store-canvas.ts:372` and both sides are told nothing.

### 11. Bridges, communities, and the Obsidian shell

- **Bridges (D9).** A canvas entry crosses a Telegram or Slack bridge as its **text line plus a deep
  link**, and nothing structural. The bridge's outbound payload is `{ content }` only, and
  attachments already set this precedent.
- **Communities.** The canvas stays **off** the `CommunityAdapter` port. `CommunityEntrySchema` and
  `communityConformance` are untouched by this spec, and the ADR says so: the port is text-only and
  single-identity, and a canvas that crossed it would be a second, weaker canvas.
- **Obsidian / DirectTransport.** The Browser tab is hidden (§9.1). The Canvas tab is visible and
  shows what that shell can render — markdown, widgets, JSON, diffs, images. The docs say exactly
  that and claim nothing more (the demo-claim gate).

### 12. The drift fixes (D10), and the test that keeps them fixed

#### 12.1 One generated catalog

`ui-tool-contract.ts` gains `buildCanvasContentCatalog()` and `buildUiActionCatalog()`, derived from
`UiCanvasContentSchema` and `UiCommandSchema` by walking each discriminated union's options and
reading each variant's `type`/`action` literal and its keys. `CONTROL_UI_DESCRIPTION` (`:28-59`) and
the `<ui_tools>` block (`context-builder.ts:353-376`) are both composed from them, so the numbers
cannot disagree: **14 content types and 22 actions**, everywhere, including `apply_layout`, `mcp_app`,
`file`, `diff` and `browser`, which are reachable today and taught nowhere.

Per-variant prose (what `sourcePath` means, what `open_diff` is for) stays hand-written and is keyed
by variant name in one table; the generator asserts the table covers every variant, so **adding a
15th content type fails the build until somebody writes its sentence**.

#### 12.2 The drift test

`ui-tool-contract.test.ts` parses the rendered description and the rendered `<ui_tools>` block and
asserts each names exactly the set of `UiCanvasContentSchema` variants and `UiCommand` actions —
neither more nor fewer. It fails today (6 vs 10 vs 14), which is what makes it a test that can fail.

#### 12.3 Room teaching

`buildRoomToolsBlock` (`room-tools-context.ts:97-100`) gains a canvas paragraph in **both** its
`text` and `tool-only` variants, written out in each rather than shared (the file's own rule at
`:85-88`: "a version assembled from clauses is one that can be assembled wrong"). It says, in plain
sentences:

- which six verbs put something on the room's canvas, and that everything else about the window only
  works in a one-on-one session;
- that `open_canvas`, `open_file`, `open_diff` and `browser_navigate` **give back a `documentId`**,
  that `update_canvas` and `close_canvas` take one, and that leaving it out means "the last document
  **you** opened here" — so acting on somebody else's document takes naming it (§5.6);
- that a canvas change **notifies nobody** — to ask for eyes, `@mention` somebody;
- that `read_canvas` is how to see what is already there;
- that `viewers: 0` means nobody is looking right now, so say it in words too;
- that long output belongs on the canvas with a one-line message, not pasted into the room (E9, E14).

#### 12.4 `dorkos-ui` fences in room bodies (P0b)

`render-room-body.tsx:86-91` passes no `renderers` to `MarkdownContent`. It gains the same
`dorkos-ui` registration `StreamingText.tsx:61-77` has, with one difference: in a room the widget is
**read-only**. A `ui-action` of channel `agent` needs a session to post into and a room message has
none, so those controls render disabled with the existing tooltip, while `ui` and `url` actions work.
Otherwise a widget an agent posts to a room shows as a code block.

## Data model changes

1. **`canvas_documents`** (§1) + migration `0096_*.sql` in `packages/db/drizzle/`.
2. **`rooms.maxCanvasOpsPerTurn`** — a new config field, following all 13 steps of
   `contributing/configuration.md` §"Step-by-step: adding a new config field" and the
   `adding-config-fields` skill:
   - the Zod field in the `rooms` section of `packages/shared/src/config-schema.ts` (the section
     starts at `:1711`), declared exactly like its sibling at `:1927`:
     `maxCanvasOpsPerTurn: z.number().int().min(1).max(10).default(3),`
   - **and** the matching entry in the same section's object-literal default block (`:2020`, where
     `maxPostsPerTurn: 3` sits). **Both sites or neither**: the per-field default feeds a fresh
     install and the object literal feeds an upgrade, and they can silently disagree;
   - `projectVersion` bumped in `ConfigManager`, and a migration appended to `CONFIG_MIGRATIONS`
     (`config-manager.ts:3272-3921`) under a key strictly greater than the newest present, `'0.78.0'`
     (`:3911`), guarded with `store.has()` and pinned in `merged-migration-hashes.ts` in the same PR;
   - classified in `CONFIG_DISCLOSURE` and `CONFIG_WRITE_POLICY`, given a verdict in
     `safe-defaults/default-verdicts.ts`, and a `PROTECTIVE_CARRYOVERS` decision;
   - documented in the Settings Reference table and mirrored to
     `docs/getting-started/configuration.mdx`;
   - a migration test in `config-manager.test.ts` that boots a real `ConfigManager` and reads the
     file back off disk.
3. **Shared schemas** — `RoomCanvasEventSchema` and `CanvasDocumentSchema` added to
   `packages/shared/src/room-schemas.ts`; `RoomEventSchema`'s union (`:1990-1996`) gains a fourth
   member; `RoomSnapshotSchema` gains `canvas`; `RoomEntryBodySchema` (`:908`) gains `canvas`;
   `RoomContextData` (`additional-context.ts:427`) gains `canvas`. Every one is **optional or
   additive**, so an older client parses a newer server's frames.
4. **`UiCommandSchema`** (`packages/shared/src/schemas.ts:5276-5285`) — `update_canvas` and
   `close_canvas` each gain `documentId: z.string().optional()`, and `CONTROL_UI_INPUT`
   (`ui-tool-contract.ts:67-109`) gains the matching optional field (§5.6). Additive on the session
   surface: absent behaves exactly as today, present targets that document. `UiCommandEventSchema`
   (`:5498-5502`) gains an optional `applied: { documentId, rev }` — **server-side data the client
   never reads** (§5.2), pinned by a test.
5. **Untouched on purpose:** `CommunityEntrySchema`, `communityConformance`, and the `CommunityAdapter`
   port. A test asserts the port's surface is unchanged by this spec.
6. **`Transport`** — the room methods live on `RoomTransport` (`packages/shared/src/transport-rooms.ts`,
   which `Transport` extends at `transport.ts:554`). Six additions, each of which must land in
   **all three** implementations or the build breaks: `HttpTransport`
   (`apps/client/src/layers/shared/lib/transport/http-transport.ts`), `DirectTransport`
   (`apps/client/src/layers/shared/lib/direct-transport.ts`), and `createMockTransport`
   (`packages/test-utils/src/mock-factories.ts:234`).

## User Experience

**Kai opens a channel.** The right panel shows Pulse · Room · Canvas · Browser. **Room** is what
auto-selects, because the panel picks the first contextual tab in priority order and Room (8) sorts
ahead of Canvas (20) and Browser (22) (`RightPanelContainer.tsx:148-156`). Kai clicks Canvas; it is
empty, with the canvas splash.

**Kai asks two agents to look at a failing build.** Ana opens the diff of `src/router.ts`; Ikechi
opens a preview of `localhost:5173`. Kai sees a diff tab appear in Canvas with Ana's avatar; the
Browser tab, which he is not on, shows an unread dot for Ikechi's preview. Neither moves the tab he
is on, and neither moves him off Canvas. One line lands in the room's log per turn: "Ana opened the
diff of `src/router.ts`." Nothing pings.

**Kai switches to the Browser tab** and clicks Ikechi's preview. It frames through the existing
serve/proxy/external cascade in his own browser, with the same reachability sentences the session
canvas already gives. He types a different URL in the address bar; it appears on the table as his,
and both agents see it in their next turn's context.

**Ana's next turn** reads a `canvas` section listing four documents, their types, titles and authors,
and `viewers: 1`. She calls `read_canvas` on Ikechi's preview, gets the URL, and writes "@kai the
500 is from the proxy, not the app — see the console on the preview tab."

**Kai edits the diff's file** in the canvas. While he types, Ana's `update_canvas` on that document is
held; Kai sees "Ana updated this while you were editing" with Reload and Keep mine, and Ana's tool
result says it was held rather than reporting success.

**On a phone**, the panel is the existing full-height sheet (`RightPanelContainer.tsx:241-289`); the
Browser tab behaves as the Canvas tab does, tab strip scrolling included.

**In Obsidian**, the Canvas tab shows markdown, widgets, JSON and diffs; there is no Browser tab,
because that shell has no way to serve or proxy a page.

**Error and exit paths.** Every refusal is a plain sentence: over the per-turn ceiling (§3.4), an
action that only works in a session (§5.4), a document another member is editing (§3.5), a file
outside the shared tree (§8). Closing the last document leaves the splash, not an error. Losing the
stream shows the room's existing stalled indicator and re-hydrates the whole table on reconnect.

## Testing Strategy

Every test below is one that **can fail**: each names a behaviour that is absent or wrong on today's
code, and each is listed with the defect it would catch.

### Unit tests

**`packages/shared`** (`src/__tests__/`)

- `RoomEventSchema` parses a `canvas` frame and still parses `entry`, `signal` and `reaction`
  unchanged. _Catches: a union edit that narrows an existing member._
- A `canvas` frame carries **no `seq`** — asserted structurally, not by convention. _Catches: the
  exact mistake `01-ideation.md` D1 proposed; a `seq` here would put two numbers in one cursor._
- `RoomEntryBodySchema` accepts `canvas` beside `moment` and `merge`, and an older body with neither
  still parses. _Catches: a required field breaking every existing entry._
- `RoomContextData.canvas` is optional; a producer that predates it still validates.

**`packages/db`**

- The migration applies to a fresh database and to one seeded at `0095`; `canvas_documents` exists
  with all three indexes. _Catches the silent failure `.claude/rules/testing.md:317` names: a
  standalone `index(...)` export that Drizzle ignores without error._
- Deleting a room deletes its documents; **archiving a room does not**.

**`apps/server` — `services/rooms/canvas/__tests__/`**

- `canvasSourceKey` matches the client's `sourceKey` for all 14 content types, driven from one shared
  case table. _Catches the two implementations drifting, which would silently double every document._
- `canvasDocumentId` is stable across processes for the same `(scope, sourceKey)`, and content with a
  `null` key gets a fresh random id every time (§5.7). _If the first were unstable, two agents opening
  one file would get two documents and the table would stop being shared; if the second were stable,
  every `json` open would overwrite the last one._
- LRU evicts the 13th unpinned document and publishes a `closed` frame for it; a pinned document and
  one under a live edit lock are never evicted.
- The edit lock expires **lazily** at 45 s with no timer, and a 15 s heartbeat holds it. _Catches a
  crashed browser wedging a document forever._
- `update` is refused while another author holds the lock, and **allowed** once it lapses.
- The per-turn ceiling refuses the 4th operation of a turn, keyed by `turnId`, and the count resets
  on the next turn. Asserted **twice, once per path**: on claude-code, on the **tool result the
  handler returns** (`success: false` and the sentence, and no row written); on a test-mode scenario
  that scripts four `ui_command`s, on the **applied count** (three rows, three frames, one coalesced
  entry naming three operations). _Catches the defect this review found: a ceiling enforced after the
  handler already answered is not a bound._
- A bare `update_canvas` with no `documentId` targets the **author's own** last-touched document,
  never another member's, and survives a service restart because the pointer is on the row.
- A bare `update_canvas` or `close_canvas` from an author with no document in that room is refused
  with the "nothing to update" sentence rather than acting on somebody else's work.
- `open_canvas` with no `content` is refused in a room. _It is optional at `schemas.ts:5278` and in a
  session means "just reveal the pane", which a room has no equivalent of._
- Every write refuses on an archived room **before** the table is touched; every read still answers.
- Membership is required by every mutating method; a non-member is refused identically to a caller
  naming a room that does not exist.

**`apps/server` — the routing seam**

- `sendMessage` sets `session.roomTurn` from a `room_context` bag entry **and clears it when the
  entry is absent**. _This is the defect the `ui_state` lift at `claude-code-runtime.ts:476-480` would
  have if it were copied naively: a session that ran one room turn would keep writing to that room
  forever._
- `control_ui` in a room turn calls `RoomCanvasService.apply` **synchronously** and returns its real
  result — `{ target: 'room', roomId, documentId, rev, viewers }` on success, the refusal sentence on
  failure — and pushes no `ui_command` event at all when `apply` refused. Outside a room turn its
  behaviour is byte-identical to today's.
- An event the handler applied carries the `applied` stamp and the tap **skips** it; an unstamped
  event from codex or test-mode is applied exactly once. _Catches double-application, which would
  double-count the ceiling and double the coalesced entry._
- The client never reads `applied`: a test greps `apps/client/src` for the field and fails on a hit.
- Each of the sixteen non-canvas actions is refused in a room with the exact sentence, and the
  refused command **never reaches `session.eventQueue`**. _Catches a refusal that still leaks onto a
  private stream._
- The same sixteen are refused on **codex**, through `isUiActionRefusedInRoom` in
  `codex/ui-command-consent.ts`, emitting `UI_COMMAND_REFUSED_CODE` instead of a `ui_command` event —
  asserted on the event-mapper's output, the way the existing `apply_layout` refusal already is.
- `get_ui_state` answers with the room summary in a room turn and with `UiState` outside one.
- The `collectReply` tap applies an **unstamped** `ui_command` through the same `apply`, and composes
  **one** entry per turn no matter how many operations ran — including for a turn the ceiling or the
  deadline killed. _Catches a notice per operation, which is the E17 failure._
- An operation that was not applied — refused, or arriving after the collector settled — produces **no
  row, no frame, and no line in the coalesced entry**. _Catches the "reported successful but lost"
  class: unapplied must mean unclaimed on both paths._

- `read_canvas` returns **content** to the document's author and **metadata plus the sentence** to a
  member whose cwd differs, in a repo-less room; and returns content to every member for a document
  under the room's `repoPath`. _Catches the cross-member read this review found: a canvas document
  becoming a way to read a tree the reader has no claim on._

**`apps/server` — routes** (`routes/__tests__/`): each of the six routes, member-gated; the refusal
codes and their statuses, `ROOM_ARCHIVED` and `CANVAS_NO_DEFAULT_DOCUMENT` included; the OpenAPI
registry entry existing for each path.

**Tool census.** Adding `rooms.readCanvas` changes the advertised tool set, which reds the count
guards in `apps/server/src/services/runtimes/claude-code/mcp-tools/__tests__/tool-exposure.test.ts`
**by design**. They are updated in the same PR, and the PR runs
`pnpm vitest run apps/server/src/services/runtimes` before it is opened — a new verb has reddened
these before and the failure reads like an unrelated break if you have not been told.

### Runtime conformance

One new case in `runtimeConformance` (`packages/test-utils/src/runtime-conformance.ts:1135`), so
every runtime that ships must satisfy it:

> **A room turn's `open_canvas` lands on the room canvas, appears in the next turn's context of a
> second agent, and triggers no turn.** Drive a room turn that yields a `ui_command` `open_canvas`;
> assert (a) `RoomCanvasService.list` holds the document, (b) a second member's next
> `buildRoomContext` carries it in `canvas.documents`, (c) **no turn was triggered for anybody** —
> read off the trigger dispatcher, not off a sleep.

Written against the event stream rather than against the claude-code tool handler, which is what
makes it satisfiable by codex and by test-mode through the tap (§5.5) rather than by one runtime.

### Client tests (RTL + jsdom, mock `Transport`)

- The room canvas slice hydrates from `snapshot.canvas`, applies `opened`/`updated`/`closed` frames,
  **drops a frame with a lower `rev`**, and **replaces** its whole set on a resync. _Catches a merge
  that leaves a closed document on screen forever._
- The Browser view shows exactly `url` and `browser` documents and the Canvas view shows the other
  twelve, including `mcp_app` in Canvas (Q3). _Catches the split drifting from
  `AgentCanvas.tsx:55-63`._
- Each view keeps its own active document across a switch.
- A document opened by **another** member does not move this viewer's active tab; one opened by this
  member does. _Catches focus-stealing, which is the pixel version of over-participation._
- A viewer who is editing is never moved off their document.
- The notify-and-reconcile banner appears when an update is held, with Reload and Keep mine.
- `dorkos-ui` fences render in a room message body, with `agent`-channel controls disabled and
  `ui`/`url` controls live.
- The contribution registry hides the Browser tab under a transport reporting no workbench-serve
  support. _Catches the Obsidian shell showing a tab that can only error._

### Drift test

`ui-tool-contract.test.ts` (§12.2) — the rendered `control_ui` description and the rendered
`<ui_tools>` block each name exactly the schema's 14 content types and 22 actions. **It fails on
today's code (6 / 10 / 14)**, which is the point.

### Playwright (`apps/e2e`)

**Existing specs that change with the Browser tab** — the tab strip is asserted literally in more
than one place, and a UI-copy change that misses one of them goes red only in the merge queue, where
`browser-test` actually runs:

| Spec                                         | Change                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `tests/pulse/right-panel-tab-strip.spec.ts`  | its **premise** changes, not just a count — see below                                 |
| `tests/workbench/dev-server-preview.spec.ts` | drives the preview through `pages/canvas-dev-server.ts`; it now opens the Browser tab |
| `tests/responsive/touch-reach.spec.ts`       | opens a "Web Page" canvas document; that document is now a Browser-tab document       |
| `tests/production/shipped-shell.spec.ts`     | reuses `pages/canvas-dev-server.ts`, so it follows that page object                   |
| `pages/canvas-dev-server.ts`                 | `openInCanvasBrowser` selects the Browser tab rather than the Canvas tab              |

**New spec — `apps/e2e/tests/rooms/room-canvas.spec.ts`**, built from the helpers rooms specs already
use (`fixtures/rooms-api.ts` → `RoomsApi.createChannel`, `:273`) and **no model spend**:

1. Create a channel with two agent members through `RoomsApi`.
2. Drive a room turn on the deterministic **test-mode** runtime with a scenario modelled on
   `demoCanvas` (`test-mode/demo-scenarios.ts:203-229`) that yields a `ui_command` `open_canvas`.
   This is the payoff of the runtime-neutral second caller (§5.5): a real agent turn puts a real document on
   a real room canvas with no credential and no cost.
3. Assert the document appears in the room's **Canvas** tab, with the agent's avatar on the tab.
4. Assert **one** coalesced line appears in the room log, and that the second agent was not triggered.
5. Navigate the room's Browser tab to a URL as the person; assert the document appears and that a
   second browser context — a second viewer of the same room — sees the same tab without reloading.
6. Reload the page; assert the whole table is still there (the property `localStorage` could never
   give: hydration from the server).
7. Close a document in one context; assert it disappears in the other.

Step 5's two-context assertion is the one that fails hardest on today's code, and it is the whole
feature in one line.

**`right-panel-tab-strip.spec.ts` needs its premise rewritten, not its number bumped.** The file is
built on a measured claim — "six tabs do not fit a 45% panel at this window width" (`:5-8, 27-28,
96`) — **and on its converse**, a wide-window test asserting the same split "fits all six tabs"
(`:33-36, 137-155`). A seventh tab changes the arithmetic under both halves: the narrow case still
overflows (more so), but the wide case may no longer fit, and a spec that only had its count changed
from six to seven would either pass vacuously or fail for a reason that is not the bug it was filed
for (ADR `260725-004456`, the scroll-affordance rule it pins). P1 re-measures both window widths and
rewrites the premise sentences to match.

**Mocking strategy.** Server tests use the rooms test harness and a real SQLite database, never a
mocked `RoomCanvasService` — a mock here would encode the hypothesis rather than test it. Client
tests use the mock `Transport` through `TransportProvider`. The e2e leg uses the test-mode runtime,
which is deterministic and free; no test in this spec reads `ANTHROPIC_API_KEY` or any other paid
credential, and none may.

## Performance Considerations

- **Per-turn prompt cost.** The `canvas` context section is labels only, capped at 12 unpinned
  documents plus pins, and inlines no content — a few hundred tokens at the ceiling. It rides the
  per-turn bag, not the cached system-prompt prefix, so it never invalidates the prefix.
- **Stream volume.** One frame per operation, bounded by `rooms.maxCanvasOpsPerTurn` per turn per
  agent, each carrying one document. `RoomBroadcaster` already ends a subscriber at 1000 queued
  events, so a pathological writer degrades into a reconnect-and-replay rather than unbounded memory.
- **The resync is O(live documents)**, at most 12 + pins, and runs once per stream resume — beside
  the reaction resync, which is O(100) by comparison.
- **Reads.** `list` is one indexed query on `(room_id, last_active_at)`. `get` is a primary-key read.
  Document content is fetched only by `read_canvas` and by the viewer who opens the tab.
- **No polling anywhere.** The edit lock is evaluated lazily at read/write time; the heartbeat is one
  small POST every 15 s, and only while an editor is focused with unsaved changes.

## Security Considerations

1. **Prompt injection through canvas content.** A document title, and a browser document's URL, are
   strings another member chose — in a bridged room, possibly a stranger who found a public bot. Both
   are rendered **inside** the nonced untrusted fence and defused, exactly as message bodies are.
   Only server-generated labels — ids, types, author handles, counts, timestamps — sit outside it,
   each through `sanitizeIdentity`, and each id printed as a nonced `idLabel` so a title cannot forge
   one (`room-context-block.ts:20-76, 605-606`). **Document content is never put in context at all**,
   which removes the largest injection surface by construction rather than by escaping.
2. **Membership gates everything.** Every route resolves the caller server-side and calls
   `requireMembership`; a non-member is refused identically to a caller naming a room that does not
   exist, so room ids stay non-probing (`room-events-handler.ts:48-55`).
3. **File documents do not widen the boundary, and never widen a member's reach.** `open_file`,
   `open_diff` and `read_canvas` go through the existing files routes with the row's stored
   `resolvedCwd`, so the process boundary check is unchanged and a document opened against one
   directory is never later read against another. On top of that, §8.1 states the property that
   matters in a shared room: **a canvas document never lets a member read a tree it could not already
   read.** In a room with a repo, file documents resolve only under the shared `repoPath` or the
   reader's own worktree; in a repo-less room, `read_canvas` returns content only when the document's
   cwd is the reader's own, and otherwise metadata plus one plain sentence. Enforced on the reader at
   read time, so it holds for a member who joined after the document was opened. Without this rule,
   "open a document" would be a cross-tree read primitive with a friendlier name.
4. **The sandbox posture is unchanged.** A browser document is a URL and who opened it. Every viewer
   frames it locally through the existing serve/proxy/external cascade — opaque-origin sandbox for
   served files, a per-port minted origin for dev servers, direct framing for external sites.
   Nothing is streamed between viewers, and captures stay keyed by the capturing session.
5. **A room can never widen what an agent may do.** Canvas actions stay `client-only` reach
   (`schemas.ts:5463-5481`) and stay auto-approved. `apply_layout` — the one
   `reaches-the-machine` action (`:5486`) — is **refused** in a room, so a room turn cannot write a
   `SKILL.md`, rewrite `~/.dork/config.json` or create a scheduled task through the UI path. The
   refusal is an allow-list (§5.4), so a twenty-third action is refused by default.
6. **The per-turn ceiling is a mechanism, not a prompt.** It is enforced inside
   `RoomCanvasService.apply`, synchronously, keyed by the turn's dispatch id — where an agent cannot
   talk its way past it and, crucially, early enough to refuse rather than to drop (§5.1).
7. **An archived room accepts no canvas writes** (§3.7), refused before the table is touched, on the
   same precedent and for the same reason `postMergeEvent` refuses to speak in one.

## Documentation

**`docs/guides/workbench.mdx`** — the Browser tab changes four places:

- the tab-strip sentence at `:12` ("**Files**, **Canvas**, and **Terminal**") and the `ProductShot`
  alt text at `:14-17` gain Browser;
- **"Embedded Browser: Preview Without Leaving DorkOS"** (`:80`) is rewritten: it is premised
  throughout on the browser being a document inside the Canvas tab;
- **"Multi-Document Tabs"** (`:90`) says "Open a file, then a browser preview, then another file, and
  each gets its own tab" in one strip — that sentence is now false and becomes the two-views
  explanation;
- **"Agents Can Drive the Workbench for You"** (`:117`) lists "Navigate the embedded browser" as a
  canvas action; the wording follows.

**`docs/concepts/rooms.mdx`** — this page has **no** mention of a canvas or an embedded browser
today, so this is a new section rather than an edit. It goes beside **"Files a room owns"** (`:99`),
whose structure it parallels: "The room's canvas", with subsections for what it is, who can put
things on it, that a change notifies nobody and how to ask for eyes, that a file document opens
against the room's shared copy, and what it looks like on a phone. **"What a room can never do to an agent"** (`:213`) gains two sentences: a room's canvas cannot make
an agent do anything a session could not, and **a document on the canvas never lets a member read a
file they could not already read** — a file from somebody's own project shows as a tab with its name
and who opened it, and says so instead of opening (§8.1). The REST surface table under **"Reference (for developers)"** (`:550`) gains the six
routes.

**`docs/guides/generative-ui.mdx`** — **"Canvas"** (`:56`) is session-scoped prose ("rendering live
beside a streaming session") and gains the room case: a widget an agent posts to a room renders in
the room's canvas, and a widget in a room **message** renders read-only. **"Canvas Content Types"**
(`:229`) currently documents 13 types with `browser` as one of them; the generated catalog makes it
14, and the section says which two the Browser tab shows.

**`docs/getting-started/configuration.mdx`** and the Settings Reference table gain
`rooms.maxCanvasOpsPerTurn`.

**`contributing/`** — `architecture.md`'s rooms paragraph gains the canvas service and the table;
`api-reference.md` needs nothing beyond the regenerated spec. Whichever guide the room-turn seam is
described in gains the `session.roomTurn` lift and the `collectReply` tap, because a future reader
tracing "where does a room turn's `ui_command` go" must not have to find it by grep.

**`.claude/skills/` / `chat:rooms-test`** — the rooms self-test skill gains a canvas leg: open a
document from one agent, assert the other agent's next turn sees it in context, assert nobody was
woken.

**Changelog fragments.** One fragment per PR in `changelog/unreleased/`, named
`<YYMMDD-HHMMSS>-<kebab-slug>.md` with the id from `.claude/scripts/id.ts`. Each carries a `covers:`
block on the very first lines, listing that PR's exact commit subjects (or `"#<number>"`), so
rewriting the prose never breaks the coverage check. Bodies use only the seven allowed headings
(`### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, `### Security`,
`### Note for people upgrading`) — anything else fails validation, and an invalid heading has silently
deleted a fragment before. Run `pnpm exec prettier --write changelog/unreleased/<file>` before
committing: hand-edited fragments are the single most common source of the formatting gate going red.

The demo-claim gate applies to every page above: the Obsidian shell's canvas is described by what it
renders, and no page claims the Browser tab works there.

## Implementation Phases

One PR per phase, in the order the dependency graph allows. Each phase's acceptance criteria are the
gate; none of them is "it looks right".

### P0a — One generated catalog, `apply_layout` described, notify-and-reconcile

**Create/modify**

- `apps/server/src/services/runtimes/shared/ui-tool-contract.ts` — catalog generators; description
  composed from them
- `apps/server/src/services/runtimes/claude-code/messaging/context-builder.ts:353-376` — `<ui_tools>`
  composed from them
- `apps/server/src/services/runtimes/shared/__tests__/ui-tool-contract.test.ts` — the drift test
- `apps/client/src/layers/shared/model/app-store/app-store-canvas.ts:368-374` — a held update is
  recorded rather than dropped
- a new banner component + its RTL test; `apps/server/.../ui-tools.ts` result says "held"

**Acceptance:** the drift test passes with 14 content types and 22 actions named in both places;
`apply_layout`, `mcp_app`, `file`, `diff` and `browser` are each taught; adding a 15th variant to the
schema fails the build until its sentence is written; an agent update arriving while a person edits
produces a banner with Reload / Keep mine and a tool result that does not claim success.

### P0b — `dorkos-ui` fences render in room bodies

**Create/modify**

- `apps/client/src/layers/widgets/room-view/ui/render-room-body.tsx:86-91` — register the renderer
- RTL test for a widget fence in a room message

**Acceptance:** a `dorkos-ui` fence in a room message renders as a widget; `agent`-channel controls
render disabled with the existing tooltip; `ui` and `url` actions work; a malformed fence still falls
back to a code block rather than breaking the message.

### P1 — The Browser tab on `/session` (D4)

**Create/modify**

- `app-store-canvas.ts` — two views over one store, per-view active id
- `apps/client/src/app/init-extensions.ts` — the `browser` contribution at priority 22
- `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts:395-414` — `revealBrowser`, the reveal
  table, the rewritten note
- `packages/shared/src/transport.ts` + both implementations + `mock-factories.ts` — the
  workbench-serve capability flag
- `apps/e2e/pages/canvas-dev-server.ts`, `apps/e2e/pages/RightPanelPage.ts`,
  `tests/pulse/right-panel-tab-strip.spec.ts` (premise re-measured, not just recounted),
  `tests/workbench/dev-server-preview.spec.ts`, `tests/responsive/touch-reach.spec.ts`,
  `tests/production/shipped-shell.spec.ts`
- `docs/guides/workbench.mdx`; a changelog fragment

**Acceptance:** seven tabs on `/session`; `browser_navigate` reveals Browser and `open_file` of a
markdown file reveals Canvas; each view remembers its own active document across a switch; the
Browser tab is absent under DirectTransport; every listed e2e spec passes against the new strip.

### P2a — Server: the table, the service, the routing (depends on P0a)

**Create/modify**

- `packages/db/src/schema/rooms.ts` + `packages/db/drizzle/0096_*.sql` + journal
- `packages/shared/src/room-schemas.ts` (`RoomCanvasEventSchema`, `CanvasDocumentSchema`,
  `RoomEventSchema` union, snapshot, `RoomEntryBodySchema.canvas`),
  `packages/shared/src/additional-context.ts` (`RoomContextData.canvas`)
- `apps/server/src/services/rooms/canvas/` — service, `document-key.ts`, tests
- `apps/server/src/services/core/streams/room-stream-delivery.ts` — the canvas resync
- `apps/server/src/routes/room-canvas.ts` + `openapi-registry.ts` + regenerated docs
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts:476-480` — the
  `session.roomTurn` lift, assigned unconditionally
- `apps/server/src/services/runtimes/claude-code/mcp-tools/ui-tools.ts` — the synchronous `apply`
  call, the real result, the `applied` stamp, refusals, room-aware `get_ui_state`
- `packages/shared/src/schemas.ts:5276-5285, 5498-5502` — the optional `documentId` on
  `update_canvas`/`close_canvas`, the optional `applied` on `UiCommandEventSchema`;
  `runtimes/shared/ui-tool-contract.ts` — the matching input field
- `apps/server/src/services/runtimes/codex/ui-command-consent.ts` + `event-mapper.ts:122, 631-640` —
  `isUiActionRefusedInRoom` and the `roomTurn` marker on `CodexEventContext`
- `apps/server/src/services/rooms/room-turn-runner.ts:1262-1400` — `collectReply`'s `bounds` gains
  `roomId`, `authorId` and `dispatchId`; the unstamped-event tap; the coalesced entry
- `apps/server/src/services/rooms/room-capabilities.ts` — `rooms.readCanvas`
- `apps/server/src/services/rooms/room-context.ts` — the `canvas` section;
  `runtimes/shared/room-context-block.ts` — its rendering across the fence;
  `runtimes/shared/room-tools-context.ts` — the teaching paragraph in both variants
- `packages/shared/src/config-schema.ts` + `config-manager.ts` migration + the 13 config steps
- `packages/test-utils/src/runtime-conformance.ts` — the new case
- `tool-exposure.test.ts` — the census update

**Acceptance:** the conformance case passes on claude-code and on test-mode; a room turn's
`open_canvas` is visible in `GET /api/rooms/:id/canvas` and on the stream; a second agent's next
context lists it; no turn is triggered; exactly one entry lands per turn; **the 4th operation is
refused in the tool result the model reads**, and nothing was written for it; a stamped event is
applied once and an unstamped one is applied once; the sixteen non-canvas actions are refused with
the sentence on claude-code and on codex and never reach the event queue; a bare `update_canvas`
targets the author's own last document and refuses plainly when there is none; an archived room
refuses every write and answers every read; a repo-less room's document returns content only to its
author; a session that ran a room turn writes to no room on its next direct turn.

### P2b — Client: the room canvas (depends on P1 and P2a)

**Create/modify**

- `apps/client/src/layers/shared/model/app-store/app-store-room-canvas.ts` + tests
- `apps/client/src/layers/entities/room/model/use-room-stream.ts` — the `'canvas'` branch and
  `snapshot.canvas`
- `apps/client/src/app/init-extensions.ts` — Canvas and Browser `visibleWhen` gain `routeShowsRoom`
- tab avatars, pins, the unread dot, the no-focus-steal rule (§9.3)
- `CanvasBrowserContent.tsx:159-166` — the address bar posts to the room on a room route
- `RoomPanelBody.tsx:563-570` — the Files section opens onto the room canvas
- the edit-lock heartbeat; the source-editor rule for `sourcePath` documents
- `apps/e2e/pages/RoomsPage.ts` — canvas and browser tab selectors, the document tab strip, the
  unread dot; `apps/e2e/tests/rooms/room-canvas.spec.ts`; a changelog fragment

**Acceptance:** two browser contexts viewing one room see the same documents, live, without
reloading; a reload restores the whole table; closing a document in one context removes it in the
other; a document another member opened never moves this viewer's active tab; a viewer editing is
never moved; the phone sheet renders both tabs.

### P2c — Docs (depends on P2b)

**Create/modify:** `docs/guides/workbench.mdx`, `docs/concepts/rooms.mdx`,
`docs/guides/generative-ui.mdx`, `docs/getting-started/configuration.mdx`, the Settings Reference
table, `contributing/architecture.md`, the `chat:rooms-test` skill's canvas leg, a changelog fragment.

**Acceptance:** every page reads at a smart-9th-grader level per `writing-for-humans`; no page claims
the Obsidian shell has a Browser tab; the rooms page's new section is reachable from its sidebar; the
docs build passes (`site-build`).

### P3 — Pins, tab presence, the `#team` board (depends on P2b)

**Create/modify:** pinned-first ordering in the UI and the pin action; `signal`-frame tab presence
("Ana is looking at tab 2", and an agent's face on a document while a `read_canvas` claim is held,
exempt as a mechanical presence signal); `ROOM.md` pinned by default in a room with a repo; the
`#team` status board shipped as documentation and a seeded example widget, **not** as a new
primitive.

**Acceptance:** a pin survives a reload and is never evicted; presence is ephemeral and never
replayed (it rides `signal`, which carries no `seq` by design); `#team` shows the board on Home; no
new schema is introduced for the board.

### Dependency graph

```
P0a ─┬─> P2a ─┬─> P2b ─┬─> P2c
     │        │        └─> P3
P0b ─┘        │
P1 ───────────┘
```

P0a, P0b and P1 are independent of each other and of P2a's server work; P0a is listed as P2a's
dependency because P2a's room teaching is composed from P0a's generated catalog.

## Open Questions

All three questions `01-ideation.md` §8 left for SPECIFY are resolved. Nothing is outstanding; the
spec is implementable as written.

- ~~**Q1. Frame kind versus body: is `canvas` a new `RoomEvent` kind (recommended: it is state, not
  conversation) or a `RoomEntryBody.canvas` structure on a notice entry?** (RESOLVED)~~

  **Answer: both, for two different jobs — and the frame is modelled on `reaction`, not on `entry`.**
  `canvas` is a fourth member of `RoomEventSchema` (`room-schemas.ts:1990-1996`) carrying live state,
  **and** `RoomEntryBodySchema` (`:908`) gains a `canvas` structure for the once-per-turn coalesced
  entry. They are not alternatives: the frame is how a viewer's screen stays current, the entry is
  how the room's history records what happened.

  **Rationale — and this corrects the ideation.** D1 says the frame is "replayed like `entry`" with
  "a per-room `seq`". The code forbids it. `room-stream-delivery.ts:53-64` states the rule outright:
  the room stream has exactly one cursor, the highest durable **entry** a reader holds, and
  "inventing one would put two numbers in one cursor". `RoomReactionEventSchema`'s TSDoc
  (`room-schemas.ts:1929-1975`) already worked the whole argument through for durable state that is
  not conversation, and landed on three properties — whole-state not delta, no `seq` and no `id:`
  line, and a resync on resume. The canvas frame takes all three, with the cold snapshot carrying the
  table and a **canvas resync** mirroring `reactionResync` (`room-stream-delivery.ts:114-117`).
  Ordering between two frames for one document is the row's own `rev`, which is not a stream cursor.
  The coalesced entry follows the **merge** precedent rather than the notice one, because notice
  codes are refusal-shaped and deliberately damped, and ADR `260829-115625` already established that
  per-change content must not ride a damper.

- ~~**Q2. `editingBy` heartbeat interval and TTL for server-side edit protection (D6).**
  (RESOLVED)~~

  **Answer: a 15 s heartbeat, a 45 s TTL, cleared explicitly on save, on close and on
  blur-with-no-changes — and the TTL is evaluated lazily at read/write time, with no sweeper.**

  **Rationale.** 45 s is a 3× margin on the heartbeat, so one dropped request never drops a lock
  while somebody is mid-sentence. Lazy evaluation is the part that matters: a timer that expires
  locks is a timer that must be cancelled on every close, restart and room deletion, and the failure
  mode of getting that wrong is a document nobody can ever edit again. Evaluated lazily, a crashed
  browser simply stops holding a lock 45 s later and no code had to notice. Nothing in the code
  contradicted the ideation's recommendation; it is adopted with the evaluation strategy made
  explicit.

- ~~**Q3. Whether the Browser tab on `/session` keeps a "Canvas" affordance for `mcp_app` documents
  that are pages (they stay in Canvas: they are apps, not pages).** (RESOLVED)~~

  **Answer: `mcp_app` stays in Canvas, and it is not an exception — it falls out of the rule.** The
  Browser view is defined as "the documents `CanvasBrowserContent` renders", which
  `AgentCanvas.tsx:55-63` already fixes at exactly two content types: `url` and `browser`. Every
  other type, `mcp_app` included, is rendered by a different viewer and belongs to the Canvas view.

  **Rationale.** The split was already drawn by the renderer, so defining the views by it means there
  is one definition rather than a list plus exceptions, and no way for the tab split and the viewer
  dispatch to drift. `mcp_app`'s own dedupe key is `mcp:<serverName>:<uri>`
  (`app-store-canvas.ts:148-176`), not a URL — the store has never treated it as a page either.

## Related ADRs

Seeded by this spec (`proposed`, `extractedFrom: spec`, `specSlug: room-canvas`):

| id              | Title                                                                               |
| --------------- | ----------------------------------------------------------------------------------- |
| `260911-200301` | A room's canvas is server-owned and rides the room stream as whole-document state   |
| `260911-200302` | A canvas change never triggers a turn                                               |
| `260911-200303` | A room turn's canvas commands are routed by turn context, at the session-event seam |
| `260911-200304` | The Browser is its own right-panel tab: two views over one document store           |

Constraining this work:

- `260708-185518` — the multi-document canvas, its dedupe and its LRU.
- `0292` — per-document edit protection; its notify-and-reconcile half lands here.
- `0293` — the editor owns the document, the host owns the file.
- `0290` — markdown is Blintz, code is CodeMirror.
- `260822-083229` — room surfaces are right-panel contributions, not modals ("future room surfaces
  (files, canvas) are contribution registrations").
- `260829-115625` — a merge wakes nobody; the durable-unaddressed-entry shape this spec reuses.
- `260829-115621`, `260829-115626` — the room's worktrees and its integration checkout.
- `260807-233815`, `260807-233816` — a room has no working directory; attachments are rows.
- `260814-024525` — bridged rooms are projections, not community backends.
- `260728-022013` — a thread is a position in a room, not a room.
- `0273` — the server owns what context exists; each adapter owns how it renders.
- `0312` — timestamp ids for ADRs and specs.

## References

- `specs/room-canvas/01-ideation.md` — decisions D1–D17, phases P0a–P3.
- `research/20260911_canvas-browser-in-rooms.md` — the inventory (§1), the drifts (§1.5), the
  reframing (§3.1), the three awareness channels (§3.6), and the three decisions (§8).
- `specs/project-rooms/02-specification.md:173` — room files are edited with a source editor.
- `specs/room-presence/02-specification.md` — why `signal` frames are the wrong transport for state.
- `specs/message-search/` — the coverage claim this spec deliberately does not widen (D15).
- `meta/agent-etiquette.md` — E7 (silence must be free), E9/E14 (long output belongs behind an
  artifact), E16a (mechanical presence signals), E17 (batch notices).
- `contributing/api-reference.md` — the two-step OpenAPI regeneration.
- `contributing/configuration.md` §"Step-by-step: adding a new config field" — the 13 steps.
- `.claude/rules/testing.md:317` — Drizzle ignores standalone index exports silently; migration
  numbers are not semantic.
- `changelog/README.md` — fragment naming, the `covers:` block, the seven allowed headings.
- DOR-1995 (umbrella) · Linear project "Canvas and Browser in Rooms".
- DOR-1807 — merge Files, Canvas and Terminal into one Workspace tab. Related, not adopted: this
  spec's direction is separate tabs.
