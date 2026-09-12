# Task breakdown — The canvas agent seat

**Spec:** [`specs/canvas-agent-seat/02-specification.md`](02-specification.md)
**Slug:** `canvas-agent-seat`
**Umbrella:** DOR-2004 · Linear project "Canvas and Browser in Rooms" · follows DOR-1995 (`specs/room-canvas/`)
**Mode:** full · **Generated:** 2026-09-11

Six tasks, one per phase of the spec's Implementation Phases section. Each task is one PR, each is
sized `xl`, and each is therefore promoted to its own tracker sub-issue under DOR-2004. Every
description is self-contained: it carries the phase's own create/modify list and acceptance criteria
plus every design, data-model, experience, testing, performance, security and documentation passage
that phase implements, quoted in full, so an implementer can build from the task with the
specification closed.

Every `file:line` the descriptions quote was read on the branch base `ff3b94e15` — `origin/main`
with room-canvas P0a, P0b, P1 and P2a merged. P2b and P3 are not on main, which is why the last two
tasks carry an external precondition instead of a dependency.

## Dependency graph

```
Q1 ──┬──────────────┐
     │              v
Q2 ──┼──> Q3       Q4
     └──────────────^

room-canvas P2b ─┬──> Q6
       (+ P3) ───┴──> Q5
```

Q1 and Q2 are independent of each other: Q1 is the canvas's storage and Q2 is the browser's command
channel, and they meet only in the `ui` domain Q1 creates and Q2 fills. Q3 needs Q2's round trip. Q4
needs both, because it moves five tools into a domain Q1 created and standardises them beside the six
Q2 added. Q5 and Q6 are gated on the room canvas client landing on `main`, not on anything here —
they carry `dependencies: []` and a `note` naming the work item that gates them, because a
dependency on a task in another spec's file is a dependency this file cannot express honestly.

| Task  | Phase | Title                                 | Size | Priority | Depends on | Parallel with | Blocked by (outside this spec) |
| ----- | ----- | ------------------------------------- | ---- | -------- | ---------- | ------------- | ------------------------------ |
| `1.1` | Q1    | The session canvas on the server      | xl   | high     | —          | 1.2           | —                              |
| `1.2` | Q2    | Driving the browser                   | xl   | high     | —          | 1.1           | —                              |
| `2.1` | Q3    | Recording and agent attachments       | xl   | medium   | 1.2        | 2.2           | —                              |
| `2.2` | Q4    | Runtime parity                        | xl   | high     | 1.1, 1.2   | 2.1           | —                              |
| `3.1` | Q5    | Follow mode and document threads      | xl   | medium   | —          | 3.2           | DOR-2000 and DOR-2002 merged   |
| `3.2` | Q6    | Merge preview and `control_ui.target` | xl   | medium   | —          | 3.1           | DOR-2000 merged                |

## Critical path

`1.2 (Q2) → 2.2 (Q4)` — two PRs deep, and `1.2` is the pacing item of the whole spec: both `2.1`
and `2.2` wait on it, and `2.2` additionally waits on `1.1`. Start `1.1` and `1.2` together on day
one; they touch different files and meet only at the `ui` domain's declaration file, which `1.1`
creates with one capability and `1.2` fills with six. `2.2` (Q4) is the largest and most dangerous
PR in the spec — it deletes five hand registrations, retires Codex's `dorkos_ui` server, and narrows
two tables that `tsc` compares against each other — so it should be the one that gets the deepest
review, not the one that gets rushed because it is last in its wave.

`3.1` and `3.2` are not on that path at all. They are ready to start the moment room-canvas P2b
(DOR-2000) — and, for `3.1`, P3 (DOR-2002) — are on `main`, and they can run beside anything here.
The real longest chain to a finished programme therefore runs through the other spec: P2b → Q5/Q6.

---

### Task 1.1: Move the session canvas to the server and open the ui capability domain

**Phase:** Q1 — The session canvas on the server (B1)
**Scope:** one PR. Independent of Q2; together with Q2 it unblocks Q4. Base branch `ff3b94e15` —
`origin/main` with room-canvas P0a, P0b, P1 and P2a merged.

#### Phase definition — create/modify and acceptance

**Create**

- `apps/server/src/services/canvas/{canvas-service,canvas-document-store,document-key,scopes,index}.ts`
  - `__tests__/` (moved from `services/rooms/canvas/`, generalised over scope)
- `apps/server/src/routes/session-canvas.ts`
- `apps/server/src/services/session/ui-capabilities.ts` — the `ui` domain, with
  `ui.read_canvas_document`
- `apps/client/src/layers/shared/lib/transport/session-canvas-methods.ts`,
  `apps/client/src/layers/shared/lib/direct/session-canvas-methods.ts`
- `packages/db/drizzle/0097_*.sql` + journal entry

**Modify**

- `packages/db/src/schema/rooms.ts` — nullable `room_id`, indexes on `scope`
- `packages/shared/src/session-stream.ts` — the `canvas` event member, `SessionSnapshotSchema.canvas`
- `packages/shared/src/schemas.ts:5585-5623` — `UiStateSchema.canvas` removed, `UiStateReport`
  added; `apps/client/src/layers/shared/lib/ui-state-snapshot.ts:66` stops composing it
- `packages/shared/src/transport.ts` — six methods; `http-transport.ts`, `direct-transport.ts`,
  `packages/test-utils/src/mock-factories.ts`
- `apps/server/src/services/session/session-state-projector.ts:198-202` — `EVENTS_OUTSIDE_THE_TURN`;
  a `subscriberCount()` beside `getWaiterCount()` (`:2011`)
- `apps/server/src/services/core/streams/session-stream-delivery.ts:152-159` — decorate the snapshot
- `apps/server/src/services/rooms/canvas/room-canvas-service.ts` — the room flavour, delegating
- `apps/server/src/services/runtimes/claude-code/mcp-tools/ui-tools.ts:69-122, 237-270` — the canvas
  arms of `applyUiCommandToState` removed; the session arm of `get_ui_state` reads the table
- `apps/client/src/layers/shared/model/app-store/app-store-canvas.ts` — hydrate, write through, drop
  `persist()`; `app-store-helpers.ts:136-268` and `constants.ts:9,16` — the retirement; the one-time
  import; **delete** `features/canvas/model/use-canvas-persistence.ts`
- `apps/server/src/routes/sessions.ts` — mount; `openapi-registry.ts` + both regeneration commands
- `apps/server/src/index.ts:2727` — `onProjectorRekey(... canvasService.rekeyScope(...))` beside the
  connector-attachment line; that wiring lives in `index.ts`, which the Obsidian shell (DirectTransport) never runs — so the `CanvasService` self-subscribes to `onProjectorRekey` at module scope, the way `message-dispatcher.ts:2275-2282` self-wires its own listener, and `index.ts` adds nothing; one root owns it and both shells get it; `onSessionRemoved(...)` beside `noteSessionOrphaned`
  (`message-dispatcher.ts:2282`); `sweepOrphanedCanvasDocuments()` in the health-check interval
  (`index.ts:4395-4402`)
- `apps/client/src/layers/features/chat/model/use-session-submit.ts:419-424` and
  `use-session-stream.ts:127-149` — the import waits for the canonical id off the paths that already
  learn it
- `AGENTS.md` + `scripts/__tests__/agents-service-census.test.ts` — the `canvas` domain
- `tool-exposure.test.ts` (92→93, 83→84), `capability-conformance.test.ts` `sampleInputs`

**Acceptance:** a document opened in one browser context appears in a second context on the same
session without a reload, and survives a reload of both; `localStorage` holds no canvas key
afterwards and a grep test fails on one; a session with a pre-existing local entry imports exactly
once and never twice; `get_ui_state` lists the real documents and a real viewer count; an agent reads
one back with `read_canvas_document` and cannot name another session; a `canvas` event never appears
inside an in-progress turn and never reaches the event store; a resume replays missed canvas events
gap-free; the moved room-canvas test suite passes unchanged; **a document opened on a fresh,
un-canonical session survives the first-turn rekey** — after it, a hydrate lists that document under
the canonical scope, re-opening the same source key finds the same row rather than a second, and only
then is the local entry removed; a runtime that degrades in the session listing causes the orphan
sweep to delete nothing.

#### Detailed Design §1 — The session canvas moves to the server (B1)

#### 1.1 One table, two scopes

`canvas_documents` (`packages/db/src/schema/rooms.ts:1019-1116`) was built scope-keyed on purpose:
its `scope` column already carries `room:<roomId>` and its own TSDoc reserves `session:<id>` for
this spec. Two changes make the reservation real.

**`room_id` becomes nullable.** Today it is `text('room_id').notNull().references(() => rooms.id,
{ onDelete: 'cascade' })`. A session document belongs to no room, so it stores `null` there and keeps
the cascade for the rows that do. The invariant is enforced in `CanvasService`, not by a CHECK
constraint (SQLite CHECK constraints are not something this schema uses anywhere):

> A `room:<id>` scope row has a non-null `room_id` equal to that id. A `session:<id>` scope row has
> `room_id` null.

A test asserts both halves, because a session row that carried a `room_id` would be deleted by an
unrelated room deletion.

**The four indexes move from `room_id` to `scope`.** Every query in `CanvasDocumentStore` keys on the
owner, and after this change the owner is the scope:

```ts
(table) => [
  index('idx_canvas_documents_scope').on(table.scope, table.lastActiveAt),
  uniqueIndex('canvas_documents_source_unique').on(table.scope, table.sourceKey),
  index('idx_canvas_documents_scope_type').on(table.scope, table.contentType),
  index('idx_canvas_documents_last_touched').on(
    table.scope,
    table.lastTouchedBy,
    table.lastTouchedAt
  ),
];
```

`canvas_documents_source_unique` is already `(scope, sourceKey)` and does not move — which is why the
dedupe story needs no thought: two tabs of one session opening one file land on one document for
exactly the reason two agents in one room do.

**The migration is `0097_*.sql`** — `0096_groovy_daredevil.sql` is the room-canvas table itself and is
the newest migration in the database. SQLite cannot `ALTER COLUMN`, so `drizzle-kit generate` will
emit a table recreate (`__new_canvas_documents`, copy, drop, rename) plus four `CREATE INDEX`
statements. **Read the generated SQL and confirm all four indexes survived**, and that the copy
carries every column: Drizzle drops a standalone `index(...)` export in silence
(`.claude/rules/testing.md:317`), and a recreate that loses a column loses rows' contents with it.
If another branch lands an `0097` first, rebase and renumber; two branches minting one number
conflict in `_journal.json`.

**The scope is the CANONICAL session id, and a rekey moves it.** This is the trap the whole phase
turns on. A claude-code session id starts life as the request UUID the client minted and is replaced
by the canonical SDK id mid-first-turn (`ui-tools.ts:145-170` explains the same hazard for the
capture store). Every in-memory store in the server already migrates across that moment, and there
are two established ways to hook it:

- **inside `rekeyProjector`**, which is what the capture store does
  (`session-state-projector.ts:2430`: `devtoolsCaptureStore.rekeySession(fromId, newId)`);
- **through the `onProjectorRekey` listener** (`session-state-projector.ts:2553`, notified at
  `:2466`), which is what the connector attachment store and the message dispatcher do.

`CanvasService` takes the **listener**, because the projector must not import it: the service already
calls `peekProjector` to publish (§1.3), and a direct call the other way would close the cycle. The
call site is one line in `apps/server/src/index.ts`, immediately beside the one that is already
there at `:2727`:

```ts
onProjectorRekey((oldId, newId) => sessionConnectorAttachmentStore.rekey(oldId, newId));
onProjectorRekey((oldId, newId) =>
  canvasService.rekeyScope(sessionScope(oldId), sessionScope(newId))
);
```

`rekeyScope(from, to)` is **one SQL statement in one transaction** — `UPDATE canvas_documents SET
scope = ? WHERE scope = ?` — so a reader either sees every row under the old scope or every row under
the new one, never a split table. It is a no-op when the old scope holds nothing, which is the
common case, and it does **not** republish: a rekeying session is mid-first-turn and its reader
re-hydrates from the snapshot under the new id.

**The document ids do not move with it, and that is deliberate.** `canvasDocumentId(scope, sourceKey)`
is a hash of the scope (`document-key.ts:42-45`), so a rekey would in principle change the
deterministic id of every row. Recomputing them would break every id already handed to the model in
this turn's tool results. So `rekeyScope` rewrites **`scope` only** and leaves `id` alone; the id is
opaque and the unique index is on `(scope, sourceKey)`, which is still unique after the rewrite. The
one consequence is that a document opened before the rekey has an id derived from the retired scope —
invisible to everyone, and a test asserts that re-opening the same source key after the rekey finds
that same row rather than inserting a second one.

#### 1.2 `CanvasService`: what is shared, what differs

`RoomCanvasService` (`services/rooms/canvas/room-canvas-service.ts`) is already the single writer,
already scope-aware internally (`roomScope(roomId)`, `:1224-1226`), and already holds every piece a
session canvas needs. It moves, generalised, to a **new service domain**:

```
apps/server/src/services/canvas/
  canvas-service.ts        # scope-generic: apply, open, update, close, activate, pin,
                           # heartbeat, list, get, lastDocumentFor, resync, mayReadContent
  canvas-document-store.ts # moved from services/rooms/canvas/, keyed on scope
  document-key.ts          # moved unchanged (already pure)
  scopes.ts                # roomScope(roomId) / sessionScope(sessionId) / parseScope
  index.ts, __tests__/
```

and `services/rooms/canvas/room-canvas-service.ts` becomes the **room flavour**: it holds the room's
policy — membership, the archived-room refusal, the per-turn ceiling, the ledger, `finishTurn`,
`viewers` from `RoomBroadcaster.subscriberCount` — and delegates every write to `CanvasService`.
`getRoomService().canvas` keeps its shape, so `ui-tools.ts:186-209`, `room-canvas.ts` and
`room-turn-runner.ts` are unchanged at their call sites.

**Adding a service domain means editing the census.** `AGENTS.md`'s "Service domains" line is a
complete list, and `scripts/__tests__/agents-service-census.test.ts` fails until `canvas` is added to
it. That is the intended cost of the move, not a surprise: a canvas that serves two scopes is not a
rooms concern, and leaving it under `services/rooms/` would have `services/session/` importing from
`services/rooms/` to answer a question that has nothing to do with rooms.

| Behaviour                | `room:<id>`                                               | `session:<id>`                                                            |
| ------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| who may write            | any member; `requireMembership` on every call             | the session's owner and its own agent; no membership concept              |
| archived refusal         | yes, before the table is touched (`ROOM_ARCHIVED`)        | n/a                                                                       |
| per-turn ceiling         | `rooms.maxCanvasOpsPerTurn`, default 3, keyed by `turnId` | **none** — see below                                                      |
| ledger + coalesced entry | yes; `finishTurn(turnId)` posts one room entry            | **none** — see below                                                      |
| LRU capacity             | 12 unpinned (`MAX_ROOM_CANVAS_DOCUMENTS`, `:72`)          | 12 unpinned (`MAX_CANVAS_DOCUMENTS`, `constants.ts:30` — the same number) |
| edit lock                | 15 s heartbeat / 45 s lazy TTL                            | the same, and it earns its keep: two devices on one session are the point |
| viewers                  | `RoomBroadcaster.subscriberCount(roomId)`                 | live readers of that session's stream (§1.7)                              |
| the wire                 | `canvas` room frame, no `seq`, whole-set resync           | `canvas` session event, **with** `seq`, replayed by the ring (§1.3)       |
| how others find out      | context section + one coalesced entry + a mention         | nothing; there is nobody else (see below)                                 |

**No per-turn ceiling on a session, and that is a decision rather than an omission.**
`rooms.maxCanvasOpsPerTurn` exists because a canvas change in a room costs every other member's
attention — it puts a tab in their strip and a line in their log. A session canvas has an audience of
one, who asked for the turn, and whose client store has never had a per-turn cap. The LRU is the only
bound it needs, and it is the same bound it has today. Adding a ceiling here would be a mechanism
protecting nobody.

**A session has no room log, and nothing replaces the coalesced entry.** In a room, `finishTurn`
composes one durable line per turn so the history records what happened. A session's history is its
transcript, which **already** records every `control_ui` call as a tool call with its result. The
`canvas` session event (§1.3) is how other windows of the same session find out, and the existing
`ui_command` event stays exactly what it is — the reveal trigger that opens the pane. So for a
`session:` scope, `CanvasService` keeps **no ledger and no closed-turn bookkeeping at all**, and
`finishTurn` is a room-flavour method that a session scope never reaches. This is worth stating
because the alternative — inventing a session-side notice — would put a second, weaker record beside
the transcript.

#### 1.3 The wire: a `canvas` session event (Q1 resolved)

A new member of `SessionEventSchema` (`packages/shared/src/session-stream.ts:356-790`), mirroring
`RoomCanvasEventSchema` (`room-schemas.ts:2211-2223`) field for field so **one client reducer
handles both scopes**:

```ts
z.object({
  ...seqShape,
  type: z.literal('canvas'),
  /** The document this frame is about. */
  documentId: z.string().min(1),
  /** Absent when `closed` — the row is gone and the id is the whole payload. */
  document: CanvasDocumentSchema.optional(),
  /** True when the document was closed and every viewer should drop it. */
  closed: z.boolean().optional(),
  /** Which write produced it. */
  change: z.enum(['opened', 'updated', 'activated', 'pinned']).optional(),
}),
```

**It carries a `seq`, and unlike the room frame it needs no resync.** That difference is the whole of
Q1's answer and it falls out of the two streams being built differently:

- The room stream has exactly one cursor — the highest durable **entry** — so a `canvas` room frame
  deliberately carries no `seq` and no `id:` line, and a resume re-sends the whole table
  (`room-stream-delivery.ts:53-64`, `:114-117`).
- The session stream's every event carries a `seq` by construction (`seqShape` is on all 31 members),
  the projector stamps it (`session-state-projector.ts:609-623`), and a resume replays from the ring
  and log above the reader's cursor (`replayFrom`, `:1708-1717`). A cursor the window cannot serve
  falls back to a cold snapshot, which carries the whole set (§1.4). So the gap the room resync
  exists to close **cannot open here**, and inventing a session resync would be a second mechanism
  for a problem the first one already solves.

**Where the event comes from.** `CanvasService` mints it and hands it to the session's projector:

```ts
peekProjector(sessionId)?.ingest({ type: 'canvas', documentId, document, closed, change });
```

The projector is the right seam because it is the one every runtime feeds — claude-code, codex,
opencode and test-mode all construct one (`claude-code-runtime.ts`, `codex-runtime.ts`,
`opencode-runtime.ts`, `test-mode-runtime.ts`) — so a server-minted event reaches every runtime's
readers without any of them knowing about the canvas. `peekProjector` returning `undefined` (nobody
attached, session idle) is the normal case and is **not** an error: the next reader hydrates from the
snapshot.

Two edits keep it from landing in the wrong place:

- `EVENTS_OUTSIDE_THE_TURN` (`session-state-projector.ts:198-202`) gains `'canvas'`. A person opening
  a document while no turn is running must not open an in-progress turn, and a document opened
  mid-turn must not be replayed as part of that turn's content.
- `RECORDED_EVENT_TYPES` (`projector-persistence.ts:73-81`) does **not** gain it. The canvas is state,
  not transcript; it is durable in SQLite and re-read from there, and writing it into the event store
  would put two records of one fact in two places with different lifetimes.

`ui_command` is unchanged, in every respect. It keeps its `applied` stamp (`schemas.ts:5550-5577`),
the normalizer keeps carrying it (`session-event-normalizer.ts:319-342`), and the client keeps
reading only `command` — its job on a session is still to reveal the pane, and `executeUiCommand`
still drives the reveal.

#### 1.4 The snapshot

`SessionSnapshotSchema` (`session-stream.ts:897-920`) gains one field:

```ts
    /** The session's canvas, server-owned. Pinned first, then most recently active. */
    canvas: z.array(CanvasDocumentSchema),
```

It is filled in `deliverSessionStream`, **not** in the runtime's `getSessionSnapshot`, beside the two
decorations the delivery already makes to a snapshot it got from the runtime
(`session-stream-delivery.ts:152-159`: `filterKickoffHistory`, and blanking `pendingInteractions` for
a caller the Ask entitlement refuses):

```ts
snap.canvas = canvasService.list(sessionScope(sessionId));
```

That keeps the canvas out of four runtime adapters, which is the same reasoning ADR-0310 uses for the
other direction: storage that a runtime owns lives in the runtime, and storage the server owns does
not get copied into each of them.

`DirectTransport` does not go through `deliverSessionStream`; its session-stream methods
(`apps/client/src/layers/shared/lib/direct/session-stream-methods.ts`) must make the same decoration,
and a test asserts a `DirectTransport` snapshot carries the canvas. If the embedded shell cannot
reach the database at all, the honest answer is the empty list and the stub sentence
`embedded-mode-stubs.ts` already uses — never a silent fall-back to a local copy, which would
recreate the divergence this phase exists to remove.

#### 1.5 The client: hydrate, write through, retire `localStorage`

The store keeps its shape. `CanvasSlice` (`app-store-canvas.ts:119-207`) already holds one document
list and two views with their own active ids, `heldUpdate`, the LRU and `browserHistories`, and all of
that is right. What changes is where its state comes from and where a change goes.

- **`loadCanvasForSession(sessionId)`** stops reading `localStorage` and becomes a no-op reset: the
  slice is filled from `snapshot.canvas` on the session stream's cold connect, the same place
  messages and status come from. `use-canvas-persistence.ts` (21 lines) is **deleted**, and the
  `'canvas'` branch joins the session stream reducer beside the other event kinds.
- **`persist()`** (`app-store-canvas.ts:373-386`) is **deleted**, and every mutator that called it
  calls the transport instead — optimistic local apply, then the write, then reconcile from the
  `canvas` event that comes back. A failed write reverts the optimistic apply and surfaces the
  server's sentence; it never leaves the two disagreeing.
- **`rev` is the tiebreak.** A `canvas` event whose `document.rev` is not greater than the row the
  slice already holds is dropped, exactly as the room slice does. This is what makes the echo of your
  own write harmless and makes a second device's write win in order.
- **`browserHistories` stays in memory and stays per-viewer.** A browser document's back/forward stack
  is what _this_ window did; it is not state anybody else should inherit. Nothing about it changes.
- **`editing` stays transient** and is now also reported: the existing `setDocumentEditing` starts and
  stops the 15 s heartbeat against the server (§1.2).

**The `localStorage` retirement, and the one-time import.** `STORAGE_KEYS.CANVAS_SESSIONS`
(`constants.ts:9`), `MAX_CANVAS_SESSIONS` (`:16`), `PersistedCanvasDocument`, `CanvasSessionEntry`,
`readCanvasSession`, `writeCanvasSession` and their legacy-shape normalizers
(`app-store-helpers.ts:136-268`) are all **removed**, not left dormant. `knip` would flag them and
the quality standard forbids a superseded path kept "just in case".

**The import waits for the canonical id, and deletes nothing until the server confirms.** A brand-new
session streams under the request UUID the client minted and is rekeyed to the SDK's canonical id
mid-first-turn (§1.1). Importing under the pre-rekey id would write rows into a scope that is about
to be renamed, and — worse — deleting the local entry at that moment would destroy the only copy if
the POSTs had not landed. So the import is gated on two facts the client already has:

- **Canonical.** The client learns the canonical id twice over: `transport.postMessage` returns
  `{ sessionId }` — "the SDK-canonical id the server resolved for this turn" — and
  `use-session-submit.ts:419-424` already re-attaches the stream to it; and when the id resolves
  after the 202, `session_status.retiredSessionId` (`session-stream.ts:942-951`) carries the retired
  UUID and `useSessionRekeyRedirect` (`use-session-stream.ts:127-149`) already rewrites the URL. The
  import subscribes to the same fact rather than inventing a third path. A session the client has
  never sent a message on is **already** canonical — it has no pre-rekey id to be confused by — so
  the common case waits for nothing.
- **Confirmed.** The local entry is deleted only after every POST has returned `201`. A failed or
  partial import leaves the local entry exactly where it was and retries on the next hydrate.

```
on cold connect, once the session id is canonical:
    if localStorage has no entry for this session: stop
    if snapshot.canvas is non-empty:            delete the local entry; stop
    POST each of the entry's documents, oldest openedAt first
    if every POST returned 201:                 delete the local entry
    else:                                       keep it; retry next hydrate
```

**Its idempotence rests on the emptiness check, and its safety on the confirm-before-delete.** The
check means a session whose server table already holds anything is never re-seeded, so a second
device connecting after the first has imported adds nothing — and a client that crashed mid-import
does not double, because the documents it already sent make the table non-empty. Two devices
importing concurrently converge anyway: the documents carry source keys,
`canvas_documents_source_unique` is on `(scope, sourceKey)`, and a colliding insert refreshes the
existing row rather than making a second. `json` and `widget` documents have no source key and are
the one case that can double — and they are the one case the store itself already treats as "every
open is a fresh document".

Entries for sessions the person never opens again are swept on any hydrate: once this ships the
client drops every entry it did not just import whose `accessedAt` is older than the retired
50-session window. One sentence in the release note says the canvas now follows you between devices,
and nothing asks the person to do anything.

#### 1.6 Transport

Six methods, mirroring the room-canvas routes so one client hook can serve both scopes. They live in
`packages/shared/src/transport.ts` under a new `// --- Session canvas ---` banner (the file's own
convention, 35 such sections), and must land in **all three** implementations or the build breaks:

| Method                                                      | Route                                               |
| ----------------------------------------------------------- | --------------------------------------------------- |
| `listSessionCanvas(sessionId)`                              | `GET /api/sessions/:id/canvas`                      |
| `getSessionCanvasDocument(sessionId, documentId)`           | `GET /api/sessions/:id/canvas/:documentId`          |
| `openSessionCanvasDocument(sessionId, content, opts?)`      | `POST /api/sessions/:id/canvas`                     |
| `updateSessionCanvasDocument(sessionId, documentId, patch)` | `PATCH /api/sessions/:id/canvas/:documentId`        |
| `closeSessionCanvasDocument(sessionId, documentId)`         | `DELETE /api/sessions/:id/canvas/:documentId`       |
| `setSessionCanvasEditing(sessionId, documentId, editing)`   | `POST /api/sessions/:id/canvas/:documentId/editing` |

- **`HttpTransport`** — a new `createSessionCanvasMethods(baseUrl)` factory under
  `apps/client/src/layers/shared/lib/transport/`, added to the declaration-merge list and the
  `Object.assign` in `http-transport.ts`, following `room-methods.ts` exactly.
- **`DirectTransport`** — real implementations against the in-process `CanvasService`, in a
  `direct/session-canvas-methods.ts` beside the other real session factories; the stub shape in
  `embedded-mode-stubs.ts` is the fall-back only if the embed cannot reach the database, and it
  refuses in a sentence rather than returning a plausible empty answer.
- **`createMockTransport`** (`packages/test-utils/src/mock-factories.ts:234`) — six `vi.fn()` entries
  with honest-empty defaults.

The routes live in a new `apps/server/src/routes/session-canvas.ts`, mounted under the sessions
router beside `session-devtools.ts` (`routes/sessions.ts:1478`), each registered in
`openapi-registry.ts`, with **both** regeneration steps run in the same commit
(`pnpm docs:export-api`, then `pnpm --filter=@dorkos/site generate:api-docs`) — running only the
first leaves the site publishing the old text while `git status` is clean.

There is no membership gate to write, because a session has no members: each route resolves the
caller and refuses anyone who is not the session's owner, the same way the rest of
`routes/sessions.ts` does. **An agent never reaches these routes**; its path is §1.8.

#### 1.7 `get_ui_state` stops guessing

`createGetUiStateHandler` (`ui-tools.ts:237-270`) has two arms today: in a room turn it answers about
the room's table (`:243-267`), and otherwise it returns `session.uiState ?? DEFAULT_UI_STATE`
(`:268`) — the client's last-sent snapshot with this turn's commands folded in optimistically.

The room arm is unchanged. The session arm keeps returning `UiState` for the parts the client owns
(panels, sidebar, agent) and **replaces the canvas part with a read of the table**:

```json
{
  "canvas": {
    "open": true,
    "viewers": 2,
    "documents": [
      {
        "id": "…",
        "type": "diff",
        "title": "src/router.ts",
        "author": "Kai",
        "pinned": false,
        "active": true
      }
    ],
    "count": 3
  },
  "panels": { "…": false },
  "sidebar": { "open": true, "activeTab": "sessions" },
  "agent": { "id": "…", "cwd": "…" }
}
```

**Two shapes, one of which stops travelling.** `UiState` is used for two different things today, and
that is the confusion to remove rather than reproduce:

- **What the client SENDS** — `ClientContext.uiState`, composed by `ui-state-snapshot.ts:66` and
  folded into the turn's context bag (`context-assembler.ts:165-166`). Its `canvas` field is
  `{ open, contentType }` — one nullable content type for a surface that has held twelve documents
  since DOR-219, and whose own TSDoc (`ui-state-snapshot.ts:30-31`) already says so. **`canvas` is
  removed from what the client sends**, because the server no longer needs the client's opinion of
  it. The client keeps sending panels, sidebar and agent.
- **What the tool RETURNS** — a new `UiStateReport` schema, composed server-side from
  `session.uiState`'s panel/sidebar/agent parts plus the canvas table. It is never parsed from a
  client, so it has no version boundary to respect and can carry exactly the shape above.

Splitting them is what makes `UiStateSchema.canvas`'s removal safe: an older client that still sends
`canvas` is simply ignored by a field the schema no longer declares, and no newer field is ever
required of a client at all. `applyUiCommandToState` (`ui-tools.ts:69-122`) loses its canvas arms
entirely — they existed to keep `contentType` plausible — and keeps only the panel, sidebar and agent
arms it is actually right about.

**The document shape is the one the room arm already uses**, so an agent reading a room's table and
its own session's table parses one thing: `{ id, type, title, author, pinned }`, exactly as
`get_ui_state`'s room arm returns today (`ui-tools.ts:243-267`). The session arm adds **one** field,
`active`, set on at most one document per view; the room arm does not, and must not, because a room
has **no shared active document** by design (`specs/room-canvas/` §9.3 — nothing steals anyone's
tab). That is the only difference between the two, and it is a difference in the world rather than in
the schema. A test asserts the two arms agree on the five shared keys.

`viewers` is **live readers of this session's stream**, the exact session parallel of
`RoomBroadcaster.subscriberCount`. `SessionStateProjector` gains `subscriberCount(): number`, counting
live `subscribe()` iterators rather than the parked waiters `getWaiterCount()` (`:2011`) reports —
a subscriber that is mid-delivery is still a viewer, and a count that said otherwise would be wrong
in exactly the busy moment somebody would check it. The tool's own words say what the number means:
`0` is nobody looking right now, and a higher number is windows, not people.

#### 1.8 `read_canvas_document` — the session read, with no session parameter

`rooms.read_canvas` (`room-capabilities.ts:1475-1516`) is unchanged: it takes a `roomId`, gates on
membership, and stays in the `rooms` domain with its `GUARDED_READ_ONLY_TOOL_NAMES` entry and its
always-loaded slot. It is about a room.

The session read is a **new `ui` capability** (§5), `ui.read_canvas_document`, tool name
`read_canvas_document`, tier `observe`, `servers: ['in-session']`:

```ts
input: z.object({
  documentId: z
    .string()
    .describe(
      'A document id from get_ui_state. Reads what is on your own canvas — the one in the window ' +
        'you are talking through.'
    ),
});
```

**It takes no session id, and that absence is the security property.** The handler reads
`context.sessionId` (`registry.ts:214` — present on the in-session surface, absent on external
`/mcp` and ordinary HTTP), builds `sessionScope(context.sessionId)`, and refuses with one sentence
when there is none. There is no argument an agent could pass to name a session that is not its own,
so "sessions are reachable by no agent but their own" (`specs/message-search/` §7, and the same rule
here) is enforced by the shape of the input rather than by a check that a later refactor could drop.

What comes back mirrors `rooms.read_canvas`'s document arm: a file-backed document (`file`,
`markdown` with `sourcePath`, `diff`) is read through the existing files route against the row's
stored `resolvedCwd`, so the process boundary check is unchanged; a `browser`/`url` document returns
its URL and nothing else; a `widget` returns its definition; a `json` returns its data. Byte caps
follow the files route's own. The list half is `get_ui_state` (§1.7); this verb reads one document,
which is why it is named for one.

#### Detailed Design §5 — the `ui` capability domain this phase creates (B5)

This phase creates the domain with exactly one capability, `ui.read_canvas_document`. The table below is the whole domain across the spec; the "Lands in" column says which phase adds each row, and only the `Q1` row is this PR's.

Today's five UI tools are hand-registered in `claude-code/mcp-tools/`, which is why Codex and OpenCode
do not have them — `register-from-definitions.ts:30-50` already states this as a fact with a name
attached. They become capabilities in a **`ui` domain**, declared in
`apps/server/src/services/session/ui-capabilities.ts` with its handlers in
`apps/server/src/services/session/browser-seat/`.

**`services/session/` rather than a new `services/ui/` domain**, because that is where the state these
verbs read already lives: `devtools-capture-store.ts` is a session service, the recording state joins
it, and the `ui` verbs are session-scoped by construction. (§1.2 does add one service domain,
`canvas`, for the opposite reason: a canvas that serves two scopes belongs to neither of them.)

Ids satisfy the conformance regex `/^[a-z0-9]+\.[a-z0-9_]+$/`
(`packages/test-utils/src/capability-conformance.ts:310`) — lowercase and snake_case, the shape
`rooms.read_canvas` already uses:

| Capability                | Tool name              | Tier      | Lands in   |
| ------------------------- | ---------------------- | --------- | ---------- |
| `ui.read_canvas_document` | `read_canvas_document` | `observe` | Q1         |
| `ui.click`                | `browser_click`        | `act`     | Q2         |
| `ui.type`                 | `browser_type`         | `act`     | Q2         |
| `ui.press`                | `browser_press`        | `act`     | Q2         |
| `ui.scroll`               | `browser_scroll`       | `act`     | Q2         |
| `ui.wait_for`             | `browser_wait_for`     | `observe` | Q2         |
| `ui.read_page`            | `browser_read_page`    | `observe` | Q2         |
| `ui.record_start`         | `browser_record_start` | `act`     | Q3         |
| `ui.record_stop`          | `browser_record_stop`  | `act`     | Q3         |
| `ui.control`              | `control_ui`           | `act`     | Q4 (moved) |
| `ui.state`                | `get_ui_state`         | `observe` | Q4 (moved) |
| `ui.read_console`         | `browser_read_console` | `observe` | Q4 (moved) |
| `ui.read_network`         | `browser_read_network` | `observe` | Q4 (moved) |
| `ui.screenshot`           | `browser_screenshot`   | `observe` | Q4 (moved) |

**This corrects the ideation's phase split, deliberately.** `01-ideation.md` puts the whole `ui`
domain in Q4 and the driving tools in Q2, which would mean registering six tools twice. Q1 creates the
domain with one capability, Q2 and Q3 add to it, and Q4 does the part that is actually about parity:
moving the five that exist and deleting their hand registrations. The phases and their dependency
order are unchanged.

**Every handler keys on `context.sessionId`**, which `CapabilityHandlerContext` carries on the
in-session surface and only there (`registry.ts:214`), and which the loopback server takes from the
verified `principal.claims.canonicalSessionId` rather than from anything a caller supplies
(`agent-runtime-server.ts:23-41`). A call with no session id is refused with the sentence
`SESSIONLESS_DEVTOOLS_ERROR` already uses (`devtools-tools.ts:116-122`) — the tools read what a live
session's window captured, and a surface with no session has no window.

#### Detailed Design §5 — the count guards this phase moves

**What changes in the guards, and the arithmetic to re-derive before each PR.** Every phase that adds
a verb reds a count guard _by design_; none of these numbers is a thing to "fix" by changing an
assertion without reading its comment trail.

| Guard                                                        | Today | After Q1 | Q2  | Q3  | Q4     |
| ------------------------------------------------------------ | ----- | -------- | --- | --- | ------ |
| `tool-exposure.test.ts:373` — in-session tools               | 92    | 93       | 99  | 101 | 101    |
| `tool-exposure.test.ts:374` — deferred                       | 83    | 84       | 90  | 92  | 92     |
| `tool-exposure.test.ts:287-323` — always-loaded              | 9     | 9        | 9   | 9   | 9      |
| `mcp-tool-gate.test.ts:317-323` — hand-registered in-session | 47    | 47       | 47  | 47  | **42** |
| `mcp-tool-gate.test.ts:317-323` — `MCP_TOOL_TIERS` keys      | 47    | 47       | 47  | 47  | **42** |
| `mcp-tool-gate.test.ts:317-323` — external                   | 40    | 40       | 40  | 40  | 40     |
| `AUTO_ALLOW_ACT_REASONS` entries (`:518-563`)                | 22    | 22       | 22  | 22  | 22     |

- **Always-loaded stays nine.** None of these verbs is one a turn cannot search for first, and the
  eager slot is the scarcest thing in the prompt. (While editing that test, fix its stale title: it
  says "exactly the eight" and asserts nine, since `read_canvas` joined in DOR-1999.)
- **The external count never moves.** The `ui` domain declares `servers: ['in-session']`, so nothing
  it adds reaches `/mcp`, and it contributes nothing to `READ_ONLY_MCP_TOOL_NAMES` or
  `GUARDED_READ_ONLY_TOOL_NAMES` (`tool-security.ts:160-177`). A test asserts that directly, which
  turns `register-from-definitions.ts:30-50`'s stated fact into a checked one.
- **`AUTO_ALLOW_ACT_REASONS` never moves either**, for the reason §2.5 gives: no phase edits
  `DORKOS_AGENT_TOOLS`, and that test pins the table against it in both directions (`:555-579`).
- **`capability-conformance.test.ts:472-580` `sampleInputs`** gains a realistic input per new
  capability id, or the conformance run cannot invoke it.

#### Data model changes — items 1 and 3-7 in full, and the first three sub-bullets of item 2

1. **`canvas_documents`** (`packages/db/src/schema/rooms.ts:1019-1116`), migration **`0097_*.sql`**
   (`0096_groovy_daredevil.sql` is the newest; renumber on a rebase rather than touching another
   branch's):
   - `room_id` becomes **nullable**, keeping its cascade FK for the rows that have one.
   - the four indexes move from `room_id` to `scope` (§1.1).
   - **new column** `threadRootEntryId: text('thread_root_entry_id')`, nullable, no index (§7).
   - SQLite recreates the table for both of those. **Read the generated SQL**: confirm all four
     indexes are present, the column list is complete, and the copy carries every row
     (`.claude/rules/testing.md:317`).
2. **Shared schemas**, every one additive or optional so an older client parses a newer server:
   - `SessionEventSchema` (`session-stream.ts:356-790`) gains a `canvas` member (§1.3);
     `devtools_capture_request` gains `targetClientId` and `documentId`, and
     `devtools_action_request` joins it (§2.2); `DevtoolsIngestSchema` (`schemas.ts:5750-5762`) gains
     `active` (§2.2).
   - `SessionSnapshotSchema` (`:897-920`) gains `canvas: CanvasDocument[]` (§1.4).
   - `UiStateSchema.canvas` (`schemas.ts:5585-5623`) is **removed** — the client stops sending its
     view of the canvas — and a new `UiStateReport` schema carries what `get_ui_state` returns
     (§1.7). This is the one **non-additive** schema change in the spec, and the split is what makes
     it safe: nothing new is ever required of a client, and the report is composed server-side and
     never parsed from one.
   - `UiCommandSchema` (`:5276-5285`) gains `target` on the six canvas verbs, and
     `CONTROL_UI_INPUT` (`ui-tool-contract.ts`) gains the matching optional field (§9).
   - `RoomSignalEventSchema` gains an optional `view` payload, carried on the existing `'presence'`
     signal. **`SignalTypeSchema` (`relay-envelope-schemas.ts:39-42`) is not touched** — declaring a
     new signal name is what `specs/rooms/02-specification.md:229` forbids (§6).
   - `rooms.post`'s capability input gains `attachments?: string[]` (§4).
   - `CanvasDocumentSchema` (`room-schemas.ts:888-940`) gains an optional `threadRootEntryId`.
3. **`Transport`** — six session-canvas methods under a new `// --- Session canvas ---` banner
   (§1.6), plus `RoomTransport.mergeRoomMain` in Q6 (§8) — the merge has never had a client method.
   Each lands in `HttpTransport`, `DirectTransport` and `createMockTransport`, or the build breaks.
4. **Removed, not deprecated:** `STORAGE_KEYS.CANVAS_SESSIONS` and `MAX_CANVAS_SESSIONS`
   (`constants.ts:9, 16`), `PersistedCanvasDocument`, `CanvasSessionEntry`, `readCanvasSession`,
   `writeCanvasSession` and their legacy normalizers (`app-store-helpers.ts:136-268`),
   `use-canvas-persistence.ts`, the `persist()` helper (`app-store-canvas.ts:373-386`), and the
   canvas arms of `applyUiCommandToState` (`ui-tools.ts:69-122`). `knip` catches what is missed.
5. **No config fields.** Every bound this spec adds is a constant in `constants.ts`'s `WORKBENCH`
   block, and every bound it reuses (`uploads.maxFiles`, `uploads.maxFileSize`,
   `rooms.maxPostsPerTurn`, `rooms.maxCanvasOpsPerTurn`) already exists. So there is no
   `config-schema.ts` edit, no `projectVersion` bump, no `CONFIG_MIGRATIONS` key, and no
   `merged-migration-hashes.ts` change — stated explicitly so a reviewer checks the claim rather
   than inferring it from silence.
6. **Retention for `session:` rows, because nothing cascades them.** A `room:` row is deleted by the
   room's `ON DELETE cascade`. A `session:` row has nothing to hang off: sessions are runtime-owned
   (ADR-0310) and **DorkOS has no session deletion at all** — there is no `DELETE /api/sessions/:id`
   in `routes/sessions.ts`, only `DELETE /:id/queue/:messageId` (`:1306`). What exists instead is a
   runtime **reporting a session gone**, and a two-phase precedent for reclaiming state behind it:

   - **Mark.** `onSessionRemoved` (`session-list-broadcaster.ts:656-677`) fires when a runtime's
     watcher reports a conversation no longer exists (`session-list-watcher.ts:119-129` →
     `session-list-broadcaster.ts:638`). `CanvasService` subscribes and records the id, exactly as
     `noteSessionOrphaned` does (`message-dispatcher.ts:2182-2183`, wired at `:2282`).
   - **Sweep.** `sweepOrphanedCanvasDocuments()` runs on the existing health-check interval beside
     `sweepOrphanedMessageQueues()` (`index.ts:4395-4402`) and deletes the `session:<id>` rows of
     marked ids that are **still** absent from the session listing. The deferral is the point of the
     pattern: a session that comes back between the mark and the sweep is not purged.
   - **The degradation rule, which the precedent does not need and this one does.**
     `GET /api/sessions` degrades per runtime and reports it in `warnings[]` (ADR-0310), and a runtime
     that failed to list is a runtime whose sessions all look absent. **The sweep skips every id
     belonging to a runtime that degraded in that listing**, and skips the whole pass when the listing
     itself failed — otherwise one flaky sidecar deletes every OpenCode canvas on the machine. A test
     drives exactly that: a degraded runtime, a marked session, zero rows deleted.
   - **`disposeProjector` is NOT the seam** (`session-state-projector.ts:2327-2338`, where
     `devtoolsCaptureStore.dropSession` hangs). That is idle eviction of in-memory state for a session
     that is still real and can resume; deleting durable rows there would lose a canvas to a timeout.

7. **`AGENTS.md`'s service-domain census** gains `canvas`, and
   `scripts/__tests__/agents-service-census.test.ts` fails until it does.

#### User Experience — the paragraphs this phase makes true

**Kai's session canvas follows him.** He opens a diff on his laptop, walks to the kitchen, opens the
same session on his phone: the diff is there. He closes it on the phone and it closes on the laptop.
Neither device had to be told about the other, and clearing his browser cache no longer costs him the
tab strip.

**Kai asks his agent what is on his canvas.** It calls `get_ui_state` and gets the real list — three
documents, their types and titles, which one is active, and that two windows are open on the session
right now. It reads the chart it made last turn back with `read_canvas_document` rather than
regenerating it.

#### Testing Strategy — Unit, `packages/shared`

- `SessionEventSchema` parses a `canvas` event **and still parses all 31 existing members**.
  _Catches a union edit that narrows an existing member._
- A `canvas` session event **carries a `seq`**, asserted structurally. _This is the inverse of the
  room frame's assertion, and the pair of them is what keeps the two streams' rules from being copied
  into each other._
- `SessionSnapshotSchema` accepts `canvas` and an old snapshot without it fails, since the field is
  required on the new contract — so the decorator cannot be forgotten in one transport.
- `get_ui_state`'s room arm and session arm return the same five document keys
  (`id`, `type`, `title`, `author`, `pinned`); only the session arm adds `active`.
- `UiStateSchema` no longer declares `canvas`, and a client that still sends one still parses;
  `UiStateReport` carries the documents, the count and the viewer count. _Catches the removal being
  done on the wrong side of the wire, which would break every older client's first turn._

#### Testing Strategy — Unit, `packages/db`

- The migration applies to a fresh database **and** to one seeded at `0096`; `canvas_documents` has
  all four indexes on `scope`, `room_id` is nullable, `thread_root_entry_id` exists, and the rows
  seeded before it survive with their content intact. _Catches the two silent failures a SQLite table
  recreate has: a dropped index and a lost column._
- A `session:` row survives deleting an unrelated room; a `room:` row does not survive deleting its
  own. _Catches a session document cascaded away by a room deletion._

#### Testing Strategy — Unit, `apps/server`, the canvas service (`services/canvas/__tests__/`)

- `CanvasService` writes and reads both scopes through one store, and the room flavour still refuses
  everything `RoomCanvasService` refuses today — the existing suite is **moved, not rewritten**, and
  must pass unchanged against the generalised service. _That is the regression bar for the move._
- A `session:` scope has **no per-turn ceiling and no ledger**: forty `apply` calls in one turn all
  land, `bookkeepingSize()` stays at zero open ledgers, and `finishTurn` posts nothing.
  _Catches the room's mechanisms leaking into a scope that has no audience to protect._
- A `session:` row is written with `room_id` null and a `room:` row with its room id; the invariant
  is asserted both ways.
- **`rekeyScope` moves every row of a scope in one transaction** and moves none of any other; a
  concurrent reader sees the old set or the new set, never a split; a document's `id` is unchanged by
  it, and re-opening the same source key after the rekey finds that row rather than inserting a
  second. _Catches the trap the whole phase turns on: a canvas written under the request UUID and
  stranded there when the SDK's canonical id arrives mid-first-turn._
- **The orphan sweep respects degradation.** A marked session whose runtime reported `warnings[]` in
  the listing is not swept; a listing that failed entirely sweeps nothing; a marked session genuinely
  absent from a healthy listing is swept. _Catches one flaky sidecar deleting every canvas it owns._
- The LRU evicts the 13th unpinned session document and publishes a `closed` event for it.
- Two tabs of one session opening the same file land on one document (`canvas_documents_source_unique`
  on `(scope, sourceKey)`), and two `json` opens land on two.

#### Testing Strategy — Unit, `apps/server`, the session stream seam

- A canvas write reaches an attached reader as a `canvas` event with a monotonic `seq`, through the
  **real** projector. _Catches an event minted but never ingested._
- `'canvas'` is in `EVENTS_OUTSIDE_THE_TURN`: a document opened mid-turn does **not** appear in
  `peekInProgressTurn()`, and one opened with no turn running does not open one. _Catches the exact
  bug that would make a canvas change look like agent output._
- It is **not** in `RECORDED_EVENT_TYPES`: nothing about it reaches the event store.
- A reader that disconnects, misses two writes and resumes with `Last-Event-ID` receives both, in
  order, with no snapshot. _Catches the gap the room stream needs a resync for and this one must not._
- A reader whose cursor is outside the window gets a cold snapshot whose `canvas` is the whole current
  table.
- `CanvasService` writing to a session with **no projector attached** does not throw and does not
  lose the row. _The normal case, and the one most likely to be coded as an error._

#### Testing Strategy — Client tests (RTL + jsdom, mock `Transport`)

- The canvas slice hydrates from `snapshot.canvas`, applies `opened`/`updated`/`closed` events, and
  **drops an event whose `rev` is not greater** than the row it holds.
- A local open writes through the transport, and a failed write reverts the optimistic apply and
  surfaces the server's sentence. _Catches the two disagreeing silently, which is today's whole
  problem in a new place._
- **The import runs once, and only when canonical**: a session with a `localStorage` entry and an
  empty server table POSTs its documents and deletes the entry; the same session on a second mount
  POSTs nothing; a session whose server table is non-empty POSTs nothing and still deletes the entry;
  **a session whose id is still the pre-rekey UUID POSTs nothing and deletes nothing** until the
  canonical id arrives; and a POST that fails leaves the entry in place for the next hydrate.
  _Catches the double-import, which would duplicate every `json` and `widget` document, and catches
  the worse one: deleting the only copy after writing it under a scope about to be renamed._
- A test greps `apps/client/src` for `dorkos-canvas-sessions` and for `writeCanvasSession` and fails
  on a hit. _Catches a retirement that left a caller behind._

#### Testing Strategy — Playwright (`apps/e2e`)

Built on the helpers rooms specs already use (`fixtures/rooms-api.ts`, `room-signals.ts`, the
`requireTestModeLeg` gate `room-autonomy.spec.ts:96-129` uses so a missing `TestModeRuntime` fails
loudly instead of starting a billable turn), and on `workbench/dev-server-preview.spec.ts`'s real
local dev server.

| Spec                                                | What it proves                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/workbench/session-canvas-sync.spec.ts` (new) | open a document in one context; a **second context on the same session** sees it without reloading; reload and the table is still there; close in one and it goes in the other; a brand-new session's first turn rekeys and the document is still there afterwards |

**Mocking strategy.** Server tests use a real SQLite database and the real capability registry, never
a mocked `CanvasService` — a mock here would encode the hypothesis rather than test it. The shim is
executed, never read. Client tests use the mock `Transport` through `TransportProvider`. The e2e leg
uses the deterministic test-mode runtime and a real local dev server.

**Before opening any PR in this spec**, run
`pnpm vitest run apps/server/src/services/runtimes apps/server/src/services/core packages/shared packages/db`
— every phase here touches a count guard or a schema census, and those failures read like unrelated
breaks if you have not been told to expect them.

#### Performance Considerations

- **Per-turn prompt cost is unchanged.** `get_ui_state` is called, not injected; the canvas section of
  a room's context is still labels only and still capped at 12 + pins; the driving tools are deferred,
  not always-loaded, so they cost nothing in a turn that does not search for them.
- **The session canvas adds one indexed query per stream connect** (`list` on `(scope, lastActiveAt)`)
  and one row write per canvas change. It **removes** a `localStorage` read-modify-write of the whole
  session map on every canvas mutation, which is the larger of the two costs today.

#### Security Considerations — item 6

6. **A session canvas is one person's.** `read_canvas_document` takes no session id, so there is no
   argument that could name another session (§1.8); the routes refuse a caller who is not the
   session's owner; and `session:` documents appear in no room's list and in no other session's
   snapshot.

#### Documentation

**`docs/guides/workbench.mdx`** — four sections change, all of them session-scoped prose today:

- **"Multi-Document Tabs"** gains one sentence: the canvas now lives on the server, so it is the same
  on every device you open the session on, and it survives clearing your browser data.

**`docs/concepts/rooms.mdx`** — this page still has **no mention of a canvas**; room-canvas P2c is the
phase that adds it and has not landed. This spec therefore **adds to that section rather than
creating one**, and its PR must read what P2c wrote before editing:

- the room-canvas section gains "Talking about a document" (the thread) and "Following somebody's
  browser" (people only, off by default, nothing recorded);
- the **"REST surface"** table gains the session-canvas routes and the two new devtools routes.

**`docs/guides/generative-ui.mdx`** — the **"Widgets in Chat"** paragraph (≈`:39-45`) is the one page
in the docs set that contradicts shipped code. It says a room message's buttons "that would open
something in the canvas, the browser or a terminal, are still shown but switched off". Since
room-canvas P0b, `ui`-channel actions in a room body **work**; only `agent`-channel actions are
disabled, because a room message is not a session to answer into. The paragraph is corrected to say
exactly that. **"Canvas Content Types"** gains a sentence naming which two types the Browser tab
renders, and **"Canvas"** gains the session canvas's new property: it is the server's, not the
browser's.

**`contributing/`** — `architecture.md`'s service-domain paragraph gains `canvas` and says why it is
its own domain; `adding-a-runtime.md` gains a sentence that a new runtime inherits the whole `ui`
domain for free through the loopback server and owes it no code, which is the point of Q4;
`api-reference.md` needs nothing beyond the regenerated spec, and **both** regeneration commands run
in the same commit.

**`AGENTS.md`** — the service-domain census line (§Data model changes 6).

**Changelog.** One fragment per PR in `changelog/unreleased/`, named `<YYMMDD-HHMMSS>-<kebab-slug>.md`
with an id from `.claude/scripts/id.ts`, carrying a `covers:` block on its very first lines listing
that PR's exact commit subjects. Bodies use only the seven allowed headings; an invalid heading has
silently deleted a fragment before. Run `pnpm exec prettier --write` on the fragment before
committing — hand-edited fragments are the most common source of the formatting gate going red.

The demo-claim gate applies to every page: the Obsidian shell has no Browser tab and no driving, and
no page says otherwise; a recording is described by what it is (a slideshow of the steps), never as
video.

#### Definition of done

- `packages/db` migration tests exist and pass: `0097_*.sql` applies to a fresh database and to one
  seeded at `0096`; all four indexes are on `scope`, `room_id` is nullable, `thread_root_entry_id`
  exists, and rows seeded before it keep their contents. The generated SQL was read by hand before it
  was committed.
- `apps/server/src/services/canvas/__tests__/` holds the moved room-canvas suite, passing **unchanged**
  against the generalised service, plus the new scope tests: the `room_id` invariant both ways, no
  ledger and no per-turn ceiling on a `session:` scope, `rekeyScope` moving every row of a scope in one
  transaction and leaving `id` alone, re-opening a source key after a rekey finding the same row, the
  LRU evicting the 13th unpinned document, and the orphan sweep skipping a degraded runtime.
- Session-stream seam tests pass through the **real** projector: a `canvas` event with a monotonic
  `seq` reaches an attached reader; `'canvas'` is in `EVENTS_OUTSIDE_THE_TURN` and not in
  `RECORDED_EVENT_TYPES`; a `Last-Event-ID` resume replays two missed writes in order with no snapshot;
  an out-of-window cursor gets a cold snapshot carrying the whole table; a write with no projector
  attached neither throws nor loses the row.
- `packages/shared` tests pass: the `canvas` member parses and all 31 existing members still parse;
  the event carries a `seq`; `SessionSnapshotSchema` requires `canvas`; the two `get_ui_state` arms
  agree on the five shared keys; `UiStateSchema` no longer declares `canvas` and an older client's
  payload still parses.
- Client tests pass: hydrate from `snapshot.canvas`, apply `opened`/`updated`/`closed`, drop a stale
  `rev`; a failed write reverts the optimistic apply and shows the server's sentence; the import runs
  once, POSTs nothing before the id is canonical, deletes nothing until every POST returned `201`; the
  grep test for `dorkos-canvas-sessions` and `writeCanvasSession` fails on a hit.
- `apps/e2e/tests/workbench/session-canvas-sync.spec.ts` exists and passes.
- Browser proof: two browser contexts on one session, a document opened in one appearing in the other
  without a reload, screenshotted in the PR — jsdom cannot prove cross-context delivery.
- `scripts/__tests__/agents-service-census.test.ts` passes with `canvas` added to `AGENTS.md`;
  `tool-exposure.test.ts` reads 93 in-session and 84 deferred, with the comment trail read first.
- Both OpenAPI regeneration commands ran in this commit (`pnpm docs:export-api`, then
  `pnpm --filter=@dorkos/site generate:api-docs`), and `git status` is clean afterwards.
- `pnpm --filter @dorkos/server typecheck`, `pnpm --filter @dorkos/client typecheck` and both lint runs
  are clean; `pnpm knip` reports no leftovers from the `localStorage` retirement.
- One changelog fragment in `changelog/unreleased/` with a `covers:` block and only the seven allowed
  headings, `pnpm exec prettier --write` run on it before committing.
- Adversarial review per `REVIEW.md` before the PR opens.
- **The full package suite runs before push**, not just the files you touched:
  `pnpm vitest run apps/server/src/services/runtimes apps/server/src/services/core packages/shared packages/db`,
  then `pnpm test -- --run`. Every phase here touches a count guard or a schema census, and those
  failures read like unrelated breaks if you have not been told to expect them.

---

### Task 1.2: Let an agent drive the embedded browser through the in-page shim

**Phase:** Q2 — Driving the browser (B2)
**Scope:** one PR. Independent of Q1; unblocks Q3, and together with Q1 unblocks Q4. Base branch
`ff3b94e15` — `origin/main` with room-canvas P0a, P0b, P1 and P2a merged.

#### Phase definition — create/modify and acceptance

**Create**

- `apps/server/src/services/session/browser-seat/{act-protocol,target,handlers,index}.ts` + tests
- `apps/server/src/routes/session-devtools-action.ts` (or a second handler in `session-devtools.ts`)
- `apps/e2e/tests/workbench/browser-driving.spec.ts`

**Modify**

- `apps/server/src/services/workbench-serve/devtools-shim.ts` — the `act-request`/`act-result` pair,
  the six commands, the accessibility outline walker
- `apps/server/src/services/session/devtools-capture-store.ts` — `awaitAction`, keyed by `requestId`
- `packages/shared/src/session-stream.ts` — `devtools_action_request`; `devtools_capture_request`
  gains `targetClientId` and `documentId`; `schemas.ts:5750-5762` — `DevtoolsIngestSchema.active`
- `apps/server/src/routes/session-devtools.ts` — read `X-Client-Id` (it does not today), the way
  `routes/sessions.ts:1212-1213` does, and pass it to the store
- `apps/server/src/services/session/devtools-capture-store.ts` — the per-session driver table, its
  claim/release, and its move across `rekeySession`
- `apps/client/src/layers/features/canvas/model/use-devtools-bridge.ts:341-363` — claim the seat from
  `activeBrowserDocumentId` and focus, answer only the addressed `targetClientId` + `documentId`, the
  `act-request` forward, the immediate `act-result` post, the rewritten comment
- `apps/server/src/services/session/ui-capabilities.ts` — six capabilities
- `apps/server/src/config/constants.ts` — the act timeout and the outline budget
- `tool-exposure.test.ts` (93→99, 84→90), `capability-conformance.test.ts` `sampleInputs`.
  `DORKOS_AGENT_TOOLS` and `AUTO_ALLOW_ACT_REASONS` are **not** touched (§2.5)
- `runtimes/shared/{ui-tool-contract,room-tools-context}.ts` and
  `claude-code/messaging/context-builder.ts` — the teaching paragraph
- `docs/guides/workbench.mdx`; a changelog fragment

**Acceptance:** in a real browser, an agent clicks a button by role and name, types into a field,
presses Enter, scrolls to an element, waits for text, and reads the page outline — each returning
what it did, **which document it acted on**, and where that page is; **with the same session open in
two windows**, a command with no `documentId` reaches exactly the window that most recently activated
a browser document and the other never sees it; a command naming a `documentId` reaches the window
holding it; the seat moves when the second window activates one; with nothing claimed, the tool
answers in a sentence immediately; two matches with no `nth` refuses rather than guessing; a page that
is open but not instrumented answers in a sentence **without** waiting out a timeout; `fetchIdle`
returns only after the shim's in-flight counter has been zero for 500 ms; nothing in the shim can
reach `/api/*`, asserted by a test that tries.

#### Detailed Design §2 — Driving the browser (B2)

#### 2.1 The shim command protocol

The shim already round-trips one command by `requestId`: the parent posts
`{ __dorkosDevtools: 'capture-request', requestId, lib? }` and the shim answers
`{ __dorkosDevtools: 'capture-result', requestId, dataUrl | error }` (`devtools-shim.ts:487-489`,
`:432-437`). Driving is the same shape with a command in it:

```ts
/** Parent → shim. One action to perform in this page. */
{
  __dorkosDevtools: 'act-request',
  requestId: string,
  /** The verb and its target. Discriminated on `action`. */
  command:
    | { action: 'click';    target: Target }
    | { action: 'type';     target?: Target; text: string; clear?: boolean; submit?: boolean }
    | { action: 'press';    key: string }
    | { action: 'scroll';   target?: Target; by?: number; to?: 'top' | 'bottom' }
    | { action: 'wait_for'; text?: string; selector?: string; gone?: boolean;
                            fetchIdle?: boolean; timeoutMs: number }
    | { action: 'read_page'; selector?: string; maxChars: number },
  /** Set while a recording is running: answer with a keyframe too (§3). */
  capture?: boolean,
}

/** Shim → parent. Exactly one per `requestId`, ever. */
{
  __dorkosDevtools: 'act-result',
  requestId: string,
  ok: boolean,
  /** What it did, in one line, when ok. */
  did?: string,
  /** How many elements the target matched, when the command had one. */
  matched?: number,
  /** Always present when ok: which document answered, and where its page is now. */
  documentId?: string,
  page?: { title: string; url: string; focused: string | null },
  /** read_page only. */
  outline?: string,
  truncated?: boolean,
  /** A data URL when `capture` was set and rasterizing succeeded. */
  dataUrl?: string,
  /** One plain sentence when !ok. */
  error?: string,
}

/** A `Target` names ONE element, by exactly one of three routes. */
type Target =
  | { role: string; name: string; nth?: number }
  | { text: string; nth?: number }
  | { selector: string; nth?: number };
```

Four properties the protocol has to hold, each of which the existing capture channel already holds
and which are easy to lose by rewriting rather than extending:

1. **The shim talks only to `window.parent`**, never to `/api/*`. The preview sandbox has no
   `allow-same-origin`, so the frame's origin is the opaque string `"null"` and it has no credential
   to send anywhere (`devtools-shim.ts:6-17`, ADR `260708-185519`). Driving changes nothing about
   that, which is the whole of why it is safe to leave on a permission mode rather than behind a
   consent door (§2.5).
2. **The guard is source identity, not origin.** `ev.source !== parent` on the shim side
   (`devtools-shim.ts:477`); `ev.source !== frame.contentWindow` plus the known-origin check on the
   parent side (`use-devtools-bridge.ts:244-246`). Every opaque frame reports the same `"null"`
   origin, so identity is the only thing that means anything.
3. **Exactly one result per `requestId`, and a timeout resolves rather than hangs.** The capture path
   proves the shape: `awaitScreenshot(requestId, timeoutMs)` resolves `undefined` after the timer
   (`devtools-capture-store.ts:230-241`) and the tool turns that into a structured note.
4. **An `act-result` bypasses the batch debounce** and is posted straight up, as `capture-result`
   already is (`use-devtools-bridge.ts:297-319`) — a tool call is awaiting it server-side.

The store gains the matching half: `awaitAction(requestId, timeoutMs)`, keyed by `requestId` alone
exactly as `awaitScreenshot` is, so a session rekey between request and result cannot strand it
(`devtools-capture-store.ts:206-214` says why). Results arrive through a new
`POST /api/sessions/:id/devtools/action` route beside the ingest route, with its own Zod schema,
`204`, and the same "pure sink, no session-existence check" posture `session-devtools.ts:54-64`
documents.

#### 2.2 One driver seat per session, arbitrated on the server

`use-devtools-bridge.ts:341-347` names the v1 limitation in full: the hook mounts once per open
browser document, the capture request carries no target, so **every** bridge forwards it and the
first ingest wins nondeterministically. Driving would make that worse — a click delivered to
whichever preview answered first is a click nobody can reason about.

**Resolving it against the client's own `activeBrowserDocumentId` does not fix it**, and §1 is the
reason: the headline of this spec is that one session is open in more than one window at a time. Two
windows each hold their own `activeBrowserDocumentId`, each would consider itself addressed, and the
race comes straight back with `act` verbs in it instead of screenshots. The arbiter has to be
somewhere there is exactly one of, and that is the server.

**The capture store keeps a driver table per session.** Each row is
`{ clientId, documentId, activeAt }`, capped at eight rows and evicted oldest-first; the **driver
seat** is the row with the greatest `activeAt`. It lives beside the capture buffers in
`DevtoolsCaptureStore`, keyed by session id like everything else there, and moves across a session
rekey with them (`rekeySession`, `devtools-capture-store.ts:283-289`).

**How a window claims the seat.** The bridge already posts to
`POST /api/sessions/:id/devtools/ingest`, and `DevtoolsIngestSchema` (`schemas.ts:5750-5762`) already
carries `documentId`. Two additions:

- The ingest body gains `active?: boolean` — "the browser document this window is showing is the one
  on screen". The bridge sets it when its document becomes the window's `activeBrowserDocumentId`,
  when the window regains focus, and on the handshake; it posts `active: false` on blur, on document
  close, and on unmount.
- The **route reads `X-Client-Id`**, which it does not today: `session-devtools.ts` validates the body
  and calls `ingest` with nothing else. It is read inline exactly as the three handlers that already
  read it do (`routes/sessions.ts:1212-1213`, `session-ui-action-handler.ts:80`,
  `session-command-intent-handler.ts:121`), including their `randomUUID()` fallback — a client that
  sends no id gets a stable-per-request one and simply never wins a seat it did not claim.

A claim with `active: true` sets that row's `activeAt` to now, which takes the seat. `active: false`
clears the row; if it held the seat, the seat falls to the next most recent row, and to nobody when
there is none.

**How a request is addressed.** `devtools_capture_request` and the new `devtools_action_request`
session events each carry **both** `targetClientId` and `documentId`, resolved **server-side** before
the request is minted:

| The tool passed              | The server addresses                                                |
| ---------------------------- | ------------------------------------------------------------------- |
| no `documentId`              | the seat: its `clientId` and its `documentId`                       |
| a `documentId`               | the most recent row for that document; its `clientId` is the target |
| a `documentId` nobody claims | nothing is minted — the tool answers immediately (below)            |
| nothing claimed at all       | nothing is minted — the tool answers immediately (below)            |

A bridge answers **only** when `event.targetClientId === transport.clientId` **and**
`event.documentId === this.documentId`. It consults `activeBrowserDocumentId` to decide what to
**claim**, never to decide what to **answer** — local state produces a claim, the server arbitrates,
and exactly one window is ever addressed. This closes the race for `browser_screenshot` too, which is
the bug `:341-347` documents; the stale comment there is **rewritten, not deleted**, so the next
reader finds the answer where the question was.

**The "no driver" sentence**, returned immediately rather than after a timeout:

> No window is showing a browser preview for this session right now, so there is nothing to drive.
> Open one with browser_navigate, or bring the window with the preview to the front.

and, when a `documentId` was named that no window is holding:

> No window has that page open any more. Call get_ui_state to see which browser tabs are open.

**Every driving result names the document it acted on** — `documentId` and the tab's `title` sit
beside `did`, `matched` and `page` (§2.3), so a turn that drove one of three previews can say which,
and a person reading the transcript can tell.

#### 2.3 The six tools

All six are registered as `ui` capabilities (§5) and reach claude-code, Codex and OpenCode alike.
Every one returns what it did, how many elements it matched, **which document it acted on** (its
`documentId` and tab title, §2.2) and one line of where that page is now — because an agent that
clicked something needs to know **what** it clicked, and in which of its previews, at least as much
as that the click succeeded.

```ts
/** Shared across the four verbs that name an element. Exactly one route must be given. */
const TARGET = {
  role: z
    .string()
    .optional()
    .describe(
      'An accessible role from browser_read_page, such as "button" or "link". Pair with name.'
    ),
  name: z
    .string()
    .optional()
    .describe(
      'The accessible name as browser_read_page printed it. Matched case-insensitively, whole string.'
    ),
  text: z
    .string()
    .optional()
    .describe('Visible text on the element. Use when the page has no roles worth naming.'),
  selector: z
    .string()
    .optional()
    .describe('A CSS selector. The last resort: it breaks whenever the markup changes.'),
  nth: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Which match to act on when several fit. Leave it out and several matches is an error, not a guess.'
    ),
};
const DOCUMENT = {
  documentId: z
    .string()
    .optional()
    .describe(
      'Which browser tab to act in. Leave it out for the one whose window last brought a preview ' +
        'to the front. Ids come from get_ui_state.'
    ),
};
```

| Tool                | Input beyond `DOCUMENT`                                                             | Answers                        |
| ------------------- | ----------------------------------------------------------------------------------- | ------------------------------ |
| `browser_click`     | `TARGET`                                                                            | `{ did, matched, page }`       |
| `browser_type`      | `TARGET` (optional — the focused field), `text` (≤ 10 000), `clear?`, `submit?`     | `{ did, matched, page }`       |
| `browser_press`     | `key` — one key or a chord, `"Enter"`, `"Escape"`, `"Control+a"`                    | `{ did, page }`                |
| `browser_scroll`    | `TARGET` (optional), `by?` (pixels, ±), `to?` (`top`/`bottom`)                      | `{ did, page }`                |
| `browser_wait_for`  | `text?`, `selector?`, `gone?`, `fetchIdle?`, `timeoutMs?` (≤ 10 000, default 5 000) | `{ did, waitedMs, page }`      |
| `browser_read_page` | `selector?` (a subtree root), nothing else                                          | `{ outline, truncated, page }` |

**Refusals are plain sentences, and each names the fix.** Zero or more than one targeting route:
"Name the element one way — a role and name, some visible text, or a CSS selector — not several."
No match: "Nothing on the page matched that. Call browser_read_page to see what is there." Several
matches with no `nth`: "Four things matched that. Pass nth to pick one, or name it more exactly."
An element that matched but cannot be clicked (hidden, disabled, zero-size): "That matched a
<button> that is disabled, so the click would do nothing."

**`fetchIdle`, named for what it actually measures.** The shim wraps `window.fetch`
(`devtools-shim.ts:319-354`) and `XMLHttpRequest.prototype.open`/`send` (`:357-394`) to record
completed requests; it keeps **no in-flight counter**, so nothing in the page knows what "network
idle" would mean, and nothing there can see an image, a stylesheet, a `sendBeacon`, a WebSocket or a
service worker at all. Calling the mode `networkIdle` would promise all of that. So the wrappers gain
one integer — incremented on entry, decremented in the settle path of both the success and the
failure branch of each — and the mode is called **`fetchIdle`**: _no `fetch` or `XMLHttpRequest` has
been in flight for 500 ms_. The tool's description says exactly that, including what it does not
cover, so an agent waiting on an image is told to wait on the element instead.

**A driving verb never navigates on its own**, and a click that navigates is reported as such: the
shim's existing `'navigated'` message (`devtools-shim.ts:397-401`) already fires on `pagehide`, and
the act result's `page.url` is read after the navigation settles or after 2 s, whichever comes first,
with `did` saying "the page went to …".

#### 2.4 `browser_read_page` (Q3 resolved)

A flattened accessibility outline, one line per node, indented two spaces per level:

```
document "Checkout — Acme"
  banner
    link "Acme"
    navigation
      link "Products"
      link "Cart" [3 items]
  main
    heading "Checkout" level=1
    form "Payment"
      textbox "Card number" [required]
      textbox "Expiry"
      button "Pay $42.00"
  status "Your card was declined." [live]
```

Each line is `role "accessible name" [state]`, with `state` carrying only what changes what the agent
should do: `disabled`, `required`, `checked`, `expanded`, `selected`, `invalid`, `hidden` is never
printed because hidden nodes are not walked. Nodes with neither a name nor a landmark role and
nothing under them are dropped, which is what keeps a real page inside the budget.

**The shim computes it with no library**, and the answer to "can it walk `aria` without one" is yes,
with one honest limitation:

- `Element.role` (ARIA reflection) gives an explicit role directly, and it is available in every
  browser DorkOS's preview runs in. For an element with no explicit role, a small implicit-role table
  covers the ~30 tags that matter (`a[href]`→link, `button`, `input[type]`→textbox/checkbox/radio/…,
  `h1`-`h6`→heading, `nav`→navigation, `main`, `header`→banner, `footer`→contentinfo, `form`,
  `table`/`tr`/`td`, `select`→combobox, `textarea`→textbox, `img[alt]`→img, `ul`/`ol`→list, `li`).
- The accessible name is `aria-label`, then `aria-labelledby` resolved one level, then a `<label for>`
  or wrapping `<label>`, then `alt`, then `title`, then `placeholder`, then the element's own trimmed
  text content capped at 120 characters.
- **This is not the full accname algorithm**, and the tool's description says so in one sentence:
  it is what a person reading the page would call the thing, computed cheaply, and an agent that
  cannot find something by name is told to fall back to a selector. Claiming accname conformance
  would be a claim nothing here verifies.

Visibility is `checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })` where available,
falling back to an offset-parent-and-rects check. Budget: `maxChars` defaults to 32 768 (half the
`RESULT_BUDGET_CHARS` the console reads already use, `devtools-tools.ts:76`) and hard-caps at 65 536;
past it the outline is truncated **breadth-first from the deepest nodes**, so the page's structure
survives and its leaves are what is lost, and `truncated: true` says so.

#### 2.5 Tiers, reach, approval, and the no-preview path

| Property     | Value                                                                            |
| ------------ | -------------------------------------------------------------------------------- |
| tier         | `act` for click/type/press/scroll; `observe` for `wait_for` and `read_page`      |
| reach        | `client-only` — the same reach the canvas actions carry (`schemas.ts:5463-5481`) |
| MCP servers  | `['in-session']` only. Never `/mcp`                                              |
| auto-allowed | **no** — see below                                                               |
| annotations  | `readOnlyHint: true` for `browser_read_page` and `browser_wait_for` only         |

`servers: ['in-session']` is the load-bearing half. The in-session surface is **both** the claude-code
in-process server and the loopback `dorkos` server Codex and OpenCode are injected with
(`agent-runtime-server.ts:23-41` registers with `'in-session'`), so declaring it reaches all three
runtimes **and** keeps these tools off the external `/mcp` exactly as
`register-from-definitions.ts:30-50` describes today. A test asserts no `ui.*` tool is registered on
the external server, which turns that paragraph's stated fact into a checked one.

**Not auto-allowed, and that corrects the ideation.** `01-ideation.md` B2 says the driving tools are
"auto-allowed with a justification sentence in the table". The code says the precedent runs the other
way. Auto-allow is membership of `DORKOS_AGENT_TOOLS` (`interactive-handlers.ts:116-170`), which the
gate reads at `:855` — and the three existing `browser_*` tools are **not** on it, while
`READ_ONLY_TOOLS` (`:44-52`) holds only Claude Code's own built-ins. So a `browser_read_console` call
already raises an approval card under any asking mode. Driving a page is strictly more consequential
than reading its console; putting the driving verbs on the auto-allow list while the reads stay off it
would be backwards. Therefore:

- **no phase edits `DORKOS_AGENT_TOOLS`**, and `AUTO_ALLOW_ACT_REASONS` (`mcp-tool-gate.test.ts:518-563`)
  keeps its 22 entries through every phase. That test pins the set **both ways**
  (`:555-579`: `needsAReason` from `DORKOS_AGENT_TOOLS ∩ (act ∨ identity-scoped)` must `toEqual` the
  table's keys), so an entry added without a list change fails just as loudly as one omitted.
- The driving verbs are decided by the session's permission mode like every other unlisted tool: under
  the shipped `bypassPermissions` default they do not prompt, and under an asking mode the person sees
  a card the first time an agent clicks something. For a verb that acts on a page, that is the right
  default.
- Each verb's description carries the sentence that would have been the justification, because it is
  what a person reading that card needs:

  > Acts only inside the sandboxed preview frame DorkOS itself serves — an opaque origin with no
  > credentials, no reach to `/api/*`, and no path to the machine. It is the same frame
  > `browser_screenshot` already reads, and the same page you are looking at.

**Q4 must not change `control_ui`'s auto-allow, and that is a test, not a hope.** `control_ui` and
`get_ui_state` **are** on `DORKOS_AGENT_TOOLS`, by their prefixed in-session names, and
`isAutoAllowedCall` (`interactive-handlers.ts:416-421`) additionally gates `control_ui` per argument
on `UI_COMMAND_REACH[action] === 'client-only'`. A capability registered on the in-session server
produces the **same** prefixed tool name, so the move in §5 leaves both mechanisms working untouched —
and a test asserts a `control_ui` call with a `client-only` action still auto-allows, and one with
`apply_layout` still does not, after the move.

**The no-preview path, three distinct answers instead of one silence.** Today a capture with nothing
open waits 8 s and then returns `NO_PREVIEW_NOTE`. Driving distinguishes:

1. **No browser document open** — answered immediately, before any request is minted, with
   `NO_PREVIEW_NOTE` verbatim (`devtools-tools.ts:125-128`), which already tells the agent to open one
   with `browser_navigate` and already says external sites are not instrumented.
2. **A document open, but its frame never handshook** — the direct-loopback fallback
   (`use-resolved-frame.ts:205-213`) and any externally framed URL load with no shim, so the bridge
   knows within its own state that no `'hello'` ever arrived. It answers immediately:

   > That page is open but DorkOS is not instrumenting it, so it cannot be driven or read from here.
   > A local file or a dev server preview can be; a page loaded straight from the internet cannot.

3. **Instrumented, and the command genuinely timed out** — the plain failure the timeout produces,
   naming the command and the wait.

The first two are the interesting ones, because they replace an eight-second pause and a misleading
note with an instant, true sentence.

#### Detailed Design §5 — the six capabilities this phase adds to the `ui` domain

Q1 creates the domain; this phase fills it with six more capabilities. The table is the whole domain across the spec, and its "Lands in" column says which phase adds each row — the six `Q2` rows are this PR's.

Today's five UI tools are hand-registered in `claude-code/mcp-tools/`, which is why Codex and OpenCode
do not have them — `register-from-definitions.ts:30-50` already states this as a fact with a name
attached. They become capabilities in a **`ui` domain**, declared in
`apps/server/src/services/session/ui-capabilities.ts` with its handlers in
`apps/server/src/services/session/browser-seat/`.

**`services/session/` rather than a new `services/ui/` domain**, because that is where the state these
verbs read already lives: `devtools-capture-store.ts` is a session service, the recording state joins
it, and the `ui` verbs are session-scoped by construction. (§1.2 does add one service domain,
`canvas`, for the opposite reason: a canvas that serves two scopes belongs to neither of them.)

Ids satisfy the conformance regex `/^[a-z0-9]+\.[a-z0-9_]+$/`
(`packages/test-utils/src/capability-conformance.ts:310`) — lowercase and snake_case, the shape
`rooms.read_canvas` already uses:

| Capability                | Tool name              | Tier      | Lands in   |
| ------------------------- | ---------------------- | --------- | ---------- |
| `ui.read_canvas_document` | `read_canvas_document` | `observe` | Q1         |
| `ui.click`                | `browser_click`        | `act`     | Q2         |
| `ui.type`                 | `browser_type`         | `act`     | Q2         |
| `ui.press`                | `browser_press`        | `act`     | Q2         |
| `ui.scroll`               | `browser_scroll`       | `act`     | Q2         |
| `ui.wait_for`             | `browser_wait_for`     | `observe` | Q2         |
| `ui.read_page`            | `browser_read_page`    | `observe` | Q2         |
| `ui.record_start`         | `browser_record_start` | `act`     | Q3         |
| `ui.record_stop`          | `browser_record_stop`  | `act`     | Q3         |
| `ui.control`              | `control_ui`           | `act`     | Q4 (moved) |
| `ui.state`                | `get_ui_state`         | `observe` | Q4 (moved) |
| `ui.read_console`         | `browser_read_console` | `observe` | Q4 (moved) |
| `ui.read_network`         | `browser_read_network` | `observe` | Q4 (moved) |
| `ui.screenshot`           | `browser_screenshot`   | `observe` | Q4 (moved) |

**This corrects the ideation's phase split, deliberately.** `01-ideation.md` puts the whole `ui`
domain in Q4 and the driving tools in Q2, which would mean registering six tools twice. Q1 creates the
domain with one capability, Q2 and Q3 add to it, and Q4 does the part that is actually about parity:
moving the five that exist and deleting their hand registrations. The phases and their dependency
order are unchanged.

**Every handler keys on `context.sessionId`**, which `CapabilityHandlerContext` carries on the
in-session surface and only there (`registry.ts:214`), and which the loopback server takes from the
verified `principal.claims.canonicalSessionId` rather than from anything a caller supplies
(`agent-runtime-server.ts:23-41`). A call with no session id is refused with the sentence
`SESSIONLESS_DEVTOOLS_ERROR` already uses (`devtools-tools.ts:116-122`) — the tools read what a live
session's window captured, and a surface with no session has no window.

#### Detailed Design §5 — the count guards this phase moves

**What changes in the guards, and the arithmetic to re-derive before each PR.** Every phase that adds
a verb reds a count guard _by design_; none of these numbers is a thing to "fix" by changing an
assertion without reading its comment trail.

| Guard                                                        | Today | After Q1 | Q2  | Q3  | Q4     |
| ------------------------------------------------------------ | ----- | -------- | --- | --- | ------ |
| `tool-exposure.test.ts:373` — in-session tools               | 92    | 93       | 99  | 101 | 101    |
| `tool-exposure.test.ts:374` — deferred                       | 83    | 84       | 90  | 92  | 92     |
| `tool-exposure.test.ts:287-323` — always-loaded              | 9     | 9        | 9   | 9   | 9      |
| `mcp-tool-gate.test.ts:317-323` — hand-registered in-session | 47    | 47       | 47  | 47  | **42** |
| `mcp-tool-gate.test.ts:317-323` — `MCP_TOOL_TIERS` keys      | 47    | 47       | 47  | 47  | **42** |
| `mcp-tool-gate.test.ts:317-323` — external                   | 40    | 40       | 40  | 40  | 40     |
| `AUTO_ALLOW_ACT_REASONS` entries (`:518-563`)                | 22    | 22       | 22  | 22  | 22     |

- **Always-loaded stays nine.** None of these verbs is one a turn cannot search for first, and the
  eager slot is the scarcest thing in the prompt. (While editing that test, fix its stale title: it
  says "exactly the eight" and asserts nine, since `read_canvas` joined in DOR-1999.)
- **The external count never moves.** The `ui` domain declares `servers: ['in-session']`, so nothing
  it adds reaches `/mcp`, and it contributes nothing to `READ_ONLY_MCP_TOOL_NAMES` or
  `GUARDED_READ_ONLY_TOOL_NAMES` (`tool-security.ts:160-177`). A test asserts that directly, which
  turns `register-from-definitions.ts:30-50`'s stated fact into a checked one.
- **`AUTO_ALLOW_ACT_REASONS` never moves either**, for the reason §2.5 gives: no phase edits
  `DORKOS_AGENT_TOOLS`, and that test pins the table against it in both directions (`:555-579`).
- **`capability-conformance.test.ts:472-580` `sampleInputs`** gains a realistic input per new
  capability id, or the conformance run cannot invoke it.

#### Data model changes — item 2, the sub-bullets this phase lands

2. **Shared schemas**, every one additive or optional so an older client parses a newer server:
   - `SessionEventSchema` (`session-stream.ts:356-790`) gains a `canvas` member (§1.3);
     `devtools_capture_request` gains `targetClientId` and `documentId`, and
     `devtools_action_request` joins it (§2.2); `DevtoolsIngestSchema` (`schemas.ts:5750-5762`) gains
     `active` (§2.2).

   The `canvas` member is Q1's; `targetClientId`, `documentId`, `devtools_action_request` and
   `DevtoolsIngestSchema.active` are this phase's.

#### Data model changes — item 5, which this phase must keep true

5. **No config fields.** Every bound this spec adds is a constant in `constants.ts`'s `WORKBENCH`
   block, and every bound it reuses (`uploads.maxFiles`, `uploads.maxFileSize`,
   `rooms.maxPostsPerTurn`, `rooms.maxCanvasOpsPerTurn`) already exists. So there is no
   `config-schema.ts` edit, no `projectVersion` bump, no `CONFIG_MIGRATIONS` key, and no
   `merged-migration-hashes.ts` change — stated explicitly so a reviewer checks the claim rather
   than inferring it from silence.

#### User Experience — the paragraphs this phase makes true

**Ikechi asks his agent to check the signup form.** He has a dev server running and its preview open
in the Browser tab. He types "sign up as test@example.com and tell me what happens". The agent calls
`browser_read_page`, sees `textbox "Email"` and `button "Create account"`, types, clicks, waits for
the page to settle, and answers: "It accepted the email and then showed 'Something went wrong' —
the console has a 500 from `/api/signup`." It pasted no HTML, and it did not guess.

**Error and exit paths.** Nothing open to drive: one sentence naming `browser_navigate`. A page that
is open but not instrumented: one sentence saying so, immediately, instead of an eight-second pause.
A target that matched nothing, or four things: a sentence naming the fix. A recording over its frame
ceiling: it keeps working and says it stopped filming. An attachment over the size cap: the file and
the limit, by name. A merge behind main: the merge service's own words. Every one of them is a
refusal the agent can act on without asking a person.

#### Detailed Design §10 — Bounds, honesty, etiquette (B10)

- **Driving is work, not speech.** No driving verb, recording verb, or canvas write triggers a turn
  for anybody. The only thing in this spec that puts a line in a room's log is a `post_to_room` an
  agent chose to write (§4) and the once-per-turn coalesced canvas line that already exists.
- **Every bound here is a mechanism.** Frames and bytes for a recording (§3.3); `uploads.maxFiles` and
  `uploads.maxFileSize` for attachments (§4); the derived synthetic turn id for `target` (§9); the
  publish-only-while-followed rule for follow mode (§6). None of them is a sentence in a prompt, and
  none may be replaced by one (`.claude/rules/room-conduct.md`, "Bounds are mechanisms, never
  prompts").
- **No new trigger, anywhere.** Nothing in this spec calls the trigger dispatcher. A conformance case
  and an e2e assertion both read that off the dispatcher rather than off a sleep.
- **Every tool result says what happened.** A timeout is a plain failure naming the command and the
  wait. A refusal names the fix. A recording that hit its ceiling says so and keeps working. Nothing
  reports success for something that did not happen — the property `specs/room-canvas/` §5.5
  establishes, extended to the browser seat.
- **The teaching is one paragraph, not a manual.** `buildRoomToolsBlock`
  (`room-tools-context.ts:97-100`) and the session `<ui_tools>` block each gain three sentences: that
  the browser can be driven and read on an instrumented preview, that a recording is frames of what
  you did and lands in a file you can post, and that a screenshot or a recording belongs in the room
  as an attachment rather than described in prose (E9, E14). Written out in each variant rather than
  shared, per that file's own rule at `:85-88`.

#### Testing Strategy — Unit, `apps/server`, the browser seat

Every bullet below except the recording one is this phase's; the recording bullet is quoted because the state machine it describes is Q3's and the `capture` flag on `act-request` this phase adds is what it rides.

- **A devtools-shim test against a real page, one per driving command.** `devtools-shim.ts` is a
  string of source injected into a page, so it is tested by evaluating it in a real document and
  posting it real messages. jsdom is enough for `click`, `type`, `press`, `scroll`, `read_page` and
  the target resolution; **`wait_for` with `fetchIdle` and the visibility checks run in Playwright**
  (`apps/e2e`), because jsdom has neither a layout engine nor `checkVisibility`. Each asserts the
  `act-result` shape, including `matched`, and that exactly one result is posted per `requestId`.
  _Catches the whole class this spec's memory warns about: reading the shim's source and reasoning
  about it yields confident wrong conclusions; it has to be executed._
- Target resolution: role+name, visible text, and selector each find the right element; two matches
  with no `nth` is a refusal, not a guess; zero matches names `browser_read_page` as the fix.
- `fetchIdle` waits on the shim's new in-flight counter: it does not return while a `fetch` is
  pending, does return 500 ms after the last one settles, and returns just as promptly after one that
  **rejected**. _The decrement in the failure branch is the half that gets forgotten, and forgetting
  it wedges every later wait for the life of the page._
- `browser_read_page` prints the outline shape of §2.4 for a page with landmarks, forms and a live
  region; a node with no name, no landmark role and no children is dropped; over the budget it
  truncates from the deepest nodes and sets `truncated`.
- **Capture store**: `awaitAction(requestId, timeoutMs)` resolves the result, resolves `undefined` at
  the timeout, and resolves the result across a `rekeySession` between request and answer. _Catches
  the stranding `devtools-capture-store.ts:206-214` already avoided for screenshots._
- **The driver seat, asserted on the server**: two client ids claim browser documents for one
  session; the seat is the later claim; a request with no `documentId` resolves to that client and
  that document; a request naming the other document resolves to the other client; releasing the seat
  moves it to the remaining claim and then to nobody. _This is the test that closes
  `use-devtools-bridge.ts:341-347` — and it is a server test, because a client test could only prove
  that one window behaves, which is exactly what is already true and already insufficient._
- **And on the client**: a bridge ignores a request whose `targetClientId` is not its own even when
  its own document is the active one, and ignores one whose `documentId` is not its own even when it
  holds the seat. _Catches the arbiter being re-derived locally, which is the bug in a new place._
- The three no-preview answers of §2.5 are distinguished, and the first two return **without waiting
  out a timeout** — asserted on elapsed time against a fake clock, not on the text alone.
- **Recording**: the state machine's eight transitions, including a second `record_start` refused, a
  ceiling that keeps driving and stops filming, and a document close that drops the buffer; the GIF
  upload writes to `{cwd}/.dork/.temp/recordings/<id>.gif` and resolves the waiter; an upload over the
  multer cap answers `413` and the tool says so.
- The encoder itself is tested in the **client**: `gifenc` encodes three known frames into a GIF whose
  header, logical screen size and frame count are asserted by parsing the bytes back. _Catches an
  encoder integration that produces a file no decoder accepts._

#### Testing Strategy — Playwright (`apps/e2e`)

Built on the helpers rooms specs already use (`fixtures/rooms-api.ts`, `room-signals.ts`, the
`requireTestModeLeg` gate `room-autonomy.spec.ts:96-129` uses so a missing `TestModeRuntime` fails
loudly instead of starting a billable turn), and on `workbench/dev-server-preview.spec.ts`'s real
local dev server.

| Spec                                            | What it proves                                                                                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/workbench/browser-driving.spec.ts` (new) | a real page in the real preview frame is clicked, typed into, scrolled and read back; `wait_for` with `fetchIdle`; the visibility rules jsdom cannot see; **two windows on one session, and only the seat holder answers** |

| `tests/workbench/dev-server-preview.spec.ts` (existing) | still passes; its console assertion is the one that proves the shim survived the protocol extension |

**Mocking strategy.** Server tests use a real SQLite database and the real capability registry, never
a mocked `CanvasService` — a mock here would encode the hypothesis rather than test it. The shim is
executed, never read. Client tests use the mock `Transport` through `TransportProvider`. The e2e leg
uses the deterministic test-mode runtime and a real local dev server.

**Before opening any PR in this spec**, run
`pnpm vitest run apps/server/src/services/runtimes apps/server/src/services/core packages/shared packages/db`
— every phase here touches a count guard or a schema census, and those failures read like unrelated
breaks if you have not been told to expect them.

#### Performance Considerations

- **Per-turn prompt cost is unchanged.** `get_ui_state` is called, not injected; the canvas section of
  a room's context is still labels only and still capped at 12 + pins; the driving tools are deferred,
  not always-loaded, so they cost nothing in a turn that does not search for them.
- **One round trip per action.** The keyframe rides the `act-result` rather than taking a second
  request, so a recorded 20-action run is 20 messages, not 40.

#### Security Considerations — items 1, 2 and 8

1. **Driving stays inside the opaque-origin frame and cannot reach `/api/*`.** The shim talks only to
   `window.parent` (`devtools-shim.ts:6-17`); the preview sandbox has no `allow-same-origin`, so the
   frame has no credential and no same-origin path to the API (ADR `260708-185519`). Driving adds
   verbs to a channel that already exists and widens the channel not at all. Both ends keep the
   source-identity guard (`:477`, `use-devtools-bridge.ts:244-246`), which is the only guard that
   means anything when every frame reports `"null"`.
2. **Only instrumented previews are driven.** A page framed without the shim never handshakes, so
   there is nothing to drive; the tool says so in a sentence rather than trying. External sites are
   not instrumented today and are not instrumented by this spec.
3. **Prompt injection through a page.** `browser_read_page` returns text an arbitrary local page
   authored. It is tool output, so it is already outside the trusted preamble everywhere it is
   rendered, and it is capped. It is **not** put into any room's context block — nothing in this spec
   adds page content to a prompt that was not the result of a tool call the agent made.

#### Documentation

**`docs/guides/workbench.mdx`** — four sections change, all of them session-scoped prose today:

- **"Browser: Preview Without Leaving DorkOS"** gains what the browser can now do beyond showing a
  page: an agent can click, type and read it back, and can record what it did. Written as what
  happens for the person ("ask your agent to try the signup form and it will"), never as a tool list.
- **"Agents Can Drive the Workbench for You"** is the section whose title finally becomes literally
  true; its list gains the six driving verbs in plain words, and the sentence that this only works on
  a preview DorkOS is serving — a page loaded straight from the internet is shown, not driven.
  **`docs/concepts/rooms.mdx`** — this page still has **no mention of a canvas**; room-canvas P2c is the
  phase that adds it and has not landed. This spec therefore **adds to that section rather than
  creating one**, and its PR must read what P2c wrote before editing:

- the room-canvas section gains "Talking about a document" (the thread) and "Following somebody's
  browser" (people only, off by default, nothing recorded);
- the **"REST surface"** table gains the session-canvas routes and the two new devtools routes.

**Skills** — `chat:self-test` gains a browser-driving leg (drive a served page, assert the outline and
the click); `chat:rooms-test` gains an attachment leg (an agent posts a file, the other member's turn
can open it).

**Changelog.** One fragment per PR in `changelog/unreleased/`, named `<YYMMDD-HHMMSS>-<kebab-slug>.md`
with an id from `.claude/scripts/id.ts`, carrying a `covers:` block on its very first lines listing
that PR's exact commit subjects. Bodies use only the seven allowed headings; an invalid heading has
silently deleted a fragment before. Run `pnpm exec prettier --write` on the fragment before
committing — hand-edited fragments are the most common source of the formatting gate going red.

The demo-claim gate applies to every page: the Obsidian shell has no Browser tab and no driving, and
no page says otherwise; a recording is described by what it is (a slideshow of the steps), never as
video.

#### Definition of done

- A devtools-shim test file exists with **one test per driving command**, each executing the shim's
  source in a real document and posting it real messages, asserting the `act-result` shape including
  `matched` and exactly one result per `requestId`. The shim is executed, never read.
- Target-resolution tests: role+name, visible text and selector each find the right element; two
  matches with no `nth` refuses; zero matches names `browser_read_page` as the fix; a matched but
  disabled element refuses with the sentence naming what it matched.
- `fetchIdle` tests: it does not return while a `fetch` is pending, returns 500 ms after the last one
  settles, and returns just as promptly after one that **rejected** — the decrement in the failure
  branch is asserted, because forgetting it wedges every later wait for the life of the page.
- `browser_read_page` tests: the §2.4 outline shape for a page with landmarks, forms and a live region;
  an unnamed, unlandmarked, childless node dropped; over-budget truncation from the deepest nodes with
  `truncated` set.
- Capture-store tests: `awaitAction(requestId, timeoutMs)` resolves the result, resolves `undefined` at
  the timeout, and resolves across a `rekeySession` between request and answer.
- **The driver-seat test on the server**: two client ids claim documents for one session; the seat is
  the later claim; a request with no `documentId` resolves to that client and that document; a request
  naming the other document resolves to the other client; releasing moves the seat and then empties it.
  This is the test that closes `use-devtools-bridge.ts:341-347`, and it is a server test on purpose.
- The client half: a bridge ignores a request whose `targetClientId` is not its own even when its own
  document is active, and ignores one whose `documentId` is not its own even when it holds the seat.
- The three no-preview answers are distinguished and the first two return **without waiting out a
  timeout**, asserted on elapsed time against a fake clock rather than on the text.
- A test asserts nothing in the shim can reach `/api/*`.
- `apps/e2e/tests/workbench/browser-driving.spec.ts` exists and passes, including the two-windows leg;
  `apps/e2e/tests/workbench/dev-server-preview.spec.ts` still passes — its console assertion is what
  proves the shim survived the protocol extension.
- Browser proof: an agent clicking, typing and reading back a real page in the real preview frame,
  screenshotted or recorded in the PR — jsdom has neither a layout engine nor `checkVisibility`.
- `tool-exposure.test.ts` reads 99 in-session and 90 deferred, always-loaded stays 9, external stays
  40, and `AUTO_ALLOW_ACT_REASONS` still has its 22 entries — `DORKOS_AGENT_TOOLS` is **not** edited by
  this phase.
- `pnpm --filter @dorkos/server typecheck`, `pnpm --filter @dorkos/client typecheck` and both lint runs
  are clean.
- One changelog fragment in `changelog/unreleased/` with a `covers:` block and only the seven allowed
  headings, `pnpm exec prettier --write` run on it before committing.
- Adversarial review per `REVIEW.md` before the PR opens.
- **The full package suite runs before push**, not just the files you touched:
  `pnpm vitest run apps/server/src/services/runtimes apps/server/src/services/core packages/shared packages/db`,
  then `pnpm test -- --run`.

---

### Task 2.1: Record a run as a GIF and let an agent post attachments to a room

**Phase:** Q3 — Recording and agent attachments (B3, B4) — depends on Q2
**Scope:** one PR. It needs Q2's `act-request`/`act-result` round trip on `main`, because a keyframe
rides the `capture?: boolean` flag Q2 puts on that message. It blocks nothing.

#### Phase definition — create/modify and acceptance

**Create**

- `apps/client/src/layers/features/canvas/lib/load-gif-encoder.ts` + the recording buffer
- `apps/server/src/routes/session-recording.ts` (multipart, reusing `upload-handler`)
- `apps/e2e/tests/rooms/room-agent-attachment.spec.ts`

**Modify**

- `devtools-capture-store.ts` — `RecordingState` and its transitions
- `devtools-shim.ts` — the `capture` flag on `act-request`
- `ui-capabilities.ts` — `ui.record_start`, `ui.record_stop`
- `apps/server/src/services/rooms/room-capabilities.ts:669-729` — `post_to_room.attachments`,
  resolved with `resolveWithinCwd` (`lib/file-route-guards.ts:137-146`); the store/row/bind path
  beside `services/rooms/attachments/`
- `apps/server/src/config/constants.ts` — the five recording bounds, `RECORDING_STOP_TIMEOUT_MS`
  included
- `apps/client/package.json` — `gifenc`
- `tool-exposure.test.ts` (99→101, 90→92); `mcp-tool-gate.test.ts` is NOT edited — driving verbs are not on `DORKOS_AGENT_TOOLS`, so `AUTO_ALLOW_ACT_REASONS` keeps its 22 entries (§2.5)
- `docs/guides/workbench.mdx`, `docs/concepts/rooms.mdx`; a changelog fragment

**Acceptance:** a recorded run of four actions produces a GIF whose bytes parse as a GIF with six
frames (start, four actions, stop), at the recording size, under the byte cap; the file is at
`{cwd}/.dork/.temp/recordings/<id>.gif` and the tool answers with the path and the final frame, never
the GIF; a stop that never comes back fails plainly at 30 s and claims no file; a second
`record_start` is refused; the frame ceiling stops filming and keeps driving; an
agent posts that file to a room with one `post_to_room` call, it renders inline for members, and the
next turn of a second agent finds it hardlinked in its own working copy; a path outside the **agent's own cwd** — another member's
worktree in the same room, reachable under the global boundary — is refused and writes nothing; the
human upload route still refuses agents.

#### Detailed Design §3 — Recording (B3)

#### 3.1 The state machine

Two tools, `browser_record_start` and `browser_record_stop`, and exactly one recording per session at
a time. The state lives beside the capture buffers, in `DevtoolsCaptureStore`, keyed by session id
like everything else there:

```ts
interface RecordingState {
  /** ULID. Names the file and the upload. */
  id: string;
  /** Which browser document is being recorded. Resolved at start, never `null` afterwards. */
  documentId: string;
  startedAt: number;
  /** Frames the client has accepted so far, for the ceiling and for the tool's answer. */
  frames: number;
  /** True once the ceiling was hit; further actions still run, they just stop capturing. */
  full: boolean;
}
```

| From      | Event                                    | To                                                                           |
| --------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| idle      | `browser_record_start`                   | recording; one keyframe captured immediately                                 |
| recording | any driving verb, or `browser_navigate`  | recording; one keyframe captured after the action settles; `frames++`        |
| recording | `frames === MAX_RECORDING_FRAMES`        | recording, `full: true`; the tools keep working and say they stopped filming |
| recording | `browser_record_stop`                    | idle; one last keyframe, then encode and upload                              |
| recording | `browser_record_start` again             | refused: "A recording is already running. Stop it first."                    |
| recording | the document closes, or the session ends | idle; the buffer is dropped and nothing is written                           |
| idle      | `browser_record_stop`                    | refused: "Nothing is being recorded right now."                              |

A recording that is never stopped costs nothing but the client's frame buffer, which is bounded, and
is dropped when the document closes or the session's capture buffer is evicted
(`devtools-capture-store.ts:335-346`).

#### 3.2 Keyframes

A keyframe is exactly what `browser_screenshot` already produces — the shim's existing rasterizer
path (`ensureRasterizer`, `devtools-shim.ts:417-430`, long edge 1568 px, one downscale retry) — asked
for as part of the action rather than as a separate round trip. That is what the `capture?: boolean`
field on `act-request` is for (§2.1): one message, one result, one frame, and no second timeout to
reason about.

**Keyframes do not go to the server one at a time, and they do not touch the screenshot slot.** The
client accumulates them in a per-document recording buffer in the bridge, and the screenshot slot
stays exactly what it is: the latest on-demand `browser_screenshot`. Mixing the two would mean a
recording quietly overwriting the screenshot an agent was about to read.

#### 3.3 The encoder (Q2 resolved) and the bounds

**`gifenc` (MIT, pure JavaScript, no native code), lazy-loaded in the client**, beside the rasterizer
the bridge already loads on demand (`lib/load-rasterizer.ts`). `gifenc` is ~20 KB minified and ships
its own `quantize` and `applyPalette`, which is the whole reason it wins: the alternatives either need
a PNG decoder on the server (two dependencies where one will do) or are native.

**Encoding happens in the client, not the server, and that is the same decision as §2's.** The frames
are produced in the page, the browser already has a `<canvas>` that can read their pixels, and a
server-side encode would mean shipping N base64 PNGs up the wire to decode them again. So: on
`browser_record_stop` the client draws each keyframe to an offscreen canvas at the recording size,
quantizes to a shared 256-colour palette built from the **first** frame plus the last, encodes, and
uploads the result once.

| Bound                       | Value  | Why                                                                                                       |
| --------------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `MAX_RECORDING_FRAMES`      | 60     | ~60 actions is a long session; past it the run keeps working and stops filming, with a sentence           |
| `RECORDING_LONG_EDGE_PX`    | 800    | Downscaled from the 1568 px capture. Readable, and a quarter of the pixels                                |
| `RECORDING_FRAME_MS`        | 500    | Two frames a second. It is a slideshow of actions, and it should look like one                            |
| `MAX_RECORDING_BYTES`       | 8 MiB  | The encoded GIF. Over it, the client re-encodes once at half the long edge, then gives up with a sentence |
| `RECORDING_STOP_TIMEOUT_MS` | 30 000 | The encode-and-upload wait. Past it, a plain failure and the buffer is dropped                            |
| one per session             | —      | The state machine above                                                                                   |

These are **constants in `apps/server/src/config/constants.ts`'s `WORKBENCH` block, not config
fields.** Nothing about them is a preference a person would want to set, and the cost of a config
field is thirteen steps and a semver-keyed migration (`contributing/configuration.md`); this spec
adds no config field at all, which is stated here so a reviewer can check it rather than infer it.

#### 3.4 Where the file lands, and what comes back

`POST /api/sessions/:id/devtools/recording` — multipart with **two file parts**: `recording` (the GIF) and `keyframe` (the final keyframe as a PNG, the same bytes the last `browser_screenshot`-style capture produced, so the tool result can return it as the image block §3.5 promises), `requestId` in the body,
reusing `upload-handler.ts`'s multer configuration and its `10 MiB` ceiling so the byte cap is one
number in one place. The server writes it to

```
{session cwd}/.dork/.temp/recordings/<recordingId>.gif
```

which is the directory shape `upload-handler.ts:29` already establishes for
`{cwd}/.dork/.temp/uploads/`, under a path `.gitignore` already covers (`.temp`, `:80`), and then
resolves the `browser_record_stop` waiter.

The tool answers with **the path, the frame count, the size, and one image block that is the final
keyframe as a PNG — not the GIF**:

```json
{
  "path": ".dork/.temp/recordings/01J8Z….gif",
  "frames": 14,
  "bytes": 743210,
  "seconds": 7,
  "note": "The last frame is attached. Open the file to watch the whole thing, or post it to a room with post_to_room."
}
```

A GIF in a tool result would be megabytes of base64 that the model cannot watch anyway — an
animation is not something a vision model sees animate. The final keyframe is small, is the state the
page ended in, and is the frame an agent actually wants to reason about. The path is what makes the
recording useful: a person opens it, and `post_to_room.attachments` (§4) puts it in a room.

#### Detailed Design §4 — An agent posts attachments (B4)

This closes `specs/room-attachments/` Open Question 4 ("agents uploading files"), and it closes it
**without opening the upload route to agents**. `POST /api/rooms/:id/attachments`
(`routes/rooms.ts:428-556`) refuses a non-human caller with `PEOPLE_ONLY` (`:437-439`) and keeps
refusing: a multipart upload endpoint reachable by an agent identity is a different security
question from "an agent may show a file it already has". What an agent gets is a field on the verb it
already uses.

`rooms.post` (`room-capabilities.ts:669-729`) gains:

```ts
  attachments: z
    .array(z.string())
    .max(ROOM_ATTACHMENTS_PER_POST)
    .optional()
    .describe(
      'Files to show with this message, by path. Relative paths are from your own working ' +
        'directory. Screenshots and recordings you made are the usual case. Everyone in the room ' +
        'sees them, and the other agents get their own copy.'
    ),
```

The server, in order, and **all of it before the entry is written**:

1. **Resolve every path inside the agent's OWN working directory.** Not `validateBoundary(userPath)`
   (`lib/boundary.ts:367`) on its own: that confines to the **global** boundary, which in a project
   room contains every member's worktree, so an agent could name another agent's copy and attach it.
   The call is `resolveWithinCwd(agentCwd, path)` (`lib/file-route-guards.ts:137-146`) — the guard
   `routes/files.ts` and `routes/diff.ts` already use — which validates the cwd and then validates
   the target **against that cwd**, canonicalizing through the deepest ancestor on disk so a
   symlinked parent is followed rather than read as text (DOR-1185). A path outside the agent's own
   cwd is refused with the boundary's own sentence; a path that is not a regular file is refused by
   name. Nothing here widens what an agent can read: a file it could not open today it cannot attach
   today, and another member's worktree is not attachable at all.
2. **Check the caps**, which are the human route's caps, read from the same place
   (`configManager.get('uploads')`, `config-schema.ts:2140-2151`): at most `maxFiles` (10) per post,
   at most `maxFileSize` (10 MiB) each, and the `allowedTypes` mime allow-list. A refusal names the
   file and the limit: "`run.gif` is 14 MB, and the limit is 10 MB."
3. **Sniff, do not trust.** `preview` is set only from `sniffImageContentType(bytes)`, exactly as the
   human route does — never from the file's extension. A `.png` that is not a PNG is an attachment,
   not an inline image.
4. **Store the bytes.** `LocalRoomAttachmentStore.put(roomId, attachmentId, extension, bytes)` writes
   to `<dorkHome>/rooms/<roomId>/attachments/<id>.<ext>` through its existing stage-then-rename.
   The name is `path.basename` through `sanitizeAttachmentName` (`rooms.ts:404-408`), capped at
   `ROOM_ATTACHMENT_NAME_MAX` (`room-schemas.ts:1239`).
5. **Insert the rows unbound, then bind them in the entry's own transaction.**
   `AttachmentRowStore.bind(roomId, attachmentIds, entryId, tx)` (`attachment-row-store.ts:154-172`)
   is already transactional and already re-guards `entry_id IS NULL`, so "the post and its
   attachments land together or neither does" needs no new machinery. A failure anywhere in 1–4 rolls
   back the bytes already written and posts nothing — the same `committed`-array rollback the human
   route does at `rooms.ts:487-556`.
6. **The fan-out is unchanged.** `projectRoomAttachments` (`attachment-projection.ts:103-147`) already
   runs once per turn before dispatch (`room-turn-runner.ts:709-716`), hardlinking each of the entry's
   attachments into `.dork/.temp/room-attachments/<entryId>/` in every other agent's working copy,
   copying on `EXDEV`. An agent's screenshot reaches the next agent by the path that already existed.
   `sweepUnboundAttachments` also needs no change: an agent post that fails after step 4 leaves
   unbound rows, and the 24-hour sweep already reclaims them on the next upload.

**Per-turn bounds.** The room's existing `rooms.maxPostsPerTurn` already bounds how many times an
agent speaks; `attachments` rides a post, so it inherits that ceiling. `ROOM_ATTACHMENTS_PER_POST` is
the `uploads.maxFiles` value, not a new number.

#### Detailed Design §5 — the two capabilities this phase adds to the `ui` domain

Q1 creates the domain and Q2 fills it with six verbs; this phase adds `ui.record_start` and `ui.record_stop`. The table is the whole domain across the spec, and its "Lands in" column says which phase adds each row — the two `Q3` rows are this PR's.

| Capability                | Tool name              | Tier      | Lands in   |
| ------------------------- | ---------------------- | --------- | ---------- |
| `ui.read_canvas_document` | `read_canvas_document` | `observe` | Q1         |
| `ui.click`                | `browser_click`        | `act`     | Q2         |
| `ui.type`                 | `browser_type`         | `act`     | Q2         |
| `ui.press`                | `browser_press`        | `act`     | Q2         |
| `ui.scroll`               | `browser_scroll`       | `act`     | Q2         |
| `ui.wait_for`             | `browser_wait_for`     | `observe` | Q2         |
| `ui.read_page`            | `browser_read_page`    | `observe` | Q2         |
| `ui.record_start`         | `browser_record_start` | `act`     | Q3         |
| `ui.record_stop`          | `browser_record_stop`  | `act`     | Q3         |
| `ui.control`              | `control_ui`           | `act`     | Q4 (moved) |
| `ui.state`                | `get_ui_state`         | `observe` | Q4 (moved) |
| `ui.read_console`         | `browser_read_console` | `observe` | Q4 (moved) |
| `ui.read_network`         | `browser_read_network` | `observe` | Q4 (moved) |
| `ui.screenshot`           | `browser_screenshot`   | `observe` | Q4 (moved) |

**Every handler keys on `context.sessionId`**, which `CapabilityHandlerContext` carries on the
in-session surface and only there (`registry.ts:214`), and which the loopback server takes from the
verified `principal.claims.canonicalSessionId` rather than from anything a caller supplies
(`agent-runtime-server.ts:23-41`). A call with no session id is refused with the sentence
`SESSIONLESS_DEVTOOLS_ERROR` already uses (`devtools-tools.ts:116-122`) — the tools read what a live
session's window captured, and a surface with no session has no window.

#### Detailed Design §5 — the count guards this phase moves

**What changes in the guards, and the arithmetic to re-derive before each PR.** Every phase that adds
a verb reds a count guard _by design_; none of these numbers is a thing to "fix" by changing an
assertion without reading its comment trail.

| Guard                                                        | Today | After Q1 | Q2  | Q3  | Q4     |
| ------------------------------------------------------------ | ----- | -------- | --- | --- | ------ |
| `tool-exposure.test.ts:373` — in-session tools               | 92    | 93       | 99  | 101 | 101    |
| `tool-exposure.test.ts:374` — deferred                       | 83    | 84       | 90  | 92  | 92     |
| `tool-exposure.test.ts:287-323` — always-loaded              | 9     | 9        | 9   | 9   | 9      |
| `mcp-tool-gate.test.ts:317-323` — hand-registered in-session | 47    | 47       | 47  | 47  | **42** |
| `mcp-tool-gate.test.ts:317-323` — `MCP_TOOL_TIERS` keys      | 47    | 47       | 47  | 47  | **42** |
| `mcp-tool-gate.test.ts:317-323` — external                   | 40    | 40       | 40  | 40  | 40     |
| `AUTO_ALLOW_ACT_REASONS` entries (`:518-563`)                | 22    | 22       | 22  | 22  | 22     |

- **Always-loaded stays nine.** None of these verbs is one a turn cannot search for first, and the
  eager slot is the scarcest thing in the prompt. (While editing that test, fix its stale title: it
  says "exactly the eight" and asserts nine, since `read_canvas` joined in DOR-1999.)
- **The external count never moves.** The `ui` domain declares `servers: ['in-session']`, so nothing
  it adds reaches `/mcp`, and it contributes nothing to `READ_ONLY_MCP_TOOL_NAMES` or
  `GUARDED_READ_ONLY_TOOL_NAMES` (`tool-security.ts:160-177`). A test asserts that directly, which
  turns `register-from-definitions.ts:30-50`'s stated fact into a checked one.
- **`AUTO_ALLOW_ACT_REASONS` never moves either**, for the reason §2.5 gives: no phase edits
  `DORKOS_AGENT_TOOLS`, and that test pins the table against it in both directions (`:555-579`).
- **`capability-conformance.test.ts:472-580` `sampleInputs`** gains a realistic input per new
  capability id, or the conformance run cannot invoke it.

**Settled (2026-09-12): `mcp-tool-gate.test.ts` is not edited in this phase.** An earlier draft of the create/modify list said `mcp-tool-gate.test.ts` (+2 reasons); the list is corrected, and §2.5 and the table above say `AUTO_ALLOW_ACT_REASONS` keeps its 22 entries through every phase because no phase edits `DORKOS_AGENT_TOOLS`. §2.5 is the half that carries the reasoning and the two-way pin (`:555-579`), so the "+2 reasons" in the create/modify list reads as stale. Do not change either assertion without reading its comment trail; if the recording verbs genuinely need auto-allow entries, that is a decision to raise at review, not a number to edit.

#### Data model changes — item 2, the sub-bullet this phase lands

2. **Shared schemas**, every one additive or optional so an older client parses a newer server:
   - `rooms.post`'s capability input gains `attachments?: string[]` (§4).

#### Data model changes — item 5, which this phase must keep true

5. **No config fields.** Every bound this spec adds is a constant in `constants.ts`'s `WORKBENCH`
   block, and every bound it reuses (`uploads.maxFiles`, `uploads.maxFileSize`,
   `rooms.maxPostsPerTurn`, `rooms.maxCanvasOpsPerTurn`) already exists. So there is no
   `config-schema.ts` edit, no `projectVersion` bump, no `CONFIG_MIGRATIONS` key, and no
   `merged-migration-hashes.ts` change — stated explicitly so a reviewer checks the claim rather
   than inferring it from silence.

#### User Experience — the paragraphs this phase makes true

**He asks for it again as a recording.** The agent starts a recording, redoes the four steps, stops.
He gets one line — "14 frames, 7 seconds, `.dork/.temp/recordings/01J8Z….gif`" — and the last frame
inline. He opens the file and watches the form fail.

**Two agents look at one room's table.** Ana takes a screenshot of the failing page and posts it:
"@kai the 500 is from the proxy" with the image attached. It renders inline in the log for Kai, and
Ikechi's agent finds the same file hardlinked into its own working copy on its next turn, and can
open it.

**Error and exit paths.** Nothing open to drive: one sentence naming `browser_navigate`. A page that
is open but not instrumented: one sentence saying so, immediately, instead of an eight-second pause.
A target that matched nothing, or four things: a sentence naming the fix. A recording over its frame
ceiling: it keeps working and says it stopped filming. An attachment over the size cap: the file and
the limit, by name. A merge behind main: the merge service's own words. Every one of them is a
refusal the agent can act on without asking a person.

#### Detailed Design §10 — Bounds, honesty, etiquette (B10)

- **Driving is work, not speech.** No driving verb, recording verb, or canvas write triggers a turn
  for anybody. The only thing in this spec that puts a line in a room's log is a `post_to_room` an
  agent chose to write (§4) and the once-per-turn coalesced canvas line that already exists.
- **Every bound here is a mechanism.** Frames and bytes for a recording (§3.3); `uploads.maxFiles` and
  `uploads.maxFileSize` for attachments (§4); the derived synthetic turn id for `target` (§9); the
  publish-only-while-followed rule for follow mode (§6). None of them is a sentence in a prompt, and
  none may be replaced by one (`.claude/rules/room-conduct.md`, "Bounds are mechanisms, never
  prompts").
- **No new trigger, anywhere.** Nothing in this spec calls the trigger dispatcher. A conformance case
  and an e2e assertion both read that off the dispatcher rather than off a sleep.
- **Every tool result says what happened.** A timeout is a plain failure naming the command and the
  wait. A refusal names the fix. A recording that hit its ceiling says so and keeps working. Nothing
  reports success for something that did not happen — the property `specs/room-canvas/` §5.5
  establishes, extended to the browser seat.
- **The teaching is one paragraph, not a manual.** `buildRoomToolsBlock`
  (`room-tools-context.ts:97-100`) and the session `<ui_tools>` block each gain three sentences: that
  the browser can be driven and read on an instrumented preview, that a recording is frames of what
  you did and lands in a file you can post, and that a screenshot or a recording belongs in the room
  as an attachment rather than described in prose (E9, E14). Written out in each variant rather than
  shared, per that file's own rule at `:85-88`.

#### Testing Strategy — Unit, `apps/server`, the browser seat (the recording half)

- **Recording**: the state machine's eight transitions, including a second `record_start` refused, a
  ceiling that keeps driving and stops filming, and a document close that drops the buffer; the GIF
  upload writes to `{cwd}/.dork/.temp/recordings/<id>.gif` and resolves the waiter; an upload over the
  multer cap answers `413` and the tool says so.
- The encoder itself is tested in the **client**: `gifenc` encodes three known frames into a GIF whose
  header, logical screen size and frame count are asserted by parsing the bytes back. _Catches an
  encoder integration that produces a file no decoder accepts._

#### Testing Strategy — Unit, `apps/server`, attachments and rooms

The last two bullets (`control_ui` with `target`) are Q6's and are quoted only so the section reads whole; everything above them is this phase's.

- `post_to_room` with `attachments` writes the bytes, inserts the rows and binds them to the entry
  **in one transaction**: a failure at the bind leaves no bytes, no rows and no entry.
- A path outside the **agent's own cwd** is refused and nothing is written — asserted with a second
  agent's worktree in the same project room, which is inside the global boundary and must still be
  refused. A directory, a symlink pointing outside, and a missing file are each refused by name.
  _Catches the only way this feature could widen what an agent reads, and catches it in the case
  `validateBoundary` alone would have let through._
- A file over `uploads.maxFileSize`, and an eleventh file, are each refused naming the limit.
- `preview` is `'image'` only when the **bytes** sniff as an image — asserted with a `.png` that is
  not one.
- The next turn's `projectRoomAttachments` hardlinks the new attachment into a second agent's working
  copy. _The point of the feature, asserted end to end in-process._
- `POST /api/rooms/:id/attachments` still refuses an agent caller with `PEOPLE_ONLY`. _Catches the
  route being opened as a side effect of opening the tool._
- `control_ui` with `target` naming a room the agent is not in is refused with `ROOM_NOT_FOUND`'s
  sentence and writes nothing; naming one it is in writes a row on that room; twenty targeted writes
  in one turn are refused at the fourth per room, and two rooms get one allowance each.
- A targeted write's coalesced line posts once, at the end of the calling turn, naming every
  operation.

#### Testing Strategy — Playwright (`apps/e2e`)

Built on the helpers rooms specs already use (`fixtures/rooms-api.ts`, `room-signals.ts`, the
`requireTestModeLeg` gate `room-autonomy.spec.ts:96-129` uses so a missing `TestModeRuntime` fails
loudly instead of starting a billable turn), and on `workbench/dev-server-preview.spec.ts`'s real
local dev server.

| Spec                                              | What it proves                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `tests/rooms/room-agent-attachment.spec.ts` (new) | a test-mode agent turn posts a file with `attachments`; it renders inline in the log and downloads correctly |

**Mocking strategy.** Server tests use a real SQLite database and the real capability registry, never
a mocked `CanvasService` — a mock here would encode the hypothesis rather than test it. The shim is
executed, never read. Client tests use the mock `Transport` through `TransportProvider`. The e2e leg
uses the deterministic test-mode runtime and a real local dev server.

**Before opening any PR in this spec**, run
`pnpm vitest run apps/server/src/services/runtimes apps/server/src/services/core packages/shared packages/db`
— every phase here touches a count guard or a schema census, and those failures read like unrelated
breaks if you have not been told to expect them.

#### Performance Considerations

- **Per-turn prompt cost is unchanged.** `get_ui_state` is called, not injected; the canvas section of
  a room's context is still labels only and still capped at 12 + pins; the driving tools are deferred,
  not always-loaded, so they cost nothing in a turn that does not search for them.
- **Recording memory is bounded in the client**, at `MAX_RECORDING_FRAMES` × the downscaled frame
  size — ~60 × ~150 KB of PNG data URL, well under the tens of megabytes a page routinely holds — and
  is freed on stop, on document close, and on session-buffer eviction.
- **Encoding blocks the client**, briefly. 60 frames at 800 px is on the order of a second of
  quantize-and-encode; it runs after `record_stop` is called, once, and the tool is awaiting it
  anyway. If measurement says otherwise, the encoder moves to a worker — but a worker added before
  measuring would be complexity bought on a guess.
- **Follow mode is one coalesced frame per 250 ms per followed member**, and zero when nobody follows.
- **Attachments do not change the fan-out cost**: `projectRoomAttachments` already runs once per turn
  and no-ops when an entry has none.

#### Security Considerations — items 3 and 7

3. **Attachments never widen what an agent can read.** Every path goes through
   `validateBoundary` (`lib/boundary.ts:367`), the same call the file routes make, before anything is
   read. An agent can attach exactly the files it could already open, and the upload route stays
   `PEOPLE_ONLY`. The hardlink fan-out is into each agent's own working copy and is unchanged.
4. **Recordings are bounded and local.** Frame count, frame size, and encoded bytes are all capped;
   the file lands under `{cwd}/.dork/.temp/`, which `.gitignore` already covers; nothing is uploaded
   anywhere, and a recording reaches another person only if an agent deliberately posts it as an
   attachment, through the caps of §4.

#### Documentation

**`docs/guides/workbench.mdx`** — four sections change, all of them session-scoped prose today:

- **"Agents Can Check Their Own Work"** gains recording: what a GIF of the run is, where the file
  lands, and that it can be posted into a room.
  **`docs/concepts/rooms.mdx`** — this page still has **no mention of a canvas**; room-canvas P2c is the
  phase that adds it and has not landed. This spec therefore **adds to that section rather than
  creating one**, and its PR must read what P2c wrote before editing:

- the room-canvas section gains "Talking about a document" (the thread) and "Following somebody's
  browser" (people only, off by default, nothing recorded);
- **"What a room can never do to an agent"** gains one sentence: an agent posting a file to a room can
  only post a file it could already open on its own machine;
- the **"REST surface"** table gains the session-canvas routes and the two new devtools routes.

**Skills** — `chat:self-test` gains a browser-driving leg (drive a served page, assert the outline and
the click); `chat:rooms-test` gains an attachment leg (an agent posts a file, the other member's turn
can open it).

**Changelog.** One fragment per PR in `changelog/unreleased/`, named `<YYMMDD-HHMMSS>-<kebab-slug>.md`
with an id from `.claude/scripts/id.ts`, carrying a `covers:` block on its very first lines listing
that PR's exact commit subjects. Bodies use only the seven allowed headings; an invalid heading has
silently deleted a fragment before. Run `pnpm exec prettier --write` on the fragment before
committing — hand-edited fragments are the most common source of the formatting gate going red.

The demo-claim gate applies to every page: the Obsidian shell has no Browser tab and no driving, and
no page says otherwise; a recording is described by what it is (a slideshow of the steps), never as
video.

#### Definition of done

- Recording state-machine tests cover every transition in the §3.1 table, including a second
  `record_start` refused, a ceiling that keeps driving and stops filming, an unstopped recording
  dropped when the document closes, and `record_stop` with nothing recording refused.
- An upload test: the GIF lands at `{cwd}/.dork/.temp/recordings/<id>.gif` and resolves the
  `browser_record_stop` waiter; an upload over the multer cap answers `413` and the tool says so; a
  stop that never comes back fails plainly at `RECORDING_STOP_TIMEOUT_MS` and claims no file.
- The encoder test lives in the **client**: `gifenc` encodes three known frames into a GIF whose
  header, logical screen size and frame count are asserted by parsing the bytes back. A run of four
  actions produces six frames (start, four actions, stop) at the recording size, under the byte cap.
- Attachment tests: `post_to_room` with `attachments` writes bytes, inserts rows and binds them to the
  entry in **one transaction** — a failure at the bind leaves no bytes, no rows and no entry; a path
  outside the **agent's own cwd** is refused with nothing written, asserted with a second agent's
  worktree in the same project room, which is inside the global boundary and must still be refused; a
  directory, a symlink pointing outside and a missing file are each refused by name; a file over
  `uploads.maxFileSize` and an eleventh file are each refused naming the limit; `preview` is `'image'`
  only when the **bytes** sniff as one, asserted with a `.png` that is not; the next turn's
  `projectRoomAttachments` hardlinks the file into a second agent's working copy; and
  `POST /api/rooms/:id/attachments` still refuses an agent caller with `PEOPLE_ONLY`.
- `apps/e2e/tests/rooms/room-agent-attachment.spec.ts` exists and passes.
- Browser proof: the posted screenshot rendering inline in a real room log and downloading correctly,
  screenshotted in the PR.
- `tool-exposure.test.ts` reads 101 in-session and 92 deferred; always-loaded stays 9 and external
  stays 40; the `AUTO_ALLOW_ACT_REASONS` conflict above is resolved deliberately, not by editing a
  number.
- `pnpm --filter @dorkos/server typecheck`, `pnpm --filter @dorkos/client typecheck` and both lint runs
  are clean; `gifenc` is a `apps/client` dependency and is lazy-loaded, never imported at module scope.
- One changelog fragment in `changelog/unreleased/` with a `covers:` block and only the seven allowed
  headings, `pnpm exec prettier --write` run on it before committing. The fragment describes a
  recording as what it is — a slideshow of the steps — never as video.
- Adversarial review per `REVIEW.md` before the PR opens.
- **The full package suite runs before push**, not just the files you touched:
  `pnpm vitest run apps/server/src/services/runtimes apps/server/src/services/core packages/shared packages/db`,
  then `pnpm test -- --run`.

---

### Task 2.2: Give every runtime the same canvas and browser seat

**Phase:** Q4 — Runtime parity (B5) — depends on Q1 and Q2
**Scope:** one PR, and the one with the largest blast radius in the spec: it deletes five hand
registrations, retires Codex's `dorkos_ui` server, and narrows two tables that `tsc` checks against
each other. It needs Q1 on `main` for the `ui` domain it moves tools into, and Q2 on `main` for the
six verbs it standardises them beside. It blocks nothing.

#### Phase definition — create/modify and acceptance

**Modify**

- `apps/server/src/services/session/ui-capabilities.ts` — `ui.control`, `ui.state`, `ui.read_console`,
  `ui.read_network`, `ui.screenshot`, each wrapping the handler that already exists
- `apps/server/src/services/runtimes/claude-code/mcp-tools/{ui-tools,devtools-tools,index}.ts` — the
  hand registrations **deleted**; the handlers moved, not copied
- `apps/server/src/services/core/mcp-tool-tiers.ts:125-261` — five entries removed, `McpToolName`
  narrowed, and the `:247-253` comment about the ungated third copy deleted because the third copy is
  gone
- `packages/shared/src/mcp-tool-groups.ts:177-237` — **the same five names removed**, or
  `mcp-tool-tiers.ts:294-299`'s exhaustiveness assertions fail to compile; `'ui'` and `'devtools'`
  dropped from `ToolGateGroup` (`:125-136`) and from `SESSION_CORE_TOOL_GROUPS` (`:274`), with the
  client's always-enabled tool-group row re-checked
- **`dorkos_ui` retired:** `apps/server/src/services/runtimes/codex/codex-ui-mcp-server.ts` **deleted**
  with its test; `codex/index.ts:8` exports removed; `codex/event-mapper.ts:398-405, 631-674` — the
  `mcp_tool_call` interception and `mapControlUi` removed; `codex/mcp-server-config.ts:42, 202-219`
  and `codex/codex-options.ts` — the name reservation and the injected bridge URL removed;
  `codex/ui-command-consent.ts:69-74` — `isUiActionRefusedOnCodex` renamed for the surface it tests
  and moved to the `ui.control` handler, `uiActionRefusalMessage` reworded to name the surface;
  `apps/server/src/index.ts:1161` — the loopback mount removed
- `apps/server/src/services/session/ui-capabilities.ts` — the `ui.control` handler stamps `applied`
  when it wrote to a room and pushes the `ui_command` through `peekProjector(sessionId)?.ingest`
- `mcp-tool-gate.test.ts:317-323` (47→42 twice; external stays 40),
  `tool-exposure.test.ts:287-323` (fix the stale "eight" title while there)
- `contributing/adding-a-runtime.md`; a changelog fragment

**Acceptance:** a Codex session and an OpenCode session each list and successfully call
`control_ui`, `get_ui_state`, `browser_read_console` and `browser_click` through the loopback `dorkos`
server, with the session resolved from the verified principal; **a Codex room turn's `open_canvas`
writes exactly one row** — the handler applied it and stamped `applied`, so
`room-turn-runner.ts:1501-1503` skips it, and asserting one row is what catches the double-apply this
retirement could introduce; a non-`client-only` action over the loopback surface is refused with the
reworded sentence, on Codex **and** on OpenCode; `control_ui` still auto-allows for a `client-only`
action and still does not for `apply_layout`, after the move; claude-code's behaviour is unchanged,
asserted by the existing suites passing without edits beyond the counts; no `ui.*` tool appears on
`/mcp`; `tsc` is green, which is what proves the tiers and groups tables still describe one set.

#### Detailed Design §5 — The `ui` capability domain (B5), in full

Today's five UI tools are hand-registered in `claude-code/mcp-tools/`, which is why Codex and OpenCode
do not have them — `register-from-definitions.ts:30-50` already states this as a fact with a name
attached. They become capabilities in a **`ui` domain**, declared in
`apps/server/src/services/session/ui-capabilities.ts` with its handlers in
`apps/server/src/services/session/browser-seat/`.

**`services/session/` rather than a new `services/ui/` domain**, because that is where the state these
verbs read already lives: `devtools-capture-store.ts` is a session service, the recording state joins
it, and the `ui` verbs are session-scoped by construction. (§1.2 does add one service domain,
`canvas`, for the opposite reason: a canvas that serves two scopes belongs to neither of them.)

Ids satisfy the conformance regex `/^[a-z0-9]+\.[a-z0-9_]+$/`
(`packages/test-utils/src/capability-conformance.ts:310`) — lowercase and snake_case, the shape
`rooms.read_canvas` already uses:

| Capability                | Tool name              | Tier      | Lands in   |
| ------------------------- | ---------------------- | --------- | ---------- |
| `ui.read_canvas_document` | `read_canvas_document` | `observe` | Q1         |
| `ui.click`                | `browser_click`        | `act`     | Q2         |
| `ui.type`                 | `browser_type`         | `act`     | Q2         |
| `ui.press`                | `browser_press`        | `act`     | Q2         |
| `ui.scroll`               | `browser_scroll`       | `act`     | Q2         |
| `ui.wait_for`             | `browser_wait_for`     | `observe` | Q2         |
| `ui.read_page`            | `browser_read_page`    | `observe` | Q2         |
| `ui.record_start`         | `browser_record_start` | `act`     | Q3         |
| `ui.record_stop`          | `browser_record_stop`  | `act`     | Q3         |
| `ui.control`              | `control_ui`           | `act`     | Q4 (moved) |
| `ui.state`                | `get_ui_state`         | `observe` | Q4 (moved) |
| `ui.read_console`         | `browser_read_console` | `observe` | Q4 (moved) |
| `ui.read_network`         | `browser_read_network` | `observe` | Q4 (moved) |
| `ui.screenshot`           | `browser_screenshot`   | `observe` | Q4 (moved) |

**This corrects the ideation's phase split, deliberately.** `01-ideation.md` puts the whole `ui`
domain in Q4 and the driving tools in Q2, which would mean registering six tools twice. Q1 creates the
domain with one capability, Q2 and Q3 add to it, and Q4 does the part that is actually about parity:
moving the five that exist and deleting their hand registrations. The phases and their dependency
order are unchanged.

**Every handler keys on `context.sessionId`**, which `CapabilityHandlerContext` carries on the
in-session surface and only there (`registry.ts:214`), and which the loopback server takes from the
verified `principal.claims.canonicalSessionId` rather than from anything a caller supplies
(`agent-runtime-server.ts:23-41`). A call with no session id is refused with the sentence
`SESSIONLESS_DEVTOOLS_ERROR` already uses (`devtools-tools.ts:116-122`) — the tools read what a live
session's window captured, and a surface with no session has no window.

**The claude-code registrations become thin wrappers, then go away.** In Q4, `getUiTools` and
`getDevtoolsTools` (`mcp-tools/index.ts:227-237`) stop contributing these five, and the capability
registry supplies them to all three runtimes. One implementation, one description, one input schema.

**Codex's `dorkos_ui` server is retired in the same PR, and that is a decision with a loser.** Today
`control_ui` exists in **three** copies, and `mcp-tool-tiers.ts:247-253` says so in a standing
comment: "A third copy of this tool is registered on the codex-scoped `dorkos_ui` server, which does
NOT go through the gate… if this tool were ever promoted, that server would need the gated registrar
first." The third copy is `codex-ui-mcp-server.ts:38,55-66` — one tool, `control_ui`, with a
**deliberately stubbed handler** that produces no effect and only echoes `{ success, action }`,
because that server has no session in scope. The real effect is produced downstream in
`codex/event-mapper.ts:398-405` and `mapControlUi` (`:631-674`), which intercepts the resulting
`mcp_tool_call` item and turns it into a `ui_command` StreamEvent.

**We retire it**, rather than keeping it and declining to register `ui.control` for codex. The reason
the stub exists is that its server has no session; the loopback `dorkos` server **does** — it takes
`sessionId` from the verified `principal.claims.canonicalSessionId`
(`agent-runtime-server.ts:23-41`), never from an argument. Every premise of the split is therefore
gone, and keeping it would mean two `control_ui` implementations for one runtime, one of them outside
the gate, forever. What moves with it:

| Concern today                                                                     | Where it lands                                                                                                         |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| the refusal reaching the model (`codex-ui-mcp-server.ts:58-65`)                   | the capability's own error result — the same channel, and a direct one                                                 |
| `isUiActionRefusedOnCodex` (reach ≠ `client-only`, `ui-command-consent.ts:69-74`) | the `ui.control` handler, as a **surface** rule (below)                                                                |
| `isUiActionRefusedInRoom` + `NOT_IN_A_ROOM_MESSAGE` (`event-mapper.ts:655-662`)   | already enforced by `RoomCanvasService.apply`'s `CANVAS_VERBS` allow-list, which the handler calls                     |
| pushing the `ui_command` event                                                    | the handler, through `peekProjector(sessionId)?.ingest(...)`, **carrying the `applied` stamp** when it wrote to a room |
| the name reservation (`codex/mcp-server-config.ts:42,202-219`)                    | removed, with its tests                                                                                                |

**The `applied` stamp is the part that must not be dropped.** `room-turn-runner.ts:1501-1503` applies
any `ui_command` whose `applied` is `undefined`, and that tap is what makes codex's canvas writes work
today. Once codex's `control_ui` calls `apply` itself, it **must** stamp, or every codex canvas
operation applies twice. The test for this already exists in shape for claude-code
(`specs/room-canvas/` §5.5) and is duplicated for codex in the same PR.

**The consent rule becomes a property of the surface, not of a runtime name.**
`isUiActionRefusedOnCodex` refuses any action whose reach is not `client-only`, because a Codex
session has no way to ask the person first. That is true of the **loopback runtime surface** as a
whole, not of Codex in particular — OpenCode reaches DorkOS the same way and today has no rule at all
because it has no `control_ui`. So the predicate is renamed to what it tests and moved to the handler:
a `ui.control` call arriving with a `runtime` principal refuses a non-`client-only` action with
`uiActionRefusalMessage`'s sentence, reworded to name the surface rather than Codex. OpenCode gains a
refusal it never had, which regresses nothing, because it never had the verb.

**What changes in the guards, and the arithmetic to re-derive before each PR.** Every phase that adds
a verb reds a count guard _by design_; none of these numbers is a thing to "fix" by changing an
assertion without reading its comment trail.

| Guard                                                        | Today | After Q1 | Q2  | Q3  | Q4     |
| ------------------------------------------------------------ | ----- | -------- | --- | --- | ------ |
| `tool-exposure.test.ts:373` — in-session tools               | 92    | 93       | 99  | 101 | 101    |
| `tool-exposure.test.ts:374` — deferred                       | 83    | 84       | 90  | 92  | 92     |
| `tool-exposure.test.ts:287-323` — always-loaded              | 9     | 9        | 9   | 9   | 9      |
| `mcp-tool-gate.test.ts:317-323` — hand-registered in-session | 47    | 47       | 47  | 47  | **42** |
| `mcp-tool-gate.test.ts:317-323` — `MCP_TOOL_TIERS` keys      | 47    | 47       | 47  | 47  | **42** |
| `mcp-tool-gate.test.ts:317-323` — external                   | 40    | 40       | 40  | 40  | 40     |
| `AUTO_ALLOW_ACT_REASONS` entries (`:518-563`)                | 22    | 22       | 22  | 22  | 22     |

- **Always-loaded stays nine.** None of these verbs is one a turn cannot search for first, and the
  eager slot is the scarcest thing in the prompt. (While editing that test, fix its stale title: it
  says "exactly the eight" and asserts nine, since `read_canvas` joined in DOR-1999.)
- **The external count never moves.** The `ui` domain declares `servers: ['in-session']`, so nothing
  it adds reaches `/mcp`, and it contributes nothing to `READ_ONLY_MCP_TOOL_NAMES` or
  `GUARDED_READ_ONLY_TOOL_NAMES` (`tool-security.ts:160-177`). A test asserts that directly, which
  turns `register-from-definitions.ts:30-50`'s stated fact into a checked one.
- **`AUTO_ALLOW_ACT_REASONS` never moves either**, for the reason §2.5 gives: no phase edits
  `DORKOS_AGENT_TOOLS`, and that test pins the table against it in both directions (`:555-579`).
- **`MCP_TOOL_TIERS` is half of a pair, and the other half is in `packages/shared`.**
  `mcp-tool-tiers.ts:294-299` are compile-time exhaustiveness assertions comparing the **tool-name key
  sets** of `MCP_TOOL_TIERS` and `MCP_TOOL_GATE_GROUPS` (`packages/shared/src/mcp-tool-groups.ts:177-237`,
  whose keys are `McpToolGroupName`). So Q4 removes the same five names from **both** tables or
  `tsc` fails — and removing them from the groups table empties the `'ui'` and `'devtools'` gate
  groups entirely (`mcp-tool-groups.ts:185-190` are their only members). Q4 therefore also drops
  `'ui'` and `'devtools'` from the `ToolGateGroup` union (`:125-136`) and from
  `SESSION_CORE_TOOL_GROUPS` (`:274`), which shortens `SESSION_CORE_TOOL_NAMES` to the `core` group.
  **The visible consequence, stated rather than discovered:** the app's always-enabled tool-group row
  stops listing a UI group and a devtools group, because those tools are no longer gated by group at
  all — they are capabilities, gated by tier. A test asserts the row still renders and that no
  `ui.*` tool is missing from the session's advertised set.
- **`capability-conformance.test.ts:472-580` `sampleInputs`** gains a realistic input per new
  capability id, or the conformance run cannot invoke it.

#### Detailed Design §2.5 — the auto-allow rule this phase must not change

**Not auto-allowed, and that corrects the ideation.** `01-ideation.md` B2 says the driving tools are
"auto-allowed with a justification sentence in the table". The code says the precedent runs the other
way. Auto-allow is membership of `DORKOS_AGENT_TOOLS` (`interactive-handlers.ts:116-170`), which the
gate reads at `:855` — and the three existing `browser_*` tools are **not** on it, while
`READ_ONLY_TOOLS` (`:44-52`) holds only Claude Code's own built-ins. So a `browser_read_console` call
already raises an approval card under any asking mode. Driving a page is strictly more consequential
than reading its console; putting the driving verbs on the auto-allow list while the reads stay off it
would be backwards. Therefore:

- **no phase edits `DORKOS_AGENT_TOOLS`**, and `AUTO_ALLOW_ACT_REASONS` (`mcp-tool-gate.test.ts:518-563`)
  keeps its 22 entries through every phase. That test pins the set **both ways**
  (`:555-579`: `needsAReason` from `DORKOS_AGENT_TOOLS ∩ (act ∨ identity-scoped)` must `toEqual` the
  table's keys), so an entry added without a list change fails just as loudly as one omitted.
- The driving verbs are decided by the session's permission mode like every other unlisted tool: under
  the shipped `bypassPermissions` default they do not prompt, and under an asking mode the person sees
  a card the first time an agent clicks something. For a verb that acts on a page, that is the right
  default.
- Each verb's description carries the sentence that would have been the justification, because it is
  what a person reading that card needs:

  > Acts only inside the sandboxed preview frame DorkOS itself serves — an opaque origin with no
  > credentials, no reach to `/api/*`, and no path to the machine. It is the same frame
  > `browser_screenshot` already reads, and the same page you are looking at.

**Q4 must not change `control_ui`'s auto-allow, and that is a test, not a hope.** `control_ui` and
`get_ui_state` **are** on `DORKOS_AGENT_TOOLS`, by their prefixed in-session names, and
`isAutoAllowedCall` (`interactive-handlers.ts:416-421`) additionally gates `control_ui` per argument
on `UI_COMMAND_REACH[action] === 'client-only'`. A capability registered on the in-session server
produces the **same** prefixed tool name, so the move in §5 leaves both mechanisms working untouched —
and a test asserts a `control_ui` call with a `client-only` action still auto-allows, and one with
`apply_layout` still does not, after the move.

#### Data model changes — item 5, which this phase must keep true

5. **No config fields.** Every bound this spec adds is a constant in `constants.ts`'s `WORKBENCH`
   block, and every bound it reuses (`uploads.maxFiles`, `uploads.maxFileSize`,
   `rooms.maxPostsPerTurn`, `rooms.maxCanvasOpsPerTurn`) already exists. So there is no
   `config-schema.ts` edit, no `projectVersion` bump, no `CONFIG_MIGRATIONS` key, and no
   `merged-migration-hashes.ts` change — stated explicitly so a reviewer checks the claim rather
   than inferring it from silence.

#### User Experience — what this phase makes true

There is no new screen in this phase. What changes is who can do what has been shown already: a room that mixes runtimes stops having a pecking order. The spec's Background states the gap this closes, and the Overview states the property:

**Only one runtime has any of it.** `register-from-definitions.ts:30-50` names the consequence as a
fact: `control_ui`, `get_ui_state` and the three `browser_*` tools "stay off `/mcp`" because they
have no external entry — and they are absent from the loopback `dorkos` server too, because they
are hand-registered in `claude-code/mcp-tools/` rather than declared as capabilities. In a room that
mixes runtimes that is a hidden pecking order: the claude-code member can see the console and the
others cannot.

5. **Every runtime gets the same seat.** Today `control_ui`, `get_ui_state` and the three `browser_*`
   tools are hand-registered claude-code tools (`register-from-definitions.ts:30-50` states it), so
   a Codex or OpenCode member of a room cannot see a console error. They become capabilities.

#### Detailed Design §10 — Bounds, honesty, etiquette (B10)

- **Driving is work, not speech.** No driving verb, recording verb, or canvas write triggers a turn
  for anybody. The only thing in this spec that puts a line in a room's log is a `post_to_room` an
  agent chose to write (§4) and the once-per-turn coalesced canvas line that already exists.
- **Every bound here is a mechanism.** Frames and bytes for a recording (§3.3); `uploads.maxFiles` and
  `uploads.maxFileSize` for attachments (§4); the derived synthetic turn id for `target` (§9); the
  publish-only-while-followed rule for follow mode (§6). None of them is a sentence in a prompt, and
  none may be replaced by one (`.claude/rules/room-conduct.md`, "Bounds are mechanisms, never
  prompts").
- **No new trigger, anywhere.** Nothing in this spec calls the trigger dispatcher. A conformance case
  and an e2e assertion both read that off the dispatcher rather than off a sleep.
- **Every tool result says what happened.** A timeout is a plain failure naming the command and the
  wait. A refusal names the fix. A recording that hit its ceiling says so and keeps working. Nothing
  reports success for something that did not happen — the property `specs/room-canvas/` §5.5
  establishes, extended to the browser seat.
- **The teaching is one paragraph, not a manual.** `buildRoomToolsBlock`
  (`room-tools-context.ts:97-100`) and the session `<ui_tools>` block each gain three sentences: that
  the browser can be driven and read on an instrumented preview, that a recording is frames of what
  you did and lands in a file you can post, and that a screenshot or a recording belongs in the room
  as an attachment rather than described in prose (E9, E14). Written out in each variant rather than
  shared, per that file's own rule at `:85-88`.

#### Testing Strategy — Capability conformance

`capabilityConformance` runs over the whole registry, so the `ui` domain is covered the moment it is
registered: ids against `/^[a-z0-9]+\.[a-z0-9_]+$/`, tool-name uniqueness, the declared servers
matching what is actually registered, and every capability invocable against fake deps from its
`sampleInputs` entry (`capability-conformance.test.ts:472-580`).

Beyond that, the **parity claim needs a parity test**, once per runtime:

- **claude-code** — through the existing mocked-SDK suite: a turn calls `browser_click` and the
  handler runs.
- **codex** and **opencode** — through the loopback `dorkos` server, which is how they reach DorkOS
  at all: `createAgentRuntimeMcpServer` with a `runtime` principal advertises every `ui` tool, and a
  call carries `context.sessionId` from `principal.claims.canonicalSessionId` rather than from the
  arguments. _Catches the thing this phase exists to fix, and catches it in the place it would
  regress: a capability whose `servers` list was edited._
- A test asserts **no `ui.*` tool is registered on the external `/mcp` server** and that
  `READ_ONLY_MCP_TOOL_NAMES` and `GUARDED_READ_ONLY_TOOL_NAMES` are unchanged by the domain.
- **The `dorkos_ui` retirement, asserted where it can break.** A Codex room turn that runs one
  `open_canvas` ends with **exactly one row, one frame and one line** — the handler applied it and
  stamped `applied`, so the runtime-neutral tap at `room-turn-runner.ts:1501-1503` skips it. _Without
  the stamp every Codex canvas operation applies twice, and dedupe by source key would hide it for
  every content type except `json` and `widget`; the test uses `json`._
- A non-`client-only` action arriving over the loopback runtime surface is refused with the reworded
  sentence, on Codex **and** on OpenCode; the refusal reaches the caller as the capability's error
  result, which is the channel `codex-ui-mcp-server.ts:48-53` says is the only one that reaches the
  model.
- `control_ui` still auto-allows a `client-only` action and still does not auto-allow `apply_layout`
  after the move — `DORKOS_AGENT_TOOLS` keys on the prefixed in-session tool name, which a capability
  registration produces unchanged. _Catches the move silently un-gating or un-allowing the one tool
  on that list that is argument-gated._

#### Testing Strategy — Playwright (`apps/e2e`)

Built on the helpers rooms specs already use (`fixtures/rooms-api.ts`, `room-signals.ts`, the
`requireTestModeLeg` gate `room-autonomy.spec.ts:96-129` uses so a missing `TestModeRuntime` fails
loudly instead of starting a billable turn), and on `workbench/dev-server-preview.spec.ts`'s real
local dev server.

| Spec                                                    | What it proves                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `tests/workbench/dev-server-preview.spec.ts` (existing) | still passes; its console assertion is the one that proves the shim survived the protocol extension |

**Mocking strategy.** Server tests use a real SQLite database and the real capability registry, never
a mocked `CanvasService` — a mock here would encode the hypothesis rather than test it. The shim is
executed, never read. Client tests use the mock `Transport` through `TransportProvider`. The e2e leg
uses the deterministic test-mode runtime and a real local dev server.

**Before opening any PR in this spec**, run
`pnpm vitest run apps/server/src/services/runtimes apps/server/src/services/core packages/shared packages/db`
— every phase here touches a count guard or a schema census, and those failures read like unrelated
breaks if you have not been told to expect them.

#### Performance Considerations

- **Per-turn prompt cost is unchanged.** `get_ui_state` is called, not injected; the canvas section of
  a room's context is still labels only and still capped at 12 + pins; the driving tools are deferred,
  not always-loaded, so they cost nothing in a turn that does not search for them.

#### Security Considerations — the reach this phase must not widen

This phase adds no verb and no reach; it moves five handlers into a domain and deletes a sixth
registration. The property it must preserve is the one §2.5 and §5 state, and a test pins:

`servers: ['in-session']` is the load-bearing half. The in-session surface is **both** the claude-code
in-process server and the loopback `dorkos` server Codex and OpenCode are injected with
(`agent-runtime-server.ts:23-41` registers with `'in-session'`), so declaring it reaches all three
runtimes **and** keeps these tools off the external `/mcp` exactly as
`register-from-definitions.ts:30-50` describes today. A test asserts no `ui.*` tool is registered on
the external server, which turns that paragraph's stated fact into a checked one.

- **The external count never moves.** The `ui` domain declares `servers: ['in-session']`, so nothing
  it adds reaches `/mcp`, and it contributes nothing to `READ_ONLY_MCP_TOOL_NAMES` or
  `GUARDED_READ_ONLY_TOOL_NAMES` (`tool-security.ts:160-177`). A test asserts that directly, which
  turns `register-from-definitions.ts:30-50`'s stated fact into a checked one.

#### Documentation

**`contributing/`** — `architecture.md`'s service-domain paragraph gains `canvas` and says why it is
its own domain; `adding-a-runtime.md` gains a sentence that a new runtime inherits the whole `ui`
domain for free through the loopback server and owes it no code, which is the point of Q4;
`api-reference.md` needs nothing beyond the regenerated spec, and **both** regeneration commands run
in the same commit.

**`AGENTS.md`** — the service-domain census line (§Data model changes 6).

**Changelog.** One fragment per PR in `changelog/unreleased/`, named `<YYMMDD-HHMMSS>-<kebab-slug>.md`
with an id from `.claude/scripts/id.ts`, carrying a `covers:` block on its very first lines listing
that PR's exact commit subjects. Bodies use only the seven allowed headings; an invalid heading has
silently deleted a fragment before. Run `pnpm exec prettier --write` on the fragment before
committing — hand-edited fragments are the most common source of the formatting gate going red.

The demo-claim gate applies to every page: the Obsidian shell has no Browser tab and no driving, and
no page says otherwise; a recording is described by what it is (a slideshow of the steps), never as
video.

#### Definition of done

- `capabilityConformance` passes over the whole registry with the five moved capabilities in it: ids
  against `/^[a-z0-9]+\.[a-z0-9_]+$/`, tool-name uniqueness, declared servers matching what is actually
  registered, and every capability invocable from its `sampleInputs` entry.
- The parity test exists once per runtime: claude-code through the mocked-SDK suite; **codex** and
  **opencode** through the loopback `dorkos` server, asserting `createAgentRuntimeMcpServer` with a
  `runtime` principal advertises every `ui` tool and that a call carries `context.sessionId` from
  `principal.claims.canonicalSessionId` rather than from the arguments.
- A test asserts **no `ui.*` tool is registered on the external `/mcp` server**, and that
  `READ_ONLY_MCP_TOOL_NAMES` and `GUARDED_READ_ONLY_TOOL_NAMES` are unchanged by the domain.
- **The `dorkos_ui` retirement is asserted where it can break**: a Codex room turn running one
  `open_canvas` ends with exactly one row, one frame and one line, using a `json` document — without
  the `applied` stamp every Codex canvas operation applies twice, and dedupe by source key would hide
  it for every content type except `json` and `widget`.
- A non-`client-only` action over the loopback runtime surface is refused with the reworded sentence,
  on Codex **and** on OpenCode, and the refusal reaches the caller as the capability's error result.
- `control_ui` still auto-allows a `client-only` action and still does not auto-allow `apply_layout`
  after the move.
- `mcp-tool-gate.test.ts` reads 42 hand-registered in-session and 42 `MCP_TOOL_TIERS` keys, external
  stays 40, and `AUTO_ALLOW_ACT_REASONS` still has its 22 entries. `tool-exposure.test.ts` still reads
  101 / 92 / 9, and its stale "exactly the eight" title is fixed while you are in the file.
- `tsc` is green across `apps/server` and `packages/shared`, which is what proves `MCP_TOOL_TIERS` and
  `MCP_TOOL_GATE_GROUPS` still describe one set after five names left both.
- The client's always-enabled tool-group row still renders with `'ui'` and `'devtools'` gone from
  `ToolGateGroup` and `SESSION_CORE_TOOL_GROUPS`, and a test asserts no `ui.*` tool is missing from the
  session's advertised set.
- The existing claude-code suites pass **without edits beyond the counts**, which is what proves
  claude-code's behaviour is unchanged.
- `codex-ui-mcp-server.ts` and its test are deleted; `knip` reports nothing left behind from the
  retirement.
- Browser proof: a Codex or OpenCode session calling `browser_read_console` and `control_ui` in the
  real app, screenshotted in the PR — this is the phase's whole claim and it is a cross-process one.
- `pnpm --filter @dorkos/server typecheck` and both lint runs are clean.
- One changelog fragment in `changelog/unreleased/` with a `covers:` block and only the seven allowed
  headings, `pnpm exec prettier --write` run on it before committing.
- Adversarial review per `REVIEW.md` before the PR opens.
- **The full package suite runs before push**, not just the files you touched:
  `pnpm vitest run apps/server/src/services/runtimes apps/server/src/services/core packages/shared packages/db`,
  then `pnpm test -- --run`. This phase is the one most likely to red a guard in a file you never
  opened.

---

### Task 3.1: Add follow mode and document-anchored threads

**Phase:** Q5 — Follow mode and document threads (B6, B7) — depends on room-canvas P2b and P3
**Scope:** one PR. Its blocker is outside this spec: the room-canvas client (P2b, DOR-2000) and pins
and tab presence (P3, DOR-2002) must be merged to `main` before it starts, because the Follow toggle
and the Discuss action live on surfaces those phases build. Inside this spec it depends on nothing —
its `thread_root_entry_id` column is already in Q1's `0097` migration. **Verify the shapes below
against the landed P2b/P3 code before building**; they are written against
`specs/room-canvas/02-specification.md` §6 and §9.

#### Phase definition — create/modify and acceptance

**Verify against the landed P2b/P3 code before building.** The shapes below are written against
`specs/room-canvas/02-specification.md` §6 and §9.

**Modify**

- `packages/shared/src/room-schemas.ts` — the optional `view` payload on `RoomSignalEventSchema`,
  `CanvasDocumentSchema.threadRootEntryId`. **`SignalTypeSchema` is not touched** (§6)
- `packages/db/src/schema/rooms.ts` — `thread_root_entry_id` on `canvas_documents` (the `0097`
  migration already added it in Q1)
- `apps/server/src/services/rooms/service/room-publisher.ts:159-190` — the follow claim
- `apps/server/src/services/rooms/canvas/room-canvas-service.ts` — the thread root, posted through
  `postCanvasEvent` and written to the row in one transaction
- `apps/server/src/services/rooms/room-context.ts:145-161, 342-365` — a canvas-rooted thread's
  context narrows to its document, labels only
- the P2b room-canvas client slice and Browser tab — the Follow toggle, the Discuss action
- `apps/e2e/tests/rooms/{room-follow,room-canvas-thread}.spec.ts`
- `docs/concepts/rooms.mdx`; a changelog fragment

**Acceptance:** two browser contexts in one room, one follows the other and the frame moves within
250 ms; the leader publishes nothing while unfollowed, asserted on the stream; follow clears on blur
and on leaving; a viewer editing a document is never moved; Discuss posts one system root naming the
document, stores its id, and a second Discuss opens the same thread; a reply lands in it and triggers
nobody; a thread turn's context carries that document and no other, and carries no contents.

#### Detailed Design §6 — Follow mode (B6)

**Depends on the P2b room canvas client, which is not on main.** Verify against the landed P2b code
before building; the shapes below are written against `specs/room-canvas/02-specification.md` §9.1–9.3.

A person can follow another **person's** browser view in a room. A toggle on the room's Browser tab
reads "Follow Ana"; while it is on, the follower's frame goes where Ana's goes.

**The wire is a `signal` frame, because it is exactly what signals are for**: live, never logged,
never replayed (`room-publisher.ts:159-190`). **It declares no new signal name**, because
`specs/rooms/02-specification.md:229` forbids one:

> Ephemeral signals never enter the room log… They reuse `SignalTypeSchema`
> (`packages/shared/src/relay-envelope-schemas.ts:21`) rather than declaring new names.

That rule has been kept once already: room presence reused `'progress'` rather than minting a
`'working'` signal, and rooms emit exactly that one member today (`room-service.ts:129`) out of the
six the enum holds (`typing`, `presence`, `read_receipt`, `delivery_receipt`, `progress`,
`backpressure`) — the other five are the relay's. So follow mode reuses **`'presence'`**, which is
the member that already means "where this member is", and adds a payload to
`RoomSignalEventSchema` beside its existing optional `state`, `entryId`, `since`, `activity`,
`heldBehind` and `outcome`:

```ts
    /** Where this member is looking. Present only on a `presence` signal from a followed person. */
    view: z
      .object({
        documentId: z.string().min(1),
        url: z.string().optional(),
        scrollY: z.number().int().nonnegative().optional(),
      })
      .optional(),
```

**The payload is the discriminator**, exactly as `state` already discriminates an agent's presence
from a bare one: a `presence` frame with `view` is a follow position, a `presence` frame with `state`
is an agent's work claim, and neither reads the other's field. A schema test refuses a frame carrying
both, and refuses `view` on any signal that is not `presence`. Nothing is added to
`SignalTypeSchema`, so nothing changes for the relay.

The rules, each a mechanism:The rules, each a mechanism:

- **Publish only while somebody is following.** The server tells a client it is being followed — the
  room stream already knows who has a follow claim open — and the client publishes nothing until then.
  A room where nobody follows anybody carries zero extra frames, which is what keeps E7 ("silence must
  be free") true of bandwidth as well as of turns.
- **Debounced at 250 ms**, the same number the shim's own batch debounce uses
  (`devtools-shim.ts:141`), and coalesced: only the latest position is ever in flight.
- **Published as a consequence of real state**, never as an intention — the follower's frame moves
  because the leader's frame moved, read from the store, exactly the rule
  `specs/room-presence/02-specification.md` sets for every other signal.
- **People only.** An agent is never a follower (it has no viewport) and never followed (its browser
  is a document, and `read_canvas` already says what is in it). The toggle lists people.
- **Off by default, never persisted, cleared on blur, on close, on leaving the room, and when the
  leader stops publishing for 30 s** — the same three-intervals TTL the presence republisher uses
  (`PRESENCE_REPUBLISH_MS = 10_000`, `room-trigger.ts:517`).
- **A follower is never moved off a document it is editing**, which is §9.3's rule and outranks this
  one.

#### Detailed Design §7 — Document-anchored threads (B7)

**Depends on P2b.** Verify against the landed code; written against `specs/room-canvas/` §6 and §9.

"Discuss" on a canvas tab opens that document's thread. Threads already exist and the mechanism is
one column plus one system entry.

- **`canvas_documents` gains `threadRootEntryId: text('thread_root_entry_id')`**, nullable, with no
  index: it is read one row at a time, by primary key.
- **The first Discuss posts the root.** `RoomService.postCanvasEvent` already writes the
  system-voiced, unaddressed, wakes-nobody entry the coalesced canvas line uses
  (`room-system-posts.ts:263-`, the shape `postMergeEvent` establishes at `:198-230`). The thread root
  is one of those, with text naming the document — "The diff of `src/router.ts`" — and its id is
  written to the row in the same transaction. A second Discuss on the same document opens the
  existing thread; the column is what makes that true across restarts and across members.
- **Replies are ordinary thread entries**, through the existing writer. `threadPointers`
  (`room-entry-writer.ts:52-65`) already sets `parentEntryId` and `threadRootEntryId` from the entry
  being replied to, and already refuses a reply to a reply with `NESTED_THREAD` ("A thread reply
  cannot hang off another reply"). Nothing about the one-level rule changes.
- **`RoomThreadPanel.tsx`** needs no change to render it: it derives its root and replies by scanning
  the entries it is given for `entry.id === rootEntryId` and `threadRootIdOf(entry) === rootEntryId`,
  so a canvas-rooted thread reaches it by the same path every other thread does.
- **A thread turn's context gains the document.** `buildRoomContext`
  (`room-context.ts:342`, thread scoping at `:365`) already narrows the window to the thread when
  `threadRootEntryId` is set. When the thread's root is a canvas root, the context's `canvas` section
  is narrowed to that one document — **still labels only**, under the reader rule
  `RoomContextDeps.canvasFor` states at `room-context.ts:145-161`: titles, types, authors and
  timestamps, never contents, because contents are what `read_canvas` is for and because a document
  another member wrote is untrusted text. An agent replying in a document's thread that wants the
  document reads it, under §8.1 of the room-canvas spec, which decides per reader whether content
  comes back at all.

#### Data model changes — the sub-bullets this phase lands

1. **`canvas_documents`** — `threadRootEntryId: text('thread_root_entry_id')`, nullable, no index (§7). The column itself ships in Q1's `0097` migration; this phase is the first to write it.

2. **Shared schemas**, every one additive or optional so an older client parses a newer server:

   - `RoomSignalEventSchema` gains an optional `view` payload, carried on the existing `'presence'`
     signal. **`SignalTypeSchema` (`relay-envelope-schemas.ts:39-42`) is not touched** — declaring a
     new signal name is what `specs/rooms/02-specification.md:229` forbids (§6).
   - `CanvasDocumentSchema` (`room-schemas.ts:888-940`) gains an optional `threadRootEntryId`.

#### Data model changes — item 5, which this phase must keep true

5. **No config fields.** Every bound this spec adds is a constant in `constants.ts`'s `WORKBENCH`
   block, and every bound it reuses (`uploads.maxFiles`, `uploads.maxFileSize`,
   `rooms.maxPostsPerTurn`, `rooms.maxCanvasOpsPerTurn`) already exists. So there is no
   `config-schema.ts` edit, no `projectVersion` bump, no `CONFIG_MIGRATIONS` key, and no
   `merged-migration-hashes.ts` change — stated explicitly so a reviewer checks the claim rather
   than inferring it from silence.

#### User Experience — the paragraph this phase makes true

**Kai follows Ana's browser.** He turns on "Follow Ana" in the room's Browser tab; her page appears
in his frame, and scrolls as she scrolls. He turns it off and stays where she left him. Nobody was
notified, and nothing was recorded.

#### Detailed Design §10 — Bounds, honesty, etiquette (B10)

- **Driving is work, not speech.** No driving verb, recording verb, or canvas write triggers a turn
  for anybody. The only thing in this spec that puts a line in a room's log is a `post_to_room` an
  agent chose to write (§4) and the once-per-turn coalesced canvas line that already exists.
- **Every bound here is a mechanism.** Frames and bytes for a recording (§3.3); `uploads.maxFiles` and
  `uploads.maxFileSize` for attachments (§4); the derived synthetic turn id for `target` (§9); the
  publish-only-while-followed rule for follow mode (§6). None of them is a sentence in a prompt, and
  none may be replaced by one (`.claude/rules/room-conduct.md`, "Bounds are mechanisms, never
  prompts").
- **No new trigger, anywhere.** Nothing in this spec calls the trigger dispatcher. A conformance case
  and an e2e assertion both read that off the dispatcher rather than off a sleep.
- **Every tool result says what happened.** A timeout is a plain failure naming the command and the
  wait. A refusal names the fix. A recording that hit its ceiling says so and keeps working. Nothing
  reports success for something that did not happen — the property `specs/room-canvas/` §5.5
  establishes, extended to the browser seat.
- **The teaching is one paragraph, not a manual.** `buildRoomToolsBlock`
  (`room-tools-context.ts:97-100`) and the session `<ui_tools>` block each gain three sentences: that
  the browser can be driven and read on an instrumented preview, that a recording is frames of what
  you did and lands in a file you can post, and that a screenshot or a recording belongs in the room
  as an attachment rather than described in prose (E9, E14). Written out in each variant rather than
  shared, per that file's own rule at `:85-88`.

#### Testing Strategy — Unit, `packages/shared`

- **`SignalTypeSchema` is unchanged** — a test asserts its six members, because `specs/rooms/` §229
  forbids a new signal name and the easy mistake is to add one. A `presence` frame carrying `view`
  round-trips; a `presence` frame carrying both `view` and `state` **fails**; `view` on any other
  signal **fails**. _Catches a payload drifting off the verb that discriminates it._

#### Testing Strategy — Client tests (RTL + jsdom, mock `Transport`)

- Follow mode publishes nothing until a follower exists, coalesces to the latest position, stops on
  blur, and never moves a viewer who is editing.

#### Testing Strategy — Playwright (`apps/e2e`)

Built on the helpers rooms specs already use (`fixtures/rooms-api.ts`, `room-signals.ts`, the
`requireTestModeLeg` gate `room-autonomy.spec.ts:96-129` uses so a missing `TestModeRuntime` fails
loudly instead of starting a billable turn), and on `workbench/dev-server-preview.spec.ts`'s real
local dev server.

| Spec                                           | What it proves                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `tests/rooms/room-follow.spec.ts` (new)        | two contexts, one follows the other, the frame moves; the leader publishes nothing until followed         |
| `tests/rooms/room-canvas-thread.spec.ts` (new) | Discuss on a document opens its thread, the root names the document, a reply lands in it, nobody is woken |

**Mocking strategy.** Server tests use a real SQLite database and the real capability registry, never
a mocked `CanvasService` — a mock here would encode the hypothesis rather than test it. The shim is
executed, never read. Client tests use the mock `Transport` through `TransportProvider`. The e2e leg
uses the deterministic test-mode runtime and a real local dev server.

**Before opening any PR in this spec**, run
`pnpm vitest run apps/server/src/services/runtimes apps/server/src/services/core packages/shared packages/db`
— every phase here touches a count guard or a schema census, and those failures read like unrelated
breaks if you have not been told to expect them.

#### Performance Considerations

- **Per-turn prompt cost is unchanged.** `get_ui_state` is called, not injected; the canvas section of
  a room's context is still labels only and still capped at 12 + pins; the driving tools are deferred,
  not always-loaded, so they cost nothing in a turn that does not search for them.
- **Follow mode is one coalesced frame per 250 ms per followed member**, and zero when nobody follows.

#### Security Considerations — item 9

9. **Follow mode publishes a URL and a scroll offset to room members only**, on a signal that is never
   logged and never replayed, and only while somebody is following. It carries no page content.

#### Documentation

**`docs/concepts/rooms.mdx`** — this page still has **no mention of a canvas**; room-canvas P2c is the
phase that adds it and has not landed. This spec therefore **adds to that section rather than
creating one**, and its PR must read what P2c wrote before editing:

- the room-canvas section gains "Talking about a document" (the thread) and "Following somebody's
  browser" (people only, off by default, nothing recorded);
  **Changelog.** One fragment per PR in `changelog/unreleased/`, named `<YYMMDD-HHMMSS>-<kebab-slug>.md`
  with an id from `.claude/scripts/id.ts`, carrying a `covers:` block on its very first lines listing
  that PR's exact commit subjects. Bodies use only the seven allowed headings; an invalid heading has
  silently deleted a fragment before. Run `pnpm exec prettier --write` on the fragment before
  committing — hand-edited fragments are the most common source of the formatting gate going red.

The demo-claim gate applies to every page: the Obsidian shell has no Browser tab and no driving, and
no page says otherwise; a recording is described by what it is (a slideshow of the steps), never as
video.

#### Definition of done

- `packages/shared` tests pass: `SignalTypeSchema` still has exactly its six members; a `presence`
  frame carrying `view` round-trips; a `presence` frame carrying both `view` and `state` **fails**;
  `view` on any other signal **fails**.
- Client tests pass: follow mode publishes nothing until a follower exists, coalesces to the latest
  position, stops on blur, and never moves a viewer who is editing.
- Server tests pass for the thread root: the first Discuss posts one system-voiced, unaddressed,
  wakes-nobody entry naming the document and writes its id to the row **in one transaction**; a second
  Discuss opens the existing thread; a reply lands in it and triggers nobody; a canvas-rooted thread
  turn's context carries that document and no other, labels only, never contents.
- `apps/e2e/tests/rooms/room-follow.spec.ts` and `apps/e2e/tests/rooms/room-canvas-thread.spec.ts`
  exist and pass.
- Browser proof: two contexts in one room, one following the other, the frame moving within 250 ms,
  captured in the PR — a follow that only jsdom has seen is not a follow.
- A test reads the trigger dispatcher, not a sleep, to assert nothing here wakes anybody.
- `pnpm --filter @dorkos/server typecheck`, `pnpm --filter @dorkos/client typecheck` and both lint runs
  are clean.
- One changelog fragment in `changelog/unreleased/` with a `covers:` block and only the seven allowed
  headings, `pnpm exec prettier --write` run on it before committing.
- Adversarial review per `REVIEW.md` before the PR opens.
- **The full package suite runs before push**, not just the files you touched:
  `pnpm vitest run apps/server/src/services/runtimes apps/server/src/services/core packages/shared packages/db`,
  then `pnpm test -- --run`.

---

### Task 3.2: Add merge preview from the diff and control_ui.target

**Phase:** Q6 — Merge preview and `control_ui.target` (B8, B9) — depends on room-canvas P2b
**Scope:** one PR. Its blocker is outside this spec: the room-canvas client (P2b, DOR-2000) must be
merged to `main` before it starts, because the diff surface it retargets is the one P2b builds.
Inside this spec it depends on nothing, though it subscribes beside Q1's rekey listener if Q1 has
landed. **Verify the shapes below against the landed P2b code before building.**

#### Phase definition — create/modify and acceptance

**Verify against the landed P2b code before building.**

**Modify**

- `apps/client/src/layers/features/diff-review/` — the worktree-vs-main comparison for a
  `treeKind: 'worktree'` document, the operator-only merge action, the behind-main sentence, the
  per-hunk reject against the row's `resolvedCwd`
- `packages/shared/src/transport-rooms.ts` — `mergeRoomMain`, with `createRoomMethods`,
  `embedded-mode-stubs.ts` and `mock-factories.ts`
- `packages/shared/src/schemas.ts:5276-5285` + `runtimes/shared/ui-tool-contract.ts` — `target`
- `apps/server/src/services/runtimes/claude-code/mcp-tools/ui-tools.ts:170-228` (now
  `ui-capabilities.ts`) — membership check, the derived synthetic turn id, the refusal
- `apps/server/src/index.ts` — `onProjectorTurnBoundary(... finishTargetedTurns(sessionId))` beside
  the Q1 rekey subscription; `services/canvas/canvas-service.ts` — the `session:` synthetic ledger,
  its `n` counter and `finishTargetedTurns`. `room-turn-runner.ts:1537-1544` is **unchanged**: a room
  turn keeps finishing its own `turnId`
- `apps/e2e/tests/rooms/room-merge-from-diff.spec.ts`
- `docs/concepts/rooms.mdx`; a changelog fragment

**Acceptance:** a worktree diff ahead of main shows the merge action to the operator and to nobody
else; rejecting a hunk writes to the agent's working copy and a stale hash surfaces the existing
conflict banner; merging posts one line and triggers nobody; a worktree behind main shows the merge
service's own sentence and no button; an agent puts a chart on a room it is a member of from a direct
session, the room's viewers see it, one coalesced line posts at the end of that turn, and the fourth
targeted write to one room in one turn is refused; a room it is not a member of answers
`ROOM_NOT_FOUND`.

#### Detailed Design §8 — Merge preview and accept-to-merge (B8)

**Depends on P2b.** Verify against the landed code before building.

The room-canvas table already stores what this needs: `treeKind` is one of `room-main`, `worktree`,
`agent-cwd`, and `aheadOfMain` is a snapshot count or `null`
(`canvas-document-store.ts:24-49`, derivation at `room-canvas-service.ts:847-892`).

- **Which rows qualify.** A `diff` document whose `treeKind === 'worktree'` and whose `aheadOfMain`
  is a number greater than zero renders **worktree-vs-main** instead of the session's
  edited-vs-baseline comparison. Every other document is unchanged: `treeKind: 'room-main'` is the
  shared tree with nothing to merge, `'agent-cwd'` is a room with no files of its own, and
  `aheadOfMain: null` means git could not be asked, which is shown as "not measured" and never as
  zero.
- **The component is the one that exists.** `CanvasDiffContent` → `CodeMirrorDiff`
  (`features/diff-review/ui/`) already renders a two-document comparison with a per-chunk gutter; it
  is handed the worktree copy and the room's `main` copy instead of the file and its baseline.
- **"Merge into the room" is on the diff header, and only the operator sees it.** It needs a
  `Transport` method, and **there is none**: neither `Transport` nor `RoomTransport`
  (`packages/shared/src/transport-rooms.ts`, 24 methods) exposes the merge, which has only ever been
  reached by an agent through `merge_to_room_main`. So `RoomTransport` gains
  `mergeRoomMain(roomId, input: { summary: string; worktree: string }): Promise<RoomMergeResult>`,
  landing in all three implementations — a `createRoomMethods` entry for `HttpTransport` against the
  existing route, a `roomStubs` entry for `DirectTransport` (the Obsidian shell has no rooms at all,
  so it refuses in a sentence), and a `vi.fn()` in `createMockTransport`. Behind it, the same
  server-mediated merge — `RoomMergeService.merge(roomId, callerAuthorId, { summary, worktree })`
  (`room-merge-service.ts:249-278`) — which posts its usual line through `postMergeEvent`
  and **wakes nobody** (`room-system-posts.ts:160-179`: a `post`, `mentions: []`, cascade spent at the
  ceiling, never dispatched). No new merge path, no client-side git, and no agent-reachable verb:
  agents keep `merge_to_room_main` and gain nothing here.
- **Per-hunk reject writes to the worktree copy**, through the path `useDiffReview` already takes:
  `transport.writeFile(cwd, sourcePath, revertedContent, { expectedHash })`, whose result is
  `{ ok: true, hash } | { ok: false, conflict: { currentHash, currentContent } }`
  (`transport.ts:481-483`) — a conflict is control flow, and the existing banner handles it. The
  `cwd` is the row's stored `resolvedCwd`, not a re-derived one, so a reject lands in the tree the
  document was opened against. Accept stays what it is: a client-side dismissal that writes nothing
  (`CodeMirrorDiff.tsx:67-68`). "Reject two hunks, then merge" is therefore one flow made of two
  things that already work.
- **Behind main is refused by the merge service, in its own words**, and the UI shows that sentence
  rather than inventing one (`room-merge-service.ts:611-616`):

  > The room has moved on: main is 3 commits ahead of your branch, and you are 2 commits ahead of it.
  > Run `git merge main` in your own working copy, sort out anything that clashes there, then merge
  > again.

  Because it is the merge service's own refusal, the operator is told to **ask the agent to catch
  up** — the working copy is the agent's, and the operator has no business running git in it. The
  header adds exactly that one sentence beneath the refusal, and no button.

- **A room with no files of its own** shows no merge affordance at all; the merge service's
  `NOT_A_PROJECT_ROOM` ("This room does not have files of its own.") is the fallback if one is
  reached anyway.

#### Detailed Design §9 — `control_ui.target` — putting a document on another room (B9)

`control_ui` gains one optional field on the six canvas verbs:

```ts
  target: z
    .object({ room: z.string().describe('The room id to put this on. You must be a member of it.') })
    .optional()
    .describe('Put the document on a room’s shared canvas instead of this window.'),
```

- **Membership is checked, and the refusal is the room system's own.** The handler calls
  `requireMembership(roomId, callerAuthorId)`, which throws `ROOM_NOT_FOUND` ("No such room") for a
  non-member and for a room that does not exist, identically and on purpose
  (`room-visibility.ts:123-128`). The tool result carries that sentence:

  > No such room. Check the id — `get_room` or `list_member_rooms` will tell you which rooms you are
  > in.

- **A direct session turn has no turn id, so the seam mints one — and there is exactly one place that
  can.** `turnId` exists today only under `session.roomTurn`, threaded from the room runner
  (`specs/room-canvas/` §5.3); `finishTurn` has one call site, `collectReply`'s `finally`
  (`room-turn-runner.ts:1537-1544`); and the projector holds no room ledger. A targeted write from a
  direct session turn has none of that. Rather than thread a turn id through the message dispatcher
  into every runtime — which would mean four adapters and a new `MessageOpts` field for a feature none
  of them needs — the seam is the **turn boundary the projector already publishes**, which is
  server-owned, runtime-neutral, and already subscribed to by exactly this kind of subsystem:

  ```ts
  // apps/server/src/index.ts, beside the rekey subscription of §1.1
  onProjectorTurnBoundary((sessionId, kind) => {
    if (kind === 'turn_end') canvasService.finishTargetedTurns(sessionId);
  });
  ```

  `onProjectorTurnBoundary` (`session-state-projector.ts:2515`, notified at `:668` for `turn_end` and
  `interaction_resolved`) is the same hook the message dispatcher already uses
  (`message-dispatcher.ts:2280`).

- **The synthetic turn id is `session:<sessionId>:<n>:room:<roomId>`**, where `n` is the count of
  `turn_end` boundaries the service has seen for that session. It is constant for the whole of one
  turn, so the room's per-turn ceiling (`room-canvas-service.ts:1197-1199`) holds across every call
  in it — twenty targeted writes to one room are refused at the fourth, exactly as a room turn is —
  and it changes at the boundary, so the next turn gets fresh allowances. Two rooms targeted in one
  turn get one allowance each, because the room id is in the key. A **room** turn keeps its own
  `turnId` from the runner and is unaffected: `finishTargetedTurns` only ever finishes ids in the
  `session:` namespace, so the two paths cannot finish each other's ledgers.

- **The coalesced line posts at that boundary.** `finishTargetedTurns(sessionId)` calls the existing
  `finishTurn` once per synthetic id opened under the turn that just ended, which composes and posts
  one line per targeted room and clears the ledger. It never throws, exactly as `finishTurn` never
  does. A session whose process dies mid-turn never reaches the boundary; the service's `closedTurns`
  and `LEDGER_TTL_MS` bookkeeping (`:1128-1144`, `:1160-1183`) already covers that — a late operation
  gets its own line, and a ledger nobody closes ages out in two hours. The rows survive either way;
  only the line is lost, which is already the room behaviour.

- **A room turn without `target` behaves exactly as today.** `session.roomTurn` still decides the
  default surface; `target` only ever names a _different_ room, and naming the room the turn is
  already in is accepted and is a no-op distinction.
- **Refused in reverse.** `target` is ignored — with a sentence — on the sixteen non-canvas actions,
  which are already refused in a room by `CANVAS_VERBS` (`room-canvas-service.ts:135-142`). Targeting
  cannot be a way to reach an action a room refuses.

#### Data model changes — the sub-bullets this phase lands

2. **Shared schemas**, every one additive or optional so an older client parses a newer server:

   - `UiCommandSchema` (`:5276-5285`) gains `target` on the six canvas verbs, and
     `CONTROL_UI_INPUT` (`ui-tool-contract.ts`) gains the matching optional field (§9).

3. **`Transport`** — six session-canvas methods under a new `// --- Session canvas ---` banner
   (§1.6), plus `RoomTransport.mergeRoomMain` in Q6 (§8) — the merge has never had a client method.
   Each lands in `HttpTransport`, `DirectTransport` and `createMockTransport`, or the build breaks.

#### Data model changes — item 5, which this phase must keep true

5. **No config fields.** Every bound this spec adds is a constant in `constants.ts`'s `WORKBENCH`
   block, and every bound it reuses (`uploads.maxFiles`, `uploads.maxFileSize`,
   `rooms.maxPostsPerTurn`, `rooms.maxCanvasOpsPerTurn`) already exists. So there is no
   `config-schema.ts` edit, no `projectVersion` bump, no `CONFIG_MIGRATIONS` key, and no
   `merged-migration-hashes.ts` change — stated explicitly so a reviewer checks the claim rather
   than inferring it from silence.

#### User Experience — the paragraph this phase makes true

**Kai reviews before merging.** Ana's diff is on the room's canvas, labelled "Ana's copy · 3 ahead of
main". He opens it, rejects two hunks — which write to Ana's working copy through the ordinary file
path — and presses "Merge into the room". One line lands in the log and nobody's turn starts. When
main has moved on, the button is replaced by the merge service's own sentence and a note to ask Ana
to catch up.

#### Detailed Design §10 — Bounds, honesty, etiquette (B10)

- **Driving is work, not speech.** No driving verb, recording verb, or canvas write triggers a turn
  for anybody. The only thing in this spec that puts a line in a room's log is a `post_to_room` an
  agent chose to write (§4) and the once-per-turn coalesced canvas line that already exists.
- **Every bound here is a mechanism.** Frames and bytes for a recording (§3.3); `uploads.maxFiles` and
  `uploads.maxFileSize` for attachments (§4); the derived synthetic turn id for `target` (§9); the
  publish-only-while-followed rule for follow mode (§6). None of them is a sentence in a prompt, and
  none may be replaced by one (`.claude/rules/room-conduct.md`, "Bounds are mechanisms, never
  prompts").
- **No new trigger, anywhere.** Nothing in this spec calls the trigger dispatcher. A conformance case
  and an e2e assertion both read that off the dispatcher rather than off a sleep.
- **Every tool result says what happened.** A timeout is a plain failure naming the command and the
  wait. A refusal names the fix. A recording that hit its ceiling says so and keeps working. Nothing
  reports success for something that did not happen — the property `specs/room-canvas/` §5.5
  establishes, extended to the browser seat.
- **The teaching is one paragraph, not a manual.** `buildRoomToolsBlock`
  (`room-tools-context.ts:97-100`) and the session `<ui_tools>` block each gain three sentences: that
  the browser can be driven and read on an instrumented preview, that a recording is frames of what
  you did and lands in a file you can post, and that a screenshot or a recording belongs in the room
  as an attachment rather than described in prose (E9, E14). Written out in each variant rather than
  shared, per that file's own rule at `:85-88`.

#### Testing Strategy — Unit, `apps/server`, the `target` half

- `control_ui` with `target` naming a room the agent is not in is refused with `ROOM_NOT_FOUND`'s
  sentence and writes nothing; naming one it is in writes a row on that room; twenty targeted writes
  in one turn are refused at the fourth per room, and two rooms get one allowance each.
- A targeted write's coalesced line posts once, at the end of the calling turn, naming every
  operation.

#### Testing Strategy — Playwright (`apps/e2e`)

Built on the helpers rooms specs already use (`fixtures/rooms-api.ts`, `room-signals.ts`, the
`requireTestModeLeg` gate `room-autonomy.spec.ts:96-129` uses so a missing `TestModeRuntime` fails
loudly instead of starting a billable turn), and on `workbench/dev-server-preview.spec.ts`'s real
local dev server.

| Spec                                             | What it proves                                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `tests/rooms/room-merge-from-diff.spec.ts` (new) | a worktree diff shows the merge action for the operator; a hunk reject writes; the merge posts one line and triggers nobody |

**Mocking strategy.** Server tests use a real SQLite database and the real capability registry, never
a mocked `CanvasService` — a mock here would encode the hypothesis rather than test it. The shim is
executed, never read. Client tests use the mock `Transport` through `TransportProvider`. The e2e leg
uses the deterministic test-mode runtime and a real local dev server.

**Before opening any PR in this spec**, run
`pnpm vitest run apps/server/src/services/runtimes apps/server/src/services/core packages/shared packages/db`
— every phase here touches a count guard or a schema census, and those failures read like unrelated
breaks if you have not been told to expect them.

#### Performance Considerations

- **Per-turn prompt cost is unchanged.** `get_ui_state` is called, not injected; the canvas section of
  a room's context is still labels only and still capped at 12 + pins; the driving tools are deferred,
  not always-loaded, so they cost nothing in a turn that does not search for them.

#### Security Considerations — items 4 and 5

4. **Merge stays operator-initiated and server-mediated.** The action is on the diff header and only
   the operator sees it; it calls `RoomMergeService.merge`, which holds the room's mutex, runs its own
   symlink-escape, file-size and repo-cap refusals (`:756-773`) and posts a line that wakes nobody. No
   agent gains a merge path it did not have, and no git runs in the client.
5. **`target` cannot reach a room the agent is not a member of.** `requireMembership` refuses with
   `ROOM_NOT_FOUND` — the same answer a non-existent room gets, so room ids stay non-probing
   (`room-visibility.ts:123-128`) — and the per-room synthetic turn id means targeting cannot be used
   to escape a room's canvas ceiling.

#### Documentation

**`docs/concepts/rooms.mdx`** — this page still has **no mention of a canvas**; room-canvas P2c is the
phase that adds it and has not landed. This spec therefore **adds to that section rather than
creating one**, and its PR must read what P2c wrote before editing:

- the room-canvas section gains "Talking about a document" (the thread) and "Following somebody's
  browser" (people only, off by default, nothing recorded);
- **"Handing work back to the room"** gains the review flow: open the diff from the canvas, turn down
  the parts you do not want, and merge — and that merging is something a person does, not an agent;
- the **"REST surface"** table gains the session-canvas routes and the two new devtools routes.

**Changelog.** One fragment per PR in `changelog/unreleased/`, named `<YYMMDD-HHMMSS>-<kebab-slug>.md`
with an id from `.claude/scripts/id.ts`, carrying a `covers:` block on its very first lines listing
that PR's exact commit subjects. Bodies use only the seven allowed headings; an invalid heading has
silently deleted a fragment before. Run `pnpm exec prettier --write` on the fragment before
committing — hand-edited fragments are the most common source of the formatting gate going red.

The demo-claim gate applies to every page: the Obsidian shell has no Browser tab and no driving, and
no page says otherwise; a recording is described by what it is (a slideshow of the steps), never as
video.

#### Definition of done

- Server tests pass for `target`: a room the agent is not a member of is refused with
  `ROOM_NOT_FOUND`'s sentence and writes nothing; a room it is in writes a row on that room; twenty
  targeted writes in one turn are refused at the fourth **per room**, and two rooms get one allowance
  each; a targeted write's coalesced line posts once, at the end of the calling turn, naming every
  operation; `target` on a non-canvas action is ignored with a sentence.
- A test asserts `finishTargetedTurns` only ever finishes ids in the `session:` namespace, so a room
  turn's own `turnId` — still finished by `room-turn-runner.ts:1537-1544`, unchanged — cannot be
  closed by it.
- Client tests pass for the merge preview: a `treeKind: 'worktree'` document ahead of main renders
  worktree-vs-main; the merge action is shown to the operator and to nobody else; a worktree behind
  main shows the merge service's own sentence and no button; a room with no files of its own shows no
  merge affordance; a per-hunk reject writes through `transport.writeFile` against the row's stored
  `resolvedCwd` and a stale hash surfaces the existing conflict banner.
- `RoomTransport.mergeRoomMain` exists in all three implementations — `HttpTransport` against the
  existing route, a `roomStubs` refusal sentence for `DirectTransport`, and a `vi.fn()` in
  `createMockTransport` — or the build breaks.
- `apps/e2e/tests/rooms/room-merge-from-diff.spec.ts` exists and passes.
- Browser proof: the merge action on a real worktree diff, a hunk rejected, and the one line it posts,
  captured in the PR.
- A test reads the trigger dispatcher to assert merging wakes nobody.
- `pnpm --filter @dorkos/server typecheck`, `pnpm --filter @dorkos/client typecheck` and both lint runs
  are clean.
- One changelog fragment in `changelog/unreleased/` with a `covers:` block and only the seven allowed
  headings, `pnpm exec prettier --write` run on it before committing.
- Adversarial review per `REVIEW.md` before the PR opens.
- **The full package suite runs before push**, not just the files you touched:
  `pnpm vitest run apps/server/src/services/runtimes apps/server/src/services/core packages/shared packages/db`,
  then `pnpm test -- --run`.

---
